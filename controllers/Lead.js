const lenteDeUnidade = require("../lib/lenteDeUnidade.js");
const limiteDoPlano = require("../lib/limiteDoPlano.js");
const funil = require("../lib/funilDeLeads.js");

// OS LEADS — quem procurou e ainda não é ninguém no sistema.
//
// *"crie uma nova rota chamada 'lead'. Esses leads vão ser os dados de pessoas
// que não pagam nada e nem são alunos"* (01/10/2026).
//
// ── POR QUE CHAVE PRÓPRIA, e não `people.view` ──────────────────────────
//
// Pareceu natural pendurar nas pessoas: é gente, tem nome e telefone. Mas as
// duas respondem a perguntas diferentes e são tocadas por mãos diferentes.
//
// Quem trabalha o funil é a RECEPÇÃO e quem vende — e dar `people.view` a essa
// pessoa é abrir a ficha de todo aluno da casa: treino, anamnese, exame,
// medida. O contrário também vale: o professor que precisa ver a ficha dos
// alunos dele não tem por que mexer na lista de quem ainda não é.
//
// `leads.view` abre e trabalha a fila; `leads.manage` cadastra, edita e apaga.
module.exports = function (app) {
  // Quem traduz o documento do banco para a tela é o MODELO (`paraTela`): os
  // campos do funil moram aninhados em `lead`, e a tela não precisa saber
  // disso. Ver `model/Lead_model.js`.
  const paraTela = (l) => app.api.lead.paraTela(l);

  app.get("/leads", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.view");
    if (user === false) return;

    const r = await app.api.lead.pagina({
      busca: req.query.q,
      // SEM FILTRO PEDIDO, só as etapas ABERTAS. A lista é uma fila de
      // trabalho: abrir com os perdidos de três meses atrás misturados faria a
      // primeira página não responder "o que eu faço hoje".
      //
      // `etapas=todas` é a porta para ver o resto — e ela precisa existir,
      // senão um lead marcado como perdido por engano fica inalcançável.
      // `todas` manda a lista INTEIRA, e não vazio. Parece o mesmo e não é:
      // pedir "convertido" é o que faz o modelo alcançar quem já virou aluno
      // (o tipo mudou, ver `recorteDaLista`). Com vazio, "todas as etapas"
      // esconderia justamente o que o funil produziu.
      etapas:
        req.query.etapas === "todas"
          ? funil.IDS_DE_ETAPA.join(",")
          : req.query.etapas || funil.ETAPAS_ABERTAS.join(","),
      origens: req.query.origens,
      ordem: req.query.sort,
      direcao: req.query.dir,
      pagina: req.query.page,
      limite: req.query.limit,
      semUnidade: req.query.unit === "nenhuma",
      ...lenteDeUnidade.recorte(user, req.query.unit === "nenhuma" ? "" : req.query.unit),
    });

    res.send({
      // ── SEM `paraTela` AQUI, E É DE PROPÓSITO ─────────────────────────
      //
      // `pagina()` já devolve a linha no formato da tela. Transformar de novo
      // parece inofensivo e não é: `paraTela` lê os campos do funil de dentro
      // de `lead`, e na segunda passada esse objeto já não existe — origem e
      // observação voltavam para o padrão, caladas.
      //
      // Custou um teste contra produção para aparecer, porque o POST e o GET de
      // um lead só (que transformam UMA vez) estavam certos o tempo todo.
      rows: r.rows,
      total: r.total,
      porEtapa: r.porEtapa,
      pagina: r.pagina,
      porPagina: r.porPagina,
      // O catálogo viaja junto com a lista, como as categorias viajam com as
      // contas: uma etapa nova entra no ar sem tocar no frontend.
      ...funil.paraTela(req.t),
    });
  });

  app.get("/leads/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.view");
    if (user === false) return;

    const lead = await app.api.lead.data(req.params.id);
    if (!lead) return res.status(404).send({ msg: req.t("errors.leadNotFound") });

    res.send(paraTela(lead));
  });

  app.post("/leads", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.manage");
    if (user === false) return;

    const id = await app.api.lead.insert(req.body || {});
    // Sem nome não há lead: a lista mostraria uma linha em branco.
    if (!id) return res.status(400).send({ msg: req.t("errors.leadNoName") });

    app.insertUserActionHistory(req, user, "create_lead", {
      category: "leads",
      local: { target_type: "leads", target_id: String(id) },
    });

    res.status(201).send(paraTela(await app.api.lead.data(id)));
  });

  app.put("/leads/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.manage");
    if (user === false) return;

    const ok = await app.api.lead.update(req.params.id, req.body || {});
    if (!ok) return res.status(404).send({ msg: req.t("errors.leadNotFound") });

    app.insertUserActionHistory(req, user, "update_lead", {
      category: "leads",
      local: { target_type: "leads", target_id: String(req.params.id) },
    });

    res.send(paraTela(await app.api.lead.data(req.params.id)));
  });

  // ── CONVERTER: O LEAD VIRA ALUNO SEM SAIR DO LUGAR ──────────────────────
  //
  // *"a ideia é converter o lead para aluno... agente só muda uma chave false
  // ou true, e pronto, todos os dados já aparecem em aluno sem ter que copiar
  // nada de um lugar para o outro"* (01/10/2026).
  //
  // É literalmente isso: `type: "lead" → "student"` mais o vínculo. O `_id` não
  // muda, então o que já apontava para o lead continua apontando para a pessoa.
  //
  // ── DUAS CHAVES, E AS DUAS SÃO NECESSÁRIAS ────────────────────────────
  //
  // `leads.manage` porque mexe no funil, e `people.create` porque o resultado é
  // uma ficha nova na casa. Exigir só a primeira deixaria quem não pode
  // cadastrar ninguém cadastrar por este caminho.
  app.post("/leads/:id/converter", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.manage");
    if (user === false) return;

    const podeCriar = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (podeCriar === false) return;

    const lead = await app.api.lead.data(req.params.id);
    if (!lead) return res.status(404).send({ msg: req.t("errors.leadNotFound") });

    // O TETO DO PLANO, o mesmo de `POST /people`: converter cria um aluno para
    // efeito de cobrança, e deixar passar por aqui seria a porta dos fundos do
    // limite que a outra rota cobra na porta da frente.
    // Numa linha só porque o conferidor de `test/lib/limitesLigados.test.js`
    // cobra o `return` colado na chamada — e ele existe porque um `barrou()`
    // sem `return` deixa o código seguir criando depois de já ter respondido.
    if (await limiteDoPlano.barrou(app, req, res, "people", limiteDoPlano.contarNa(app, "users", { type: "student" }))) return;

    const id = await app.api.lead.converter(req.params.id, user._id);
    // `null` depois de o lead existir é corrida: dois cliques no mesmo botão, e
    // o segundo já não acha um lead. A resposta é 409 e não 500 — não houve
    // erro, houve atraso.
    if (!id) return res.status(409).send({ msg: req.t("errors.leadAlreadyConverted") });

    app.insertUserActionHistory(req, user, "convert_lead", {
      category: "leads",
      local: { target_type: "people", target_id: String(id), person: String(id) },
      extra: { name: lead.name, origem: lead.lead?.origem },
    });

    // O id da PESSOA volta para a tela poder abrir a ficha dela na hora — que é
    // o que alguém quer fazer no segundo seguinte a converter.
    res.send({ personId: String(id), msg: req.t("ok.leadConverted") });
  });

  // ── A FOTO DO LEAD ──────────────────────────────────────────────────────
  //
  // *"todos os campos que já tem em alunos"* — e a foto é um deles.
  //
  // Rota PRÓPRIA, e não a de pessoa: `POST /people/:id/avatar` resolve o alvo
  // por `dataStudent`, que passa pelo VÍNCULO. Lead não tem vínculo, então
  // aquela rota devolveria 404 — e a autorização dela, `people.edit`, é a chave
  // errada para quem só trabalha o funil.
  //
  // ── A FOTO SOBREVIVE À CONVERSÃO DE GRAÇA ─────────────────────────────
  //
  // O avatar é guardado pelo `_id` do usuário, e converter não troca o `_id`.
  // A foto tirada no balcão, no dia em que a pessoa apareceu, é a mesma que
  // aparece na ficha dela um mês depois. Nada é copiado.
  app.post("/leads/:id/foto", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.manage");
    if (user === false) return;

    const lead = await app.api.lead.data(req.params.id);
    if (!lead) return res.status(404).send({ msg: req.t("errors.leadNotFound") });

    const parsed = app.api.avatar.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const at = await app.api.avatar.save(lead._id, parsed.mime, parsed.buffer);

    app.insertUserActionHistory(req, user, "update_lead_avatar", {
      category: "leads",
      local: { target_type: "leads", target_id: String(lead._id) },
      extra: { name: lead.name, size: parsed.buffer.length, mime: parsed.mime },
    });

    res.send({ msg: req.t("ok.photoUpdated"), avatarAt: at });
  });

  app.delete("/leads/:id/foto", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.manage");
    if (user === false) return;

    const lead = await app.api.lead.data(req.params.id);
    if (!lead) return res.status(404).send({ msg: req.t("errors.leadNotFound") });

    const ok = await app.api.avatar.delete(lead._id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.noPhoto") });

    app.insertUserActionHistory(req, user, "delete_lead_avatar", {
      category: "leads",
      local: { target_type: "leads", target_id: String(lead._id) },
      extra: { name: lead.name },
    });

    res.send({ msg: req.t("ok.photoRemoved") });
  });

  app.delete("/leads/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "leads.manage");
    if (user === false) return;

    const lead = await app.api.lead.data(req.params.id);
    const ok = await app.api.lead.remove(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.leadNotFound") });

    app.insertUserActionHistory(req, user, "delete_lead", {
      category: "leads",
      local: { target_type: "leads", target_id: String(req.params.id) },
      extra: { name: lead?.name },
    });

    res.send({ msg: req.t("ok.leadRemoved") });
  });
};
