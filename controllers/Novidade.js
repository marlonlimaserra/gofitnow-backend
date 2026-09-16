const modulos = require("../lib/modulos.js");

// AS NOVIDADES E O BOTÃO QUE LIBERA O MÓDULO.
//
// *"sempre que eu lançar um módulo novo... eu colo o link da documentação e
// link do vídeo do YouTube explicando como vai funcionar, e aí na notícia vai
// ter um botão chamado liberar módulo, aí só habilita os menus."*
//
// A ordem inverteu, e é a inversão que é o recurso: antes o módulo aparecia no
// deploy e a explicação existia em algum lugar que ninguém abria. Agora a
// explicação chega primeiro e o menu vem depois, quando a pessoa quiser.
//
// ── POR QUE `roles.manage`, E NÃO `user.admin === true` ───────────────────
//
// "apenas para os admins ver" — e o jeito de dizer isso nesta casa é uma
// PERMISSÃO, nunca um interruptor de admin. O `ReqProtected` é explícito:
// "Authorization is by PERMISSION, never by 'is this an admin'", e a razão é
// que existe mais de um papel equivalente a admin numa conta que se organizou.
//
// `roles.manage` é a chave certa por ser exatamente o poder exercido: liberar um
// módulo muda o que a CONTA usa, que é a mesma natureza de mexer nos tipos de
// usuário. Quem cuida disso numa conta é quem também cuidaria daquilo — e a
// assistente que só atende não vê o aviso nem consegue apertar o botão.
module.exports = function (app) {
  // ── A LISTA ─────────────────────────────────────────────────────────────
  app.get("/me/novidades", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const [posts, liberados] = await Promise.all([
      app.api.novidade.publicadas(),
      app.api.modulo.liberados(),
    ]);

    // `null` (conta sem o documento semeado) conta como "tem tudo", igual ao
    // resto do sistema: ver o cabeçalho de `Modulo_model.liberados`. Tratá-lo
    // como lista vazia faria a tela oferecer "liberar" um módulo que a pessoa
    // está usando — e o clique não faria nada visível, porque já está aceso.
    const temTudo = liberados === null;
    const tem = new Set(temTudo ? modulos.CHAVES : liberados);

    const visto = user.preferences?.novidadesVistasEm
      ? new Date(user.preferences.novidadesVistasEm)
      : null;

    const rows = posts.map((p) => ({
      id: String(p._id),
      title: p.title,
      html: p.html || "",
      version: p.version || null,
      date: p.date,
      features: p.features || [],
      improvements: p.improvements || [],
      fixes: p.fixes || [],
      deprecated: p.deprecated || [],
      docUrl: p.docUrl || null,
      videoUrl: p.videoUrl || null,

      // ── O MÓDULO, e os três estados que a tela desenha ────────────────
      //
      // `null`          notícia sem módulo: só se lê.
      // `liberado`      já aceso nesta conta — o botão vira um selo.
      // `por liberar`   o botão aparece.
      //
      // Um `modulo` gravado que não existe mais no catálogo vira `null`: o
      // módulo foi aposentado, e um botão que liberasse uma chave morta
      // gravaria lixo no documento da conta.
      modulo: modulos.existe(p.modulo) ? String(p.modulo) : null,
      liberado: modulos.existe(p.modulo) ? tem.has(String(p.modulo)) : false,

      // Novo desde a última vez que esta pessoa abriu a tela. Sem marca
      // nenhuma, tudo é novo — é a primeira visita.
      novo: !visto || new Date(p.date) > visto,
    }));

    res.send({ rows, naoLidas: rows.filter((r) => r.novo).length });
  });

  // ── SÓ A CONTAGEM, para o pontinho do topo ──────────────────────────────
  //
  // Separada da lista de propósito, no mesmo desenho do selo da ajuda: este é o
  // pedido que TODA abertura do app faz, e ele não pode carregar vinte notícias
  // com corpo em HTML para desenhar um ponto de dois pixels.
  app.get("/me/novidades/nao-lidas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const quantas = await app.api.novidade.naoLidas(user.preferences?.novidadesVistasEm);
    res.send({ naoLidas: quantas });
  });

  // ── LIBERAR ─────────────────────────────────────────────────────────────
  //
  // A chave vem no CAMINHO e é conferida contra o catálogo antes de qualquer
  // gravação (`Modulo_model.liberar` recusa o que não existe). Sem isso, um
  // `POST /me/modulos/qualquer-coisa/liberar` encheria o documento da conta de
  // chaves inventadas que nada nunca leria — e que ninguém saberia de onde
  // vieram.
  app.post("/me/modulos/:chave/liberar", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    const r = await app.api.modulo.liberar(req.params.chave);
    if (!r.ok) {
      return res.status(404).send({ msg: req.t("errors.moduleNotFound"), code: r.erro });
    }

    // A lista devolvida é o que a barra lateral precisa para acender o menu
    // AGORA, sem recarregar a página. Sem ela a pessoa aperta "Liberar", vê a
    // confirmação, e o menu só aparece no próximo F5 — que é o momento em que
    // ela já desistiu e foi procurar onde ficou.
    res.send({ ok: true, liberados: r.lista, menusEscondidos: await app.api.modulo.menusEscondidos() });
  });

  // ── MARCAR COMO LIDAS ───────────────────────────────────────────────────
  //
  // Guardado nas PREFERÊNCIAS da pessoa, e não na conta: duas pessoas com
  // `roles.manage` na mesma conta leem em momentos diferentes, e a bolinha de
  // uma não pode apagar porque a outra leu.
  app.post("/me/novidades/vistas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "roles.manage");
    if (user === false) return;

    await app.api.user.savePreferences(String(user._id), {
      novidadesVistasEm: new Date().toISOString(),
    });

    res.send({ ok: true });
  });
};
