const { escapar, formatarData, pagina } = require("./documentoBase.js");
const htmlSeguro = require("./htmlSeguro.js");

// A FOLHA DE UM MODELO DE DOCUMENTO, preenchida para uma pessoa.
//
// *"cadastrar esse documento... ai lá dentro do aluno... um select chamado
// baixar documento; se for PDF já abre o visualizador para imprimir, HTML
// também"*.
//
// ── POR QUE O MODELO TEM CAMPOS, e não é só um texto fixo ───────────────
//
// Um termo de responsabilidade sem o nome de quem assina é um papel que alguém
// preenche à caneta. Era o que o PDF pronto já fazia — e se o editor ao vivo
// fizesse a mesma coisa, ele não teria razão de existir ao lado do PDF.
//
// Os campos são escritos como `{{nome}}` no editor, e a tela mostra a lista
// para clicar. Deliberadamente poucos: os que TODA ficha tem. Um campo que
// existe e vem vazio na metade dos alunos é pior que um espaço para preencher
// à mão, porque some sem deixar linha.
const CAMPOS = [
  { chave: "nome", rotulo: "documentTemplates.fieldName" },
  { chave: "cpf", rotulo: "documentTemplates.fieldCpf" },
  { chave: "email", rotulo: "documentTemplates.fieldEmail" },
  { chave: "telefone", rotulo: "documentTemplates.fieldPhone" },
  { chave: "nascimento", rotulo: "documentTemplates.fieldBirth" },
  { chave: "endereco", rotulo: "documentTemplates.fieldAddress" },
  { chave: "academia", rotulo: "documentTemplates.fieldHouse" },
  { chave: "hoje", rotulo: "documentTemplates.fieldToday" },
];

function camposParaTela(t) {
  return CAMPOS.map((c) => ({
    chave: c.chave,
    label: t ? t(c.rotulo) : c.chave,
    // O que se cola no editor. A tela mostra isto ao lado do rótulo para quem
    // preferir digitar.
    marca: `{{${c.chave}}}`,
  }));
}

// ── O PREENCHIMENTO ───────────────────────────────────────────────────────
//
// O valor é ESCAPADO antes de entrar: o nome de alguém com `<` quebraria a
// folha, e com `<script>` seria pior. O HTML em volta já foi limpo na gravação
// (`lib/htmlSeguro.js`); o que entra agora vem do banco e é texto.
//
// Campo sem valor vira um TRACINHO sublinhado, e não vazio: num termo impresso
// é a linha onde alguém escreve à mão. Sumir deixaria a frase sem sentido —
// "Eu, , portador do CPF".
const VAZIO = '<span style="display:inline-block;min-width:140px;border-bottom:1px solid #94a3b8;">&nbsp;</span>';

function preencher(html, valores) {
  return String(html || "").replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (todo, chave) => {
    const nome = String(chave).toLowerCase();
    if (!CAMPOS.some((c) => c.chave === nome)) return todo;

    const valor = valores[nome];
    return valor ? escapar(valor) : VAZIO;
  });
}

// Os valores de uma pessoa, prontos para o preenchimento.
function valoresDaPessoa({ pessoa, casa, lang, fuso }) {
  return {
    nome: pessoa?.name || "",
    cpf: pessoa?.cpf || pessoa?.document || "",
    email: pessoa?.email || "",
    telefone: pessoa?.phone || pessoa?.whatsapp || "",
    nascimento: formatarData(pessoa?.birthDate, lang, fuso),
    endereco: pessoa?.endereco || pessoa?.address || "",
    academia: casa?.name || "",
    hoje: formatarData(new Date(), lang, fuso),
  };
}

// ── A FOLHA ───────────────────────────────────────────────────────────────
//
// Ela usa o MESMO papel da avaliação e do plano alimentar (`pagina`), e é por
// isso que o termo sai com a logo da casa e o nome do aluno no cabeçalho sem
// este arquivo saber desenhar nada disso.
function documentoModelo({ modelo, pessoa, casa, marca, lang, fuso }) {
  const valores = valoresDaPessoa({ pessoa, casa, lang, fuso });

  // Limpo DE NOVO na saída, mesmo já tendo sido limpo na gravação.
  //
  // Não é desconfiança do que está no banco: é que um documento gravado antes
  // desta peneira existir continuaria saindo sujo para sempre. Limpar aqui faz
  // a correção alcançar o que já está guardado, sem migração.
  const corpo = preencher(htmlSeguro.limpar(modelo.html), valores);

  return pagina({
    lang,
    titulo: modelo.name,
    nome: pessoa?.name || "",
    subtitulo: modelo.descricao || "",
    corpo,
    // O rodapé do papel diz quando a folha foi gerada — num termo assinado, é o
    // que separa a via de março da via de setembro.
    rodape: valores.hoje,
    marca,
  });
}

module.exports = { documentoModelo, camposParaTela, preencher, valoresDaPessoa, CAMPOS };
