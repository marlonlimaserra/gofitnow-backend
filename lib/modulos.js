// OS MÓDULOS QUE PRECISAM SER LIBERADOS.
//
// *"sempre que eu lançar um módulo novo... na central precisamos da tela de
// notícia... e aí na notícia vai ter um botão chamado liberar módulo, aí só
// habilita os menus."*
//
// ── O PROBLEMA QUE ISTO RESOLVE ───────────────────────────────────────────
//
// Um módulo novo aparecia no menu de todo mundo no deploy. O cliente entrava de
// manhã e tinha uma tela a mais, sem saber o que era nem para que servia — e a
// documentação e o vídeo que explicam existiam, mas em nenhum lugar que ele
// fosse olhar.
//
// Agora a ordem é a inversa: a notícia chega primeiro, com o vídeo e o link; o
// cliente lê, entende, e libera quando quiser. Menu que ninguém pediu não
// acende.
//
// ── POR QUE NÃO É PERMISSÃO ───────────────────────────────────────────────
//
// Foi a primeira ideia, e ela não funciona. `ensureSystemRoles` força a sincronia
// do papel Administrador com `permissions.ALL` a cada boot (ver database/schema.js
// — "é o que faz um deploy alcançar clientes criados depois da última versão").
// A permissão de um módulo novo já está concedida quando o deploy termina; não
// há o que liberar.
//
// E isso está certo como está: permissão responde "quem nesta conta pode", e a
// resposta não deve depender de alguém ter visto um aviso. Liberação responde
// "esta conta usa este módulo" — outra pergunta, outro lugar.
//
// As duas continuam valendo juntas: a barra lateral esconde o que não foi
// liberado, e a rota recusa quem não tem permissão. Esconder menu nunca foi
// proteção (ver menuConfig.js).
//
// ── `padrao`: O MÓDULO QUE DEIXOU DE SER NOVIDADE ─────────────────────────
//
// Um módulo nasce com `padrao: false` — ninguém o tem até liberar. Passado o
// lançamento, quando ele virou parte do produto e não uma novidade para
// apresentar, viram `padrao: true` e toda conta NOVA nasce com ele aceso.
//
// Sem essa distinção, um cliente que assinasse em 2027 abriria o app sem
// Financeiro, esperando uma notícia de 2026 que ele nunca vai ver.
//
// ── A LISTA É UM CONTRATO ─────────────────────────────────────────────────
//
// Uma chave daqui é gravada no documento da conta que a liberou. Renomear uma
// apagaria a liberação de quem já tinha — o mesmo motivo pelo qual chave de
// permissão nunca muda. Para aposentar um módulo, tire-o daqui: o menu volta a
// aparecer para todos, que é o comportamento de antes deste arquivo.
//
// O `center-backend` tem uma cópia desta lista de chaves, em
// `lib/modulosDoProduto.js`, porque o painel precisa oferecê-las num campo de
// escolha. É a mesma decisão do formato das ideias e dos chamados: o que se
// compartilha entre os dois projetos é o FORMATO, nunca um `require`
// atravessando deploys (ver Idea_model.js).
const MODULOS = [
  {
    key: "aulao",
    // Os caminhos que este módulo acende na barra lateral. É por caminho e não
    // por permissão de propósito: Aulões e Agenda dividem `schedule.view`, e
    // filtrar por permissão esconderia as duas.
    menus: ["/aulaoes"],
    // Já estava no ar para quem usa quando este arquivo nasceu — ver `semear`.
    padrao: false,
  },
  {
    key: "financeiro",
    menus: ["/financeiro"],
    padrao: false,
  },
];

const CHAVES = MODULOS.map((m) => m.key);

// Todo caminho que está sob controle de algum módulo. A barra lateral usa isto
// para saber o que NÃO filtrar: um caminho que não é de módulo nenhum aparece
// sempre, e é a maioria deles.
const MENUS_CONTROLADOS = MODULOS.flatMap((m) => m.menus);

function existe(chave) {
  return CHAVES.includes(String(chave));
}

// Quais caminhos ficam escondidos, dada a lista do que a conta liberou.
function menusEscondidos(liberados) {
  const tem = new Set(Array.isArray(liberados) ? liberados.map(String) : []);
  return MODULOS.filter((m) => !tem.has(m.key)).flatMap((m) => m.menus);
}

// Com que módulos uma conta NOVA nasce.
function padroes() {
  return MODULOS.filter((m) => m.padrao).map((m) => m.key);
}

module.exports = { MODULOS, CHAVES, MENUS_CONTROLADOS, existe, menusEscondidos, padroes };
