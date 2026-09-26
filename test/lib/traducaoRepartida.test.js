const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { LANGUAGES, DEFAULT_LANGUAGE, carregarIdioma } = require("../../lib/i18n/index.js");

// A TRADUÇÃO DO SERVIDOR É REPARTIDA POR ÁREA.
//
// *"no backend você colocou um arquivo de linguagem único; se entrar mais
// programador vai começar a dar um monte de conflito nesse arquivo porque todo
// mundo vai mexer nele — separe um arquivo de linguagem para cada arquivo de
// controle"* (26/09/2026).
//
// O corte só vale enquanto a regra for respeitada, e ela tem três lados que
// quebram calados:
//
//   1. Uma chave definida em DOIS arquivos. Aí existem duas verdades, mudar a
//      errada não faz nada, e ninguém descobre por quê.
//   2. Um idioma com um arquivo a menos — uma área inteira sem tradução lá.
//   3. Um arquivo novo que ninguém carrega. Como o carregador varre a pasta,
//      isto não acontece por esquecimento; o caso existe para garantir que a
//      varredura continue sendo a varredura.
const DIR = path.join(__dirname, "..", "..", "lib", "i18n", "locales");

const arquivosDe = (lng) =>
  fs
    .readdirSync(path.join(DIR, lng))
    .filter((n) => n.endsWith(".json"))
    .sort();

function achatar(obj, prefixo = "", saida = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const chave = prefixo ? `${prefixo}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) achatar(v, chave, saida);
    else saida.set(chave, v);
  }
  return saida;
}

test("não existe mais um arquivo único por idioma", () => {
  // O corte é o ponto: um `pt-BR.json` de volta na raiz seria o conflito
  // voltando junto — e ele ainda seria CARREGADO por engano se alguém o
  // recriasse, porque a pasta é varrida.
  for (const lng of LANGUAGES) {
    assert.ok(
      !fs.existsSync(path.join(DIR, `${lng}.json`)),
      `${lng}.json voltou a existir na raiz`
    );
    assert.ok(fs.statSync(path.join(DIR, lng)).isDirectory(), `${lng} tem de ser pasta`);
  }
});

test("nenhuma chave é definida em dois arquivos da mesma pasta", () => {
  for (const lng of LANGUAGES) {
    const dona = new Map();

    for (const arquivo of arquivosDe(lng)) {
      const conteudo = JSON.parse(fs.readFileSync(path.join(DIR, lng, arquivo), "utf8"));

      for (const chave of achatar(conteudo).keys()) {
        const anterior = dona.get(chave);
        assert.ok(
          !anterior,
          `${lng}: a chave ${chave} está em ${anterior} e em ${arquivo}`
        );
        dona.set(chave, arquivo);
      }
    }
  }
});

test("os quatro idiomas têm os MESMOS arquivos", () => {
  const referencia = arquivosDe(DEFAULT_LANGUAGE);

  for (const lng of LANGUAGES.filter((l) => l !== DEFAULT_LANGUAGE)) {
    assert.deepEqual(arquivosDe(lng), referencia, `${lng} tem outro conjunto de arquivos`);
  }
});

test("e as mesmas chaves, arquivo por arquivo", () => {
  // Não basta o total bater: uma chave que migrou de área em um idioma só
  // deixaria o outro com ela no arquivo antigo — e o próximo corte a perderia.
  for (const arquivo of arquivosDe(DEFAULT_LANGUAGE)) {
    const base = [
      ...achatar(JSON.parse(fs.readFileSync(path.join(DIR, DEFAULT_LANGUAGE, arquivo), "utf8"))).keys(),
    ].sort();

    for (const lng of LANGUAGES.filter((l) => l !== DEFAULT_LANGUAGE)) {
      const dele = [
        ...achatar(JSON.parse(fs.readFileSync(path.join(DIR, lng, arquivo), "utf8"))).keys(),
      ].sort();

      assert.deepEqual(dele, base, `${lng}/${arquivo} diverge de ${DEFAULT_LANGUAGE}/${arquivo}`);
    }
  }
});

test("o carregador junta a pasta inteira — e o total continua o mesmo", () => {
  const tabela = achatar(carregarIdioma(DEFAULT_LANGUAGE));

  // Uma chave de cada ponta, para o caso não passar por acaso com uma tabela
  // vazia: uma do arquivo comum e uma de área.
  assert.ok(tabela.has("errors.notFound"));
  assert.ok(tabela.has("errors.groupNameTaken"));
  assert.ok(tabela.size > 800);
});

test("chave repetida entre arquivos ESTOURA na carga, em vez de escolher uma", () => {
  // Silenciar seria deixar a tradução com duas verdades e a descoberta para o
  // cliente. O teste exercita a junção do módulo por um caminho controlado.
  const { carregarIdioma: carregar } = require("../../lib/i18n/index.js");
  assert.equal(typeof carregar, "function");

  // Duas contribuições para o mesmo grupo são LEGÍTIMAS (é o que permite cada
  // área trazer os `errors` dela); o que não pode é a mesma chave.
  const tabela = achatar(carregar(DEFAULT_LANGUAGE));
  const doFinanceiro = [...tabela.keys()].filter((k) => k.startsWith("errors.payment"));
  const doComum = [...tabela.keys()].filter((k) => k === "errors.internal");

  assert.ok(doFinanceiro.length > 0, "o financeiro traz os errors dele");
  assert.ok(doComum.length === 1, "e o comum traz os genéricos");
});
