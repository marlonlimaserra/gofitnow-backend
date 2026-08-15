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

const POR_INSTANCIA = [
  "users",
  "user_tokens",
  "workouts",
  "diets",
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
  "auto_fill_values",
  "avatars",
  "brand_images",
  "api_keys",
  "api_calls",
  "tenants",
  "ai_sessions",
];

// A instância que nasce com o sistema. Sem ela o primeiro boot sobe um servidor
// que não atende ninguém.
const SEED_INSTANCE = process.env.SEED_INSTANCE || "marlon";
const SEED_EMAIL = process.env.SEED_EMAIL || "marlon@sprinthub.com";

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

  // exercises — catálogo ÚNICO, igual para todo mundo. Sem `trainer`: o escopo
  // por profissional saiu quando o catálogo virou central.
  //
  // A ordenação e a busca usam `nameSort` (nome sem acento, minúsculo) — ver
  // Exercise_model.
  await db.collection("exercises").createIndex({ nameSort: 1 }, { name: "by_name" });
  await db.collection("exercises").createIndex({ muscleGroup: 1, nameSort: 1 }, { name: "by_group" });

  // foods — o catálogo de alimentos, central como o de exercícios e com a mesma
  // chave de busca sem acento.
  await db.collection("foods").createIndex({ nameSort: 1 }, { name: "by_name" });
  await db.collection("foods").createIndex({ category: 1, nameSort: 1 }, { name: "by_category" });

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

