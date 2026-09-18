// OS CONTADORES DE CADA CONTA — o número que se fala ao telefone.
//
// Pedido do Marlon em 18/09/2026: *"senti falta de um #ID aqui... para quando eu
// perguntar para alguém 'qual a cobrança' ou 'qual fatura'?"*.
//
// ── POR QUE O `_id` DO MONGO NÃO SERVE ───────────────────────────────────
//
// Ele é "6aac6f7fce88864c1d79e021": vinte e quatro caracteres hexadecimais.
// Ninguém dita isso num telefone, ninguém escreve num WhatsApp sem errar, e
// ninguém confere se leu certo. Ele é bom para o que foi feito — ser único no
// mundo sem coordenação — e é péssimo para ser dito em voz alta.
//
// O que se fala é #12, #103. Curto, sequencial e da CONTA — dois clientes
// diferentes podem ter a cobrança #12, e isso não é problema nenhum: ninguém
// nunca compara as duas.
//
// ── ATÔMICO, e é isso que o torna confiável ──────────────────────────────
//
// `findOneAndUpdate` com `$inc` é uma operação só no banco: dois cadastros no
// mesmo instante recebem 12 e 13, nunca 12 e 12. Ler o maior número existente e
// somar um — que é o jeito óbvio — perde essa corrida, e o estrago é duas
// cobranças com o mesmo número, que é exatamente o que este campo existe para
// impedir.
//
// O `instance` entra sozinho no filtro e no documento: ver `lib/escopo.js`. Por
// isso a chave é `chave` e não `_id` — com `_id` fixo, o upsert da segunda conta
// bateria na unicidade do `_id`, que é global.
function Counter_model(app) {
  this.app = app;
}

Counter_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("counters");
};

// O próximo número da sequência. Começa em 1.
Counter_model.prototype.proximo = async function (chave) {
  const col = await this.collection();

  const r = await col.findOneAndUpdate(
    { chave: String(chave) },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  // O driver 6 devolve o documento direto; o 4 devolvia `{ value }`. Aceitar os
  // dois é o que evita um `undefined` silencioso numa atualização de driver —
  // e um número ausente aqui vira cobrança sem número, que ninguém nota até
  // alguém perguntar "qual é a #?".
  const doc = r?.value || r;
  return Number(doc?.seq) || 1;
};

// Garante que a sequência comece DEPOIS do que já existe.
//
// Usado pela migração: as cobranças que nasceram antes deste campo recebem
// número na ordem em que foram criadas, e o contador precisa saber disso —
// senão a próxima cobrança nova recomeçaria do 1 e colidiria com todas.
Counter_model.prototype.peloMenos = async function (chave, valor) {
  if (!Number.isFinite(valor) || valor < 1) return;

  const col = await this.collection();
  await col.updateOne(
    { chave: String(chave), seq: { $lt: valor } },
    { $set: { seq: Math.floor(valor) } },
    { upsert: false }
  );
  // O upsert é separado porque o filtro acima tem `$lt`: com `upsert: true` ele
  // criaria um documento com `seq: {$lt: …}` dentro. Criar só quando não há.
  await col.updateOne(
    { chave: String(chave) },
    { $setOnInsert: { seq: Math.floor(valor) } },
    { upsert: true }
  );
};

module.exports = Counter_model;
