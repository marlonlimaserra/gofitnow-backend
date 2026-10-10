const instanceContext = require("../lib/instance.js");
const rateLimit = require("../lib/rateLimit.js");
const Dispositivo_model = require("../model/Dispositivo_model.js");

// O LEITOR FACIAL DA PORTA — Control iD iDFace.
//
// *"conectei o control id na rede, agora precisa fazer a integração"* (06/10/2026),
// e antes disso: *"já comprei o negócio de face ID para a gente testar quando
// chegar"*, que é de quando o `Checkin_model` nasceu esperando por este dia.
//
// ── POR QUE É O APARELHO QUE LIGA PARA NÓS, E NÃO O CONTRÁRIO ──────────────
//
// O leitor fica atrás do roteador da academia. Nosso servidor está na nuvem.
// Da nuvem não se alcança um aparelho em rede doméstica sem redirecionamento de
// porta ou IP fixo — e pedir isso a cada dono de academia é o fim do produto
// antes de começar.
//
// A Control iD resolve com dois canais em que QUEM LIGA É O APARELHO. É o mesmo
// mecanismo do iDCloud (a nuvem paga deles): lá o endereço aponta para
// `push.idsecure.com.br`, aqui aponta para nós. Não assinamos o iDCloud — o
// VAFIT é o servidor.
//
//   MONITOR  o aparelho avisa cada evento (passou alguém, porta abriu, estou vivo)
//   PUSH     o aparelho pergunta de tempos em tempos "tem comando para mim?"
//
// Configuração gravada no aparelho (`set_configuration.fcgi`, ou pela tela dele):
//
//   monitor      { hostname: "api.vafit.app", port: "443",
//                  path: "cid/<credencial>" }
//   push_server  { push_remote_address: "https://api.vafit.app/cid/<credencial>",
//                  push_request_period: "5" }
//
// ── A CREDENCIAL ESTÁ NO CAMINHO, E ISSO É DE PROPÓSITO ────────────────────
//
// Um leitor facial não manda cabeçalho: ele tem um campo de endereço e mais
// nada. Então a credencial cabe no endereço — ver `model/Dispositivo_model.js`,
// que explica o formato `instancia.segredo` e por que a instância viaja junto.
//
// Consequência que não dá para esquecer: estas rotas entram na lista
// `SEM_INSTANCIA` do `lib/instanceGate.js`, e por isso elas mesmas têm de abrir
// o contexto da instância — e conferi-la na central antes, como o gate faria.
// É o mesmo caminho da volta do login do Google, pelo mesmo motivo.
//
// ── O QUE NÃO GUARDAMOS ────────────────────────────────────────────────────
//
// Template biométrico. Ele fica no aparelho, que é quem reconhece o rosto; o
// que chega aqui é um número de usuário. Dado biométrico é sensível na LGPD, e
// guardá-lo nos poria a responder por uma coisa que o aparelho já resolve — a
// decisão está escrita desde o `Checkin_model`, e esta integração a respeita.
module.exports = function (app) {
  // ── A PORTA DE ENTRADA DOS APARELHOS ─────────────────────────────────────
  //
  // Resolve a credencial, confere a instância na central, abre o contexto e
  // acha o aparelho. Devolve `false` depois de já ter respondido — o mesmo
  // contrato dos `protect` deste backend, para o corpo das rotas ficar com uma
  // linha de guarda e nada mais.
  //
  // ── POR QUE A RESPOSTA DE ERRO É SEMPRE CURTA E SEM EXPLICAÇÃO ───────────
  //
  // Porque do outro lado não há gente lendo: é um aparelho que vai repetir a
  // requisição em cinco segundos para sempre. Mensagem bonita não ajuda
  // ninguém, e distinguir "instância não existe" de "segredo errado" entrega a
  // quem está sondando o endereço qual metade ele acertou.
  async function comDispositivo(req, res, canal, fn) {
    const partes = Dispositivo_model.separarCredencial(req.params.credencial);
    if (!partes) return res.status(401).send({});

    let conhecida = false;
    try {
      conhecida = await app.api.center.isActive(partes.instancia);
    } catch (erro) {
      // Central fora do ar FECHA a porta, como no `instanceGate`. 503 e não 401:
      // é indisponibilidade nossa, e o aparelho tentando de novo é o certo.
      console.error("[controlid] não consegui conferir a instância:", erro.message);
      return res.status(503).send({});
    }
    if (!conhecida) return res.status(401).send({});

    return instanceContext.run(partes.instancia, async function () {
      const dispositivo = await app.api.dispositivo.porSegredo(partes.segredo);
      if (!dispositivo) {
        // ── O LIMITADOR SÓ EXISTE PARA O ERRO ─────────────────────────────
        //
        // O segredo virou 14 dígitos a pedido dele, e 10^14 é um número que não
        // se deixa sozinho. Quem acerta passa livre — o aparelho legítimo bate
        // aqui a cada poucos segundos e não pode ser estrangulado. Quem erra
        // entra na conta, e o chute em escala deixa de caber no tempo de uma
        // vida.
        await rateLimit.checkShared("controlid:" + (req.clientIp || "sem-ip"));
        return res.status(401).send({});
      }

      // ── O APARELHO SE PRENDE À CREDENCIAL ─────────────────────────────────
      //
      // Toda requisição traz o id do aparelho. No PRIMEIRO contato ele é
      // gravado; daí em diante, credencial certa com aparelho diferente é
      // recusada.
      //
      // É a segunda trava que paga a conta do segredo curto: mesmo que alguém
      // adivinhasse os 14 dígitos, só conseguiria usá-los antes de o leitor de
      // verdade chegar — e depois disso o impostor bate numa porta fechada.
      const quemDiz = String(req.body?.device_id || req.query?.deviceId || "").trim();
      if (quemDiz && dispositivo.deviceId && dispositivo.deviceId !== quemDiz) {
        console.warn(
          "[controlid] credencial de " + partes.instancia + " usada por aparelho diferente: " +
            quemDiz + " (esperado " + dispositivo.deviceId + ")"
        );
        return res.status(401).send({});
      }

      // ── O SEGREDO DO PUSH NUNCA ANDA EM TEXTO PURO ───────────────────
      //
      // Desde 09/10/2026 o canal de monitor chega pela porta 80, sem TLS —
      // não por escolha, mas porque o firmware do iDFace não sabe fazer o
      // monitor falar HTTPS (a explicação inteira está em `configurarMonitor`).
      //
      // A decisão foi aceitar isso para o MONITOR, que só conta o que já
      // aconteceu, e nunca para o PUSH, que RECEBE comandos — e que a partir
      // do cadastro remoto de rosto passa a carregar FOTO. Quem escuta o fio
      // da academia pega uma chave que sabe dizer "alguém passou"; não uma que
      // drena a fila de comandos nem recebe imagem de ninguém.
      //
      // Daí duas regras, e elas bastam:
      const semTls = String(req.headers["x-forwarded-proto"] || "https").toLowerCase() === "http";

      // 1. A credencial do push é recusada em QUALQUER rota sem TLS. Se ela
      //    aparecer na porta 80 é porque está mal configurada — e o certo é
      //    não atendê-la, não "atender só desta vez".
      if (dispositivo.canal === "push" && semTls) {
        console.warn(
          "[controlid] credencial de push recusada em texto puro: " + partes.instancia
        );
        return res.status(401).send({});
      }

      // 2. A credencial do monitor não abre o push nem com TLS. O contrário é
      //    permitido de propósito: um aparelho antigo, configurado antes de o
      //    monitor ganhar credencial própria, continua falando pela 443 como
      //    sempre falou — e a regra 1 garante que ele nunca cairá na 80.
      if (canal === "push" && dispositivo.canal !== "push") {
        return res.status(401).send({});
      }

      req.instance = partes.instancia;
      return fn(dispositivo);
    });
  }

  // Os dois canais, nomeados. O canal exigido fica VISÍVEL em cada rota em vez
  // de ser deduzido do caminho: a trava acima só vale se for impossível
  // esquecer de declará-la, e uma rota nova que chame o atalho errado salta aos
  // olhos na revisão.
  const comMonitor = (req, res, fn) => comDispositivo(req, res, "monitor", fn);
  const comPush = (req, res, fn) => comDispositivo(req, res, "push", fn);

  // ── MONITOR: "ALGUÉM PASSOU" ─────────────────────────────────────────────
  //
  // O aparelho manda as mudanças das tabelas internas dele. O que nos interessa
  // é `access_logs` inserido — é a batida.
  //
  //   { "object_changes": [ { "object": "access_logs", "type": "inserted",
  //       "values": { "user_id": "37", "time": "1532977090", "event": "12" } } ],
  //     "device_id": 478435 }
  //
  // `time` vem em SEGUNDOS desde 1970 (o aparelho é embarcado, não manda ISO).
  // Multiplicar por mil é a diferença entre registrar a entrada de hoje e uma
  // de 1970 — e um erro desses só aparece na tela do dono, semanas depois.
  app.post("/cid/:credencial/dao", async function (req, res) {
    await comMonitor(req, res, async function (dispositivo) {
      const corpo = req.body || {};

      app.api.dispositivo.tocar(dispositivo._id, { deviceId: corpo.device_id });

      app.api.dispositivo.registrarEvento(dispositivo._id, "dao", corpo, req.corpoCru);

      const mudancas = Array.isArray(corpo.object_changes) ? corpo.object_changes : [];
      const batidas = mudancas.filter(
        (m) => m?.object === "access_logs" && m?.type === "inserted" && m?.values
      );

      for (const batida of batidas) {
        await registrarBatida(dispositivo, batida.values);
      }

      // O aparelho não lê o corpo: ele quer o 200 para marcar o evento como
      // entregue. Responder erro aqui faria ele reenviar para sempre.
      res.send({});
    });
  });

  // Uma batida vira check-in, ou vira pendência. Nunca vira nada.
  async function registrarBatida(dispositivo, valores) {
    // A leitura dos campos crus é função pura em `Dispositivo_model` — é lá que
    // está explicado por que o tempo vem em segundos e o que `user_id: "0"`
    // quer dizer. Aqui só fica a decisão de o que FAZER com o que se leu.
    const { usuarioNoAparelho, em, reconhecido } = Dispositivo_model.lerBatida(valores);
    if (!reconhecido) return;

    // Sem tempo utilizável vale agora: a batida acabou de chegar, e perder a
    // entrada por causa de um relógio desacertado seria pior que um minuto de
    // diferença.
    const quando = em || new Date();

    const pessoa = await app.api.dispositivo.pessoaDoUsuario(dispositivo._id, usuarioNoAparelho);

    if (!pessoa) {
      await guardarPendencia(dispositivo, usuarioNoAparelho, quando);
      return;
    }

    const existe = await app.api.user.data(pessoa);
    if (!existe) return;

    await app.api.checkin.registrar(pessoa, {
      em: quando,
      origem: "catraca",
      unit: dispositivo.unit || existe.unit,
      dispositivo: dispositivo.nome,
    });
  }

  // ── A PENDÊNCIA ──────────────────────────────────────────────────────────
  //
  // Passou alguém que o aparelho conhece e nós não. Guardar o evento cru é o
  // que permite transformar em frequência de verdade no minuto em que alguém
  // ligar as pontas na tela — e é a diferença entre "a academia cadastrou no
  // leitor antes de cadastrar no sistema" ser um detalhe ou ser perda de dado.
  async function guardarPendencia(dispositivo, usuarioNoAparelho, em) {
    const db = await app.mongodb.connectToServer();
    await db.collection("access_device_pendings").insertOne({
      dispositivo: dispositivo._id,
      usuarioNoAparelho,
      em,
      createdAt: new Date(),
    });
  }

  // ── MONITOR: O RESTO ─────────────────────────────────────────────────────
  //
  // Batimento de vida, modo de operação, porta e giro de catraca. Hoje só
  // servem para dizer que o aparelho está vivo — mas precisam responder 200:
  // endpoint que devolve 404 faz o aparelho repetir, e repetir a cada 30
  // segundos para sempre é ruído que esconde o evento que importa.
  //
  // `access_photo` é a foto de cada identificação. Ela é aceita e DESCARTADA de
  // propósito: guardar foto de rosto de todo mundo que entra na academia é
  // exatamente o tipo de acervo que a LGPD trata como sensível, e nada no
  // produto precisa dela hoje. Se um dia precisar, a decisão é consciente e vem
  // com consentimento — não por acidente de integração.
  for (const rota of ["device_is_alive", "operation_mode", "door", "catra_event", "access_photo"]) {
    app.post("/cid/:credencial/" + rota, async function (req, res) {
      await comMonitor(req, res, async function (dispositivo) {
        app.api.dispositivo.tocar(dispositivo._id, { deviceId: (req.body || {}).device_id });
        // A foto não é guardada — só o registro de que chegou. Ver o cabeçalho
        // de `registrarEvento` no modelo.
        app.api.dispositivo.registrarEvento(
          dispositivo._id,
          rota,
          rota === "access_photo" ? { recebida: true } : req.body,
          rota === "access_photo" ? "" : req.corpoCru
        );
        res.send({});
      });
    });
  }

  // ── PUSH: "TEM COMANDO PARA MIM?" ────────────────────────────────────────
  //
  // O aparelho pergunta a cada poucos segundos. Resposta vazia = nada a fazer,
  // e é o que ele vai ouvir 99,9% das vezes. Quando houver, sai um comando no
  // formato dele:
  //
  //   { verb, endpoint, body, contentType }
  //
  // A fila ainda não tem quem a encha — o cadastro remoto de rosto é o próximo
  // passo. O canal existe desde já porque é ele que torna o cadastro remoto
  // possível, e porque um aparelho configurado hoje já começa a perguntar.
  app.get("/cid/:credencial/push", async function (req, res) {
    await comPush(req, res, async function (dispositivo) {
      app.api.dispositivo.tocar(dispositivo._id, { deviceId: req.query.deviceId });

      const comando = await app.api.dispositivo.proximoComando(dispositivo._id);
      // Só registra quando SAI alguma coisa: a pergunta de rotina chega de
      // minuto em minuto e encheria o histórico de linhas iguais.
      if (comando) app.api.dispositivo.registrarEvento(dispositivo._id, "push", comando);
      res.send(comando || {});
    });
  });

  // O aparelho conta como foi o comando anterior. A resposta tem de ser VAZIA —
  // é o que faz ele voltar a perguntar em `/push`.
  app.post("/cid/:credencial/result", async function (req, res) {
    await comPush(req, res, async function (dispositivo) {
      await app.api.dispositivo.guardarResultado(dispositivo._id, req.body || {});
      app.api.dispositivo.registrarEvento(dispositivo._id, "result", req.body, req.corpoCru);
      res.send({});
    });
  });

  // ── O QUE O FIRMWARE MANDA E A GENTE NÃO CONHECE ─────────────────────────
  //
  // O aparelho posta em `/secbox` — endpoint que não está na lista acima e que
  // ninguém documentou para nós. Ele vinha levando 404, e 404 faz firmware
  // repetir: a cada 30 segundos, para sempre.
  //
  // Então o desconhecido também recebe 200 e vai para o histórico, com o nome
  // que ele usou. É a mesma regra do resto desta integração: **um evento da
  // porta não se perde**, e o que a gente ainda não entende fica GUARDADO em
  // vez de recusado — é assim que se descobre o que ele é.
  //
  // Vem depois das rotas conhecidas de propósito: o Express casa na ordem, e
  // esta engoliria todas se viesse antes.
  app.post("/cid/:credencial/:desconhecido", async function (req, res) {
    await comMonitor(req, res, async function (dispositivo) {
      app.api.dispositivo.tocar(dispositivo._id, { deviceId: (req.body || {}).device_id });
      app.api.dispositivo.registrarEvento(
        dispositivo._id,
        String(req.params.desconhecido || "?").slice(0, 40),
        req.body,
        req.corpoCru
      );
      res.send({});
    });
  });


  // ── A TELA: OS APARELHOS DA ACADEMIA ─────────────────────────────────────
  //
  // Estas sim passam pelo `instanceGate` e pela sessão, como qualquer rota do
  // painel. `users.manage` e não `people.view`: criar um leitor é entregar uma
  // credencial que grava frequência — é administração, não consulta.
  // ── EXISTE LEITOR NESTA CASA? ────────────────────────────────────────────
  //
  // A ficha do aluno precisa saber disso para decidir se mostra a chave
  // "Passagem liberada" — uma chave que não comanda nada é pior que chave
  // nenhuma, e academia sem catraca não deve nem desconfiar que isso existe.
  //
  // Permissão `people.edit` e não `users.manage`: quem edita a ficha de um
  // aluno precisa da resposta, e um personal sem acesso à administração também
  // edita ficha. A resposta é um booleano — não vaza nem nome nem credencial.
  app.get("/access-devices/exists", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (user === false) return;

    // `podeMudar` vem junto porque a ficha não tem um canal de permissões —
    // e inventar um só para isto seria refatorar meia tela. Quem sabe se este
    // usuário pode virar a catraca é o servidor, e ele já está respondendo.
    //
    // Sem isso, quem não tem `people.gate` veria o crachá como botão, clicaria
    // e levaria 403. Erro no lugar de ausência ensina que o sistema está
    // quebrado, quando na verdade está funcionando.
    res.send({
      existe: (await app.api.dispositivo.listar()).length > 0,
      podeMudar: Boolean(user.permissions?.includes("people.gate")),
    });
  });

  app.get("/access-devices", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    res.send({ rows: await app.api.dispositivo.listar() });
  });

  app.post("/access-devices", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const criado = await app.api.dispositivo.criar(req.body || {});

    // ── O MONITOR JÁ SAI ENFILEIRADO ──────────────────────────────────────
    //
    // *"quando cadastrar o leitor, já deixe esse comando, para eu não precisar
    // clicar no botão"* (06/10/2026).
    //
    // O aparelho ainda não existe para nós neste instante — ele nem foi
    // configurado. Mas o comando não precisa de ninguém escutando: ele espera
    // na fila. Quando o leitor for ligado e fizer o primeiro push, encontra o
    // `set_configuration` lá e se configura sozinho.
    //
    // É o que transforma a instalação em UM passo: colar o endereço do push na
    // tela do aparelho. O resto ele busca.
    //
    // O botão "Ligar o monitor daqui" continua existindo — serve aos leitores
    // criados antes disto, e ao dia em que alguém reconfigurar o aparelho e
    // apagar o monitor sem querer.
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
      .split(":")[0]
      .trim();
    if (host) await app.api.dispositivo.configurarMonitor(criado._id, host);

    // A credencial sai AQUI e só aqui, como toda chave de API deste backend.
    // Quem não copiou agora apaga e cria outro.
    app.insertUserActionHistory(req, user, "create_access_device", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(criado._id) },
    });
    res.status(201).send(criado);
  });

  // Trocar a credencial. A antiga morre no mesmo instante — é o que se quer
  // tanto para quem perdeu o papel quanto para quem precisa revogar.
  app.post("/access-devices/:id/credential", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const credencial = await app.api.dispositivo.novaCredencial(req.params.id);
    if (!credencial) return res.status(404).send({ msg: req.t("errors.notFound") });

    app.insertUserActionHistory(req, user, "reset_access_device_credential", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(req.params.id) },
    });

    res.send({ credencial });
  });

  app.delete("/access-devices/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    // ── APAGAR UM LEITOR EM USO PEDE SENHA ────────────────────────────────
    //
    // *"se recebeu sinal, pede para por senha antes de excluir e avise que
    // está em uso"* (06/10/2026).
    //
    // O que está em jogo não é o registro: é a PORTA. Apagar um leitor que já
    // deu sinal cala a frequência da academia no mesmo instante — e o sintoma
    // não é um erro, é a ausência dele. Ninguém percebe hoje; percebe-se no fim
    // do mês, quando o relatório vem vazio e já não há como reconstruir quem
    // entrou.
    //
    // É o mesmo raciocínio de `conferirSenha` em `Account.js`: a sessão do
    // painel fica aberta por semanas, e um computador destravado na recepção é
    // exatamente onde esse clique acontece sem querer.
    //
    // Leitor que nunca deu sinal não pede nada: é cadastro errado, criado há um
    // minuto, e exigir senha ali seria cerimônia sem risco.
    const dispositivo = await app.api.dispositivo.data(req.params.id);
    if (!dispositivo) return res.status(404).send({ msg: req.t("errors.notFound") });

    if (dispositivo.ultimoContato) {
      const senha = String(req.body?.senha || "");
      if (!senha) {
        return res.status(400).send({
          msg: req.t("errors.accessDeviceInUse"),
          code: "senha_faltando",
        });
      }

      // 403 e não 401 — 401 faria o painel achar que a sessão caiu e mandar a
      // pessoa para o login por causa de um erro de digitação.
      if (!(await app.api.user.conferirSenha(String(user._id), senha))) {
        return res.status(403).send({
          msg: req.t("errors.deletionWrongPassword"),
          code: "senha_errada",
        });
      }
    }

    const ok = await app.api.dispositivo.remover(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.notFound") });

    app.insertUserActionHistory(req, user, "delete_access_device", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(req.params.id) },
    });
    res.send({ msg: req.t("ok.accessDeviceRemoved") });
  });

  // As batidas que chegaram de alguém que o aparelho conhece e nós não. É a
  // fila de trabalho da tela: cada linha é um "quem é este?" esperando resposta.
  app.get("/access-devices/:id/pendings", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    res.send({ rows: await app.api.dispositivo.pendencias(req.params.id) });
  });

  // Jogar fora as batidas de um número que nunca vai ter dono — o usuário foi
  // apagado na tela do aparelho, e aquele número não volta.
  //
  // Apaga frequência que nunca foi contada, então a tela confirma antes. Não
  // existe "descartar tudo": quem limpa a lista inteira de uma vez não leu
  // nenhuma linha dela.
  app.delete("/access-devices/:id/pendings/:usuario", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const quantas = await app.api.dispositivo.descartarPendencias(
      req.params.id,
      req.params.usuario
    );

    app.insertUserActionHistory(req, user, "discard_access_device_pendings", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(req.params.id) },
      extra: { usuarioNoAparelho: String(req.params.usuario), quantas },
    });

    res.send({ quantas });
  });

  // ── LIGAR O MONITOR À DISTÂNCIA ──────────────────────────────────────────
  //
  // O canal de monitor — o que traz a passagem do aluno — NÃO existe na tela do
  // aparelho: só se configura pela API. E o leitor fica atrás do roteador da
  // academia, onde a nuvem não alcança.
  //
  // A saída é o próprio push: enfileiramos um `set_configuration` e ele busca
  // no próximo ciclo. Quem não alcança o aparelho é a rede; a conversa que ele
  // mesmo abriu alcança.
  app.post("/access-devices/:id/configure-monitor", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    // O endereço que o APARELHO precisa discar é o deste servidor, visto de
    // fora. Sai do cabeçalho da requisição — que é por onde o painel chegou —
    // e não de constante no código: há três domínios atendendo este backend, e
    // cravar um faria o leitor de um cliente discar para o endereço de outro.
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
      .split(":")[0]
      .trim();
    if (!host) return res.status(400).send({ msg: req.t("errors.internal") });

    const credencial = await app.api.dispositivo.configurarMonitor(req.params.id, host);
    if (!credencial) return res.status(404).send({ msg: req.t("errors.notFound") });

    app.insertUserActionHistory(req, user, "configure_access_device_monitor", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(req.params.id) },
    });

    // O aparelho pergunta de minuto em minuto; a tela avisa que pode demorar
    // isso. Não esperamos aqui — seria segurar a requisição por um minuto.
    res.send({ ok: true });
  });

  // Perguntar ao aparelho o que ele tem guardado. A resposta volta pelo
  // `/result` e aparece no histórico — é como se sai da dúvida "ele aplicou ou
  // só disse que sim?".
  app.post("/access-devices/:id/ask-config", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const ok = await app.api.dispositivo.perguntarConfiguracao(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.notFound") });

    res.send({ ok: true });
  });

  // Perguntar QUEM está cadastrado lá dentro — e com que permissão.
  //
  // *"esse aluno tá cadastrado mas a catraca não libera"*: quem decide abrir é
  // o aparelho, com o cadastro DELE. Esta rota é como se vê esse cadastro sem
  // estar na frente do leitor.
  app.post("/access-devices/:id/ask-objects", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const quantos = await app.api.dispositivo.perguntarCadastro(req.params.id);
    if (!quantos) return res.status(404).send({ msg: req.t("errors.notFound") });

    res.send({ ok: true, perguntas: quantos });
  });

  // Liberar no aparelho quem ele já conhece.
  //
  // *"esse aluno tá cadastrado mas a catraca não libera"*: o rosto estava lá,
  // ele reconhecia, e `user_access_rules` estava vazio. Este é o comando que
  // fecha esse buraco — e ele depende de a gente SABER qual regra abre a
  // porta, o que só o aparelho pode dizer.
  app.post("/access-devices/:id/release/:usuario", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.dispositivo.liberarNoAparelho(req.params.id, req.params.usuario);

    // "Pergunte primeiro" é resposta, não erro de sistema: sem o cadastro lido
    // não há como escolher a regra, e escolher errado dá o mesmo sintoma de
    // não ter feito nada.
    if (r.erro === "sem_regra") {
      return res.status(409).send({ msg: req.t("errors.accessDeviceAskFirst"), code: r.erro });
    }
    if (r.erro) return res.status(404).send({ msg: req.t("errors.notFound") });

    app.insertUserActionHistory(req, user, "release_access_device_user", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(req.params.id) },
      extra: { usuarioNoAparelho: String(req.params.usuario), regra: r.regra },
    });

    res.send({ ok: true, regra: r.regra });
  });

  // O histórico cru. É a janela para dentro da caixa-preta: o que o aparelho
  // mandou, quando, e exatamente como.
  // ── SÓ O QUE DEU ERRADO ────────────────────────────────────────────────
  //
  // O histórico cru tem tudo, e por isso esconde isto: cem linhas de push de
  // rotina para cada recusa, com a mensagem enterrada num JSON escapado. Foi
  // assim que o `Invalid member 'match'` passou despercebido enquanto o
  // usuário era criado e a regra ligada — de fora, parecia ter funcionado.
  // A FILA DE PEDIDOS, com o estado de cada um. É a resposta visível para
  // "mandei e não sei se chegou" — e ela distingue o aparelho que não veio
  // buscar do que veio, levou e recusou.
  // ── OS AJUSTES DO LEITOR ───────────────────────────────────────────────
  //
  // *"bote aqui uma aba chamada configurações, a primeira vai ser um checkbox,
  // 'bloquear se houver pendências'"* (10/10/2026).
  //
  // Ligar isto muda quem entra na academia amanhã de manhã, então é
  // `users.manage` — a mesma permissão de criar o leitor, não a de editar uma
  // ficha.
  app.patch("/access-devices/:id/settings", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const leitor = await app.api.dispositivo.ajustar(req.params.id, req.body || {});
    if (!leitor) return res.status(404).send({ msg: req.t("errors.notFound") });

    app.insertUserActionHistory(req, user, "update_access_device_settings", {
      category: "configuration",
      local: { target_type: "access_devices", target_id: String(req.params.id) },
      extra: { bloquearComPendencia: Boolean(leitor.bloquearComPendencia) },
    });

    res.send(leitor);
  });

  app.get("/access-devices/:id/queue", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    res.send({ rows: await app.api.dispositivo.fila(req.params.id) });
  });

  app.get("/access-devices/:id/errors", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    res.send({ rows: await app.api.dispositivo.erros(req.params.id) });
  });

  app.get("/access-devices/:id/events", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    res.send({ rows: await app.api.dispositivo.eventos(req.params.id) });
  });

  // Ligar um número do aparelho a uma pessoa — e trazer junto o que ficou para
  // trás: as pendências daquele número viram frequência retroativa.
  app.post("/access-devices/:id/link", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const { usuarioNoAparelho, pessoa } = req.body || {};
    const ok = await app.api.dispositivo.vincular(req.params.id, usuarioNoAparelho, pessoa);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidField") });

    const recuperadas = await app.api.dispositivo.aproveitarPendencias(
      req.params.id,
      usuarioNoAparelho,
      pessoa
    );

    res.send({ msg: req.t("ok.accessDeviceLinked"), recuperadas });
  });

  // ── A CATRACA, VIRADA DA FICHA ───────────────────────────────────────────
  //
  // *"me lembro que pedi, para ser um dialog para também cadastrar as fotos
  // que vão ser cadastradas na catraca"* (10/10/2026).
  //
  // Esta rota mora AQUI, e não no `Student.js`, porque o que ela faz é quase
  // todo da porta: a chave na ficha é uma linha, e as outras trinta são
  // aparelho, foto, regra e o que fazer quando um dos dois não existe.
  //
  // ── POR QUE NÃO BASTAVA O `PUT /people/:id` ──────────────────────────────
  //
  // Porque ele responde "salvei" e nada mais. Liberar alguém na porta pode
  // esbarrar em quatro coisas — ficha sem foto, foto em webp, foto grande
  // demais, aparelho sem a regra lida — e todas são resolvíveis por quem está
  // na tela, se souber qual é. Um "salvo" verde por cima disso é a pessoa indo
  // embora achando que o aluno entra amanhã.
  //
  // O `PUT` continua existindo e continua sincronizando (o formulário também
  // tem a chave), só que lá o resultado vai para o log; aqui ele vai para a
  // tela.
  // A SITUAÇÃO desta pessoa em cada leitor — lida antes de decidir.
  //
  // `people.edit` e não `people.gate`: ver em que pé está não é um poder, é o
  // mesmo nível de quem abre a ficha. Virar a chave continua pedindo a outra.
  app.get("/people/:id/gate", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.edit");
    if (trainer === false) return;

    const alvo = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    res.send({ aparelhos: await app.api.dispositivo.situacaoNaPorta(req.params.id) });
  });

  app.post("/people/:id/gate", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "people.gate");
    if (trainer === false) return;

    // Pelo VÍNCULO, como o resto da ficha: um profissional não alcança quem
    // não acompanha, nem mandando o id na URL.
    const alvo = await app.api.user.dataStudent(trainer._id, req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    const liberado = Boolean(req.body?.liberado);

    // A CHAVE PRIMEIRO, o aparelho depois. A ficha é a verdade: se o leitor
    // estiver fora do ar, o que vale é o que está escrito aqui, e o aparelho
    // se acerta no próximo "Perguntar ao aparelho". O contrário — gravar só se
    // o aparelho aceitar — deixaria a academia sem conseguir bloquear ninguém
    // num dia de queda de internet, que é justamente quando mais se quer.
    await app.api.user.updateStudent(trainer._id, req.params.id, { passagemLiberada: liberado });

    const aparelhos = await app.api.dispositivo.sincronizarPassagem(req.params.id, liberado);

    app.insertUserActionHistory(req, trainer, liberado ? "gate_release" : "gate_block", {
      category: "people",
      local: { target_type: "users", target_id: String(req.params.id) },
      extra: { aparelhos: aparelhos.length },
    });

    res.send({ liberado, aparelhos });
  });
};
