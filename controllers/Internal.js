const ensureSchema = require("../database/schema.js");
const instanceContext = require("../lib/instance.js");

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
