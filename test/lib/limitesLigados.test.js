const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ESTE ARQUIVO EXISTE PORQUE O DEFEITO FOI EXATAMENTE ESTE.
//
// O painel guardava seis limites por plano e a tela os mostrava. Nenhuma rota os
// consultava — só `brandImages`. Ninguém percebeu por meses: o campo existia, o
// número aparecia, e nada acontecia.
//
// Um teste que só exercitasse `limiteDoPlano` não teria pego isso: a função
// sempre funcionou. O que faltava era CHAMÁ-LA. Então o que se confere aqui é o
// código, e não o comportamento.
const CONTROLLERS = path.join(__dirname, "..", "..", "controllers");

const fonte = fs
  .readdirSync(CONTROLLERS)
  .filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(CONTROLLERS, f), "utf8"))
  .join("\n");

// Todo limite do catálogo do painel, e onde ele é aplicado.
//
// `brandImages` está de fora porque ele é o único com regra própria: ele não cai
// num teto vindo do plano, ele cai num PADRÃO do produto (24) quando o plano não
// diz nada. Ver controllers/Brand.js.
const APLICADOS = [
  "people",
  "professionals",
  "workouts",
  "workoutTemplates",
  "diets",
  "dietTemplates",
  "apiKeys",
  "assessments",
  "schedule",
  "supplements",
  "prescriptions",
  "anamnesis",
  "exams",
  // Os AULÕES (16/09/2026). Entra nesta lista porque a lista é o CONTRATO: ela
  // é o que faz um limite novo no painel, que ninguém ligou no código, quebrar
  // aqui em vez de virar enfeite na tela de planos.
  "aulaoes",
  // UNIDADES e PLANOS DA CASA (18/09/2026). Os dois entram pelo mesmo motivo
  // dos aulões — a lista é o CONTRATO —, e com uma razão a mais: eles são os
  // dois únicos limites que protegem uma página NOSSA. A unidade entra no mapa
  // de parceiros do site da VAFIT; o plano, na vitrine que a gente hospeda.
  //
  // Um teto que o painel vende e ninguém confere, aqui, não seria só um limite
  // furado: seria o nosso site virando quadro de avisos de quem cadastrar mais
  // rápido.
  "units",
  "memberships",
  // A grade de aulas coletivas (18/09/2026).
  "groupClasses",
];

test("todo limite do plano é APLICADO em alguma rota", () => {
  const semGuarda = APLICADOS.filter(
    (chave) => !fonte.includes(`limiteDoPlano.barrou(app, req, res, "${chave}"`)
  );

  assert.deepEqual(
    semGuarda,
    [],
    "limite que o painel vende e nenhuma rota confere — foi assim que 628 treinos entraram num plano de 1"
  );
});

// As duas de SIM/NÃO. Elas não têm teto para contar — a pergunta é "pode?" —,
// então passam por `barrouChave` e não por `barrou`.
const CHAVES = ["appearance", "whitelabel"];

test("as chaves de sim/não também são aplicadas", () => {
  const semGuarda = CHAVES.filter(
    (chave) => !fonte.includes(`limiteDoPlano.barrouChave(app, req, res, "${chave}")`)
  );

  assert.deepEqual(semGuarda, [], "chave que o painel vende e nenhuma rota confere");
});

test("a aparência é trancada em CADA porta dela", () => {
  // São duas: salvar o tema e subir imagem da marca. Trancar só uma deixaria a
  // outra aberta — e a que ficasse aberta seria a que ninguém testa.
  const tenant = fs.readFileSync(path.join(CONTROLLERS, "Tenant.js"), "utf8");
  const brand = fs.readFileSync(path.join(CONTROLLERS, "Brand.js"), "utf8");

  assert.ok(tenant.includes('barrouChave(app, req, res, "appearance")'), "o tema ficou sem tranca");
  assert.ok(brand.includes('barrouChave(app, req, res, "appearance")'), "a imagem ficou sem tranca");
});

test("quem confere o teto RETORNA — não segue criando", () => {
  // `await barrou(...)` sem o `return` responderia 409 e criaria o registro
  // assim mesmo: dois `send` na mesma resposta, e o limite virando enfeite de
  // novo. É um erro de uma palavra, invisível na revisão.
  const chamadas = fonte.match(/limiteDoPlano\.barrou(?:Chave)?\([^\n]*/g) || [];

  assert.ok(chamadas.length >= APLICADOS.length + CHAVES.length, "faltou rota guardada");

  const semReturn = chamadas.filter((linha) => !linha.includes("return"));
  assert.deepEqual(semReturn, [], "chamada a barrou() sem `return`");
});
