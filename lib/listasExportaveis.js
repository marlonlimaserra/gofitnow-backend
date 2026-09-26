const { rotulos } = require("./rotulosDeDocumento.js");
const {
  FRACO, dinheiro, escapar, formatarData, formatarDataHora, pagina,
} = require("./documentoBase.js");
const cat = require("./catalogosDeEstrutura.js");
const vinculos = require("./vinculosDeTrabalho.js");
const { somenteEscolhidos } = require("./recorteDeIds.js");
const statusDePagamento = require("./statusDePagamento.js");
const tiposDeOcorrencia = require("./tiposDeOcorrencia.js");
const categoriasDeConta = require("./categoriasDeConta.js");
const statusDeCobranca = require("./statusDeCobranca.js");
const { weekdaysOf } = require("./weekdays.js");
const { TETO_DE_EXPORTACAO } = require("./tetoDaLista.js");

// AS LISTAS QUE SE LEVAM EMBORA — uma definição, todos os aplicativos.
//
// *"acho melhor o xlsx e pdf sempre serem gerados pelo backend, assim
// garantimos que sempre vai ser igual em todos os apps"* (23/09/2026).
//
// Ele está certo, e o contra-exemplo é o próprio painel: lá cada tela descreve
// as colunas dela em JavaScript, ao lado do componente. Funciona enquanto há um
// cliente só. Com dois, a mesma planilha passa a existir em dois lugares e
// diverge no primeiro ajuste — e ninguém percebe até alguém receber dois
// arquivos diferentes da mesma lista.
//
// Aqui a lista é descrita UMA vez: quem pode ver, como buscar as linhas, quais
// são as colunas e como cada célula se escreve. As duas saídas (planilha e
// papel) leem a mesma descrição, e qualquer cliente que peça recebe o mesmo
// arquivo.
//
// ── COMO UMA LISTA SE DESCREVE ────────────────────────────────────────────
//
//   permissao   a chave que o servidor exige — a MESMA da tela.
//   titulo(t)   o nome da aba e o título do papel.
//   linhas(…)   busca as linhas, já respeitando os filtros e os marcados.
//   colunas(…)  rótulo, largura e como escrever a célula.
//
// As duas últimas recebem o mesmo CONTEXTO, montado uma vez pela rota:
// `t` (os rótulos no idioma de quem lê), `lang`, `fuso`, `moeda`, `words` (o
// vocabulário da casa), `nomeDaUnidade`, `user` e `query`. `colunas` recebe
// ainda as `linhas` já buscadas — é o que permite esconder a coluna de unidade
// quando a casa tem uma só.
//
// Uma célula devolve texto, número ou `{ data }`. `{ data }` vira data DE
// VERDADE na planilha: data como texto não ordena nem entra em conta, e "14/03"
// exportado daqui e aberto num Excel americano seria lido como 3 de fevereiro.
//
// ── DINHEIRO SAI COMO NÚMERO ──────────────────────────────────────────────
//
// `{ dinheiro: 260000 }` vira 2600,00 na planilha, com o formato na coluna, e
// "R$ 2.600,00" no papel. O painel escrevia texto em três das suas exportações
// ("a planilha é para uma pessoa ler"), e é meia verdade: quem abre uma lista
// de dinheiro no Excel abre para SOMAR, e uma coluna de strings não soma nem
// ordena. No papel o texto é o mesmo dos dois jeitos.
const LISTAS = {
  // ── PESSOAS ────────────────────────────────────────────────────────────
  //
  // As colunas são as do PAPEL do painel (`views/students/planilha.js`), e não
  // as da importação: senha não faz sentido numa lista que se leva para uma
  // reunião, e unidade e situação fazem.
  pessoas: {
    permissao: "people.view",
    titulo: (t, words) => words.Plural || t("menu.people"),

    async linhas(app, { user, query }) {
      const r = await app.api.user.pageStudents(user._id, {
        ids: query.ids,
        search: query.search,
        active: query.active,
        access: query.access,
        unit: query.unit,
        // Os outros dois recortes da tela. Faltavam aqui, e o efeito era o
        // arquivo discordar do que estava à vista: filtrar "sem treino", pedir
        // a planilha e receber a base inteira.
        workout: query.workout,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
        sort: query.sort,
        dir: query.dir,
        // A lista INTEIRA do recorte, e não uma página: quem exporta quer o
        // que o filtro diz, não os vinte primeiros que couberam na tela.
        // `exportando` é o que solta o teto de 200 — ver `lib/tetoDaLista.js`.
        page: 1,
        exportando: true,
      });

      return r.rows || [];
    },

    colunas(t, { words, nomeDaUnidade }) {
      return [
        { rotulo: words.Singular || t("import.colName"), largura: 28, valor: (p) => p.name || "" },
        { rotulo: t("unidade.one"), largura: 18, valor: (p) => nomeDaUnidade(p.unit) },
        { rotulo: t("import.colPhone"), largura: 18, valor: (p) => p.phone || "" },
        { rotulo: t("import.colEmail"), largura: 28, valor: (p) => p.email || "" },
        { rotulo: t("import.colGoal"), largura: 24, valor: (p) => p.goal || "" },
        {
          rotulo: t("people.access"),
          largura: 16,
          valor: (p) => t(p.hasAccess ? "people.accessGranted" : "people.recordOnly"),
        },
        {
          rotulo: t("people.status"),
          largura: 12,
          valor: (p) => t(p.active ? "common.active" : "common.inactive"),
        },
      ];
    },
  },

  // ── TREINOS ────────────────────────────────────────────────────────────
  //
  // A lista GERAL, de todo mundo — a que responde "o que eu montei
  // ultimamente". Por isso a segunda coluna é a PESSOA: num apanhado que
  // mistura a casa inteira, "de quem é" identifica melhor que "como se chama"
  // — um treino chamado "Segunda-feira" não identifica nada.
  treinos: {
    permissao: "workouts.view",
    titulo: (t) => t("allWorkouts.title"),

    async linhas(app, { user, query }) {
      const r = await app.api.workout.pageAll(user._id, {
        ids: query.ids,
        search: query.search,
        studentId: query.personId,
        unit: query.unit,
        status: query.status,
        sort: query.sort,
        dir: query.dir,
        page: 1,
        exportando: true,
      });

      return r.rows || [];
    },

    colunas(t, { nomeDaUnidade }) {
      const STATUS = {
        current: "workouts.statusCurrent",
        past: "workouts.statusPast",
        future: "workouts.statusFuture",
      };

      return [
        { rotulo: t("workouts.name"), largura: 30, valor: (w) => w.name || "" },
        { rotulo: t("allWorkouts.person"), largura: 26, valor: (w) => w.personName || "" },
        // A UNIDADE vai SEMPRE, mesmo com a coluna desligada na tela: a
        // planilha sai da tela para virar outra coisa (um filtro no Excel, um
        // relatório por unidade), e lá a coluna a mais não custa largura.
        { rotulo: t("unidade.one"), largura: 20, valor: (w) => nomeDaUnidade(w.personUnit) },
        { rotulo: t("workouts.goal"), largura: 22, valor: (w) => w.goal || "" },
        { rotulo: t("workouts.teacher"), largura: 20, valor: (w) => w.teacherName || "" },
        { rotulo: t("people.status"), largura: 12, valor: (w) => (STATUS[w.status] ? t(STATUS[w.status]) : "") },
        { rotulo: t("workouts.start"), largura: 14, valor: (w) => ({ data: w.startDate }) },
        { rotulo: t("workouts.end"), largura: 14, valor: (w) => ({ data: w.endDate }) },
        // Os dias por extenso e não as chaves em inglês: isto é para uma
        // pessoa ler, e "monday,friday" não é como ninguém escreve.
        { rotulo: t("workouts.weekdays"), largura: 24, valor: (w) => diasDaSemana(t, w.weekdays) },
        { rotulo: t("exercises.title"), largura: 12, direita: true, valor: (w) => w.exerciseCount ?? 0 },
        { rotulo: t("allWorkouts.colSets"), largura: 12, direita: true, valor: (w) => w.setCount ?? 0 },
        { rotulo: t("people.createdAtLong"), largura: 18, valor: (w) => ({ dataHora: w.createdAt }) },
      ];
    },
  },

  // ── FUNCIONÁRIOS ───────────────────────────────────────────────────────
  //
  // *"e aqui, faltou coluna unidade e exportar xlsx / imprimir salvar pdf"*.
  //
  // Sem CPF de propósito: a listagem não o manda, e ele fica na ficha junto de
  // PIS e conta bancária, porque não se despeja documento de trinta pessoas na
  // rede para desenhar uma tabela. Uma coluna que nunca preenche é pior que
  // coluna nenhuma — quem abre conclui que o cadastro está vazio.
  funcionarios: {
    permissao: "employees.view",
    titulo: (t) => t("employees.title"),

    async linhas(app, { user, query }) {
      const r = await app.api.employee.listar({
        ids: query.ids,
        busca: query.search,
        situacao: query.situacao,
        bond: query.bond,
        unit: query.unit,
        semUnidade: query.semUnidade === "1",
        ordem: query.sort,
        direcao: query.dir,
        pagina: 1,
        exportando: true,
      });

      // Sem permissão de FOLHA, o salário nem sai do banco para a memória
      // desta requisição. Esconder a coluna bastaria para a planilha, e não
      // basta para o princípio: uma planilha que vaza salário é pior que uma
      // coluna que vaza, porque ela sai do sistema e vira arquivo no
      // computador de alguém.
      if (podeVerFolha(user)) return r.rows || [];

      return (r.rows || []).map(({ salary, salaryKind, ...resto }) => resto);
    },

    colunas(t, { user, moeda, linhas, nomeDaUnidade }) {
      const comUnidade = linhas.some((f) => nomeDaUnidade(f.unit));
      const vinculo = catalogoPorId(vinculos.paraTela(t));

      return [
        { rotulo: t("employees.colName"), largura: 28, valor: (f) => f.name || "" },
        { rotulo: t("employees.fieldNickname"), largura: 18, valor: (f) => f.nickname || "" },
        ...(comUnidade
          ? [{ rotulo: t("unidade.one"), largura: 20, valor: (f) => nomeDaUnidade(f.unit) }]
          : []),
        { rotulo: t("employees.colRole"), largura: 22, valor: (f) => f.role || "" },
        { rotulo: t("employees.colBond"), largura: 14, valor: (f) => vinculo(f.bond) },
        { rotulo: t("employees.colAdmitted"), largura: 14, valor: (f) => ({ data: f.admittedAt }) },
        {
          rotulo: t("employees.colStatus"),
          largura: 16,
          valor: (f) => (f.situacao ? t("employees.status." + f.situacao) : ""),
        },
        { rotulo: t("employees.fieldPhone"), largura: 18, valor: (f) => f.phone || "" },
        { rotulo: t("employees.fieldWhatsapp"), largura: 18, valor: (f) => f.whatsapp || "" },
        { rotulo: t("employees.fieldEmail"), largura: 28, valor: (f) => f.email || "" },
        ...(podeVerFolha(user)
          ? [
              {
                rotulo: t("employees.colSalary"),
                largura: 16,
                direita: true,
                valor: (f) => (f.salary ? { dinheiro: f.salary, moeda } : ""),
              },
            ]
          : []),
      ];
    },
  },

  // ── O HISTÓRICO DE UM FUNCIONÁRIO ──────────────────────────────────────
  //
  // *"em histórico, na parte de funcionário, faça filtros de data, toda parte
  // de checkbox e os botões de exportar"* (24/09/2026).
  //
  // Férias, atestado, advertência, anotação, reajuste — a vida do vínculo. É a
  // lista que mais viaja para fora do sistema: ela vai para a contabilidade, vai
  // para o advogado, e é a que sustenta uma conversa difícil.
  //
  // ── O SALÁRIO OBEDECE À CHAVE DA FOLHA ────────────────────────────────
  //
  // O REAJUSTE carrega dinheiro. Sem `employees.payroll` ele continua na
  // história — "houve um aumento em março" não é segredo —, mas sem o valor. É
  // a mesma regra da rota da tela; esconder a linha inteira faria a história
  // mentir por omissão, e mostrar o valor seria a planilha vazando salário.
  historicoDoFuncionario: {
    permissao: "employees.view",
    titulo: (t) => t("employees.tabHistory"),

    async linhas(app, { user, query }) {
      const r = await app.api.employeeRecord.listar({
        employee: query.employeeId,
        tipo: query.tipo,
        de: query.de,
        ate: query.ate,
        limite: 500,
      });

      const rows = somenteEscolhidos(r.rows || [], query.ids);

      return podeVerFolha(user) ? rows : rows.map((x) => ({ ...x, amount: 0 }));
    },

    colunas(t, { user, moeda, linhas }) {
      const tipo = catalogoPorId(tiposDeOcorrencia.paraTela(t));
      const gravidade = catalogoPorId(tiposDeOcorrencia.gravidadesParaTela(t));

      // As colunas que só existem quando há o que mostrar. Uma coluna
      // "Gravidade" em branco numa lista sem advertência nenhuma parece
      // cadastro incompleto — e são cinco colunas de largura que o papel não
      // tem de sobra.
      const temAte = linhas.some((r) => r.ate);
      const temGravidade = linhas.some((r) => r.gravidade);
      const temFalta = linhas.some((r) => r.tipo === "falta");
      const temDinheiro = podeVerFolha(user) && linhas.some((r) => r.amount);

      return [
        { rotulo: t("employees.recordDate"), largura: 14, valor: (r) => ({ data: r.data }) },
        ...(temAte ? [{ rotulo: t("employees.recordUntil"), largura: 14, valor: (r) => ({ data: r.ate }) }] : []),
        { rotulo: t("employees.recordType"), largura: 18, valor: (r) => tipo(r.tipo) },
        ...(temGravidade
          ? [{ rotulo: t("employees.severity"), largura: 14, valor: (r) => (r.gravidade ? gravidade(r.gravidade) : "") }]
          : []),
        { rotulo: t("employees.recordText"), largura: 46, valor: (r) => r.texto || "" },
        ...(temFalta
          ? [
              {
                rotulo: t("employees.excusedLabel"),
                largura: 18,
                // Só para a FALTA: "não justificada" numa linha de férias seria
                // uma afirmação sobre coisa nenhuma.
                valor: (r) =>
                  r.tipo === "falta" ? t(r.justificada ? "employees.excused" : "employees.unexcused") : "",
              },
            ]
          : []),
        ...(temDinheiro
          ? [
              {
                rotulo: t("employees.colSalary"),
                largura: 16,
                direita: true,
                valor: (r) => (r.amount ? { dinheiro: r.amount, moeda } : ""),
              },
            ]
          : []),
        {
          // A CIÊNCIA é o que sustenta a advertência: sem a assinatura, ela não
          // sustenta nada depois. Por isso ela é coluna, e não detalhe.
          rotulo: t("employees.acknowledgedLabel"),
          largura: 22,
          valor: (r) => (r.ciente ? t("common.yes") : t("common.no")),
        },
        { rotulo: t("employees.colName"), largura: 22, valor: (r) => r.createdByName || "" },
      ];
    },
  },

  // ── EQUIPAMENTOS ───────────────────────────────────────────────────────
  //
  // *"checkbox para poder exportar tudo seguindo esse padrão"*.
  equipamentos: {
    permissao: "structure.view",
    titulo: (t) => t("structure.cardEquipment"),

    async linhas(app, { query }) {
      const rows = await app.api.equipment.listar({
        busca: query.search,
        categoria: query.categoria,
        estado: query.estado,
        unit: query.unit,
        semUnidade: query.semUnidade === "1",
      });

      // O recorte por marcados acontece aqui, e não no banco: este catálogo
      // vem inteiro (são dezenas de aparelhos, não milhares de linhas), e ir
      // ao banco de novo só para peneirar seria uma consulta paga por nada.
      return somenteEscolhidos(rows, query.ids);
    },

    colunas(t, { moeda, linhas, nomeDaUnidade }) {
      const comUnidade = linhas.some((e) => nomeDaUnidade(e.unit));
      const categoria = catalogoPorId(cat.paraTela(cat.EQUIPAMENTOS, t));
      const estado = catalogoPorId(cat.paraTela(cat.ESTADOS, t));

      return [
        { rotulo: t("structure.colEquipment"), largura: 28, valor: (e) => e.name || "" },
        { rotulo: t("structure.fieldBrand"), largura: 18, valor: (e) => e.marca || "" },
        { rotulo: t("structure.fieldModel"), largura: 18, valor: (e) => e.modelo || "" },
        { rotulo: t("structure.fieldSerial"), largura: 20, valor: (e) => e.serie || "" },
        ...(comUnidade
          ? [{ rotulo: t("unidade.one"), largura: 18, valor: (e) => nomeDaUnidade(e.unit) }]
          : []),
        { rotulo: t("structure.colCategory"), largura: 18, valor: (e) => categoria(e.categoria) },
        // `local`, e não `onde`. O painel escrevia `e.onde` aqui e a coluna
        // saía VAZIA em toda planilha e em toda folha — o campo se chama
        // `local` desde sempre. O mesmo com o gasto, que ele lia de
        // `custoTotal` em vez de `gastoEmManutencao`. Um nome errado não
        // levanta erro nenhum: sai em branco, e uma coluna em branco parece
        // cadastro incompleto.
        { rotulo: t("structure.colWhere"), largura: 22, valor: (e) => e.local || "" },
        { rotulo: t("structure.colState"), largura: 16, valor: (e) => estado(e.estado) },
        { rotulo: t("structure.colMaintenance"), largura: 16, valor: (e) => ({ data: e.ultimaManutencao }) },
        {
          rotulo: t("structure.colSpent"),
          largura: 16,
          direita: true,
          valor: (e) => (e.gastoEmManutencao ? { dinheiro: e.gastoEmManutencao, moeda } : ""),
        },
      ];
    },
  },

  // ── ESTOQUE ────────────────────────────────────────────────────────────
  //
  // O insumo é uma QUANTIDADE, e não uma coisa com identidade: o que interessa
  // é o saldo e o dia em que ele chega perto do fim.
  estoque: {
    permissao: "structure.view",
    titulo: (t) => t("structure.cardSupplies"),

    async linhas(app, { query }) {
      const rows = await app.api.supply.listar({
        busca: query.search,
        categoria: query.categoria,
        soFaltando: query.soFaltando === "1",
        unit: query.unit,
      });

      return somenteEscolhidos(rows, query.ids);
    },

    colunas(t) {
      const categoria = catalogoPorId(cat.paraTela(cat.INSUMOS, t));
      const medida = catalogoPorId(cat.paraTela(cat.MEDIDAS, t));

      return [
        { rotulo: t("structure.colSupply"), largura: 28, valor: (i) => i.name || "" },
        { rotulo: t("structure.colCategory"), largura: 18, valor: (i) => categoria(i.categoria) },
        { rotulo: t("structure.colBalance"), largura: 14, direita: true, valor: (i) => i.saldo ?? 0 },
        { rotulo: t("structure.fieldUnit"), largura: 12, valor: (i) => medida(i.medida) },
        { rotulo: t("structure.colMinimum"), largura: 12, direita: true, valor: (i) => i.minimo ?? "" },
        { rotulo: t("structure.colLastMove"), largura: 18, valor: (i) => ({ data: i.ultimoEm }) },
      ];
    },
  },

  // ── O HISTÓRICO DA ESTRUTURA ───────────────────────────────────────────
  //
  // Duas pontas na mesma tabela: a MANUTENÇÃO de um aparelho e o MOVIMENTO de
  // um insumo. Não são a mesma coisa, e é justamente por isso que ficam
  // juntas — a pergunta é "o que aconteceu na estrutura", e responder em duas
  // listas obrigaria a intercalar duas folhas à mão.
  //
  // Elas se misturam ordenadas pelo INSTANTE, e cada uma leva um prefixo no id
  // (`m` de manutenção, `v` de movimento): os dois vêm de coleções diferentes
  // e dois ids iguais marcariam a linha errada.
  historico: {
    permissao: "structure.view",
    titulo: (t) => t("structure.whatHappened"),

    async linhas(app, { query, t, lang, fuso, moeda }) {
      const janela = { de: query.de, ate: query.ate, unit: query.unit };

      const [manutencoes, movimentos] = await Promise.all([
        app.api.equipment.manutencoesNoPeriodo(janela),
        app.api.supply.movimentosNoPeriodo(janela),
      ]);

      const tipo = catalogoPorId(cat.paraTela(cat.MANUTENCOES, t));
      const medida = catalogoPorId(cat.paraTela(cat.MEDIDAS, t));

      const deManutencao = (m) => ({
        id: "m" + m.id,
        instante: new Date(m.data).getTime(),
        titulo: m.equipmentName || t("structure.removedEquipment"),
        // A unidade do APARELHO: a manutenção é dele.
        unit: m.unit,
        quando: formatarData(m.data, lang, fuso),
        detalhe: [tipo(m.tipo), m.descricao, m.fornecedor].filter(Boolean).join(" · "),
        direita: m.custo ? dinheiro(m.custo, moeda) : "",
      });

      const deMovimento = (m) => ({
        id: "v" + m.id,
        instante: new Date(m.em).getTime(),
        titulo: m.supplyName || t("structure.removedSupply"),
        // A unidade do MOVIMENTO: quem consumiu. O insumo em si é da casa.
        unit: m.unit,
        quando: formatarDataHora(m.em, lang, fuso),
        detalhe: [m.motivo, m.porNome, m.custo > 0 && dinheiro(m.custo, moeda)]
          .filter(Boolean)
          .join(" · "),
        direita: (m.quantidade > 0 ? "+" : "") + m.quantidade + " " + medida(m.medida),
      });

      const itens = [...manutencoes.map(deManutencao), ...movimentos.map(deMovimento)].sort(
        (a, b) => b.instante - a.instante
      );

      return somenteEscolhidos(itens, query.ids);
    },

    colunas(t, { linhas, nomeDaUnidade }) {
      const comUnidade = linhas.some((i) => nomeDaUnidade(i.unit));

      return [
        { rotulo: t("structure.colWhen"), largura: 20, valor: (i) => i.quando || "" },
        { rotulo: t("structure.colWhat"), largura: 28, valor: (i) => i.titulo || "" },
        ...(comUnidade
          ? [{ rotulo: t("unidade.one"), largura: 18, valor: (i) => nomeDaUnidade(i.unit) }]
          : []),
        { rotulo: t("structure.colDetail"), largura: 40, valor: (i) => i.detalhe || "" },
        { rotulo: t("structure.colValue"), largura: 16, direita: true, valor: (i) => i.direita || "" },
      ];
    },
  },

  // ── OS FORNECEDORES ────────────────────────────────────────────────────
  //
  // *"bote search, paginação, ordenação de coluna, checkbox para exportar xlsx
  // e pdf"* (24/09/2026), na aba que acabou de nascer.
  //
  // A coluna que justifica a lista é QUANTAS CONTAS cada um tem: sem ela isto é
  // um apanhado de nomes; com ela dá para ver o que é fornecedor de verdade e o
  // que é cadastro criado por engano e nunca usado.
  fornecedores: {
    permissao: "finance.view",
    titulo: (t) => t("suppliers.tab"),

    async linhas(app, { query }) {
      const r = await app.api.supplier.pagina({
        ids: query.ids,
        busca: query.search,
        ordem: query.sort,
        direcao: query.dir,
        pagina: 1,
        exportando: true,
      });

      return r.rows || [];
    },

    colunas(t, { linhas, moeda }) {
      const categoria = catalogoPorId(categoriasDeConta.paraTela(t));

      // Estas três quase sempre estão vazias — o cadastro mínimo é nome e
      // categoria. Uma coluna que nunca preenche é pior que coluna nenhuma.
      const temDocumento = linhas.some((f) => f.document);
      const temContato = linhas.some((f) => f.contact || f.phone || f.email);
      const temDesativado = linhas.some((f) => f.active === false);

      return [
        { rotulo: t("suppliers.name"), largura: 26, valor: (f) => f.name || "" },
        { rotulo: t("suppliers.defaultCategory"), largura: 18, valor: (f) => categoria(f.categoria) },
        {
          rotulo: t("suppliers.defaultDescription"),
          largura: 30,
          valor: (f) => f.defaultDescription || "",
        },
        ...(temDocumento
          ? [{ rotulo: t("suppliers.document"), largura: 20, valor: (f) => f.document || "" }]
          : []),
        ...(temContato
          ? [
              { rotulo: t("suppliers.contact"), largura: 22, valor: (f) => f.contact || "" },
              { rotulo: t("suppliers.phone"), largura: 18, valor: (f) => f.phone || "" },
              { rotulo: t("auth.email"), largura: 26, valor: (f) => f.email || "" },
            ]
          : []),
        {
          rotulo: t("payables.title"),
          largura: 14,
          direita: true,
          valor: (f) => f.contas ?? 0,
        },
        ...(temDesativado
          ? [
              {
                rotulo: t("people.status"),
                largura: 14,
                valor: (f) => t(f.active === false ? "suppliers.inactive" : "common.active"),
              },
            ]
          : []),
      ];
    },
  },

  // ── AS CONTAS A PAGAR ──────────────────────────────────────────────────
  //
  // *"faltou checkbox"* (24/09/2026), na aba de Contas — a única lista do
  // produto que ainda não levava a lista embora.
  //
  // É o espelho das cobranças: lá é o que me devem, aqui é o que eu devo. E a
  // SITUAÇÃO é calculada, não gravada — "atrasada" é o relógio, e só `paid` e
  // `canceled` estão no banco.
  contas: {
    permissao: "finance.view",
    titulo: (t) => t("payables.title"),

    async linhas(app, { query, fuso }) {
      const r = await app.api.payable.listar({
        ids: query.ids,
        de: query.de,
        ate: query.ate,
        status: query.status,
        categoria: query.categoria,
        busca: query.search,
        unit: query.unit,
        semUnidade: query.semUnidade === "1",
        ordem: query.sort,
        direcao: query.dir,
        pagina: 1,
        exportando: true,
        fuso,
      });

      return r.rows || [];
    },

    colunas(t, { moeda, linhas, nomeDaUnidade, query }) {
      const categoria = catalogoPorId(categoriasDeConta.paraTela(t));
      const estado = catalogoPorId(statusDeCobranca.paraTela(t));

      // A coluna de unidade some quando a LENTE já escolheu uma: *"se escolhi
      // Niterói, não precisa mostrar coluna unidade"* (24/09/2026). Todas as
      // linhas diriam Niterói, e o recorte impresso no alto da folha já conta
      // isso. Some também quando nenhuma linha tem filial.
      const comUnidade = !query.unit && linhas.some((c) => nomeDaUnidade(c.unit));
      const comObservacao = linhas.some((c) => c.note);

      return [
        { rotulo: t("payables.colWhat"), largura: 30, valor: (c) => c.description || "" },
        { rotulo: t("payables.colSupplier"), largura: 22, valor: (c) => c.supplierName || "" },
        { rotulo: t("payables.colCategory"), largura: 18, valor: (c) => categoria(c.categoria) },
        ...(comUnidade
          ? [
              {
                rotulo: t("unidade.one"),
                largura: 18,
                // Sem unidade é "Da casa toda" — o contador, o software. É um
                // recorte de verdade, e não a ausência de escolha; em branco a
                // planilha pareceria cadastro pela metade.
                valor: (c) => nomeDaUnidade(c.unit) || t("payables.allUnits"),
              },
            ]
          : []),
        { rotulo: t("payables.colDue"), largura: 14, valor: (c) => ({ data: c.dueDate }) },
        { rotulo: t("payables.paid"), largura: 14, valor: (c) => ({ data: c.paidAt }) },
        {
          rotulo: t("payables.colAmount"),
          largura: 14,
          direita: true,
          valor: (c) => ({ dinheiro: c.amount, moeda: c.currency || moeda }),
        },
        {
          rotulo: t("payables.colStatus"),
          largura: 14,
          // "Atrasada" é o RELÓGIO, e não um campo: só `paid` e `canceled`
          // estão gravados. Ler o campo faria a folha dizer "em aberto" numa
          // conta vencida há três meses.
          valor: (c) => estado(c.atrasada ? "late" : c.status || "open"),
        },
        ...(comObservacao
          ? [{ rotulo: t("payables.colNote"), largura: 34, valor: (c) => c.note || "" }]
          : []),
      ];
    },
  },

  // ── AS COBRANÇAS ───────────────────────────────────────────────────────
  //
  // O que me devem. O CONTATO entra na planilha e não na tela: *"coloque o
  // e-mail e whatsapp também"* — quem recebe esta lista vai ligar e cobrar, e
  // sem o contato o caminho é abrir a ficha de trinta pessoas e copiar trinta
  // telefones à mão, que é o trabalho que a exportação existe para tirar.
  cobrancas: {
    permissao: "finance.view",
    titulo: (t) => t("finance.title"),

    async linhas(app, { query, fuso }) {
      const r = await app.api.finance.carteira({
        ids: query.ids,
        de: query.de,
        ate: query.ate,
        status: query.status,
        busca: query.search,
        unit: query.unit,
        // A ficha de UMA pessoa usa a mesma lista com o dono amarrado.
        personId: query.personId,
        ordem: query.sort,
        direcao: query.dir,
        pagina: 1,
        exportando: true,
        fuso,
      });

      return r.rows || [];
    },

    colunas(t, { words, moeda }) {
      return [
        // O NÚMERO primeiro, e é ele que faz a planilha conversar com o
        // sistema: quem recebe o arquivo e pergunta "qual é essa?" tem o que
        // ditar de volta.
        { rotulo: t("finance.colNumber"), largura: 8, valor: (c) => c.numero || "" },
        { rotulo: words.Singular || t("finance.colPerson"), largura: 26, valor: (c) => c.studentName || "" },
        { rotulo: t("people.phone"), largura: 18, valor: (c) => c.studentPhone || "" },
        { rotulo: t("auth.email"), largura: 30, valor: (c) => c.studentEmail || "" },
        { rotulo: t("finance.colWhat"), largura: 34, valor: (c) => c.description || "" },
        { rotulo: t("finance.colDue"), largura: 14, valor: (c) => ({ data: c.dueDate }) },
        { rotulo: t("finance.colCreated"), largura: 14, valor: (c) => ({ data: c.createdAt }) },
        // O que já entrou e o que falta saem SEPARADOS do valor. Na tela eles
        // convivem numa célula só ("pago X, falta Y" em letra miúda), que é
        // bom para ler e péssimo para somar.
        { rotulo: t("finance.colAmount"), largura: 14, direita: true, valor: (c) => ({ dinheiro: c.amount, moeda: c.currency || moeda }) },
        { rotulo: t("finance.paid"), largura: 14, direita: true, valor: (c) => ({ dinheiro: c.pago, moeda: c.currency || moeda }) },
        { rotulo: t("finance.left"), largura: 14, direita: true, valor: (c) => ({ dinheiro: c.falta, moeda: c.currency || moeda }) },
        { rotulo: t("finance.colStatus"), largura: 14, valor: (c) => situacaoDaCobranca(t, c) },
      ];
    },
  },

  // ── OS RECEBIMENTOS ────────────────────────────────────────────────────
  //
  // A outra pergunta: não "o que me devem", e sim "o que ENTROU". São duas
  // rotas no servidor pela mesma razão que são duas abas na tela — um
  // pagamento avulso não tem cobrança do outro lado e não teria onde aparecer
  // numa lista de cobranças.
  pagamentos: {
    permissao: "finance.view",
    titulo: (t) => t("finance.tabPayments"),

    async linhas(app, { query, fuso }) {
      const r = await app.api.finance.recebimentos({
        ids: query.ids,
        de: query.de,
        ate: query.ate,
        status: query.status,
        busca: query.search,
        unit: query.unit,
        personId: query.personId,
        ordem: query.sort,
        direcao: query.dir,
        pagina: 1,
        exportando: true,
        fuso,
      });

      return r.rows || [];
    },

    colunas(t, { words, moeda, linhas, nomeDaUnidade, formas }) {
      const comUnidade = linhas.some((p) => nomeDaUnidade(p.studentUnit));
      // Pelo catálogo, e não por `t("finance.paymentStatus." + p.status)`: um
      // estado que o catálogo não conhece sai como o próprio id, e não como a
      // chave crua no meio da tabela.
      const estado = catalogoPorId(statusDePagamento.paraTela(t));

      return [
        { rotulo: t("finance.colNumber"), largura: 8, valor: (p) => p.numero || "" },
        { rotulo: words.Singular || t("finance.colPerson"), largura: 26, valor: (p) => p.studentName || "" },
        ...(comUnidade
          ? [{ rotulo: t("unidade.one"), largura: 18, valor: (p) => nomeDaUnidade(p.studentUnit) }]
          : []),
        { rotulo: t("finance.colWhat"), largura: 34, valor: (p) => p.assunto || p.note || "" },
        { rotulo: t("finance.colDate"), largura: 14, valor: (p) => ({ data: p.date }) },
        { rotulo: t("finance.colMethod"), largura: 16, valor: (p) => formas(p.method) },
        { rotulo: t("finance.colAmount"), largura: 14, direita: true, valor: (p) => ({ dinheiro: p.amount, moeda: p.currency || moeda }) },
        {
          rotulo: t("finance.colStatus"),
          largura: 14,
          valor: (p) => estado(p.status || "paid"),
        },
      ];
    },
  },
};

