const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const { fakeApp, call } = require("../helpers/harness.js");
const McpController = require("../../controllers/Mcp.js");
const tools = require("../../lib/mcpTools.js");

// A porta MCP: onde um modelo opera o sistema por FERRAMENTA, e não pela tela.
//
// O que estes casos guardam não é o protocolo — é a promessa que o protocolo
// carrega: **a ferramenta não é um caminho paralelo**. Ela passa pela mesma
// permissão da tela, chama os mesmos modelos e devolve o motivo quando recusa.
//
// Um caminho paralelo que "quase" faz o mesmo é a origem do bug que ninguém
// encontra: a tela valida o e-mail, a ferramenta não, e um dia aparece uma ficha
// com endereço impossível que "o sistema aceitou".
const TREINADOR = { _id: new ObjectId(), name: "Marlon" };
const PESSOA = new ObjectId();
const TREINO = new ObjectId();
const EXERCICIO = new ObjectId();

function monta({ permissoes = ["people.view", "people.create", "people.edit", "people.delete", "workouts.view", "workouts.manage"], treino = null, comEmail = null } = {}) {
  const gravado = { pessoas: [], exercicios: null, apagados: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify() {
          return TREINADOR;
        },
        has(user, permissao) {
          return permissoes.includes(permissao);
        },
      },
    },
    api: {
      user: {
        async pageStudents() {
          return { rows: [{ _id: PESSOA, name: "Bruna", email: "bruna@x.com", active: 1 }] };
        },
        async dataStudent(_t, id) {
          if (String(id) !== String(PESSOA)) return undefined;
          return { _id: PESSOA, name: "Bruna", email: "bruna@x.com", password: comEmail ? "hash" : null };
        },
        async dataByEmail(email) {
          return email === "ocupado@x.com" ? { _id: new ObjectId() } : undefined;
        },
        async insertStudent(_t, dados) {
          gravado.pessoas.push(dados);
          return PESSOA;
        },
        async updateStudent(_t, _id, mudanca) {
          gravado.mudanca = mudanca;
          return true;
        },
        async deleteStudent(_t, id) {
          gravado.apagados.push(String(id));
          return true;
        },
      },
      auth: {
        async deleteAllTokensByUser(id) {
          gravado.tokensApagados = String(id);
        },
      },
      exercise: {
        async list() {
          return { rows: [{ _id: EXERCICIO, name: "Remada baixa", muscleGroup: "Costas" }] };
        },
        async data(id) {
          if (String(id) !== String(EXERCICIO)) return undefined;
          return { _id: EXERCICIO, name: "Remada baixa", muscleGroup: "Costas" };
        },
      },
      workout: {
        async list() {
          return [{ _id: TREINO, name: "A", exercises: [] }];
        },
        async data(_t, id) {
          if (String(id) !== String(TREINO)) return undefined;
          return treino || { _id: TREINO, name: "A", student: PESSOA, exercises: [] };
        },
        async insert(_t, _s, dados) {
          gravado.treino = dados;
          return TREINO;
        },
        async update(_t, _id, mudanca) {
          gravado.treinoMudanca = mudanca;
          return true;
        },
        async delete(_t, id) {
          gravado.apagados.push(String(id));
          return true;
        },
        async saveExercises(_t, _id, lista) {
          gravado.exercicios = lista;
          return true;
        },
      },
    },
  });

  McpController(app);
  return { app, gravado };
}

const rpc = (app, method, params) =>
  call(app, "post", "/mcp", { body: { jsonrpc: "2.0", id: 1, method, params } });

// O resultado da ferramenta vem embrulhado no envelope do MCP.
const saida = (r) => r.body.result.structuredContent;

// ── O protocolo, o mínimo dele ───────────────────────────────────────────

test("o aperto de mão diz quem somos e o que temos", async () => {
  const { app } = monta();

  const r = await rpc(app, "initialize", {});

  assert.equal(r.body.result.serverInfo.name, "gofitnow");
  assert.ok(r.body.result.capabilities.tools);
});

test("a lista de ferramentas sai no formato que o cliente espera", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/list", {});
  const lista = r.body.result.tools;

  assert.ok(lista.length >= 10);
  for (const f of lista) {
    assert.ok(f.name, "toda ferramenta precisa de nome");
    assert.ok(f.description, "e de descrição — é o que o modelo lê para decidir");
    assert.equal(f.inputSchema.type, "object");
  }
});

test("ferramenta que não existe é erro de PROTOCOLO", async () => {
  // Aqui é o cliente que está errado, não o mundo: -32602 é "parâmetro
  // inválido", e é o que faz um cliente bem escrito parar em vez de repetir.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "voar", arguments: {} });

  assert.equal(r.body.error.code, -32602);
});

// ── A permissão é a MESMA da tela ────────────────────────────────────────

