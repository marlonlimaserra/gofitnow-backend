const limiteDoPlano = require("../lib/limiteDoPlano.js");
const { documentoDieta } = require("../lib/documentoDieta.js");
const { registrarRotasDeDocumento } = require("../lib/rotasDeDocumento.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");
const { avisarSemEsperar } = require("../lib/avisar.js");
const arquivos = require("../lib/arquivos.js");

module.exports = function (app) {
  // Os planos alimentares de uma pessoa.
  //
  // Espelham as rotas de treino de propósito: mesma forma de URL, mesmo formato
  // de resposta, mesmo lugar para o escopo. Quem integrou uma integra a outra
  // sem reler nada.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  // ── A TELA "DIETAS": OS ÚLTIMOS PLANOS, DE TODAS AS PESSOAS ─────────────
  //
  // Irmã de `/workouts` e de `/assessments`, com a mesma forma de resposta. Ela
  // responde a pergunta que a ficha não responde: "o que eu montei ultimamente,
  // e o que ainda está valendo".
  //
  // As contagens por situação vão junto porque os botões do filtro mostram o
  // número, e elas usam os MESMOS filtros da lista menos o status — senão o
  // número diria uma coisa e a lista logo abaixo mostraria outra.
  app.get("/diets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
    if (trainer === false) return;

    const filtros = {
      search: req.query.search,
      status: req.query.status,
      studentId: req.query.personId,
      sort: req.query.sort,
      dir: req.query.dir,
      page: req.query.page,
      limit: req.query.limit,
    };

    const [{ rows, total }, counts] = await Promise.all([
      app.api.diet.pageAll(trainer._id, filtros),
      app.api.diet.contarPorStatus(trainer._id, filtros),
    ]);

    res.send({ rows, total, counts });
  });

  app.get("/people/:personId/diets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const rows = await app.api.diet.list(trainer._id, student._id);

    res.send({
      rows,
      counts: {
        current: rows.filter((d) => d.status === "current").length,
        past: rows.filter((d) => d.status === "past").length,
        future: rows.filter((d) => d.status === "future").length,
        all: rows.length,
      },
    });
  });

  app.post("/people/:personId/diets", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    // O teto do plano — ver lib/limiteDoPlano.js.
    if (await limiteDoPlano.barrou(app, req, res, "diets", limiteDoPlano.contarNa(app, "diets"))) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    if (!body.name || String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireDietName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const id = await app.api.diet.insert(trainer._id, student._id, body);
    const criada = await app.api.diet.data(trainer._id, id);

    app.insertUserActionHistory(req, trainer, "create_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: id + "" },
      extra: { name: criada.name, person: student.name, personId: student._id + "" },
    });

    // ── O AVISO, sem esperar ────────────────────────────────────────────
    //
    // A pessoa fechou o app; sem push ela descobre a dieta na próxima vez que
    // abrir, que pode ser semana que vem.
    //
    // Não seguramos a resposta: o profissional não deve pagar, no tempo dele, a
    // ida ao OneSignal. E falha aqui não desfaz a dieta — ver `lib/avisar.js`.
    avisarSemEsperar(app, "diet", {
      para: student._id,
      de: trainer._id,
      lang: student.lang,
      vars: { profissional: trainer.name },
    });

    res.status(201).send(criada);
  });

  app.get("/diets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
    if (trainer === false) return;

    const diet = await app.api.diet.data(trainer._id, req.params.id);
    if (!diet) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    // O nome da pessoa vem junto: fora da ficha dela, "Plano de agosto" não
    // identifica de quem é.
    const student = await app.api.user.data(diet.student);
    res.send({ ...diet, student: student ? { _id: student._id, name: student.name } : null });
  });

  app.put("/diets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const body = req.body || {};

    if (body.name !== undefined && String(body.name).trim().length < 2) {
      res.status(400).send({ msg: req.t("errors.requireDietName") });
      return;
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      res.status(400).send({ msg: req.t("errors.endBeforeStart") });
      return;
    }

    const antes = await app.api.diet.data(trainer._id, req.params.id);

    const ok = await app.api.diet.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    const depois = await app.api.diet.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: req.params.id + "" },
      extra: { name: depois.name },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/diets/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const alvo = await app.api.diet.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    await app.api.diet.delete(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_diet", {
      category: "diets",
      local: { target_type: "diets", target_id: req.params.id + "" },
      extra: { name: alvo.name },
    });

    res.send({ msg: req.t("ok.dietRemoved") });
  });

  // As refeições, salvas TODAS de uma vez.
  //
  // Mesma escolha da rota de exercícios do treino: a tela edita o dia inteiro e
  // salva uma vez. Uma rota por refeição multiplicaria o número de chamadas sem
  // dar nada em troca — e deixaria o plano num estado meio salvo se uma delas
  // falhasse no meio.
  app.put("/diets/:id/meals", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "diets.manage");
    if (trainer === false) return;

    const { meals } = req.body || {};
    if (!Array.isArray(meals)) {
      res.status(400).send({ msg: req.t("errors.requireMeals") });
      return;
    }

    // ── O TETO DE ALIMENTOS POR REFEIÇÃO ──────────────────────────────────
    //
    // Recusa a MAIOR refeição do pedido, e não a soma: o limite é por refeição,
    // e somar diria "seu plano permite 30" a quem mandou seis refeições de dez.
    //
    // A recusa é do pedido INTEIRO, sem gravar as refeições que caberiam. Meia
    // dieta salva é pior que nenhuma — a tela edita o dia todo de uma vez e
    // salvaria por cima na próxima, com o que ficou de fora sumido.
    const maiorRefeicao = meals.reduce(
      (n, r) => Math.max(n, Array.isArray(r?.foods) ? r.foods.length : 0),
      0
    );
    if (await limiteDoPlano.barrouQuantidade(app, req, res, "foodsPerMeal", maiorRefeicao)) return;

    const ok = await app.api.diet.saveMeals(trainer._id, req.params.id, meals);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.dietNotFound") });
      return;
    }

    const atualizada = await app.api.diet.data(trainer._id, req.params.id);

    app.insertUserActionHistory(req, trainer, "update_diet_meals", {
      category: "diets",
      local: { target_type: "diets", target_id: req.params.id + "" },
      extra: { name: atualizada.name, meals: atualizada.mealCount },
    });

    res.send(atualizada);
  });

  // ── O DOCUMENTO DO PLANO ALIMENTAR ────────────────────────────────────
  //
  // As mesmas três rotas da avaliação física, pela mesma fábrica. Pedido do
  // Marlon: *"faça o mesmo para o plano alimentar, todas essas opções, coloque
  // no app e web também"*.
  registrarRotasDeDocumento(app, {
    base: "diets",
    prefixoDoArquivo: "plano-alimentar",
    chaveDoAssunto: "email.diet.subject",
    chaveDeOk: "ok.dietEmailed",
    acao: "email_diet",

    montar: async function (req, res) {
      const trainer = await app.helpers.ReqProtected.can(req, res, "diets.view");
      if (trainer === false) return null;

      // `data` já devolve o plano com as refeições ordenadas pelo horário e com
      // os totais calculados — inclusive a regra de que só a primeira opção de
      // cada grupo conta. A folha não recalcula nada disso: recalcular seria
      // criar uma segunda verdade sobre o mesmo plano.
      const diet = await app.api.diet.data(trainer._id, req.params.id);
      if (!diet) {
        res.status(404).send({ msg: req.t("errors.dietNotFound") });
        return null;
      }

      const [student, fuso, casa] = await Promise.all([
        app.api.user.dataStudent(trainer._id, diet.student),
        app.api.tenant.timezoneOfInstance(),
        app.api.tenant.dataOfInstance(),
      ]);

      // ── AS FOTINHAS DOS ALIMENTOS ────────────────────────────────────
      //
      // Relato do Marlon: *"ao enviar a dieta para o e-mail, está sem as
      // fotinhos da comida"*. A tela da dieta as mostra, e a folha não tinha
      // nenhuma — quem recebe reconhece o prato pela foto antes de ler o nome.
      //
      // DEDUPLICADAS por chave: um plano repete "arroz integral" no almoço e no
      // jantar, e a mesma foto entraria duas vezes no anexo e no PDF. Com 42 kB
      // de média, repetir custa caro rápido.
      //
      // TETO de 60 imagens distintas. Um plano gigante não pode virar um e-mail
      // de 10 MB que nenhum servidor aceita — e, passando disso, a folha ainda
      // vale sem foto. `log` quando cortar, senão o limite mente em silêncio.
      const TETO = 60;

      const chaves = [
        ...new Set(
          (diet.meals || [])
            .flatMap((m) => m.foods || [])
            .map((a) => a.imageKey)
            .filter(Boolean)
        ),
      ];

      if (chaves.length > TETO) {
        console.warn(`[documento:diets] ${chaves.length} fotos, usando ${TETO}`);
      }

      const bytesPorChave = {};
      await Promise.all(
        chaves.slice(0, TETO).map(async (chave) => {
          const img = await app.api.foodImage.byKey(chave);
          if (!img) return;

          // ── OS BYTES PODEM ESTAR NO R2 ────────────────────────────────
          //
          // Isto lia `img.data` direto, e desde a migração de 31/08/2026 esse
          // campo NÃO EXISTE MAIS: as 2.499 fotos de alimento têm `chave` e
          // zero bytes no banco. O documento de avaliação foi convertido na
          // época; a dieta ficou para trás.
          //
          // ── POR QUE ISSO PASSOU MESES SEM NINGUÉM VER ─────────────────
          //
          // Porque falhava produzindo algo VÁLIDO. `Buffer.from(undefined || "")`
          // dá um buffer vazio, e um buffer vazio vira
          // `data:image/webp;base64,` — um endereço bem formado, sem dado
          // dentro. O HTML saía com o `<img>` no lugar certo, o e-mail saía com
          // o anexo no lugar certo, e o que chegava era o ícone de imagem
          // quebrada. Nenhum erro, nenhum log, nenhum teste vermelho.
          //
          // O relato foi dele: *"as imagens do plano alimentar, no e-mail e pdf
          // estão indo quebradas"*.
          const bytes = await arquivos.bytesDoDocumento(img);

          // ── E O VAZIO É RECUSADO AQUI ─────────────────────────────────
          //
          // É a guarda que faltava. Sem foto, o `fotinha` do documento não
          // desenha `<img>` nenhum (ele testa se a chave existe no mapa) — e
          // nenhuma foto é melhor que um ícone quebrado, porque a linha continua
          // legível e ninguém acha que o app está estragado.
          if (!bytes || !bytes.length) return;

          bytesPorChave[chave] = { bytes, mime: img.mime || "image/webp" };
        })
      );

      const marca = await logoDaCasa(casa?.theme);
      const CID_LOGO = "logo-da-casa";

      // Duas versões, pelo mesmo motivo da avaliação: o Gmail descarta `data:` no
      // corpo, e o Chromium que faz o PDF não resolve `cid:`.
      const embutidas = {};
      const porCid = {};
      const anexosDeFoto = [];

      for (const [chave, { bytes, mime }] of Object.entries(bytesPorChave)) {
        embutidas[chave] = `data:${mime};base64,${bytes.toString("base64")}`;

        const cid = `alimento-${chave}`;
        porCid[chave] = `cid:${cid}`;
        anexosDeFoto.push({
          cid,
          filename: `${chave}.${(mime.split("/")[1] || "webp").replace("jpeg", "jpg")}`,
          content: bytes,
          contentType: mime,
        });
      }

      if (marca) {
        const [cabecalho, base64] = marca.split(",");
        anexosDeFoto.push({
          cid: CID_LOGO,
          filename: "logo.png",
          content: Buffer.from(base64 || "", "base64"),
          contentType: (cabecalho.match(/data:([^;]+)/) || [])[1] || "image/png",
        });
      }

      const desenhar = (imagens, comoMarca) =>
        documentoDieta({
          diet,
          person: student,
          lang: trainer.lang || req.language,
          fuso,
          imagens,
          marca: comoMarca,
        });

      // A data do arquivo é a de INÍCIO do plano, não a de hoje: dois planos
      // baixados em dias diferentes ficariam com nomes diferentes para o mesmo
      // conteúdo, e o de ontem pareceria outro documento.
      return {
        trainer,
        pessoa: student,
        html: desenhar(embutidas, marca),
        htmlDeEmail: desenhar(porCid, marca ? `cid:${CID_LOGO}` : null),
        fotos: anexosDeFoto,
        nome: student?.name,
        data: diet.startDate,
      };
    },
  });
};
