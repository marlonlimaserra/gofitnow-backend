// OS TIPOS DE UM CAMPO CUSTOMIZADO.
//
// *"na parte de configuração do sistema, crie 'Campos customizados', vai ser
// tipo isso aqui, com os tipos"* (01/10/2026), com as telas de um CRM que ele
// usa como referência de desenho.
//
// ── O QUE O TIPO DECIDE, E NÃO É SÓ O TECLADO ───────────────────────────
//
// Um campo customizado é a casa inventando uma pergunta que o produto não fez:
// "qual o plano de saúde?", "veio por indicação de quem?", "assinou o termo?".
// O tipo responde quatro coisas de uma vez, e por isso ele é uma lista fechada
// e não texto livre:
//
//   • como DESENHAR (caixa de texto, data, lista, interruptor)
//   • como GUARDAR (texto, número, data, booleano, lista de textos)
//   • como VALIDAR (e-mail precisa de @, CPF tem 11 dígitos)
//   • como MOSTRAR (data no formato de quem lê, Sim/Não em vez de true)
//
// ── `guarda`: O TIPO DO VALOR NO BANCO ─────────────────────────────────
//
// Vinte tipos de tela, cinco formas de guardar. É `guarda` que o gravador usa
// para converter — sem ele, "123" do campo Número ficaria texto e nenhuma soma
// funcionaria, e a Data viraria string em formato de navegador.
//
// ── `opcoes: true`: OS QUE PEDEM UMA LISTA ─────────────────────────────
//
// Seletor e Seletor Múltiplo não existem sem as opções, e o formulário de
// cadastro do campo precisa saber disso para cobrar — um seletor sem opção é
// uma caixa que não abre.
const TIPOS = [
  { id: "texto", guarda: "texto", icone: "Type", rotulo: "customFields.type.texto", padrao: "Texto" },
  { id: "numero", guarda: "numero", icone: "Hash", rotulo: "customFields.type.numero", padrao: "Número" },
  { id: "email", guarda: "texto", icone: "Mail", rotulo: "customFields.type.email", padrao: "E-mail" },
  { id: "url", guarda: "texto", icone: "Link", rotulo: "customFields.type.url", padrao: "URL" },
  { id: "telefone", guarda: "texto", icone: "Phone", rotulo: "customFields.type.telefone", padrao: "Telefone" },
  { id: "data", guarda: "data", icone: "Calendar", rotulo: "customFields.type.data", padrao: "Data" },
  { id: "dataHora", guarda: "data", icone: "CalendarClock", rotulo: "customFields.type.dataHora", padrao: "Data e hora" },
  // PAÍS, ESTADO, IDIOMA e FUSO são seletores de lista FIXA — a lista não é da
  // casa, é do mundo. Guardam o código (BR, RJ, pt-BR, America/Sao_Paulo) e não
  // o nome: o nome muda com o idioma de quem lê, o código não muda nunca.
  { id: "pais", guarda: "texto", icone: "Globe", rotulo: "customFields.type.pais", padrao: "País" },
  { id: "estado", guarda: "texto", icone: "Map", rotulo: "customFields.type.estado", padrao: "Estado" },
  { id: "idioma", guarda: "texto", icone: "Languages", rotulo: "customFields.type.idioma", padrao: "Idioma" },
  { id: "fuso", guarda: "texto", icone: "Clock", rotulo: "customFields.type.fuso", padrao: "Fuso horário" },
  { id: "seletor", guarda: "texto", opcoes: true, icone: "List", rotulo: "customFields.type.seletor", padrao: "Seletor" },
  {
    id: "seletorMultiplo",
    guarda: "lista",
    opcoes: true,
    icone: "ListChecks",
    rotulo: "customFields.type.seletorMultiplo",
    padrao: "Seletor múltiplo",
  },
  { id: "areaDeTexto", guarda: "texto", icone: "AlignLeft", rotulo: "customFields.type.areaDeTexto", padrao: "Área de texto" },
  { id: "simNao", guarda: "booleano", icone: "ToggleLeft", rotulo: "customFields.type.simNao", padrao: "Sim/Não" },
  { id: "cnpj", guarda: "texto", icone: "Building2", rotulo: "customFields.type.cnpj", padrao: "CNPJ" },
  { id: "cpf", guarda: "texto", icone: "IdCard", rotulo: "customFields.type.cpf", padrao: "CPF" },
];

const IDS = TIPOS.map((t) => t.id);
const PADRAO = "texto";

// ── OS TIPOS QUE NÃO ENTRARAM, E POR QUÊ ────────────────────────────────
//
// A referência tinha mais três: Arquivo, Arquivos Múltiplos e URL dinâmico.
//
// Os dois de arquivo não são um tipo de campo — são um ANEXO com dono, cota,
// faxina de órfãos e uma rota de leitura autenticada. O produto já tem isso
// para a ficha (`person_documents`), e um campo customizado que guardasse
// arquivo sem essa plumbing deixaria bytes pendurados no banco para sempre.
//
// "URL dinâmico" é um gerador de endereço a partir de outros campos
// (`https://wa.me/{{telefone}}`) — é template, não tipo, e depende de um
// avaliador de expressão que não existe aqui. Os dois voltam quando houver
// pedido de verdade; inventá-los agora seria desenhar no escuro.
const NAO_IMPLEMENTADOS = ["arquivo", "arquivosMultiplos", "urlDinamico"];

function existe(id) {
  return IDS.includes(String(id || ""));
}

function normalizar(id) {
  return existe(id) ? String(id) : PADRAO;
}

function dados(id) {
  return TIPOS.find((t) => t.id === normalizar(id));
}

// Como ESTE tipo guarda o valor. É o que o gravador do valor consulta.
function comoGuarda(id) {
  return dados(id).guarda;
}

function pedeOpcoes(id) {
  return Boolean(dados(id).opcoes);
}

// `padrao` é o rótulo de quem não tem tradutor — o painel da central é interno
// e em português. Mesma saída de `categoriasDeConta` e `funilDeLeads`: o
// catálogo carrega o texto de reserva em vez de existir uma segunda lista.
function paraTela(t) {
  return TIPOS.map((x) => ({
    id: x.id,
    label: t ? t(x.rotulo) : x.padrao || x.rotulo,
    icone: x.icone,
    guarda: x.guarda,
    opcoes: Boolean(x.opcoes),
  }));
}

module.exports = {
  TIPOS,
  IDS,
  PADRAO,
  NAO_IMPLEMENTADOS,
  existe,
  normalizar,
  dados,
  comoGuarda,
  pedeOpcoes,
  paraTela,
};
