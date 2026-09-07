const { seedFoods } = require("./foods.js");
// Cria as collections e os índices. Roda no boot (app.js) e também sozinho via
// `npm run db:init`. Idempotente: rodar de novo não duplica nada.
//
// São DOIS conjuntos, e a divisão é o desenho:
//
//   CENTRAL (`gofitnow_center`)    o que é IGUAL PARA TODO MUNDO.
//   POR INSTÂNCIA (`gofitnow_x`)   o que é de um cliente só.
//
// O catálogo de exercícios está no central porque é igual para todo mundo. Tudo
// que é conta, treino, vínculo e histórico está na instância — e ali o
// isolamento é do BANCO, não de um filtro que alguém pode esquecer.
//
// O banco central é COMPARTILHADO com o painel do center, e a divisão de dono é
// por collection: o painel cria e indexa `instances`, `admins`, `sessions`,
// `plans` e `groups`; este arquivo cria e indexa `exercises`. Nenhum dos dois
// mexe no que é do outro.
const instanceContext = require("../lib/instance.js");

// `ai_usage` é o consumo de IA por instância — contagem e custo, NUNCA conteúdo
// de conversa. Este arquivo é o dono dela; o painel só lê. A conversa em si mora
// no banco do cliente (`ai_sessions`), com o resto do que é dele.
const CENTRAL = ["exercises", "foods", "ai_usage"];

// Quanto tempo o histórico de ações fica. Decisão do Marlon em 07/09/2026 — ver
// o comentário longo em `indicesEssenciais`.
//
// Constante e não número solto na chamada: mudar a retenção é mudar uma linha, e
// o nome diz o que o `expireAfterSeconds` está contando (o segundo é a unidade
// do Mongo, o dia é a unidade da decisão).
const PODA_HISTORICO_DIAS = 180;

const POR_INSTANCIA = [
  "users",
  "user_tokens",
  "workouts",
  "diets",
  "anamnesis",
  "anamnesis_links",
  "supplements",
  "exams",
  "prescriptions",
  "assessments",
  "assessment_photos",
  "appointments",
  "services",
  "availability",
  "booking_pages",
  "charges",
  "payments",
  "payment_files",
  "conversations",
  "messages",
  "message_files",
  "password_resets",
  "professional_links",
  "roles",
  "user_action_history",
  "workout_templates",
  // `diet_templates` estava FALTANDO nesta lista, e por isso nunca teve índice:
  // ela existia só porque o Mongo cria a collection na primeira inserção. Achei
  // no ensaio da migração — a soma de documentos deu 2 a menos que a contagem
  // direta do servidor, e os 2 eram os templates de dieta do `will`.
  //
  // Com um banco por cliente a falta custava pouco (uma varredura numa collection
  // de dois documentos). Num banco só, custaria varrer os templates de todos os
  // clientes a cada abertura da tela.
  "diet_templates",
  // `recipe_categories` estava faltando pelo mesmo motivo do `diet_templates`, e
  // achei no mesmo ensaio. Ela vive nos DOIS bancos de propósito: as nossas
  // categorias no central, as que o cliente criou (e as que ele escondeu) aqui.
  // Só a metade do cliente é responsabilidade desta lista.
  //
  // Não tinha dado em nenhum cliente ainda, então a migração não perdeu nada —
  // mas na primeira inserção o Mongo criaria a collection sem índice, e a leitura
  // varreria as categorias de todos os clientes.
  "recipe_categories",
  "payment_methods",
  "auto_fill_values",
  "avatars",
  "brand_images",
  "api_keys",
  "api_calls",
  "tenants",
  "configurations",
  "ai_sessions",
];

// A instância que nasce com o sistema. Sem ela o primeiro boot sobe um servidor
// que não atende ninguém.
const SEED_INSTANCE = process.env.SEED_INSTANCE || "marlon";
const SEED_EMAIL = process.env.SEED_EMAIL || "marlon@gofitnow.fit";

async function criarFaltantes(db, nomes, rotulo) {
  const existentes = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

  for (const nome of nomes) {
    if (!existentes.includes(nome)) {
      await db.createCollection(nome);
      console.log(`[schema] ${rotulo}: collection criada — ${nome}`);
    }
  }
}

// ── Central ────────────────────────────────────────────────────────────────

