// OS DEPARTAMENTOS — Financeiro, Vendas, Suporte.
//
// *"em administração crie 'departamentos'… vamos usar isso em breve no chat"*
// (02/10/2026).
//
// ── AS DUAS PERMISSÕES, E POR QUE SÃO DIFERENTES ───────────────────────
//
// ESCREVER é `users.manage`: criar departamento é decisão de instalação, da
// mesma família de Tipos de usuário e Grupos de permissão — que são os
// vizinhos dele na tela.
//
// LER é `people.view`, que é larga de propósito. Quem vai consumir isto é o
// CHAT, e quem atende chat não administra a conta. Com `users.view` na leitura,
// o atendente abriria a conversa sem saber a qual fila ela pertence.
module.exports = function (app) {
  // Os ids saem como TEXTO: um ObjectId cru vira `{}` quando o JSON é montado,
  // e a tela compararia o id da lista com o do seletor e nunca casaria.
  const paraTela = (d) => ({
    ...d,
    _id: String(d._id),
    membros: (d.membros || []).map(String),
  });

  app.get("/departments", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    // `ativos=1` é o que o chat vai pedir: um departamento desligado não some
    // do cadastro (as conversas antigas continuam apontando para ele), mas
    // para de ser oferecido.
    const lista = await app.api.departamento.list({ ativos: req.query.ativos === "1" });
    res.send({ rows: lista.map(paraTela) });
  });

  const recusa = (req, res, erro) => {
    const porErro = {
      sem_nome: ["departmentNoName", 400],
      em_uso: ["departmentTaken", 409],
      nao_encontrado: ["departmentNotFound", 404],
    };

    const [chave, status] = porErro[erro] || ["departmentNoName", 400];
    res.status(status).send({ msg: req.t("errors." + chave), code: erro });
  };

  app.post("/departments", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.departamento.insert(req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "create_department", {
      category: "configuration",
      local: { target_type: "departments", target_id: String(r.id) },
    });

    res.status(201).send(paraTela(await app.api.departamento.data(r.id)));
  });

  // `/ordem` ANTES de `/:id`: o Express casa na ordem de registro, e com `/:id`
  // em cima este pedido entraria na rota de UM departamento com `id = "ordem"`
  // — respondendo "não encontrado" e nunca salvando a ordem. Já me pegou nas
  // gavetas de campos; aqui já nasce certo.
  app.put("/departments/ordem", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.departamento.reordenar((req.body || {}).ids);
    if (!r.ok) return recusa(req, res, "sem_nome");

    const lista = await app.api.departamento.list();
    res.send({ rows: lista.map(paraTela) });
  });

  app.put("/departments/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.departamento.update(req.params.id, req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    res.send(paraTela(await app.api.departamento.data(req.params.id)));
  });

  app.delete("/departments/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const alvo = await app.api.departamento.data(req.params.id);
    if (!alvo) return recusa(req, res, "nao_encontrado");

    const ok = await app.api.departamento.remove(req.params.id);
    if (!ok) return recusa(req, res, "nao_encontrado");

    app.insertUserActionHistory(req, user, "delete_department", {
      category: "configuration",
      local: { target_type: "departments", target_id: String(req.params.id) },
      extra: { name: alvo.name, key: alvo.key },
    });

    res.send({ msg: req.t("ok.departmentRemoved") });
  });
};
