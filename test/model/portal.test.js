const test = require("node:test");
const assert = require("node:assert/strict");

const Portal_model = require("../../model/Portal_model.js");
const instanceContext = require("../../lib/instance.js");

// O modelo é onde mora a decisão que custa: procurar o e-mail em TODOS os
// bancos de cliente em vez de manter um índice central.
//
// Os testes abaixo defendem três coisas nessa escolha — que o dono é resolvido
// sem abrir banco, que cada busca roda no contexto da instância certa (senão os
// modelos leriam o banco errado), e que um cliente com banco fora do ar não
// derruba a busca dos outros.
const MARLON = {
  instance: "marlon",
  email: "marlon@gofitnow.fit",
  name: "Marlon",
  hosts: ["marlon.gofitnow.fit"],
  active: true,
};
const BRUNA = {
  instance: "bruna",
  email: "brunasampaio1611@gmail.com",
  name: "Bruna",
  hosts: ["bruna.gofitnow.fit"],
  active: true,
};

// `usuarios` é um mapa instância → lista de e-mails que existem lá dentro.
function monta({ registros = [MARLON, BRUNA], usuarios = {}, quebra = [] } = {}) {
  const visitadas = [];

  const app = {
    api: {
      center: {
        async list() {
          return registros;
        },
      },
      user: {
        async dataByEmail(email) {
          // A instância NÃO vem por parâmetro: o modelo de verdade a lê do
          // contexto assíncrono. Ler daqui é o que prova que o contexto foi
          // estabelecido — sem `instanceContext.run`, isto seria undefined e a
          // busca abriria o banco errado.
          const atual = instanceContext.current();
          visitadas.push(atual);

          if (quebra.includes(atual)) throw new Error("banco fora do ar");
          return (usuarios[atual] || []).includes(email) ? { _id: "u1", email } : undefined;
        },
      },
    },
  };

  const portal = new Portal_model(app);
  portal.forget();
  return { portal, visitadas };
}

test("acha o DONO da instância sem abrir banco de cliente", async () => {
  const { portal, visitadas } = monta();

  const achadas = await portal.instancesForEmail("marlon@gofitnow.fit");

  assert.deepEqual(
    achadas.map((r) => r.instance),
    ["marlon"]
  );
  // A instância do dono não é visitada: o e-mail dele está no registro central,
  // que já veio em memória.
  assert.ok(!visitadas.includes("marlon"));
});

test("acha quem só existe dentro do banco do cliente", async () => {
  const { portal, visitadas } = monta({ usuarios: { marlon: ["aluno@exemplo.com"] } });

  const achadas = await portal.instancesForEmail("aluno@exemplo.com");

  assert.deepEqual(
    achadas.map((r) => r.instance),
    ["marlon"]
  );
  // As duas foram varridas: não havia como saber onde estava sem procurar.
  assert.deepEqual(visitadas.sort(), ["bruna", "marlon"]);
});

test("cada busca roda no contexto da instância que está sendo procurada", async () => {
  const { portal, visitadas } = monta();

  await portal.instancesForEmail("ninguem@exemplo.com");

  assert.deepEqual(visitadas.sort(), ["bruna", "marlon"]);
  assert.ok(!visitadas.includes(undefined), "alguma busca rodou sem contexto de instância");
});

test("o mesmo e-mail em dois clientes devolve os dois", async () => {
  const { portal } = monta({
    usuarios: { marlon: ["pessoa@exemplo.com"], bruna: ["pessoa@exemplo.com"] },
  });

  const achadas = await portal.instancesForEmail("pessoa@exemplo.com");

  assert.deepEqual(
    achadas.map((r) => r.instance).sort(),
    ["bruna", "marlon"]
  );
});

test("instância desativada fica de fora da busca", async () => {
  const { portal, visitadas } = monta({
    registros: [MARLON, { ...BRUNA, active: false }],
    usuarios: { bruna: ["pessoa@exemplo.com"] },
  });

  const achadas = await portal.instancesForEmail("pessoa@exemplo.com");

  assert.deepEqual(achadas, []);
  assert.ok(!visitadas.includes("bruna"));
});

// Um cliente com banco fora do ar tem de sair da resposta, não levar os outros
// com ele. Melhor um resultado incompleto que uma tela de erro para todo mundo.
test("cliente com banco fora do ar não derruba a busca dos outros", async () => {
  const { portal } = monta({
    quebra: ["bruna"],
    usuarios: { marlon: ["pessoa@exemplo.com"] },
  });

  const achadas = await portal.instancesForEmail("pessoa@exemplo.com");

  assert.deepEqual(
    achadas.map((r) => r.instance),
    ["marlon"]
  );
});

test("e-mail sem arroba nem chega a varrer", async () => {
  const { portal, visitadas } = monta();

  assert.deepEqual(await portal.instancesForEmail("abc"), []);
  assert.deepEqual(await portal.instancesForEmail(""), []);
  assert.deepEqual(visitadas, []);
});

test("o e-mail é comparado sem espaço e sem caixa", async () => {
  const { portal } = monta({ usuarios: { marlon: ["aluno@exemplo.com"] } });

  const achadas = await portal.instancesForEmail("  ALUNO@Exemplo.COM  ");

  assert.deepEqual(
    achadas.map((r) => r.instance),
    ["marlon"]
  );
});

test("a segunda pergunta igual não varre de novo", async () => {
  const { portal, visitadas } = monta({ usuarios: { marlon: ["aluno@exemplo.com"] } });

  await portal.instancesForEmail("aluno@exemplo.com");
  const quantas = visitadas.length;
  await portal.instancesForEmail("aluno@exemplo.com");

  assert.equal(visitadas.length, quantas, "varreu de novo em vez de usar o cache");
});