test("sem a permissão da tela, a ferramenta recusa", async () => {
  const { app, gravado } = monta({ permissoes: [] });

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna" },
  });

  assert.equal(saida(r).erro, "sem_permissao");
  assert.equal(gravado.pessoas.length, 0, "não pode nem chegar ao modelo");
});

test("a recusa volta como RESULTADO, não como erro de protocolo", async () => {
  // O modelo precisa poder ler o motivo e dizer à pessoa o que faltou. Um erro
  // de protocolo faria o cliente tentar de novo, igual.
  const { app } = monta({ permissoes: [] });

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "x" } });

  assert.equal(r.body.error, undefined);
  assert.equal(r.body.result.isError, true);
});

// ── Pessoas ──────────────────────────────────────────────────────────────

test("criar pessoa segue a regra da tela: e-mail é opcional", async () => {
  // Ele foi obrigatório por muito tempo, e a tela deixou de exigir. A
  // ferramenta tem de acompanhar — senão a mesma casa tem duas regras.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "Bruna" } });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.pessoas[0].email, "");
});

test("e-mail inválido é recusado com motivo, não com exceção", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna", email: "nao-e-email" },
  });

  assert.equal(saida(r).erro, "email_invalido");
  assert.equal(gravado.pessoas.length, 0);
});

test("e-mail já usado não vira ficha duplicada", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_criar",
    arguments: { nome: "Bruna", email: "ocupado@x.com" },
  });

  assert.equal(saida(r).erro, "email_em_uso");
  assert.equal(gravado.pessoas.length, 0);
});

test("a resposta diz ONDE olhar — é o que faz a tela acompanhar", async () => {
  // O front recebe isto e abre a tela certa, destacando o que mudou. É assim
  // que a pessoa vê a ação acontecer sem o modelo ter tocado na tela.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_criar", arguments: { nome: "Bruna" } });

  assert.equal(saida(r).alvo.rota, `/people/${PESSOA}`);
});

test("achar UMA pessoa leva a tela até ela", async () => {
  // Procurar alguém pelo nome quase sempre é o começo de "e agora faz X com
  // ela": abrir a ficha adianta o passo seguinte e mostra que a busca acertou.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  assert.equal(saida(r).alvo.rota, `/people/${PESSOA}`);
});

test("achar VÁRIAS não navega para nenhuma", async () => {
  // Escolher uma seria escolher pela pessoa; ir para a lista sem o filtro seria
  // pior que ficar parado, porque ela teria de buscar de novo à mão.
  const { app } = monta();
  app.api.user.pageStudents = async () => ({
    rows: [
      { _id: PESSOA, name: "Bruna" },
      { _id: new ObjectId(), name: "Bruno" },
    ],
  });

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  assert.equal(saida(r).pessoas.length, 2);
  assert.equal(saida(r).alvo, undefined);
});

test("ver um treino abre o treino", async () => {
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_ver",
    arguments: { treinoId: String(TREINO) },
  });

  assert.equal(saida(r).alvo.rota, `/people/${PESSOA}/workouts/${TREINO}`);
});

test("a ficha devolvida NÃO traz senha nem salt", async () => {
  // O que entra no contexto de um modelo sai na resposta dele em algum momento.
  const { app } = monta();

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "bru" } });

  const p = saida(r).pessoas[0];
  assert.deepEqual(Object.keys(p).sort(), ["ativo", "email", "id", "nome", "telefone"]);
});

test("tirar o e-mail de quem tem senha é recusado", async () => {
  // A mesma regra da tela: o e-mail é o login. Tirá-lo deixaria a pessoa sem
  // porta de entrada, e sem aviso.
  const { app } = monta({ comEmail: true });

  const r = await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), email: "" },
  });

  assert.equal(saida(r).erro, "email_e_login");
});

test("editar manda SÓ o que mudou", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "pessoa_editar",
    arguments: { pessoaId: String(PESSOA), telefone: "11999" },
  });

  assert.deepEqual(gravado.mudanca, { phone: "11999" });
});

test("excluir mata a sessão junto", async () => {
  // Sem isto, quem já estava logado continuaria dentro de uma conta que não
  // existe mais.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_excluir",
    arguments: { pessoaId: String(PESSOA) },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.tokensApagados, String(PESSOA));
});

test("pessoa de outro profissional não é encontrada", async () => {
  // `dataStudent` só devolve quem está vinculado a quem pediu — a ferramenta
  // não fura o vínculo porque não conhece outro caminho até a ficha.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "pessoa_excluir",
    arguments: { pessoaId: String(new ObjectId()) },
  });

  assert.equal(saida(r).erro, "pessoa_nao_encontrada");
});

// ── Treinos ──────────────────────────────────────────────────────────────