// Um catálogo (`[{ id, label }]`) vira uma função de consulta. Id que o
// catálogo não conhece devolve o próprio id: um vínculo antigo removido da
// lista continua tendo de aparecer na planilha, e em branco ele viraria uma
// linha sem cargo.
function catalogoPorId(lista) {
  const mapa = new Map((lista || []).map((x) => [String(x.id), x.label]));
  return (id) => mapa.get(String(id || "")) || String(id || "");
}

const podeVerFolha = (user) =>
  Array.isArray(user?.permissions) && user.permissions.includes("employees.payroll");

function diasDaSemana(t, dias) {
  return weekdaysOf(dias)
    .map((d) => t(`workouts.weekdayShort.${d}`))
    .join(" · ");
}

// A situação de uma cobrança é CALCULADA, e não um campo: "paga" é consequência
// de os pagamentos cobrirem o valor, e "vencida" é o relógio. Só `canceled`
// está gravado — ler o campo faria a planilha dizer "em aberto" numa cobrança
// com a coluna "Pago" cheia ao lado.
function situacaoDaCobranca(t, c) {
  if (c.status === "canceled") return t("finance.canceled");
  if (c.status === "paid" || c.falta === 0) return t("finance.statusPaid");
  if (c.atrasada) return t("finance.late");
  return t("finance.open");
}

