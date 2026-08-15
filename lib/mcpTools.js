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

      const quantas = Math.min(20, Math.max(1, Number(args.series) || 1));
      const series = Array.from({ length: quantas }, () => ({
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
        alvo: { rota: rotaDaDieta(args.pessoaId, id), destacar: `diet:${id}` },
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
        alvo: { rota: `/people/${dieta.student}?tab=diet` },
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
