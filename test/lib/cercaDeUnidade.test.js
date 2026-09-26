const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const lente = require("../../lib/lenteDeUnidade.js");

// A UNIDADE VIROU CERCA.
//
// *"ok, faça isso"* (26/09/2026), depois de eu mostrar o buraco: a recepcionista
// atribuída a Niterói via só Niterói NA TELA — porque a tela pedia assim —, e
// via a casa inteira em qualquer pedido que não mandasse o filtro. Um `curl`
// com a sessão dela, uma chave de API, ou um app que simplesmente não mande o
// parâmetro.
//
// ── O QUE ESTES CASOS SEGURAM ────────────────────────────────────────────
//
// O buraco não era um `if` errado: era a AUSÊNCIA de decisão no servidor. Então
// o que se testa aqui é a decisão, nos quatro estados em que ela acontece — e
// em especial nos dois que passavam batido: pedir uma unidade alheia, e não
// pedir nada.
const NITEROI = "6512f1c0c0c0c0c0c0c0c0a1";
const PARATY = "6512f1c0c0c0c0c0c0c0c0a2";

test("quem alcança TODAS continua como antes — a lente é dele", () => {
  // `units` vazio é o estado de toda conta que existe hoje. Mudar isso seria
  // acordar o sistema inteiro sem ver ninguém.
  const r = lente.recorte({ units: [] }, PARATY);

  assert.equal(r.unit, PARATY);
  assert.equal(r.units, null);
});

test("quem é restrito e escolhe uma das DELE filtra por ela", () => {
  const r = lente.recorte({ units: [NITEROI, PARATY] }, PARATY);

  assert.equal(r.unit, PARATY);
  assert.equal(r.units, null);
});

test("pedir unidade ALHEIA não vale — e devolve as dele", () => {
  // Este é o furo, e ele não dá 403 de propósito: um seletor com um id velho,
  // ou um link mandado por quem alcança mais, não é ataque. Uma tela de erro no
  // lugar da lista seria pior que a lista certa.
  const r = lente.recorte({ units: [NITEROI] }, PARATY);

  assert.equal(r.unit, "");
  assert.deepEqual(r.units, [NITEROI]);
});

test("NÃO pedir nada também não abre a casa — e era esse o buraco", () => {
  // O `curl` sem `?unit=`, a chave de API, o app que não manda o parâmetro.
  const r = lente.recorte({ units: [NITEROI] }, "");

  assert.equal(r.unit, "");
  assert.deepEqual(r.units, [NITEROI]);
});

test("id inválido na lista do usuário é ignorado, não vira consulta torta", () => {
  const r = lente.recorte({ units: ["lixo", NITEROI] }, "");

  assert.deepEqual(r.units, [NITEROI]);
});

test("usuário sem `units` nenhum (campo ausente) alcança tudo", () => {
  assert.deepEqual(lente.recorte({}, ""), { unit: "", units: null });
  assert.deepEqual(lente.recorte(undefined, ""), { unit: "", units: null });
});

test("o filtro inclui o que NÃO tem unidade — é da casa, não de outra unidade", () => {
  // A conta de luz do escritório, o faxineiro que atende as duas. Esconder isso
  // de quem está restrito faria a tela parecer quebrada, e não protegeria nada.
  const f = lente.filtroDeUnidades([NITEROI]);

  assert.equal(f.$or.length, 2);
  assert.deepEqual(f.$or[0].unit.$in.map(String), [NITEROI]);
  assert.deepEqual(f.$or[1], { unit: null });
  assert.ok(f.$or[0].unit.$in[0] instanceof ObjectId, "vai como ObjectId, não texto");
});

test("sem cerca não há filtro — e não um filtro que casa com nada", () => {
  // O erro espelhado: devolver `{ unit: { $in: [] } }` esvaziaria a tela de
  // todo mundo que alcança tudo.
  assert.equal(lente.filtroDeUnidades([]), null);
  assert.equal(lente.filtroDeUnidades(null), null);
  assert.equal(lente.filtroDeUnidades(undefined), null);
});
