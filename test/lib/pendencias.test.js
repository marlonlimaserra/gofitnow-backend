const test = require("node:test");
const assert = require("node:assert/strict");

const pendencias = require("../../lib/pendencias.js");

// O QUE FALTA UM ALUNO ENTREGAR — e o que disso TRANCA.
//
// *"sempre que um aluno se matricula, é obrigatório ele preencher alguns desses
// documentos, aí o acesso dele fica travado se tiver alguma pendência"*.
//
// Este arquivo cuida da regra que decide se alguém entra. É a parte perigosa do
// recurso: um defeito aqui não mostra tela errada — ele deixa gente de fora.
function fakeApp(modelos, cumpridos = []) {
  return {
    api: {
      documentTemplate: { async listar() { return modelos; } },
      personDocument: { async modelosCumpridos() { return cumpridos; } },
      // Sem pendência escrita à mão: estes casos são só sobre a fonte
      // automática, a dos documentos obrigatórios.
      pendency: { async listar() { return []; } },
    },
  };
}

const TERMO = { id: "t1", name: "Termo de responsabilidade", obrigatorio: true };
const IMAGEM = { id: "t2", name: "Autorização de imagem", obrigatorio: true };
const OPCIONAL = { id: "t3", name: "Ficha de saúde", obrigatorio: false };

test("modelo obrigatório não cumprido é pendência", async () => {
  const lista = await pendencias.pendenciasDe(fakeApp([TERMO, IMAGEM]), "p1");
  assert.deepEqual(lista.map((p) => p.id), ["t1", "t2"]);
});

test("o que já foi cumprido sai da lista", async () => {
  const lista = await pendencias.pendenciasDe(fakeApp([TERMO, IMAGEM], ["t1"]), "p1");
  assert.deepEqual(lista.map((p) => p.id), ["t2"]);
});

test("modelo que NÃO é obrigatório nunca é pendência", async () => {
  const lista = await pendencias.pendenciasDe(fakeApp([OPCIONAL]), "p1");
  assert.deepEqual(lista, []);
});

test("modelo DESATIVADO não gera pendência — é o freio de emergência", async () => {
  // A casa que trancou a base inteira sem querer desativa o modelo e todo mundo
  // volta, sem precisar mexer em aluno nenhum.
  //
  // Quem filtra os inativos é `listar({ somenteAtivos: true })`, e este caso
  // prova que é ELE que é chamado.
  const chamadas = [];
  const app = {
    api: {
      documentTemplate: {
        async listar(opcoes) {
          chamadas.push(opcoes);
          return [];
        },
      },
      personDocument: { async modelosCumpridos() { return []; } },
      pendency: { async listar() { return []; } },
    },
  };

  await pendencias.pendenciasDe(app, "p1");
  assert.deepEqual(chamadas, [{ somenteAtivos: true }]);
});

test("o documento obrigatório vira uma pendência do ALUNO", async () => {
  // Ele é sempre coisa que a pessoa entrega — diferente da camisa, que é o que
  // a casa deve a ela.
  const lista = await pendencias.pendenciasDe(fakeApp([TERMO]), "p1");

  assert.equal(lista[0].origem, "documento");
  assert.equal(lista[0].quem, "aluno");
  assert.equal(lista[0].categoria, "documento");
});

test("NADA aqui tranca login — o Marlon cortou isso de propósito", async () => {
  // *"só cadastra como pendência, não precisa travar até o login dele no app"*.
  // O propósito é parar a pessoa no BALCÃO, e para isso basta aparecer na ficha.
  assert.equal(typeof pendencias.travaOLogin, "undefined");
  assert.equal(typeof pendencias.trancam, "undefined");
});

// ── AS DUAS FONTES, NUMA LISTA SÓ ─────────────────────────────────────────
//
// *"não seria só documentos. Exemplo: eu queria uma camisa, aí a academia
// cadastrou camisa como pendência, para eu ser barrado na recepção."*
const CAMISA = {
  id: "x1",
  origem: "manual",
  titulo: "Camiseta tamanho M",
  categoria: "entrega",
  quem: "casa",
  resolvida: false,
};

function comManuais(modelos, manuais, cumpridos = []) {
  return {
    api: {
      documentTemplate: { async listar() { return modelos; } },
      personDocument: { async modelosCumpridos() { return cumpridos; } },
      pendency: { async listar() { return manuais; } },
    },
  };
}

test("a camisa e o termo aparecem na MESMA lista", async () => {
  // Duas listas separadas fariam quem atende olhar em dois lugares — e é a
  // segunda que ninguém olha.
  const lista = await pendencias.pendenciasDe(comManuais([TERMO], [CAMISA]), "p1");

  assert.equal(lista.length, 2);
  assert.deepEqual(lista.map((p) => p.titulo), ["Camiseta tamanho M", "Termo de responsabilidade"]);
});

test("as ESCRITAS À MÃO vêm primeiro", async () => {
  // Alguém as escreveu agora, para alguém ser parado hoje. A do documento é a
  // de sempre e pode esperar o fim da lista.
  const lista = await pendencias.pendenciasDe(comManuais([TERMO, IMAGEM], [CAMISA]), "p1");
  assert.equal(lista[0].origem, "manual");
});

test("a pendência da CASA diz que é a casa que deve", async () => {
  // "O aluno deve" é uma cobrança; "a casa deve" é um lembrete para nós. As
  // duas param a pessoa no balcão, e quem lê precisa saber de que lado está a
  // bola.
  const lista = await pendencias.pendenciasDe(comManuais([], [CAMISA]), "p1");
  assert.equal(lista[0].quem, "casa");
});

test("sem nada em aberto, a lista é vazia", async () => {
  assert.deepEqual(await pendencias.pendenciasDe(comManuais([], []), "p1"), []);
});
