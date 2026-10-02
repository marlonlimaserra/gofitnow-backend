const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const Controller = require("../../controllers/Departamento.js");
const Departamento = require("../../model/Departamento_model.js");

// OS DEPARTAMENTOS — Financeiro, Vendas, Suporte.
//
// *"em administração crie 'departamentos'… vamos usar isso em breve no chat"*
// (02/10/2026).
//
// O que estes casos guardam é a decisão que o chat vai depender: quem LÊ não é
// quem ADMINISTRA. Com a leitura presa a `users.manage`, o atendente abriria a
// conversa sem saber a qual fila ela pertence.
function monta({ permissoes = ["people.view", "users.manage"] } = {}) {
  const pedidas = [];
  const gravado = {};

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
    api: {
      departamento: {
        async list(filtros) {
          gravado.listou = filtros;
          return [{ _id: "d1", key: "financeiro", name: "Financeiro", ordem: 10 }];
        },
        async data(id) {
          return String(id) === "sumiu" ? undefined : { _id: String(id), name: "Financeiro" };
        },
        async insert(obj) {
          gravado.criou = obj;
          return obj.__erro ? { erro: obj.__erro } : { id: "d1" };
        },
        async update() {
          return { id: "d1" };
        },
        async remove(id) {
          return String(id) !== "sumiu";
        },
        async reordenar(ids) {
          gravado.ordem = ids;
          return Array.isArray(ids) && ids.length ? { ok: true } : { ok: false };
        },
      },
    },
  });

  Controller(app);
  return { app, pedidas, gravado };
}

test("LER pede `people.view` — quem atende chat não administra a conta", async () => {
  const { app, pedidas } = monta();
  await call(app, "get", "/departments");
  assert.deepEqual(pedidas, ["people.view"]);
});

test("ESCREVER pede `users.manage`", async () => {
  const { app, pedidas } = monta();
  await call(app, "post", "/departments", { body: { name: "Vendas" } });
  assert.deepEqual(pedidas, ["users.manage"]);
});

test("quem só lê não cria", async () => {
  const { app } = monta({ permissoes: ["people.view"] });
  const r = await call(app, "post", "/departments", { body: { name: "Vendas" } });
  assert.equal(r.status, 403);
});

test("`ativos=1` é o que o chat vai pedir", async () => {
  // Desligado não some do cadastro — as conversas antigas continuam apontando
  // para ele —, mas para de ser oferecido.
  const { app, gravado } = monta();
  await call(app, "get", "/departments", { query: { ativos: "1" } });
  assert.deepEqual(gravado.listou, { ativos: true });
});

test("nome repetido é 409 — o pedido está certo, o mundo é que já tem", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/departments", { body: { name: "x", __erro: "em_uso" } });

  assert.equal(r.status, 409);
  assert.ok(!String(r.body.msg).startsWith("errors."));
});

test("`/ordem` não é tratado como um id de departamento", async () => {
  // O Express casa na ordem de registro. Já me pegou nas gavetas de campos.
  const { app, gravado } = monta();
  const r = await call(app, "put", "/departments/ordem", { body: { ids: ["d2", "d1"] } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.ordem, ["d2", "d1"]);
});

test("apagar o que não existe é 404", async () => {
  const { app } = monta();
  const r = await call(app, "delete", "/departments/sumiu");
  assert.equal(r.status, 404);
});

// ── A CHAVE E A COR ──────────────────────────────────────────────────────
test("a chave sai do nome, sem acento e sem espaço", () => {
  // É ela que a conversa vai carimbar, e é ela que faz um departamento apagado
  // por engano voltar recriando com o mesmo nome.
  assert.equal(Departamento.chaveDe("Financeiro"), "financeiro");
  assert.equal(Departamento.chaveDe("Pós-venda"), "pos_venda");
});

test("a cor segue a regra das gavetas: hex, e lixo cai no padrão", () => {
  assert.equal(Departamento.corValida("#ABC"), "#aabbcc");
  assert.equal(Departamento.corValida("roxo"), Departamento.COR_PADRAO);
});

// ── OS MEMBROS ───────────────────────────────────────────────────────────
//
// *"faltou poder escolher quais usuários do sistema fazem parte desse
// departamento"* (02/10/2026). É a peça que faltava para o chat rotear: sem
// gente, o departamento é só um rótulo.
test("id inválido e repetido não entram na lista de membros", () => {
  const r = Departamento.membrosValidos([
    "64b000000000000000000001",
    "lixo",
    "64b000000000000000000001",
    null,
  ]);

  assert.deepEqual(r.map(String), ["64b000000000000000000001"]);
});

test("a lista tem teto — cem é sanidade, não regra de negócio", () => {
  // Um departamento com cem atendentes não foi escolhido a dedo; é alguém
  // mandando o banco inteiro num pedido feito à mão.
  const muitos = Array.from({ length: 150 }, (_, i) =>
    "64b0000000000000000000" + String(i).padStart(2, "0")
  );

  assert.ok(Departamento.membrosValidos(muitos).length <= 100);
});

test("o que não é lista vira lista vazia", () => {
  for (const v of [undefined, null, "u1", 7, {}]) {
    assert.deepEqual(Departamento.membrosValidos(v), []);
  }
});

// ── EDITAR PELO LADO DO USUÁRIO ──────────────────────────────────────────
//
// *"coloque para poder escolher os departamentos aqui também"* (02/10/2026),
// no cadastro do usuário.
//
// A tentação é guardar `departamentos` no documento do usuário. Isso cria DUAS
// verdades sobre a mesma relação, e elas divergem no primeiro lugar que
// escrever só uma. O armazenamento continua um só.
test("marcar pelo usuário ENTRA nos escolhidos e SAI dos outros", async () => {
  const feitos = [];

  const app = {
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async updateMany(filtro, mudanca) {
              feitos.push({ filtro, mudanca });
            },
          }),
        };
      },
    },
  };

  const modelo = new Departamento(app);
  const r = await modelo.definirDoUsuario("64b0000000000000000000ff", ["64b000000000000000000001"]);

  assert.equal(r.ok, true);
  assert.equal(feitos.length, 2, "faltou um dos dois passos");

  // O primeiro acrescenta nos marcados…
  assert.ok(feitos[0].mudanca.$addToSet.membros);
  // …e o segundo tira de todos os outros. Sem ele, desmarcar não desmarcaria
  // nada — só marcar funcionaria, e a lista cresceria para sempre.
  assert.ok(feitos[1].mudanca.$pull.membros);
  assert.ok(feitos[1].filtro._id.$nin);
});

test("desmarcar tudo ainda limpa", async () => {
  const feitos = [];
  const app = {
    mongodb: {
      async connectToServer() {
        return { collection: () => ({ async updateMany(f, m) { feitos.push({ f, m }); } }) };
      },
    },
  };

  await new Departamento(app).definirDoUsuario("64b0000000000000000000ff", []);

  // Só o `$pull`: não há a quem acrescentar, mas há de quem tirar.
  assert.equal(feitos.length, 1);
  assert.ok(feitos[0].m.$pull.membros);
});
