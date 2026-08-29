const test = require("node:test");
const assert = require("node:assert");

const lados = require("../../lib/assessmentPhotoSides.js");

// OS ÂNGULOS DA FOTO DE EVOLUÇÃO.
//
// A regra que estes testes protegem é uma só: a CHAVE é para sempre. Ela vai na
// URL da rota e nomeia o campo dentro do documento da coleta, então uma chave
// que mudasse ao renomear o ângulo desligaria as fotos já enviadas do lugar
// delas — sem erro, sem aviso, só uma vaga vazia onde havia dois anos de foto.

test("quem nunca configurou recebe os quatro de fábrica", () => {
  assert.deepEqual(
    lados.daInstancia(undefined).map((l) => l.key),
    ["front", "right", "left", "back"]
  );
  assert.deepEqual(lados.daInstancia(null).map((l) => l.key), lados.PADRAO);
  // Rótulo VAZIO nos quatro: é o que os mantém traduzidos pela interface.
  assert.ok(lados.daInstancia(undefined).every((l) => l.label === ""));
});

test("lista vazia gravada é uma escolha, não uma falta", () => {
  // "Configurou e apagou todos" é a conta que não usa foto. Devolver os quatro
  // aqui desfaria a escolha dela toda vez que a tela abrisse.
  assert.deepEqual(lados.daInstancia([]), []);
});

test("a chave nasce do rótulo, sem acento e sem espaço", () => {
  assert.equal(lados.chaveDe("Duplo bíceps"), "duplo-biceps");
  assert.equal(lados.chaveDe("Costas   contraídas"), "costas-contraidas");
  assert.equal(lados.chaveDe("Lado 45°"), "lado-45");
});

test("a chave nunca carrega o que o Mongo e a rota não aceitam", () => {
  // Ponto e cifrão são proibidos em nome de campo; barra e espaço quebrariam a
  // URL de `/assessments/:id/photos/:side`.
  for (const bruto of ["a.b", "a$b", "a/b", "a b", "../etc", "A B C"]) {
    const chave = lados.chaveDe(bruto);
    assert.ok(/^[a-z0-9-]*$/.test(chave), `${bruto} → ${chave}`);
  }
});

test("renomear NÃO troca a chave — é o que preserva as fotos já enviadas", () => {
  const salvo = lados.normalizar([
    { key: "front", label: "Frente relaxada" },
    { key: "duplo-biceps", label: "Duplo bíceps frontal" },
  ]);

  assert.deepEqual(salvo, [
    { key: "front", label: "Frente relaxada" },
    { key: "duplo-biceps", label: "Duplo bíceps frontal" },
  ]);
});

test("ângulo novo chega sem chave e ganha uma", () => {
  const salvo = lados.normalizar([{ key: "front" }, { label: "Mais muscular" }]);

  assert.deepEqual(salvo, [
    { key: "front", label: "" },
    { key: "mais-muscular", label: "Mais muscular" },
  ]);
});

test("dois ângulos com o mesmo nome não viram a mesma vaga", () => {
  // Sem isto, a segunda foto sobrescreveria a primeira sem ninguém pedir.
  const salvo = lados.normalizar([{ label: "Lateral" }, { label: "Lateral" }]);
  assert.deepEqual(salvo.map((l) => l.key), ["lateral", "lateral-2"]);
});

test("rótulo sem letra nenhuma ainda vira uma vaga utilizável", () => {
  const salvo = lados.normalizar([{ label: "💪" }]);
  assert.equal(salvo.length, 1);
  assert.ok(lados.chaveValida(salvo[0].key));
  // O rótulo continua sendo o que a pessoa escreveu — quem não presta é a chave.
  assert.equal(salvo[0].label, "💪");
});

test("o teto é doze; o que passa disso é cortado, não recusado", () => {
  const pedidos = Array.from({ length: 20 }, (_, i) => ({ label: "Pose " + (i + 1) }));
  assert.equal(lados.normalizar(pedidos).length, lados.MAXIMO);
});

test("o que não é lista é recusado, e não vira lista vazia", () => {
  // Gravar `[]` por causa de um corpo malformado apagaria os ângulos da conta
  // inteira — e as fotos deixariam de aparecer sem ninguém ter pedido.
  for (const lixo of [undefined, null, "front", 7, {}]) {
    assert.equal(lados.normalizar(lixo), null);
  }
  assert.deepEqual(lados.normalizar([]), []);
});

test("entrada com chave inválida não passa a chave adiante", () => {
  // Uma chave forjada no corpo da requisição é descartada e refeita a partir do
  // rótulo: quem escolhe o formato é o servidor.
  const salvo = lados.normalizar([{ key: "a.b", label: "Frente" }]);
  assert.deepEqual(salvo, [{ key: "frente", label: "Frente" }]);
});

test("o rótulo é aparado, e o comprimento tem teto", () => {
  const salvo = lados.normalizar([{ key: "front", label: "   Frente   relaxada  " }]);
  assert.equal(salvo[0].label, "Frente relaxada");

  const longo = lados.normalizar([{ key: "front", label: "x".repeat(200) }]);
  assert.equal(longo[0].label.length, 40);
});
