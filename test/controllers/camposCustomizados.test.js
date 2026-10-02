const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const CustomFieldController = require("../../controllers/CustomField.js");
const CustomField_model = require("../../model/CustomField_model.js");
const tipos = require("../../lib/tiposDeCampo.js");

// OS CAMPOS CUSTOMIZADOS — as perguntas que a casa inventa.
//
// *"na parte de configuração do sistema, crie 'Campos customizados'"*
// (01/10/2026).
//
// O que estes casos guardam são as três decisões que não se vê na tela: quem
// LÊ não é quem ADMINISTRA, o alias é a chave e não pode colidir, e um seletor
// sem opção é uma caixa que não abre.
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
      customField: {
        async list(filtros) {
          gravado.listou = filtros;
          return [{ _id: "c1", name: "Convênio", alias: "convenio", tipo: "seletor" }];
        },
        async resumo() {
          return { total: 1, obrigatorios: 0, noCadastro: 1, unicos: 0 };
        },
        async data(id) {
          return String(id) === "sumiu" ? undefined : { _id: String(id), name: "Convênio" };
        },
        async insert(obj) {
          gravado.criou = obj;
          return obj.__erro ? { erro: obj.__erro } : { id: "c1" };
        },
        async update(id, obj) {
          gravado.mudou = { id: String(id), obj };
          return String(id) === "sumiu" ? { erro: "nao_encontrado" } : { id: String(id) };
        },
        async remove(id) {
          return String(id) !== "sumiu";
        },
      },
    },
  });

  CustomFieldController(app);
  return { app, pedidas, gravado };
}

test("LER pede `people.view` — quem abre ficha não administra a conta", () => {
  // A ficha precisa saber quais campos existem. Exigir `users.manage` para ler
  // deixaria o professor com uma ficha sem metade das perguntas.
  const { app, pedidas } = monta();
  return call(app, "get", "/custom-fields").then(() => {
    assert.deepEqual(pedidas, ["people.view"]);
  });
});

test("ESCREVER pede `users.manage` — mexer aqui muda a ficha de todo mundo", async () => {
  const { app, pedidas } = monta();
  await call(app, "post", "/custom-fields", { body: { name: "Convênio" } });
  assert.deepEqual(pedidas, ["users.manage"]);
});

test("quem só lê não cria", async () => {
  const { app } = monta({ permissoes: ["people.view"] });
  const r = await call(app, "post", "/custom-fields", { body: { name: "x" } });
  assert.equal(r.status, 403);
});

test("a lista traz o catálogo de tipos e o resumo do topo", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/custom-fields");

  // Um tipo novo entra no ar sem tocar no frontend.
  assert.equal(r.body.tipos.length, tipos.IDS.length);
  // Os números do topo contam o CATÁLOGO, não a página.
  assert.deepEqual(r.body.resumo, { total: 1, obrigatorios: 0, noCadastro: 1, unicos: 0 });
});

test("`ativos=1` é o que a ficha pede — campo desativado para de ser perguntado", async () => {
  const { app, gravado } = monta();
  await call(app, "get", "/custom-fields", { query: { ativos: "1" } });
  assert.deepEqual(gravado.listou, { ativos: true });
});

test("alias em uso é 409, e não 400 — o pedido está certo, o mundo é que já tem", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/custom-fields", { body: { name: "x", __erro: "alias_em_uso" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "alias_em_uso");
});

test("cada recusa tem a sua frase, e nenhuma sai como chave crua", async () => {
  for (const [erro, status] of [
    ["sem_nome", 400],
    ["sem_alias", 400],
    ["alias_reservado", 400],
    ["sem_opcoes", 400],
  ]) {
    const { app } = monta();
    const r = await call(app, "post", "/custom-fields", { body: { name: "x", __erro: erro } });

    assert.equal(r.status, status, erro);
    assert.ok(r.body.msg, erro + " sem mensagem");
    assert.ok(!String(r.body.msg).startsWith("errors."), erro + " saiu como chave crua");
  }
});

test("apagar o que não existe é 404", async () => {
  const { app } = monta();
  const r = await call(app, "delete", "/custom-fields/sumiu");
  assert.equal(r.status, 404);
});

// ── O ALIAS ──────────────────────────────────────────────────────────────
test("o alias sai do nome: sem acento, sem espaço, sem maiúscula", () => {
  // Ele vira chave de objeto no banco e nome de coluna numa planilha, e os dois
  // castigam acento.
  assert.equal(CustomField_model.aliasDe("Convênio"), "convenio");
  assert.equal(CustomField_model.aliasDe("  Tamanho da camiseta "), "tamanho_da_camiseta");
});

test("alias nunca começa com número", () => {
  // Legal no Mongo, ilegal em quase todo lugar que consome a exportação.
  assert.equal(CustomField_model.aliasDe("3x na semana"), "campo_3x_na_semana");
});

test("nome só de símbolo não gera alias — e a gravação recusa", () => {
  assert.equal(CustomField_model.aliasDe("@@@"), "");
});

test("os aliases do produto são reservados", () => {
  // Um campo "Nome" geraria `name`, e a planilha sairia com duas colunas iguais.
  for (const k of ["name", "email", "phone", "weight"]) {
    assert.ok(CustomField_model.RESERVADOS.includes(k), k + " ficou de fora");
  }
});

// ── OS CAMPOS NATIVOS ────────────────────────────────────────────────────
//
// *"coloca esses 3 como customizado padrão já"* (01/10/2026), apontando para
// Objetivo, Peso e Altura.
//
// Eles já existem no documento da pessoa e meio produto os lê — o peso e a
// altura entram no IMC e na avaliação. Então eles entram no catálogo como
// NATIVOS: a casa manda na pergunta, e o valor fica onde está.
const CustomFieldModel = require("../../model/CustomField_model.js");

test("os três campos da ficha são os nativos semeados", () => {
  assert.deepEqual(
    CustomFieldModel.NATIVOS.map((n) => n.alias),
    ["goal", "weight", "height"]
  );
});

test("peso e altura são NÚMERO — senão não somam nem comparam", () => {
  const porAlias = Object.fromEntries(CustomFieldModel.NATIVOS.map((n) => [n.alias, n]));

  assert.equal(porAlias.weight.tipo, "numero");
  assert.equal(porAlias.height.tipo, "numero");
  assert.equal(porAlias.goal.tipo, "texto");
});

test("nativo nasce sem nome: o rótulo sai da tradução de quem abre", () => {
  // Gravar "Objetivo" em português numa conta em inglês seria errar o idioma de
  // quem nunca pediu nada.
  for (const n of CustomFieldModel.NATIVOS) {
    assert.ok(n.rotuloPadrao.startsWith("customFields.native."), n.alias);
    assert.equal(n.name, undefined);
  }
});

test("apagar um nativo é recusado com a saída certa: desligue", async () => {
  const { app } = monta();
  // O dublê devolve "nativo", que é o que o modelo responde para um campo do
  // sistema.
  app.api.customField.remove = async () => "nativo";

  const r = await call(app, "delete", "/custom-fields/c1");

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "nativo");
  assert.ok(!String(r.body.msg).startsWith("errors."));
});
