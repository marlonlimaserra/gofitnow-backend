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
// ── DOIS TIPOS DE MÓDULO, E A DIFERENÇA É QUEM DECIDE ────────────────────
//
// *"acho melhor eu poder mostrar ou esconder a partir do plano que a pessoa
// faz parte. Assim crio um plano chamado desenvolvimento onde fica tudo
// liberado"* (27/09/2026).
//
// Até aqui os dois portões eram um E: o plano tinha de incluir E a conta tinha
// de liberar pela notícia. Isso serve para LANÇAMENTO — o cliente lê a
// novidade, vê o vídeo e aperta o botão quando quiser.
//
// Não serve para o que ele quer agora, que é o contrário: segurar uma tela
// que ainda não está pronta e liberá-la para si mesmo trocando o plano. Com o
// E, o plano "Desenvolvimento" com tudo dentro não mostraria nada, porque
// nenhuma conta apertou botão nenhum.
//
// Então o catálogo passa a dizer QUEM decide cada módulo:
//
//   `pedeLiberacao: true`   plano E notícia   (Aulões, Financeiro — lançados)
//   `pedeLiberacao: false`  só o plano        (o padrão, e o caso do Marlon)
//
// ── E `semPlano`: O QUE UMA CONTA SEM PLANO TEM ─────────────────────────
//
// Cinco das sete contas não têm plano, e "sem plano" precisa significar
// coisas diferentes:
//
//   `semPlano: true`   faz parte do produto  → tem, até o plano tirar
//   `semPlano: false`  ainda não está pronto → não tem, até o plano dar
//
// Sem essa distinção, transformar os menus do produto em módulos apagaria o
// sistema inteiro das contas sem plano no primeiro deploy — e daria para
// descobrir só quando alguém abrisse o app.
//
// NÃO é o mesmo que `padrao`, que decide com o que uma conta NOVA nasce na
// lista de liberados da notícia. Os dois já quase colidiram: Aulões tem
// `semPlano: true` (quem não tem plano já usa) e `padrao: false` (conta nova
// espera a notícia).
//
// O padrão é `false` porque é o caso comum daqui para a frente: a maioria dos
// módulos novos nasce escondido até estar pronto, e quem decide isso somos
// nós, pelo plano — não o cliente, por um botão numa notícia que ele nunca vai
// ver sobre uma tela que ainda não existe.
// ── `grupo`: ONDE ELE APARECE NA LISTA DA CENTRAL ───────────────────────
//
// *"separe numa categoria chamada 'configuração' pra ser fácil de eu achar"*
// (29/09/2026), com a lista de módulos já passando de trinta itens.
//
// Três grupos, e eles saem de ONDE o módulo esconde alguma coisa:
//
//   `menu`          item da barra lateral
//   `ficha`         seção dentro da ficha da pessoa
//   `configuracao`  seção da tela de Configurações
//
// Um módulo pode esconder nos dois primeiros (Treinos é menu E aba), e aí o
// grupo diz qual é o principal — o lugar por onde a pessoa pensa nele.
const MODULOS = [
  {
    key: "aulao",
    grupo: "menu",
    // Lançado com notícia: o cliente aperta o botão quando quiser.
    pedeLiberacao: true,
    semPlano: true,
    // Os caminhos que este módulo acende na barra lateral. É por caminho e não
    // por permissão de propósito: Aulões e Agenda dividem `schedule.view`, e
    // filtrar por permissão esconderia as duas.
    menus: ["/aulaoes"],
    // Já estava no ar para quem usa quando este arquivo nasceu — ver `semear`.
    padrao: false,
  },
  {
    key: "financeiro",
    grupo: "menu",
    menus: ["/financeiro", "/people/tab/finance"],
    pedeLiberacao: true,
    semPlano: true,
    padrao: false,
  },
  // ── LEADS (01/10/2026) ──────────────────────────────────────────────────
  //
  // *"crie uma nova rota chamada 'lead'. Esses leads vão ser os dados de
  // pessoas que não pagam nada e nem são alunos"*.
  //
  // Nasce FECHADO para todo mundo, e é o caso de uso que `semPlano` existe
  // para atender: `semPlano: false` quer dizer "ainda não está pronto para
  // sair" — as contas sem plano não ganham a tela no deploy, e quem decide
  // quem a vê é o plano, na central.
  //
  // `pedeLiberacao: false` porque não há notícia a dar: notícia é para
  // LANÇAMENTO, e isto ainda não é um. Com `true`, nem o plano
  // "Desenvolvimento" acenderia a tela — faltaria alguém apertar um botão
  // sobre uma funcionalidade que ninguém anunciou.
  {
    key: "leads",
    grupo: "menu",
    menus: ["/leads"],
    pedeLiberacao: false,
    semPlano: false,
    padrao: false,
  },
  // ── REDES SOCIAIS (27/09/2026) ──────────────────────────────────────────
  //
  // *"na central acho que já temos algo para esconder tudo que não está
  // pronto né?"* — temos, e é isto.
  //
  // Conectar Instagram e Página do Facebook está pronto do nosso lado, mas o
  // app da Meta ainda está em modo de desenvolvimento: só quem tem papel no
  // app consegue concluir. Um cliente que clicasse em "Conectar" veria a tela
  // de consentimento recusar, e leria isso como defeito do VAFIT.
  //
  // Os caminhos aqui são SEÇÕES de Configuração, e não itens do menu lateral
  // — foi o primeiro módulo assim. `views/configuration/index.jsx` passou a
  // filtrar pela mesma lista que a barra já usava; o formato do caminho é o
  // da URL, que é o que os dois lados conhecem.
  //
  // ── OS TRÊS FORMATOS DE CAMINHO QUE UM MÓDULO PODE LISTAR ────────────
  //
  //   `/algo`                 item do menu lateral      (o original)
  //   `/configuration/algo`   seção de Configuração     (27/09/2026)
  //   `/people/tab/algo`      aba dentro da ficha       (27/09/2026)
  //
  // Os três saem da MESMA lista (`user.menusEscondidos`) e são lidos em
  // `components/Sidebar/menuConfig.js`. O terceiro tem o `tab/` no meio de
  // propósito: a ficha mora em `/people/:id`, e `/people/exam` seria ambíguo
  // com o id de alguém.
  {
    key: "redesSociais",
    grupo: "configuracao",
    menus: ["/configuration/instagram", "/configuration/facebook"],
    // Sem notícia: quem decide é o PLANO. Não há o que anunciar enquanto o
    // app da Meta estiver em modo de desenvolvimento.
    pedeLiberacao: false,
    // E sem plano não aparece: é o ponto de segurar o que não está pronto.
    semPlano: false,
    padrao: false,
  },

  // ── OS MENUS DO PRODUTO (27/09/2026) ────────────────────────────────────
  //
  // *"aqui tem tudo isso... ali tem pouco"*, com o print da barra lateral de
  // onze itens ao lado da lista de três módulos. Ele está certo: se o plano é
  // quem decide o que o cliente vê, ele tem de alcançar o que existe — não só
  // os dois que por acaso nasceram com notícia.
  //
  // Todos com `semPlano: true`: fazem parte do produto, e conta sem plano
  // continua com tudo. O plano SUBTRAI — é assim que um plano de entrada fica
  // menor sem que ninguém perca nada por omissão.
  //
  // E sem `pedeLiberacao`: não há notícia para "Treinos", que existe desde o
  // primeiro dia. Marcar no plano basta.
  //
  // ── O QUE NÃO ESTÁ AQUI, E POR QUÊ ──────────────────────────────────────
  //
  // O DASHBOARD (`/`) não entra: é para onde o app leva depois de entrar e
  // onde todo caminho errado cai. Um plano sem ele deixaria a pessoa numa
  // tela em branco ao fazer login, sem nada para clicar.
  //
  // PESSOAS (`/people`) também não: é o cadastro de quem a casa atende, o
  // objeto de todo o resto. Um sistema de treino sem a lista de alunos não é
  // um plano menor, é um produto quebrado — e o que se quer limitar ali é a
  // QUANTIDADE, que já é limite de plano.
  { grupo: "menu", key: "treinos", menus: ["/workouts", "/people/tab/workouts"], semPlano: true, padrao: false },
  { grupo: "menu", key: "dietas", menus: ["/dietas", "/people/tab/diet"], semPlano: true, padrao: false },
  { grupo: "menu", key: "avaliacoes", menus: ["/avaliacoes", "/people/tab/assessment"], semPlano: true, padrao: false },
  { grupo: "menu", key: "agenda", menus: ["/agenda", "/people/tab/schedule"], semPlano: true, padrao: false },
  { grupo: "menu", key: "aulasColetivas", menus: ["/aulas", "/people/tab/classes"], semPlano: true, padrao: false },
  { grupo: "menu", key: "contasAPagar", menus: ["/contas"], semPlano: true, padrao: false },
  { grupo: "menu", key: "funcionarios", menus: ["/funcionarios"], semPlano: true, padrao: false },
  { grupo: "menu", key: "estrutura", menus: ["/estrutura"], semPlano: true, padrao: false },

  // ── O QUE SÓ EXISTE DENTRO DA FICHA ─────────────────────────────────────
  //
  // *"entrei no aluno e ainda aparece tudo"* (27/09/2026), com o print das
  // catorze abas. Os módulos escondiam MENUS, e a ficha tem chaves próprias
  // — a ponte estava faltando.
  //
  // Os de cima ganharam a aba correspondente (Treinos esconde o menu E a aba
  // de treino do aluno; é o mesmo recurso visto de dois lugares). Estes aqui
  // não têm menu nenhum: vivem só na ficha, e por isso são módulos próprios.
  //
  // Ficam de fora HISTÓRICO e PENDÊNCIAS: não são recursos que um plano
  // vende, são a leitura do que já existe. Um plano sem histórico esconderia
  // a auditoria de quem mexeu na ficha, o que é outra conversa — e a errada.
  { grupo: "ficha", key: "suplementacao", menus: ["/people/tab/supplement"], semPlano: true, padrao: false },
  { grupo: "ficha", key: "prescricoes", menus: ["/people/tab/prescription"], semPlano: true, padrao: false },
  { grupo: "ficha", key: "anamnese", menus: ["/people/tab/anamnesis"], semPlano: true, padrao: false },
  { grupo: "ficha", key: "exames", menus: ["/people/tab/exam"], semPlano: true, padrao: false },
  { grupo: "ficha", key: "frequencia", menus: ["/people/tab/frequency"], semPlano: true, padrao: false },
  { grupo: "ficha", key: "documentos", menus: ["/people/tab/documents"], semPlano: true, padrao: false },

  // ── CADA SEÇÃO DE CONFIGURAÇÃO (29/09/2026) ────────────────────────────
  //
  // *"coloque cada item desse aqui também, na parte de módulos incluídos"*,
  // com o print da coluna de Configurações — vinte e quatro seções, e o plano
  // alcançava duas.
  //
  // Todas com `semPlano: true`: fazem parte do produto. O plano SUBTRAI.
  //
  // O prefixo `cfg` nas chaves não é enfeite: `plans` já é o plano do
  // PRODUTO, `users` já é gente, `system` é ambíguo. Sem ele, uma chave de
  // seção colidiria com uma de menu — e chave de módulo é contrato, fica
  // gravada no documento do plano.
  //
  // Instagram e Facebook NÃO estão aqui: os dois já são o módulo
  // `redesSociais`, que os esconde em par. Duas chaves para a mesma tela
  // deixariam metade acesa quando alguém desmarcasse só uma.
  { grupo: "configuracao", key: "cfgServicos", menus: ["/configuration/services"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgPlanos", menus: ["/configuration/plans"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgUnidades", menus: ["/configuration/units"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgAulasColetivas", menus: ["/configuration/group-classes"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgAgendaPublica", menus: ["/configuration/public-booking"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgModelosDeDocumento", menus: ["/configuration/document-templates"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgTemplatesDeTreino", menus: ["/configuration/templates"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgTemplatesDeDieta", menus: ["/configuration/diet-templates"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgMeusExercicios", menus: ["/configuration/my-exercises"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgFotosDaAvaliacao", menus: ["/configuration/assessment-photos"], semPlano: true, padrao: false },
  // CAMPOS CUSTOMIZADOS (01/10/2026). `semPlano: false`, ao contrário dos
  // vizinhos: os outros já estavam no ar quando este arquivo nasceu, e tirá-los
  // de quem usa seria quebrar a casa. Este é novo — só aparece onde o plano
  // disser.
  { grupo: "configuracao", key: "cfgCamposCustomizados", menus: ["/configuration/custom-fields"], semPlano: false, padrao: false },
  { grupo: "configuracao", key: "cfgAutoPreencher", menus: ["/configuration/auto-fill"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgIndicacao", menus: ["/configuration/affiliate"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgSistema", menus: ["/configuration/system"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgEndereco", menus: ["/configuration/address"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgAparencia", menus: ["/configuration/appearance"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgUsuarios", menus: ["/configuration/users"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgTiposDeUsuario", menus: ["/configuration/roles"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgGruposDePermissao", menus: ["/configuration/permission-groups"], semPlano: true, padrao: false },
  // DEPARTAMENTOS (02/10/2026). Nasce fechado, como todo módulo novo: só
  // aparece onde o plano disser. Ver `semPlano` no cabeçalho.
  { grupo: "configuracao", key: "cfgDepartamentos", menus: ["/configuration/departments"], semPlano: false, padrao: false },
  { grupo: "configuracao", key: "cfgLogs", menus: ["/configuration/logs"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgChavesDeApi", menus: ["/configuration/api-keys"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgDocumentacao", menus: ["/configuration/api-docs"], semPlano: true, padrao: false },
  { grupo: "configuracao", key: "cfgChamadas", menus: ["/configuration/api-calls"], semPlano: true, padrao: false },
];

const CHAVES = MODULOS.map((m) => m.key);

// Todo caminho que está sob controle de algum módulo. A barra lateral usa isto
// para saber o que NÃO filtrar: um caminho que não é de módulo nenhum aparece
// sempre, e é a maioria deles.
const MENUS_CONTROLADOS = MODULOS.flatMap((m) => m.menus);

function existe(chave) {
  return CHAVES.includes(String(chave));
}

// Este módulo espera o cliente apertar o botão da notícia?
//
// Desconhecido responde `false`: uma chave que não está no catálogo não vira
// menu de jeito nenhum (ver `menusEscondidos`), então a resposta aqui não
// muda nada — e `false` é o padrão do catálogo.
function pedeLiberacao(chave) {
  const m = MODULOS.find((x) => x.key === String(chave));
  return Boolean(m && m.pedeLiberacao);
}

// Uma conta SEM plano tem este módulo? Ver o cabeçalho da lista.
//
// Desconhecido responde `false` pelo mesmo motivo de `pedeLiberacao`: chave
// fora do catálogo não vira menu de jeito nenhum.
function temSemPlano(chave) {
  const m = MODULOS.find((x) => x.key === String(chave));
  return Boolean(m && m.semPlano);
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

module.exports = {
  MODULOS,
  CHAVES,
  MENUS_CONTROLADOS,
  existe,
  pedeLiberacao,
  temSemPlano,
  menusEscondidos,
  padroes,
};
