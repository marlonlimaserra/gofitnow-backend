const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ObjectId } = require("mongodb");

const instanceContext = require(path.join(__dirname, "..", "..", "lib", "instance.js"));
const User = require(path.join(__dirname, "..", "..", "model", "User_model.js"));

// A LENTE DA UNIDADE na lista de pessoas.
//
// *"se tiver acesso a mais de uma, aparece um selectzinho ali em cima, para
// poder escolher qual unidade eu quero navegar pelos dados"*.
//
// É uma LENTE, e não uma tranca: a escolha fica visível no alto, e quem não
// está vendo alguém sabe por quê e desfaz num clique.
const UNIDADE = "6a80de570056d24c09f5da61";
const PESSOA = new ObjectId("6a80de570056d24c09f5da62");

function monta() {
  const consultas = [];

  const col = {
    aggregate: (etapas) => {
      consultas.push(etapas);
      return { toArray: async () => [{ rows: [], total: [] }] };
    },
  };

  const model = new User({
    mongodb: { connectToServer: async () => ({ collection: () => col }) },
    api: {
      link: {
        async personIdsOf() {
          return [PESSOA];
        },
      },
      tenant: { async currencyOfInstance() { return {}; } },
    },
  });

  model.fusoDaConta = async () => "America/Sao_Paulo";

  return { model, consultas };
}

const rodar = (filtros) =>
  instanceContext.run("marlon", async () => {
    const { model, consultas } = monta();
    await model.pageStudents(PESSOA, filtros);
    return consultas[0];
  });

// Acha o `$match` que fala de unidade, sem depender da posição dele no
// pipeline — que muda quando os outros filtros entram e saem.
const filtroDeUnidade = (etapas) =>
  etapas.find((e) => JSON.stringify(e.$match || {}).includes("unit"));

test("sem lente, a consulta não menciona unidade nenhuma", async () => {
  // É o estado de quem atende num lugar só, e de toda conta que nunca
  // cadastrou unidade: nada pode mudar para eles.
  const etapas = await rodar({});

  assert.equal(filtroDeUnidade(etapas), undefined);
});

test("com lente, filtra pela unidade escolhida — e SÓ por ela", async () => {
  // A primeira versão deixava quem NÃO TEM unidade aparecer junto, com medo de
  // a lista ficar vazia. O medo era real e o remédio estava errado: com quase
  // ninguém atribuído, escolher "Paraty" continuava mostrando os cem alunos —
  // e uma lente que não muda nada não parece cautelosa, parece quebrada.
  const etapas = await rodar({ unit: UNIDADE });
  const filtro = filtroDeUnidade(etapas);

  assert.ok(filtro, "a consulta não recebeu a lente");
  assert.equal(String(filtro.$match.unit), UNIDADE);
  assert.ok(!filtro.$match.$or, "a lente não pode ter escape");
});

test("lente com id inválido é ignorada — e não vira lista vazia", async () => {
  // Um id sujo na URL não pode esconder todo mundo. Ignorar é o pior caso
  // seguro; filtrar por lixo seria uma tela vazia sem explicação.
  for (const lixo of ["nada", "", "123", null]) {
    const etapas = await rodar({ unit: lixo });
    assert.equal(filtroDeUnidade(etapas), undefined, String(lixo));
  }
});
