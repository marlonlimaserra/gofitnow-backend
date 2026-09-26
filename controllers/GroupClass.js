// AS AULAS COLETIVAS — a grade que se repete toda semana.
//
// Pedido do Marlon em 18/09/2026: *"crie aqui em configuração 'Aula coletiva',
// vai ser parecido com o aulões, a diferença é que vai resetar todo o dia,
// coloque para configurar horário mínimo para check-in etc, e em qual unidade
// aquela aula vai estar disponível"*.
//
// ── DUAS PERMISSÕES ──────────────────────────────────────────────────────
//
// LER é `people.view`: quem atende precisa ver a grade do dia para saber quem
// vai chegar.
//
// MEXER é `schedule.manage` — a mesma de quem organiza a agenda. Montar a
// grade é exatamente isso: decidir o que a casa oferece e quando.
const limiteDoPlano = require("../lib/limiteDoPlano.js");
const instanceContext = require("../lib/instance.js");
const arquivos = require("../lib/arquivos.js");
const dominio = require("../lib/domain.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

module.exports = function (app) {
  const baseUrl = dominio.apiBaseUrl;
  // A contagem do teto, fora das rotas: a chamada a `barrou` tem de caber numa
  // linha com o `return` — ver `test/lib/limitesLigados.test.js`.
  const contarAulas = limiteDoPlano.contarNa(app, "group_classes");

  // Minutos desde a meia-noite → "07:05". O modelo guarda minutos; quem lê uma
  // folha impressa lê relógio.
  const horaDeMinutos = (n) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

  app.get("/group-classes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const rows =
      req.query.todos === "1"
        ? await app.api.groupClass.list()
        : await app.api.groupClass.listActive();

    res.send({ rows: rows.map(paraTela(req)) });
  });

  // ── A GRADE DE HOJE ─────────────────────────────────────────────────────
  //
  // O que a tela de check-in precisa, numa ida só: quais aulas são hoje, se a
  // janela está aberta e quantos já entraram.
  //
  // O estado é calculado NO SERVIDOR, e não na tela. Dois motivos: o relógio
  // de quem abre a tela pode estar errado — e a janela decide se alguém conta
  // presença —, e o fuso que vale é o da CONTA, que a tela teria de saber
  // aplicar igualzinho. Uma conta feita em dois lugares é uma conta que
  // diverge.
  //
  // Antes do `/:id` porque "today" cairia nele como se fosse um id.
  app.get("/group-classes/today", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const fuso = await app.api.tenant.timezoneOfInstance();
    const agora = new Date();

    // A LENTE. `units` é plural: a mesma aula pode valer em duas unidades, e
    // lista vazia vale para todas — ver o modelo.
    // A CERCA da unidade (26/09/2026). `listActive` recebe UMA unidade, então
    // quem é restrito e não escolheu nenhuma recebe a PRIMEIRA das dele — a
    // grade é sempre de uma unidade de cada vez, e mostrar a casa inteira para
    // quem só alcança uma seria o furo que esta mudança veio fechar.
    const cerca = lenteDeUnidade.recorte(user, req.query.unit);
    const aulas = await app.api.groupClass.listActive(cerca.unit || (cerca.units || [])[0] || "");
    const comEstado = aulas
      .map((a) => ({ aula: a, estado: app.api.groupClass.estadoAgora(a, agora, fuso) }))
      .filter((x) => x.estado.hoje);

    const dia = comEstado[0]?.estado?.data;
    const [contagem, fechadas] = dia
      ? await Promise.all([
          app.api.groupClassCheckin.contagemDoDia(dia),
          app.api.groupClassSession.fechadasDoDia(dia),
        ])
      : [{}, new Set()];

    res.send({
      // O DIA vai na resposta: é a chave que o check-in usa para gravar, e
      // deixar a tela montá-la do relógio dela seria deixá-la gravar no dia
      // errado quando o relógio estiver errado.
      dia: dia || app.api.groupClass.estadoAgora({ dias: [] }, agora, fuso).data,
      rows: comEstado.map(({ aula, estado }) => ({
        ...paraTela(req)(aula),
        aberta: estado.aberta,
        // CADA horário com a sua janela, a sua contagem e o seu fechamento:
        // a aula das 07:00 e das 18:00 é a mesma aula, mas às 07:10 só a
        // primeira está aberta — e fechar uma não fecha a outra.
        horarios: estado.horarios.map((h, i) => {
          const inicio = aula.horarios[i]?.inicio;
          const chave = `${aula._id}:${inicio}`;

          return {
            ...h,
            inicio_minutos: inicio,
            inscritos: contagem[chave] || 0,
            fechada: fechadas.has(chave),
            // Vagas esgotadas é DIFERENTE de fechada, e a tela precisa dizer
            // qual das duas: uma se resolve abrindo vaga, a outra com um
            // clique.
            lotada: aula.seats > 0 && (contagem[chave] || 0) >= aula.seats,
          };
        }),
      })),
    });
  });

  // O ENDEREÇO da capa, montado aqui e não guardado na aula. O documento
  // guarda só o ID: guardar a URL prenderia a aula ao endereço do backend do
  // dia em que a foto subiu.
  const urlDaCapa = (instancia, id) =>
    id ? `${baseUrl()}/public/group-class-image/${instancia}/${id}` : null;

  const paraTela = (req) => (a) => ({ ...a, coverUrl: urlDaCapa(req.instance, a.cover) });

  app.post("/group-classes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    if (await limiteDoPlano.barrou(app, req, res, "groupClasses", contarAulas)) return;

    const id = await app.api.groupClass.insert(req.body || {});
    // Sem nome, sem hora ou sem dia não existe aula: ela nunca aconteceria.
    if (!id) return res.status(400).send({ msg: req.t("errors.groupClassIncomplete") });

    app.insertUserActionHistory(req, user, "create_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(id) },
    });

    res.status(201).send(paraTela(req)(await app.api.groupClass.data(id)));
  });

  // A ORDEM antes do `:id`, pela mesma razão do `today`.
  app.put("/group-classes/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const ok = await app.api.groupClass.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.groupClassSaved") });
  });

  app.put("/group-classes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const existe = await app.api.groupClass.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const ok = await app.api.groupClass.update(req.params.id, req.body || {});
    if (!ok) return res.status(400).send({ msg: req.t("errors.groupClassIncomplete") });

    app.insertUserActionHistory(req, user, "update_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(req.params.id) },
    });

    res.send(paraTela(req)(await app.api.groupClass.data(req.params.id)));
  });

  // ── APAGAR LEVA O HISTÓRICO JUNTO ──────────────────────────────────────
  //
  // Diferente da unidade, que é RECUSADA quando tem gente: ali as pessoas
  // continuam existindo e ficariam apontando para o nada. Aqui o que fica são
  // os check-ins daquela aula, que não têm vida própria — sem a aula, nenhuma
  // tela os alcança e nada os apagaria.
  app.delete("/group-classes/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.groupClass.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    await app.api.groupClass.remove(req.params.id);
    await app.api.groupClassCheckin.removeAllOf(req.params.id);
    // A capa vai junto: sem isto ela ficaria apontando para uma aula que não
    // existe, e nada a alcançaria.
    await app.api.groupClassImage.removeAllOf(req.params.id).catch(() => {});
    await app.api.groupClassSession.removeAllOf(req.params.id).catch(() => {});

    app.insertUserActionHistory(req, user, "delete_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(req.params.id) },
      extra: { nome: alvo.name },
    });

    res.send({ msg: req.t("ok.groupClassRemoved") });
  });

  // ── OS INSCRITOS DE UM HORÁRIO ──────────────────────────────────────────
  //
  // *"inscrições"*. Com o nome de quem é: uma lista de presença sem nome não
  // responde nada.
  app.get("/group-classes/:id/checkins", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const alvo = await app.api.groupClass.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const fuso = await app.api.tenant.timezoneOfInstance();
    // Sem `dia` na query, é HOJE — que é o caso de quem abriu a tela para
    // chamar a lista. Montar o dia na tela deixaria o relógio dela decidir.
    const dia = String(req.query.dia || "") || app.api.groupClass.estadoAgora({ dias: [] }, new Date(), fuso).data;

    // A AULA vai junto, e não só os inscritos.
    //
    // Quem chama esta rota do diálogo já tem o nome na tela; quem a chama da
    // FOLHA IMPRESSA (`/imprimir/aula/:id`) chega por um link, sem tela
    // nenhuma atrás — e uma folha que diz "08:00" sem dizer de que aula é não
    // serve para nada na prancheta.
    //
    // Sai daqui em vez de uma segunda chamada porque é o mesmo documento: a
    // folha é a aula MAIS a lista, e duas requisições fariam o cabeçalho
    // aparecer um instante antes dos nomes.
    const inicio = Number(req.query.inicio);
    const horario = (alvo.horarios || []).find((h) => h.inicio === inicio);

    res.send({
      dia,
      aula: {
        id: String(alvo._id),
        nome: alvo.name,
        sala: alvo.sala || "",
        // O relógio de parede daquele horário, montado aqui: a tela receberia
        // minutos e teria de converter — e a terceira tela a fazer essa conta
        // é a que a faz errado.
        inicio: horario ? horaDeMinutos(horario.inicio) : "",
        fim: horario ? horaDeMinutos(horario.fim) : "",
      },
      fechada: await app.api.groupClassSession.estaFechada(req.params.id, dia, req.query.inicio),
      rows: await app.api.groupClassCheckin.inscritos(req.params.id, dia, req.query.inicio),
    });
  });

  // ── INSCREVER À MÃO ─────────────────────────────────────────────────────
  //
  // *"coloque botão para inserir aluno manualmente para ocupar vaga"*.
  //
  // A aula coletiva se enche sozinha, pelo aplicativo. Mas a recepção também
  // recebe o pedido pelo balcão e pelo WhatsApp, e sem esta rota ela teria de
  // pedir para a pessoa abrir o celular na frente dela — ou deixar a vaga
  // vazia numa aula que tem fila.
  //
  // ── POR QUE AS MESMAS TRÊS RECUSAS DO APLICATIVO ───────────────────────
  //
  // Lotada, fechada e "já entrou hoje" valem aqui também. A tentação é dizer
  // que quem está no balcão manda — mas quem está no balcão é justamente quem
  // não vê a lista inteira, e uma inscrição a mais numa aula de vinte vagas
  // aparece na hora da chamada, quando não dá mais para resolver.
  //
  // Quem precisa de uma vaga a mais aumenta as vagas, que é uma decisão
  // consciente e fica registrada; quem precisa reabrir, reabre.
  app.post("/group-classes/:id/checkins", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const aula = await app.api.groupClass.data(req.params.id);
    if (!aula) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const corpo = req.body || {};
    // A pessoa tem de ser da lista de quem chama — sem isto, um id de outra
    // conta entraria numa aula que não é dela.
    const pessoa = await app.api.user.dataStudent(user._id, String(corpo.person || ""));
    if (!pessoa) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    const fuso = await app.api.tenant.timezoneOfInstance();
    // O DIA vem do servidor quando não é dito, pela razão de sempre: o relógio
    // de quem está no balcão pode estar errado, e a inscrição de hoje iria
    // parar em ontem sem nada na tela denunciar.
    const dia = String(corpo.dia || "") || app.api.groupClass.estadoAgora({ dias: [] }, new Date(), fuso).data;
    const inicio = Number(corpo.inicio);

    if (await app.api.groupClassSession.estaFechada(req.params.id, dia, inicio)) {
      return res.status(409).send({ msg: req.t("errors.groupClassClosed"), code: "fechada" });
    }

    // A conferência de vaga é ANTES, e ela é uma conferência mesmo — não há
    // índice que a segure. Duas recepcionistas inscrevendo ao mesmo tempo na
    // última vaga passam as duas; é uma corrida estreita e o preço dela é uma
    // pessoa a mais numa aula, que a chamada resolve. Travar para valer custaria
    // um contador transacional em cima de uma collection que zera todo dia.
    if (aula.seats > 0) {
      const dentro = await app.api.groupClassCheckin.inscritos(req.params.id, dia, inicio);
      if (dentro.length >= aula.seats) {
        return res.status(409).send({ msg: req.t("errors.groupClassFull"), code: "lotada" });
      }
    }

    const r = await app.api.groupClassCheckin.entrar(req.params.id, dia, pessoa._id, {
      inicio,
      variosHorarios: aula.variosHorarios === true,
    });

    if (!r.ok) {
      const status = r.erro === "ja_entrou_hoje" ? 409 : 400;
      const chave = r.erro === "ja_entrou_hoje" ? "groupClassAlreadyToday" : "groupClassIncomplete";
      return res.status(status).send({ msg: req.t("errors." + chave), code: r.erro });
    }

    app.insertUserActionHistory(req, user, "enroll_group_class", {
      category: "settings",
      local: { target_type: "group_classes", target_id: String(req.params.id) },
    });

    res.status(201).send({ msg: req.t("ok.groupClassEnrolled"), novo: r.novo });
  });

  // ── E TIRAR DA LISTA ────────────────────────────────────────────────────
  //
  // O par de cima, e não um extra: inscrever à mão erra a pessoa às vezes, e
  // sem saída a recepção marcaria "faltou" em quem nunca se inscreveu — o
  // histórico da pessoa ficaria com uma falta inventada.
  //
  // Apaga a LINHA, e por isso pede o id dela: a mesma pessoa pode estar nos
  // dois horários do dia, e tirar "a pessoa da aula" tiraria dos dois.
  app.delete("/group-class-checkins/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const ok = await app.api.groupClassCheckin.remover(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    res.send({ msg: req.t("ok.groupClassLeft") });
  });

  // ── FECHAR E REABRIR ────────────────────────────────────────────────────
  //
  // *"'fechar' aula para ninguém mais se inscrever"*. É do DIA, e não da aula:
  // amanhã ela nasce aberta de novo, porque ninguém escreveu a linha de
  // amanhã.
  //
  // `schedule.manage` e não `people.view`: fechar é uma decisão sobre a aula,
  // como montá-la.
  app.post("/group-classes/:id/close", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.groupClass.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const corpo = req.body || {};
    const ok = await app.api.groupClassSession.fechar(
      req.params.id,
      corpo.dia,
      corpo.inicio,
      corpo.fechada !== false,
      user._id
    );
    if (!ok) return res.status(400).send({ msg: req.t("errors.groupClassIncomplete") });

    res.send({ msg: req.t("ok.groupClassSaved") });
  });

  // ── PRESENÇA OU FALTA ───────────────────────────────────────────────────
  //
  // *"poder dar PRESENÇA"* — *"presença ou falta no caso"*.
  //
  // Três estados, e não uma caixa de marcar: `inscrito` é "disse que vem",
  // `presente` é "veio", `faltou` é "não veio". Enquanto a aula não acontece,
  // ninguém faltou ainda — e uma caixa desmarcada diria que sim.
  app.put("/group-class-checkins/:id/presence", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const ok = await app.api.groupClassCheckin.marcarPresenca(
      req.params.id,
      (req.body || {}).presenca
    );
    if (!ok) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    res.send({ msg: req.t("ok.groupClassSaved") });
  });

  // ── O HISTÓRICO DE UMA PESSOA ───────────────────────────────────────────
  //
  // *"aqui no aluno preciso da parte do check-in, para ver aulas que ele fez
  // check-in e se ele foi marcado como presente ou não"*.
  //
  // O NOME da aula vem junto, resolvido aqui: a ficha mostra "Spinning, 18/09,
  // presente", e uma segunda chamada para traduzir ids em nomes faria a aba
  // piscar em dois tempos.
  app.get("/people/:id/class-checkins", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    // O VÍNCULO, e não só a existência: sem isto, um id adivinhado mostraria o
    // histórico de quem não é seu.
    const pessoa = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!pessoa) return res.status(404).send({ msg: req.t("errors.userNotFound") });

    const linhas = await app.api.groupClassCheckin.daPessoa(req.params.id);
    const aulas = await app.api.groupClass.list();
    const nomes = new Map(aulas.map((a) => [String(a._id), a.name]));

    res.send({
      rows: linhas.map((l) => ({
        id: String(l._id),
        // Aula apagada continua no histórico, sem nome: a presença aconteceu,
        // e sumir com ela seria reescrever o passado da pessoa.
        aula: nomes.get(String(l.class)) || "",
        dia: l.dia,
        inicio: l.inicio,
        presenca: l.presenca || "inscrito",
      })),
    });
  });

  // A CAPA sobe em `data:` no corpo, como a do plano e a da unidade: a tela já
  // reduz a imagem antes de enviar, e um `multipart` só para isto traria uma
  // dependência e um caminho de erro a mais.
  app.post("/group-classes/:id/cover", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "schedule.manage");
    if (user === false) return;

    const alvo = await app.api.groupClass.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.groupClassNotFound") });

    const parsed = app.api.groupClassImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.groupClassImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaCapa(req.instance, salva.id) });
  });

  // OS BYTES, sem sessão. A instância vai no CAMINHO porque aqui não há de
  // onde tirá-la: `<img src>` não manda cabeçalho nosso, e `/public/` não
  // passa pelo portão de instância.
  app.get("/public/group-class-image/:instance/:id", async function (req, res) {
    const instancia = instanceContext.normalize(req.params.instance);
    if (!instancia) return res.status(404).end();

    const img = await instanceContext.run(instancia, () =>
      app.api.groupClassImage.data(req.params.id)
    );
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.setHeader("Content-Type", img.mime);
    res.setHeader("ETag", etag);
    // Cache longo e `immutable`: o id nunca é reaproveitado — trocar a foto
    // gera outro documento —, então este endereço não segura imagem velha.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  });
};
