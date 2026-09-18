const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const cep = require(path.join(__dirname, "..", "..", "lib", "cep.js"));
const geo = require(path.join(__dirname, "..", "..", "lib", "geocodificar.js"));

// O CEP E O PONTO NO MAPA.
//
// *"peça o cep primeiro e preencha o resto"* e *"tem como abrir o google maps,
// ou algum mapa, para a pessoa colocar o ponto certinho?"*.
//
// A regra que atravessa os dois: eles são ATALHOS, nunca cercas. Terceiro fora
// do ar, CEP de outro país, endereço que o mapa não conhece — nada disso pode
// impedir alguém de cadastrar uma unidade. O pior caso é preencher à mão.

const resposta = (corpo, ok = true) => ({ ok, async json() { return corpo; } });

test("o CEP aceita com e sem traço, e só oito dígitos", () => {
  assert.ok(cep.valido("01310-100"));
  assert.ok(cep.valido("01310100"));
  assert.equal(cep.limpar(" 01310-100 "), "01310100");

  for (const ruim of ["123", "", null, "abcdefgh", "013101001"]) {
    assert.equal(cep.valido(ruim), false, String(ruim));
  }
});

test("acha, e devolve só o que a tela preenche", async () => {
  const achado = await cep.buscar("01310-100", async () =>
    resposta({
      cep: "01310-100",
      logradouro: "Avenida Paulista",
      bairro: "Bela Vista",
      localidade: "São Paulo",
      uf: "sp",
      // Campos do ViaCEP que não nos interessam.
      ibge: "3550308",
      ddd: "11",
    })
  );

  assert.deepEqual(achado, {
    cep: "01310100",
    logradouro: "Avenida Paulista",
    bairro: "Bela Vista",
    cidade: "São Paulo",
    uf: "SP",
  });
  assert.ok(!("ibge" in achado), "não repassa o que a tela não usa");
});

test("CEP inexistente é RESPOSTA, não erro", async () => {
  // O ViaCEP devolve 200 com `{ erro: true }`. Tratar isso como falha faria a
  // tela mostrar "algo deu errado" para um CEP que só não existe.
  const achado = await cep.buscar("99999999", async () => resposta({ erro: true }));

  assert.equal(achado, undefined);
});

test("o terceiro fora do ar não derruba nada", async () => {
  const achado = await cep.buscar("01310101", async () => {
    throw new Error("rede");
  });

  assert.equal(achado, undefined);
});

test("o mesmo CEP não é consultado duas vezes", async () => {
  // Um CEP não muda. A mesma pessoa corrigindo o número três vezes é uma
  // consulta só.
  let chamadas = 0;
  const buscador = async () => {
    chamadas += 1;
    return resposta({ logradouro: "Rua X", localidade: "Niterói", uf: "RJ" });
  };

  await cep.buscar("24000000", buscador);
  await cep.buscar("24000-000", buscador);

  assert.equal(chamadas, 1);
});

test("o endereço de uma linha não deixa pontuação sobrando", () => {
  // É o que separa "Rua X — Niterói" de "Rua X, , — , /" numa unidade meio
  // preenchida — e uma unidade meio preenchida é o caso normal.
  assert.equal(
    cep.umaLinha({
      logradouro: "Av. Paulista",
      numero: "1000",
      complemento: "sala 42",
      bairro: "Bela Vista",
      cidade: "São Paulo",
      uf: "SP",
    }),
    "Av. Paulista, 1000 — sala 42 — Bela Vista, São Paulo/SP"
  );

  assert.equal(cep.umaLinha({ logradouro: "Rua X", cidade: "Niterói" }), "Rua X — Niterói");
  assert.equal(cep.umaLinha({ cidade: "Recife", uf: "PE" }), "Recife/PE");
  assert.equal(cep.umaLinha({}), "");
});

test("o mapa identifica quem chama — é o que a política do Nominatim pede", async () => {
  let cabecalhos = null;
  await geo.porEndereco("Avenida Paulista 1000 São Paulo", async (url, opcoes) => {
    cabecalhos = opcoes.headers;
    return resposta([{ lat: "-23.56", lon: "-46.65" }]);
  });

  assert.match(cabecalhos["User-Agent"], /VAFIT/);
});

test("devolve o ponto como NÚMERO — coordenada é para calcular", async () => {
  const ponto = await geo.porEndereco("Rua da Praia 100 Porto Alegre", async () =>
    resposta([{ lat: "-30.03", lon: "-51.23" }])
  );

  assert.deepEqual(ponto, { lat: -30.03, lng: -51.23 });
});

test("endereço que o mapa não conhece é `undefined`, e o alfinete fica onde está", async () => {
  const ponto = await geo.porEndereco("Rua que não existe 999 Nárnia", async () => resposta([]));

  assert.equal(ponto, undefined);
});

test("consulta curta demais nem sai — seria um pedido para adivinhar", async () => {
  let foi = false;
  await geo.porEndereco("SP", async () => {
    foi = true;
    return resposta([]);
  });

  assert.equal(foi, false);
});

test("a fila sobrevive a uma falha", async () => {
  // Sem o `catch` que a segura, um erro deixaria toda consulta seguinte
  // rejeitada para sempre — e o mapa pararia de funcionar até o próximo
  // deploy, sem ninguém entender por quê.
  await geo.porEndereco("Rua Um 1 Cidade Um", async () => {
    throw new Error("nominatim fora");
  });

  const depois = await geo.porEndereco("Rua Dois 2 Cidade Dois", async () =>
    resposta([{ lat: "-1.5", lon: "-2.5" }])
  );

  assert.deepEqual(depois, { lat: -1.5, lng: -2.5 });
});
