// As ferramentas que o assistente usa para OPERAR o sistema.
//
// Antes, ele operava a TELA: lia o DOM, procurava o botão, clicava, esperava a
// rede e lia de novo. Funcionava, e custava caro em três moedas — dinheiro (os
// retratos de tela eram 89% dos tokens, e mudavam a cada turno, o que estragava
// o cache), tempo (420 ms cegos por ação, mais a re-renderização) e acerto
// ("não achei na lista" quando o item estava lá, só que fora da parte visível).
//
// Aqui ele chama uma função. `buscarExercicio("remada baixa")` não tem como não
// achar o que existe: ou o banco tem, ou não tem.
//
// ── O que estas funções NÃO fazem ──────────────────────────────────────────
//
// Elas não reimplementam regra nenhuma. Cada uma chama o MESMO modelo que o
// controller da tela chama, na mesma ordem, com as mesmas checagens. Um caminho
// paralelo que "quase" faz o mesmo é a origem do bug que ninguém encontra: a
// tela valida o e-mail e a ferramenta não, e um dia aparece uma ficha com
// e-mail impossível que "o sistema aceitou".
//
// Por isso também a PERMISSÃO é a mesma: quem não pode criar pessoa pela tela
// não cria por aqui. A ferramenta recebe o usuário já autenticado e confere a
// permissão dele antes de tocar em qualquer coisa.
const ObjectId = require("mongodb").ObjectId;

// O que uma ferramenta devolve quando dá errado.
//
// Erro é RESPOSTA, não exceção: o modelo precisa ler o motivo e decidir o que
// fazer — pedir o dado que falta, tentar outro nome, desistir. Uma exceção
// viraria "erro interno" e ele tentaria de novo, igual.
function erro(motivo, detalhe) {
  return { ok: false, erro: motivo, ...(detalhe ? { detalhe } : {}) };
}

// A pessoa, reduzida ao que o assistente precisa.
//
// Nunca o documento inteiro: ele traz senha, salt e token de convite. Isso não
// pode entrar no contexto de um modelo — o que entra no contexto sai na
// resposta em algum momento.
function pessoaPublica(p) {
  if (!p) return null;

  return {
    id: String(p._id),
    nome: p.name,
    email: p.email || "",
    telefone: p.phone || "",
    ativo: p.active === undefined ? true : Boolean(p.active),
  };
}

function treinoPublico(t) {
  if (!t) return null;

  return {
    id: String(t._id),
    nome: t.name,
    pessoaId: t.student ? String(t.student) : null,
    inicio: t.startDate || "",
    fim: t.endDate || "",
    status: t.status || "",
    exercicios: (t.exercises || []).map((e, i) => ({
      posicao: i,
      nome: e.name,
      grupo: e.muscleGroup || "",
      series: (e.sets || []).map((s) => ({
        unidade: s.unit || "reps",
        quantidade: s.quantity || "",
        carga: s.load || "",
        descanso: s.rest || "",
      })),
    })),
  };
}


function dietaPublica(d) {
  if (!d) return null;

  return {
    id: String(d._id),
    nome: d.name,
    pessoaId: d.student ? String(d.student) : null,
    objetivo: d.goal || "",
    inicio: d.startDate || "",
    fim: d.endDate || "",
    metaKcal: d.targetKcal ?? null,
    refeicoes: (d.meals || []).map((m, i) => ({
      posicao: i,
      nome: m.name,
      hora: m.time || "",
      alimentos: (m.foods || []).map((a, j) => ({
        posicao: j,
        nome: a.name,
        quantidade: a.quantity ?? null,
        unidade: a.unit || "g",
        kcal: a.kcal ?? null,
      })),
    })),
  };
}

// A rota de uma dieta.
//
// Ela não tem endereço próprio: mora na ficha da pessoa, numa aba, com o id na
// busca da URL. Montar isto num lugar só evita a divergência entre as
// ferramentas — e o dia em que a tela mudar, muda aqui.
function rotaDaDieta(pessoaId, dietaId) {
  return `/people/${pessoaId}?tab=diet&diet=${dietaId}`;
}

// O financeiro e a avaliação também moram em ABAS da ficha, e por isso mandam
// `recarregar` junto com a rota: quem já está na ficha não navega para lugar
// nenhum, e sem o aviso a tela continuaria mostrando o de antes.
function rotaDoFinanceiro(pessoaId) {
  return `/people/${pessoaId}?tab=finance`;
}

function rotaDaAvaliacao(pessoaId) {
  return `/people/${pessoaId}?tab=assessment`;
}

// A moeda de um lançamento.
//
// Sem pedido, a da conta. Com pedido, ela precisa estar HABILITADA: a moeda
// fica gravada em cada lançamento, e é ela que dá sentido ao número — "50" em
// dólar e "50" em real são valores diferentes, e um relatório que soma os dois
// mente. Aceitar uma moeda que a conta não usa criaria essa soma.
//
// Isto existe porque a ferramenta não tinha o campo: pedir "registra 50 dólares"
// gravava 50 reais, calado.
async function moedaDoLancamento(app, pedida) {
  const conta = await app.api.tenant.currencyOfInstance();
  if (!pedida) return conta?.currency || "BRL";

  const alvo = String(pedida).trim().toUpperCase();
  const habilitadas = conta?.currencies || [conta?.currency].filter(Boolean);

  return habilitadas.includes(alvo) ? alvo : null;
}

// O dinheiro sai daqui como CENTAVOS e como texto pronto.
//
// Só centavos faria o modelo escrever "25000" na resposta ao profissional; só
// texto o impediria de somar. Os dois, e cada um serve a um leitor.
function dinheiro(centavos, moeda) {
  const valor = (Number(centavos) || 0) / 100;
  return {
    centavos: Number(centavos) || 0,
    texto: valor.toLocaleString("pt-BR", { style: "currency", currency: moeda || "BRL" }),
  };
}

function cobrancaPublica(c, pago) {
  const falta = Math.max(0, (c.amount || 0) - (pago || 0));

  return {
    id: String(c._id),
    descricao: c.description || "",
    valor: dinheiro(c.amount, c.currency),
    pago: dinheiro(pago, c.currency),
    falta: dinheiro(falta, c.currency),
    vencimento: c.dueDate ? new Date(c.dueDate).toISOString().slice(0, 10) : "",
    // A situação que a tela mostra, e não a gravada: "quitada" é consequência
    // dos pagamentos cobrirem o valor, e o modelo precisa ler o mesmo que o
    // profissional lê.
    situacao: c.status === "canceled" ? "cancelada" : falta === 0 ? "quitada" : "em aberto",
    daAgenda: Boolean(c.appointment),
  };
}

function compromissoPublico(a, nomes) {
  const quem = nomes?.[String(a.student)];

  return {
    id: String(a._id),
    pessoaId: String(a.student),
    pessoa: quem?.name || "",
    quando: a.date ? new Date(a.date).toISOString() : "",
    minutos: a.minutes || 60,
    titulo: a.title || "",
    situacao: a.status || "scheduled",
    observacao: a.note || "",
  };
}

