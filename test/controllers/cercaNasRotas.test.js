const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// TODA ROTA QUE ACEITA `?unit=` PASSA PELA CERCA.
//
// A cerca é boa enquanto ninguém escrever a décima quinta rota do jeito antigo
// — `unit: req.query.unit` —, e essa rota não vai parecer errada em revisão
// nenhuma: ela é idêntica às catorze que existiam antes de hoje.
//
// Por isso este caso lê o CÓDIGO. É grosseiro de propósito, como
// `gramaticaDasAbas` e `tituloNaoRepete`: o que ele guarda não aparece em
// teste de comportamento, porque o comportamento só é errado para um usuário
// restrito — e não existe nenhum hoje.
const DIR = path.join(__dirname, "..", "..", "controllers");

test("nenhum controller passa `req.query.unit` cru para um modelo", () => {
  const culpados = [];

  for (const nome of fs.readdirSync(DIR).filter((n) => n.endsWith(".js"))) {
    const fonte = fs.readFileSync(path.join(DIR, nome), "utf8");

    for (const linha of fonte.split("\n")) {
      // A forma proibida é a que ENTREGA o parâmetro a alguém: `unit:
      // req.query.unit`. Ler `req.query.unit` para passar pela cerca é o
      // caminho certo, e continua permitido.
      if (/unit:\s*req\.query\.unit/.test(linha)) culpados.push(`${nome}: ${linha.trim()}`);
    }
  }

  assert.deepEqual(
    culpados,
    [],
    "use `...lenteDeUnidade.recorte(user, req.query.unit)` — ver lib/lenteDeUnidade.js"
  );
});

test("e há rotas de verdade usando a cerca — um teste que não vê nada passaria calado", () => {
  let comCerca = 0;

  for (const nome of fs.readdirSync(DIR).filter((n) => n.endsWith(".js"))) {
    const fonte = fs.readFileSync(path.join(DIR, nome), "utf8");
    comCerca += (fonte.match(/lenteDeUnidade\.recorte\(/g) || []).length;
  }

  assert.ok(comCerca >= 14, `só ${comCerca} rotas com a cerca`);
});

test("a BUSCA GLOBAL também passa por ela", () => {
  // Ela não tem seletor de unidade — e seria a porta dos fundos da casa que
  // acabou de ganhar tranca.
  const fonte = fs.readFileSync(path.join(DIR, "Busca.js"), "utf8");

  assert.ok(fonte.includes("lenteDeUnidade.recorte("), "a busca precisa da cerca");
  // E ela aplica em cada consulta, não só declara.
  assert.ok((fonte.match(/\.\.\.cerca/g) || []).length >= 5);
});
