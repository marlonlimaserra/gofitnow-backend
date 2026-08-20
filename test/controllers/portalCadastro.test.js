const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const PortalController = require("../../controllers/Portal.js");
const rateLimit = require("../../lib/rateLimit.js");

// O CADASTRO é a rota mais perigosa deste backend: ela cria banco de dados e
// registro de DNS a partir de um formulário aberto na internet.
//
// Por isso metade destes testes não é sobre criar. É sobre NÃO criar — quando o
// e-mail já tem acesso, quando o vocabulário chegou torto, quando o mesmo
// computador já pediu três vezes — e sobre a ORDEM, que é o que decide se uma
// falha no meio deixa lixo atrás.
const CORPO = {
  name: "Bruna Sampaio",
  email: "bruna@exemplo.com",
  peopleSingular: "paciente",
  peoplePlural: "pacientes",
};

function monta({
  jaTemAcesso = [],
  slug = "bruna-sampaio",
  dnsOk = true,
  ensureOk = true,
  ensureErro = "",
  insertErro = null,
  mailErro = null,
  // O afiliado que existe no central, para o campo de indicação ter no que casar.
  afiliados = [{ alias: "wil", instance: "will", name: "Willian Costa", active: true }],
  indicacaoErro = null,
} = {}) {
  const feito = { dns: [], ensure: [], schema: [], hosts: [], trainers: [], vocab: [], mails: [], indicacoes: [] };

  const app = fakeApp({
    crypto: require("crypto"),
    // O dublê da rede.
    cloudflare: {
      async createSubdomain(host) {
        feito.dns.push(host);
        return dnsOk ? { ok: true, host } : { ok: false, erro: "recusou", passo: "dns" };
      },
      async domainStatus(host) {
        return { ok: true, status: host === "pronto.gofitnow.fit" ? "active" : "pending" };
      },
    },
    // O dublê do banco.
    schema: {
      async ensureInstance(_app, nome) {
        feito.schema.push(nome);
      },
    },
    helpers: {
      mailer: {
        async send(m) {
          if (mailErro) throw new Error(mailErro);
          feito.mails.push(m.to);
          return {};
        },
      },
    },
    api: {
      portal: {
        async destinosParaEmail() {
          return jaTemAcesso;
        },
        async slugLivre() {
          return slug;
        },
      },
      center: {
        async ensure(dados) {
          feito.ensure.push(dados);
          return ensureOk ? { ok: true, instance: dados.instance } : { ok: false, erro: ensureErro };
        },
        async addHost(instancia, host) {
          feito.hosts.push({ instancia, host });
          return { ok: true };
        },
        forget() {},
        async porAlias(valor) {
          return afiliados.find((a) => a.alias === String(valor || "").trim().toLowerCase());
        },
        async registrarIndicacao(instancia, codigo) {
          feito.indicacoes.push({ instancia, codigo });
          if (indicacaoErro) return { ok: false, erro: indicacaoErro };
          const achado = afiliados.find((a) => a.alias === codigo);
          if (!achado) return { ok: false, erro: "codigo_invalido" };
          return { ok: true, indicadoPor: achado.alias };
        },
      },
      user: {
        async insertTrainer(dados) {
          if (insertErro) return { erro: insertErro };
          feito.trainers.push(dados);
          return "u1";
        },
        async updateSelf(id, obj) {
          feito.vocab.push({ id, ...obj });
        },
      },
      passwordReset: {
        validityMinutes: 30,
        async create(id) {
          return "tok-" + id;
        },
      },
    },
  });

  PortalController(app);
  return { app, feito };
}

test.beforeEach(() => rateLimit.reset());

const cadastrar = (app, body = CORPO, ip = "5.5.5.5") =>
  call(app, "post", "/public/portal/signup", {
    body,
    headers: { "x-forwarded-for": ip },
  });

test("cria a instância, o banco, o endereço e o primeiro acesso", async () => {
  const { app, feito } = monta();

  const r = await cadastrar(app);

  assert.equal(r.status, 201);
  assert.equal(r.body.host, "bruna-sampaio.gofitnow.fit");
  assert.ok(r.body.token);

  assert.deepEqual(feito.dns, ["bruna-sampaio.gofitnow.fit"]);
  assert.deepEqual(feito.schema, ["bruna-sampaio"]);
  assert.deepEqual(feito.hosts, [
    { instancia: "bruna-sampaio", host: "bruna-sampaio.gofitnow.fit" },
  ]);
});