async function ensureCentral(app) {
  const db = await app.mongodb.centralDb();
  await criarFaltantes(db, CENTRAL, "central");

  // A collection `instances` NÃO é criada aqui: ela mora no banco do painel, e
  // o dono do schema dela é o painel. Este backend só a lê.

  // exercises — o catálogo compartilhado (`instance: null`) mais o que cada
  // conta criou (`instance: "marlon"`), na mesma collection.
  //
  // Os índices começam por `instance` porque TODA consulta começa por ele: a
  // conta nunca lê a collection inteira, lê a fatia dela que é sua mais a
  // compartilhada. Um índice que comece por `nameSort` faria o Mongo varrer os
  // mil e quatrocentos para depois descartar os de outras contas.
  //
  // A ordenação e a busca usam `nameSort` (nome sem acento, minúsculo) — ver
  // Exercise_model.
  // `hasVideo` na frente do nome: a lista mostra os que têm demonstração
  // primeiro e os sem vídeo no fim. Sem ele no índice, essa ordenação passaria a
  // ser feita na memória, com mil e quatrocentos documentos por página.
  await db
    .collection("exercises")
    .createIndex({ instance: 1, hasVideo: -1, nameSort: 1 }, { name: "by_instance_video_name" });
  await db.collection("exercises").createIndex({ instance: 1, nameSort: 1 }, { name: "by_instance_name" });
  await db
    .collection("exercises")
    .createIndex({ instance: 1, muscleGroup: 1, nameSort: 1 }, { name: "by_instance_group" });

  // Os índices sem `instance` deixaram de servir a qualquer consulta, e índice
  // morto não é inofensivo: continua sendo atualizado em toda escrita.
  for (const morto of ["by_name", "by_group"]) {
    await dropIndexIfPresent(db, "exercises", morto);
  }

  // foods — o catálogo de alimentos, central como o de exercícios e com a mesma
  // chave de busca sem acento.
  await db.collection("foods").createIndex({ nameSort: 1 }, { name: "by_name" });
  await db.collection("foods").createIndex({ category: 1, nameSort: 1 }, { name: "by_category" });

  // A FOTO do alimento: `imageKey` aponta para uma linha de `food_images`, que
  // é do painel. Muitos alimentos para uma foto — as três tabelas dizem "peito
  // de frango grelhado" de quatro maneiras, e é uma imagem só.
  //
  // O índice mora aqui porque `foods` é desta base: o painel escreve o campo,
  // mas quem cria e mantém o schema desta collection é quem a semeou. Ele serve
  // à fila de trabalho da tela do painel ("o que ainda está sem foto") e à
  // limpeza que desliga todas as linhas de uma imagem apagada.
  await db.collection("foods").createIndex({ imageKey: 1 }, { name: "by_image" });

  // ai_usage — o consumo por instância. Uma linha por sessão, incrementada a
  // cada turno; o índice é o que a torna única e o que o painel usa para somar
  // por cliente e por período.
  await db
    .collection("ai_usage")
    .createIndex({ instance: 1, sessionId: 1 }, { unique: true, name: "instance_session" });
  await db
    .collection("ai_usage")
    .createIndex({ instance: 1, createdAt: -1 }, { name: "by_instance_date" });

  const semeados = await seedFoods(db);
  if (semeados) console.log(`[schema] catálogo de alimentos semeado: ${semeados} itens`);

  // Os índices por `trainer` não têm mais campo para indexar. Um índice morto
  // não é inofensivo: ele continua sendo atualizado em toda escrita.
  for (const morto of ["by_trainer_name", "by_trainer_group"]) {
    await dropIndexIfPresent(db, "exercises", morto);
  }

  return db;
}

// ── Por instância ──────────────────────────────────────────────────────────

// ── O QUE UMA INSTÂNCIA PRECISA PARA JÁ ABRIR ─────────────────────────────
//
// Criar as 29 coleções e os 85 índices leva ~900 ms no servidor, e o cadastro
// esperava por tudo antes de responder. Só que quem acabou de se inscrever não
// usa `payment_files` nem `ai_sessions` no primeiro minuto: usa entrar, criar
// senha, os papéis do sistema e a trilha de auditoria.
//
// Então o cadastro cria ESTAS cinco coleções e os índices delas (~150 ms), e
// manda o resto para depois da resposta. `ensureInstance` continua sendo a
// verdade completa — e continua idempotente, então rodar as duas na ordem que
// for não repete nem conflita.
const ESSENCIAIS = ["users", "roles", "user_tokens", "password_resets", "user_action_history"];

