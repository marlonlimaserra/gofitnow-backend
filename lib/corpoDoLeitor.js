const express = require("express");

// O CORPO QUE O LEITOR DA PORTA MANDA — lido com tolerância, nunca recusado.
//
// ── O DEFEITO QUE ISTO CONSERTA (09/10/2026) ─────────────────────────────
//
// *"esse aluno tá cadastrado mas a catraca não libera"*. Fui atrás e o canal
// de monitor NÃO estava mudo: ele vinha falando o tempo todo e **nós é que
// recusávamos**, com HTTP 400, três vezes a cada 30 segundos — 213 recusas no
// log do nginx, e nenhuma linha no log do app.
//
// As duas metades do silêncio:
//
//   • `bodyParser.json()` estourava com o corpo do firmware e devolvia 400;
//   • ele roda ANTES do log de requisições, então a recusa não aparecia em
//     lugar nenhum. O nginx contava, o app não sabia, e a tela dizia "nenhum
//     evento" com toda a sinceridade.
//
// Por três dias eu procurei por que o aparelho não falava. Ele falava.
//
// ── A REGRA ──────────────────────────────────────────────────────────────
//
// **Um evento de catraca não se perde por causa de um byte que não gostamos.**
//
// Do nosso lado da porta, rigor no parsing não protege nada: o corpo vem de um
// aparelho que nós mesmos autenticamos pela credencial do caminho, e a
// alternativa a um JSON torto não é um JSON certo — é a frequência do dia
// sumindo sem ninguém notar. Firmware embarcado manda BOM, NUL de sobra,
// vírgula pendurada e `Content-Type` que não combina com o corpo, e nada disso
// é motivo para jogar fora quem acabou de passar na porta.
//
// Por isso aqui o corpo é lido CRU e convertido na mão. Sem exceção que suba:
// o que não der para ler vira `{}` e segue, com o original preservado em
// `req.corpoCru` para o histórico mostrar.
const LIMITE = "6mb";

// Tira o que firmware pendura FORA do JSON: marca de ordem de bytes, NUL de
// preenchimento e espaço em branco das pontas. Nada aqui toca no conteúdo.
function limpar(texto) {
  return String(texto || "")
    .replace(/^﻿/, "")
    .replace(/\0+$/g, "")
    .trim();
}

// A vírgula pendurada antes de fechar chave ou colchete. É REMENDO, e por isso
// só roda depois que o `JSON.parse` honesto falhou.
//
// A razão está num teste que falhou: esta regex não entende aspas, e num corpo
// VÁLIDO como `{"nota":"entrou,}"}` ela comeria a vírgula de dentro do texto e
// entregaria `entrou}` — dado adulterado em silêncio, num registro de quem
// entrou na academia. Aplicada só sobre o que já não parseava, o estrago
// possível é sobre algo que de outro modo seria descartado inteiro.
function remendarVirgula(texto) {
  return texto.replace(/,\s*([}\]])/g, "$1");
}

// Devolve SEMPRE um objeto. Um corpo ilegível não é motivo para derrubar a
// requisição — é motivo para guardar o cru e deixar a rota decidir.
function lerCorpo(cru) {
  const texto = limpar(cru);
  if (!texto) return {};

  // A tentativa honesta primeiro: corpo válido chega byte a byte como veio.
  try {
    const lido = JSON.parse(texto);
    return lido && typeof lido === "object" ? lido : { valor: lido };
  } catch {
    // Segue para os remendos.
  }

  try {
    const lido = JSON.parse(remendarVirgula(texto));
    return lido && typeof lido === "object" ? lido : { valor: lido };
  } catch {
    // Alguns firmwares mandam o JSON embrulhado em formulário
    // (`application/x-www-form-urlencoded`), e aí o corpo inteiro chega como
    // UMA chave sem valor. Vale uma segunda tentativa antes de desistir.
    const chave = texto.split("=")[0];
    try {
      const lido = JSON.parse(decodeURIComponent(chave.replace(/\+/g, " ")));
      if (lido && typeof lido === "object") return lido;
    } catch {
      // Segue para o vazio: o cru fica guardado de qualquer jeito.
    }
    return {};
  }
}

// O middleware. Entra ANTES dos parsers globais — se entrar depois, o
// `bodyParser.json()` já terá estourado e nada disto roda.
function corpoDoLeitor() {
  const cru = express.raw({ type: () => true, limit: LIMITE });

  return [
    cru,
    (req, res, next) => {
      req.corpoCru = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      req.body = lerCorpo(req.corpoCru);
      next();
    },
  ];
}

module.exports = corpoDoLeitor;
module.exports.lerCorpo = lerCorpo;
module.exports.limpar = limpar;
module.exports.remendarVirgula = remendarVirgula;