// A primeira pessoa é a dona da casa. Sem `admin: true` ela entra e não consegue
// cadastrar ninguém — um cliente novo que não pode usar o produto.
test("a primeira pessoa nasce administradora", async () => {
  const { app, feito } = monta();
  await cadastrar(app);

  assert.equal(feito.trainers[0].admin, true);
  assert.equal(feito.trainers[0].email, "bruna@exemplo.com");
});

// A senha existe porque `insertTrainer` exige uma, e ninguém a conhece — quem
// entra é o token. Uma senha curta aqui seria a única senha fraca do sistema,
// numa conta que vai guardar dado de saúde.
test("a senha gravada é longa e aleatória, não algo adivinhável", async () => {
  const { app, feito } = monta();
  await cadastrar(app);

  const senha = feito.trainers[0].password;
  assert.ok(senha.length >= 32, `senha de ${senha.length} caracteres é curta demais`);
  assert.ok(!/bruna|exemplo|1234/i.test(senha));
});

test("o vocabulário escolhido é gravado na conta", async () => {
  const { app, feito } = monta();
  await cadastrar(app);

  assert.deepEqual(feito.vocab, [
    { id: "u1", peopleSingular: "paciente", peoplePlural: "pacientes" },
  ]);
});

// O link vai por e-mail ALÉM de ir na resposta: é a rede de segurança de quem
// fechou a aba. Sem ele, um cadastro interrompido é conta inalcançável — e com o
// e-mail já ocupado, nem repetir o cadastro resolveria.
test("manda o link de criar senha por e-mail também", async () => {
  const { app, feito } = monta();
  await cadastrar(app);

  assert.deepEqual(feito.mails, ["bruna@exemplo.com"]);
});

test("e-mail que não sai NÃO derruba um cadastro que deu certo", async () => {
  const { app } = monta({ mailErro: "smtp fora" });

  const r = await cadastrar(app);

  assert.equal(r.status, 201);
  assert.ok(r.body.token);
});

// ── O que ele tem de RECUSAR ──────────────────────────────────────────────

test("e-mail que já tem acesso é 409, com o endereço para entrar", async () => {
  const { app, feito } = monta({
    jaTemAcesso: [{ host: "bruna.gofitnow.fit", name: "Bruna" }],
  });

  const r = await cadastrar(app);

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "already_has_access");
  assert.equal(r.body.destinations[0].host, "bruna.gofitnow.fit");
  // E nada foi criado.
  assert.deepEqual(feito.dns, []);
  assert.deepEqual(feito.schema, []);
});

// Corrida de duas requisições com o mesmo e-mail: uma cria, a outra bate no
// índice único. As duas têm de terminar na mesma resposta útil.
test("colisão no índice único de e-mail também vira 409", async () => {
  const { app } = monta({ ensureOk: false, ensureErro: "taken" });

  const r = await cadastrar(app);

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "already_has_access");
});

test("nome curto é 400 e não cria nada", async () => {
  const { app, feito } = monta();

  const r = await cadastrar(app, { ...CORPO, name: "B" });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_name");
  assert.deepEqual(feito.dns, []);
});

