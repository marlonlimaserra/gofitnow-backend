const { registrarRotasDeDocumento } = require("../lib/rotasDeDocumento.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");
const { documentoModelo } = require("../lib/documentoModelo.js");
const pendencias = require("../lib/pendencias.js");
const categoriasDePendencia = require("../lib/categoriasDePendencia.js");

// A ABA DOCUMENTOS DA FICHA — os arquivos de uma pessoa, e o termo gerado.
//
// *"lá dentro do aluno, coloque a aba de documentos, onde podemos colocar
// vários arquivos, e lá em cima um select chamado baixar documento; se for PDF
// já abre o visualizador para imprimir, HTML também"*.
//
// ── SÃO DUAS COISAS NA MESMA ABA, e elas se encontram ───────────────────
//
// GUARDAR: o termo assinado e escaneado, a carteirinha, o atestado de aptidão.
// GERAR: pegar um modelo da casa e sair com a folha preenchida para assinar.
//
// O ciclo fecha na mesma tela: gera, imprime, colhe a assinatura, escaneia, e
// guarda de volta ali. Separá-las em duas telas faria a segunda metade do
// trabalho acontecer noutro lugar — e é a metade que ninguém lembra de fazer.
module.exports = function (app) {
  async function pessoaDoProfissional(req, res, trainer, id) {
    const pessoa = await app.api.user.dataStudent(trainer._id, id);
    if (!pessoa) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return pessoa;
  }

  app.get("/people/:personId/documents", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    res.send({
      rows: await app.api.personDocument.listar(req.params.personId),
      // O QUE ESTÁ EM ABERTO, na mesma resposta — as escritas à mão e os
      // documentos obrigatórios que faltam, numa lista só.
      pendencias: await pendencias.pendenciasDe(app, req.params.personId),
      // E as resolvidas, para a aba poder mostrar o histórico: "a camisa foi
      // entregue pelo Marlon em 20/09" é o que se confere quando o aluno diz
      // que nunca recebeu.
      resolvidas: await app.api.pendency.listar(req.params.personId, { incluirResolvidas: true }),
      categorias: categoriasDePendencia.paraTela(req.t),
      devedores: categoriasDePendencia.devedoresParaTela(req.t),
      // Os modelos ATIVOS vêm na mesma resposta: o seletor "Gerar documento"
      // fica no topo desta aba, e pedi-los à parte seria uma segunda ida ao
      // servidor para desenhar uma tela só.
      modelos: await app.api.documentTemplate.listar({ somenteAtivos: true }),
    });
  });

  // ── GUARDAR UM ARQUIVO ──────────────────────────────────────────────────
  //
  // Um por requisição, como os anexos de funcionário: o `bodyParser` corta o
  // corpo em 10 MB e o base64 infla ~33%, então mandar cinco de uma vez
  // derrubaria o lote inteiro.
  //
  // `people.edit` e não `people.view`: guardar documento na ficha de alguém é
  // mexer na ficha.
  app.post("/people/:personId/documents", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const arquivo = app.api.personDocument.parseArquivo(req.body || {});
    if (!arquivo) return res.status(400).send({ msg: req.t("errors.attachmentTooBig") });

    const id = await app.api.personDocument.insert(
      req.params.personId,
      arquivo,
      trainer,
      (req.body || {}).note,
      // Qual exigência este arquivo cumpre. Sem o elo, o sistema veria um PDF
      // chamado "scan_001.pdf" e não teria como saber que é o termo.
      (req.body || {}).template
    );

    app.insertUserActionHistory(req, trainer, "create_person_document", {
      category: "people",
      local: { target_type: "person_documents", target_id: String(id) },
    });

    res.status(201).send(await app.api.personDocument.data(id));
  });

  // ── AS PENDÊNCIAS ESCRITAS À MÃO ────────────────────────────────────────
  //
  // *"a academia cadastrou camisa como pendência, para eu ser barrado na
  // recepção para eles me entregarem a camisa"*.
  //
  // Elas moram aqui, e não num controller próprio, porque a ficha pede as duas
  // fontes na MESMA resposta — a aba mostra uma lista só, e separar as rotas
  // faria a tela juntar o que o servidor já sabe juntar.
  app.post("/people/:personId/pendencies", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const id = await app.api.pendency.insert(req.params.personId, req.body || {}, trainer);
    if (!id) return res.status(400).send({ msg: req.t("errors.requireTitle") });

    app.insertUserActionHistory(req, trainer, "create_pendency", {
      category: "people",
      local: { target_type: "pendencies", target_id: String(id), person: req.params.personId },
      extra: { titulo: (req.body || {}).titulo },
    });

    res.status(201).send({ pendencias: await pendencias.pendenciasDe(app, req.params.personId) });
  });

  // ── RESOLVER, e não apagar ──────────────────────────────────────────────
  //
  // A camisa entregue vira uma linha resolvida, com quem entregou e quando.
  // Apagar apagaria a prova de que a casa cumpriu — e é justamente isso que
  // alguém vai querer conferir quando o aluno disser que nunca recebeu.
  app.put("/people/:personId/pendencies/:id/resolver", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const ok = await app.api.pendency.resolver(req.params.personId, req.params.id, trainer);
    if (!ok) return res.status(404).send({ msg: req.t("errors.pendencyNotFound") });

    app.insertUserActionHistory(req, trainer, "resolve_pendency", {
      category: "people",
      local: { target_type: "pendencies", target_id: String(req.params.id), person: req.params.personId },
    });

    res.send({ pendencias: await pendencias.pendenciasDe(app, req.params.personId) });
  });

  // Apagar existe para o que foi criado errado — "camiseta" duas vezes. O
  // caminho normal é resolver.
  app.delete("/people/:personId/pendencies/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const ok = await app.api.pendency.remove(req.params.personId, req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.pendencyNotFound") });

    res.send({ pendencias: await pendencias.pendenciasDe(app, req.params.personId) });
  });

  // ── DISPENSAR UMA EXIGÊNCIA ─────────────────────────────────────────────
  //
  // O aluno assinou em papel, e o papel está na pasta física. A exigência está
  // cumprida e o sistema não tem o arquivo.
  //
  // Sem esta porta, a única saída seria escanear qualquer coisa para destravar
  // — e aí a ficha teria um PDF em branco afirmando que o termo existe.
  //
  // `people.edit`, como guardar: é a mesma decisão sobre a ficha de alguém.
  app.post("/people/:personId/documents/dispensar", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const modelo = await app.api.documentTemplate.data((req.body || {}).template);
    if (!modelo) return res.status(404).send({ msg: req.t("errors.templateNotFound") });

    await app.api.personDocument.dispensar(
      req.params.personId,
      modelo.id,
      (req.body || {}).motivo,
      { ...trainer, nomeDoModelo: modelo.name }
    );

    app.insertUserActionHistory(req, trainer, "waive_person_document", {
      category: "people",
      local: { target_type: "person_documents", target_id: String(modelo.id), person: req.params.personId },
      extra: { modelo: modelo.name },
    });

    res.status(201).send({
      rows: await app.api.personDocument.listar(req.params.personId),
      pendencias: await pendencias.pendenciasDe(app, req.params.personId),
    });
  });

  app.delete("/people/:personId/documents/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const ok = await app.api.personDocument.remove(req.params.personId, req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.documentNotFound") });

    // As pendências voltam na resposta: apagar um termo assinado RECRIA a
    // exigência, e a tela precisa mostrar isso na hora — senão alguém apaga por
    // engano e só descobre quando o aluno não consegue entrar.
    res.send({
      msg: req.t("ok.documentRemoved"),
      pendencias: await pendencias.pendenciasDe(app, req.params.personId),
    });
  });

  // Os BYTES. A pessoa está no caminho E no filtro: sem ela, um id adivinhado
  // leria o documento da ficha de outra pessoa.
  app.get("/people/:personId/documents/:id/arquivo", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (trainer === false) return;

    const pessoa = await pessoaDoProfissional(req, res, trainer, req.params.personId);
    if (pessoa === false) return;

    const doc = await app.api.personDocument.arquivoDe(req.params.personId, req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.documentNotFound") });

    const abre = app.api.personDocument.podeSairInline(doc.mime);
    const nome = String(doc.name || "documento").replace(/["\\]/g, "");

    res.setHeader("Content-Type", abre ? doc.mime : "application/octet-stream");
    // `nosniff` sempre: sem ele o navegador adivinha o tipo pelo conteúdo, e um
    // `.txt` com HTML dentro volta a ser página.
    res.setHeader("X-Content-Type-Options", "nosniff");
    // `no-store`: é documento pessoal de um aluno. Proxy compartilhado não pode
    // guardar isto e servir para outra pessoa.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `${abre ? "inline" : "attachment"}; filename="${nome}"`);

    res.send(doc.data?.buffer ? Buffer.from(doc.data.buffer) : doc.data);
  });

  // ── GERAR A FOLHA DE UM MODELO, PARA ESTA PESSOA ────────────────────────
  //
  // Pela MESMA fábrica da avaliação e do plano alimentar: ver, baixar em PDF e
  // mandar por e-mail saem de graça, com as mesmas travas.
  //
  // `:id` é a PESSOA, e o modelo vem na query — igual ao extrato financeiro,
  // onde o `:id` também é a pessoa e o recorte viaja em `?ids=`. Aqui não
  // existe "um documento" no banco: ele é o cruzamento de um modelo com alguém.
  registrarRotasDeDocumento(app, {
    base: "person-documents",
    prefixoDoArquivo: "documento",
    chaveDoAssunto: "email.document.subject",
    chaveDeOk: "ok.documentEmailed",
    acao: "email_document",

    montar: async function (req, res) {
      const trainer = await app.helpers.ReqProtected.can(req, res, "people.view");
      if (trainer === false) return null;

      const pessoa = await app.api.user.dataStudent(trainer._id, req.params.id);
      if (!pessoa) {
        res.status(404).send({ msg: req.t("errors.personNotFound") });
        return null;
      }

      const modelo = await app.api.documentTemplate.data(req.query.modelo);
      if (!modelo || modelo.tipo !== "html") {
        res.status(404).send({ msg: req.t("errors.templateNotFound") });
        return null;
      }

      const [fuso, casa] = await Promise.all([
        app.api.tenant.timezoneOfInstance(),
        app.api.tenant.dataOfInstance(),
      ]);

      // A logo da CASA quando ela tem uma; a nossa quando não. Ela depende do
      // tema, então só pode ser pedida depois de `casa`.
      const marca = await logoDaCasa(casa?.theme);

      return {
        trainer,
        pessoa,
        html: documentoModelo({ modelo, pessoa, casa, marca, lang: req.lang, fuso }),
        nome: modelo.name,
        data: new Date(),
      };
    },
  });
};
