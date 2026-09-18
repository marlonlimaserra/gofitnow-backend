const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const iconeGuardado = require(path.join(__dirname, "..", "..", "lib", "iconeGuardado.js"));
const iconify = require(path.join(__dirname, "..", "..", "lib", "iconify.js"));

// O DESENHO DE UM ÍCONE, guardado junto com o nome.
//
// Nasceu dentro do modelo do benefício e virou biblioteca em 18/09/2026, quando
// o botão de comprar ganhou ícone: *"permita escolher ícone para esse botão"*.
// A regra é a mesma, só mudam os nomes dos campos — e copiá-la criaria duas
// versões da mesma decisão, das quais só uma seria consertada no dia seguinte.
const DO_BOTAO = { nome: "botaoIcone", svg: "botaoIconeSvg", caixa: "botaoIconeCaixa" };

// Troca a busca de verdade, que fala com a Iconify pela rede.
function comBusca(resposta) {
  const original = iconify.buscar;
  iconify.buscar = async () => resposta;
  return () => {
    iconify.buscar = original;
  };
}

test("o nome só passa na forma da Iconify", () => {
  assert.equal(iconeGuardado.nome("MDI:Check-All"), "mdi:check-all");
  assert.equal(iconeGuardado.nome("  mdi:heart "), "mdi:heart");

  for (const ruim of ["", "mdi", "mdi:", "<script>", "mdi:check all", null, undefined]) {
    assert.equal(iconeGuardado.nome(ruim), "", `recusa ${JSON.stringify(ruim)}`);
  }
});

test("escolher um ícone busca o desenho e o guarda", async () => {
  const devolver = comBusca({ body: '<path d="M1 2h3z"/>', caixa: "0 0 32 32" });

  const doc = { botaoIcone: "mdi:cart" };
  await iconeGuardado.aplicar(doc, null, DO_BOTAO);

  assert.equal(doc.botaoIconeSvg, '<path d="M1 2h3z"/>');
  assert.equal(doc.botaoIconeCaixa, "0 0 32 32");
  devolver();
});

test("tirar o ícone apaga o desenho junto", async () => {
  // Senão o cartão continuaria mostrando o de antes, e a pessoa acharia que o
  // "sem ícone" não funcionou.
  const doc = { botaoIcone: "" };
  await iconeGuardado.aplicar(doc, { botaoIcone: "mdi:cart", botaoIconeSvg: "<path/>" }, DO_BOTAO);

  assert.equal(doc.botaoIconeSvg, "");
  assert.equal(doc.botaoIconeCaixa, "");
});

test("mesmo ícone de antes não vai à rede — é quase toda edição", async () => {
  let foi = false;
  const original = iconify.buscar;
  iconify.buscar = async () => {
    foi = true;
    return null;
  };
  const devolver = () => {
    iconify.buscar = original;
  };

  const doc = { botaoIcone: "mdi:cart" };
  await iconeGuardado.aplicar(
    doc,
    { botaoIcone: "mdi:cart", botaoIconeSvg: "<path/>" },
    DO_BOTAO
  );

  assert.equal(foi, false);
  devolver();
});

test("campo AUSENTE é edição que não mencionou o ícone — não se toca nele", async () => {
  // É a mesma regra do `updateCharge`: o que a chamada não menciona, ela não
  // altera. Apagar aqui tiraria o ícone de quem só mudou o preço.
  const doc = { botaoTexto: "Matricule-se" };
  await iconeGuardado.aplicar(doc, { botaoIcone: "mdi:cart" }, DO_BOTAO);

  assert.ok(!("botaoIconeSvg" in doc));
  assert.ok(!("botaoIcone" in doc));
});

test("busca que falha grava SEM ícone, em vez de não gravar", async () => {
  // O texto é o conteúdo e o ícone é enfeite. Perder o enfeite é melhor que
  // perder o que a pessoa escreveu.
  const devolver = comBusca(null);

  const doc = { botaoIcone: "mdi:cart" };
  await iconeGuardado.aplicar(doc, null, DO_BOTAO);

  assert.equal(doc.botaoIcone, "");
  assert.equal(doc.botaoIconeSvg, "");
  devolver();
});

test("sem dizer os campos, vale o benefício — quem já usava não mudou", async () => {
  const devolver = comBusca({ body: "<path/>", caixa: "0 0 24 24" });

  const doc = { icone: "mdi:check" };
  await iconeGuardado.aplicar(doc, null);

  assert.equal(doc.iconeSvg, "<path/>");
  devolver();
});