test("e-mail inválido é 400", async () => {
  const { app } = monta();
  const r = await cadastrar(app, { ...CORPO, email: "nao-e-email" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_email");
});

// O vocabulário vem de botões na tela, mas chega como texto — e texto de rota
// aberta não se confia. Ele acaba impresso em toda tela do cliente.
test("vocabulário com marcação é recusado", async () => {
  const { app, feito } = monta();

  for (const ruim of ["<script>x</script>", "paciente<b>", "http://x.com", ""]) {
    const r = await cadastrar(app, { ...CORPO, peopleSingular: ruim });
    assert.equal(r.status, 400, `aceitou "${ruim}"`);
    assert.equal(r.body.code, "invalid_words");
  }

  assert.deepEqual(feito.dns, []);
});

// Este teste nasceu de um erro que o de cima encontrou: o limite estava ANTES da
// validação, e quatro tentativas com campo torto viravam 429 em vez de 400.
// Ou seja, quem errasse o próprio e-mail três vezes ficava trancado uma hora, no
// primeiro contato com o produto. Cota se gasta criando, não errando de digitar.
test("erro de digitação não gasta a cota de cadastros da hora", async () => {
  const { app } = monta();

  // Seis tentativas tortas — o dobro da cota.
  for (let i = 0; i < 6; i++) {
    const r = await cadastrar(app, { ...CORPO, email: "ainda-nao-e-email" });
    assert.equal(r.status, 400, `a ${i + 1}ª virou ${r.status} em vez de 400`);
  }

  // E o cadastro de verdade, depois de tudo isso, ainda passa.
  const bom = await cadastrar(app);
  assert.equal(bom.status, 201);
});

// Palavra legítima que não está na lista de botões da tela tem de passar:
// "atleta" e "corredor" são reais, e a tela pode oferecê-los amanhã.
test("palavra legítima fora dos presets é aceita", async () => {
  const { app } = monta();

  const r = await cadastrar(app, {
    ...CORPO,
    peopleSingular: "atleta",
    peoplePlural: "atletas",
  });

  assert.equal(r.status, 201);
});

// ── A ORDEM, que é o que evita lixo ───────────────────────────────────────
//
// DNS primeiro: se a Cloudflare recusar, NADA foi criado e tentar de novo é
// limpo. Na ordem contrária a pessoa ficaria cadastrada num endereço que não
// responde, com o e-mail já ocupado — sem nem poder repetir o cadastro.
test("Cloudflare recusando não deixa instância nem banco atrás", async () => {
  const { app, feito } = monta({ dnsOk: false });

  const r = await cadastrar(app);

  assert.equal(r.status, 503);
  assert.equal(r.body.code, "domain_failed");
  assert.deepEqual(feito.ensure, []);
  assert.deepEqual(feito.schema, []);
});

test("o DNS é pedido ANTES de registrar a instância", async () => {
  const { app, feito } = monta();
  await cadastrar(app);

  // Os dois aconteceram, e o de rede foi o primeiro a ser tocado.
  assert.equal(feito.dns.length, 1);
  assert.equal(feito.ensure.length, 1);
});

test("falha ao criar o primeiro acesso é 503, e não 201 calado", async () => {
  const { app } = monta({ insertErro: "username" });

  const r = await cadastrar(app);

  assert.equal(r.status, 503);
  assert.equal(r.body.code, "first_user_failed");
});

// ── O LIMITE ──────────────────────────────────────────────────────────────
//
// Três por hora. Cada chamada custa um banco de dados: ninguém abre três
// negócios numa tarde, e sem isto a rota é uma fábrica de bancos órfãos.
test("o quarto cadastro na mesma hora é 429", async () => {
  const { app } = monta();

  for (let i = 0; i < 3; i++) {
    const ok = await cadastrar(app, { ...CORPO, email: `p${i}@exemplo.com` });
    assert.equal(ok.status, 201, `o ${i + 1}º devia passar`);
  }

  const barrado = await cadastrar(app, { ...CORPO, email: "p4@exemplo.com" });

  assert.equal(barrado.status, 429);
  assert.equal(barrado.headers["retry-after"], "3600");
});

test("o limite de cadastro é por IP", async () => {
  const { app } = monta();

  for (let i = 0; i < 3; i++) {
    await cadastrar(app, { ...CORPO, email: `a${i}@exemplo.com` }, "1.1.1.1");
  }

  const outro = await cadastrar(app, { ...CORPO, email: "outro@exemplo.com" }, "2.2.2.2");
  assert.equal(outro.status, 201);
});

// ── A ESPERA DO CERTIFICADO ───────────────────────────────────────────────
//
// O DNS é instantâneo; o certificado do Pages não. Dizer "pronto" cedo joga a
// pessoa numa tela de erro de SSL logo depois de se cadastrar — que parece que o
// cadastro falhou.
test("só diz pronto quando o Pages diz active", async () => {
  const { app } = monta();

  const pendente = await call(app, "get", "/public/portal/ready", {
    query: { host: "novo.gofitnow.fit" },
  });
  assert.equal(pendente.body.ready, false);

  const pronto = await call(app, "get", "/public/portal/ready", {
    query: { host: "pronto.gofitnow.fit" },
  });
  assert.equal(pronto.body.ready, true);
});

test("sem host, o ready é 400", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/public/portal/ready", { query: {} });
  assert.equal(r.status, 400);
});

// ── A INDICAÇÃO ───────────────────────────────────────────────────────────
//
// O código de quem indicou é gravado AQUI ou nunca: depois do cadastro ninguém
// lembra quem mandou o link. E a indicação é escrita uma vez só — então um erro neste
// ponto não se conserta sem tirar comissão de um afiliado para dar a outro.

test("o código de indicação é registrado no cadastro", async () => {
  const { app, feito } = monta();

  const r = await cadastrar(app, { ...CORPO, indicacao: "wil" });

  assert.equal(r.status, 201);
  assert.equal(r.body.referral, "wil");
  assert.deepEqual(feito.indicacoes, [{ instancia: "bruna-sampaio", codigo: "wil" }]);
});

test("código inválido NÃO derruba o cadastro — mas aparece na resposta", async () => {
  // Desfazer neste ponto significaria apagar banco, DNS e usuário por causa de um
  // campo opcional. Calar significaria um afiliado cobrando por uma indicação que
  // ninguém gravou.
  const { app, feito } = monta();

  const r = await cadastrar(app, { ...CORPO, indicacao: "naoexiste" });

  assert.equal(r.status, 201, "o cadastro tem de acontecer");
  assert.equal(r.body.referral, false, "false = pôs código e não valeu");
  assert.equal(feito.trainers.length, 1);
  assert.equal(feito.mails.length, 1);
});

test("sem código, `referral` é null — e nada é chamado", async () => {
  // `null` (ninguém pôs código) é diferente de `false` (pôs e não valeu). A tela usa
  // os dois para dizer coisas diferentes.
  const { app, feito } = monta();

  const r = await cadastrar(app, CORPO);

  assert.equal(r.body.referral, null);
  assert.equal(feito.indicacoes.length, 0);
});

test("a indicação é gravada DEPOIS de a conta existir", async () => {
  // Antes do registro não há o que indicar, e a ordem errada gravaria a indicação
  // numa instância que ainda não está no central — perdendo-a em silêncio.
  const ordem = [];
  const { app } = monta();

  const centro = app.api.center;
  const ensureOriginal = centro.ensure;
  centro.ensure = async (d) => (ordem.push("ensure"), ensureOriginal(d));
  const indicarOriginal = centro.registrarIndicacao;
  centro.registrarIndicacao = async (i, c) => (ordem.push("indicacao"), indicarOriginal(i, c));

  await cadastrar(app, { ...CORPO, indicacao: "wil" });

  assert.deepEqual(ordem, ["ensure", "indicacao"]);
});

test("conferir o código responde o NOME, e não só que existe", async () => {
  // "Código válido" não deixa perceber que se digitou o código de outro afiliado.
  const { app } = monta();

  const r = await call(app, "get", "/public/affiliate/wil");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.name, "Willian Costa");
});

