const limiteDoPlano = require("../lib/limiteDoPlano.js");
const arquivos = require("../lib/arquivos.js");
const vinculos = require("../lib/vinculosDeTrabalho.js");
const tiposDeOcorrencia = require("../lib/tiposDeOcorrencia.js");

// FUNCIONÁRIOS — a equipe da casa.
//
// *"crie mais um item no menu, chamado funcionários, para a gente cadastrar o
// funcionário, ver folha de ponto, salário, advertências, anotações e outras
// coisas que funcionário pode ter que eu não sei"*.
//
// ── TRÊS PERMISSÕES, E A TERCEIRA É O MOTIVO DESTE MÓDULO EXISTIR ───────
//
// `employees.view` abre a lista e a ficha. `employees.manage` cadastra, edita,
// lança ocorrência e preenche o ponto.
//
// `employees.payroll` é o SALÁRIO — e é uma chave à parte porque salário é o
// dado mais sensível que uma academia guarda dos próprios funcionários. A
// recepcionista que preenche o ponto de todo mundo não pode ver quanto o
// gerente ganha, e o gerente não pode ver o que o sócio retira.
//
// Este argumento já estava escrito em `controllers/Payable.js`, quando as
// contas a pagar nasceram com a permissão do financeiro: *"o argumento a favor
// de separar é real e tem nome: FOLHA"*. Era este módulo.
//
// Sem a chave, o servidor NÃO MANDA o número — ele não some só na tela. Esconder
// no frontend seria deixá-lo viajar no JSON, a um F12 de distância.
//
// ── A QUARTA CHAVE, que não entrou ──────────────────────────────────────
//
// `employees.time`, só para preencher o ponto sem poder demitir ninguém. Faz
// sentido e não entrou porque quatro chaves num módulo novo é mais configuração
// do que uma casa de dez pessoas quer. No dia em que a recepção preencher o
// ponto, a conversa começa neste comentário.
module.exports = function (app) {
  const contarFuncionarios = () => app.api.employee.contagem();

  // O SALÁRIO SAI DA RESPOSTA para quem não tem a chave da folha.
  //
  // Uma função e não um `if` espalhado: são quatro rotas que devolvem ficha, e
  // a que esquecesse do `delete` vazaria tudo.
  const CAMPOS_DE_FOLHA = [
    "salary",
    "salaryKind",
    "benefits",
    "commission",
    "pix",
    "bank",
    "bankAgency",
    "bankAccount",
  ];

  const podeVerFolha = (user) =>
    Array.isArray(user?.permissions) && user.permissions.includes("employees.payroll");

  function semFolha(doc) {
    if (!doc) return doc;
    const copia = { ...doc };
    for (const campo of CAMPOS_DE_FOLHA) delete copia[campo];
    return copia;
  }

  app.get("/employees", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.view");
    if (user === false) return;

    const lista = await app.api.employee.listar({
      busca: req.query.q,
      situacao: req.query.situacao,
      bond: req.query.bond,
      unit: req.query.unit,
      semUnidade: req.query.semUnidade === "1",
      ordem: req.query.sort,
      direcao: req.query.dir,
      pagina: req.query.page,
      limite: req.query.limit,
    });

    const folha = podeVerFolha(user);

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows: folha ? lista.rows : lista.rows.map(semFolha),
      total: lista.total,
      pagina: lista.pagina,
      porPagina: lista.porPagina,
      paginas: lista.paginas,
      // O resumo perde a FOLHA junto: a soma dos salários é o dado que a chave
      // protege, e um total sem as partes ainda é o total.
      resumo: folha ? lista.resumo : { ...lista.resumo, folha: undefined },
      podeVerFolha: folha,
      currency: moedas.currency,
      // Os catálogos, já traduzidos — o mesmo caminho do financeiro: um vínculo
      // novo aparece na tela sem ninguém mexer no frontend.
      vinculos: vinculos.paraTela(req.t),
      tipos: tiposDeOcorrencia.paraTela(req.t),
      gravidades: tiposDeOcorrencia.gravidadesParaTela(req.t),
    });
  });

  app.get("/employees/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.view");
    if (user === false) return;

    const ficha = await app.api.employee.data(req.params.id);
    if (!ficha) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    res.send(podeVerFolha(user) ? ficha : semFolha(ficha));
  });

  app.post("/employees", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    if (await limiteDoPlano.barrou(app, req, res, "employees", contarFuncionarios)) return;

    // Sem a chave da folha, os campos de dinheiro do corpo são IGNORADOS, e não
    // recusados: quem cadastra sem poder ver salário cadastra a pessoa, e quem
    // tem a chave preenche o valor depois. Recusar obrigaria as duas coisas a
    // acontecerem na mesma mão.
    const corpo = podeVerFolha(user) ? req.body || {} : semFolha(req.body || {});

    const id = await app.api.employee.insert(corpo);
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    app.insertUserActionHistory(req, user, "create_employee", {
      category: "employees",
      local: { target_type: "employees", target_id: String(id) },
    });

    const ficha = await app.api.employee.data(id);
    res.status(201).send(podeVerFolha(user) ? ficha : semFolha(ficha));
  });

  app.put("/employees/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const existe = await app.api.employee.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    const corpo = podeVerFolha(user) ? req.body || {} : semFolha(req.body || {});

    const ok = await app.api.employee.update(req.params.id, corpo);
    if (!ok) return res.status(400).send({ msg: req.t("errors.requireName") });

    app.insertUserActionHistory(req, user, "update_employee", {
      category: "employees",
      local: { target_type: "employees", target_id: String(req.params.id) },
    });

    const ficha = await app.api.employee.data(req.params.id);
    res.send(podeVerFolha(user) ? ficha : semFolha(ficha));
  });

  // ── APAGAR AVISA O QUE VAI JUNTO ────────────────────────────────────────
  //
  // O caminho normal é DESLIGAR — a pessoa sai da lista e a história dela
  // continua existindo, que é o que se pede num processo trabalhista.
  //
  // Apagar existe para o cadastro feito errado, e por isso ele diz, antes,
  // quantas ocorrências e quantos dias de ponto somem junto.
  app.delete("/employees/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const alvo = await app.api.employee.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    const junto = await app.api.employee.quantoTemJunto(req.params.id);

    // `?confirmado=1` é a segunda volta. Sem ela, quem tem história responde
    // 409 com os números — a tela pergunta, e só então apaga.
    const temHistoria = junto.ocorrencias > 0 || junto.pontos > 0;
    if (temHistoria && req.query.confirmado !== "1") {
      return res.status(409).send({
        msg: req.t("errors.employeeHasHistory", junto),
        ...junto,
        precisaConfirmar: true,
      });
    }

    await app.api.employee.remove(req.params.id);

    app.insertUserActionHistory(req, user, "delete_employee", {
      category: "employees",
      local: { target_type: "employees", target_id: String(req.params.id) },
      extra: junto,
    });

    res.send({ msg: req.t("ok.employeeRemoved") });
  });

  // ── A FOTO ──────────────────────────────────────────────────────────────
  //
  // A leitura EXIGE SESSÃO, e é a diferença desta rota para a do fornecedor.
  //
  // A foto de um fornecedor é a logo da Enel — a mesma que está no site dela.
  // Esta é o ROSTO de uma pessoa empregada, e rosto de gente é dado pessoal:
  // uma URL aberta, mesmo com id opaco, é uma URL que vaza num print, num
  // histórico de navegador ou num log de proxy.
  //
  // É o mesmo caminho do avatar (`/avatars/:id`), e a tela carrega a imagem por
  // fetch com a sessão, virando objectURL — ver `components/Avatar.jsx`.
  app.get("/employee-photo/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.view");
    if (user === false) return;

    const img = await app.api.employeeImage.data(req.params.id);
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';

    res.setHeader("Content-Type", img.mime);
    // `private` porque é conteúdo de uma sessão: um proxy compartilhado não
    // pode guardar isto e servir para outra pessoa.
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.send(bytes);
  });

  app.post("/employees/:id/photo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const alvo = await app.api.employee.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    const parsed = app.api.employeeImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.employeeImage.save(req.params.id, parsed.mime, parsed.buffer);
    await app.api.employee.update(req.params.id, { photo: salva.id });

    res.status(201).send({ id: salva.id, updatedAt: salva.updatedAt });
  });

  // ── A LINHA DO TEMPO ────────────────────────────────────────────────────

  app.get("/employees/:id/records", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.view");
    if (user === false) return;

    const lista = await app.api.employeeRecord.listar({
      employee: req.params.id,
      tipo: req.query.tipo,
      de: req.query.de,
      ate: req.query.ate,
      limite: req.query.limit,
    });

    // O REAJUSTE carrega dinheiro. Sem a chave da folha ele continua aparecendo
    // na história — "houve um aumento em março" não é segredo —, mas sem o
    // valor. Esconder a linha inteira faria a história mentir por omissão.
    const folha = podeVerFolha(user);

    res.send({
      rows: folha ? lista.rows : lista.rows.map((r) => ({ ...r, amount: undefined })),
      porTipo: lista.porTipo,
      tipos: tiposDeOcorrencia.paraTela(req.t),
      gravidades: tiposDeOcorrencia.gravidadesParaTela(req.t),
    });
  });

  app.post("/employees/:id/records", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const alvo = await app.api.employee.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    const corpo = req.body || {};
    if (corpo.tipo === "reajuste" && !podeVerFolha(user)) {
      return res.status(403).send({ msg: req.t("errors.payrollOnly") });
    }

    const id = await app.api.employeeRecord.insert(req.params.id, corpo, user);
    if (!id) return res.status(400).send({ msg: req.t("errors.employeeNotFound") });

    // ── O REAJUSTE MOVE O SALÁRIO DA FICHA ────────────────────────────────
    //
    // Lançar "reajuste para R$ 2.800" e a ficha continuar dizendo R$ 2.500
    // seria pedir para alguém digitar a mesma coisa duas vezes — e a segunda é
    // a que se esquece. O valor atual é o último reajuste, por construção.
    if (corpo.tipo === "reajuste" && Number(corpo.amount) > 0) {
      await app.api.employee.update(req.params.id, { salary: corpo.amount });
    }

    // A PROMOÇÃO move o cargo, pela mesma razão.
    if (corpo.tipo === "promocao" && String(corpo.cargo || "").trim()) {
      await app.api.employee.update(req.params.id, { role: corpo.cargo });
    }

    app.insertUserActionHistory(req, user, "create_employee_record", {
      category: "employees",
      local: { target_type: "employee_records", target_id: String(id) },
      extra: { tipo: corpo.tipo },
    });

    res.status(201).send(await app.api.employeeRecord.data(id));
  });

  app.put("/employee-records/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const existe = await app.api.employeeRecord.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.recordNotFound") });

    if ((existe.tipo === "reajuste" || req.body?.tipo === "reajuste") && !podeVerFolha(user)) {
      return res.status(403).send({ msg: req.t("errors.payrollOnly") });
    }

    const ok = await app.api.employeeRecord.update(req.params.id, req.body || {});
    if (!ok) return res.status(404).send({ msg: req.t("errors.recordNotFound") });

    res.send(await app.api.employeeRecord.data(req.params.id));
  });

  app.delete("/employee-records/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const ok = await app.api.employeeRecord.remove(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.recordNotFound") });

    res.send({ msg: req.t("ok.recordRemoved") });
  });

  // ── OS ANEXOS SÃO VÁRIOS ────────────────────────────────────────────────
  //
  // *"deixe colocar vários, no máximo 10"*. O id do ARQUIVO está no caminho, ao
  // lado do id da ocorrência — e os dois entram no filtro: sem o da ocorrência,
  // um id de arquivo adivinhado leria o anexo de outra ficha.
  app.get("/employee-records/:id/anexos/:anexoId", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.view");
    if (user === false) return;

    const anexo = await app.api.employeeRecord.anexoDe(req.params.id, req.params.anexoId);
    if (!anexo) return res.status(404).send({ msg: req.t("errors.noAttachment") });

    // ── O QUE SAI INLINE, E O QUE VIRA DOWNLOAD ──────────────────────────
    //
    // Desde que QUALQUER tipo pode ser anexado, esta é a linha que separa um
    // anexo de um XSS: um `.html` — ou um `.svg`, que é documento executável
    // com cara de imagem — servido `inline` da nossa origem roda script na
    // nossa origem, com a sessão de quem abriu.
    //
    // Então só imagem e PDF saem `inline`. O resto vai como
    // `application/octet-stream` e `attachment`: o navegador baixa e não
    // interpreta, que é exatamente o que se quer de um `.mp3`, um `.docx` ou um
    // arquivo que ninguém sabe o que é.
    const abre = app.api.employeeRecord.podeSairInline(anexo.mime);
    const nome = String(anexo.name || "anexo").replace(/["\\]/g, "");

    res.setHeader("Content-Type", abre ? anexo.mime : "application/octet-stream");
    // `nosniff` em TODOS: sem ele o navegador adivinha o tipo pelo conteúdo, e
    // um `.txt` com HTML dentro volta a ser página.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader(
      "Content-Disposition",
      `${abre ? "inline" : "attachment"}; filename="${nome}"`
    );

    res.send(anexo.data?.buffer ? Buffer.from(anexo.data.buffer) : anexo.data);
  });

  // ── UM ARQUIVO POR REQUISIÇÃO ───────────────────────────────────────────
  //
  // Eles vinham todos dentro do corpo do lançamento, e isso não cabia: o
  // `bodyParser` corta em 10 MB, o base64 infla ~33%, e dois anexos de 6 MB
  // derrubariam o pedido inteiro — levando junto o texto da advertência.
  //
  // Um por vez também dá o que faltava na tela: saber qual arquivo falhou.
  app.post("/employee-records/:id/anexos", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const existe = await app.api.employeeRecord.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.recordNotFound") });

    const anexo = app.api.employeeRecord.parseAnexo(req.body || {});
    if (!anexo) return res.status(400).send({ msg: req.t("errors.attachmentTooBig") });

    const fichas = await app.api.employeeRecord.saveAnexos(req.params.id, [anexo]);
    res.status(201).send({ anexos: fichas });
  });

  app.delete("/employee-records/:id/anexos/:anexoId", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const ok = await app.api.employeeRecord.removeAnexo(req.params.id, req.params.anexoId);
    if (!ok) return res.status(404).send({ msg: req.t("errors.noAttachment") });

    res.send(await app.api.employeeRecord.data(req.params.id));
  });

  // ── A FOLHA DE PONTO ────────────────────────────────────────────────────

  app.get("/employees/:id/time", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.view");
    if (user === false) return;

    const ficha = await app.api.employee.data(req.params.id);
    if (!ficha) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    const espelho = await app.api.employeeTime.espelho({
      employee: req.params.id,
      de: req.query.de,
      ate: req.query.ate,
      // A jornada vem da FICHA, e não da URL: o previsto do período é dela, e
      // deixar a tela mandar o número faria dois lugares decidirem a mesma coisa.
      jornadaSemanal: ficha.weeklyHours,
    });

    res.send({
      ...espelho,
      funcionario: { id: String(ficha._id), name: ficha.name, role: ficha.role, weeklyHours: ficha.weeklyHours },
    });
  });

  app.put("/employees/:id/time/:dia", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "employees.manage");
    if (user === false) return;

    const ficha = await app.api.employee.data(req.params.id);
    if (!ficha) return res.status(404).send({ msg: req.t("errors.employeeNotFound") });

    const gravado = await app.api.employeeTime.gravar(
      req.params.id,
      { ...(req.body || {}), dia: req.params.dia },
      user
    );
    if (!gravado) return res.status(400).send({ msg: req.t("errors.invalidDay") });

    res.send(gravado);
  });
};