async function indicesEssenciais(db) {
  // users — o e-mail é a chave de login, então o índice único no banco é o que
  // de fato impede dois cadastros iguais (a checagem no controller sozinha
  // perde a corrida entre duas requisições simultâneas).
  //
  // PARCIAL porque uma pessoa sem acesso pode não ter e-mail nenhum: sem o
  // filtro, a segunda colidiria com a primeira.
  //
  // Ele é único DENTRO da instância. É a consequência mais importante de um
  // banco por cliente: o mesmo e-mail pode ter conta em duas instâncias, e as
  // duas são contas diferentes. Foi o que tornou o pedido de acesso
  // desnecessário — "essa pessoa já tem conta em outro lugar" deixou de ser um
  // problema que a gente precise resolver.
  // Único POR CLIENTE, e não é teoria: na migração, dois e-mails já existiam em
  // duas academias cada — brunasampaio1611@gmail.com em `bruna` e `marlon`,
  // marlon.20rj@gmail.com em `marlon` e `will`. Único global recusaria a segunda
  // conta de cada um, e a criação do índice falharia na hora da migração.
  await db.collection("users").createIndex(
    { instance: 1, email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique" }
  );

  // username — a outra chave de login. Mesmo desenho do e-mail, pelo mesmo
  // motivo: a checagem no controller perde a corrida entre duas requisições
  // simultâneas, e quem garante é o índice.
  //
  // PARCIAL de novo, e aqui é ainda mais necessário: quase ninguém tem nome de
  // usuário. Sem o filtro, a segunda conta sem o campo colidiria com a primeira —
  // `null` é um valor como qualquer outro para um índice único.
  // Mesmo raciocínio do e-mail: o apelido é escolhido dentro de uma academia.
  await db.collection("users").createIndex(
    { instance: 1, username: 1 },
    {
      unique: true,
      partialFilterExpression: { username: { $type: "string" } },
      name: "username_unique",
    }
  );

  // A lista de admin e a tela de Usuários: tudo de um tipo, mais novo primeiro.
  await db.collection("users").createIndex({ instance: 1, type: 1, createdAt: -1 }, { name: "by_type_created" });
  await db.collection("users").createIndex({ instance: 1, type: 1, name: 1 }, { name: "by_type_name" });
  await db.collection("users").createIndex({ instance: 1, admin: 1 }, { name: "by_admin" });
  await db.collection("users").createIndex({ instance: 1, role: 1 }, { name: "by_role" });

  // user_tokens — consultado por token em toda requisição; o TTL varre os
  // expirados.
  await db.collection("user_tokens").createIndex({ instance: 1, token: 1 }, { unique: true, name: "token_unique" });
  await db
    .collection("user_tokens")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "token_ttl" });
  await db.collection("user_tokens").createIndex({ instance: 1, user: 1 }, { name: "by_user" });
  // anamnesis — um documento por (profissional, pessoa), e o índice é ÚNICO: é
  // ele que garante que duas abas abertas na mesma ficha não criem duas
  // anamneses da mesma pessoa.
  await db
    .collection("anamnesis")
    .createIndex({ instance: 1, trainer: 1, student: 1 }, { unique: true, name: "por_pessoa_unico" });

  // anamnesis_links — o link público é procurado pelo TOKEN, que é único; e o
  // TTL varre os vencidos sozinho, senão a collection cresceria para sempre com
  // endereços que já não abrem nada.
  await db
    .collection("anamnesis_links")
    .createIndex({ instance: 1, token: 1 }, { unique: true, name: "token_unico" });
  await db
    .collection("anamnesis_links")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "link_ttl" });
  await db
    .collection("anamnesis_links")
    .createIndex({ instance: 1, trainer: 1, student: 1 }, { name: "por_pessoa" });

  // supplements — a suplementação é lida SEMPRE por (profissional, pessoa), e a
  // ordem de exibição é montada na memória (por momento do dia), então o índice
  // só precisa do par.
  await db
    .collection("supplements")
    .createIndex({ instance: 1, trainer: 1, student: 1 }, { name: "by_trainer_student" });

  // exams — o par de sempre mais a data da coleta: a lista abre da mais
  // recente para trás, e é a coleta que ordena a tabela de evolução.
  await db
    .collection("exams")
    .createIndex({ instance: 1, trainer: 1, student: 1, collectedAt: -1 }, { name: "by_trainer_student_collected" });

  // prescriptions — mesmo par, mais a data: a lista abre pela mais recente, que
  // é a que vale.
  await db
    .collection("prescriptions")
    .createIndex({ instance: 1, trainer: 1, student: 1, date: -1 }, { name: "by_trainer_student_date" });

  // password_resets — consultado por hash do token; o TTL varre os expirados.
  await db
    .collection("password_resets")
    .createIndex({ instance: 1, tokenHash: 1 }, { unique: true, name: "token_hash_unique" });
  await db
    .collection("password_resets")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "reset_ttl" });
  await db.collection("password_resets").createIndex({ instance: 1, user: 1 }, { name: "by_user" });
  // roles — os tipos de usuário. Poucas linhas, lidas em toda requisição
  // autenticada, então o nome é único para dois "Administrador" nunca
  // coexistirem.
  await db.collection("roles").createIndex({ instance: 1, name: 1 }, { unique: true, name: "role_name_unique" });
  await db.collection("roles").createIndex({ instance: 1, permissions: 1 }, { name: "by_permission" });

  // user_action_history — muita escrita, lido por "quem fez isto" e "o que
  // aconteceu com este registro".
  //
  // ── A PODA DE 180 DIAS (07/09/2026) ──────────────────────────────────────
  //
  // Aqui dizia **"sem TTL: uma trilha de auditoria que se apaga sozinha não é
  // uma"**, e completava: *"se um dia precisar de poda, que seja decisão
  // explícita e não uma varredura que ninguém lembra de ter configurado"*.
  //
  // A decisão explícita aconteceu. Eu mostrei ao Marlon que esta era a maior
  // collection em contagem (2.792 documentos, 1,3 MB) e a única que cresce para
  // sempre — `api_calls` tem 90 dias, `client_errors` 30, sessões e tokens têm
  // os deles, e esta não tinha nada. Ele respondeu: *"pode 6 meses, limpe o que
  // for antigo"*.
  //
  // Então o comentário antigo continua valendo como regra: a poda é decisão de
  // quem tem o dado, tomada e registrada — não um padrão que apareceu sozinho.
  //
  // ── POR QUE 180 DIAS SERVE ───────────────────────────────────────────────
  //
  // O que se pergunta a esta collection é "quem mexeu nisto?", e essa pergunta
  // nasce de uma conversa de suporte — que acontece dias depois do fato, não
  // meses. Meio ano cobre com folga qualquer "mês passado alguém apagou o treino
  // da Bruna", que é o caso real.
  //
  // ── O TTL É UM ÍNDICE À PARTE, e tem de ser ──────────────────────────────
  //
  // Ele NÃO pode ser um dos compostos abaixo: o Mongo só expira por índice de um
  // campo só. E é um campo só sem `instance`, o que está certo — a poda é do
  // sistema, não de um cliente, e a data é a mesma régua para todos.
  //
  // Custo: um quinto índice numa collection que só escreve. É uma data por
  // documento, e o que ele evita é a collection dobrar de tamanho a cada
  // semestre para sempre.
  //
  // Quem apaga é o monitor de TTL do Mongo, que passa a cada minuto. Criar o
  // índice JÁ É a limpeza — não existe script de poda para lembrar de rodar, que
  // era metade da objeção do comentário antigo.
  await db
    .collection("user_action_history")
    .createIndex({ createdAt: 1 }, { expireAfterSeconds: PODA_HISTORICO_DIAS * 86400, name: "poda_180d" });

  await db.collection("user_action_history").createIndex({ instance: 1, createdAt: -1 }, { name: "by_date" });
  await db
    .collection("user_action_history")
    .createIndex({ instance: 1, user: 1, createdAt: -1 }, { name: "by_user_date" });
  await db
    .collection("user_action_history")
    .createIndex({ instance: 1, "target.type": 1, "target.id": 1, createdAt: -1 }, { name: "by_target" });
  await db
    .collection("user_action_history")
    .createIndex({ instance: 1, action: 1, createdAt: -1 }, { name: "by_action" });
}