function existe(lista) {
  return Object.prototype.hasOwnProperty.call(LISTAS, String(lista));
}

// O nome do arquivo viaja por WhatsApp, e-mail e pen drive — e cada um reescreve
// o que não entende. Sem acento e sem espaço, e com a data: dois arquivos da
// mesma lista em semanas diferentes têm de se distinguir na pasta de downloads.
function nomeDoArquivo(titulo, extensao) {
  const limpo = String(titulo || "lista")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  const hoje = new Date().toISOString().slice(0, 10);
  return [limpo || "lista", hoje].join("-") + "." + extensao;
}

// ── O QUE UMA CÉLULA PODE SER ────────────────────────────────────────────
//
// Texto e número vão como estão. Os outros dois formatos existem porque a
// planilha e o papel precisam da MESMA informação em tipos diferentes:
//
//   { data }            um dia do calendário
//   { dataHora }        um instante
//   { dinheiro, moeda } centavos
//
// Na planilha os três viram valor de verdade (uma data, um número) com o
// formato na COLUNA; no papel viram texto. Mandar "14/03/2026" como string
// para o Excel é o defeito clássico: não ordena, não filtra por período, e
// aberto num Excel americano é lido como 3 de fevereiro.
const ehData = (v) => v && typeof v === "object" && ("data" in v || "dataHora" in v);
const ehDinheiro = (v) => v && typeof v === "object" && "dinheiro" in v;

