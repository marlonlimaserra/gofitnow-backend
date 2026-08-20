// O ALIAS de afiliado: o código que uma conta usa para indicar outra.
//
// ── GÊMEO de `gofitnow-center-backend/lib/alias.js` ───────────────────────
//
// As duas cópias têm de dizer a mesma coisa, porque as duas GERAM alias: o painel
// quando cadastra um cliente à mão, e este backend quando alguém se cadastra sozinho
// pelo portal. Um alias válido de um lado e recusado do outro seria um código que o
// sistema emite e o formulário rejeita.
//
// Poderia ser um pacote compartilhado. Não é, pelo mesmo motivo de `lib/instance.js`
// e `lib/theme.js`, que também são gêmeos: os dois projetos sobem separados, e uma
// dependência entre eles transformaria cada deploy em dois.
//
// Se mexer aqui, mexa lá. A lista de reservados e o formato são o contrato.
//
// ── Por que ele NÃO pode ser o `username` ─────────────────────────────────
//
// Porque `username` é único DENTRO da instância, não entre elas. Hoje pode existir
// um `wil` na conta do Willian e outro `wil` na conta da Bruna, e as duas estão
// certas — são bancos separados, com índices separados.
//
// Se o código de indicação saísse do username, dois afiliados diferentes teriam o
// mesmo código. A comissão iria para um deles, o outro nunca receberia, e nada no
// sistema acusaria — o dinheiro simplesmente cairia na conta errada.
//
// Então o alias mora na CENTRAL, com índice único global. Ele pode NASCER igual ao
// username e divergir quando houver colisão (`wil`, `wil2`).
//
// ── Por que ele nunca muda ────────────────────────────────────────────────
//
// Ele vira link (`gofitnow.fit/i/wil`) e link é impresso em cartão, colado em bio de
// Instagram e mandado em grupo de WhatsApp. Alias que muda transforma indicação
// futura em indicação perdida, e ninguém descobre — o visitante só vê "código
// inválido".
const RESERVADOS = new Set([
  // Rotas nossas: um alias `api` faria `gofitnow.fit/i/api` competir com o resto.
  "admin", "api", "app", "www", "central", "center", "config", "suporte", "support",
  "ajuda", "help", "blog", "site", "loja", "conta", "login", "cadastro", "signup",
  "assinatura", "afiliado", "afiliados", "indicacao", "comissao", "comissoes",
  "gofitnow", "gofit", "sobre", "contato", "termos", "privacidade", "documentacao",
  "docs", "teste", "test", "null", "undefined",
]);

const MIN = 3;
const MAX = 24;

// Só letra minúscula, número e hífen. Sem ponto e sem sublinhado de propósito:
// alias é ditado por telefone e escrito à mão em formulário, e os dois são a fonte
// da metade dos erros de digitação.
const FORMATO = /^[a-z0-9-]+$/;

function normalizar(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    // Hífen repetido e hífen na ponta: "Willian  Costa" daria "willian--costa".
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX);
}

function conferir(valor) {
  const limpo = normalizar(valor);

  if (!limpo) return { ok: false, motivo: "vazio" };
  if (limpo.length < MIN) return { ok: false, motivo: "curto" };
  if (!FORMATO.test(limpo)) return { ok: false, motivo: "caracteres" };
  if (RESERVADOS.has(limpo)) return { ok: false, motivo: "reservado" };
  // Só número seria confundido com id, e um dia alguém vai escrever uma rota que
  // aceita os dois.
  if (/^\d+$/.test(limpo)) return { ok: false, motivo: "so_numero" };

  return { ok: true, valor: limpo };
}

// A SUGESTÃO a partir do que se sabe da pessoa, na ordem do que dá melhor alias:
// nome de usuário, depois o nome, depois o nome da instância.
//
// Não devolve único — quem garante unicidade é o banco. Esta função só propõe.
function sugerir({ username, name, instance } = {}) {
  for (const fonte of [username, name, instance]) {
    const r = conferir(fonte);
    if (r.ok) return r.valor;
  }
  return "";
}

// A tentativa seguinte quando o alias está tomado: `wil` → `wil2` → `wil3`.
//
// Sufixo NUMÉRICO e não aleatório: `wil2` se dita por telefone, `wil-a7f3` não. O
// alias é feito para ser falado.
function proxima(base, tentativa) {
  const raiz = normalizar(base).slice(0, MAX - String(tentativa).length);
  return `${raiz}${tentativa}`;
}

module.exports = { normalizar, conferir, sugerir, proxima, RESERVADOS, MIN, MAX };
