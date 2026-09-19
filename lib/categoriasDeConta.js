// AS CATEGORIAS DE UMA CONTA A PAGAR.
//
// *"crie mais um módulo chamado de contas a pagar para lançar conta de luz,
// telefone etc… por unidade também"*.
//
// ── POR QUE UMA LISTA FECHADA, e não texto livre ────────────────────────
//
// Porque a pergunta que a tela existe para responder é "para onde vai o meu
// dinheiro", e ela só tem resposta se as linhas se agruparem. Com campo livre,
// "Luz", "Energia", "CPFL" e "conta de luz" viram quatro categorias, e o
// relatório do mês não soma nada.
//
// A lista é a do custo de uma academia pequena, e cabe numa tela sem rolagem.
// Quem tiver algo que não está aqui usa `outros` e escreve na descrição — o que
// é melhor que uma lista de trinta itens em que ninguém acha o certo.
//
// ── ELA VEM DO SERVIDOR, JÁ TRADUZIDA ───────────────────────────────────
//
// O mesmo caminho dos estados da cobrança e das cadências: *"coloque esse
// status, em uma variável no backend, assim se a gente adicionar um status
// novo, a chamada já traz, e não precisa mexer em nada do frontend"*.
//
// `icone` é o nome do ícone do lucide, resolvido na tela. Não é enfeite: numa
// lista de trinta contas do mês, o ícone é o que separa a luz do aluguel antes
// de qualquer leitura.
const CATEGORIAS = [
  { id: "aluguel", icone: "Building2", rotulo: "payables.category.aluguel", padrao: "Aluguel" },
  { id: "energia", icone: "Zap", rotulo: "payables.category.energia", padrao: "Energia" },
  { id: "agua", icone: "Droplets", rotulo: "payables.category.agua", padrao: "Água" },
  { id: "internet", icone: "Wifi", rotulo: "payables.category.internet", padrao: "Internet" },
  { id: "telefone", icone: "Phone", rotulo: "payables.category.telefone", padrao: "Telefone" },
  // FOLHA é o custo que costuma ser o maior de todos, e o mais sensível: é ele
  // que faz valer a pena um dia separar quem vê contas a pagar de quem vê o
  // financeiro dos alunos.
  { id: "folha", icone: "Users", rotulo: "payables.category.folha", padrao: "Folha de pagamento" },
  { id: "impostos", icone: "Landmark", rotulo: "payables.category.impostos", padrao: "Impostos" },
  // ── AS CINCO QUE ENTRARAM COM O CATÁLOGO (19/09/2026) ─────────────────
  //
  // O catálogo de fornecedores conhecidos jogou trinta nomes em "Outros" — gás,
  // maquininha, banco, seguro, contabilidade, alarme. E "Outros" virando a
  // maior barra do relatório é o relatório não respondendo nada: a pergunta é
  // *"para onde vai o meu dinheiro"*, e "para outros" não é resposta.
  //
  // São cinco, e não quinze: cada uma tem pelo menos meia dúzia de fornecedores
  // conhecidos atrás dela. Categoria com um nome só é categoria que ninguém
  // acha na lista.
  { id: "gas", icone: "Flame", rotulo: "payables.category.gas", padrao: "Gás" },
  // A TAXA que sai descontada do repasse, e não chega como boleto. Sem uma
  // linha própria ela some — e é o custo que mais cresce quando a academia
  // passa a vender por cartão.
  { id: "taxas", icone: "CreditCard", rotulo: "payables.category.taxas", padrao: "Taxas bancárias e de cartão" },
  { id: "seguro", icone: "ShieldCheck", rotulo: "payables.category.seguro", padrao: "Seguro" },
  { id: "contabilidade", icone: "Calculator", rotulo: "payables.category.contabilidade", padrao: "Contabilidade" },
  { id: "seguranca", icone: "Lock", rotulo: "payables.category.seguranca", padrao: "Segurança" },
  { id: "fornecedor", icone: "Truck", rotulo: "payables.category.fornecedor", padrao: "Fornecedor" },
  { id: "manutencao", icone: "Wrench", rotulo: "payables.category.manutencao", padrao: "Manutenção" },
  { id: "equipamento", icone: "Dumbbell", rotulo: "payables.category.equipamento", padrao: "Equipamento" },
  { id: "marketing", icone: "Megaphone", rotulo: "payables.category.marketing", padrao: "Marketing" },
  { id: "software", icone: "Monitor", rotulo: "payables.category.software", padrao: "Software" },
  { id: "outros", icone: "Receipt", rotulo: "payables.category.outros", padrao: "Outros" },
];

const IDS = CATEGORIAS.map((c) => c.id);
const PADRAO = "outros";

function existe(id) {
  return IDS.includes(String(id || ""));
}

// O que não existe vira `outros`, e não vazio: uma conta sem categoria some do
// relatório por categoria, que é o relatório inteiro.
function normalizar(id) {
  return existe(id) ? String(id) : PADRAO;
}

// Os PEDIDOS pela tela, em texto separado por vírgula. O que não existe cai
// fora — o valor entra num `$in`, e aceitar o que vier é deixar a tela escolher
// por qual chave o banco filtra.
function pedidos(bruto) {
  return String(bruto || "")
    .split(",")
    .map((x) => x.trim())
    .filter(existe);
}

// ── `padrao`: O RÓTULO DE QUEM NÃO TEM TRADUTOR ──────────────────────────
//
// O backend do cliente traduz por `rotulo`, nos quatro idiomas. O PAINEL não
// tem i18n — ele é interno e é em português —, e chamava `paraTela()` sem `t`.
// O resultado foi a tela do catálogo mostrando "payables.category.agua" em
// dezenove linhas.
//
// A saída não é uma segunda lista no painel: seria a lista que diverge. É o
// próprio catálogo carregar o texto de reserva, e quem tem tradutor continuar
// ignorando-o.
function paraTela(t) {
  return CATEGORIAS.map((c) => ({
    id: c.id,
    label: t ? t(c.rotulo) : c.padrao || c.rotulo,
    icone: c.icone,
  }));
}

module.exports = { CATEGORIAS, IDS, PADRAO, existe, normalizar, pedidos, paraTela };
