const { avisarSemEsperar } = require("../lib/avisar.js");
const instanceContext = require("../lib/instance.js");
const arquivos = require("../lib/arquivos.js");
const AulaoImage = require("../model/AulaoImage_model.js");
const dominio = require("../lib/domain.js");
const limiteDoPlano = require("../lib/limiteDoPlano.js");

// OS AULÕES — aula em grupo com data, lugar e vagas.
//
// ── A PERMISSÃO É A DA AGENDA, e isso é decisão ───────────────────────────
//
// `schedule.view` e `schedule.manage`, e não um `aulao.*` novo. Duas razões, e
// a segunda é a que decide:
//
//   1. Um aulão É um evento agendado. Quem cuida do calendário cuida dele, e
//      ninguém precisa de um cargo novo para marcar uma aula no parque.
//
//   2. Uma chave NOVA não chegaria a ninguém. `ensureSystemRoles` — que joga
//      permissão nova no papel Administrador — só roda no PROVISIONAMENTO de
//      uma instância, nunca no boot de uma que já existe. Uma `aulao.view`
//      nasceria sem estar em papel nenhum, o menu sumiria para todos e as rotas
//      devolveriam 403 — inclusive para o dono.
//
// É o mesmo raciocínio que levou `/me/checkout` a usar `users.manage`. No dia em
// que existir reconciliação de permissões para instância viva, isto vira
// `aulao.*`.
module.exports = function (app) {
  // O endereço deste backend, de `lib/domain.js`. Ele entra na URL da foto, que
  // vai numa página compartilhada — montá-la com o cabeçalho do navegador a
  // deixaria forjável.
  const baseUrl = dominio.apiBaseUrl;

  // ── O QUE A TELA MOSTRA DE CADA AULÃO ───────────────────────────────────
  //
  // Uma lista fechada, e não o documento cru — mesma regra da vitrine de
  // planos. `createdBy` é o id de quem cadastrou: não é informação de tela, e
  // mandá-lo de graça é vazar id de usuário para quem só quer ver a data.
  function paraTela(a, inscritos, req) {
    return {
      id: String(a._id),
      slug: a.slug,
      name: a.name,
      description: a.description || "",
      address: a.address || "",
      startsAt: a.startsAt,
      minutes: a.minutes,
      seats: a.seats,
      priceCents: a.priceCents,
      published: Boolean(a.published),
      showcase: Boolean(a.showcase),
      // ── OS IDs E AS URLs, os dois ─────────────────────────────────────
      //
      // O id é o que a tela GRAVA de volta (a capa é uma escolha entre as fotos
      // da galeria); a URL é o que ela MOSTRA. Mandar só o id obrigaria a tela
      // a montar o endereço, e para isso ela precisaria saber o nome da
      // instância — que ela não sabe, e que não deveria precisar saber.
      cover: a.cover || null,
      gallery: Array.isArray(a.gallery) ? a.gallery : [],
      coverUrl: a.cover ? `${baseUrl()}/public/aulao-image/${req.instance}/${a.cover}` : null,
      galleryUrls: (Array.isArray(a.gallery) ? a.gallery : []).map(
        (id) => `${baseUrl()}/public/aulao-image/${req.instance}/${id}`
      ),
      inscritos: typeof inscritos === "number" ? inscritos : undefined,
      // Quantas sobram. Calculado aqui e não na tela: a conta com `seats: 0`
      // (sem limite) é fácil de errar para "nenhuma vaga".
      vagasLivres: a.seats > 0 ? Math.max(0, a.seats - (inscritos || 0)) : null,
    };
  }

  app.get("/aulaoes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (user === false) return;

    // Os passados vêm por pedido explícito. A tela abre nos que ainda vão
    // acontecer, que é o que alguém quer ver — a lista do que já passou cresce
    // para sempre e empurraria o próximo aulão para o fim.
    const lista = await app.api.aulao.list({ passados: req.query.passados === "1" });

    // A contagem de inscritos de cada um, numa consulta só. Uma por aulão
    // seriam N idas ao banco para desenhar uma lista.
    const contagens = await app.api.aulao.contagemDeTodos(lista.map((a) => a._id));

    res.send({ rows: lista.map((a) => paraTela(a, contagens[String(a._id)] || 0, req)) });
  });

  app.get("/aulaoes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.view");
    if (user === false) return;

    const a = await app.api.aulao.byId(req.params.id);
    if (!a) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    const inscritos = await app.api.aulao.inscritos(a._id);

    // ── O ESTADO DO DINHEIRO, de todos de uma vez ─────────────────────────
    //
    // Uma cobrança por pessoa, e o que falta nela. Buscado em lote e não por
    // linha: trinta inscritos dariam sessenta idas ao banco (a cobrança e os
    // pagamentos dela) para desenhar uma lista.
    //
    // "Pago" NÃO é o campo `status` da cobrança: é a soma dos pagamentos
    // comparada com o valor — pagamento parcial existe, alguém paga metade hoje
    // e metade no dia da aula. É a mesma conta do `carteira`, e ela mora lá.
    const dinheiro = a.priceCents > 0 ? await app.api.finance.cobrancasDeAulao(a._id) : {};

    // As PESSOAS, e não só os ids: quem abre um aulão quer a lista de presença.
    const pessoas = await Promise.all(
      inscritos.map(async (i) => {
        const p = await app.api.user.data(i.person);
        return {
          id: String(i.person),
          name: p?.name || "—",
          email: p?.email || "",
          phone: p?.phone || "",
          origem: i.origem,
          desde: i.createdAt,

          // A FOTO, para a lista mostrar rosto e não só nome. O componente
          // `Avatar` monta o endereço a partir do id e desta data — ela é a
          // VERSÃO: sem ela, trocar a foto deixaria o navegador servindo a
          // antiga por um dia. Os bytes ele busca com a sessão, por rota própria.
          avatarAt: p?.avatarAt || null,

          // ── PRESENÇA: três estados ──────────────────────────────────────
          //
          // `true` veio, `false` faltou, `null` ninguém conferiu. O terceiro
          // não é preguiça de modelar: no dia seguinte, ausente-por-omissão
          // acusaria de falta quem o professor não chamou.
          presente: typeof i.presente === "boolean" ? i.presente : null,

          // ── O DINHEIRO desta pessoa neste aulão ─────────────────────────
          //
          // `null` quando o aulão é de graça — não há cobrança, e mandar zeros
          // faria a tela desenhar "pago" para uma aula sem preço.
          cobranca: dinheiro[String(i.person)] || null,

          // ── JÁ ERA ALUNO, OU CHEGOU PELO LINK? ──────────────────────────
          //
          // Gravado na inscrição desde 16/09/2026 (`novaPessoa`). Para as
          // inscrições ANTERIORES o campo não existe, e aí se deduz.
          //
          // ── A DEDUÇÃO VALE SÓ PARA `publica` ────────────────────────────
          //
          // Inscrição INTERNA implica que a pessoa já existia: quem inscreve de
          // dentro escolhe de uma lista, e só entra nela quem já é aluno. (O
          // caminho manual que cria alguém do zero é de hoje, e ele grava o
          // campo — não depende disto.)
          //
          // A primeira versão aplicava a janela de tempo a TODAS as origens, e
          // o resultado apareceu na instância de demonstração: nove inscritos
          // `interna` marcados como "novo pelo link", porque o semeador criou as
          // pessoas segundos antes de inscrevê-las. A conta estava certa sobre os
          // relógios e errada sobre o significado.
          //
          // Para `publica` sem o campo, a janela: a criação e a inscrição
          // acontecem na mesma requisição, separadas por uma escrita no banco —
          // milissegundos. Dez segundos é folga para servidor sob carga.
          nova:
            typeof i.novaPessoa === "boolean"
              ? i.novaPessoa
              : i.origem === "publica" &&
                Boolean(
                  p?.createdAt &&
                    i.createdAt &&
                    Math.abs(new Date(i.createdAt) - new Date(p.createdAt)) < 10000
                ),

          // TEM LOGIN, que é outra pergunta: uma ficha existe sem senha (foi o
          // profissional que a cadastrou), e a pessoa só entra no app depois de
          // um convite. Quem organiza um aulão quer saber as duas — quem é novo
          // para vender, e quem não tem acesso para convidar.
          //
          // Pelo `filter` do modelo, e não por `p.hasAccess`: `user.data()`
          // devolve o documento CRU, sem passar por ele — então `hasAccess` vem
          // `undefined` e a resposta seria "ninguém tem acesso", sempre, sem
          // erro nenhum. O `filter` é onde essa derivação mora (senha existe →
          // tem acesso), e é o único lugar que deve saber disso.
          temAcesso: Boolean(app.api.user.filter(p)?.hasAccess),
        };
      })
    );

    res.send({ aulao: paraTela(a, pessoas.length, req), inscritos: pessoas });
  });

  app.post("/aulaoes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    // ── O TETO DO PLANO ───────────────────────────────────────────────────
    //
    // Conta quantos aulões EXISTEM, não quantos já aconteceram: um aulão que
    // passou não pode ocupar vaga para sempre, senão o teto vira uma dívida que
    // só cresce e o cliente precisa apagar o histórico para cadastrar o próximo.
    //
    // Por isso a contagem não é `contarNa(app, "aulaoes")` — aquela conta a
    // collection inteira. Aqui é dos que ainda vão acontecer.
    if (await limiteDoPlano.barrou(app, req, res, "aulaoes", contarOsQueVemAi)) return;

    const r = await app.api.aulao.insert(user._id, req.body || {});
    if (!r.ok) return res.status(400).send({ msg: req.t("errors." + motivoDoErro(r.erro)) });

    app.insertUserActionHistory(req, user, "create_aulao", {
      category: "schedule",
      local: { target_type: "aulao", target_id: String(r.id) },
      extra: { name: String((req.body || {}).name || "") },
    });

    res.status(201).send({ id: String(r.id), slug: r.slug });
  });

  app.put("/aulaoes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const r = await app.api.aulao.update(req.params.id, req.body || {});
    if (!r.ok) {
      const status = r.erro === "nao_achei" ? 404 : 400;
      return res.status(status).send({ msg: req.t("errors." + motivoDoErro(r.erro)) });
    }

    res.send({ ok: true });
  });

  app.delete("/aulaoes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const a = await app.api.aulao.byId(req.params.id);
    if (!a) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    await app.api.aulao.remove(req.params.id);

    app.insertUserActionHistory(req, user, "delete_aulao", {
      category: "schedule",
      local: { target_type: "aulao", target_id: String(req.params.id) },
      extra: { name: a.name },
    });

    res.send({ ok: true });
  });

  // ── INSCREVER ───────────────────────────────────────────────────────────
  //
  // Do lado de DENTRO: o profissional põe alguém que já está na lista dele.
  // A inscrição pública é outra rota (e ainda não existe) porque ela cria a
  // pessoa, e criar pessoa a partir de um formulário aberto tem regras que esta
  // não precisa ter.
  // ── DUPLICAR ────────────────────────────────────────────────────────────
  //
  // *"bote opção de duplicar, aí eu só preencho a nova data e hora."*
  //
  // A cópia nasce RASCUNHO e com a data do original — que é a que vai ser
  // trocada. Ver `Aulao_model.duplicar`: publicar antes da correção poria no
  // ar, por alguns segundos, um aulão anunciando a data da semana passada.
  //
  // O LIMITE DO PLANO vale aqui como na criação: duplicar é criar. Sem esta
  // linha, o botão seria a porta de fundo para passar do teto — e quem a
  // usasse não saberia que passou.
  app.post("/aulaoes/:id/duplicar", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    if (await limiteDoPlano.barrou(app, req, res, "aulaoes", contarOsQueVemAi)) return;

    const r = await app.api.aulao.duplicar(user._id, req.params.id, { nome: (req.body || {}).name });

    if (!r.ok) return res.status(404).send({ msg: req.t("errors.aulaoNotFound"), code: r.erro });

    res.status(201).send({ ok: true, id: String(r.id), slug: r.slug });
  });

  app.post("/aulaoes/:id/inscritos", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    // ── DOIS CAMINHOS PARA INSCREVER À MÃO ────────────────────────────────
    //
    // *"e também opção de inserir manualmente."*
    //
    //   `person`        alguém que já está na lista deste profissional;
    //   `name`+`phone`  alguém que não está — a pessoa que apareceu na aula, ou
    //                   que mandou mensagem no WhatsApp.
    //
    // O segundo existia só na rota PÚBLICA, o que obrigava o profissional a
    // cadastrar a pessoa em Pessoas, voltar ao aulão e procurá-la — três telas
    // para anotar um nome.
    //
    // A busca por TELEFONE vem antes de criar, com a mesma normalização da rota
    // pública (`lib/telefone.js`): sem ela, inscrever à mão alguém que já é
    // aluno criaria um duplicado — e este caminho é o mais provável de receber o
    // número num formato diferente, porque quem digita é outra pessoa.
    const personIdPedido = String((req.body || {}).person || "");
    const nomeNovo = String((req.body || {}).name || "").trim();
    const telefoneNovo = String((req.body || {}).phone || "").trim();

    let personId = personIdPedido;
    let pessoa;
    let novaPessoa = false;

    if (personId) {
      // A pessoa tem de ser da lista de quem chama — sem isto, um id de outra
      // conta inscreveria alguém que este profissional não acompanha.
      pessoa = await app.api.user.dataStudent(user._id, personId);
      if (!pessoa) return res.status(404).send({ msg: req.t("errors.personNotFound") });
    } else if (telefoneNovo || nomeNovo) {
      if (!telefoneNovo) {
        return res.status(400).send({ msg: req.t("errors.bookingPhone"), code: "precisa_do_telefone" });
      }

      pessoa = await app.api.user.dataByPhone(telefoneNovo);

      if (pessoa) {
        personId = String(pessoa._id);
        // Achada pelo telefone, mas talvez não seja da lista DELE: vincula, como
        // a rota pública faz. Sem isto a pessoa fica inscrita e invisível na
        // lista de Pessoas.
        await app.api.link.link(user._id, personId, "aulao");
      } else {
        if (!nomeNovo) {
          return res.status(422).send({ msg: req.t("errors.bookingName"), code: "precisa_do_nome" });
        }
        personId = String(
          await app.api.user.insertStudent(user._id, { name: nomeNovo, phone: telefoneNovo })
        );
        pessoa = await app.api.user.data(personId);
        novaPessoa = true;
      }
    } else {
      return res.status(400).send({ msg: req.t("errors.aulaoNoPerson") });
    }

    const r = await app.api.aulao.inscrever(req.params.id, personId, { origem: "interna", novaPessoa });

    if (!r.ok) {
      const status = r.erro === "lotado" ? 409 : r.erro === "ja_inscrito" ? 409 : 404;
      return res.status(status).send({ msg: req.t("errors." + motivoDoErro(r.erro)), code: r.erro });
    }

    // ── A COBRANÇA ────────────────────────────────────────────────────────
    //
    // Só quando o aulão TEM preço, e é a mesma regra do compromisso com serviço
    // pago: quem entra num aulão de R$ 25 já sai devendo R$ 25, sem alguém
    // precisar lançar à mão e esquecer metade das vezes.
    //
    // O vencimento é o DIA DO AULÃO. Não hoje: cobrar no ato transformaria uma
    // inscrição feita com três semanas de antecedência em pendência de três
    // semanas no relatório.
    let cobranca = null;
    if (r.aulao.priceCents > 0) {
      // Já cobrada? Alguém que saiu e voltou não deve duas vezes. A cobrança
      // NÃO é apagada na saída (ela pode estar paga — ver o DELETE abaixo), então
      // sem esta conferência a segunda inscrição criaria a segunda dívida.
      const jaExiste = await app.api.finance.chargeOfAulao(r.aulao._id, personId);
      if (jaExiste) {
        cobranca = jaExiste._id;
      } else {
        cobranca = await app.api.finance.insertCharge(
          personId,
          {
            amount: r.aulao.priceCents,
            dueDate: r.aulao.startsAt,
            description: r.aulao.name,
            aulao: r.aulao._id,
          },
          user._id,
          await app.api.tenant.currencyFor()
        );
      }
    }

    // ── O AVISO ───────────────────────────────────────────────────────────
    //
    // Para a PESSOA inscrita, e não para quem inscreveu: quem inscreveu está na
    // tela, olhando o resultado. `de` evita avisar alguém do próprio ato — o
    // profissional que se inscreve no próprio aulão não recebe recado.
    avisarSemEsperar(app, "aulao", {
      para: personId,
      de: String(user._id),
      lang: pessoa.lang,
      vars: { name: r.aulao.name, when: String(r.aulao.startsAt) },
    });

    res.status(201).send({ ok: true, cobranca: cobranca ? String(cobranca) : null });
  });

  // ── MARCAR PRESENÇA ─────────────────────────────────────────────────────
  //
  // `schedule.manage`, como inscrever: é a mesma natureza — mexer na lista de
  // uma aula.
  //
  // `presente: null` limpa a marca, e existe porque o clique errado tem de ter
  // volta sem obrigar a escolher entre presente e ausente. Ver
  // `Aulao_model.marcarPresenca` sobre os três estados.
  app.put("/aulaoes/:id/inscritos/:personId/presenca", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const pedido = (req.body || {}).presente;
    const valor = pedido === null || pedido === undefined ? null : Boolean(pedido);

    const r = await app.api.aulao.marcarPresenca(req.params.id, req.params.personId, valor);
    if (!r.ok) return res.status(404).send({ msg: req.t("errors.aulaoNotEnrolled"), code: r.erro });

    res.send({ ok: true, presente: r.presente === undefined ? null : r.presente });
  });

  // ── MARCAR COMO PAGO ────────────────────────────────────────────────────
  //
  // *"senti falta de 'marcar como pago'."*
  //
  // No app isto sempre foram dois passos — lançar o pagamento e depois fechar a
  // cobrança —, e ninguém faz os dois trinta vezes depois de um aulão.
  //
  // ── `finance.manage`, e não `schedule.manage` ──────────────────────────
  //
  // Porque o que esta rota faz é ESCREVER DINHEIRO: ela lança um pagamento no
  // financeiro do cliente. Quem cuida da lista de uma aula não é
  // necessariamente quem pode dizer que entrou dinheiro — e numa conta com
  // recepção essas duas pessoas são diferentes de propósito.
  //
  // Se o Marlon quiser que a recepção quite, ele dá `finance.manage` ao tipo
  // dela. A tela esconde o botão de quem não tem — e o servidor recusa de todo
  // jeito, porque esconder botão nunca foi proteção.
  app.post("/aulaoes/:id/inscritos/:personId/pago", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const a = await app.api.aulao.byId(req.params.id);
    if (!a) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    // Aulão de graça não tem o que quitar. Recusa em vez de criar uma cobrança
    // de zero: um lançamento de R$ 0,00 no financeiro é lixo que alguém vai
    // tentar entender depois.
    if (!(a.priceCents > 0)) {
      return res.status(409).send({ msg: req.t("errors.aulaoFree"), code: "aulao_gratuito" });
    }

    const cobranca = await app.api.finance.chargeOfAulao(a._id, req.params.personId);
    if (!cobranca) {
      return res.status(404).send({ msg: req.t("errors.chargeNotFound"), code: "sem_cobranca" });
    }

    const r = await app.api.finance.quitarCobranca(String(cobranca._id), {
      method: (req.body || {}).method,
      createdBy: user._id,
    });

    if (!r.ok) return res.status(404).send({ msg: req.t("errors.chargeNotFound"), code: r.erro });

    // `ja_pago` volta 200 e não erro: o estado desejado é o estado atual. Dois
    // cliques num botão de "pago" é o gesto mais natural que existe quando a
    // rede demora, e o segundo não pode parecer falha.
    res.send({ ok: true, jaEstava: r.erro === "ja_pago", valor: r.valor || 0 });
  });

  // ── DESFAZER O "MARCAR COMO PAGO" ───────────────────────────────────────
  //
  // O mesmo botão, apertado de novo. `DELETE` no mesmo caminho do `POST`:
  // é a mesma coisa sendo desfeita, e um caminho novo ("/nao-pago") faria
  // parecer outra operação.
  //
  // `finance.manage` como o irmão dele: desfazer um pagamento é mexer em
  // dinheiro tanto quanto lançá-lo — e talvez mais, porque APAGA.
  app.delete("/aulaoes/:id/inscritos/:personId/pago", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const a = await app.api.aulao.byId(req.params.id);
    if (!a) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    const cobranca = await app.api.finance.chargeOfAulao(a._id, req.params.personId);
    if (!cobranca) {
      return res.status(404).send({ msg: req.t("errors.chargeNotFound"), code: "sem_cobranca" });
    }

    const r = await app.api.finance.reabrirCobranca(String(cobranca._id));
    if (!r.ok) return res.status(404).send({ msg: req.t("errors.chargeNotFound"), code: r.erro });

    // `apagados: 0` volta 200: pode não haver pagamento automático nenhum (a
    // cobrança foi quitada à mão no financeiro). O estado desejado — não pago
    // pelo botão — é o estado atual, e isso não é falha.
    // `manual` sobe para a tela: quando há parciais lançados à mão, ela precisa
    // dizer ONDE desfazer em vez de anunciar que desfez.
    res.send({ ok: true, apagados: r.apagados, manual: r.manual === true, falta: r.falta });
  });

  app.delete("/aulaoes/:id/inscritos/:personId", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const r = await app.api.aulao.desinscrever(req.params.id, req.params.personId);
    if (!r.ok) return res.status(404).send({ msg: req.t("errors.aulaoNotEnrolled") });

    // A COBRANÇA NÃO é apagada junto, e é decisão: ela pode já estar paga, e
    // apagar lançamento pago é apagar dinheiro que entrou. Quem tira alguém do
    // aulão decide no financeiro o que fazer com o que foi cobrado.
    res.send({ ok: true });
  });


  // ── DE QUEM É ESTE AULÃO ────────────────────────────────────────────────
  //
  // As rotas `/public/` não passam pelo portão de instância (ver a lista
  // `SEM_INSTANCIA` em lib/instanceGate.js): elas chegam antes de qualquer
  // sessão, e o portão nem tenta resolver. Então a resolução é feita aqui, e
  // pelo mesmo caminho do `/public/theme`: o host vem do pedido e é conferido
  // contra o registro central.
  //
  // O navegador diz o ENDEREÇO, nunca a instância. Aceitar um `X-Instance` aqui
  // deixaria qualquer um ler o aulão de outro cliente trocando um cabeçalho.
  async function instanciaDoPedido(req) {
    const host = String(
      req.query.host || req.headers["x-instance-host"] || req.headers["x-forwarded-host"] || req.headers.host || ""
    );
    if (!host) return "";
    return (await app.api.center.instanceForHost(host)) || "";
  }

  // ── AS FOTOS ────────────────────────────────────────────────────────────
  //
  // Subir devolve um id, e a TELA decide se ele vai para a capa ou para a
  // galeria — gravando no aulão. A imagem nasce órfã de propósito: quem sobe
  // três e salva com duas não fica com a terceira pendurada, porque o dono da
  // verdade é o aulão salvo (ver `pruneUnused`).
  app.post("/aulaoes/:id/imagens", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const a = await app.api.aulao.byId(req.params.id);
    if (!a) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    const lida = app.api.aulaoImage.parseDataUri((req.body || {}).image);
    if (!lida) return res.status(400).send({ msg: req.t("errors.aulaoBadImage") });

    // O teto por aulão. Sem ele a rota é um caminho de encher o bucket em laço
    // — e ninguém rola treze fotos de uma aula.
    const quantas = await app.api.aulaoImage.count(a._id);
    if (quantas >= AulaoImage.MAX_POR_AULAO) {
      return res.status(409).send({ msg: req.t("errors.aulaoTooManyImages") });
    }

    const salva = await app.api.aulaoImage.save(a._id, lida.mime, lida.buffer);
    res.status(201).send({ id: salva.id, url: `${baseUrl()}/public/aulao-image/${req.instance}/${salva.id}` });
  });

  // A imagem, aberta. A INSTÂNCIA vai no caminho pela mesma razão da imagem de
  // marca: esta rota chega sem sessão e sem cabeçalho, e as imagens moram no
  // banco de um cliente — sem o nome ali não haveria como saber qual abrir.
  app.get("/public/aulao-image/:instance/:id", async function (req, res) {
    const instance = instanceContext.normalize(req.params.instance);
    if (!instance) return res.status(404).end();

    const img = await instanceContext.run(instance, () => app.api.aulaoImage.data(req.params.id));
    // 404 seco: aqui não há quem leia mensagem traduzida.
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';

    // Cache longo e `immutable`: o id nunca é reaproveitado — trocar a capa
    // gera outro documento —, então não há como este endereço segurar imagem
    // velha.
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    // Os bytes DEPOIS do 304: com o navegador já tendo a versão cacheada, não
    // há ida ao bucket nenhuma.
    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.end(bytes);
  });

  // ── A VITRINE DA VAFIT ──────────────────────────────────────────────────
  //
  // "pode criar lá no site a rota que verifica todo mundo que tem aulão
  // disponível."
  //
  // É a ÚNICA rota do produto que devolve dado de clientes diferentes na mesma
  // resposta. Tudo o mais é escopado por instância; esta atravessa o escopo de
  // propósito, porque a pergunta ("quais aulões existem?") não tem dono.
  //
  // ── O QUE A TORNA ACEITÁVEL ───────────────────────────────────────────
  //
  // O consentimento, e ele é explícito no dado: só entra aulão com
  // `showcase: true`, marca que existe só para isto e que nasce desligada.
  // Publicar na página do próprio cliente é uma coisa; aparecer no site da
  // VAFIT é outra — e são duas marcas separadas para que ninguém seja divulgado
  // sem ter pedido. Ver `Aulao_model.paraVitrine`.
  //
  // ── SEM INSTÂNCIA, e por isso sem `req.instance` ─────────────────────
  //
  // Quem chama é o site da VAFIT (`vafit.app`), que não é de cliente nenhum. O
  // nome da instância de cada aulão vai na RESPOSTA, porque é ele que monta o
  // endereço da foto e o link da inscrição — e é público por natureza: é o
  // subdomínio pelo qual o cliente já se anuncia.
  app.get("/public/aulaoes", async function (req, res) {
    const lista = await app.api.aulao.paraVitrine({ limite: req.query.limite });

    // ── O FUSO DE CADA ESTÚDIO ────────────────────────────────────────────
    //
    // A vitrine junta aulões de clientes diferentes, e cada um tem o relógio
    // dele: um aulão do Porto e um de Belém aparecem na mesma lista. Sem isto, a
    // página do site desenhava os dois no relógio de quem estava olhando — e
    // quem viu "08:00" num aulão em Belém, lendo de Lisboa, chegaria quatro
    // horas depois da aula.
    //
    // Uma leitura por INSTÂNCIA distinta, e não por linha: vinte aulões de três
    // estúdios são três leituras. `timezoneOfInstance` passa pelo cache de
    // configuração da conta, mas mesmo assim pedir vinte vezes o que tem três
    // respostas é gasto sem troco.
    const fusos = new Map();
    for (const instancia of new Set(lista.map((a) => a.instance))) {
      fusos.set(
        instancia,
        await instanceContext.run(instancia, () => app.api.tenant.timezoneOfInstance())
      );
    }

    // Cache curto na borda: a vitrine muda quando alguém marca um aulão, e não
    // de minuto em minuto. Dois minutos absorvem uma visita em massa sem
    // segurar um aulão novo por muito tempo.
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120, stale-while-revalidate=600");

    res.send({
      rows: lista.map((a) => ({
        instance: a.instance,
        slug: a.slug,
        name: a.name,
        // Cortada: a vitrine é uma lista, e a descrição inteira de vinte aulões
        // seria uma parede de texto. Quem se interessa abre a página do aulão.
        resumo: String(a.description || "").slice(0, 180),
        address: a.address || "",
        startsAt: a.startsAt,
        minutes: a.minutes,
        priceCents: a.priceCents,
        seats: a.seats,
        cover: a.cover ? `${baseUrl()}/public/aulao-image/${a.instance}/${a.cover}` : null,
        // O endereço da página do aulão, montado aqui: o site não conhece a
        // regra de como um cliente é alcançado (subdomínio, domínio próprio),
        // e ela não deveria vazar para lá.
        url: `https://${a.instance}.${dominio.BASE_DOMAIN}/aulao/${a.slug}`,
        // O relógio deste estúdio. O site desenha `startsAt` nele, e não no de
        // quem visita — ver acima.
        timezone: fusos.get(a.instance) || null,
      })),
    });
  });

  // ── A PÁGINA PÚBLICA DE UM AULÃO ────────────────────────────────────────
  //
  // Por INSTÂNCIA, como a de agendamento: `marlon.vafit.app/aulao/<slug>`. A
  // vitrine no site da VAFIT, que junta aulões de clientes diferentes, é outra
  // coisa — ela atravessa o escopo de instância de propósito, e é decisão de
  // arquitetura ainda não tomada (ver o cabeçalho de Aulao_model).
  //
  // RASCUNHO não abre. Um aulão sem foto e sem endereço, alcançável por link
  // antes de estar pronto, é divulgação errada — e divulgação não se desfaz.
  app.get("/public/aulao/:slug", async function (req, res) {
    const instancia = await instanciaDoPedido(req);
    if (!instancia) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    const { a, inscritos } = await instanceContext.run(instancia, async () => {
      const achado = await app.api.aulao.bySlug(req.params.slug);
      return {
        a: achado,
        inscritos: achado ? await app.api.aulao.contarInscritos(achado._id) : 0,
      };
    });

    if (!a || !a.published) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    const base = `${baseUrl()}/public/aulao-image/${instancia}`;

    // ── O FUSO DO ESTÚDIO VIAJA JUNTO ─────────────────────────────────────
    //
    // Sem ele, a página desenhava `startsAt` no relógio de QUEM OLHA: um aulão
    // das 08:00 em São Paulo aparecia como 13:00 para quem abrisse de Lisboa — e
    // a pessoa anotava 13:00.
    //
    // Eu tinha escrito o contrário num comentário, e o raciocínio estava errado:
    // "mostra a hora de lá, que é a hora em que a pessoa tem de estar no lugar".
    // Não é. O aulão acontece num ENDEREÇO, e quem vai tem de chegar na hora
    // daquele endereço. Hora de quem olha só serviria para evento on-line.
    //
    // Vai o nome da zona (`America/Sao_Paulo`) e não o deslocamento: o
    // deslocamento muda com horário de verão, e um número gravado hoje estaria
    // errado em novembro.
    const fuso = await instanceContext.run(instancia, () =>
      app.api.tenant.timezoneOfInstance()
    );

    // ── O QUE SAI PARA QUEM NÃO É CLIENTE ─────────────────────────────────
    //
    // O que vende o aulão, e nada além. NÃO sai a lista de inscritos — nem os
    // nomes, nem quantos, quando o aulão é aberto: "3 inscritos" num aulão sem
    // limite é informação que só desanima. Com limite, o que interessa é
    // quantas VAGAS sobram, e essa sai.
    res.send({
      aulao: {
        slug: a.slug,
        name: a.name,
        description: a.description || "",
        address: a.address || "",
        startsAt: a.startsAt,
        minutes: a.minutes,
        priceCents: a.priceCents,
        seats: a.seats,
        vagasLivres: a.seats > 0 ? Math.max(0, a.seats - inscritos) : null,
        lotado: a.seats > 0 && inscritos >= a.seats,
        cover: a.cover ? `${base}/${a.cover}` : null,
        gallery: (a.gallery || []).map((id) => `${base}/${id}`),
        // O relógio em que `startsAt` deve ser lido — ver acima.
        timezone: fuso,
      },
    });
  });

  // ── INSCREVER-SE DE FORA ────────────────────────────────────────────────
  //
  // Quem chega pelo link não tem conta. A ficha é criada como na página de
  // agendamento — e pelo mesmo motivo: reaproveitar pelo e-mail evita uma ficha
  // nova a cada inscrição, e é o que faz o histórico de quem já é cliente
  // continuar sendo dele.
  app.post("/public/aulao/:slug/inscricao", async function (req, res) {
    const instancia = await instanciaDoPedido(req);
    if (!instancia) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    // O resto roda DENTRO do contexto: a pessoa é criada no banco daquele
    // cliente, e o vínculo e a cobrança também. Fora dele, `connectToServer`
    // não sabe qual banco abrir.
    return instanceContext.run(instancia, async () => {
    const a = await app.api.aulao.bySlug(req.params.slug);
    if (!a || !a.published) return res.status(404).send({ msg: req.t("errors.aulaoNotFound") });

    const nome = String((req.body || {}).name || "").trim();
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const telefone = String((req.body || {}).phone || "").trim();

    // ── O WHATSAPP É O QUE SE PEDE PRIMEIRO ───────────────────────────────
    //
    // *"para garantir a vaga, peça só o whatsapp; aí quando preencher, verificar
    // se existe no sistema; se não existir peça o nome, e cadastre só isso."*
    //
    // Antes, o nome era obrigatório de saída e o e-mail era a chave de
    // reaproveitamento. Isso pedia três campos a quem já era aluno do estúdio —
    // e pedia o dado que o profissional JÁ TEM.
    //
    // Agora: o telefone identifica. Quem já existe é reconhecido e inscrito sem
    // digitar mais nada; quem não existe recebe um segundo passo pedindo o nome.
    if (!telefone) return res.status(400).send({ msg: req.t("errors.bookingPhone"), code: "precisa_do_telefone" });
    if (email && !app.validator.isEmail(email)) return res.status(400).send({ msg: req.t("errors.invalidEmail") });

    const dono = a.createdBy;

    // ── QUEM É ESTA PESSOA ────────────────────────────────────────────────
    //
    // Pelo TELEFONE primeiro, que é o que ela digitou. O e-mail continua valendo
    // como segunda chave: quem se inscreveu antes por e-mail (versão anterior
    // desta rota, ou a página de agendamento) é a mesma pessoa.
    //
    // A comparação de telefone normaliza os formatos — ver `lib/telefone.js`.
    // Sem isso, "(11) 98765-0001" e "11987650001" seriam duas pessoas.
    let existente = await app.api.user.dataByPhone(telefone);
    if (!existente && email) existente = await app.api.user.dataByEmail(email);

    let personId;

    if (existente) {
      personId = existente._id;
      // Vincula a quem criou o aulão: sem isto a pessoa existe e não aparece na
      // lista de ninguém.
      await app.api.link.link(dono, personId, "aulao");
    } else {
      // ── SÓ AQUI O NOME É NECESSÁRIO ─────────────────────────────────────
      //
      // A tela pede em um segundo passo, depois de saber que o número é novo. O
      // código é o que ela lê para decidir mostrar o campo — a mensagem é para
      // quem chamar a rota direto.
      if (!nome) {
        return res.status(422).send({
          msg: req.t("errors.bookingName"),
          code: "precisa_do_nome",
        });
      }

      // "cadastre só isso": nome e telefone. O e-mail entra apenas se alguém o
      // mandou — a tela não pede mais.
      personId = await app.api.user.insertStudent(dono, { name: nome, email: email || "", phone: telefone });
    }

    // `novaPessoa` é o que a busca por telefone acabou de responder: esta rota
    // SABE se criou ou achou, e é a única que sabe sem chutar.
    const r = await app.api.aulao.inscrever(a._id, personId, {
      origem: "publica",
      novaPessoa: !existente,
    });
    if (!r.ok) {
      const status = r.erro === "lotado" || r.erro === "ja_inscrito" ? 409 : 404;
      return res.status(status).send({ msg: req.t("errors." + motivoDoErro(r.erro)), code: r.erro });
    }

    // A cobrança nasce igual à da inscrição de dentro — mesma conta, mesmo
    // vencimento, mesma trava contra cobrar duas vezes.
    if (a.priceCents > 0) {
      const jaExiste = await app.api.finance.chargeOfAulao(a._id, personId);
      if (!jaExiste) {
        await app.api.finance.insertCharge(
          personId,
          { amount: a.priceCents, dueDate: a.startsAt, description: a.name, aulao: a._id },
          dono,
          await app.api.tenant.currencyFor()
        );
      }
    }

    // ── QUEM É AVISADO AQUI É O PROFISSIONAL ──────────────────────────────
    //
    // Ao contrário da inscrição de dentro, em que ele está na tela olhando o
    // resultado. Aqui alguém entrou na aula dele sem ele estar na frente — é a
    // mesma razão do aviso de agendamento.
    avisarSemEsperar(app, "aulaoInscricao", {
      para: String(dono),
      lang: undefined,
      vars: { person: nome, name: a.name },
    });

    res.status(201).send({ ok: true });
    });
  });

  // ── QUANTOS AULÕES CONTAM PARA O TETO ───────────────────────────────────
  //
  // Os que ainda VÃO ACONTECER, e não a collection inteira (é por isso que não
  // serve o `contarNa` genérico). Um aulão que já passou não pode ocupar vaga
  // para sempre: o teto viraria uma dívida crescente, e o cliente precisaria
  // apagar o histórico para cadastrar o próximo.
  async function contarOsQueVemAi() {
    const col = await app.api.aulao.collection();
    return col.countDocuments({ startsAt: { $gte: new Date() } });
  }

  function motivoDoErro(erro) {
    return (
      {
        sem_nome: "aulaoNoName",
        sem_data: "aulaoNoDate",
        nao_achei: "aulaoNotFound",
        lotado: "aulaoFull",
        ja_inscrito: "aulaoAlreadyIn",
      }[erro] || "invalidData"
    );
  }
};