// Meio-dia UTC: se o Excel deslocar por fuso, um empurrão de até doze horas
// para qualquer lado ainda cai no mesmo dia. Só para o dia do calendário — um
// INSTANTE já traz a hora certa e mexer nela seria mentir.
function comoDataDaPlanilha(v) {
  if (v.dataHora) {
    const d = new Date(v.dataHora);
    return Number.isNaN(d.getTime()) ? "" : d;
  }

  if (!v.data) return "";
  const d = new Date(`${String(v.data).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d;
}

// ── QUANDO O TETO CORTOU, O ARQUIVO DIZ ───────────────────────────────────
//
// *"o backend gerar esse xlsx com TUDO"* (24/09/2026) — e "tudo" tem um limite
// de cinco mil linhas, que é o que cabe na memória desta máquina.
//
// Uma conta que passe disso receberia cinco mil linhas e nenhuma pista de que
// faltam as outras. É o MESMO defeito que o clamp de 200 causava, só que mais
// raro — e mais raro é pior: ninguém está esperando por ele.
const cortou = (linhas) => linhas.length >= TETO_DE_EXPORTACAO;

const avisoDoCorte = (t) => t("bulk.capped", { count: TETO_DE_EXPORTACAO });

async function planilha({ titulo, colunas, linhas, lang, fuso, t }) {
  // O `exceljs` entra só quando alguém pede: a máquina tem 903 MB e três Node
  // em cima dela, e uma biblioteca de planilha carregada no boot é memória
  // parada por causa de um botão.
  const ExcelJS = require("exceljs");

  const book = new ExcelJS.Workbook();
  book.creator = "VAFIT";
  book.created = new Date();

  const aba = book.addWorksheet(String(titulo || "Lista").slice(0, 30));

  aba.columns = colunas.map((c, i) => ({
    header: c.rotulo,
    key: "c" + i,
    width: c.largura || 20,
  }));

  aba.getRow(1).font = { bold: true };
  aba.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  aba.views = [{ state: "frozen", ySplit: 1 }];

  // O formato da DATA segue quem lê, e não a máquina: 03/14 num Excel
  // brasileiro é um dia que não existe.
  const formatoDeData = String(lang || "").startsWith("en") ? "mm/dd/yyyy" : "dd/mm/yyyy";

  for (const linha of linhas) {
    const celulas = {};

    colunas.forEach((c, i) => {
      const v = c.valor(linha);

      if (ehData(v)) {
        celulas["c" + i] = comoDataDaPlanilha(v);
        return;
      }

      // Centavos viram a unidade da moeda: o Excel soma 1120, não "R$ 1.120,00".
      if (ehDinheiro(v)) {
        const n = Number(v.dinheiro);
        celulas["c" + i] = Number.isFinite(n) ? n / 100 : "";
        return;
      }

      celulas["c" + i] = v ?? "";
    });

    aba.addRow(celulas);
  }

  // O formato vai na COLUNA, depois das linhas — e é decidido pela PRIMEIRA
  // célula que tem tipo, não pelo rótulo: uma coluna de datas onde a primeira
  // linha está vazia ainda é uma coluna de datas.
  colunas.forEach((c, i) => {
    const amostra = linhas.map((l) => c.valor(l)).find((v) => ehData(v) || ehDinheiro(v));
    if (!amostra) return;

    const col = aba.getColumn("c" + i);

    if (ehData(amostra)) {
      col.numFmt = amostra.dataHora ? `${formatoDeData} hh:mm` : formatoDeData;
      return;
    }

    // `#,##0.00` e não o símbolo da moeda: a planilha pode misturar moedas
    // (um lançamento antigo em outra), e carimbar "R$" na coluna inteira
    // escreveria real em cima de dólar.
    col.numFmt = "#,##0.00";
  });

  colunas.forEach((c, i) => {
    if (c.direita) aba.getColumn("c" + i).alignment = { horizontal: "right" };
  });

  // O aviso vai no PÉ da planilha, depois de uma linha em branco: quem rola
  // até o fim para conferir o total é exatamente quem precisa lê-lo. No papel
  // ele vai junto do recorte, no alto.
  if (cortou(linhas) && t) {
    aba.addRow({});
    const linha = aba.addRow({ c0: avisoDoCorte(t) });
    linha.getCell(1).font = { bold: true, color: { argb: "FFB45309" } };
  }

  return book.xlsx.writeBuffer();
}