// `destinosParaEmail` é o que a TELA recebe, e é o filtro final: instância sem
// endereço não pode ser um destino, senão a pessoa é mandada para uma página que
// não responde — pior que ouvir "não achei".
test("instância sem endereço não vira destino", async () => {
  const { portal } = monta({
    registros: [{ ...MARLON, hosts: [] }],
    usuarios: { marlon: ["aluno@exemplo.com"] },
  });

  assert.deepEqual(await portal.destinosParaEmail("aluno@exemplo.com"), []);
});

// ── QUANTO TEMPO a resposta fica guardada ─────────────────────────────────
//
// Este caso nasceu de um defeito real. Ao criar o cliente `will`, a sequência foi:
// registro criado → e-mail casou → host ligado trinta segundos depois. No meio
// dela alguém pediu o lookup, e o portal guardou por DEZ MINUTOS um registro sem
// endereço — que `destinosParaEmail` filtra fora. Resultado: "não existe conta com
// esse e-mail" por dez minutos, com a conta pronta e funcionando.
//
// O prazo curto do "não achei" existia justamente para o recém-cadastrado, e não
// cobria este caso porque aqui a busca ACHOU. A regra passou a ser sobre a
// resposta ser USÁVEL.
test("registro achado mas SEM endereço é guardado por pouco tempo", async () => {
  const { portal, visitadas } = monta({
    registros: [{ ...MARLON, hosts: [] }],
    usuarios: { marlon: ["aluno@exemplo.com"] },
  });

  await portal.instancesForEmail("aluno@exemplo.com");
  const antes = visitadas.length;

  // Trinta segundos e um tico depois — o prazo do "não achei".
  const relogio = Date.now;
  Date.now = () => relogio() + 31_000;
  try {
    await portal.instancesForEmail("aluno@exemplo.com");
  } finally {
    Date.now = relogio;
  }

  assert.ok(
    visitadas.length > antes,
    "devia ter varrido de novo: a resposta guardada não levava a endereço nenhum"
  );
});

test("registro COM endereço é guardado pelos dez minutos", async () => {
  const { portal, visitadas } = monta({ usuarios: { marlon: ["aluno@exemplo.com"] } });

  await portal.instancesForEmail("aluno@exemplo.com");
  const antes = visitadas.length;

  const relogio = Date.now;
  Date.now = () => relogio() + 31_000;
  try {
    await portal.instancesForEmail("aluno@exemplo.com");
  } finally {
    Date.now = relogio;
  }

  // Passados os 30 s do prazo curto, esta resposta continua valendo: ela é usável,
  // e a pessoa não troca de clínica no meio da tarde.
  assert.equal(visitadas.length, antes, "varreu de novo uma resposta que servia");
});

test("o destino leva endereço e nome, e não a instância", async () => {
  const { portal } = monta({ usuarios: { bruna: ["paciente@exemplo.com"] } });

  const destinos = await portal.destinosParaEmail("paciente@exemplo.com");

  assert.deepEqual(destinos, [{ host: "bruna.gofitnow.fit", name: "Bruna" }]);
});

// ── O NOME DA INSTÂNCIA de quem se cadastra sozinho ───────────────────────
//
// No autoatendimento não há ninguém para escolher o endereço, então ele sai do
// nome digitado. É a única coisa que se sabe, e é o que a profissional
// reconhece depois no endereço dela.
function montaSlug(existentes = []) {
  const app = {
    api: {
      center: {
        async byInstance(nome) {
          return existentes.includes(nome) ? { instance: nome } : undefined;
        },
      },
    },
  };
  const portal = new Portal_model(app);
  portal.forget();
  return portal;
}

test("o endereço sai do nome completo, e não do primeiro nome", async () => {
  const portal = montaSlug();

  // "bruna" sozinho seria mais bonito e colidiria muito mais: já existe uma
  // Bruna, e a segunda viraria "bruna2" — pior de ler e sem dizer quem é.
  assert.equal(await portal.slugLivre("Bruna Sampaio"), "bruna-sampaio");
});

test("acento, maiúscula e pontuação saem do endereço", async () => {
  const portal = montaSlug();

  assert.equal(await portal.slugLivre("José da Conceição Jr."), "jose-da-conceicao-jr");
  assert.equal(await portal.slugLivre("Ana  Paula"), "ana-paula");
});

test("nome já usado ganha sufixo em vez de colidir", async () => {
  const portal = montaSlug(["bruna-sampaio", "bruna-sampaio2"]);

  assert.equal(await portal.slugLivre("Bruna Sampaio"), "bruna-sampaio3");
});

// Sem isto, alguém chamado "Admin" ganharia uma instância com um nome que o
// resto do sistema trata de outro jeito.
test("nome reservado não vira instância", async () => {
  const portal = montaSlug();

  const escolhido = await portal.slugLivre("Admin");
  assert.notEqual(escolhido, "admin");
  assert.equal(escolhido, "admin2");
});

test("nome sem nenhuma letra ou número não tem endereço possível", async () => {
  const portal = montaSlug();

  assert.equal(await portal.slugLivre("!!! ---"), "");
  assert.equal(await portal.slugLivre(""), "");
});

// O padrão de instância exige começar e terminar em letra ou número. Um nome
// longo cortado no meio pode deixar hífen na ponta.
test("nome comprido é cortado sem deixar hífen na ponta", async () => {
  const portal = montaSlug();

  const slug = await portal.slugLivre("Maria Aparecida dos Santos Oliveira Silva Costa");
  assert.ok(slug.length <= 30, `${slug.length} caracteres`);
  assert.ok(!slug.endsWith("-"), `terminou em hífen: ${slug}`);
  assert.ok(/^[a-z0-9]/.test(slug));
});
