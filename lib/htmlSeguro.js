// O HTML QUE VEIO DE FORA, limpo o bastante para virar documento.
//
// *"coloque um editor de HTML para ele poder colar e editar o documento"*.
//
// ── POR QUE ISTO EXISTE ───────────────────────────────────────────────────
//
// O termo de responsabilidade é escrito pelo cliente, colado do Word, e depois
// SERVIDO por nós — na tela de quem administra, na folha que o aluno assina, e
// no PDF que vai por e-mail. Entre "alguém digita" e "todo mundo abre" tem de
// haver uma peneira.
//
// O risco não é hipotético nem exótico: colar do Word traz `<script>` de
// telemetria, markup do Office e atributos "onmouseover". E o documento é
// exibido num `<iframe>` que carrega HTML NOSSO — script ali roda na nossa
// origem, com a sessão de quem abriu.
//
// ── LISTA DO QUE ENTRA, e não do que sai ─────────────────────────────────
//
// Uma lista de proibidos é uma corrida que se perde: `<svg onload>`,
// `<math href>`, `<form action>` e o próximo que alguém inventar. Aqui só passa
// o que está escrito abaixo; o resto some, com o miolo junto quando o miolo é
// perigoso.
//
// ── ISTO NÃO É UM SANITIZADOR DE PROPÓSITO GERAL ──────────────────────────
//
// Ele resolve ESTE caso: documento de texto, escrito por alguém de dentro da
// casa, com permissão de administrador. Não é para HTML de desconhecido na
// internet — para aquilo o certo é uma biblioteca com gente olhando (DOMPurify),
// e o dia em que o produto aceitar HTML de fora, é ela que entra aqui.
const TAGS = new Set([
  "p", "br", "hr", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "sub", "sup", "small", "mark",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "a", "img", "figure", "figcaption",
]);

// As que somem COM O CONTEÚDO. Deixar o miolo de um `<script>` viraria o código
// impresso no meio do termo; o de um `<style>`, um monte de CSS solto.
const COM_MIOLO = ["script", "style", "iframe", "object", "embed", "template", "noscript"];

// Atributos aceitos, por tag. `style` entra porque é como o Word e o editor
// marcam negrito, alinhamento e cor — sem ele o documento colado perde a
// formatação inteira. Ele é limpo à parte, mais abaixo.
const ATRIBUTOS = {
  "*": ["style", "class", "align", "title"],
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
  col: ["span", "width"],
  table: ["border", "cellpadding", "cellspacing", "width"],
};

// ── O QUE PODE SER UM ENDEREÇO ────────────────────────────────────────────
//
// `javascript:` é execução com cara de link. `data:` é pior: `data:text/html`
// dentro de um quadro herda a origem de quem o abriu.
//
// A exceção é `data:image/`, que é como uma imagem colada do Word chega — e
// imagem em `<img>` é inerte. SVG fica de fora mesmo aí: é documento executável
// com cara de imagem.
function enderecoSeguro(valor, ehImagem) {
  const v = String(valor || "").trim();

  // Tudo que é espaço ou caractere de controle SAI antes da comparação:
  // `java\tscript:` e `java\nscript:` são lidos pelo navegador como o esquema
  // que a gente está tentando barrar. Filtrar por ponto de código evita ter
  // esses caracteres literais no código-fonte deste arquivo.
  const semEspaco = [...v]
    .filter((c) => c.codePointAt(0) > 32)
    .join("")
    .toLowerCase();

  if (semEspaco.startsWith("javascript:") || semEspaco.startsWith("vbscript:")) return "";

  if (semEspaco.startsWith("data:")) {
    if (!ehImagem) return "";
    return /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(semEspaco) ? v : "";
  }

  return v;
}

// O `style` de um elemento, sem o que executa.
//
// `expression()` é do IE antigo e ainda aparece em HTML colado de documento
// velho; `url(javascript:…)` e `behavior:` são da mesma família. `position:
// fixed` sai porque um documento que gruda na tela sobrepõe a interface de quem
// o está revisando.
function estiloSeguro(valor) {
  const v = String(valor || "");
  if (/expression\s*\(|javascript:|vbscript:|behavior\s*:|@import/i.test(v)) return "";
  return v.replace(/position\s*:\s*(fixed|sticky)/gi, "").slice(0, 600);
}

function escaparTexto(texto) {
  return String(texto).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── A LIMPEZA ─────────────────────────────────────────────────────────────
//
// Feita com expressão regular, e não com um parser de HTML, porque trazer um
// parser para isto seria uma dependência nova num backend que não tem nenhuma
// para HTML. A troca é consciente e cabe NESTE caso: a entrada vem de um editor
// nosso, o autor é administrador da conta, e o que sai é texto formatado.
//
// O que a torna defensável é a ordem: primeiro somem os blocos perigosos
// INTEIROS (com o miolo), e só depois as tags restantes são filtradas uma a uma.
// Sem a primeira passada, um `<script>` mal fechado deixaria código solto.
function limpar(html) {
  let texto = String(html || "");

  // Comentários saem. O motivo não é estético: o comentário condicional que o
  // Word cola (o "if IE") guarda markup DENTRO dele, e ele voltaria a existir
  // no dia em que alguém removesse o comentário sem olhar o conteúdo.
  //
  // Sem o literal do delimitador aqui de propósito — ver
  // `test/lib/crasesNoTemplate.test.js`: arquivo com esse literal é tratado
  // como gerador de HTML, e este não é.
  texto = texto.replace(/<!--[\s\S]*?-->/g, "");

  for (const tag of COM_MIOLO) {
    // Com miolo, e também a versão sem fechamento — que é como um `<script`
    // cortado no meio de um colar chega.
    texto = texto.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
    texto = texto.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
  }

  return texto.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (todo, nome, resto) => {
      const tag = String(nome).toLowerCase();
      if (!TAGS.has(tag)) return "";

      // Fechamento não tem atributo para limpar.
      if (todo.startsWith("</")) return `</${tag}>`;

      const permitidos = new Set([...(ATRIBUTOS["*"] || []), ...(ATRIBUTOS[tag] || [])]);
      const saida = [];

      const cada = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      for (const m of String(resto).matchAll(cada)) {
        const chave = m[1].toLowerCase();
        let valor = m[3] ?? m[4] ?? m[5] ?? "";

        // TODO atributo que começa com `on` sai, esteja ou não na lista: é a
        // família inteira de execução (`onclick`, `onerror`, `onmouseover`), e
        // ela cresce a cada versão de navegador.
        if (chave.startsWith("on")) continue;
        if (!permitidos.has(chave)) continue;

        if (chave === "style") valor = estiloSeguro(valor);
        if (chave === "href") valor = enderecoSeguro(valor, false);
        if (chave === "src") valor = enderecoSeguro(valor, true);
        if (!valor) continue;

        saida.push(`${chave}="${escaparTexto(valor).replace(/"/g, "&quot;")}"`);
      }

      // Link que abre fora leva `rel`: sem ele a página aberta ganha
      // `window.opener` e pode trocar a nossa de endereço.
      if (tag === "a" && /target\s*=/i.test(resto)) saida.push('rel="noopener noreferrer"');

      const fecha = /\/>$/.test(todo) ? " /" : "";
      return `<${tag}${saida.length ? " " + saida.join(" ") : ""}${fecha}>`;
    }
  );
}

module.exports = { limpar, TAGS, enderecoSeguro, estiloSeguro };