// ── OS DADOS: um banco só, para todos os clientes ──────────────────────────
//
// Collections e índices são do BANCO, não do cliente. Nascem uma vez, no boot.
//
// Era por cliente até 24/08/2026: cada um ganhava 35 collections e ~99 índices no
// próprio banco. A conta que derrubou aquilo está no cabeçalho de
// `config/mongodb.js` — em resumo, mil clientes já davam ~134 mil arquivos no
// WiredTiger, e o catálogo do Mongo mora em RAM.
//
// O banco vem CRU, sem escopo, porque criar índice é justamente a operação que
// não pode ser escopada: `lib/escopo.js` recusa `createIndex` de propósito, para
// a decisão de pôr `instance` como primeiro campo ficar visível AQUI e não
// escondida atrás de um proxy.
async function ensureDados(app) {
  // ── EM CADA BANCO REGISTRADO ──────────────────────────────────────────────
  //
  // Desde que o painel pode registrar mais de um banco (um padrão e os dedicados
  // dos clientes grandes), collections e índices têm de existir em TODOS. Um
  // banco recém-registrado sem as 37 collections é um cliente que não abre — e o
  // erro apareceria como "sumiu tudo", longe da causa.
  //
  // Idempotente por construção: `criarFaltantes` só cria o que falta e
  // `createIndex` com a mesma chave e o mesmo nome é no-op.
  const bancos = await app.mongodb.bancosRegistrados();

  for (const destino of bancos) {
    console.log(`[schema] dados: preparando "${destino.nome}" (${destino.banco})`);
    await ensureUmBanco(await app.mongodb.bancoCruSemEscopo(destino.uri));
  }

  console.log(`[schema] dados: ${bancos.length} banco(s) pronto(s)`);
}

