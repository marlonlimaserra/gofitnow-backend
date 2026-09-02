const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const AnamnesisController = require("../../controllers/Anamnesis.js");
const Anamnesis_model = require("../../model/Anamnesis_model.js");

// A ANAMNESE de uma pessoa.
//
// Um documento por pessoa, não um histórico de versões — e é isso que estes casos
// guardam junto com o resto: a rota grava por `upsert` (a tela é a mesma para
// preencher e para alterar), e o log distingue as duas coisas, porque "preencheu
// a anamnese" é primeira consulta e "alterou" é acompanhamento.
const PESSOA = "64b2c0f7e1a2b3c4d5e6f701";
const PROF = "64b2c0f7e1a2b3c4d5e6f7a8";

function monta({ permissao = "anamnesis.manage", existente = null, link = null, email = "" } = {}) {
  const feito = { salvos: [], links: 0, mails: [] };
  let doc = existente;
  let oLink = link;
  const modelo = new Anamnesis_model({});

  const app = fakeApp({
    api: {
      user: {
        async dataStudent() {
          return { _id: PESSOA, name: "Marlon Lima", email };
        },
        async data() {
          return { _id: PESSOA, name: "Marlon Lima", email };
        },
      },
      anamnesis: {
        ENUMS: modelo.ENUMS,
        // A limpeza é do modelo DE VERDADE: é ela que decide o que conta como
        // campo preenchido, e a rota pública confia nisso para não apagar o que o
        // profissional escreveu. Um dublê aqui provaria o dublê.
        limpar: modelo.limpar,
        async data() {
          return doc;
        },
        async save(_t, _s, obj) {
          feito.salvos.push(obj);
          const criou = !doc;
          doc = { ...(doc || {}), ...modelo.limpar(obj) };
          return { criou };
        },
      },
      actionHistory: { diff: () => ({ mudou: true }) },
      // O LINK público. O dublê guarda um só, como o modelo de verdade: um por
      // pessoa, e gerar outro apaga o anterior.
      anamnesisLink: {
        diasDeValidade: 15,
        async create() {
          feito.links += 1;
          oLink = {
            _id: "l1",
            token: "t".repeat(64),
            trainer: PROF,
            student: PESSOA,
            expiresAt: new Date(Date.now() + 86400000),
            createdAt: new Date(),
            submittedAt: null,
          };
          return { token: oLink.token, expiresAt: oLink.expiresAt };
        },
        async doStudent() {
          return oLink;
        },
        async byToken(token) {
          return oLink && token === oLink.token ? oLink : null;
        },
        async markSubmitted() {
          if (oLink) oLink.submittedAt = new Date();
        },
      },
      center: {
        // Este teste traz o `center` dele (precisa de `byHost` para a tela
        // pública), e com isso o padrão do harness sai de baixo — inclusive o
        // `limitsFor`. Sem esta linha, preencher a primeira anamnese estourava
        // no teto do plano, que este arquivo não está exercitando.
        async limitsFor() {
          return {};
        },
        async byInstance() {
          return { instance: "marlon", hosts: ["marlon.gofitnow.fit"] };
        },
        async byHost(host) {
          return host === "marlon.gofitnow.fit" ? { instance: "marlon", active: true } : null;
        },
      },
      tenant: {
        async dataOfInstance() {
          return { theme: { tabName: "Estúdio Bruna" } };
        },
      },
    },
    helpers: {
      mailer: {
        async send(m) {
          feito.mails.push(m.to);
          return {};
        },
      },
      ReqProtected: {
        async can(req, res, pedida) {
          if (pedida !== permissao && permissao !== "todas") {
            res.status(403).send({ msg: "sem permissão" });
            return false;
          }
          return { _id: PROF, name: "Bruna" };
        },
      },
    },
  });

  AnamnesisController(app);
  return { app, feito };
}

test("nunca preenchida devolve null — e não um documento vazio", async () => {
  // A tela precisa da diferença: `null` é "convide a preencher"; um documento
  // com todos os campos vazios seria "já foi preenchida e está em branco", que
  // não acontece.
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", `/people/${PESSOA}/anamnesis`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.anamnesis, null);
  // As listas fechadas vêm do servidor.
  assert.deepEqual(r.body.options.smoking, ["never", "former", "current"]);
});

test("preencher exige `anamnesis.manage` — ver não basta", async () => {
  const { app, feito } = monta({ permissao: "anamnesis.view" });

  const r = await call(app, "put", `/people/${PESSOA}/anamnesis`, {
    params: { personId: PESSOA },
    body: { mainComplaint: "Quer emagrecer" },
  });

  assert.equal(r.status, 403);
  assert.deepEqual(feito.salvos, []);
});

