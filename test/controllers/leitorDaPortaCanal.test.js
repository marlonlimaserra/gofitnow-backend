const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const ControlIdController = require("../../controllers/ControlId.js");

// O SEGREDO DO PUSH NUNCA ANDA EM TEXTO PURO.
//
// Desde 09/10/2026 o canal de monitor do leitor da porta chega pela porta 80,
// sem TLS. Não foi escolha: o firmware do iDFace recebe hostname + porta +
// caminho, sem esquema, e manda HTTP cru — apontado para a 443, o nginx
// respondia 400 e NENHUMA passagem de aluno virava check-in.
//
// O que torna isso aceitável é a separação que estes casos prendem. São duas
// credenciais, e elas não valem o mesmo:
//
//   MONITOR  só sabe CONTAR o que já aconteceu. É a que anda exposta.
//   PUSH     RECEBE comandos — e, com o cadastro remoto, FOTO de rosto.
//
// Se um dia alguém "simplificar" isto de volta para uma credencial só, ou
// apagar o `X-Forwarded-Proto` do bloco /cid/ no nginx, são estes testes que
// quebram. Eles são o que impede a porta 80 de virar um vazamento.

const CRED_PUSH = "marlon.segredodopushlongo";
const CRED_MONITOR = "marlon.segredodomonitorlongo";

const APARELHO = { _id: "d1", deviceId: "", instance: "marlon" };

function monta() {
  const eventos = [];

  const app = fakeApp({
    api: {
      center: {
        async isActive() {
          return true;
        },
      },
      dispositivo: {
        async porSegredo(segredo) {
          // O de verdade marca `canal` com QUAL das duas casou; aqui o espelho
          // é literal, para o caso exercitar o controller e não o modelo.
          if (segredo === "segredodopushlongo") return { ...APARELHO, canal: "push" };
          if (segredo === "segredodomonitorlongo") return { ...APARELHO, canal: "monitor" };
          return null;
        },
        tocar() {},
        registrarEvento(id, tipo) {
          eventos.push(tipo);
        },
        async proximoComando() {
          return null;
        },
        async guardarResultado() {},
        async registrarPassagem() {
          return null;
        },
      },
    },
  });

  ControlIdController(app);
  return { app, eventos };
}

const emTextoPuro = { headers: { "x-forwarded-proto": "http" } };
const comTls = { headers: { "x-forwarded-proto": "https" } };

test("o monitor fala em texto puro — é para isto que a porta 80 existe", async () => {
  const { app } = monta();
  const r = await call(app, "post", `/cid/${CRED_MONITOR}/device_is_alive`, {
    ...emTextoPuro,
    body: { device_id: "4409419584553886" },
  });

  assert.equal(r.status, 200);
});

test("a credencial do MONITOR não abre o push, nem com TLS", async () => {
  // Esta é a metade que importa. Quem escuta o fio da academia pega a chave do
  // monitor; se ela servisse para o push, pegaria junto a fila de comandos —
  // e, do cadastro remoto em diante, a foto do rosto de quem está entrando.
  const { app } = monta();

  const puro = await call(app, "get", `/cid/${CRED_MONITOR}/push`, emTextoPuro);
  const seguro = await call(app, "get", `/cid/${CRED_MONITOR}/push`, comTls);

  assert.equal(puro.status, 401);
  assert.equal(seguro.status, 401);
});

test("a credencial do MONITOR não reporta resultado de comando", async () => {
  // `/result` é a outra metade do canal de push: é por ela que o aparelho diz
  // como foi o comando. Aceitar a chave exposta aqui deixaria alguém fingir
  // que um comando nosso funcionou.
  const { app } = monta();
  const r = await call(app, "post", `/cid/${CRED_MONITOR}/result`, comTls);

  assert.equal(r.status, 401);
});

test("a credencial do PUSH é recusada em texto puro, em QUALQUER rota", async () => {
  // Se ela aparecer na porta 80 é porque está mal configurada. O certo é não
  // atender — atender "só desta vez" é publicar o segredo e seguir em frente.
  const { app } = monta();

  const push = await call(app, "get", `/cid/${CRED_PUSH}/push`, emTextoPuro);
  const monitor = await call(app, "post", `/cid/${CRED_PUSH}/device_is_alive`, emTextoPuro);

  assert.equal(push.status, 401);
  assert.equal(monitor.status, 401);
});

test("a credencial do PUSH funciona com TLS, nos dois canais", async () => {
  // O monitor com a chave do push é permitido DE PROPÓSITO: um aparelho
  // configurado antes de o monitor ganhar credencial própria continua falando
  // pela 443, como sempre falou. O caso acima garante que ele nunca cairá na 80.
  const { app } = monta();

  const push = await call(app, "get", `/cid/${CRED_PUSH}/push`, comTls);
  const monitor = await call(app, "post", `/cid/${CRED_PUSH}/device_is_alive`, comTls);

  assert.equal(push.status, 200);
  assert.equal(monitor.status, 200);
});

test("sem o cabeçalho de protocolo, assume-se TLS", async () => {
  // Em desenvolvimento se bate direto no 127.0.0.1:3030, sem nginx na frente.
  // Presumir "texto puro" ali trancaria o push de quem está desenvolvendo; o
  // que protege em produção é o nginx SEMPRE mandar o cabeçalho — e o bloco
  // /cid/ da porta 80 manda `http`, que é o que dispara a recusa.
  const { app } = monta();
  const r = await call(app, "get", `/cid/${CRED_PUSH}/push`);

  assert.equal(r.status, 200);
});

test("o endpoint desconhecido também é só do monitor", async () => {
  // `/secbox` e o que mais o firmware inventar caem na rota curinga. Ela
  // responde 200 para o aparelho parar de repetir — e justamente por ser
  // curinga não pode ser uma porta dos fundos para a chave exposta.
  const { app, eventos } = monta();
  const r = await call(app, "post", `/cid/${CRED_MONITOR}/secbox`, emTextoPuro);

  assert.equal(r.status, 200);
  assert.ok(eventos.includes("secbox"));
});
