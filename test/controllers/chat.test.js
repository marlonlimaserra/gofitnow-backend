const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const ChatController = require("../../controllers/Chat.js");
const Chat_model = require("../../model/Chat_model.js");

const EU = { _id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "Marlon" };
const OUTRO = { _id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "Ana" };
const ESTRANHO = { _id: "aaaaaaaaaaaaaaaaaaaaaaa9", name: "De fora" };

// O chat tem uma regra que não pode falhar em silêncio: PERMISSÃO não é
// PARTICIPAÇÃO.
//
// Ter "chat.view" deixa a conta usar o chat. Não deixa ela ler a conversa dos
// outros. Sem o segundo degrau, trocar o id na URL abriria a conversa de
// qualquer dupla do cliente — e nada na tela denunciaria isso.
function monta({ conversa, membro = true, arquivo } = {}) {
  const chamadas = { enviadas: [], lidas: [] };
  const permissao = permiteTudo(EU);

  const doc = conversa || {
    _id: "c1",
    members: membro ? [EU._id, OUTRO._id] : [OUTRO._id, ESTRANHO._id],
    lastMessage: "oi",
    lastFrom: OUTRO._id,
    lastAt: new Date("2026-08-13T12:00:00Z"),
    unread: { [EU._id]: 3 },
  };

  const chat = {
    async data() {
      return doc;
    },
    // As duas de verdade: é nelas que mora a regra de participação.
    isMember: Chat_model.prototype.isMember,
    otherOf: Chat_model.prototype.otherOf,
    async listOf() {
      return [doc];
    },
    async countOf() {
      return 1;
    },
    async unreadTotal() {
      return 3;
    },
    async messagesOf() {
      return [{ _id: "m1", body: "oi", from: OUTRO._id }];
    },
    async openWith(a, b) {
      return { ...doc, members: [String(a), String(b)].sort() };
    },
    parseAttachment: Chat_model.prototype.parseAttachment,
    async send(id, from, body, anexo) {
      if (!String(body || "").trim() && !anexo) return undefined;
      chamadas.enviadas.push({ id, from: String(from), body, anexo });
      return { _id: "m2", body };
    },
    async fileOf() {
      return arquivo;
    },
    async markRead(id, userId) {
      chamadas.lidas.push({ id, userId: String(userId) });
      return true;
    },
  };

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      chat,
      user: {
        async data(id) {
          return String(id) === OUTRO._id ? OUTRO : undefined;
        },
        async briefByIds() {
          return { [OUTRO._id]: { name: OUTRO.name, avatarAt: null } };
        },
      },
    },
  });

  ChatController(app);
  return { app, chamadas, permissao };
}

test("a lista traz o outro participante, o resumo e o não lido", async () => {
  const { app } = monta();
  const res = await call(app, "get", "/chat/conversations");

  assert.equal(res.status, 200);
  assert.equal(res.body.rows[0].person.name, "Ana");
  assert.equal(res.body.rows[0].unread, 3);
  assert.equal(res.body.unread, 3);
});

test("`lastFromMe` diz de que lado está a bola", async () => {
  // A lista mostra "Você: …" quando a última foi minha. Sem isso, não dá para
  // saber de relance quem está esperando resposta.
  const { app } = monta();
  const minha = await call(app, "get", "/chat/conversations");
  assert.equal(minha.body.rows[0].lastFromMe, false);

  const { app: app2 } = monta({
    conversa: { _id: "c1", members: [EU._id, OUTRO._id], lastFrom: EU._id, unread: {} },
  });
  const outra = await call(app2, "get", "/chat/conversations");
  assert.equal(outra.body.rows[0].lastFromMe, true);
});

test("conversa de que não participo é 404, mesmo com permissão total", async () => {
  // O teste central deste arquivo. `permiteTudo` libera toda permissão — e
  // ainda assim a rota tem de recusar, porque a conta não é dali.
  const { app } = monta({ membro: false });

  for (const [metodo, caminho] of [
    ["get", "/chat/conversations/c1/messages"],
    ["post", "/chat/conversations/c1/read"],
  ]) {
    const res = await call(app, metodo, caminho);
    assert.equal(res.status, 404, `${metodo} ${caminho}`);
  }

  const enviar = await call(app, "post", "/chat/conversations/c1/messages", {
    body: { body: "oi" },
  });
  assert.equal(enviar.status, 404);
});

test("não participando, nada é enviado nem marcado como lido", async () => {
  // O 404 sozinho não bastaria: se a rota respondesse 404 DEPOIS de gravar, a
  // mensagem estaria na conversa de estranhos.
  const { app, chamadas } = monta({ membro: false });

  await call(app, "post", "/chat/conversations/c1/messages", { body: { body: "oi" } });
  await call(app, "post", "/chat/conversations/c1/read");

  assert.deepEqual(chamadas.enviadas, []);
  assert.deepEqual(chamadas.lidas, []);
});

test("mensagem vazia é recusada", async () => {
  const { app } = monta();

  const res = await call(app, "post", "/chat/conversations/c1/messages", {
    body: { body: "   " },
  });

  assert.equal(res.status, 400);
});

test("mensagem não entra no histórico de ações", async () => {
  // Mensagem é conteúdo, não administração. Uma conversa de trinta linhas
  // viraria trinta entradas e afogaria tudo o mais que a conta fez no dia.
  const { app } = monta();

  await call(app, "post", "/chat/conversations/c1/messages", { body: { body: "oi" } });

  assert.deepEqual(app.registrados, []);
});