// As collections e os índices de UM banco. Separado do laço acima para o corpo
// não ganhar um nível de indentação e para a migração poder preparar um banco
// recém-registrado sozinha.
async function ensureUmBanco(db) {
  await criarFaltantes(db, POR_INSTANCIA, "dados");

  // Os índices que os primeiros minutos de um cliente usam (entrar, criar senha,
  // papéis, auditoria). Separados por herança da época em que o cadastro criava
  // só eles antes de responder; hoje rodam juntos, e a separação continua
  // documentando quais são os críticos.
  await indicesEssenciais(db);

  // workouts — sempre listados por (trainer, student), na ordem do período.
  await db
    .collection("workouts")
    .createIndex({ instance: 1, trainer: 1, student: 1, startDate: -1 }, { name: "by_trainer_student" });

  // A tela geral de treinos: todos os do profissional, do mais novo para o mais
  // antigo. É a ordem padrão da lista e a primeira etapa da agregação que a
  // pagina — sem este índice, cada abertura varre a collection inteira.
  await db
    .collection("workouts")
    .createIndex({ instance: 1, trainer: 1, createdAt: -1 }, { name: "by_trainer_created" });

  // Ordenar por nome do treino, também dentro do escopo do profissional.
  await db.collection("workouts").createIndex({ instance: 1, trainer: 1, name: 1 }, { name: "by_trainer_name" });

  // diets — sempre listados por (trainer, student), do mais novo para o mais
  // antigo, que é a ordem da aba Dieta dentro da pessoa.
  await db
    .collection("diets")
    .createIndex({ instance: 1, trainer: 1, student: 1, createdAt: -1 }, { name: "by_trainer_student" });

  // assessments — sempre lidas por (trainer, student), da coleta mais nova para
  // a mais antiga: é a ordem da linha do tempo e a do gráfico de evolução.
  await db
    .collection("assessments")
    .createIndex({ instance: 1, trainer: 1, student: 1, date: -1 }, { name: "by_trainer_student" });

  // assessment_photos — sempre buscada pelo par (coleta, ângulo), que é também
  // o que a torna única: subir de novo o mesmo lado substitui, nunca acumula.
  await db
    .collection("assessment_photos")
    .createIndex({ instance: 1, assessment: 1, side: 1 }, { unique: true, name: "by_assessment_side" });


  // appointments — a agenda. Lida de duas formas: a semana do profissional
  // (por data) e o histórico de uma pessoa (por pessoa, do mais novo ao mais
  // antigo). Um índice para cada, porque são consultas diferentes.
  await db
    .collection("appointments")
    .createIndex({ instance: 1, trainer: 1, date: 1 }, { name: "by_trainer_date" });
  await db
    .collection("appointments")
    .createIndex({ instance: 1, trainer: 1, student: 1, date: -1 }, { name: "by_trainer_student" });

  // services — poucos por cliente, sempre lidos inteiros e em ordem de
  // apresentação. O índice é só para a ordenação não ler a collection toda.
  await db.collection("services").createIndex({ instance: 1, order: 1, name: 1 }, { name: "by_order" });

  // availability — uma grade por profissional, lida pelo id dele.
  await db
    .collection("availability")
    .createIndex({ instance: 1, professional: 1 }, { unique: true, name: "professional_unique" });

  // booking_pages — a página é achada pelo APELIDO da URL, e dois apelidos
  // iguais fariam a mesma rota responder coisas diferentes conforme a ordem do
  // banco. O índice é quem garante; a checagem no modelo é só pela mensagem.
  await db
    .collection("booking_pages")
    .createIndex({ instance: 1, slug: 1 }, { unique: true, name: "slug_unique" });

  // charges e payments — sempre lidos de uma pessoa, do mais recente para o
  // mais antigo, que é a ordem da aba Financeiro.
  await db.collection("charges").createIndex({ instance: 1, student: 1, dueDate: -1 }, { name: "by_student" });
  // E pelo compromisso, que é como a cobrança automática confere se já existe.
  await db.collection("charges").createIndex({ instance: 1, appointment: 1 }, { name: "by_appointment" });
  await db.collection("payments").createIndex({ instance: 1, student: 1, date: -1 }, { name: "by_student" });
  await db
    .collection("payment_files")
    .createIndex({ instance: 1, payment: 1 }, { unique: true, name: "payment_unique" });

  // conversations — a lista de quem fala com quem.
  //
  // A unicidade é sobre `pairKey`, um ESCALAR com os dois ids ordenados, e não
  // sobre `members`. Índice único em array é multikey: ele exigiria que cada id
  // fosse único na collection, isto é, que cada pessoa participasse de no
  // máximo uma conversa. Foi assim que nasceu e quebrou na segunda conversa de
  // qualquer um.
  await db.collection("conversations").dropIndex("members_unique").catch(() => {});

  // Retroativo para o que foi criado antes de `pairKey` existir. Barato e
  // idempotente: sem documento sem a chave, não escreve nada.
  await db.collection("conversations").updateMany({ pairKey: { $exists: false } }, [
    {
      $set: {
        pairKey: {
          $reduce: {
            input: { $map: { input: "$members", in: { $toString: "$$this" } } },
            initialValue: "",
            in: {
              $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", "_"] }, "$$this"],
            },
          },
        },
      },
    },
  ]);

  await db
    .collection("conversations")
    .createIndex({ instance: 1, pairKey: 1 }, { unique: true, name: "pair_unique" });
  await db
    .collection("conversations")
    .createIndex({ instance: 1, members: 1, lastAt: -1 }, { name: "by_member_recent" });

  // messages — sempre lidas de uma conversa, da mais nova para a mais antiga.
  await db
    .collection("messages")
    .createIndex({ instance: 1, conversation: 1, createdAt: -1 }, { name: "by_conversation" });

  // message_files — buscado pelo id da mensagem; um anexo por mensagem.
  await db
    .collection("message_files")
    .createIndex({ instance: 1, message: 1 }, { unique: true, name: "message_unique" });
  // E pela conversa, que é como a exclusão em cascata os encontra.
  await db.collection("message_files").createIndex({ instance: 1, conversation: 1 }, { name: "by_conversation" });

  // professional_links — lido constantemente (toda lista de pessoas começa
  // aqui) e nos dois sentidos. O par único é o que faz vincular ser idempotente.
  await db
    .collection("professional_links")
    .createIndex({ instance: 1, professional: 1, person: 1 }, { unique: true, name: "link_unique" });
  await db.collection("professional_links").createIndex({ instance: 1, person: 1 }, { name: "by_person" });

  // payment_methods — lidos SEMPRE na ordem escolhida, e a chave é única: ela é
  // o que fica gravado no pagamento, e duas formas com a mesma chave seriam a
  // mesma forma com dois nomes.
  await db.collection("payment_methods").createIndex({ instance: 1, order: 1 }, { name: "by_order" });
  await db.collection("payment_methods").createIndex({ instance: 1, key: 1 }, { unique: true, name: "key_unique" });

  // workout_templates — sempre lidos por profissional, em ordem alfabética.
  // recipe_categories — lida inteira, em ordem de nome: são poucas por cliente.
  await db
    .collection("recipe_categories")
    .createIndex({ instance: 1, name: 1 }, { name: "by_name" });

  // diet_templates — a lista da tela é "os meus, em ordem de nome", e é a única
  // consulta que existe sobre ela.
  await db
    .collection("diet_templates")
    .createIndex({ instance: 1, professional: 1, name: 1 }, { name: "by_professional_name" });

  await db
    .collection("workout_templates")
    .createIndex({ instance: 1, professional: 1, name: 1 }, { name: "by_professional_name" });

  // auto_fill_values — sempre lidos por (profissional, campo). O trio único
  // impede a mesma frase virar duas opções iguais na lista.
  await db
    .collection("auto_fill_values")
    .createIndex({ instance: 1, professional: 1, field: 1, value: 1 }, { unique: true, name: "value_unique" });

  // avatars — uma por usuário, sempre lida por dono.
  await db.collection("avatars").createIndex({ instance: 1, user: 1 }, { unique: true, name: "avatar_user_unique" });

  // brand_images — a logo e as fotos da tela de entrada. O índice é por dono
  // porque as duas operações que existem são "quantas esta conta tem" e "apaga
  // as desta conta que o tema não usa mais".
  await db.collection("brand_images").createIndex({ instance: 1, user: 1 }, { name: "user" });

  // api_keys — a busca de cada requisição é POR HASH, então o índice é nele.
  // Único: dois documentos com o mesmo hash significariam a mesma chave valendo
  // duas vezes, e revogar uma deixaria a outra viva.
  await db.collection("api_keys").createIndex({ instance: 1, hash: 1 }, { unique: true, name: "hash_unique" });
  await db
    .collection("api_keys")
    .createIndex({ instance: 1, user: 1, revokedAt: 1, createdAt: -1 }, { name: "by_user_state" });

  // ai_sessions — a lista do histórico é sempre "as minhas, a mais recente
  // primeiro". `updatedAt` e não `createdAt`: uma conversa retomada volta ao
  // topo, que é onde quem a retomou espera achá-la.
  await db
    .collection("ai_sessions")
    .createIndex({ instance: 1, user: 1, updatedAt: -1 }, { name: "by_user_date" });
  // O resumo de gasto varre por período, sem filtrar por conta: é a conta do
  // cliente inteiro.
  await db.collection("ai_sessions").createIndex({ instance: 1, createdAt: -1 }, { name: "by_date" });

  // api_calls — a tela lê sempre por conta e por data decrescente.
  await db.collection("api_calls").createIndex({ instance: 1, user: 1, createdAt: -1 }, { name: "by_user_date" });
  await db
    .collection("api_calls")
    .createIndex({ instance: 1, user: 1, prefix: 1, createdAt: -1 }, { name: "by_user_key_date" });
  {
    // TTL: o log de tráfego cresce rápido e não tem valor histórico depois de
    // um tempo. O de auditoria é outro e não expira.
    const { DIAS_RETENCAO } = require("../model/ApiCall_model.js");
    await db
      .collection("api_calls")
      .createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: DIAS_RETENCAO * 24 * 60 * 60, name: "ttl_created" }
      );
  }

  // ── configurations — A CONFIGURAÇÃO DA CASA, num documento só ────────────
  //
  // Substitui `tenants`, e a razão é um defeito real: lá o documento era
  // chaveado pelo USUÁRIO, resquício do tempo de banco único (quando cada
  // profissional tinha subdomínio e marca próprios). Com um banco por cliente
  // isso deixou de fazer sentido — e cobrou: quem não era o dono lia um tenant
  // vazio, o web aplicava esse vazio por cima do tema do host, e a marca do
  // cliente sumia no instante em que outro usuário da casa entrava. Salvar era
  // pior: criava um tema paralelo que ninguém mais via.
  //
  // Aqui é UM documento por instância, sem dono. `chave: "instancia"` com
  // índice único é o que garante isso no banco, e não só na intenção do código:
  // um segundo documento é recusado pelo Mongo.
  await db
    .collection("configurations")
    .createIndex({ instance: 1, chave: 1 }, { unique: true, name: "chave_unica" });

  // tenants — LEGADO. Os índices continuam enquanto a collection existir: ela
  // é a cópia de segurança da migração acima, e some quando o dado novo tiver
  // rodado tempo suficiente em produção.
  await db.collection("tenants").createIndex({ instance: 1, user: 1 }, { unique: true, name: "user_unique" });
  // ── ESTES DOIS NÃO LEVAM `instance`, e é de propósito ────────────────────
  //
  // Todo outro índice daqui ganhou `instance` na frente. Endereço, não: duas
  // academias não podem ocupar `bruna.gofitnow.fit`, então a unicidade é GLOBAL.
  // Pôr o cliente na frente autorizaria justamente a colisão que o índice existe
  // para impedir.
  //
  // Com um banco por cliente estes índices não protegiam nada — um documento por
  // banco, e a colisão só era barrada pelo registro no central. Num banco só eles
  // passam a valer. Conferido antes de criar: um único cliente tem subdomínio
  // gravado e nenhum tem domínio próprio, então não há colisão para tropeçar.
  await db
    .collection("tenants")
    .createIndex(
      { subdomain: 1 },
      { unique: true, partialFilterExpression: { subdomain: { $type: "string" } }, name: "subdomain_unique" }
    );
  await db
    .collection("tenants")
    .createIndex(
      { customDomain: 1 },
      { unique: true, partialFilterExpression: { customDomain: { $type: "string" } }, name: "custom_domain_unique" }
    );

  return db;
}

