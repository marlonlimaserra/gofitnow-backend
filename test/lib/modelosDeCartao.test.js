const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const modelos = require(path.join(__dirname, "..", "..", "lib", "modelosDeCartao.js"));

// OS MODELOS DE COR DO CARTÃO DE UM PLANO.
//
// *"monte um modelo de cores, igual você fez em aparência"*.
//
// O que estes casos guardam é a única promessa que um modelo faz: **ele é
// legível**. Cinco cores escolhidas a dedo dão cinco decisões e um cartão
// ilegível na primeira tentativa; um modelo é uma decisão, e essa decisão tem
// de vir com o contraste já resolvido.
//
// Um modelo bonito que deixa "Quero este plano" ilegível é pior que nenhum,
// porque ele parece aprovado.

// Luminância relativa da WCAG, e a razão de contraste entre duas cores. É a
// mesma conta que qualquer verificador de acessibilidade faz — está aqui, e
// não numa biblioteca, porque são oito linhas e a dependência valeria menos
// que o comentário explicando de onde ela veio.
function luz(hex) {
  const canais = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = canais.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a, b) {
  const [x, y] = [luz(a), luz(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const paraTela = modelos.paraTela((chave) => chave);

test("o primeiro modelo é o VAZIO — o caminho de volta à marca", () => {
  // Quem mexeu demais precisa de um clique de volta. E vazio não é "branco":
  // é "sem escolha", que é o que faz o cartão mudar junto quando a marca
  // mudar.
  const primeiro = paraTela[0];

  assert.equal(primeiro.id, "marca");
  for (const cor of Object.values(primeiro.cores)) assert.equal(cor, "");
});

test("todo modelo define as CINCO cores — nenhuma meia pintura", () => {
  // Um modelo que esquece uma cor deixa a anterior no lugar, e o resultado é
  // uma mistura que ninguém escolheu.
  const esperadas = ["corFundo", "corTexto", "corDestaque", "corBotao", "corBotaoTexto"];

  for (const m of paraTela) {
    assert.deepEqual(Object.keys(m.cores).sort(), [...esperadas].sort(), m.id);
  }
});

test("as cores são hex de seis dígitos — é o que o modelo do plano aceita gravar", () => {
  for (const m of paraTela) {
    for (const [campo, cor] of Object.entries(m.cores)) {
      if (!cor) continue;
      assert.match(cor, /^#[0-9a-f]{6}$/, `${m.id}.${campo}`);
    }
  }
});

test("o TEXTO é legível sobre o fundo, em todo modelo", () => {
  // 4.5:1 é o mínimo da WCAG para texto normal. A descrição do plano sai
  // nesse tamanho.
  for (const m of paraTela.filter((x) => x.cores.corFundo)) {
    const razao = contraste(m.cores.corTexto, m.cores.corFundo);
    assert.ok(razao >= 4.5, `${m.id}: texto sobre fundo ficou em ${razao.toFixed(2)}:1`);
  }
});

test("o texto do BOTÃO é legível sobre o botão", () => {
  // É a linha que decide a venda. Ilegível aqui é o pior lugar possível.
  for (const m of paraTela.filter((x) => x.cores.corBotao)) {
    const razao = contraste(m.cores.corBotaoTexto, m.cores.corBotao);
    assert.ok(razao >= 4.5, `${m.id}: texto do botão ficou em ${razao.toFixed(2)}:1`);
  }
});

test("o BOTÃO se separa do fundo — senão ele desaparece dentro do cartão", () => {
  // 3:1 é o mínimo da WCAG para um componente de interface contra o que está
  // atrás dele. Um botão da cor do fundo existe e ninguém vê.
  for (const m of paraTela.filter((x) => x.cores.corBotao && x.cores.corFundo)) {
    const razao = contraste(m.cores.corBotao, m.cores.corFundo);
    assert.ok(razao >= 3, `${m.id}: botão sobre fundo ficou em ${razao.toFixed(2)}:1`);
  }
});

test("o SELO do destaque também se separa do fundo", () => {
  for (const m of paraTela.filter((x) => x.cores.corDestaque && x.cores.corFundo)) {
    const razao = contraste(m.cores.corDestaque, m.cores.corFundo);
    assert.ok(razao >= 3, `${m.id}: selo sobre fundo ficou em ${razao.toFixed(2)}:1`);
  }
});

test("o selo admite um texto legível — preto ou branco", () => {
  // O texto do selo é DERIVADO no cartão, e não um sexto campo: um selo
  // verde-limão com texto branco é ilegível, e não dá para pedir que quem
  // escolhe uma cor bonita lembre disso. O que este caso garante é que a
  // derivação TEM uma saída boa — que uma das duas passa de 4.5:1.
  for (const m of paraTela.filter((x) => x.cores.corDestaque)) {
    const melhor = Math.max(
      contraste(m.cores.corDestaque, "#ffffff"),
      contraste(m.cores.corDestaque, "#0f172a")
    );
    assert.ok(melhor >= 4.5, `${m.id}: o melhor texto possível no selo dá ${melhor.toFixed(2)}:1`);
  }
});

test("o rótulo vem traduzido, e o id não", () => {
  // O id é o que um dia pode ser gravado; o rótulo é apresentação. Trocar o
  // texto de um modelo não pode mexer no que ficou guardado.
  const comT = modelos.paraTela(() => "Traduzido");

  for (const m of comT) {
    assert.equal(m.label, "Traduzido");
    assert.match(m.id, /^[a-z]+$/);
  }
});

test("mexer nas cores devolvidas não estraga o catálogo", () => {
  // `paraTela` é chamado a cada requisição. Devolver a referência deixaria
  // uma mutação acidental valer para todo mundo até o próximo deploy.
  const primeiro = modelos.paraTela((k) => k)[1];
  primeiro.cores.corFundo = "#000000";

  assert.notEqual(modelos.paraTela((k) => k)[1].cores.corFundo, "#000000");
});
