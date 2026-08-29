const { documentoAvaliacao } = require("../lib/documentoAvaliacao.js");
const { registrarRotasDeDocumento } = require("../lib/rotasDeDocumento.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");

// Os bytes de uma foto, venha ela como vier do banco.
//
// O Mongo devolve `Binary`, cujo `.buffer` É um Buffer — daí o caminho de sempre.
// Mas um Buffer TAMBÉM tem `.buffer`, e ali ele é o ArrayBuffer do pool
// compartilhado: `Buffer.from(buf.buffer)` devolveria o pool inteiro, com os
// bytes de outra coisa junto. Por isso o Buffer é testado PRIMEIRO.
function bytesDa(dado) {
  if (Buffer.isBuffer(dado)) return dado;
  if (dado?.buffer) return Buffer.from(dado.buffer);
  return Buffer.from(dado || "");
}

module.exports = function (app) {
  // As avaliações físicas de uma pessoa.
  //
  // Mesma forma das rotas de treino e de dieta: quem integrou uma integra esta
  // sem reler nada.
  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  app.get("/people/:personId/assessments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // A pessoa vai junto porque TODA conta desta tela depende dela: idade e
    // sexo entram nas fórmulas de dobras, e sem eles a tela mostraria campos
    // vazios sem explicar por quê.
    res.send({
      rows: await app.api.assessment.list(trainer._id, student._id),
      person: {
        _id: student._id,
        name: student.name,
        sex: student.sex || "",
        birthDate: student.birthDate || "",
      },
      // Os ângulos configurados vão JUNTO, e não numa chamada à parte.
      //
      // A tela precisa dos dois ao mesmo tempo — sem a lista ela não sabe
      // quantas vagas desenhar —, e buscar em separado só acrescentaria um
      // instante em que as vagas piscam de quatro para o que a casa escolheu.
      photoSides: await app.api.tenant.assessmentPhotoSides(),
    });
  });

  // ── A TELA "AVALIAÇÕES": as últimas coletas de TODAS as pessoas ──────────
  //
  // Irmã de `/workouts`, e pela mesma razão de existir: dentro da ficha não há
  // como ver que faz seis meses que ninguém é medido. Esta responde "quem eu
  // avaliei ultimamente"; a da ficha responde "como esta pessoa está".
  //
  // `assessments.view` — a mesma permissão da aba. A tela é a mesma informação,
  // ordenada por outra pergunta.
  app.get("/assessments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.view");
    if (trainer === false) return;

    const { rows, total } = await app.api.assessment.pageAll(trainer._id, {
      search: req.query.search,
      studentId: req.query.personId,
      sort: req.query.sort,
      dir: req.query.dir,
      page: req.query.page,
      limit: req.query.limit,
    });

    // Os ângulos configurados vão junto, como na aba: é o que deixa a coluna de
    // fotos dizer "3 de 4" em vez de um número solto.
    res.send({ rows, total, photoSides: await app.api.tenant.assessmentPhotoSides() });
  });

  // Abre uma coleta. Ela nasce RASCUNHO e vazia.
  //
  // Nasce no banco antes de ter qualquer número porque é isso que salva o
  // trabalho: a partir daqui cada campo digitado é um PUT, e uma queda de luz
  // custa o último campo em vez da coleta inteira.
  //
  // Por isso não há exigência de peso e altura aqui — elas valem na hora de
  // fechar a coleta, não na de começá-la. E por isso não há registro no
  // histórico de ações: quem abriu um formulário ainda não fez nada.
  app.post("/people/:personId/assessments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // Um rascunho por pessoa: havendo um em aberto, a tela continua dele. Sem
    // isso, cada clique abandonado deixaria uma coleta vazia para trás.
    const emAberto = await app.api.assessment.draftOf(trainer._id, student._id);
    if (emAberto) {
      res.status(200).send(emAberto);
      return;
    }

    // ── PESO E ALTURA JÁ VÊM PREENCHIDOS ──────────────────────────────────
    //
    // Do CADASTRO da pessoa, quando ele os tem. São os dois únicos campos da
    // coleta que já existem em outro lugar do sistema, e digitá-los de novo em
    // toda avaliação é trabalho que o produto já tinha como poupar.
    //
    // Vêm ANTES do corpo do pedido, e não depois: quem manda peso na criação
    // (uma integração, o app) está dizendo o número daquele dia, e o número
    // daquele dia vence o do cadastro.
    //
    // A altura do cadastro está em CENTÍMETROS e a da coleta em metros — quem
    // converte é `alturaEmMetros`, na entrada do model, que já aceita as duas
    // grafias porque o campo da tela também aceita.
    //
    // Preencher NÃO é medir: o número aparece no campo, editável, e é o
    // profissional que confirma. O peso do cadastro pode ser de um ano atrás.
    const id = await app.api.assessment.insert(trainer._id, student._id, {
      ...(typeof student.weight === "number" ? { weight: student.weight } : {}),
      ...(typeof student.height === "number" ? { height: student.height } : {}),
      ...(req.body || {}),
      draft: true,
    });

    res.status(201).send(await app.api.assessment.data(trainer._id, id));
  });

  // UMA coleta, com o que a tela dela precisa em volta.
  //
  // A rota existia devolvendo o documento cru e sem nenhum consumidor. Ganhou
  // forma quando a tela de uma avaliação nasceu — pedido do Marlon: clicar num
  // cartão da lista levava à aba da pessoa, que mostra TODAS, e "acho que deveria
  // ter uma tela detalhada só dessa avaliação".
  //
  // Vão junto três coisas, e nenhuma é enfeite:
  //
  //   `person`   sexo e nascimento, porque quem calcula gordura e IMC é a TELA
  //              (as fórmulas moram no front, onde o formulário as usa ao vivo).
  //              O nome e a foto, porque fora da ficha "78 kg" não é de ninguém.
  //   `previous` a coleta anterior da mesma pessoa: um número sozinho não diz
  //              nada, e é o que permite mostrar a variação sem pedir a lista.
  //   `photoSides` os ângulos configurados, para desenhar as vagas certas.
  //   `series`   a linha do tempo da pessoa, para os gráficos de evolução.
  app.get("/assessments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.view");
    if (trainer === false) return;

    const assessment = await app.api.assessment.data(trainer._id, req.params.id);
    if (!assessment) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    // A pessoa vem pelo caminho de sempre — `dataStudent` confere que ela é
    // acompanhada por QUEM PERGUNTOU. A coleta já pertence ao profissional (o
    // `data` filtra por ele), e esta é a segunda tranca.
    const student = await app.api.user.dataStudent(trainer._id, assessment.student);

    const [previous, photoSides, series] = await Promise.all([
      app.api.assessment.previousOf(trainer._id, assessment.student, assessment.date, assessment._id),
      app.api.tenant.assessmentPhotoSides(),
      // A linha do tempo desta pessoa, para os gráficos de evolução. Campos
      // crus e sem foto — ver `seriesOf`.
      app.api.assessment.seriesOf(trainer._id, assessment.student),
    ]);

    res.send({
      assessment,
      person: student
        ? {
            _id: student._id,
            name: student.name,
            sex: student.sex || "",
            birthDate: student.birthDate || "",
            avatarAt: student.avatarAt || null,
          }
        : null,
      previous: previous || null,
      photoSides,
      series,
    });
  });

  app.put("/assessments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.manage");
    if (trainer === false) return;

    const body = req.body || {};
    const antes = await app.api.assessment.data(trainer._id, req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    // Peso e altura são o mínimo para FECHAR uma coleta: sem os dois não há
    // IMC, e sem IMC a avaliação não diz nada que a pessoa não soubesse. Num
    // rascunho ainda em preenchimento a exigência não se aplica — ela chegaria
    // antes de o campo existir.
    const fechando = body.draft === false;
    if (fechando && (!body.weight || !body.height)) {
      res.status(400).send({ msg: req.t("errors.requireWeightHeight") });
      return;
    }

    const ok = await app.api.assessment.update(trainer._id, req.params.id, body);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    const depois = await app.api.assessment.data(trainer._id, req.params.id);

    // O histórico de ações registra COLETAS, não teclas.
    //
    // Salvando a cada campo digitado, registrar todo PUT encheria o histórico
    // de dezenas de entradas por avaliação e afogaria tudo o mais que a conta
    // fez no dia. O que vale é o momento em que o rascunho vira avaliação — e
    // depois disso, cada edição de verdade.
    if (fechando && antes.draft) {
      app.insertUserActionHistory(req, trainer, "create_assessment", {
        category: "assessments",
        local: { target_type: "assessments", target_id: req.params.id + "" },
        extra: { personId: antes.student + "", weight: depois.weight },
      });
    } else if (!antes.draft) {
      app.insertUserActionHistory(req, trainer, "update_assessment", {
        category: "assessments",
        local: { target_type: "assessments", target_id: req.params.id + "" },
        diff: app.api.actionHistory.diff(antes, depois),
      });
    }

    res.send(depois);
  });

  // ── Fotos de evolução ───────────────────────────────────────────────────
  //
  // Uma rota por ÂNGULO, e os ângulos válidos são os que a casa configurou — de
  // fábrica os quatro de sempre (frente, direita, esquerda, costas), no máximo
  // doze. Não há rota que acrescente foto: subir de novo no mesmo ângulo
  // substitui aquela.
  //
  // É o que impede a avaliação de virar álbum: o teto não é uma contagem que
  // alguém precisa lembrar de checar, é o formato da rota. E é o que faz a
  // comparação funcionar, porque comparar depende de ser sempre o mesmo ângulo.
  async function coletaEFoto(req, res, permissao) {
    const trainer = await app.helpers.ReqProtected.can(req, res, permissao);
    if (trainer === false) return false;

    if (!(await app.api.assessmentPhoto.isSide(req.params.side))) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return false;
    }

    const assessment = await app.api.assessment.data(trainer._id, req.params.id);
    if (!assessment) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return false;
    }

    return { trainer, assessment };
  }

  app.get("/assessments/:id/photos/:side", async function (req, res) {
    const ctx = await coletaEFoto(req, res, "assessments.view");
    if (ctx === false) return;

    const foto = await app.api.assessmentPhoto.data(req.params.id, req.params.side);
    if (!foto) {
      res.status(404).send({ msg: req.t("errors.noPhotoShort") });
      return;
    }

    // `private` porque é conteúdo de uma sessão — e aqui mais que no avatar:
    // é a foto do corpo de um cliente. Um proxy compartilhado não pode guardar
    // isto e servir para outra pessoa.
    const versao = '"' + new Date(foto.updatedAt).getTime() + '"';

    res.setHeader("Content-Type", foto.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("ETag", versao);

    if (req.headers["if-none-match"] === versao) {
      res.status(304).end();
      return;
    }

    res.send(foto.data.buffer ? Buffer.from(foto.data.buffer) : foto.data);
  });

  app.put("/assessments/:id/photos/:side", async function (req, res) {
    const ctx = await coletaEFoto(req, res, "assessments.manage");
    if (ctx === false) return;

    const parsed = app.api.assessmentPhoto.parseDataUri((req.body || {}).image);
    if (!parsed) {
      res.status(400).send({ msg: req.t("errors.invalidImage") });
      return;
    }

    const at = await app.api.assessmentPhoto.save(
      req.params.id,
      req.params.side,
      parsed.mime,
      parsed.buffer
    );

    // O carimbo vai para o documento da coleta: é por ele que a listagem sabe
    // quais fotos existem sem tocar nos bytes.
    await app.api.assessment.setPhoto(ctx.trainer._id, req.params.id, req.params.side, at);

    res.send({ side: req.params.side, at });
  });

  app.delete("/assessments/:id/photos/:side", async function (req, res) {
    const ctx = await coletaEFoto(req, res, "assessments.manage");
    if (ctx === false) return;

    await app.api.assessmentPhoto.remove(req.params.id, req.params.side);
    await app.api.assessment.clearPhoto(ctx.trainer._id, req.params.id, req.params.side);

    res.send({ side: req.params.side });
  });

  app.delete("/assessments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.manage");
    if (trainer === false) return;

    const alvo = await app.api.assessment.data(trainer._id, req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
      return;
    }

    // As fotos vão junto: elas são referenciadas pela coleta, e sem isto os
    // bytes ficariam no banco para sempre sem nada apontando para eles.
    await app.api.assessmentPhoto.deleteAllOfAssessment(req.params.id);
    await app.api.assessment.delete(trainer._id, req.params.id);

    // Descartar um rascunho não é apagar uma avaliação: nada foi entregue a
    // ninguém, e registrar isso no histórico seria contar como exclusão o
    // fechar de um formulário.
    if (!alvo.draft) {
      app.insertUserActionHistory(req, trainer, "delete_assessment", {
        category: "assessments",
        local: { target_type: "assessments", target_id: req.params.id + "" },
        extra: { weight: alvo.weight },
      });
    }

    res.send({ msg: req.t("ok.assessmentRemoved") });
  });

  // ── O DOCUMENTO DA AVALIAÇÃO ──────────────────────────────────────────
  //
  // As três rotas (ver, baixar em PDF, mandar por e-mail) são iguais às do plano
  // alimentar e moram em `lib/rotasDeDocumento.js`. Aqui fica só o que é da
  // avaliação: como carregá-la e como montar a folha.
  //
  // Pedido do Marlon, e o motivo dele: *"o ideal seria esse PDF ser um html
  // gerado direto no backend, assim garantimos que vai ser igual no web e no
  // app"*.
  registrarRotasDeDocumento(app, {
    base: "assessments",
    prefixoDoArquivo: "avaliacao",
    chaveDoAssunto: "email.assessment.subject",
    chaveDeOk: "ok.assessmentEmailed",
    acao: "email_assessment",

    montar: async function (req, res) {
      // Mesma trava da rota que mostra a avaliação: a permissão, e depois o
      // vínculo — `data` já filtra pelo profissional dono.
      const trainer = await app.helpers.ReqProtected.can(req, res, "assessments.view");
      if (trainer === false) return null;

      const assessment = await app.api.assessment.data(trainer._id, req.params.id);
      if (!assessment) {
        res.status(404).send({ msg: req.t("errors.assessmentNotFound") });
        return null;
      }

      const student = await app.api.user.dataStudent(trainer._id, assessment.student);

      const [previous, photoSides, fuso, casa] = await Promise.all([
        app.api.assessment.previousOf(trainer._id, assessment.student, assessment.date, assessment._id),
        app.api.tenant.assessmentPhotoSides(),
        app.api.tenant.timezoneOfInstance(),
        app.api.tenant.dataOfInstance(),
      ]);

      // ── AS FOTOS VÃO EMBUTIDAS, e é isso que faz a folha viajar ───────
      //
      // `data:` URI, e não uma URL para a rota da foto. Aquela exige sessão: um
      // `<img>` apontando para ela sai em branco no e-mail, no `expo-print` e no
      // PDF. Embutida, a folha funciona em qualquer lugar — inclusive salva em
      // disco, meses depois.
      //
      // O custo é o tamanho: cada foto infla ~33% em base64. São no máximo os
      // ângulos configurados, e é o preço de a folha existir fora do app.
      // ── DUAS VERSÕES DA MESMA FOLHA, e o motivo é concreto ───────────
      //
      // O Gmail DESCARTA `<img src="data:…">` — foi o que sumiu as fotos do corpo
      // do e-mail. O que funciona lá é o anexo embutido (`cid:`).
      //
      // Só que o PDF é gerado do mesmo HTML por um Chromium que NÃO resolve
      // `cid:` — ele não tem a mensagem MIME, só a página. Gerar o PDF a partir
      // da versão de e-mail deixou o anexo sem foto nenhuma: *"inverteu o
      // problema"*, como o Marlon descreveu.
      //
      // Então saem duas: a de `data:` para o PDF, para ver e para imprimir; e a
      // de `cid:` para o corpo do e-mail. As duas são construídas do MESMO dado,
      // no mesmo lugar — não há como uma envelhecer sem a outra.
      const bytesPorLado = {};

      await Promise.all(
        (photoSides || []).map(async (lado) => {
          if (!assessment.photos?.[lado.key]) return;
          const foto = await app.api.assessmentPhoto.data(req.params.id, lado.key);
          if (!foto) return;
          bytesPorLado[lado.key] = { bytes: bytesDa(foto.data), mime: foto.mime || "image/jpeg" };
        })
      );

      const marca = await logoDaCasa(casa?.theme);

      // A LOGO tem o mesmo problema das fotos: ela é `data:`, e o Gmail a
      // descarta igual. No corpo do e-mail ela também vira anexo embutido.
      const CID_LOGO = "logo-da-casa";

      const desenhar = (comoImagem, comoMarca) =>
        documentoAvaliacao({
          assessment,
          person: student,
          previous,
          photoSides,
          imagens: comoImagem,
          // O idioma é o de quem PEDIU — é ele que vai ler ou entregar a folha.
          lang: trainer.lang || req.language,
          fuso,
          marca: comoMarca,
        });

      const embutidas = {};
      const porCid = {};
      const fotos = [];

      for (const [lado, { bytes, mime }] of Object.entries(bytesPorLado)) {
        embutidas[lado] = `data:${mime};base64,${bytes.toString("base64")}`;

        const cid = `foto-${lado}`;
        porCid[lado] = `cid:${cid}`;
        fotos.push({ cid, filename: `${lado}.${mime.split("/")[1] || "jpg"}`, content: bytes, contentType: mime });
      }

      if (marca) {
        // A logo já veio em `data:`; para o anexo ela precisa voltar a ser byte.
        const [cabecalho, base64] = marca.split(",");
        fotos.push({
          cid: CID_LOGO,
          filename: "logo.png",
          content: Buffer.from(base64 || "", "base64"),
          contentType: (cabecalho.match(/data:([^;]+)/) || [])[1] || "image/png",
        });
      }

      return {
        trainer,
        pessoa: student,
        html: desenhar(embutidas, marca),
        htmlDeEmail: desenhar(porCid, marca ? `cid:${CID_LOGO}` : null),
        fotos,
        nome: student?.name,
        data: assessment.date,
      };
    },
  });
};