// ── PROVISIONAR UM CLIENTE ─────────────────────────────────────────────────
//
// Isto criava 35 collections e ~99 índices. Era tão caro que precisou ser partido
// em dois — `ensureInstanceEssencial` fazia o mínimo para o cadastro responder
// rápido, e o resto vinha depois, em segundo plano.
//
// Com um banco só, não há DDL nenhum por cliente: sobrou semear os papéis do
// sistema. De ~134 operações de schema para dois inserts.
//
// Os dois nomes continuam existindo porque são o contrato de duas rotas do painel
// (`/internal/instances/:instance/provision` e o cadastro). Fundi-los agora
// misturaria a troca de armazenamento com uma troca de API.
async function ensureInstanceEssencial(app, instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) throw new Error("invalid_instance: " + instance);

  // Tudo aqui roda DENTRO do contexto do cliente: é o que faz o
  // `connectToServer()` dos modelos escopar no cliente certo.
  await instanceContext.run(nome, async () => {
    // Sem os papéis do sistema a tela de Usuários abre vazia e o primeiro
    // convite não tem o que oferecer.
    await app.api.role.ensureSystemRoles();

    // ── A MIGRAÇÃO `tenants` → `configurations`, POR CLIENTE ────────────────
    //
    // Estava no fim do antigo `ensureInstance`, junto dos índices. Quando movi os
    // índices para `ensureDados` (que é do banco, não do cliente), ela veio de
    // carona — e ali estaria ERRADA: lê UM documento de `tenants` e escreve UM de
    // `configurations`, então num banco compartilhado pegaria o `tenants` de
    // qualquer cliente e gravaria a configuração dele para outro.
    //
    // Aqui ela volta a ser por cliente, e o escopo é quem garante isso: as duas
    // consultas abaixo já saem filtradas por `instance`.
    const db = await app.mongodb.connectToServer();

    const jaTem = await db.collection("configurations").findOne({ chave: "instancia" });
    if (jaTem) return;

    // O `tenants` de verdade tinha UM documento por instância (conferido nas
    // quatro em produção); se houver mais de um, o do dono mais antigo é o que
    // vale, pela mesma regra que `dataOfInstance` sempre usou.
    const antigo = await db.collection("tenants").findOne({}, { sort: { createdAt: 1 } });

    if (antigo) {
      const { _id, user, instance: _i, ...resto } = antigo;
      await db.collection("configurations").insertOne({
        chave: "instancia",
        ...resto,
        // Quem criou fica como HISTÓRICO, não como chave: é a diferença entre
        // "esta casa foi montada por fulano" e "esta configuração é do fulano".
        criadoPor: user || null,
        migradoDe: _id,
        migradoEm: new Date(),
      });
      console.log(`[schema] configuração migrada de tenants (${nome})`);
    } else {
      // Cliente sem tenant nenhum (nasceu e ninguém configurou nada): o
      // documento nasce vazio, para as gravações seguintes terem onde cair.
      await db.collection("configurations").insertOne({ chave: "instancia", createdAt: new Date() });
    }
  });

  console.log(`[schema] cliente pronto — ${nome}`);
}

