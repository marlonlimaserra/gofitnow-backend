const test = require("node:test");
const assert = require("node:assert/strict");

const v = require("../../lib/valoresDeCampos.js");

// O QUE A PESSOA RESPONDEU — a conversão e a conferência.
//
// *"dentro do cliente abria algo parecido com isso com os campos dentro"*
// (01/10/2026).
//
// O navegador manda tudo como texto, e é aqui que texto vira número, data e
// booleano. Cada caso abaixo é um jeito de isso dar errado em silêncio.
const CAMPOS = [
  { alias: "goal", tipo: "texto", nativo: true },
  { alias: "weight", tipo: "numero", nativo: true },
  { alias: "convenio", tipo: "seletor", opcoes: [{ valor: "Unimed" }, { valor: "Particular" }] },
  { alias: "turnos", tipo: "seletorMultiplo", opcoes: [{ valor: "manha" }, { valor: "noite" }] },
  { alias: "aceita", tipo: "simNao" },
  { alias: "retorno", tipo: "data" },
];

test("o nativo vai para a COLUNA dele, o customizado para o objeto", () => {
  // Peso e altura são lidos pelo IMC e pela avaliação: a resposta deles não
  // pode cair dentro de `customFields`.
  const r = v.preparar(CAMPOS, { goal: "emagrecer", weight: "72.5", convenio: "Unimed" });

  assert.deepEqual(r.nativos, { goal: "emagrecer", weight: 72.5 });
  assert.equal(r.valores.convenio, "Unimed");
  assert.equal(r.valores.weight, undefined);
});

test('"false" vira false — senão todo "Não" viraria "Sim"', () => {
  // `"false"` é uma string VERDADEIRA em JavaScript, e é o que o formulário
  // manda.
  assert.equal(v.preparar(CAMPOS, { aceita: "false" }).valores.aceita, false);
  assert.equal(v.preparar(CAMPOS, { aceita: "true" }).valores.aceita, true);
});

test("número vira Number, e vazio vira null — não zero", () => {
  assert.equal(v.preparar(CAMPOS, { weight: "72.5" }).nativos.weight, 72.5);
  assert.equal(v.preparar(CAMPOS, { weight: "" }).nativos.weight, null);
  // "setenta" não é peso nenhum, e gravar NaN quebraria toda soma depois.
  assert.equal(v.preparar(CAMPOS, { weight: "setenta" }).nativos.weight, null);
});

test("data inválida vira null, e não `Invalid Date`", () => {
  assert.equal(v.preparar(CAMPOS, { retorno: "amanhã" }).valores.retorno, null);
  assert.ok(v.preparar(CAMPOS, { retorno: "2026-10-05" }).valores.retorno instanceof Date);
});

test("o seletor só aceita o que ele oferece", () => {
  // Sem isto, um pedido feito à mão grava qualquer coisa num campo que a tela
  // promete ser lista fechada — e o relatório ganha uma fatia órfã.
  assert.equal(v.preparar(CAMPOS, { convenio: "Unimed" }).valores.convenio, "Unimed");
  assert.equal(v.preparar(CAMPOS, { convenio: "Amil" }).valores.convenio, "");
});

test("o seletor múltiplo filtra e não repete", () => {
  const r = v.preparar(CAMPOS, { turnos: ["manha", "tarde", "manha"] });
  assert.deepEqual(r.valores.turnos, ["manha"]);
});

test("obrigatório vazio é cobrado, com o NOME que a pessoa lê", () => {
  const campos = [{ alias: "rg", tipo: "texto", obrigatorio: true, name: "RG" }];
  const r = v.preparar(campos, { rg: "   " });

  assert.deepEqual(r.faltando, [{ alias: "rg", name: "RG" }]);
  assert.equal(r.valores.rg, undefined, "gravou mesmo faltando");
});

test('"não" num Sim/Não obrigatório é uma RESPOSTA, não ausência', () => {
  // `false` e `0` são respostas. Tratá-los como vazio faria o campo obrigatório
  // recusar quem respondeu corretamente que não.
  const campos = [
    { alias: "aceita", tipo: "simNao", obrigatorio: true, name: "Aceita" },
    { alias: "filhos", tipo: "numero", obrigatorio: true, name: "Filhos" },
  ];

  const r = v.preparar(campos, { aceita: "false", filhos: "0" });
  assert.deepEqual(r.faltando, []);
  assert.equal(r.valores.aceita, false);
  assert.equal(r.valores.filhos, 0);
});

test("num PATCH, alias ausente quer dizer 'não mexa'", () => {
  // Sem isto, salvar a gaveta aberta limparia as respostas das fechadas.
  const r = v.preparar(CAMPOS, { convenio: "Unimed" }, { parcial: true });

  assert.deepEqual(Object.keys(r.valores), ["convenio"]);
  assert.deepEqual(r.nativos, {});
});

test("o único é apontado para quem pode perguntar ao banco", () => {
  // A lib não consulta nada: ela diz O QUE conferir, e o controller pergunta.
  const campos = [{ alias: "matricula", tipo: "texto", unico: true, name: "Matrícula" }];
  const r = v.preparar(campos, { matricula: "A-12" });

  assert.equal(r.unicos.length, 1);
  assert.equal(r.unicos[0].valor, "A-12");
});

test("único VAZIO não é conferido — senão dois em branco colidiriam", () => {
  const campos = [{ alias: "matricula", tipo: "texto", unico: true, name: "Matrícula" }];
  assert.deepEqual(v.preparar(campos, { matricula: "" }).unicos, []);
});
