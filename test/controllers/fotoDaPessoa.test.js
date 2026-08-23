const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const AvatarController = require("../../controllers/Avatar.js");

// A FOTO DE QUEM É ACOMPANHADO, enviada pelo profissional.
//
// A regra que vale o arquivo é o ALCANCE: o alvo é resolvido pelo vínculo
// (`dataStudent`), então o id na URL não leva ninguém à ficha de outro
// profissional. O resto — recorte, tamanho — acontece no navegador.
const TRAINER = { _id: "t1", name: "Marlon", type: "trainer" };
const PESSOA = { _id: "p1", name: "Ana" };

const IMAGEM = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

function monta({ alvo = PESSOA } = {}) {
  const chamadas = { save: [], delete: [] };
  const permissao = permiteTudo(TRAINER);

  const app = fakeApp({
    helpers: permissao.helpers,
    api: {
      user: {
        // `null` = não é pessoa deste profissional. É o que o teste do 404 usa.
        async dataStudent() {
          return alvo;
        },
      },
      avatar: {
        parseDataUri(uri) {
          if (!uri || !String(uri).startsWith("data:image/")) return undefined;
          return { mime: "image/jpeg", buffer: Buffer.from("abc") };
        },
        async save(userId, mime, buffer) {
          chamadas.save.push({ userId: String(userId), mime, bytes: buffer.length });
          return new Date("2026-08-23T00:00:00.000Z");
        },
        async delete(userId) {
          chamadas.delete.push(String(userId));
          return true;
        },
        async data() {
          return undefined;
        },
      },
    },
  });

  AvatarController(app);
  return { app, chamadas, permissao };
}

const enviar = (app, body) =>
  call(app, "post", "/people/p1/avatar", { body, params: { id: "p1" } });

const apagar = (app) => call(app, "delete", "/people/p1/avatar", { params: { id: "p1" } });

test("o profissional envia a foto de quem ele acompanha", async () => {
  const { app, chamadas } = monta();
  const r = await enviar(app, { image: IMAGEM });

  assert.equal(r.status, 200);
  assert.equal(chamadas.save.length, 1);
  assert.equal(chamadas.save[0].userId, "p1", "a foto é gravada na PESSOA, não em quem enviou");
});

test("é `people.edit` que autoriza — foto é dado de cadastro, não permissão nova", async () => {
  const { app, permissao } = monta();
  await enviar(app, { image: IMAGEM });

  assert.ok(permissao.pedidas.includes("people.edit"));
});

test("pessoa que não é minha dá 404, e nada é gravado", async () => {
  // `dataStudent` resolve pelo VÍNCULO: mandar o id de quem é de outro
  // profissional não alcança a ficha dele.
  const { app, chamadas } = monta({ alvo: null });
  const r = await enviar(app, { image: IMAGEM });

  assert.equal(r.status, 404);
  assert.equal(chamadas.save.length, 0);
});

test("corpo sem imagem de verdade é recusado antes de gravar", async () => {
  const { app, chamadas } = monta();
  const r = await enviar(app, { image: "isto não é uma imagem" });

  assert.equal(r.status, 400);
  assert.equal(chamadas.save.length, 0);
});

test("apagar remove a foto DA PESSOA e registra na ficha dela", async () => {
  const { app, chamadas } = monta();
  const r = await apagar(app);

  assert.equal(r.status, 200);
  assert.deepEqual(chamadas.delete, ["p1"]);

  const registro = app.registrados.find((x) => x.action === "delete_person_avatar");
  assert.ok(registro, "a ação tem de ir para a auditoria");
  assert.equal(registro.data.local.target_type, "people");
  assert.equal(registro.data.local.target_id, "p1");
});

test("apagar a foto de quem não é meu também dá 404", async () => {
  const { app, chamadas } = monta({ alvo: null });
  const r = await apagar(app);

  assert.equal(r.status, 404);
  assert.equal(chamadas.delete.length, 0);
});
