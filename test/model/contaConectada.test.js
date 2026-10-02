const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const ContaConectada = require("../../model/ContaConectada_model.js");

// AS CONTAS DE FORA, no banco do cliente.
//
// Este arquivo nasceu de um defeito que foi para produção: `porId` e `remover`
// chamavam `this.app.ObjectId`, que nunca existiu neste projeto — `ObjectId`
// vem do driver, como nos outros modelos. O sintoma foi *"ao apertar em
// desconectar deu erro interno"*, com um TypeError no log e nada na tela.
//
// Nenhum teste tocava o modelo: os que eu tinha escrito exercitavam o OAuth e
// o webhook. Aqui ficam os dois métodos que pegam id, e o corte do token.

function modelo({ docs = [] } = {}) {
  const chamadas = [];
  const col = {
    find(filtro, opcoes) {
      chamadas.push({ metodo: "find", filtro, opcoes });
      return { sort: () => ({ async toArray() { return docs; } }) };
    },
    async findOne(filtro, opcoes) {
      chamadas.push({ metodo: "findOne", filtro, opcoes });
      return docs[0] || null;
    },
    async updateOne(filtro, mudanca, opcoes) {
      chamadas.push({ metodo: "updateOne", filtro, mudanca, opcoes });
    },
    async deleteOne(filtro) {
      chamadas.push({ metodo: "deleteOne", filtro });
      return { deletedCount: 1 };
    },
  };

  const m = new ContaConectada({
    mongodb: { async connectToServer() { return { collection: () => col }; } },
  });
  return { m, chamadas };
}

const ID = "6ab87796d58878d726fe75fa";

test("porId converte o id da URL — e não estoura procurando ObjectId no app", async () => {
  const { m, chamadas } = modelo({ docs: [{ _id: new ObjectId(ID), tipo: "facebook" }] });

  const doc = await m.porId(ID);

  assert.ok(doc);
  // O erro que foi a produção: `this.app.ObjectId` é `undefined`, e ler
  // `.createFromHexString` dele lança TypeError — 500 na cara de quem clicou.
  assert.ok(chamadas[0].filtro._id instanceof ObjectId);
  assert.equal(String(chamadas[0].filtro._id), ID);
});

test("id torto devolve null, e não uma exceção", async () => {
  const { m, chamadas } = modelo();

  // O id vem da URL: `new ObjectId("abc")` LANÇA, e viraria 500 numa
  // requisição que merece 404.
  assert.equal(await m.porId("abc"), null);
  assert.equal(await m.porId(""), null);
  assert.equal(await m.porId(undefined), null);
  assert.equal(chamadas.length, 0, "nem foi ao banco");
});

test("remover usa o mesmo caminho, e recusa id torto do mesmo jeito", async () => {
  const { m, chamadas } = modelo();

  assert.deepEqual(await m.remover("abc"), { ok: false });
  assert.equal(chamadas.length, 0);

  assert.deepEqual(await m.remover(ID), { ok: true });
  assert.ok(chamadas[0].filtro._id instanceof ObjectId);
});

// ── O TOKEN NUNCA SAI ─────────────────────────────────────────────────────
//
// Ele vale 60 dias (Instagram) ou não expira (Página), e fala pela conta do
// cliente. No navegador estaria ao alcance de qualquer extensão instalada.

test("a lista nem LÊ o token do banco", async () => {
  const { m, chamadas } = modelo({ docs: [] });
  await m.lista("instagram");

  // Projeção, e não "apagar depois": o que não é lido não passeia pela
  // memória de uma rota que não precisa dele.
  assert.equal(chamadas[0].opcoes.projection.token, 0);
  assert.deepEqual(chamadas[0].filtro, { tipo: "instagram" });
});

test("paraTela devolve quem é a conta, nunca o token", () => {
  const { m } = modelo();

  const tela = m.paraTela({
    _id: new ObjectId(ID),
    tipo: "instagram",
    externalId: "17841",
    usuario: "vafit",
    token: "SEGREDO-DE-60-DIAS",
    assinada: true,
  });

  assert.equal(tela.usuario, "vafit");
  assert.equal(tela.assinada, true);
  assert.ok(!("token" in tela));
  assert.ok(!JSON.stringify(tela).includes("SEGREDO"));
});

test("conectar a MESMA conta de novo substitui, não duplica", async () => {
  const { m, chamadas } = modelo();

  await m.guardar({ tipo: "instagram", externalId: "17841", token: "novo" }, { name: "Marlon" });

  const { filtro, opcoes } = chamadas[0];
  // É o caminho comum: o token venceu, a pessoa conecta outra vez. Sem a
  // chave, a lista encheria de linhas iguais e o sistema usaria a mais velha.
  assert.deepEqual(filtro, { tipo: "instagram", externalId: "17841" });
  assert.equal(opcoes.upsert, true);
  assert.equal(chamadas[0].mudanca.$set.conectadaPor, "Marlon");
});

test("`assinada` só é gravada quando o chamador diz algo — Instagram não tem isso", async () => {
  const { m, chamadas } = modelo();

  await m.guardar({ tipo: "instagram", externalId: "1", token: "t" }, null);
  await m.guardar({ tipo: "facebook", externalId: "2", token: "t", assinada: false }, null);

  // `guardar` também RELÊ o documento no fim (para devolver a conta sem o
  // token), então as chamadas se intercalam — filtrar por método é o que
  // mantém este caso legível quando isso mudar de novo.
  const gravacoes = chamadas.filter((c) => c.metodo === "updateOne");

  // Gravar `assinada: false` por omissão faria a tela dizer "conectada, mas
  // não recebe" numa conta de Instagram, onde a ideia nem existe.
  assert.ok(!("assinada" in gravacoes[0].mudanca.$set));
  assert.equal(gravacoes[1].mudanca.$set.assinada, false);
});