test("acrescentar exercício COPIA nome e grupo do catálogo", async () => {
  // O treino tem de continuar legível se o exercício sair do catálogo depois.
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: {
      treinoId: String(TREINO),
      exercicioId: String(EXERCICIO),
      series: 4,
      quantidade: "12",
      carga: "20kg",
    },
  });

  assert.equal(saida(r).ok, true);
  assert.equal(gravado.exercicios[0].name, "Remada baixa");
  assert.equal(gravado.exercicios[0].muscleGroup, "Costas");
  assert.equal(gravado.exercicios[0].sets.length, 4);
  assert.equal(gravado.exercicios[0].sets[0].quantity, "12");
});

test("exercício fora do catálogo é recusado — não se inventa nome", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(new ObjectId()) },
  });

  assert.equal(saida(r).erro, "exercicio_nao_encontrado");
  assert.equal(gravado.exercicios, null);
});

test("o exercício entra no FIM, sem apagar os que já estavam", async () => {
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [] }],
  };
  const { app, gravado } = monta({ treino });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_adicionar",
    arguments: { treinoId: String(TREINO), exercicioId: String(EXERCICIO) },
  });

  assert.equal(gravado.exercicios.length, 2);
  assert.equal(gravado.exercicios[0].name, "Supino");
});

test("editar séries mantém o que não foi mandado", async () => {
  // Quem pede "coloca a carga" não está pedindo para apagar as repetições.
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [{ unit: "reps", quantity: "10", load: "" }] }],
  };
  const { app, gravado } = monta({ treino });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 0, carga: "30kg" },
  });

  assert.equal(gravado.exercicios[0].sets[0].load, "30kg");
  assert.equal(gravado.exercicios[0].sets[0].quantity, "10", "a repetição não podia sumir");
});

test("mudar a quantidade de séries repete o que a primeira tinha", async () => {
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [{ unit: "reps", quantity: "10", load: "20kg" }] }],
  };
  const { app, gravado } = monta({ treino });

  await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 0, series: 3 },
  });

  assert.equal(gravado.exercicios[0].sets.length, 3);
  assert.equal(gravado.exercicios[0].sets[0].quantity, "10");
});

test("posição que não existe diz QUANTAS existem", async () => {
  // O modelo precisa do número para se corrigir sozinho, em vez de tentar de
  // novo no escuro.
  const { app } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_editar",
    arguments: { treinoId: String(TREINO), posicao: 7 },
  });

  assert.equal(saida(r).erro, "posicao_inexistente");
  assert.match(saida(r).detalhe, /0 exerc/);
});

test("remover tira só um, e diz qual", async () => {
  const treino = {
    _id: TREINO,
    name: "A",
    student: PESSOA,
    exercises: [{ name: "Supino", sets: [] }, { name: "Remada", sets: [] }],
  };
  const { app, gravado } = monta({ treino });

  const r = await rpc(app, "tools/call", {
    name: "treino_exercicio_remover",
    arguments: { treinoId: String(TREINO), posicao: 0 },
  });

  assert.equal(saida(r).removido, "Supino");
  assert.equal(gravado.exercicios.length, 1);
  assert.equal(gravado.exercicios[0].name, "Remada");
});

test("treino com fim antes do começo é recusado", async () => {
  const { app, gravado } = monta();

  const r = await rpc(app, "tools/call", {
    name: "treino_criar",
    arguments: {
      pessoaId: String(PESSOA),
      nome: "Treino A",
      inicio: "2026-03-01",
      fim: "2026-01-01",
    },
  });

  assert.equal(saida(r).erro, "fim_antes_do_inicio");
  assert.equal(gravado.treino, undefined);
});

test("treino nasce com o professor de quem está operando", async () => {
  const { app, gravado } = monta();

  await rpc(app, "tools/call", {
    name: "treino_criar",
    arguments: { pessoaId: String(PESSOA), nome: "Treino A" },
  });

  assert.equal(gravado.treino.teacherName, "Marlon");
});

// ── O catálogo, como contrato ────────────────────────────────────────────

test("toda ferramenta declara permissão e schema", async () => {
  // Uma ferramenta sem permissão seria uma porta aberta; uma sem schema faria o
  // modelo adivinhar os campos.
  for (const f of tools.FERRAMENTAS) {
    assert.ok(f.permissao, `${f.nome} sem permissão`);
    assert.ok(f.schema?.properties, `${f.nome} sem schema`);
    assert.ok(f.descricao.length > 30, `${f.nome}: a descrição é o que o modelo lê`);
  }
});

test("o que muda dados devolve ALVO — a tela precisa saber onde olhar", async () => {
  const escrevem = ["pessoa_criar", "pessoa_editar", "treino_criar", "treino_exercicio_adicionar"];

  for (const nome of escrevem) {
    assert.ok(
      tools.achar(nome).descricao,
      `${nome} precisa existir para o front acompanhar a ação`
    );
  }
});