// O mesmo valor, em TEXTO, para o papel. `fuso` é o da conta: sem ele o
// lançamento das 22h de ontem sai com a data de hoje.
function comoTexto(v, lang, fuso) {
  if (ehData(v)) {
    if (v.dataHora) return v.dataHora ? formatarDataHora(v.dataHora, lang, fuso) : "";
    return v.data ? formatarData(v.data, lang, fuso) : "";
  }

  if (ehDinheiro(v)) return dinheiro(v.dinheiro, v.moeda);

  return String(v ?? "");
}

// O PAPEL. Mesmo molde do resto do sistema — logo à direita, na mesma altura do
// título — porque quem recebe a folha não sabe de qual tela ela saiu.
function documento({ titulo, colunas, linhas, recorte, lang, fuso, marca }) {
  const t = rotulos(lang);
  const nota = [recorte, cortou(linhas) ? avisoDoCorte(t) : ""].filter(Boolean).join(" · ");

  const lado = (c) => (c.direita ? "right" : "left");

  const cabecalho = colunas
    .map(
      (c) =>
        `<th style="padding:0 8px 8px;text-align:${lado(c)};font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${FRACO};border-bottom:1px solid #cbd5e1;">${escapar(c.rotulo)}</th>`
    )
    .join("");

  const corpo = linhas
    .map((linha) => {
      const celulas = colunas
        .map((c) => {
          // `comoTexto` e não `String(v)`: aqui saía a data crua do banco —
          // "2026-09-23T12:00:00.000Z" impresso na folha onde deveria estar
          // 23/09/2026. Nenhuma lista com coluna de data tinha chegado ao
          // papel ainda, e por isso ninguém viu.
          const texto = comoTexto(c.valor(linha), lang, fuso);
          return `<td style="padding:9px 8px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:${lado(c)};">${escapar(texto)}</td>`;
        })
        .join("");

      return `<tr>${celulas}</tr>`;
    })
    .join("");

  const tabela = linhas.length
    ? `<table style="width:100%;border-collapse:collapse;"><thead><tr>${cabecalho}</tr></thead><tbody>${corpo}</tbody></table>`
    : `<p style="margin:0;font-size:13px;color:${FRACO};">${escapar(t("bulk.printEmpty"))}</p>`;

  return pagina({
    lang,
    titulo,
    nome: titulo,
    // O RECORTE vai impresso: uma folha com dez linhas e sem essa nota não
    // deixa ninguém saber se a lista tem dez ou se o filtro estava ligado — e
    // a folha circula longe da tela que a gerou.
    subtitulo: nota,
    corpo: `<section style="margin-top:18px;">${tabela}</section>`,
    rodape: t("bulk.printedAt", { quando: formatarDataHora(new Date(), lang, fuso) }),
    marca,
  });
}

module.exports = { LISTAS, existe, nomeDoArquivo, planilha, documento };