test("a primeira gravação registra CRIOU, e sem diff", async () => {
  // Comparar contra nada devolveria o documento inteiro como "mudança", e o log
  // da primeira consulta viraria um muro de linhas.
  const { app } = monta();

  const r = await call(app, "put", `/people/${PESSOA}/anamnesis`, {
    params: { personId: PESSOA },
    body: { mainComplaint: "Quer emagrecer", water: 2 },
  });

  assert.equal(r.status, 200);
  const registro = app.registrados.find((x) => x.action === "create_anamnesis");
  assert.ok(registro, "não registrou a criação");
  assert.equal(registro.data.diff, undefined);
  assert.equal(registro.data.extra.person, "Marlon Lima");
});

test("a segunda gravação registra ALTEROU, com o diff", async () => {
  const { app } = monta({ existente: { mainComplaint: "Quer emagrecer" } });

  await call(app, "put", `/people/${PESSOA}/anamnesis`, {
    params: { personId: PESSOA },
    body: { mainComplaint: "Quer ganhar massa" },
  });

  assert.ok(app.registrados.find((x) => x.action === "update_anamnesis"));
  assert.equal(app.registrados.find((x) => x.action === "create_anamnesis"), undefined);
  assert.deepEqual(app.registrados[0].data.diff, { mudou: true });
});

// ── O MODELO ────────────────────────────────────────────────────────────────

test("campo que não veio NÃO é apagado", async () => {
  // A tela manda o formulário inteiro, mas uma integração pode mandar um campo
  // só. Sobrescrever o resto com vazio apagaria a anamnese de alguém.
  const m = new Anamnesis_model({});
  const set = m.limpar({ medications: "Losartana" });

  assert.deepEqual(Object.keys(set), ["medications"]);
});

test("número fora do razoável vira null, e não vai para o banco torto", () => {
  // "80" horas de sono é a mesma tecla apertada duas vezes — e um gráfico futuro
  // com 80 horas some com o resto da escala.
  const m = new Anamnesis_model({});

  assert.equal(m.limpar({ sleepHours: 8 }).sleepHours, 8);
  assert.equal(m.limpar({ sleepHours: 80 }).sleepHours, null);
  assert.equal(m.limpar({ sleepHours: -1 }).sleepHours, null);
  assert.equal(m.limpar({ water: "2,5" }).water, 2.5, "vírgula é como se digita aqui");
  assert.equal(m.limpar({ mealsPerDay: 5 }).mealsPerDay, 5);
});

test("a marca de 'quem respondeu' só entra como Date do servidor", () => {
  // Um cliente mandando a marca no formulário do profissional estaria mentindo
  // sobre a ORIGEM de um dado clínico — "isto veio da paciente" quando não veio.
  const m = new Anamnesis_model({});

  const agora = new Date();
  assert.equal(m.limpar({ answeredByPersonAt: agora }).answeredByPersonAt, agora);
  assert.equal("answeredByPersonAt" in m.limpar({ answeredByPersonAt: "2020-01-01" }), false);
  assert.equal("answeredByPersonAt" in m.limpar({ answeredByPersonAt: 123 }), false);
});

test("escolha fora da lista vira vazio", () => {
  const m = new Anamnesis_model({});
  assert.equal(m.limpar({ smoking: "current" }).smoking, "current");
  assert.equal(m.limpar({ smoking: "às vezes" }).smoking, "");
});

test("texto colado gigante é cortado, não recusado", () => {
  // Quem cola um PDF inteiro na observação não fez nada de errado — mas o
  // documento do Mongo tem um teto, e recusar o salvamento perderia a consulta
  // inteira que a pessoa acabou de digitar.
  const m = new Anamnesis_model({});
  const enorme = "a".repeat(9000);
  assert.equal(m.limpar({ notes: enorme }).notes.length, 4000);
});

// ── O LINK PARA A PESSOA RESPONDER ──────────────────────────────────────────
//
// O que estes casos guardam é o que faz o recurso ser seguro o suficiente para
// existir: o endereço é montado no SERVIDOR, a tela pública quase não lê, e a
// resposta da pessoa PREENCHE em vez de sobrescrever.

test("gerar o link exige `anamnesis.manage`", async () => {
  const { app, feito } = monta({ permissao: "anamnesis.view" });

  const r = await call(app, "post", `/people/${PESSOA}/anamnesis/link`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.status, 403);
  assert.equal(feito.links, 0);
});