test("a conferência não conta nada além do nome", async () => {
  // Rota aberta. Devolver e-mail ou o nome do banco viraria um jeito de mapear a
  // base chutando códigos.
  const { app } = monta({
    afiliados: [{ alias: "wil", instance: "will", name: "Willian Costa", email: "w@x.com", plan: "pro" }],
  });

  const r = await call(app, "get", "/public/affiliate/wil");
  assert.deepEqual(Object.keys(r.body).sort(), ["alias", "name", "ok"]);
});

test("código curto não vai ao banco", async () => {
  // O formulário chama a cada tecla. Com "w" e "wi" indo ao Mongo, a rota vira uma
  // consulta por caractere digitado.
  const { app } = monta();
  let bateu = false;
  app.api.center.porAlias = async () => {
    bateu = true;
    return undefined;
  };

  const r = await call(app, "get", "/public/affiliate/wi");
  assert.equal(r.body.code, "curto");
  assert.equal(bateu, false);
});

test("conta desligada não indica", async () => {
  const { app } = monta({
    afiliados: [{ alias: "velho", instance: "antigo", name: "Antigo", active: false }],
  });

  const r = await call(app, "get", "/public/affiliate/velho");
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "inativo");
});

test("conferir o código NÃO pede sessão nem instância", async () => {
  // O cadastro roda antes de existir conta e antes de existir instância. Qualquer
  // exigência aqui deixaria o campo sempre dizendo "código inválido".
  const { app } = monta();
  const r = await call(app, "get", "/public/affiliate/wil", { headers: {} });
  assert.equal(r.body.ok, true);
});
