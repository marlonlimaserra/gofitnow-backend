const test = require("node:test");
const assert = require("node:assert/strict");

const ClientError_model = require("../../model/ClientError_model.js");
const { ORIGENS, ehRuido, assinatura } = ClientError_model;

// O ERRO DE SERVIDOR INDO PARA O PAINEL.
//
// *"você salva nos logs da central ou em alguma collection TODOS os erros que
// dão? para eu poder consultar depois?"*
//
// A resposta era não: erro de rota ia para `console.error` e morria no log da
// máquina. Foi assim que o upload de foto do aulão ficou quebrado sem ninguém
// saber — a tela dizia "Erro interno" e a causa ("pasta desconhecida") estava a
// um `ssh` de distância.
//
// Estes testes travam as duas coisas que fazem isso funcionar: a origem ser
// aceita, e um erro de servidor NÃO ser confundido com ruído de navegador.

test("`servidor` é uma origem válida", () => {
  // Fora da lista, `registrar` grava como "app" — e o erro do backend
  // apareceria misturado com o do navegador, que tem outra pilha e outro
  // conserto.
  assert.ok(ORIGENS.includes("servidor"));
});

test("as quatro origens, e nenhuma perdida no caminho", () => {
  // A lista é CONTRATO com dois outros lugares: o filtro do painel
  // (`Erros.jsx`) e a validação da central (`ORIGENS_FILTRO`). Acrescentar aqui
  // sem acrescentar lá deixa a opção decorativa — foi o que aconteceu com
  // `aplicativo`, que nunca filtrou nada.
  // Ordenado: "aplicativo" vem ANTES de "app" — o `l` precede o `p`. Escrevi
  // a expectativa na ordem errada na primeira tentativa, e o teste a corrigiu.
  assert.deepEqual([...ORIGENS].sort(), ["aplicativo", "app", "painel", "servidor"]);
});

test("mensagem de erro de servidor não é tratada como ruído", () => {
  // A lista de ruído foi escrita para o NAVEGADOR (ResizeObserver, Script
  // error, extensões). Um erro nosso de backend não pode cair nela — seria
  // descartado em silêncio, e voltaríamos ao problema original.
  const nossos = [
    'arquivos: pasta desconhecida: "aulao"',
    "no_instance_in_context",
    "E11000 duplicate key error collection",
    "Cannot read properties of undefined (reading '_id')",
    "connect ECONNREFUSED 127.0.0.1:6379",
  ];

  for (const m of nossos) {
    assert.equal(ehRuido(m, ""), false, `descartou como ruído: ${m}`);
  }
});

test("o ruído do navegador continua sendo descartado", () => {
  // O outro lado do teste de cima: acrescentar uma origem não pode ter afrouxado
  // o filtro que mantém o painel legível.
  assert.equal(ehRuido("ResizeObserver loop completed", ""), true);
  assert.equal(ehRuido("Script error.", ""), true);
  assert.equal(ehRuido("qualquer coisa", "chrome-extension://abc/x.js"), true);
});

test("dois erros iguais em rotas diferentes são registros diferentes", () => {
  // A assinatura entra no `upsert`: se o método e o caminho não a influenciassem,
  // "Erro interno" em duas rotas viraria UM registro com contador 2 — e ninguém
  // saberia quais rotas estão quebradas.
  const a = assinatura({
    message: "arquivos: pasta desconhecida",
    source: "POST /aulaoes/:id/imagens",
    tipo: "Error",
    origem: "servidor",
  });
  const b = assinatura({
    message: "arquivos: pasta desconhecida",
    source: "POST /brand/imagens",
    tipo: "Error",
    origem: "servidor",
  });

  assert.notEqual(a, b);
});

test("o mesmo erro na mesma rota é UM registro — é o que dá o contador", () => {
  const de = {
    message: "arquivos: pasta desconhecida",
    source: "POST /aulaoes/:id/imagens",
    tipo: "Error",
    origem: "servidor",
  };
  assert.equal(assinatura(de), assinatura({ ...de }));
});

test("erro do servidor e do cliente com o MESMO texto não se confundem", () => {
  // A razão pela qual `servidor` é origem separada: o mesmo texto tem conserto
  // diferente em cada lado, e juntá-los faria marcar como resolvido um bug que
  // continua de pé do outro.
  const base = { message: "Failed to save", source: "x", tipo: "Error" };
  assert.notEqual(
    assinatura({ ...base, origem: "servidor" }),
    assinatura({ ...base, origem: "app" })
  );
});
