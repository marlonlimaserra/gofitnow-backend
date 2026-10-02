const tipos = require("../lib/tiposDeCampo.js");

// OS CAMPOS CUSTOMIZADOS — as perguntas que a casa inventa.
//
// *"na parte de configuração do sistema, crie 'Campos customizados'"*
// (01/10/2026).
//
// ── A PERMISSÃO É `users.manage`, E NÃO UMA NOVA ───────────────────────
//
// Pensei em criar `customFields.manage` e desisti: a pergunta que ela
// responderia já tem dono. Quem mexe aqui está mudando a FICHA DE TODO MUNDO —
// é da mesma família de Vocabulário, Aparência e Tipos de usuário, que são as
// decisões de instalação. Uma chave a mais em Tipos de usuário para separar
// "pode inventar campo" de "pode mudar o vocabulário" seria uma linha que
// ninguém configura diferente.
//
// LER é outra história: a ficha de pessoa precisa saber quais campos existem, e
// quem abre ficha não administra a conta. Por isso a leitura pede `people.view`.
module.exports = function (app) {
  // O NOME de um nativo sai da tradução até alguém renomear — gravar
  // "Objetivo" em português numa conta em inglês seria errar o idioma de quem
  // nunca pediu nada. No instante em que a casa renomeia, `name` existe e vence.
  const paraTela = (req) => (c) => ({
    ...c,
    _id: String(c._id),
    name: c.name || (c.rotuloPadrao ? req.t(c.rotuloPadrao) : ""),
    nativo: Boolean(c.nativo),
  });

  app.get("/custom-fields", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    // `ativos=1` é o que a FICHA pede: um campo desativado não some do catálogo
    // (as respostas continuam lá), mas para de ser perguntado.
    const lista = await app.api.customField.list({ ativos: req.query.ativos === "1" });

    res.send({
      rows: lista.map(paraTela(req)),
      // O catálogo de tipos viaja junto, como as categorias viajam com as
      // contas: um tipo novo entra no ar sem tocar no frontend.
      tipos: tipos.paraTela(req.t),
      resumo: await app.api.customField.resumo(),
    });
  });

  // As mensagens de recusa, em um lugar só: as três rotas de escrita falham
  // pelos mesmos motivos, e repetir o `switch` garantiria que uma delas
  // respondesse diferente das outras um dia.
  const recusa = (req, res, erro) => {
    // As chaves levam o prefixo `customField` porque o dicionário do servidor é
    // ACHATADO num mapa só: um `errors.notFound` solto colidiria com o de outra
    // área, e o carregador recusa chave repetida em dois arquivos — de
    // propósito, para não existirem duas verdades sobre a mesma frase.
    const porErro = {
      sem_nome: ["customFieldNoName", 400],
      sem_alias: ["customFieldBadAlias", 400],
      alias_reservado: ["customFieldAliasReserved", 400],
      alias_em_uso: ["customFieldAliasTaken", 409],
      sem_opcoes: ["customFieldNeedsOptions", 400],
      nao_encontrado: ["customFieldNotFound", 404],
      nativo: ["customFieldIsNative", 400],
    };

    const [chave, status] = porErro[erro] || ["customFieldSaveFailed", 400];
    res.status(status).send({ msg: req.t("errors." + chave), code: erro });
  };

  app.post("/custom-fields", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.customField.insert(req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "create_custom_field", {
      category: "configuration",
      local: { target_type: "custom_fields", target_id: String(r.id) },
    });

    res.status(201).send(paraTela(req)(await app.api.customField.data(r.id)));
  });

  app.put("/custom-fields/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.customField.update(req.params.id, req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "update_custom_field", {
      category: "configuration",
      local: { target_type: "custom_fields", target_id: String(req.params.id) },
    });

    res.send(paraTela(req)(await app.api.customField.data(req.params.id)));
  });

  app.delete("/custom-fields/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const campo = await app.api.customField.data(req.params.id);
    if (!campo) return recusa(req, res, "nao_encontrado");

    const ok = await app.api.customField.remove(req.params.id);
    // Nativo não se apaga: a linha sumiria daqui e o campo continuaria na
    // ficha, sem lugar nenhum para configurá-lo. Quem não o quer, desliga.
    if (ok === "nativo") return recusa(req, res, "nativo");
    if (!ok) return recusa(req, res, "nao_encontrado");

    app.insertUserActionHistory(req, user, "delete_custom_field", {
      category: "configuration",
      local: { target_type: "custom_fields", target_id: String(req.params.id) },
      extra: { name: campo.name, alias: campo.alias },
    });

    // ── APAGAR O CAMPO NÃO APAGA AS RESPOSTAS ───────────────────────────
    //
    // Elas ficam na ficha de cada pessoa, sob o alias. É de propósito: quem
    // apagou por engano recria o campo com o mesmo alias e os dados voltam a
    // aparecer. Varrer duzentas fichas para limpar seria irreversível — e a
    // reclamação que viria depois ("sumiu o convênio de todo mundo") não teria
    // conserto.
    res.send({ msg: req.t("ok.customFieldRemoved") });
  });
};