async function ensureInstance(app, instance) {
  return ensureInstanceEssencial(app, instance);
}


// ── O boot ─────────────────────────────────────────────────────────────────

module.exports = async function ensureSchema(app) {
  await ensureCentral(app);

  // A instância semente. `ensure` é idempotente: um segundo boot não
  // sobrescreve o e-mail nem os endereços de quem já está lá.
  const r = await app.api.center.ensure({ instance: SEED_INSTANCE, email: SEED_EMAIL });
  if (!r.ok && r.erro !== "taken") {
    throw new Error(`[schema] instância semente inválida: ${SEED_INSTANCE} (${r.erro})`);
  }

  // As collections e os índices, uma vez: eles são do banco.
  await ensureDados(app);

  // E os papéis de cada cliente registrado — é o que faz um deploy alcançar
  // clientes criados depois da última versão.
  for (const doc of await app.api.center.list()) {
    await ensureInstance(app, doc.instance);
  }

  console.log("[schema] central e instâncias prontas");
};

module.exports.ensureCentral = ensureCentral;
module.exports.ensureDados = ensureDados;
module.exports.ensureUmBanco = ensureUmBanco;
module.exports.ensureInstance = ensureInstance;
module.exports.ensureInstanceEssencial = ensureInstanceEssencial;
module.exports.ESSENCIAIS = ESSENCIAIS;
module.exports.CENTRAL = CENTRAL;
module.exports.POR_INSTANCIA = POR_INSTANCIA;

// Remove um índice que existe; ignora o que já não está lá.
//
// Existe para índice APOSENTADO: quando um campo sai do documento, o índice
// dele continua sendo atualizado em toda escrita sem servir a consulta nenhuma.
async function dropIndexIfPresent(db, collection, name) {
  try {
    const indexes = await db.collection(collection).indexes();
    if (!indexes.some((i) => i.name === name)) return;

    await db.collection(collection).dropIndex(name);
    console.log(`[schema] índice aposentado removido: ${collection}.${name}`);
  } catch (error) {
    // Collection que não existe ainda, ou índice que outro processo já tirou.
    // Nenhum dos dois é problema — o objetivo é o índice não estar lá.
  }
}