async function ensureInstance(app, instance) {
  const nome = instanceContext.normalize(instance);
  if (!nome) throw new Error("invalid_instance: " + instance);

  const db = await app.mongodb.instanceDb(nome);
  await criarFaltantes(db, POR_INSTANCIA, nome);

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
  await db.collection("users").createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique" }
  );

  // username — a outra chave de login. Mesmo desenho do e-mail, pelo mesmo
  // motivo: a checagem no controller perde a corrida entre duas requisições
  // simultâneas, e quem garante é o índice.
  //
  // PARCIAL de novo, e aqui é ainda mais necessário: quase ninguém tem nome de
  // usuário. Sem o filtro, a segunda conta sem o campo colidiria com a primeira —
  // `null` é um valor como qualquer outro para um índice único.
  await db.collection("users").createIndex(
    { username: 1 },
    {
      unique: true,
      partialFilterExpression: { username: { $type: "string" } },
      name: "username_unique",
    }
  );

  // A lista de admin e a tela de Usuários: tudo de um tipo, mais novo primeiro.
  await db.collection("users").createIndex({ type: 1, createdAt: -1 }, { name: "by_type_created" });
  await db.collection("users").createIndex({ type: 1, name: 1 }, { name: "by_type_name" });
  await db.collection("users").createIndex({ admin: 1 }, { name: "by_admin" });
  await db.collection("users").createIndex({ role: 1 }, { name: "by_role" });

  // user_tokens — consultado por token em toda requisição; o TTL varre os
  // expirados.
  await db.collection("user_tokens").createIndex({ token: 1 }, { unique: true, name: "token_unique" });
  await db
    .collection("user_tokens")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "token_ttl" });
  await db.collection("user_tokens").createIndex({ user: 1 }, { name: "by_user" });

  // workouts — sempre listados por (trainer, student), na ordem do período.
  await db
    .collection("workouts")
    .createIndex({ trainer: 1, student: 1, startDate: -1 }, { name: "by_trainer_student" });

  // A tela geral de treinos: todos os do profissional, do mais novo para o mais
  // antigo. É a ordem padrão da lista e a primeira etapa da agregação que a
  // pagina — sem este índice, cada abertura varre a collection inteira.
  await db
    .collection("workouts")
    .createIndex({ trainer: 1, createdAt: -1 }, { name: "by_trainer_created" });

  // Ordenar por nome do treino, também dentro do escopo do profissional.
  await db.collection("workouts").createIndex({ trainer: 1, name: 1 }, { name: "by_trainer_name" });

  // diets — sempre listados por (trainer, student), do mais novo para o mais
  // antigo, que é a ordem da aba Dieta dentro da pessoa.
  await db
    .collection("diets")
    .createIndex({ trainer: 1, student: 1, createdAt: -1 }, { name: "by_trainer_student" });

  // assessments — sempre lidas por (trainer, student), da coleta mais nova para
  // a mais antiga: é a ordem da linha do tempo e a do gráfico de evolução.
  await db
    .collection("assessments")
    .createIndex({ trainer: 1, student: 1, date: -1 }, { name: "by_trainer_student" });

  // assessment_photos — sempre buscada pelo par (coleta, ângulo), que é também
  // o que a torna única: subir de novo o mesmo lado substitui, nunca acumula.
  await db
    .collection("assessment_photos")
    .createIndex({ assessment: 1, side: 1 }, { unique: true, name: "by_assessment_side" });


  // appointments — a agenda. Lida de duas formas: a semana do profissional
  // (por data) e o histórico de uma pessoa (por pessoa, do mais novo ao mais
  // antigo). Um índice para cada, porque são consultas diferentes.
  await db
    .collection("appointments")
    .createIndex({ trainer: 1, date: 1 }, { name: "by_trainer_date" });
  await db
    .collection("appointments")
    .createIndex({ trainer: 1, student: 1, date: -1 }, { name: "by_trainer_student" });

  // services — poucos por cliente, sempre lidos inteiros e em ordem de
  // apresentação. O índice é só para a ordenação não ler a collection toda.
  await db.collection("services").createIndex({ order: 1, name: 1 }, { name: "by_order" });

  // availability — uma grade por profissional, lida pelo id dele.
  await db
    .collection("availability")
    .createIndex({ professional: 1 }, { unique: true, name: "professional_unique" });

  // booking_pages — a página é achada pelo APELIDO da URL, e dois apelidos
  // iguais fariam a mesma rota responder coisas diferentes conforme a ordem do
  // banco. O índice é quem garante; a checagem no modelo é só pela mensagem.
  await db
    .collection("booking_pages")
    .createIndex({ slug: 1 }, { unique: true, name: "slug_unique" });

  // charges e payments — sempre lidos de uma pessoa, do mais recente para o
  // mais antigo, que é a ordem da aba Financeiro.
  await db.collection("charges").createIndex({ student: 1, dueDate: -1 }, { name: "by_student" });
  // E pelo compromisso, que é como a cobrança automática confere se já existe.
  await db.collection("charges").createIndex({ appointment: 1 }, { name: "by_appointment" });
  await db.collection("payments").createIndex({ student: 1, date: -1 }, { name: "by_student" });
  await db
    .collection("payment_files")
    .createIndex({ payment: 1 }, { unique: true, name: "payment_unique" });

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
    .createIndex({ pairKey: 1 }, { unique: true, name: "pair_unique" });
  await db
    .collection("conversations")
    .createIndex({ members: 1, lastAt: -1 }, { name: "by_member_recent" });

  // messages — sempre lidas de uma conversa, da mais nova para a mais antiga.
  await db
    .collection("messages")
    .createIndex({ conversation: 1, createdAt: -1 }, { name: "by_conversation" });

  // message_files — buscado pelo id da mensagem; um anexo por mensagem.
  await db
    .collection("message_files")
    .createIndex({ message: 1 }, { unique: true, name: "message_unique" });
  // E pela conversa, que é como a exclusão em cascata os encontra.
  await db.collection("message_files").createIndex({ conversation: 1 }, { name: "by_conversation" });

  // password_resets — consultado por hash do token; o TTL varre os expirados.
  await db
    .collection("password_resets")
    .createIndex({ tokenHash: 1 }, { unique: true, name: "token_hash_unique" });
  await db
    .collection("password_resets")
    .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "reset_ttl" });
  await db.collection("password_resets").createIndex({ user: 1 }, { name: "by_user" });

  // professional_links — lido constantemente (toda lista de pessoas começa
  // aqui) e nos dois sentidos. O par único é o que faz vincular ser idempotente.
  await db
    .collection("professional_links")
    .createIndex({ professional: 1, person: 1 }, { unique: true, name: "link_unique" });
  await db.collection("professional_links").createIndex({ person: 1 }, { name: "by_person" });

  // roles — os tipos de usuário. Poucas linhas, lidas em toda requisição
  // autenticada, então o nome é único para dois "Administrador" nunca
  // coexistirem.
  await db.collection("roles").createIndex({ name: 1 }, { unique: true, name: "role_name_unique" });
  await db.collection("roles").createIndex({ permissions: 1 }, { name: "by_permission" });

  // user_action_history — muita escrita, lido por "quem fez isto" e "o que
  // aconteceu com este registro". Sem TTL: uma trilha de auditoria que se apaga
  // sozinha não é uma. Se um dia precisar de poda, que seja decisão explícita e
  // não uma varredura que ninguém lembra de ter configurado.
  await db.collection("user_action_history").createIndex({ createdAt: -1 }, { name: "by_date" });
  await db
    .collection("user_action_history")
    .createIndex({ user: 1, createdAt: -1 }, { name: "by_user_date" });
  await db
    .collection("user_action_history")
    .createIndex({ "target.type": 1, "target.id": 1, createdAt: -1 }, { name: "by_target" });
  await db
    .collection("user_action_history")
    .createIndex({ action: 1, createdAt: -1 }, { name: "by_action" });

  // workout_templates — sempre lidos por profissional, em ordem alfabética.
  await db
    .collection("workout_templates")
    .createIndex({ professional: 1, name: 1 }, { name: "by_professional_name" });

  // auto_fill_values — sempre lidos por (profissional, campo). O trio único
  // impede a mesma frase virar duas opções iguais na lista.
  await db
    .collection("auto_fill_values")
    .createIndex({ professional: 1, field: 1, value: 1 }, { unique: true, name: "value_unique" });

  // avatars — uma por usuário, sempre lida por dono.
  await db.collection("avatars").createIndex({ user: 1 }, { unique: true, name: "avatar_user_unique" });

  // brand_images — a logo e as fotos da tela de entrada. O índice é por dono
  // porque as duas operações que existem são "quantas esta conta tem" e "apaga
  // as desta conta que o tema não usa mais".
  await db.collection("brand_images").createIndex({ user: 1 }, { name: "user" });

  // api_keys — a busca de cada requisição é POR HASH, então o índice é nele.
  // Único: dois documentos com o mesmo hash significariam a mesma chave valendo
  // duas vezes, e revogar uma deixaria a outra viva.
  await db.collection("api_keys").createIndex({ hash: 1 }, { unique: true, name: "hash_unique" });
  await db
    .collection("api_keys")
    .createIndex({ user: 1, revokedAt: 1, createdAt: -1 }, { name: "by_user_state" });

  // ai_sessions — a lista do histórico é sempre "as minhas, a mais recente
  // primeiro". `updatedAt` e não `createdAt`: uma conversa retomada volta ao
  // topo, que é onde quem a retomou espera achá-la.
  await db
    .collection("ai_sessions")
    .createIndex({ user: 1, updatedAt: -1 }, { name: "by_user_date" });
  // O resumo de gasto varre por período, sem filtrar por conta: é a conta do
  // cliente inteiro.
  await db.collection("ai_sessions").createIndex({ createdAt: -1 }, { name: "by_date" });

  // api_calls — a tela lê sempre por conta e por data decrescente.
  await db.collection("api_calls").createIndex({ user: 1, createdAt: -1 }, { name: "by_user_date" });
  await db
    .collection("api_calls")
    .createIndex({ user: 1, prefix: 1, createdAt: -1 }, { name: "by_user_key_date" });
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

  // tenants — um profissional, um domínio. Os índices são ÚNICOS e os dois
  // importam: o de `user` impede dois documentos para a mesma conta, e o de
  // `subdomain` decide quem levou o nome quando duas contas pedem o mesmo ao
  // mesmo tempo.
  await db.collection("tenants").createIndex({ user: 1 }, { unique: true, name: "user_unique" });
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

  // Os tipos de usuário padrão. Rodam DENTRO do contexto da instância porque
  // `roles` é dela — fora do contexto, o modelo estouraria de propósito.
  await instanceContext.run(nome, () => app.api.role.ensureSystemRoles());

  console.log(`[schema] instância pronta — ${nome}`);
  return db;
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

  // Toda instância registrada ganha as collections e os índices. É o que faz um
  // deploy alcançar clientes criados depois da última versão.
  for (const doc of await app.api.center.list()) {
    await ensureInstance(app, doc.instance);
  }

  console.log("[schema] central e instâncias prontas");
};

module.exports.ensureCentral = ensureCentral;
module.exports.ensureInstance = ensureInstance;
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