// A avaliação como ela é LIDA.
//
// Sem percentual de gordura, massa magra ou IMC: eles são derivados do método e
// do protocolo, calculados na tela. Devolvê-los aqui seria devolver um número
// que a próxima conta contradiz — e o modelo passaria a repeti-lo como se fosse
// dado gravado.
function avaliacaoPublica(a) {
  return {
    id: String(a._id),
    pessoaId: String(a.student),
    data: a.date ? new Date(a.date).toISOString().slice(0, 10) : "",
    peso: a.weight ?? null,
    alturaMetros: a.height ?? null,
    dobras: a.skinfolds || null,
    circunferencias: a.circumferences || null,
    rascunho: a.draft === true,
    observacao: a.note || "",
  };
}

function pagamentoPublico(p) {
  return {
    id: String(p._id),
    valor: dinheiro(p.amount, p.currency),
    forma: p.method || "other",
    quando: p.date ? new Date(p.date).toISOString() : "",
    situacao: p.status || "paid",
    cobrancaId: p.charge ? String(p.charge) : null,
    observacao: p.note || "",
  };
}

// ── O catálogo ─────────────────────────────────────────────────────────────
//
// Cada ferramenta é `{ nome, descricao, permissao, schema, executar }`.
//
// `schema` é JSON Schema, e é ele que o modelo lê. As descrições são escritas
// PARA ELE: elas dizem quando usar a ferramenta e o que a resposta significa,
// não o que o código faz. "Devolve a lista" não ajuda ninguém; "use quando a
// pessoa disser um nome e você precisar do id" ajuda.
//
// `alvo` no retorno é o que o front usa para abrir a tela certa e destacar o
// que mudou — é assim que a pessoa VÊ a ação acontecer sem o modelo ter tocado
// na tela.
const FERRAMENTAS = [
  // ── Pessoas ──────────────────────────────────────────────────────────────
  {
    nome: "pessoa_buscar",
    descricao:
      "Procura pessoas pelo nome ou e-mail. Use SEMPRE antes de editar ou excluir: " +
      "as outras ferramentas pedem o id, e quem fala diz o nome.",
    permissao: "people.view",
    schema: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Parte do nome ou do e-mail." },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["termo"],
    },
    async executar(app, user, args) {
      const { rows } = await app.api.user.pageStudents(user._id, {
        search: String(args.termo || ""),
        limit: Math.min(50, Number(args.limite) || 10),
        page: 1,
      });

      const pessoas = rows.map(pessoaPublica);

      // Achou UMA: a tela vai junto.
      //
      // Procurar alguém pelo nome quase sempre é o começo de "e agora faz X
      // com ela" — abrir a ficha adianta o passo seguinte e mostra que a busca
      // acertou. Com várias, não: navegar para uma delas seria escolher pela
      // pessoa, e para a lista sem o filtro seria pior que ficar parado, porque
      // ela teria de buscar de novo à mão.
      const alvo =
        pessoas.length === 1
          ? { rota: `/people/${pessoas[0].id}`, destacar: `person:${pessoas[0].id}` }
          : undefined;

      return { ok: true, pessoas, ...(alvo ? { alvo } : {}) };
    },
  },

  {
    nome: "pessoa_criar",
    descricao:
      "Cadastra uma pessoa. O e-mail é OPCIONAL — sem ele a ficha existe inteira, " +
      "só não dá login. Não invente e-mail para preencher: um endereço falso ocupa " +
      "o índice único e impede o de verdade depois.",
    permissao: "people.create",
    schema: {
      type: "object",
      properties: {
        nome: { type: "string", minLength: 2 },
        email: { type: "string" },
        telefone: { type: "string" },
      },
      required: ["nome"],
    },
    async executar(app, user, args) {
      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto", "O nome precisa de ao menos 2 letras.");

      const email = String(args.email || "").trim().toLowerCase();
      if (email && !app.validator.isEmail(email)) {
        return erro("email_invalido", "Escreva um e-mail válido ou deixe em branco.");
      }

      if (email && (await app.api.user.dataByEmail(email))) {
        return erro("email_em_uso", "Já existe alguém com este e-mail.");
      }

      const id = await app.api.user.insertStudent(user._id, {
        name: nome,
        email,
        phone: String(args.telefone || "").trim(),
      });

      const criada = await app.api.user.dataStudent(user._id, id);

      return {
        ok: true,
        pessoa: pessoaPublica(criada),
        alvo: { rota: `/people/${id}`, destacar: `person:${id}` },
      };
    },
  },

  {
    nome: "pessoa_editar",
    descricao:
      "Muda dados de uma pessoa. Mande SÓ os campos que devem mudar — o que não " +
      "vier fica como está.",
    permissao: "people.edit",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        email: { type: "string", description: "Vazio remove o e-mail." },
        telefone: { type: "string" },
        ativo: { type: "boolean" },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!alvo) return erro("pessoa_nao_encontrada");

      const mudanca = {};
      if (args.nome !== undefined) {
        const nome = String(args.nome).trim();
        if (nome.length < 2) return erro("nome_curto");
        mudanca.name = nome;
      }

      if (args.email !== undefined) {
        const email = String(args.email).trim().toLowerCase();
        if (email && !app.validator.isEmail(email)) return erro("email_invalido");

        // A mesma regra da tela: o e-mail é o login. Tirá-lo de quem tem senha
        // deixaria a pessoa sem porta de entrada, e sem aviso.
        if (!email && alvo.password) {
          return erro("email_e_login", "Esta pessoa entra no app por este e-mail.");
        }

        if (email) {
          const outro = await app.api.user.dataByEmail(email);
          if (outro && String(outro._id) !== String(alvo._id)) return erro("email_em_uso");
        }

        mudanca.email = email;
      }

      if (args.telefone !== undefined) mudanca.phone = String(args.telefone).trim();
      if (args.ativo !== undefined) mudanca.active = args.ativo ? 1 : 0;

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.user.updateStudent(user._id, args.pessoaId, mudanca);
      const depois = await app.api.user.dataStudent(user._id, args.pessoaId);

      return {
        ok: true,
        pessoa: pessoaPublica(depois),
        alvo: { rota: `/people/${args.pessoaId}`, destacar: `person:${args.pessoaId}` },
      };
    },
  },

  {
    nome: "pessoa_excluir",
    descricao:
      "Apaga uma ficha e tudo o que pende dela. NÃO tem desfazer: confirme com quem " +
      "pediu antes de chamar, dizendo o nome de quem vai sumir.",
    permissao: "people.delete",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!alvo) return erro("pessoa_nao_encontrada");

      await app.api.user.deleteStudent(user._id, args.pessoaId);
      // A sessão dela morre junto: sem isto, quem já estava logado continuaria
      // dentro de uma conta que não existe mais.
      await app.api.auth.deleteAllTokensByUser(args.pessoaId);

      return { ok: true, removida: alvo.name, alvo: { rota: "/people" } };
    },
  },

  // ── Treinos ──────────────────────────────────────────────────────────────
  {
    nome: "exercicio_buscar",
    descricao:
      "Procura no CATÁLOGO de exercícios. Use antes de acrescentar um exercício a um " +
      "treino: o resultado traz o id, o nome exato e o grupo muscular. Se vier vazio, " +
      "diga que não existe no catálogo em vez de inventar um nome.",
    permissao: "workouts.view",
    schema: {
      type: "object",
      properties: {
        termo: { type: "string" },
        grupo: { type: "string", description: "Grupo muscular, para estreitar." },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["termo"],
    },
    async executar(app, user, args) {
      const { rows } = await app.api.exercise.list({
        search: String(args.termo || ""),
        muscleGroup: args.grupo || "",
        limit: Math.min(50, Number(args.limite) || 10),
        page: 1,
      });

      return {
        ok: true,
        exercicios: rows.map((e) => ({
          id: String(e._id),
          nome: e.name,
          grupo: e.muscleGroup || "",
        })),
        // Se a pessoa está montando um treino, ela tem o painel de exercícios
        // aberto na frente dela. Mandar o TERMO faz a lista dela mostrar o mesmo
        // que o assistente está vendo — em vez de ele falar de um exercício que
        // não está na tela de ninguém.
        alvo: { busca: { onde: "exercicios", termo: String(args.termo || "") } },
      };
    },
  },

  {
    nome: "treino_listar",
    descricao: "Lista os treinos de uma pessoa, do mais novo para o mais antigo.",
    permissao: "workouts.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const rows = await app.api.workout.list(user._id, args.pessoaId);

      return {
        ok: true,
        // Ler a lista é sempre o começo de mexer em um deles: a tela abre junto.
        alvo: { rota: `/people/${args.pessoaId}/workouts` },
        treinos: rows.map((t) => ({
          id: String(t._id),
          nome: t.name,
          status: t.status || "",
          exercicios: (t.exercises || []).length,
        })),
      };
    },
  },

  {
    nome: "treino_ver",
    descricao:
      "Abre um treino inteiro, com os exercícios e as séries de cada um. A POSIÇÃO " +
      "de cada exercício vem no resultado — é ela que as outras ferramentas pedem.",
    permissao: "workouts.view",
    schema: {
      type: "object",
      properties: { treinoId: { type: "string" } },
      required: ["treinoId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      return {
        ok: true,
        treino: treinoPublico(treino),
        alvo: {
          rota: `/people/${treino.student}/workouts/${args.treinoId}`,
          destacar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_criar",
    descricao: "Cria um treino vazio para uma pessoa. Depois use treino_exercicio_adicionar.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        inicio: { type: "string", description: "AAAA-MM-DD" },
        fim: { type: "string", description: "AAAA-MM-DD" },
      },
      required: ["pessoaId", "nome"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      if (args.inicio && args.fim && args.fim < args.inicio) {
        return erro("fim_antes_do_inicio");
      }

      const id = await app.api.workout.insert(user._id, args.pessoaId, {
        name: nome,
        startDate: args.inicio || "",
        endDate: args.fim || "",
        // Sem professor dito, é quem está operando — a mesma regra da tela.
        teacherName: user.name,
      });

      const criado = await app.api.workout.data(user._id, id);

      return {
        ok: true,
        treino: treinoPublico(criado),
        alvo: { rota: `/people/${args.pessoaId}/workouts/${id}`, destacar: `workout:${id}` },
      };
    },
  },

  {
    nome: "treino_editar",
    descricao: "Muda nome, datas ou status de um treino. Só o que vier muda.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        inicio: { type: "string" },
        fim: { type: "string" },
      },
      required: ["treinoId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const mudanca = {};
      if (args.nome !== undefined) {
        const nome = String(args.nome).trim();
        if (nome.length < 2) return erro("nome_curto");
        mudanca.name = nome;
      }
      if (args.inicio !== undefined) mudanca.startDate = args.inicio;
      if (args.fim !== undefined) mudanca.endDate = args.fim;

      const inicio = mudanca.startDate ?? treino.startDate;
      const fim = mudanca.fim ?? mudanca.endDate ?? treino.endDate;
      if (inicio && fim && fim < inicio) return erro("fim_antes_do_inicio");

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.workout.update(user._id, args.treinoId, mudanca);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          destacar: `workout:${args.treinoId}`,
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_excluir",
    descricao: "Apaga um treino inteiro. Não tem desfazer.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: { treinoId: { type: "string" } },
      required: ["treinoId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      await app.api.workout.delete(user._id, args.treinoId);

      return {
        ok: true,
        removido: treino.name,
        alvo: { rota: `/people/${treino.student}/workouts` },
      };
    },
  },

  {
    nome: "treino_exercicio_adicionar",
    descricao:
      "Acrescenta um exercício ao fim do treino, já com as séries. Passe o " +
      "exercicioId que veio de exercicio_buscar — o nome é copiado do catálogo, " +
      "então o treino continua legível se o exercício sair de lá depois.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        exercicioId: { type: "string" },
        series: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Quantas séries criar. Cada uma nasce com a quantidade e a carga abaixo.",
        },
        quantidade: { type: "string", description: 'Repetições ou tempo. Ex.: "12".' },
        unidade: { type: "string", enum: ["reps", "seconds", "minutes", "meters"] },
        carga: { type: "string", description: 'Ex.: "20kg".' },
        descanso: { type: "string", description: 'Ex.: "60s".' },
      },
      required: ["treinoId", "exercicioId"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const doCatalogo = await app.api.exercise.data(args.exercicioId);
      if (!doCatalogo) return erro("exercicio_nao_encontrado");

      // A PRESCRIÇÃO padrão do exercício, quando ninguém disse outra coisa.
      //
      // O profissional que cadastrou "Remada baixa com triângulo" com 4 séries
      // de 15/12/10/8 espera que ela chegue assim — pela tela ou pela voz, dá no
      // mesmo. Se ele DISSE as séries no pedido, o que ele disse vence: quem
      // fala "acrescenta remada, 3 séries de 12" está prescrevendo agora.
      const disseAlgo =
        args.series !== undefined ||
        args.quantidade !== undefined ||
        args.carga !== undefined ||
        args.descanso !== undefined ||
        args.unidade !== undefined;

      const padrao = doCatalogo.defaultSets || [];

      const series =
        !disseAlgo && padrao.length
          ? padrao.map((s) => ({ ...s }))
          : Array.from({ length: Math.min(20, Math.max(1, Number(args.series) || 1)) }, () => ({
              unit: args.unidade || "reps",
              quantity: args.quantidade === undefined ? "" : String(args.quantidade),
              load: args.carga === undefined ? "" : String(args.carga),
              rest: args.descanso === undefined ? "" : String(args.descanso),
            }));

      const lista = [
        ...(treino.exercises || []),
        {
          exerciseId: doCatalogo._id,
          name: doCatalogo.name,
          muscleGroup: doCatalogo.muscleGroup || "",
          thumbUrl: doCatalogo.thumbUrl || null,
          videoUrl: doCatalogo.videoUrl || null,
          method: !disseAlgo ? doCatalogo.defaultMethod || "" : "",
          goal: !disseAlgo ? doCatalogo.defaultGoal || "" : "",
          tip: doCatalogo.defaultTip || "",
          sets: series,
        },
      ];

      await app.api.workout.saveExercises(user._id, args.treinoId, lista);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          destacar: `exercise:${lista.length - 1}`,
          // Quem JÁ está nesta tela não tem para onde navegar: o que ela precisa
          // é buscar o treino de novo. Sem isto, o exercício entra no banco e a
          // lista na frente da pessoa continua a mesma — pior que não ter feito
          // nada, porque parece que funcionou e não mudou.
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_exercicio_editar",
    descricao:
      "Muda as séries de UM exercício do treino, pela posição (0 é o primeiro). " +
      "Use treino_ver antes para saber a posição.",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
        series: { type: "integer", minimum: 1, maximum: 20 },
        quantidade: { type: "string" },
        unidade: { type: "string", enum: ["reps", "seconds", "minutes", "meters"] },
        carga: { type: "string" },
        descanso: { type: "string" },
      },
      required: ["treinoId", "posicao"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const lista = [...(treino.exercises || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O treino tem ${lista.length} exercícios.`);

      // Quantas séries: a nova quantidade, ou as que já existem.
      const quantas = args.series ? Math.min(20, Math.max(1, Number(args.series))) : null;
      const atuais = alvo.sets || [];
      const total = quantas || atuais.length || 1;

      const series = Array.from({ length: total }, (_, i) => {
        const antes = atuais[i] || {};

        // Campo não mandado mantém o que a série já tinha: quem pede "coloca a
        // carga" não está pedindo para apagar as repetições.
        return {
          unit: args.unidade || antes.unit || "reps",
          quantity: args.quantidade === undefined ? antes.quantity || "" : String(args.quantidade),
          load: args.carga === undefined ? antes.load || "" : String(args.carga),
          rest: args.descanso === undefined ? antes.rest || "" : String(args.descanso),
          intensity: antes.intensity || "",
          speed: antes.speed || "",
        };
      });

      lista[args.posicao] = { ...alvo, sets: series };

      await app.api.workout.saveExercises(user._id, args.treinoId, lista);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          destacar: `exercise:${args.posicao}`,
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  {
    nome: "treino_exercicio_remover",
    descricao: "Tira um exercício do treino, pela posição (0 é o primeiro).",
    permissao: "workouts.manage",
    schema: {
      type: "object",
      properties: {
        treinoId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
      },
      required: ["treinoId", "posicao"],
    },
    async executar(app, user, args) {
      const treino = await app.api.workout.data(user._id, args.treinoId);
      if (!treino) return erro("treino_nao_encontrado");

      const lista = [...(treino.exercises || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O treino tem ${lista.length} exercícios.`);

      lista.splice(args.posicao, 1);

      await app.api.workout.saveExercises(user._id, args.treinoId, lista);
      const depois = await app.api.workout.data(user._id, args.treinoId);

      return {
        ok: true,
        removido: alvo.name,
        treino: treinoPublico(depois),
        alvo: {
          rota: `/people/${depois.student}/workouts/${args.treinoId}`,
          recarregar: `workout:${args.treinoId}`,
        },
      };
    },
  },

  // ── Dietas ───────────────────────────────────────────────────────────────
  {
    nome: "dieta_listar",
    descricao: "Lista os planos alimentares de uma pessoa.",
    permissao: "diets.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const rows = await app.api.diet.list(user._id, args.pessoaId);

      return {
        ok: true,
        alvo: { rota: `/people/${args.pessoaId}?tab=diet` },
        dietas: rows.map((d) => ({
          id: String(d._id),
          nome: d.name,
          status: d.status || "",
          refeicoes: (d.meals || []).length,
        })),
      };
    },
  },

  {
    nome: "dieta_ver",
    descricao:
      "Abre um plano inteiro: refeições, horários e alimentos de cada uma. A " +
      "POSIÇÃO da refeição e a do alimento vêm no resultado — são elas que as " +
      "outras ferramentas pedem.",
    permissao: "diets.view",
    schema: {
      type: "object",
      properties: { dietaId: { type: "string" } },
      required: ["dietaId"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      return {
        ok: true,
        dieta: dietaPublica(dieta),
        alvo: {
          rota: rotaDaDieta(dieta.student, args.dietaId),
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "dieta_criar",
    descricao:
      "Cria um plano alimentar vazio. Depois use refeicao_adicionar. `diasDaSemana` " +
      "serve para o caso comum de um plano para dia de treino e outro para descanso.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        objetivo: { type: "string" },
        inicio: { type: "string", description: "AAAA-MM-DD" },
        fim: { type: "string", description: "AAAA-MM-DD" },
        metaKcal: { type: "number" },
        diasDaSemana: {
          type: "array",
          items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
        },
      },
      required: ["pessoaId", "nome"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const nome = String(args.nome || "").trim();
      if (nome.length < 2) return erro("nome_curto");

      if (args.inicio && args.fim && args.fim < args.inicio) return erro("fim_antes_do_inicio");

      const id = await app.api.diet.insert(user._id, args.pessoaId, {
        name: nome,
        goal: args.objetivo || "",
        startDate: args.inicio || "",
        endDate: args.fim || "",
        targetKcal: args.metaKcal,
        weekdays: args.diasDaSemana,
      });

      const criada = await app.api.diet.data(user._id, id);

      return {
        ok: true,
        dieta: dietaPublica(criada),
        // `recarregar` aqui não é redundante com `rota`: quem já está na ficha
        // da pessoa não NAVEGA para lugar nenhum — o plano vive na busca da
        // URL, não no caminho. Sem este aviso, o plano nasce no banco e a lista
        // na frente do profissional continua sem ele.
        alvo: {
          rota: rotaDaDieta(args.pessoaId, id),
          destacar: `diet:${id}`,
          recarregar: `diet:${id}`,
        },
      };
    },
  },

  {
    nome: "dieta_editar",
    descricao: "Muda nome, objetivo, datas ou metas do plano. Só o que vier muda.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        nome: { type: "string", minLength: 2 },
        objetivo: { type: "string" },
        inicio: { type: "string" },
        fim: { type: "string" },
        metaKcal: { type: "number" },
      },
      required: ["dietaId"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const mudanca = {};
      if (args.nome !== undefined) {
        const nome = String(args.nome).trim();
        if (nome.length < 2) return erro("nome_curto");
        mudanca.name = nome;
      }
      if (args.objetivo !== undefined) mudanca.goal = args.objetivo;
      if (args.inicio !== undefined) mudanca.startDate = args.inicio;
      if (args.fim !== undefined) mudanca.endDate = args.fim;
      if (args.metaKcal !== undefined) mudanca.targetKcal = args.metaKcal;

      const inicio = mudanca.startDate ?? dieta.startDate;
      const fim = mudanca.endDate ?? dieta.endDate;
      if (inicio && fim && fim < inicio) return erro("fim_antes_do_inicio");

      if (!Object.keys(mudanca).length) return erro("nada_para_mudar");

      await app.api.diet.update(user._id, args.dietaId, mudanca);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "dieta_excluir",
    descricao: "Apaga um plano alimentar inteiro. Não tem desfazer.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: { dietaId: { type: "string" } },
      required: ["dietaId"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      await app.api.diet.delete(user._id, args.dietaId);

      return {
        ok: true,
        removida: dieta.name,
        // Mesmo motivo de `dieta_criar`: sem `recarregar`, o plano some do banco
        // e continua na lista de quem está com a ficha aberta.
        alvo: {
          rota: `/people/${dieta.student}?tab=diet`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_adicionar",
    descricao:
      "Acrescenta uma refeição ao plano, no fim. A hora vai como HH:MM — é hora " +
      "do DIA, não data: as 07:00 de segunda e as de terça são a mesma refeição.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        nome: { type: "string", description: 'Ex.: "Café da manhã".' },
        hora: { type: "string", description: "HH:MM" },
        observacao: { type: "string" },
      },
      required: ["dietaId", "nome"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const hora = String(args.hora || "");
      if (hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
        return erro("hora_invalida", "Escreva como HH:MM, das 00:00 às 23:59.");
      }

      const lista = [
        ...(dieta.meals || []),
        { name: String(args.nome).trim(), time: hora, note: args.observacao || "", foods: [] },
      ];

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${lista.length - 1}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_editar",
    descricao: "Muda nome, hora ou observação de uma refeição, pela posição (0 é a primeira).",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
        nome: { type: "string" },
        hora: { type: "string" },
        observacao: { type: "string" },
      },
      required: ["dietaId", "posicao"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      if (args.hora !== undefined && args.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(args.hora)) {
        return erro("hora_invalida");
      }

      lista[args.posicao] = {
        ...alvo,
        name: args.nome === undefined ? alvo.name : String(args.nome).trim(),
        time: args.hora === undefined ? alvo.time : String(args.hora),
        note: args.observacao === undefined ? alvo.note : String(args.observacao),
      };

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${args.posicao}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_remover",
    descricao: "Tira uma refeição do plano, pela posição, com tudo o que há nela.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        posicao: { type: "integer", minimum: 0 },
      },
      required: ["dietaId", "posicao"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const alvo = lista[args.posicao];
      if (!alvo) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      lista.splice(args.posicao, 1);

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        removida: alvo.name,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "alimento_buscar",
    descricao:
      "Procura no catálogo de alimentos. O resultado traz o id e os valores por " +
      "porção. Se vier vazio, dá para acrescentar o alimento à refeição só pelo " +
      "nome — mas aí ele vai sem valor nutricional, e o total do dia não conta.",
    permissao: "diets.view",
    schema: {
      type: "object",
      properties: {
        termo: { type: "string" },
        limite: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["termo"],
    },
    async executar(app, user, args) {
      const { rows } = await app.api.food.list({
        search: String(args.termo || ""),
        limit: Math.min(50, Number(args.limite) || 10),
        page: 1,
      });

      return {
        ok: true,
        alimentos: rows.map((f) => ({
          id: String(f._id),
          nome: f.name,
          categoria: f.category || "",
          porcao: f.portion ?? null,
          kcal: f.kcal ?? null,
          proteina: f.protein ?? null,
          carboidrato: f.carbs ?? null,
          gordura: f.fat ?? null,
        })),
      };
    },
  },

  {
    nome: "refeicao_alimento_adicionar",
    descricao:
      "Põe um alimento numa refeição. Prefira o alimentoId vindo de " +
      "alimento_buscar: os valores nutricionais são copiados dele e proporcionais " +
      "à quantidade. Sem id, entra só o nome — e o total do dia não conta esse item.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        refeicao: { type: "integer", minimum: 0, description: "A posição da refeição." },
        alimentoId: { type: "string" },
        nome: { type: "string", description: "Só quando não há alimentoId." },
        quantidade: { type: "number" },
        unidade: { type: "string", default: "g" },
      },
      required: ["dietaId", "refeicao"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const refeicao = lista[args.refeicao];
      if (!refeicao) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      let item;
      if (args.alimentoId) {
        const doCatalogo = await app.api.food.data(args.alimentoId);
        if (!doCatalogo) return erro("alimento_nao_encontrado");

        const quantidade = Number(args.quantidade) || doCatalogo.portion || 100;
        // Os valores do catálogo são por 100 g/ml. Copiá-los sem a regra de três
        // faria 30 g de azeite contar como 100 g — o dia inteiro sairia errado.
        const fator = quantidade / 100;
        const proporcional = (v) => (v === null || v === undefined ? null : Number((v * fator).toFixed(1)));

        item = {
          foodId: doCatalogo._id,
          name: doCatalogo.name,
          quantity: quantidade,
          unit: args.unidade || "g",
          kcal: proporcional(doCatalogo.kcal),
          protein: proporcional(doCatalogo.protein),
          carbs: proporcional(doCatalogo.carbs),
          fat: proporcional(doCatalogo.fat),
        };
      } else {
        const nome = String(args.nome || "").trim();
        if (!nome) return erro("sem_alimento", "Mande alimentoId ou nome.");

        item = { name: nome, quantity: args.quantidade ?? null, unit: args.unidade || "g" };
      }

      lista[args.refeicao] = { ...refeicao, foods: [...(refeicao.foods || []), item] };

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${args.refeicao}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },

  {
    nome: "refeicao_alimento_remover",
    descricao: "Tira um alimento de uma refeição, pelas duas posições.",
    permissao: "diets.manage",
    schema: {
      type: "object",
      properties: {
        dietaId: { type: "string" },
        refeicao: { type: "integer", minimum: 0 },
        alimento: { type: "integer", minimum: 0 },
      },
      required: ["dietaId", "refeicao", "alimento"],
    },
    async executar(app, user, args) {
      const dieta = await app.api.diet.data(user._id, args.dietaId);
      if (!dieta) return erro("dieta_nao_encontrada");

      const lista = [...(dieta.meals || [])];
      const refeicao = lista[args.refeicao];
      if (!refeicao) return erro("posicao_inexistente", `O plano tem ${lista.length} refeições.`);

      const alimentos = [...(refeicao.foods || [])];
      const alvo = alimentos[args.alimento];
      if (!alvo) {
        return erro("alimento_inexistente", `A refeição tem ${alimentos.length} alimentos.`);
      }

      alimentos.splice(args.alimento, 1);
      lista[args.refeicao] = { ...refeicao, foods: alimentos };

      await app.api.diet.saveMeals(user._id, args.dietaId, lista);
      const depois = await app.api.diet.data(user._id, args.dietaId);

      return {
        ok: true,
        removido: alvo.name,
        dieta: dietaPublica(depois),
        alvo: {
          rota: rotaDaDieta(depois.student, args.dietaId),
          destacar: `meal:${args.refeicao}`,
          recarregar: `diet:${args.dietaId}`,
        },
      };
    },
  },
  // ── Financeiro ───────────────────────────────────────────────────────────
  //
  // Cobrança e pagamento são coisas SEPARADAS, e as ferramentas repetem essa
  // separação de propósito: a cobrança é o que a pessoa deve, o pagamento é o
  // que entrou. Uma ferramenta só, de "registrar dinheiro", não saberia
  // responder quem está devendo — que é metade do que se pergunta ao
  // financeiro.
  //
  // Valor entra como a pessoa fala: 250, "250", "250,00" ou "R$ 250,00". Quem
  // converte para centavos é o mesmo código da tela.

  {
    nome: "financeiro_ver",
    descricao:
      "O financeiro de uma pessoa: cobrado, recebido, a receber, e as cobranças " +
      "e pagamentos com os ids.",
    permissao: "finance.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const moeda = (await app.api.tenant.currencyOfInstance())?.currency;
      const saldo = await app.api.finance.balanceOf(args.pessoaId, moeda);
      const pagoPor = await app.api.finance.paidByCharge(args.pessoaId);
      const cobrancas = await app.api.finance.listCharges(args.pessoaId);
      const pagamentos = await app.api.finance.listPayments(args.pessoaId);

      return {
        ok: true,
        saldo,
        cobrancas: cobrancas.map((c) => cobrancaPublica(c, pagoPor[String(c._id)] || 0)),
        pagamentos: pagamentos.map(pagamentoPublico),
        alvo: { rota: rotaDoFinanceiro(args.pessoaId) },
      };
    },
  },

  {
    nome: "cobranca_criar",
    descricao:
      "O que a pessoa DEVE. Não registra dinheiro entrando — isso é " +
      "pagamento_registrar.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        valor: { type: "string", description: 'Ex.: "250,00".' },
        descricao: { type: "string" },
        vencimento: { type: "string", description: "AAAA-MM-DD. Sem isso, hoje." },
        moeda: { type: "string", description: "BRL, USD, EUR… Sem isso, a da conta." },
      },
      required: ["pessoaId", "valor"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const moeda = await moedaDoLancamento(app, args.moeda);
      if (!moeda) return erro("moeda_desconhecida");

      const id = await app.api.finance.insertCharge(
        args.pessoaId,
        { amount: args.valor, description: args.descricao, dueDate: args.vencimento },
        user._id,
        moeda
      );

      const criada = await app.api.finance.chargeData(id);
      if (!criada.amount) {
        await app.api.finance.deleteCharge(id);
        return erro("valor_invalido");
      }

      return {
        ok: true,
        cobranca: cobrancaPublica(criada, 0),
        alvo: {
          rota: rotaDoFinanceiro(args.pessoaId),
          destacar: `charge:${id}`,
          recarregar: `finance:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "cobranca_editar",
    descricao:
      'Muda valor, descrição, vencimento ou situação ("open" ou "canceled"). ' +
      '"paid" NÃO se marca: ela acontece quando os pagamentos cobrem o valor.',
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        cobrancaId: { type: "string" },
        valor: { type: "string" },
        descricao: { type: "string" },
        vencimento: { type: "string" },
        situacao: { type: "string", enum: ["open", "canceled"] },
      },
      required: ["cobrancaId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.finance.chargeData(args.cobrancaId);
      if (!atual) return erro("cobranca_nao_encontrada");
      if (!(await app.api.user.dataStudent(user._id, atual.student))) {
        return erro("cobranca_nao_encontrada");
      }

      await app.api.finance.updateCharge(args.cobrancaId, {
        amount: args.valor === undefined ? atual.amount : args.valor,
        description: args.descricao === undefined ? atual.description : args.descricao,
        dueDate: args.vencimento === undefined ? atual.dueDate : args.vencimento,
        status: args.situacao === undefined ? atual.status : args.situacao,
      });

      const depois = await app.api.finance.chargeData(args.cobrancaId);
      const pagoPor = await app.api.finance.paidByCharge(atual.student);

      return {
        ok: true,
        cobranca: cobrancaPublica(depois, pagoPor[String(args.cobrancaId)] || 0),
        alvo: {
          rota: rotaDoFinanceiro(atual.student),
          destacar: `charge:${args.cobrancaId}`,
          recarregar: `finance:${atual.student}`,
        },
      };
    },
  },

  {
    nome: "cobranca_excluir",
    descricao:
      "Apaga a cobrança. Os pagamentos dela viram avulsos — o dinheiro entrou.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: { cobrancaId: { type: "string" } },
      required: ["cobrancaId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.finance.chargeData(args.cobrancaId);
      if (!alvo) return erro("cobranca_nao_encontrada");
      if (!(await app.api.user.dataStudent(user._id, alvo.student))) {
        return erro("cobranca_nao_encontrada");
      }

      await app.api.finance.deleteCharge(args.cobrancaId);

      return {
        ok: true,
        removida: alvo.description || "",
        alvo: {
          rota: rotaDoFinanceiro(alvo.student),
          recarregar: `finance:${alvo.student}`,
        },
      };
    },
  },

  {
    nome: "pagamento_registrar",
    descricao:
      "O dinheiro que ENTROU. Com `cobrancaId` abate dela, que vira quitada " +
      "sozinha ao ser coberta; sem ele é avulso (adiantamento, venda).",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        valor: { type: "string" },
        forma: { type: "string", description: "pix, cash, credit…" },
        data: { type: "string", description: "AAAA-MM-DD, com hora ou sem" },
        cobrancaId: { type: "string" },
        observacao: { type: "string" },
        situacao: { type: "string", enum: ["paid", "pending", "refunded"] },
        moeda: { type: "string", description: "BRL, USD, EUR… Sem isso, a da conta." },
      },
      required: ["pessoaId", "valor"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      // A forma tem de existir no catálogo DESTA conta: uma chave inventada
      // viraria uma coluna de relatório que não é forma de pagamento nenhuma.
      if (args.forma) {
        const chaves = await app.api.paymentMethod.keys();
        if (!chaves.includes(args.forma)) return erro("forma_desconhecida");
      }

      const moeda = await moedaDoLancamento(app, args.moeda);
      if (!moeda) return erro("moeda_desconhecida");

      const id = await app.api.finance.insertPayment(
        args.pessoaId,
        {
          amount: args.valor,
          method: args.forma || "other",
          date: args.data,
          charge: args.cobrancaId,
          note: args.observacao,
          status: args.situacao,
        },
        user._id,
        moeda
      );

      const criado = await app.api.finance.paymentData(id);
      if (!criado.amount) {
        await app.api.finance.deletePayment(id);
        return erro("valor_invalido");
      }

      const saldo = await app.api.finance.balanceOf(args.pessoaId, moeda);

      return {
        ok: true,
        pagamento: pagamentoPublico(criado),
        saldo,
        alvo: {
          rota: rotaDoFinanceiro(args.pessoaId),
          destacar: `payment:${id}`,
          recarregar: `finance:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "pagamento_excluir",
    descricao: "Apaga um pagamento. A cobrança que ele quitava volta a ficar em aberto.",
    permissao: "finance.manage",
    schema: {
      type: "object",
      properties: { pagamentoId: { type: "string" } },
      required: ["pagamentoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.finance.paymentData(args.pagamentoId);
      if (!alvo) return erro("pagamento_nao_encontrado");
      if (!(await app.api.user.dataStudent(user._id, alvo.student))) {
        return erro("pagamento_nao_encontrado");
      }

      await app.api.finance.deletePayment(args.pagamentoId);

      return {
        ok: true,
        alvo: {
          rota: rotaDoFinanceiro(alvo.student),
          recarregar: `finance:${alvo.student}`,
        },
      };
    },
  },
  // ── Agenda ───────────────────────────────────────────────────────────────
  //
  // O compromisso é de UM profissional, e por padrão é de quem está operando.
  // Marcar no horário de um colega exige `schedule.team` — sem ela o pedido é
  // ignorado e o compromisso fica com quem marcou, que é a mesma regra da tela.
  //
  // Marcar um serviço com valor cria a COBRANÇA sozinho, com vencimento no dia
  // do atendimento. Isso acontece na rota da tela, não aqui — e por isso a
  // ferramenta chama a mesma função dela.

  {
    nome: "servico_listar",
    descricao:
      "Os serviços, com duração e preço. É daqui que sai o `servicoId`, e é ele " +
      "que decide o valor da cobrança.",
    permissao: "schedule.view",
    schema: { type: "object", properties: {}, required: [] },
    async executar(app) {
      const rows = await app.api.service.list({ apenasAtivos: true });

      return {
        ok: true,
        servicos: rows.map((s) => ({
          id: String(s._id),
          nome: s.name,
          minutos: s.minutes,
          valor: dinheiro(s.price, s.currency),
        })),
      };
    },
  },

  {
    nome: "agenda_ver",
    descricao:
      "Os compromissos de um período — sem datas, os próximos sete dias. É daqui " +
      "que sai o `compromissoId`.",
    permissao: "schedule.view",
    schema: {
      type: "object",
      properties: {
        de: { type: "string", description: "AAAA-MM-DD" },
        ate: { type: "string", description: "AAAA-MM-DD" },
        pessoaId: { type: "string", description: "Só os desta pessoa." },
      },
      required: [],
    },
    async executar(app, user, args) {
      const de = args.de ? new Date(args.de) : new Date();
      const ate = args.ate ? new Date(args.ate) : new Date(de.getTime() + 7 * 86400000);
      if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) return erro("data_invalida");

      const rows = await app.api.appointment.between([user._id], de, ate);
      const filtrados = args.pessoaId
        ? rows.filter((a) => String(a.student) === String(args.pessoaId))
        : rows;

      const nomes = await app.api.user.briefByIds(filtrados.map((a) => a.student));

      return {
        ok: true,
        compromissos: filtrados.map((a) => compromissoPublico(a, nomes)),
        alvo: { rota: "/agenda" },
      };
    },
  },

  {
    nome: "compromisso_criar",
    descricao:
      "Marca um atendimento. Serviço com valor gera a cobrança sozinho.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        quando: { type: "string", description: "AAAA-MM-DDTHH:mm" },
        minutos: { type: "integer", minimum: 5, maximum: 480 },
        servicoId: { type: "string" },
        titulo: { type: "string" },
        observacao: { type: "string" },
      },
      required: ["pessoaId", "quando"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const inicio = new Date(args.quando);
      if (Number.isNaN(inicio.getTime())) return erro("data_invalida");

      const servico = args.servicoId ? await app.api.service.data(args.servicoId) : null;
      const minutos = args.minutos || servico?.minutes || 60;

      // O MESMO aviso da tela: o horário já ocupado não é recusado, mas é dito.
      // Recusar impediria o encaixe combinado por telefone; calar faria a
      // sobreposição aparecer só quando as duas pessoas chegassem.
      const cruzam = await app.api.appointment.conflicts([user._id], inicio, minutos);

      const id = await app.api.appointment.insert(
        user._id,
        args.pessoaId,
        {
          date: inicio,
          minutes: minutos,
          service: args.servicoId,
          title: args.titulo,
          note: args.observacao,
        },
        user._id
      );

      const criado = await app.api.appointment.data([user._id], id);
      const nomes = await app.api.user.briefByIds([args.pessoaId]);

      return {
        ok: true,
        compromisso: compromissoPublico(criado, nomes),
        conflita: cruzam.length > 0,
        alvo: {
          rota: "/agenda",
          destacar: `appointment:${id}`,
          recarregar: `agenda:${inicio.toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  {
    nome: "compromisso_editar",
    descricao: "Remarca ou muda a duração, o serviço, o título ou a observação.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        compromissoId: { type: "string" },
        quando: { type: "string" },
        minutos: { type: "integer", minimum: 5, maximum: 480 },
        servicoId: { type: "string" },
        titulo: { type: "string" },
        observacao: { type: "string" },
      },
      required: ["compromissoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.appointment.data([user._id], args.compromissoId);
      if (!atual) return erro("compromisso_nao_encontrado");

      const quando = args.quando === undefined ? atual.date : new Date(args.quando);
      if (Number.isNaN(new Date(quando).getTime())) return erro("data_invalida");

      await app.api.appointment.update([user._id], args.compromissoId, {
        date: quando,
        minutes: args.minutos === undefined ? atual.minutes : args.minutos,
        service: args.servicoId === undefined ? atual.service : args.servicoId,
        title: args.titulo === undefined ? atual.title : args.titulo,
        note: args.observacao === undefined ? atual.note : args.observacao,
        status: atual.status,
      });

      const depois = await app.api.appointment.data([user._id], args.compromissoId);
      const nomes = await app.api.user.briefByIds([depois.student]);

      return {
        ok: true,
        compromisso: compromissoPublico(depois, nomes),
        alvo: {
          rota: "/agenda",
          destacar: `appointment:${args.compromissoId}`,
          recarregar: `agenda:${new Date(depois.date).toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  {
    nome: "compromisso_situacao",
    descricao:
      "Marca presença. Faltou e desmarcado são coisas diferentes: um é falta da " +
      "pessoa, o outro foi combinado.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: {
        compromissoId: { type: "string" },
        situacao: { type: "string", enum: ["scheduled", "done", "missed", "canceled"] },
      },
      required: ["compromissoId", "situacao"],
    },
    async executar(app, user, args) {
      const ok = await app.api.appointment.setStatus(
        [user._id],
        args.compromissoId,
        args.situacao
      );
      if (!ok) return erro("compromisso_nao_encontrado");

      const depois = await app.api.appointment.data([user._id], args.compromissoId);
      const nomes = await app.api.user.briefByIds([depois.student]);

      return {
        ok: true,
        compromisso: compromissoPublico(depois, nomes),
        alvo: {
          rota: "/agenda",
          destacar: `appointment:${args.compromissoId}`,
          recarregar: `agenda:${new Date(depois.date).toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  {
    nome: "compromisso_excluir",
    descricao:
      "Apaga o compromisso. Para dizer que não aconteceu sem perder o registro, " +
      "use compromisso_situacao.",
    permissao: "schedule.manage",
    schema: {
      type: "object",
      properties: { compromissoId: { type: "string" } },
      required: ["compromissoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.appointment.data([user._id], args.compromissoId);
      if (!alvo) return erro("compromisso_nao_encontrado");

      await app.api.appointment.delete([user._id], args.compromissoId);

      return {
        ok: true,
        alvo: {
          rota: "/agenda",
          recarregar: `agenda:${new Date(alvo.date).toISOString().slice(0, 10)}`,
        },
      };
    },
  },

  // ── Avaliação física ─────────────────────────────────────────────────────
  //
  // O que se guarda são as MEDIDAS; percentual de gordura, massa magra e IMC
  // são derivados, calculados na tela a partir do método e do protocolo. Por
  // isso as ferramentas não recebem resultado nenhum: mandar "18% de gordura"
  // gravaria um número que a próxima conta contradiz.

  {
    nome: "avaliacao_listar",
    descricao: "As avaliações de uma pessoa, da mais recente para a mais antiga.",
    permissao: "assessments.view",
    schema: {
      type: "object",
      properties: { pessoaId: { type: "string" } },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const rows = await app.api.assessment.list(user._id, args.pessoaId);

      return {
        ok: true,
        avaliacoes: rows.map(avaliacaoPublica),
        alvo: { rota: rotaDaAvaliacao(args.pessoaId) },
      };
    },
  },

  {
    nome: "avaliacao_criar",
    descricao:
      "Lança uma medida. Gordura e IMC NÃO se mandam: são calculados.",
    permissao: "assessments.manage",
    schema: {
      type: "object",
      properties: {
        pessoaId: { type: "string" },
        data: { type: "string", description: "AAAA-MM-DD. Sem isso, hoje." },
        peso: { type: "number", description: "Em kg." },
        altura: { type: "number", description: "Em cm ou em metros — os dois servem." },
        dobras: { type: "object", description: "mm: triceps, subscapular, suprailiac, abdominal, thigh, chest, midaxillary" },
        circunferencias: { type: "object", description: "cm: waist, hip, chest, arm, thigh, calf, neck, shoulder" },
        observacao: { type: "string" },
      },
      required: ["pessoaId"],
    },
    async executar(app, user, args) {
      const pessoa = await app.api.user.dataStudent(user._id, args.pessoaId);
      if (!pessoa) return erro("pessoa_nao_encontrada");

      const id = await app.api.assessment.insert(user._id, args.pessoaId, {
        date: args.data,
        weight: args.peso,
        height: args.altura,
        skinfolds: args.dobras,
        circumferences: args.circunferencias,
        note: args.observacao,
        // Nasce PRONTA, e não rascunho: o rascunho existe para a tela gravar
        // campo a campo enquanto se digita, e aqui a medida chega inteira.
        draft: false,
      });

      const criada = await app.api.assessment.data(user._id, id);

      return {
        ok: true,
        avaliacao: avaliacaoPublica(criada),
        alvo: {
          rota: rotaDaAvaliacao(args.pessoaId),
          destacar: `assessment:${id}`,
          recarregar: `assessment:${args.pessoaId}`,
        },
      };
    },
  },

  {
    nome: "avaliacao_editar",
    descricao: "Corrige uma medida já lançada. Só o que vier muda.",
    permissao: "assessments.manage",
    schema: {
      type: "object",
      properties: {
        avaliacaoId: { type: "string" },
        data: { type: "string" },
        peso: { type: "number" },
        altura: { type: "number" },
        dobras: { type: "object" },
        circunferencias: { type: "object" },
        observacao: { type: "string" },
      },
      required: ["avaliacaoId"],
    },
    async executar(app, user, args) {
      const atual = await app.api.assessment.data(user._id, args.avaliacaoId);
      if (!atual) return erro("avaliacao_nao_encontrada");

      await app.api.assessment.update(user._id, args.avaliacaoId, {
        ...atual,
        date: args.data === undefined ? atual.date : args.data,
        weight: args.peso === undefined ? atual.weight : args.peso,
        height: args.altura === undefined ? atual.height : args.altura,
        skinfolds: args.dobras === undefined ? atual.skinfolds : args.dobras,
        circumferences:
          args.circunferencias === undefined ? atual.circumferences : args.circunferencias,
        note: args.observacao === undefined ? atual.note : args.observacao,
      });

      const depois = await app.api.assessment.data(user._id, args.avaliacaoId);

      return {
        ok: true,
        avaliacao: avaliacaoPublica(depois),
        alvo: {
          rota: rotaDaAvaliacao(depois.student),
          destacar: `assessment:${args.avaliacaoId}`,
          recarregar: `assessment:${depois.student}`,
        },
      };
    },
  },

  {
    nome: "avaliacao_excluir",
    descricao: "Apaga uma avaliação, com as fotos dela.",
    permissao: "assessments.manage",
    schema: {
      type: "object",
      properties: { avaliacaoId: { type: "string" } },
      required: ["avaliacaoId"],
    },
    async executar(app, user, args) {
      const alvo = await app.api.assessment.data(user._id, args.avaliacaoId);
      if (!alvo) return erro("avaliacao_nao_encontrada");

      await app.api.assessment.delete(user._id, args.avaliacaoId);

      return {
        ok: true,
        alvo: {
          rota: rotaDaAvaliacao(alvo.student),
          recarregar: `assessment:${alvo.student}`,
        },
      };
    },
  },
];

const PORNOME = new Map(FERRAMENTAS.map((f) => [f.nome, f]));

function listar() {
  return FERRAMENTAS.map((f) => ({
    name: f.nome,
    description: f.descricao,
    inputSchema: f.schema,
  }));
}

function achar(nome) {
  return PORNOME.get(nome);
}

module.exports = { FERRAMENTAS, listar, achar, erro, pessoaPublica, treinoPublico, ObjectId };
