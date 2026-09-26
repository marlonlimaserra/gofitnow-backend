const avisar = require("../lib/avisar.js");
const tempoReal = require("../lib/tempoReal.js");
const ensureSchema = require("../database/schema.js");
const instanceContext = require("../lib/instance.js");
const retencaoDeLogs = require("../lib/retencaoDeLogs.js");

// Rotas INTERNAS — chamadas por outro serviço nosso, nunca por um navegador.
//
// Existe uma só, e ela existe por um motivo de dono: o schema de uma instância
// (quais collections, quais índices) é conhecimento DESTE backend. O painel do
// center precisa criar clientes, mas duplicar o schema lá significaria dois
// lugares para atualizar e um deles sempre atrasado.
//
// Então o center registra o cliente no `center` e PEDE o provisionamento aqui.
// Uma fonte de verdade, e o painel não precisa saber o que é uma collection.
//
// A porta é uma chave compartilhada no ambiente, e não sessão: quem chama é um
// serviço, não uma pessoa. Sem a chave configurada a rota não existe — melhor
// não ter porta do que ter uma porta sem tranca.
module.exports = function (app) {
  const chave = process.env.INTERNAL_KEY || "";

  if (!chave) {
    console.log("[internal] INTERNAL_KEY ausente — rotas internas desativadas");
    return;
  }

  function autorizado(req, res) {
    const mandada = String(req.headers["x-internal-key"] || "");

    // Comparação de tamanho fixo: um `!==` normal vaza, pelo tempo, quantos
    // caracteres iniciais estão certos.
    const a = Buffer.from(mandada.padEnd(chave.length).slice(0, chave.length));
    const b = Buffer.from(chave);
    const ok = mandada.length === chave.length && app.crypto.timingSafeEqual(a, b);

    if (!ok) {
      // 404 e não 403: para quem não tem a chave, esta rota não existe.
      res.status(404).send({ msg: "not_found" });
      return false;
    }

    return true;
  }

  // Cria (ou confere) as collections e os índices de uma instância.
  //
  // Idempotente de propósito: o center pode repetir a chamada depois de uma
  // falha de rede sem risco, e um deploy novo alcança clientes criados pela
  // versão anterior.
  app.post("/internal/instances/:instance/provision", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.params.instance);
    if (!nome) return res.status(400).send({ msg: "invalid_instance" });

    // O registro tem de existir ANTES: provisionar um banco para um cliente que
    // ninguém cadastrou deixaria um banco órfão que nada apaga.
    const registro = await app.api.center.byInstance(nome);
    if (!registro) return res.status(404).send({ msg: "instance_not_registered" });

    await ensureSchema.ensureInstance(app, nome);

    // Esquece o que ficou guardado sobre esta instância.
    //
    // O portão do middleware guarda por alguns segundos que um nome NÃO é de
    // ninguém. Sem esta linha, o cliente que acabou de ser criado veria "domínio
    // não identificado" nesses segundos — o pior momento possível, porque é
    // exatamente quando alguém está conferindo se o cadastro funcionou.
    app.api.center.forget(nome);

    // `db` continua na resposta porque o painel a mostra, mas agora é o mesmo
    // nome para todo cliente: o que separa um do outro é o campo `instance`, não
    // o banco.
    res.send({ ok: true, instance: nome, db: app.mongodb.nomeDoBanco() });
  });

  // ── PREPARAR UM BANCO REGISTRADO ────────────────────────────────────────
  //
  // "Se eu instalar um banco de dados novo, ele vai estar lá."
  //
  // Ele estava certo, e este é o buraco que a frase aponta. Registrar um banco
  // no painel grava a URI e mais nada: as 37 collections, os ~103 índices e os
  // papéis de sistema dos clientes que moram nele só nascem no `ensureSchema`,
  // que roda no BOOT. Até o próximo restart, um banco recém-registrado é um
  // banco vazio — e o primeiro cliente que cair nele não abre.
  //
  // Reiniciar o serviço resolvia. Reiniciar o serviço não é ferramenta.
  //
  // ── Por que os DOIS passos, e não só o schema ───────────────────────────
  //
  // `ensureUmBanco` é do BANCO: collections e índices. `ensureInstance` é do
  // CLIENTE: os papéis de sistema (sem eles a tela de Usuários abre vazia e o
  // primeiro convite não tem o que oferecer) e a migração da configuração.
  //
  // Um banco preparado sem os clientes dentro dele é metade do serviço, e a
  // metade que falta só aparece quando alguém tenta convidar a equipe. Como o
  // botão é um só, ele faz o que a frase "preparar este banco" promete.
  //
  // Idempotente pelos dois lados: `criarFaltantes` só cria o que falta,
  // `createIndex` com a mesma chave é no-op, e `ensureSystemRoles` também.
  // Rodar de novo num banco pronto não custa nada além do tempo.
  app.post("/internal/databases/prepare", async function (req, res) {
    if (!autorizado(req, res)) return;

    // O painel manda a URI porque é ELE quem tem o registro dos bancos: pedir o
    // id obrigaria este lado a reabrir a collection do painel para traduzir um
    // id que o outro lado já tinha em mãos.
    const uri = String((req.body || {}).uri || "").trim();
    if (!uri) return res.status(400).send({ msg: "invalid_uri" });

    let banco;
    try {
      banco = await app.mongodb.bancoCruSemEscopo(uri);
    } catch (erro) {
      return res.status(502).send({ msg: "connect_failed", detalhe: String(erro.message || erro) });
    }

    // A retenção CONFIGURADA, e não o padrão: sem isto, preparar um banco
    // recriaria a poda em 180 dias num sistema ajustado para outro prazo — e o
    // defeito apareceria meses depois, como registro que sumiu antes da hora.
    const dias = await retencaoDeLogs.lerDoCentral(await app.mongodb.centralDb());

    await ensureSchema.ensureUmBanco(banco, { podaHistoricoDias: dias });

    // Os clientes QUE MORAM NESTE BANCO, e não todos: preparar um banco não é
    // motivo para tocar nos clientes dos outros.
    const nomeDoBanco = banco.databaseName;
    const clientes = [];

    for (const registro of await app.api.center.list()) {
      const destino = await app.mongodb.destinoDe(registro.instance).catch(() => null);
      if (!destino || destino.banco !== nomeDoBanco) continue;

      await ensureSchema.ensureInstance(app, registro.instance);
      clientes.push(registro.instance);
    }

    res.send({ ok: true, banco: nomeDoBanco, clientes });
  });

  // ── A RETENÇÃO DOS LOGS MUDOU ───────────────────────────────────────────
  //
  // *"na central, cadastre em Configuração mais uma rota chamada retenção de
  // logs, para a gente definir quantos dias vamos reter esses logs"*
  // (25/09/2026).
  //
  // O painel grava o número; quem o APLICA é este backend, porque quem conhece
  // as collections e os índices é ele — a mesma fronteira do provisionamento.
  //
  // ── Ele LÊ o valor do painel em vez de aceitá-lo no corpo ──────────────
  //
  // Os dois lados falam com o mesmo Mongo, então o corpo seria uma segunda
  // fonte da mesma verdade — e uma chamada repetida fora de ordem (duas
  // trocas seguidas, a primeira chegando por último) gravaria o número velho
  // por cima do novo. Lendo, a última palavra é sempre a do banco.
  //
  // Sem `dias` no corpo, então: o painel diz "reaplique", não "use 90".
  app.post("/internal/logs/retention", async function (req, res) {
    if (!autorizado(req, res)) return;

    const dias = await retencaoDeLogs.lerDoCentral(await app.mongodb.centralDb());

    // TODOS os bancos registrados: a poda é do sistema. Um banco dedicado que
    // ficasse de fora guardaria o dobro do tempo sem ninguém saber.
    const bancos = [];
    const falhas = [];

    for (const destino of await app.mongodb.bancosRegistrados()) {
      try {
        const banco = await app.mongodb.bancoCruSemEscopo(destino.uri);
        await ensureSchema.garantirPodaDoHistorico(banco, dias);
        bancos.push(destino.banco);
      } catch (erro) {
        // Um banco fora do ar não pode fazer os outros ficarem sem o ajuste. A
        // lista de falhas volta para a tela dizer EM QUAL não pegou — calar
        // seria prometer uma retenção que metade do sistema não tem.
        falhas.push({ banco: destino.banco || destino.nome, erro: String(erro.message || erro) });
      }
    }

    // O que este processo guardava sobre o número já não vale.
    app.api.center.esquecerRetencao();

    res.send({ ok: falhas.length === 0, dias, bancos, falhas });
  });

  // ── O PAINEL RESPONDEU UM CHAMADO ───────────────────────────────────────
  //
  // "Quando eu responder atualiza na hora e também recebe notificação, como se
  // fosse um chat."
  //
  // Quem responde é o painel, que é OUTRO processo, com outro banco de sessões e
  // sem o socket de ninguém. Ele grava a mensagem no central e chama aqui — este
  // backend é o único que tem as duas coisas que faltam: a sala de tempo real
  // daquela pessoa e o OneSignal daquele cliente.
  //
  // Pela mesma porta interna do provisionamento, com a mesma chave. Redis pub/sub
  // resolveria também e criaria um segundo caminho entre os dois serviços, com
  // outro modo de falhar — este já existe, já é testado, e o painel já o usa.
  //
  // NUNCA derruba a resposta do painel: quem chama trata a falha como aviso não
  // entregue, e não como resposta não gravada. A mensagem já está no banco; o
  // cliente a vê no próximo F5 mesmo sem nada disto funcionar.
  app.post("/internal/tickets/notify", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.body?.instance);
    const para = String(req.body?.para || "");
    if (!nome || !para) return res.status(400).send({ msg: "invalid_payload" });

    const assunto = String(req.body?.assunto || "").slice(0, 140);
    const ticket = String(req.body?.ticket || "");

    // 1) A TELA ABERTA, na hora. A sala é da PESSOA — ver lib/tempoReal.js.
    try {
      tempoReal.avisar(nome, para, "suporte:resposta", { ticket, assunto });
    } catch (erro) {
      console.error("[internal:ticket] tempo real falhou:", erro?.message);
    }

    // 2) O CELULAR, para quem não está com a tela aberta. `sem esperar` porque a
    // resposta desta rota não deve carregar o tempo do OneSignal.
    avisar.avisarSemEsperar(app, "ticket", {
      para,
      lang: req.body?.lang,
      vars: { assunto },
    });

    res.send({ ok: true });
  });

  // O PRIMEIRO ACESSO de uma instância.
  //
  // Provisionar cria as collections e os índices — e mais nada. Um banco com 28
  // collections e nenhum usuário é uma tela de login sem ninguém para entrar,
  // que foi exatamente o que aconteceu com os dois primeiros clientes: o acesso
  // saía de um `node database/init.js` no servidor, por ssh, um por um.
  //
  // Esta rota é aquele comando, alcançável pelo painel.
  //
  // Ela cria SÓ O PRIMEIRO. Com uma instância que já tem gente dentro, ela
  // recusa (409) em vez de criar mais um administrador: um jeito de acrescentar
  // administrador em qualquer cliente, morando atrás de uma chave de serviço,
  // seria uma porta de entrada para todos eles. Quem já tem acesso convida os
  // outros por dentro do produto.
  app.post("/internal/instances/:instance/first-user", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.params.instance);
    if (!nome) return res.status(400).send({ msg: "invalid_instance" });

    const registro = await app.api.center.byInstance(nome);
    if (!registro) return res.status(404).send({ msg: "instance_not_registered" });

    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const senha = String(body.password || "");

    if (!String(body.name || "").trim()) return res.status(400).send({ msg: "invalid_name" });
    if (!app.validator.isEmail(email)) return res.status(400).send({ msg: "invalid_email" });
    // Seis é o mínimo que o resto do produto pede. Não é aqui que se aperta a
    // régua — seria a única senha do sistema com uma regra diferente.
    if (senha.length < 6) return res.status(400).send({ msg: "weak_password" });

    // Quem garante que o banco tem as collections e o índice único de e-mail é
    // o PROVISIONAMENTO, e o painel chama os dois em ordem. Repetir o schema
    // aqui daria dois donos para a mesma garantia.
    const resultado = await instanceContext.run(nome, async () => {
      const jaTem = await app.api.user.countTrainers();
      if (jaTem > 0) return { erro: "already_has_users" };

      const id = await app.api.user.insertTrainer({
        name: String(body.name).trim(),
        email,
        password: senha,
        // Dono da casa: o primeiro precisa poder tudo, inclusive criar os
        // outros. Sem isto, o cliente entra e não consegue cadastrar ninguém.
        admin: true,
      });

      if (id && id.erro) return { erro: id.erro };
      return { id };
    });

    if (resultado.erro === "already_has_users") {
      return res.status(409).send({ msg: "already_has_users" });
    }
    if (resultado.erro) return res.status(400).send({ msg: resultado.erro });

    app.api.center.forget(nome);

    res.status(201).send({ ok: true, instance: nome, id: String(resultado.id), email });
  });

  // Quantas coisas existem numa instância. O painel mostra para dar noção de
  // uso; é leitura pura.
  app.get("/internal/instances/:instance/stats", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.params.instance);
    if (!nome) return res.status(400).send({ msg: "invalid_instance" });

    const registro = await app.api.center.byInstance(nome);
    if (!registro) return res.status(404).send({ msg: "instance_not_registered" });

    // `comoCliente()` e não `connectToServer()`: esta rota é do PAINEL, atende
    // uma requisição que não é de cliente nenhum, e precisa contar o de um
    // cliente dito por nome. O escopo vem do argumento, e a contagem sai
    // filtrada pelo `instance` do mesmo jeito que sairia para o próprio cliente.
    const db = await app.mongodb.comoCliente(nome);
    const conta = async (nomeCol, filtro = {}) => {
      try {
        return await db.collection(nomeCol).countDocuments(filtro);
      } catch (error) {
        // Collection que ainda não existe conta zero — é o que ela é.
        return 0;
      }
    };

    res.send({
      instance: nome,
      professionals: await conta("users", { type: "trainer" }),
      people: await conta("users", { type: "student" }),
      workouts: await conta("workouts"),
      apiKeys: await conta("api_keys", { revokedAt: null }),
      // Sem filtro: a faxina do tema já apaga o que não é referenciado, então o
      // que está na collection é o que conta contra o limite.
      brandImages: await conta("brand_images"),
    });
  });

  // As categorias que os clientes criaram, varridas por todas as instâncias.
  //
  // Interna porque a varredura abre o banco de TODO cliente — é a operação mais
  // ampla desta API, e ela existe para uma tela só do painel.
  app.get("/internal/recipe-categories/clientes", async function (req, res) {
    if (!autorizado(req, res)) return;

    res.send(await app.api.recipeCategory.dosClientes());
  });

  // Quantos usuários há em cada CATEGORIA, somando todas as instâncias.
  //
  // Interna pela mesma razão da rota acima: a varredura abre o banco de todo
  // cliente. O painel guarda o catálogo e pergunta os números aqui — ele não tem
  // os usuários, só um e-mail por instância.
  app.get("/internal/user-categories/counts", async function (req, res) {
    if (!autorizado(req, res)) return;

    res.send(await app.api.userCategory.contagens());
  });

  // ── MOVER UM CLIENTE DE BANCO ────────────────────────────────────────────
  //
  // É o que o painel chama quando alguém marca um cliente como "dedicado". O
  // trabalho está em `lib/moverCliente.js`; aqui é só a porta.
  //
  // Síncrona de propósito, e não uma fila: com os volumes de hoje a cópia é de
  // segundos, e quem clicou está olhando a tela. Uma fila esconderia a falha da
  // conferência num log que ninguém abre. Se um cliente crescer ao ponto de a
  // cópia passar do timeout do painel, aí vale a fila — e o sintoma vai ser
  // claro.
  app.post("/internal/instances/:instance/mover-banco", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.params.instance);
    if (!nome) return res.status(400).send({ msg: "invalid_instance" });

    const destinoId = req.body?.database;
    if (!destinoId) return res.status(400).send({ msg: "database_ausente" });

    const moverCliente = require("../lib/moverCliente.js");
    const r = await moverCliente.mover(app, { instancia: nome, destinoId });

    if (r.erro === "instancia_nao_registrada") return res.status(404).send({ msg: r.erro });
    // A conferência falhando volta 409 e com a LISTA: "não deu" sem dizer o que
    // não bateu manda a pessoa abrir o banco à mão.
    if (r.erro === "conferencia_falhou") return res.status(409).send({ msg: r.erro, problemas: r.problemas });
    if (r.erro) return res.status(400).send({ msg: r.erro });

    res.send(r);
  });
};
