const tipos = require("./tiposDeCampo.js");

// O QUE A PESSOA RESPONDEU — a conversão e a conferência, num lugar só.
//
// *"dentro do cliente abria algo parecido com isso com os campos dentro"*
// (01/10/2026).
//
// O catálogo diz a PERGUNTA; isto trata a RESPOSTA. Fica em `lib/` e não no
// modelo porque dois caminhos a usam — criar pessoa e editar pessoa — e a
// terceira cópia seria a que divergisse.
//
// ── POR QUE CONVERTER, E NÃO SÓ GUARDAR O QUE VEIO ─────────────────────
//
// O navegador manda tudo como texto. Sem conversão, o campo Número guarda
// `"72.5"` e a soma vira concatenação; a Data guarda uma string no formato de
// quem digitou e nenhuma comparação funciona; o Sim/Não guarda `"false"`, que é
// uma string verdadeira — e o `if` do outro lado diz que sim.
//
// ── NATIVO VAI PARA A COLUNA DELE ──────────────────────────────────────
//
// Objetivo, Peso e Altura já são colunas do documento da pessoa, e meio produto
// as lê (IMC, avaliação, evolução). A resposta deles continua indo para lá — e
// é por isso que a saída tem DOIS baldes.
const LIMITE_TEXTO = 2000;

function comoTexto(v) {
  return String(v == null ? "" : v).trim().slice(0, LIMITE_TEXTO);
}

function comoNumero(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function comoData(v) {
  if (!v) return null;
  const d = new Date(v);
  // Lixo vira `null` e não `Invalid Date`: um `Invalid Date` gravado quebra
  // toda leitura depois, e quem o gravou não vê erro nenhum na hora.
  return Number.isNaN(d.getTime()) ? null : d;
}

function comoBooleano(v) {
  // `"false"` é uma string VERDADEIRA em JavaScript, e é o que um formulário
  // manda. Tratar só o valor booleano deixaria todo "Não" virar "Sim".
  return v === true || v === "true" || v === 1 || v === "1";
}

// Um valor, convertido pelo que o tipo manda guardar.
function converter(campo, bruto) {
  const guarda = tipos.comoGuarda(campo.tipo);

  if (guarda === "numero") return comoNumero(bruto);
  if (guarda === "data") return comoData(bruto);
  if (guarda === "booleano") return comoBooleano(bruto);

  if (guarda === "lista") {
    const lista = Array.isArray(bruto) ? bruto : String(bruto || "").split(",");
    const validos = new Set((campo.opcoes || []).map((o) => o.valor));

    // Só o que o seletor oferece. Sem isto, um pedido feito à mão grava
    // qualquer coisa num campo que a tela promete ser uma lista fechada — e o
    // relatório por opção passa a ter uma fatia que ninguém sabe de onde veio.
    return [...new Set(lista.map((x) => String(x || "").trim()).filter((x) => validos.has(x)))];
  }

  const texto = comoTexto(bruto);

  // O seletor de uma opção só segue a mesma regra da lista: o que não está no
  // catálogo não entra.
  if (campo.tipo === "seletor" && texto) {
    const validos = new Set((campo.opcoes || []).map((o) => o.valor));
    return validos.has(texto) ? texto : "";
  }

  return texto;
}

// Vazio para efeito de OBRIGATÓRIO. `0` e `false` são respostas, e não ausência
// — "peso zero" é um erro de digitação que o dono resolve, mas "não" num
// Sim/Não obrigatório é uma resposta legítima.
function vazio(valor) {
  if (valor === null || valor === undefined) return true;
  if (typeof valor === "string") return valor.trim() === "";
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

// ── A ENTRADA E A SAÍDA ─────────────────────────────────────────────────
//
//   campos    o catálogo ATIVO (`custom_fields` com `ativo !== false`)
//   entrada   o que a tela mandou, por alias
//   parcial   num PATCH, alias ausente quer dizer "não mexa" — e não "apague"
//
// Devolve:
//   nativos   `{ goal, weight, height }` para o topo do documento
//   valores   `{ alias: valor }` para `customFields`
//   faltando  os obrigatórios que ficaram vazios
//   unicos    os que pedem conferência no banco (quem pergunta é o controller)
function preparar(campos, entrada = {}, { parcial = false } = {}) {
  const nativos = {};
  const valores = {};
  const faltando = [];
  const unicos = [];

  for (const campo of campos) {
    const veio = Object.prototype.hasOwnProperty.call(entrada, campo.alias);

    if (parcial && !veio) continue;

    const valor = converter(campo, entrada[campo.alias]);

    if (campo.obrigatorio && vazio(valor)) {
      faltando.push({ alias: campo.alias, name: campo.name || campo.rotuloPadrao || campo.alias });
      continue;
    }

    if (campo.unico && !vazio(valor)) unicos.push({ campo, valor });

    if (campo.nativo) nativos[campo.alias] = valor;
    else valores[campo.alias] = valor;
  }

  return { nativos, valores, faltando, unicos };
}

module.exports = { preparar, converter, vazio, LIMITE_TEXTO };
