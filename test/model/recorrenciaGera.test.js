const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Recurrence_model = require("../../model/Recurrence_model.js");

// A GERAÇÃO DA MENSALIDADE.
//
// Ela roda na LEITURA de duas telas — a aba da pessoa e o Financeiro geral —,
// então ela roda MUITO. O que estes casos seguram é que rodar muito não produz
// nada de novo, e que nada do que pode dar errado numa regra mal cadastrada
// derruba a tela que mostra o dinheiro.
const HOJE = new Date("2026-09-17T12:00:00.000Z");

const ALUNO = new ObjectId("6a7f8e18ac5f3b34bb4e4801");
const R1 = new ObjectId("6a7f8e18ac5f3b34bb4e4901");

const REGRA = {
  _id: R1,
  student: ALUNO,
  amount: 80000,
  currency: "BRL",
  cadencia: "monthly",
  startsAt: new Date("2026-07-05T00:00:00.000Z"),
  endsAt: null,
  active: true,
  description: "Mensalidade",
};

// Um dobro da collection de cobranças que GUARDA o que foi inserido — é o que
// permite afirmar o que nasceu, e não só quantas.
function montar(regras, jaGeradas = [], aoInserir = null) {
  const inseridas = [];
  const model = new Recurrence_model({
    api: {
      finance: {
        async charges() {
          return {
            find: () => ({ toArray: async () => jaGeradas }),
            async insertOne(doc) {
              if (aoInserir) await aoInserir(doc);
              inseridas.push(doc);
              return { insertedId: new ObjectId() };
            },
          };
        },
      },
    },
  });

  model.collection = async () => ({
    find: () => ({ toArray: async () => regras }),
  });

  return { model, inseridas };
}

test("a primeira passada cria o que está vencido e o que vence na janela", async () => {
  const { model, inseridas } = montar([REGRA]);

  const criadas = await model.gerar({ hoje: HOJE });

  assert.equal(criadas, 3);
  assert.deepEqual(inseridas.map((c) => c.periodo), ["2026-07-05", "2026-08-05", "2026-09-05"]);
  // Cada uma carrega o VÍNCULO e a ETIQUETA — é o par que o índice único
  // protege. Sem eles a mensalidade de setembro nasceria de novo a cada
  // abertura da tela.
  assert.equal(String(inseridas[0].recurrence), String(R1));
  assert.equal(inseridas[0].amount, 80000);
  assert.equal(inseridas[0].status, "open");
  assert.equal(inseridas[0].description, "Mensalidade");
});

test("a segunda passada não cria nada — e é isso que permite gerar na leitura", async () => {
  const jaGeradas = ["2026-07-05", "2026-08-05", "2026-09-05"].map((periodo) => ({
    recurrence: R1,
    periodo,
  }));

  const { model, inseridas } = montar([REGRA], jaGeradas);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("o índice único ganhando a corrida não é erro — é o desenho funcionando", async () => {
  // Duas abas abertas leem "não existe" juntas e inserem juntas. A segunda bate
  // no índice, e a geração tem de seguir em frente: um 11000 propagado aqui
  // derrubaria a abertura do financeiro inteiro.
  const duplicada = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  let vez = 0;

  const { model, inseridas } = montar([REGRA], [], () => {
    vez++;
    if (vez === 2) throw duplicada;
  });

  const criadas = await model.gerar({ hoje: HOJE });

  assert.equal(criadas, 2, "a que colidiu não conta");
  assert.equal(inseridas.length, 2);
});

test("erro que NÃO é colisão não passa como sucesso", async () => {
  // Banco fora do ar precisa virar log e zero, não uma contagem inventada.
  const { model } = montar([REGRA], [], () => {
    throw new Error("sem conexão");
  });

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
});

test("regra inativa não gera — desativar é o jeito de parar sem apagar o passado", async () => {
  // O filtro é do banco (`{ active: true }`), então o dobro devolve a lista já
  // filtrada; o que este caso prende é que a rota pede o filtro.
  const { model, inseridas } = montar([]);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("valor zero não vira uma cobrança de R$ 0,00 por mês, para sempre", async () => {
  const { model, inseridas } = montar([{ ...REGRA, amount: 0 }]);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("regra sem data de início não gera cobrança de 1970", async () => {
  // `new Date(null)` é a época, e não data inválida. Antes da guarda em
  // `lib/recorrencia.js`, isto despejava 24 mensalidades datadas de 1970.
  const { model, inseridas } = montar([{ ...REGRA, startsAt: null }]);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("a data de FIM para a série", async () => {
  const { model, inseridas } = montar([{ ...REGRA, endsAt: new Date("2026-08-31T00:00:00.000Z") }]);

  await model.gerar({ hoje: HOJE });
  assert.deepEqual(inseridas.map((c) => c.periodo), ["2026-07-05", "2026-08-05"]);
});

test("aluno inválido devolve zero em vez de varrer a conta inteira", async () => {
  const { model, inseridas } = montar([REGRA]);

  assert.equal(await model.gerar({ student: "não é id", hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("duas regras da mesma pessoa não se confundem", async () => {
  // A mensalidade e a anuidade convivem: *"todo mês eu pago 800 reais pra minha
  // personal. Mas na academia eu pago anual"*. O conjunto de "já gerados" é POR
  // REGRA — compartilhá-lo faria uma calar a outra.
  const R2 = new ObjectId("6a7f8e18ac5f3b34bb4e4902");
  const anual = {
    ...REGRA,
    _id: R2,
    amount: 120000,
    cadencia: "annual",
    startsAt: new Date("2026-09-05T00:00:00.000Z"),
    description: "Anuidade",
  };

  const { model, inseridas } = montar(
    [REGRA, anual],
    // A mensalidade de setembro já existe; a anuidade tem a MESMA etiqueta e
    // ainda não existe.
    [{ recurrence: R1, periodo: "2026-09-05" }]
  );

  await model.gerar({ hoje: HOJE });

  assert.deepEqual(
    inseridas.map((c) => `${c.description} ${c.periodo}`),
    ["Mensalidade 2026-07-05", "Mensalidade 2026-08-05", "Anuidade 2026-09-05"]
  );
});