test("conversa consigo mesmo é recusada", async () => {
  // Os dois membros seriam o mesmo id, e "o outro" não existiria — o contador
  // de não lido não teria para quem subir.
  const { app } = monta();

  const res = await call(app, "post", "/chat/conversations", { body: { personId: EU._id } });

  assert.equal(res.status, 400);
});

test("abrir conversa com quem não existe é 404", async () => {
  const { app } = monta();

  const res = await call(app, "post", "/chat/conversations", {
    body: { personId: ESTRANHO._id },
  });

  assert.equal(res.status, 404);
});

test("ler zera o não lido de QUEM leu", async () => {
  const { app, chamadas } = monta();

  await call(app, "post", "/chat/conversations/c1/read");

  assert.deepEqual(chamadas.lidas, [{ id: "c1", userId: EU._id }]);
});

// ── Anexos ────────────────────────────────────────────────────────────────
//
// Duas coisas importam aqui, e as duas quebram em silêncio: QUAIS tipos passam,
// e COMO o arquivo é servido. Servir arquivo de terceiro da nossa origem é o
// caminho mais curto para transformar uma conversa em vetor de ataque.
const base64 = (texto) => Buffer.from(texto).toString("base64");

test("imagem, áudio e PDF passam", async () => {
  const { app, chamadas } = monta();

  for (const mime of ["image/png", "audio/webm", "application/pdf"]) {
    const res = await call(app, "post", "/chat/conversations/c1/messages", {
      body: { file: { dataUri: `data:${mime};base64,${base64("x")}`, name: "a" } },
    });
    assert.equal(res.status, 201, mime);
  }

  assert.equal(chamadas.enviadas.length, 3);
});

test("SVG e HTML são recusados", async () => {
  // SVG é documento executável, não imagem; HTML é página. Qualquer um dos dois
  // servido da nossa origem roda script nela.
  const { app, chamadas } = monta();

  for (const mime of ["image/svg+xml", "text/html", "application/javascript"]) {
    const res = await call(app, "post", "/chat/conversations/c1/messages", {
      body: { file: { dataUri: `data:${mime};base64,${base64("x")}`, name: "a" } },
    });
    assert.equal(res.status, 400, mime);
  }

  assert.deepEqual(chamadas.enviadas, []);
});

test("o mime com parâmetro do gravador de áudio é aceito", async () => {
  // O MediaRecorder do navegador produz `audio/webm;codecs=opus`. Uma leitura
  // que não descartasse o parâmetro recusaria todo áudio gravado na tela.
  const { app } = monta();

  const res = await call(app, "post", "/chat/conversations/c1/messages", {
    body: { file: { dataUri: `data:audio/webm;codecs=opus;base64,${base64("x")}`, name: "r" } },
  });

  assert.equal(res.status, 201);
});

test("anexo sem texto vale como mensagem", async () => {
  // Mandar só uma foto é o caso comum. Exigir legenda seria inventar uma regra.
  const { app } = monta();

  const res = await call(app, "post", "/chat/conversations/c1/messages", {
    body: { file: { dataUri: `data:image/png;base64,${base64("x")}`, name: "f.png" } },
  });

  assert.equal(res.status, 201);
});

test("caminho no nome do arquivo é descartado", async () => {
  const { app, chamadas } = monta();

  await call(app, "post", "/chat/conversations/c1/messages", {
    body: { file: { dataUri: `data:image/png;base64,${base64("x")}`, name: "../../etc/passwd" } },
  });

  assert.equal(chamadas.enviadas[0].anexo.ficha.name, "passwd");
});

test("imagem abre embutida; o resto BAIXA", async () => {
  // A diferença que impede um arquivo de terceiro de virar página na nossa
  // origem. `nosniff` fecha a outra metade: sem ele o navegador adivinha o tipo
  // pelo conteúdo e ignora o que declaramos.
  const imagem = monta({
    arquivo: { conversation: "c1", mime: "image/png", name: "f.png", data: Buffer.from("x") },
  });
  const img = await call(imagem.app, "get", "/chat/messages/m1/file");

  assert.match(img.headers["content-disposition"], /^inline/);
  assert.equal(img.headers["x-content-type-options"], "nosniff");

  const doc = monta({
    arquivo: { conversation: "c1", mime: "application/pdf", name: "e.pdf", data: Buffer.from("x") },
  });
  const pdf = await call(doc.app, "get", "/chat/messages/m1/file");

  assert.match(pdf.headers["content-disposition"], /^attachment/);
});

test("o anexo de uma conversa alheia não é servido", async () => {
  // Ter o id da mensagem não basta: a regra de participação vale para o arquivo
  // como vale para o texto.
  const { app } = monta({
    membro: false,
    arquivo: { conversation: "c1", mime: "image/png", name: "f.png", data: Buffer.from("x") },
  });

  const res = await call(app, "get", "/chat/messages/m1/file");
  assert.equal(res.status, 404);
});

test("enviar exige chat.send; ler exige chat.view", async () => {
  // As duas existem separadas para o caso de uma conta que acompanha o
  // atendimento sem responder por ele. Se as rotas pedissem a mesma, a
  // distinção estaria na tela de permissões sem filtrar nada.
  const { app, permissao } = monta();

  await call(app, "get", "/chat/conversations");
  await call(app, "post", "/chat/conversations/c1/messages", { body: { body: "oi" } });

  assert.deepEqual(permissao.pedidas, ["chat.view", "chat.send"]);
});
