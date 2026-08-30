const test = require("node:test");
const assert = require("node:assert/strict");

// O ESTADO QUE PRECISA SER O MESMO EM TODAS AS MÁQUINAS.
//
// Três contadores e o canal de tempo real assumiam uma máquina só. Com duas,
// cada uma teria a sua cópia — e nenhuma perceberia:
//
//   rateLimit          o limite de 60/min vira 60 × máquinas
//   tentativasDeLogin  errar 3 vezes vira 3 × máquinas antes do desafio
//   travaDeEnvio       a trava de 5 min deixa passar 1 e-mail POR MÁQUINA
//
// O que estes testes seguram não é o Redis funcionando — é o que acontece
// quando ele NÃO funciona. Um serviço auxiliar fora do ar não pode virar a porta
// trancada de quem não fez nada, e essa é a parte que erra calada.

const redis = require("../../lib/redis.js");

test("sem REDIS_URL, nada aqui tenta a rede", async () => {
  // É o que mantém honesto rodar o projeto na máquina de quem desenvolve, e o
  // que fez o deploy não depender de um serviço a mais no mesmo minuto.
  assert.equal(redis.ligado(), false);

  // Todas devolvem `null` — "não sei" —, e nenhuma lança.
  assert.equal(await redis.registrarNaJanela("x", 1000), null);
  assert.equal(await redis.contarNaJanela("x", 1000), null);
  assert.equal(await redis.maisAntigaNaJanela("x", 1000), null);
  assert.equal(await redis.marcarComPrazo("x", 1000), null);
  assert.equal(await redis.faltaDoPrazo("x"), null);
  assert.equal(await redis.esquecer(["x"]), null);
  assert.equal(await redis.parAdaptador(), null);
});

test("toda chave leva o prefixo da casa", () => {
  // O Redis é um espaço de nomes só, e um dia ele vai ser dividido com outra
  // coisa — cache, fila. Sem prefixo, `login:x` de dois sistemas é a mesma chave.
  assert.equal(redis.PREFIXO, "gofit:");
});

// ── O QUE OS TRÊS FAZEM QUANDO O REDIS EMUDECE ────────────────────────────
//
// Cada um cai de volta no caminho do cluster, que é o de hoje. Os testes abaixo
// exercitam o caminho REAL dos módulos com o Redis desligado — que é o estado em
// que este commit sobe, antes de a variável existir em produção.

test("o limite de chamadas continua limitando sem Redis", async () => {
  const rateLimit = require("../../lib/rateLimit.js");

  const chave = "teste-" + Math.random();
  for (let i = 0; i < 60; i++) {
    const r = await rateLimit.checkShared(chave, 60);
    assert.equal(r.allowed, true, `a chamada ${i + 1} devia passar`);
  }

  const passou = await rateLimit.checkShared(chave, 60);
  assert.equal(passou.allowed, false, "a 61ª tinha de bater no teto");
  assert.ok(passou.retryAfter > 0);
});

test("a trava de envio continua travando sem Redis", async () => {
  const trava = require("../../lib/travaDeEnvio.js");
  trava.reset();

  const chave = "envio-" + Math.random();
  assert.equal(await trava.faltamSegundos(chave), 0, "a primeira sai");

  trava.marcarEnvio(chave);

  const falta = await trava.faltamSegundos(chave);
  assert.ok(falta > 0, "a segunda tem de esperar");
  assert.ok(falta <= 300, "e a espera é a janela de cinco minutos");
});

test("as tentativas de login continuam contando sem Redis", async () => {
  const tentativas = require("../../lib/tentativasDeLogin.js");
  tentativas.reset();

  const chaves = tentativas.chavesDe("alguem@exemplo.com", "1.2.3.4");

  assert.equal(await tentativas.contarFalhas(chaves), 0);

  tentativas.registrarFalha(chaves);
  tentativas.registrarFalha(chaves);
  assert.equal(await tentativas.contarFalhas(chaves), 2);

  // Entrou: o histórico some, senão o desafio continuaria aparecendo depois de
  // um login que deu certo.
  tentativas.limparFalhas(chaves);
  assert.equal(await tentativas.contarFalhas(chaves), 0);
});

test("quem chama as funções que viraram assíncronas usa await", () => {
  // `contarFalhas` e `faltamSegundos` ganharam o caminho do Redis e viraram
  // `async`. Chamá-las sem `await` devolve uma Promise — que é sempre
  // verdadeira. A trava nunca destravaria e o desafio apareceria sempre.
  //
  // Elas já devolviam Promise pelo caminho do cluster, então os quatro
  // chamadores de hoje já esperavam. Este teste é para o quinto.
  const fs = require("node:fs");
  const path = require("node:path");

  const raiz = path.join(__dirname, "..", "..");
  const arquivos = [];

  const varrer = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const cheio = path.join(dir, item.name);
      if (item.isDirectory()) varrer(cheio);
      else if (item.name.endsWith(".js")) arquivos.push(cheio);
    }
  };
  for (const pasta of ["lib", "controllers", "helper"]) varrer(path.join(raiz, pasta));

  // Os dois arquivos donos das funções: lá dentro elas são declaradas e usadas
  // pelo caminho local, sem await, e é o certo.
  const donos = ["tentativasDeLogin.js", "travaDeEnvio.js"];

  const soltos = [];

  for (const arquivo of arquivos) {
    if (donos.some((d) => arquivo.endsWith(d))) continue;
    const linhas = fs.readFileSync(arquivo, "utf8").split("\n");

    linhas.forEach((linha, i) => {
      for (const fn of ["contarFalhas(", "faltamSegundos("]) {
        const pos = linha.indexOf(fn);
        if (pos < 0) continue;

        // O `await` pode estar colado ("await x.fn(") ou uma linha acima, no
        // caso de quebra. Basta ele existir antes na mesma linha.
        if (!linha.slice(0, pos).includes("await")) {
          soltos.push(`${path.relative(raiz, arquivo)}:${i + 1}`);
        }
      }
    });
  }

  assert.deepEqual(soltos, [], "chamada sem await — a Promise sempre passa");
});