test("o endereço é montado do HOST REGISTRADO, não do que a tela mandar", async () => {
  // Um link que sai por e-mail com um domínio que o cliente escolheu é uma
  // página de phishing assinada por nós.
  const { app } = monta();

  const r = await call(app, "post", `/people/${PESSOA}/anamnesis/link`, {
    params: { personId: PESSOA },
    body: { url: "https://golpe.example.com" },
  });

  assert.equal(r.status, 201);
  assert.match(r.body.link.url, /^https:\/\/marlon\.gofitnow\.fit\/anamnese\/t{64}$/);
});

test("sem link ativo, a tela recebe null — e não um link inventado", async () => {
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", `/people/${PESSOA}/anamnesis/link`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.body.link, null);
  assert.equal(r.body.days, 15);
});

test("a tela pública mostra só o primeiro nome e o espaço — nunca as respostas", async () => {
  // Se o link cair num grupo de WhatsApp, ninguém lê a anamnese de ninguém.
  const { app } = monta({
    permissao: "todas",
    link: {
      _id: "l1",
      token: "t".repeat(64),
      trainer: PROF,
      student: PESSOA,
      expiresAt: new Date(Date.now() + 86400000),
      submittedAt: null,
    },
    existente: { mainComplaint: "Quer emagrecer", medications: "Losartana" },
  });

  const r = await call(app, "get", `/public/anamnesis/${"t".repeat(64)}`, {
    params: { token: "t".repeat(64) },
    headers: { "x-instance-host": "marlon.gofitnow.fit" },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.firstName, "Marlon");
  assert.equal(r.body.space, "Estúdio Bruna");
  // Nada do conteúdo.
  assert.equal(r.body.mainComplaint, undefined);
  assert.equal(r.body.medications, undefined);
  assert.equal(JSON.stringify(r.body).includes("Losartana"), false);
});

test("token que não existe é 404, igual a token vencido", async () => {
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", "/public/anamnesis/" + "x".repeat(64), {
    params: { token: "x".repeat(64) },
    headers: { "x-instance-host": "marlon.gofitnow.fit" },
  });

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "invalid_link");
});

test("host que não é de ninguém não abre formulário nenhum", async () => {
  const { app } = monta({ permissao: "todas" });

  const r = await call(app, "get", "/public/anamnesis/" + "t".repeat(64), {
    params: { token: "t".repeat(64) },
    headers: { "x-instance-host": "qualquer.example.com" },
  });

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "unknown_domain");
});

test("a resposta da pessoa PREENCHE, e não apaga o que o profissional escreveu", async () => {
  // O caso real: ele escreveu "hipertensão controlada, ver exame de março" e ela
  // manda esse campo vazio porque não soube responder. Apagar seria perder
  // informação clínica por causa de um campo em branco.
  const { app, feito } = monta({
    permissao: "todas",
    link: {
      _id: "l1",
      token: "t".repeat(64),
      trainer: PROF,
      student: PESSOA,
      expiresAt: new Date(Date.now() + 86400000),
      submittedAt: null,
    },
  });

  const r = await call(app, "put", "/public/anamnesis/" + "t".repeat(64), {
    params: { token: "t".repeat(64) },
    headers: { "x-instance-host": "marlon.gofitnow.fit" },
    body: { conditions: "", medications: "Losartana 50 mg", water: 2.5 },
  });

  assert.equal(r.status, 200);
  const gravado = feito.salvos[0];
  assert.equal(gravado.medications, "Losartana 50 mg");
  assert.equal(gravado.water, 2.5);
  // O campo vazio NÃO entra no que vai ser gravado.
  assert.equal("conditions" in gravado, false);
  // E fica a marca de que foi a pessoa que respondeu.
  assert.ok(gravado.answeredByPersonAt instanceof Date);
});

test("enviar por e-mail sem e-mail cadastrado é 400 explicando", async () => {
  const { app, feito } = monta({ email: "" });

  const r = await call(app, "post", `/people/${PESSOA}/anamnesis/link/email`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "no_email");
  assert.deepEqual(feito.mails, []);
});

test("enviar por e-mail sem link ativo CRIA um — quem clicou quer que chegue", async () => {
  const { app, feito } = monta({ email: "marlon@exemplo.com" });

  const r = await call(app, "post", `/people/${PESSOA}/anamnesis/link/email`, {
    params: { personId: PESSOA },
  });

  assert.equal(r.status, 200);
  assert.equal(feito.links, 1, "não criou o link que faltava");
  assert.deepEqual(feito.mails, ["marlon@exemplo.com"]);
});
