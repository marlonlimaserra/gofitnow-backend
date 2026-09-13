const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const TenantController = require("../../controllers/Tenant.js");
const themeLib = require("../../lib/theme.js");
// O domínio canônico é lido daqui em vez de escrito à mão nas asserções: estes
// casos testam a REGRA ("o host que a gente mostra é o canônico"), e não qual é
// a marca do mês. Escrito à mão, cada troca de marca quebra quatro testes que
// não têm nada de errado.
const dominio = require("../../lib/domain.js");

const USER = { _id: "u1", name: "Marlon" };

function monta({
  // Os endereços que o CENTRAL conhece. Padrão: o subdomínio da instância, que é
  // o que o painel grava ao criar o cliente.
  hosts = ["marlon.gofitnow.fit"],
  tenant,
  livre = true,
  viaApiKey = false,
  pages = false,
  aponta = { ok: false, erro: "not_found" },
  certificado = { ok: true, status: "active" },
  // O plano deste cliente. Vazio é "sem plano", que não proíbe nada — é o
  // cenário de quase todo caso daqui. Os que exercitam a tranca passam
  // `{ appearance: false }` ou `{ whitelabel: false }`.
  limitesDoPlano = {},
  // O ambiente do endereço. `null` = instalação sem ambientes cadastrados, que é
  // como o sistema viveu até 13/09/2026 e continua vivendo enquanto ninguém
  // abrir aquela tela. Os casos que exercitam ambiente passam um objeto.
  ambienteDoHost = null,
} = {}) {
  const salvos = [];
  const reservas = [];
  const dominios = [];
  const estados = [];
  const naCloudflare = [];
  const faxina = [];
  const hostsAdicionados = [];
  const hostsRemovidos = [];
  const hostsDaInstancia = [...hosts];

  const app = fakeApp({
    // As integrações de rede entram como dublê: um teste que batesse na
    // Cloudflare ou no DNS de verdade seria um teste que falha no avião.
    cloudflare: {
      isConfigured: () => false,
      missingConfig: () => ["zoneId"],
      // O que a central pergunta antes de a pessoa escolher o nome. Neste dublê
      // é "não dá" de propósito: é o cenário que prova que o nome fica
      // reservado mesmo sem a integração ligada.
      subdomainReady: () => false,
      subdomainMissing: () => ["zoneId"],
      isPagesConfigured: () => pages,
      missingPagesConfig: () => ["token", "accountId"],
      async createSubdomain() {
        return { ok: true };
      },
      async addPagesDomain(host) {
        naCloudflare.push({ acao: "add", host });
        return { ok: true, host };
      },
      async removePagesDomain(host) {
        naCloudflare.push({ acao: "remove", host });
        return { ok: true };
      },
      async domainStatus() {
        return certificado;
      },
    },
    dnscheck: {
      async pointsTo() {
        return aponta;
      },
    },
    helpers: {
      ReqProtected: {
        async verify(req) {
          req._viaApiKey = viaApiKey;
          return USER;
        },
        // A aparência passou a exigir `users.manage` — a mesma do vocabulário,
        // porque ela muda a tela de todo mundo. O dublê libera: o que este
        // arquivo testa é a limpeza do tema, não o portão.
        async can(req) {
          req._viaApiKey = viaApiKey;
          return USER;
        },
      },
    },
    api: {
      // O registro central: é ele que diz de quem é um endereço antes de
      // existir sessão.
      // O registro central é INDEPENDENTE do tenant, e o dublê tem de refletir
      // isso — era justamente o acoplamento daqui que escondia o defeito de "salvo
      // e invisível". Na realidade quem escreve `instances.hosts` é o painel (na
      // criação do cliente) e as rotas de domínio deste controller; o documento do
      // profissional não tem voz nenhuma nessa tabela.
      center: {
        // Este arquivo traz o `center` dele, e com isso o padrão do harness sai
        // de baixo — inclusive o `limitsFor`. Salvar a aparência e cadastrar um
        // domínio próprio passaram a perguntar o plano (30/08/2026), e sem esta
        // linha 28 casos que não têm nada com plano estouravam.
        //
        // `{}` é a mesma resposta que a produção dá para cliente sem plano: o
        // que o plano não diz, ele não proíbe.
        async limitsFor() {
          return limitesDoPlano;
        },
        async byHost(host) {
          return hostsDaInstancia.includes(host) ? { instance: "marlon" } : undefined;
        },
        // O AMBIENTE do endereço (13/09/2026). `null` é o estado de uma
        // instalação que nunca abriu a tela de ambientes — e é o padrão aqui de
        // propósito: nenhum destes casos é sobre ambiente, e a resposta deles
        // não pode mudar de forma por causa de um campo que eles não pedem.
        // Os casos que SÃO sobre ambiente trocam este dublê.
        async environmentOf() {
          return ambienteDoHost;
        },
        async addHost(instance, host) {
          hostsAdicionados.push({ instance, host });
          hostsDaInstancia.push(host);
          return { ok: true, host };
        },
        async removeHost(instance, host) {
          hostsRemovidos.push({ instance, host });
          return true;
        },
      },
      brandImage: {
        async pruneUnused(userId, emUso) {
          faxina.push(emUso);
          return 0;
        },
      },
      tenant: {
        async dataByUser() {
          return tenant;
        },
        async dataBySubdomain(s) {
          return tenant && tenant.subdomain === s ? tenant : undefined;
        },
        async dataByHost(host) {
          if (!tenant) return undefined;
          const sub = tenant.subdomain ? `${tenant.subdomain}.gofitnow.fit` : null;
          return host === sub || host === tenant.customDomain ? tenant : undefined;
        },
        // A aparência da instância, quando ninguém reivindicou o endereço. O
        // dublê devolve o MESMO documento porque é o que o real faz numa
        // instância de um profissional: o mais antigo é ele.
        async dataOfInstance() {
          return tenant;
        },
        async isFree() {
          return livre;
        },
        async isDomainFree() {
          return livre;
        },
        async claim(userId, nome) {
          reservas.push(nome);
          return livre
            // O host sai do `hostOf`, como no modelo de verdade. Escrito à mão,
            // este dublê passaria a mentir no dia da troca de marca — e mentiria
            // de um jeito que o teste não pega: ele afirmaria que o sistema
            // responde um domínio que o sistema já não responde.
            ? { ok: true, subdomain: nome, host: dominio.hostOf(nome) }
            : { ok: false, erro: "taken" };
        },
        async claimCustomDomain(userId, host) {
          dominios.push(host);
          return livre ? { ok: true, customDomain: host } : { ok: false, erro: "taken" };
        },
        async setStatus() {},
        async setCustomStatus(userId, status, erro) {
          estados.push({ status, erro: erro || null });
        },
        async removeCustomDomain() {
          estados.push({ status: "removido", erro: null });
        },
        async saveTheme(userId, entrada) {
          const limpo = themeLib.sanitize(entrada);
          salvos.push(limpo);
          return limpo;
        },
        publicTheme(doc) {
          const t = themeLib.sanitize(doc?.theme);
          return { theme: t, scale: themeLib.scale(t.brand) };
        },
      },
    },
  });

  TenantController(app);
  return {
    app,
    salvos,
    reservas,
    dominios,
    estados,
    naCloudflare,
    faxina,
    hostsAdicionados,
    hostsRemovidos,
  };
}

test("o tema público sai sem sessão nenhuma", async () => {
  const { app } = monta({ tenant: { subdomain: "marlon", theme: { brand: "#2563eb" } } });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.theme.brand, "#2563eb");
  assert.equal(r.body.custom, true);
});

// ── O AMBIENTE NA RESPOSTA PÚBLICA (13/09/2026) ───────────────────────────
//
// É esta rota que diz à tela do cliente QUAL BACKEND chamar. Ela já era chamada
// em toda abertura de tela de login, antes de qualquer sessão — então o campo
// pega carona no que já existia, em vez de uma segunda ida à rede antes de a
// tela desenhar.
const PRODUCAO = {
  nome: "Produção",
  dominio: "producao.vafit.app",
  url: "https://producao.vafit.app",
};

test("o ambiente do cliente vai na resposta pública", async () => {
  const { app } = monta({
    tenant: { subdomain: "marlon", theme: { brand: "#2563eb" } },
    ambienteDoHost: PRODUCAO,
  });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.deepEqual(r.body.environment, PRODUCAO);
});

test("sem ambiente cadastrado, o campo NEM APARECE", async () => {
  // Ausente é diferente de vazio. Quem lê trata a ausência como "siga com o
  // backend de sempre" — e é isso que faz uma instalação que nunca abriu a tela
  // de ambientes continuar funcionando exatamente como antes.
  //
  // Um `environment: null` na resposta seria lido como "este cliente não tem
  // backend", que é outra coisa.
  const { app } = monta({ tenant: { subdomain: "marlon" } });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal("environment" in r.body, false);
});

test("endereço que não é de ninguém também recebe o ambiente", async () => {
  // Parece contraditório e não é: a tela de um host desconhecido PRECISA chamar
  // um backend para mostrar o que quer que seja. Sem ambiente aqui, um endereço
  // digitado errado ficaria falando com o backend de sempre enquanto o resto da
  // instalação já teria mudado.
  const { app } = monta({ ambienteDoHost: PRODUCAO, hosts: [] });
  const r = await call(app, "get", "/public/theme", { query: { host: "nao-existe.gofitnow.fit" } });

  assert.equal(r.body.known, false);
  assert.deepEqual(r.body.environment, PRODUCAO);
});

test("a PORTA DE ENTRADA também recebe o ambiente", async () => {
  const { app } = monta({ ambienteDoHost: PRODUCAO });
  const r = await call(app, "get", "/public/theme", { query: { host: "app.gofitnow.fit" } });

  assert.equal(r.body.portal, true);
  assert.deepEqual(r.body.environment, PRODUCAO);
});

test("tema salvo SEM endereço reivindicado ainda chega à tela de entrada", async () => {
  // O defeito mais confuso que este projeto teve: a pessoa salvava a tela de
  // entrada, o tema ia para o banco, e a tela continuava a original. Salvo e
  // invisível.
  //
  // A causa era o descompasso do banco-por-cliente: o endereço pertence à
  // INSTÂNCIA (quem registra é o painel, na coleção `instances`), mas a busca da
  // aparência exigia que o PROFISSIONAL tivesse reivindicado aquele subdomínio
  // por dentro, numa segunda tela. Sem isso, caía no tema padrão.
  const { app } = monta({
    // Nem `subdomain` nem `customDomain`: exatamente o estado em que o banco
    // estava quando o defeito apareceu.
    tenant: { user: "u1", status: "none", theme: { brand: "#7c3aed", layout: "side" } },
  });

  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.known, true);
  assert.equal(r.body.theme.brand, "#7c3aed", "o tema salvo tinha de chegar aqui");
  assert.equal(r.body.theme.layout, "side", "a composição escolhida também");
  assert.equal(r.body.custom, true, "é aparência de alguém, não o padrão");
});

test("o tema público NÃO entrega de quem é o domínio", async () => {
  // Um endereço aberto diz SE é de alguém, nunca DE QUEM.
  //
  // `known` é a diferença entre a tela desenhar o formulário e dizer "domínio não
  // identificado" — sem ele, um subdomínio qualquer apontado para nós ganha uma
  // porta de entrada com cara de oficial. Mas ele é um booleano: o nome da
  // instância não pode aparecer, senão esta rota sem autenticação viraria o mapa
  // de qual domínio próprio pertence a qual cliente nosso.
  const { app } = monta({
    tenant: { subdomain: "marlon", user: "u1", theme: { brand: "#2563eb" } },
  });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  const texto = JSON.stringify(r.body);
  assert.ok(!texto.includes("u1"), "vazou o id do dono");

  // A lista de chaves é FECHADA de propósito, e é o que faz este caso valer: campo
  // novo nesta rota quebra o teste e obriga a justificar. Aconteceu com `language`,
  // que entrou depois — e passou porque idioma padrão da conta é um de quatro
  // valores, não identifica ninguém, e a tela de entrar precisa dele para não abrir
  // em inglês para o cliente de um profissional brasileiro.
  //
  // O que NÃO pode entrar aqui: nome da instância, id de usuário, e-mail, endereços
  // cadastrados. Numa rota sem autenticação, qualquer um deles vira o mapa de qual
  // domínio pertence a qual cliente nosso.
  assert.deepEqual(Object.keys(r.body).sort(), ["custom", "known", "language", "scale", "theme"]);
  assert.equal(r.body.known, true);

  // `language` sem valor é `null`, e não o objeto do tenant inteiro por descuido.
  assert.ok(r.body.language === null || typeof r.body.language === "string");
});

// O idioma padrão da conta chega à tela de ENTRAR, que é o caso que importa.
//
// Ela acontece antes de qualquer sessão e por isso não sabe de padrão nenhum: cai
// no idioma do navegador de quem chegou. Um Playwright com navegador em inglês
// abriu a tela do primeiro cliente em inglês, com "pt-BR" gravado como padrão da
// conta — o campo existia e não chegava a quem precisava dele.
test("o idioma padrão da conta chega na tela de entrar", async () => {
  const { app } = monta({
    tenant: { subdomain: "marlon", user: "u1", language: "pt-BR", theme: { brand: "#2563eb" } },
  });

  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal(r.body.language, "pt-BR");
});

test("conta sem idioma padrão manda null, e a tela decide", async () => {
  const { app } = monta({
    tenant: { subdomain: "marlon", user: "u1", theme: { brand: "#2563eb" } },
  });

  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  // `null` e não ausente: a tela distingue "a conta não escolheu" de "servidor
  // antigo que não manda o campo", e no segundo caso não pode mexer no idioma.
  assert.equal(r.body.language, null);
});

test("host desconhecido responde 200 e diz que não conhece", async () => {
  // 200 e não 404 de propósito: a rota RESPONDEU, e a resposta é "este endereço
  // não é de ninguém". É a tela que decide o que fazer com isso — hoje, mostrar
  // "domínio não identificado" em vez do formulário.
  //
  // O tema padrão continua vindo para a tela ter com o que se pintar enquanto diz
  // que não conhece o endereço.
  const { app } = monta({ tenant: undefined });
  for (const host of ["ninguem.gofitnow.fit", "outro.com", "app.gofitnow.fit", ""]) {
    const r = await call(app, "get", "/public/theme", { query: { host } });
    assert.equal(r.status, 200, host);
    assert.equal(r.body.custom, false, host);
    assert.equal(r.body.known, false, host);
    assert.equal(r.body.theme.brand, themeLib.defaults().brand, host);
  }
});

test("app.gofitnow.fit não é de ninguém, e isso é de propósito", async () => {
  // A entrada genérica não pode existir num mundo de um banco por cliente: ela não
  // tem como dizer QUAL banco conferiria a senha. Quem entra, entra pelo endereço
  // do próprio cliente.
  const { app } = monta({ tenant: { subdomain: "marlon", theme: {} } });
  const r = await call(app, "get", "/public/theme", { query: { host: "app.gofitnow.fit" } });

  assert.equal(r.body.known, false, "app.gofitnow.fit não pode ser reconhecido como cliente");
  // ...mas é PORTAL, e é isso que faz a tela mostrar a porta de entrada em vez de
  // "domínio não identificado".
  assert.equal(r.body.portal, true);
});

test("a porta de entrada existe nos DOIS domínios nossos", async () => {
  // `shapeapp.fit` entrou em 25/08/2026 ao lado de `gofitnow.fit`. Sem
  // `app.shapeapp.fit` na lista de portais, quem digitasse a porta do domínio
  // novo via "domínio não identificado" — o mesmo defeito que já foi consertado
  // uma vez no domínio antigo.
  const { app } = monta({ tenant: { subdomain: "marlon", theme: {} } });

  for (const host of ["app.gofitnow.fit", "app.shapeapp.fit"]) {
    const r = await call(app, "get", "/public/theme", { query: { host } });
    assert.equal(r.body.portal, true, host);
    assert.equal(r.body.known, false, host);
  }

  // E um subdomínio qualquer do domínio novo continua sendo desconhecido: portal
  // é lista, não sufixo.
  const outro = await call(app, "get", "/public/theme", { query: { host: "qualquer.shapeapp.fit" } });
  assert.equal(outro.body.portal, undefined);
  assert.equal(outro.body.known, false);
});

test("o tema público vem com a escala pronta", async () => {
  const { app } = monta({ tenant: { subdomain: "marlon", theme: { brand: "#dc2626" } } });
  const r = await call(app, "get", "/public/theme", { query: { host: "marlon.gofitnow.fit" } });

  assert.equal(Object.keys(r.body.scale).length, 10);
  assert.match(r.body.scale["600"], /^#[0-9a-f]{6}$/);
});

test("escolher domínio reserva o nome", async () => {
  const { app, reservas } = monta();
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "Marlon" } });

  assert.equal(r.status, 200);
  assert.deepEqual(reservas, ["marlon"]);
  assert.equal(r.body.host, dominio.hostOf("marlon"));
});

test("nome inválido é recusado antes de reservar", async () => {
  const { app, reservas } = monta();
  for (const ruim of ["a", "com espaço", "com.ponto", "-x", ""]) {
    const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: ruim } });
    assert.equal(r.status, 400, JSON.stringify(ruim));
  }
  assert.deepEqual(reservas, []);
});

test("nome reservado do sistema é recusado", async () => {
  const { app } = monta();
  for (const r of ["api", "www", "admin"]) {
    const res = await call(app, "post", "/me/tenant/domain", { body: { subdomain: r } });
    assert.equal(res.status, 400, r);
  }
});

test("nome de outra conta responde 409", async () => {
  const { app } = monta({ livre: false });
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "taken");
});

test("sem credencial de DNS o nome fica reservado assim mesmo", async () => {
  // Quem escolheu não pode perder o nome porque a integração não está ligada.
  const { app, reservas } = monta();
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.status, "pending");
  assert.equal(r.body.dnsReady, false);
  assert.deepEqual(reservas, ["marlon"]);
});

test("uma chave de API não escolhe domínio", async () => {
  const { app, reservas } = monta({ viaApiKey: true });
  const r = await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.equal(r.status, 403);
  assert.deepEqual(reservas, []);
});

test("a checagem de disponibilidade explica o motivo", async () => {
  const { app } = monta({ livre: true });
  assert.equal((await call(app, "get", "/me/tenant/available", { query: { subdomain: "x" } })).body.reason, "invalid");
  assert.equal((await call(app, "get", "/me/tenant/available", { query: { subdomain: "api" } })).body.reason, "reserved");

  const ok = await call(app, "get", "/me/tenant/available", { query: { subdomain: "marlon" } });
  assert.equal(ok.body.free, true);
  assert.equal(ok.body.host, dominio.hostOf("marlon"));
});

// ── Domínio próprio ─────────────────────────────────────────────────────────

test("o tema público também sai pelo domínio próprio do profissional", async () => {
  // É o ponto do recurso: `treinos.marlon.com.br` tem de abrir com a marca dele.
  //
  // O host precisa estar no CENTRAL, e não só no documento do profissional: é o
  // central que diz de qual instância é um endereço, antes de existir sessão. Quem
  // o coloca lá é a rota de cadastro de domínio (ver os testes abaixo).
  const { app } = monta({
    hosts: ["marlon.gofitnow.fit", "treinos.marlon.com.br"],
    tenant: { customDomain: "treinos.marlon.com.br", theme: { brand: "#7c3aed" } },
  });
  const r = await call(app, "get", "/public/theme", { query: { host: "treinos.marlon.com.br" } });

  assert.equal(r.body.custom, true);
  assert.equal(r.body.theme.brand, "#7c3aed");
});

test("cadastrar domínio próprio guarda o host e diz para onde apontar", async () => {
  const { app, dominios } = monta({ pages: true });
  const r = await call(app, "post", "/me/tenant/custom-domain", {
    body: { domain: "https://Treinos.Marlon.com.br/" },
  });

  assert.equal(r.status, 200);
  assert.deepEqual(dominios, ["treinos.marlon.com.br"], "guardou o host limpo, não o que foi colado");
  assert.equal(r.body.cnameTarget, dominio.CNAME_TARGET);
});

test("cadastrar domínio próprio NÃO precisa da credencial de DNS", async () => {
  // O DNS é do profissional. Isto é o que destrava o recurso com o token de hoje.
  const { app, naCloudflare } = monta({ pages: true });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.status, 200);
  assert.deepEqual(naCloudflare, [{ acao: "add", host: "marlon.com.br" }], "só o Pages, nada de DNS");
});

test("enquanto o CNAME não aponta, o domínio fica pendente", async () => {
  const { app, estados } = monta({ pages: true, aponta: { ok: false, erro: "not_found" } });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.body.customStatus, "pending");
  assert.equal(r.body.customError, "not_found");
  assert.deepEqual(estados.at(-1), { status: "pending", erro: "not_found" });
});

test("CNAME apontado e certificado pronto põe o domínio no ar", async () => {
  const { app } = monta({
    pages: true,
    aponta: { ok: true, via: "cname", found: "app.gofitnow.fit" },
    certificado: { ok: true, status: "active" },
  });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.body.customStatus, "active");
  assert.equal(r.body.pointedAt, "app.gofitnow.fit");
});

test("CNAME certo mas certificado ainda saindo não é 'no ar'", async () => {
  // Dizer "no ar" aqui mandaria a pessoa abrir um endereço com erro de SSL.
  const { app } = monta({
    pages: true,
    aponta: { ok: true, found: "app.gofitnow.fit" },
    certificado: { ok: true, status: "pending" },
  });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.body.customStatus, "pending");
  assert.equal(r.body.customError, "certificate_pending");
});

test("domínio inválido é recusado antes de guardar", async () => {
  const { app, dominios } = monta({ pages: true });
  for (const ruim of ["", "marlon", "localhost", "com espaço.br", "192.168.0.1"]) {
    const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: ruim } });
    assert.equal(r.status, 400, JSON.stringify(ruim));
  }
  assert.deepEqual(dominios, []);
});

test("endereço nosso não entra como domínio próprio", async () => {
  // Senão o mesmo host teria dois donos possíveis.
  const { app, dominios } = monta({ pages: true });
  for (const nosso of ["marlon.gofitnow.fit", "gofitnow.fit"]) {
    const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: nosso } });
    assert.equal(r.status, 400, nosso);
    assert.equal(r.body.code, "ours", nosso);
  }
  assert.deepEqual(dominios, []);
});

test("domínio de outra conta responde 409", async () => {
  const { app } = monta({ pages: true, livre: false });
  const r = await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "marlon.com.br" } });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "taken");
});

test("uma chave de API não cadastra nem remove domínio próprio", async () => {
  const { app, dominios } = monta({ pages: true, viaApiKey: true, tenant: { customDomain: "m.com.br" } });

  assert.equal((await call(app, "post", "/me/tenant/custom-domain", { body: { domain: "m.com.br" } })).status, 403);
  assert.equal((await call(app, "delete", "/me/tenant/custom-domain")).status, 403);
  assert.deepEqual(dominios, []);
});

test("verificar de novo tenta religar ao Pages antes de conferir", async () => {
  // Quem ficou com o cadastro falhado tem de sair do buraco apertando o botão.
  const { app, naCloudflare } = monta({
    pages: true,
    tenant: { customDomain: "marlon.com.br", customStatus: "failed" },
    aponta: { ok: true, found: "app.gofitnow.fit" },
  });
  const r = await call(app, "post", "/me/tenant/custom-domain/verify");

  assert.equal(r.status, 200);
  assert.equal(r.body.customStatus, "active");
  assert.deepEqual(naCloudflare, [{ acao: "add", host: "marlon.com.br" }]);
});

test("verificar sem domínio cadastrado é 404", async () => {
  const { app } = monta({ pages: true, tenant: { subdomain: "marlon" } });
  const r = await call(app, "post", "/me/tenant/custom-domain/verify");

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "no_domain");
});

test("remover apaga do banco mesmo com a Cloudflare fora do ar", async () => {
  // Senão o endereço fica preso a alguém que já não o quer, e ninguém mais usa.
  const { app, estados, naCloudflare } = monta({
    pages: false,
    tenant: { customDomain: "marlon.com.br" },
  });
  const r = await call(app, "delete", "/me/tenant/custom-domain");

  assert.equal(r.status, 200);
  assert.equal(r.body.customDomain, "");
  assert.deepEqual(estados.at(-1), { status: "removido", erro: null });
  assert.deepEqual(naCloudflare, [], "sem credencial não tenta, e o banco já ficou limpo");
});

test("a checagem de disponibilidade responde para domínio inteiro também", async () => {
  const { app } = monta({ livre: true });

  const ok = await call(app, "get", "/me/tenant/available", { query: { domain: "marlon.com.br" } });
  assert.equal(ok.body.free, true);
  assert.equal(ok.body.host, "marlon.com.br");

  const nosso = await call(app, "get", "/me/tenant/available", { query: { domain: "x.gofitnow.fit" } });
  assert.equal(nosso.body.reason, "ours");

  const ruim = await call(app, "get", "/me/tenant/available", { query: { domain: "localhost" } });
  assert.equal(ruim.body.reason, "invalid");
});

test("a tela recebe o alvo do CNAME e o estado do domínio próprio", async () => {
  const { app } = monta({ tenant: { customDomain: "marlon.com.br", customStatus: "pending" } });
  const r = await call(app, "get", "/me/tenant");

  assert.equal(r.body.customDomain, "marlon.com.br");
  assert.equal(r.body.customStatus, "pending");
  assert.equal(r.body.cnameTarget, dominio.CNAME_TARGET);
  assert.equal(typeof r.body.pagesReady, "boolean");
});

test("salvar tema limpa o que veio de fora", async () => {
  const { app, salvos } = monta();
  const r = await call(app, "put", "/me/tenant/theme", {
    body: { brand: "red; background: url(x)", layout: "inventado", photos: ["javascript:alert(1)"] },
  });

  assert.equal(r.status, 200);
  assert.equal(salvos[0].brand, themeLib.defaults().brand);
  assert.equal(salvos[0].layout, themeLib.defaults().layout);
  assert.deepEqual(salvos[0].photos, []);
});

test("salvar tema recolhe as imagens que ele deixou de usar", async () => {
  // Trocar a logo não pode deixar a antiga pendurada no banco, e uma imagem
  // enviada e não usada também não fica.
  const { app, faxina } = monta();
  await call(app, "put", "/me/tenant/theme", {
    body: {
      logo: "https://backend.gofitnow.fit/public/brand/a",
      photo: "https://backend.gofitnow.fit/public/brand/b",
      photos: ["https://backend.gofitnow.fit/public/brand/c"],
    },
  });

  assert.equal(faxina.length, 1);
  assert.equal(faxina[0].length, 3, "a logo, a foto e as do carrossel, todas de uma vez");
});

test("a faxina falhando NÃO derruba o salvar", async () => {
  // O tema já está gravado; falhar aqui faria a tela dizer que não salvou o
  // que salvou.
  const { app } = monta();
  app.api.brandImage.pruneUnused = async () => {
    throw new Error("banco fora do ar");
  };

  const r = await call(app, "put", "/me/tenant/theme", { body: { brand: "#2563eb" } });
  assert.equal(r.status, 200);
});

test("salvar tema devolve a escala junto, para a tela aplicar de imediato", async () => {
  const { app } = monta();
  const r = await call(app, "put", "/me/tenant/theme", { body: { brand: "#2563eb" } });
  assert.equal(r.body.theme.brand, "#2563eb");
  assert.equal(Object.keys(r.body.scale).length, 10);
});

test("a tela do profissional recebe o que precisa para se montar", async () => {
  const { app } = monta({ tenant: { subdomain: "marlon", status: "pending", theme: {} } });
  const r = await call(app, "get", "/me/tenant");

  assert.equal(r.body.host, dominio.hostOf("marlon"));
  assert.equal(r.body.status, "pending");
  assert.ok(r.body.layouts.length >= 3, "as composições");
  assert.ok(r.body.backgrounds.length >= 4, "os fundos, que agora são escolha à parte");
  assert.ok(r.body.effects.length >= 3);
  assert.ok(r.body.motions.length >= 3);
  assert.ok(r.body.logoRange.min < r.body.logoRange.max);
  assert.ok(r.body.speedRange.min < r.body.speedRange.max);
  assert.ok(r.body.presets.length >= 4);
  assert.equal(typeof r.body.dnsReady, "boolean");
});

// ── O endereço no registro central ──────────────────────────────────────────
//
// Um endereço que existe só por dentro da instância é um endereço TRANCADO: o
// portão (lib/instanceGate.js) resolve host → instância consultando
// `instances.hosts`, e o que não está lá responde "domínio não identificado". Por
// meses o `addHost` do Center_model não tinha um único chamador — registrar o
// próprio endereço o deixaria inacessível.
test("escolher subdomínio registra o endereço no central", async () => {
  const { app, hostsAdicionados } = monta({ tenant: undefined });

  await call(app, "post", "/me/tenant/domain", { body: { subdomain: "marlon" } });

  assert.deepEqual(hostsAdicionados, [{ instance: "marlon", host: dominio.hostOf("marlon") }]);
});

test("cadastrar domínio próprio registra o endereço no central", async () => {
  const { app, hostsAdicionados } = monta({ tenant: { subdomain: "marlon" } });

  await call(app, "post", "/me/tenant/custom-domain", {
    body: { domain: "treinos.marlon.com.br" },
  });

  assert.deepEqual(hostsAdicionados, [{ instance: "marlon", host: "treinos.marlon.com.br" }]);
});

test("registra ANTES de a Cloudflare entrar na conversa", async () => {
  // Sem credencial de Pages a rota devolve "pending" e para. O endereço tem de
  // resolver mesmo assim, senão a tela abriria em "domínio não identificado"
  // durante toda a espera do DNS — que é justamente quando a pessoa fica
  // conferindo se funcionou.
  const { app, hostsAdicionados } = monta({
    tenant: { subdomain: "marlon" },
    pages: false,
  });

  const r = await call(app, "post", "/me/tenant/custom-domain", {
    body: { domain: "treinos.marlon.com.br" },
  });

  assert.equal(r.body.customStatus, "pending");
  assert.equal(hostsAdicionados.length, 1, "o host tinha de entrar no central mesmo assim");
});

test("remover o domínio próprio tira o endereço do central", async () => {
  // Deixá-lo lá manteria o endereço resolvendo para uma instância que já não o
  // quer — e impediria outro cliente de registrar o mesmo domínio, porque o
  // índice de host é único.
  const { app, hostsRemovidos } = monta({
    hosts: ["marlon.gofitnow.fit", "treinos.marlon.com.br"],
    tenant: { subdomain: "marlon", customDomain: "treinos.marlon.com.br" },
  });

  await call(app, "delete", "/me/tenant/custom-domain");

  assert.deepEqual(hostsRemovidos, [{ instance: "marlon", host: "treinos.marlon.com.br" }]);
});


// ── A APARÊNCIA É DA INSTÂNCIA, não de quem está logado ────────────────────
//
// O caso real: o Marlon entrou em will.gofitnow.fit com a conta dele (usuário da
// casa, não o dono). O `/me/tenant` procurava o tenant DELE, não achava, e o web
// aplicava esse vazio POR CIMA do tema que o host já tinha carregado — a logo e
// as cores do Willian sumiam no instante em que ele entrava.
//
// Uma instância é UM negócio com UMA marca. Quem não tem documento próprio lê o
// da casa; o ENDEREÇO continua sendo o de cada um.
test("qualquer um da equipe lê a MARCA e o ENDEREÇO da casa", async () => {
  // Depois da migração para `configurations` existe UM documento por instância,
  // e ele responde as duas coisas. O endereço chegou a ficar por usuário nesta
  // rota (foi a primeira tentativa de conserto, na mesma madrugada) e era a
  // herança do modelo antigo: `will.gofitnow.fit` é a INSTÂNCIA, não a conta de
  // quem registrou.
  const CASA = { theme: { brand: "#18181b" }, subdomain: "will" };
  const app = fakeApp({
    helpers: { ReqProtected: { async verify() { return { _id: "outro" }; } } },
    api: {
      tenant: {
        async dataOfInstance() {
          return CASA;
        },
      },
    },
  });

  TenantController(app);
  const r = await call(app, "get", "/me/tenant");

  assert.equal(r.status, 200);
  assert.equal(r.body.theme.brand, "#18181b", "a marca vem da casa");
  assert.equal(r.body.subdomain, "will", "o endereço também — é o da instância");
});

test("salvar a aparência exige users.manage — ela muda a tela de todo mundo", async () => {
  // Antes bastava estar logado: um CLIENTE podia trocar a logo e as cores da
  // conta inteira.
  const pedidas = [];
  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify() {
          return { _id: "u1" };
        },
        async can(req, res, permissao) {
          pedidas.push(permissao);
          res.status(403).send({ msg: "sem permissão" });
          return false;
        },
      },
    },
    api: { tenant: { async saveTheme() { throw new Error("não podia ter chegado aqui"); } } },
  });

  TenantController(app);
  const r = await call(app, "put", "/me/tenant/theme", { body: { brand: "#ff0000" } });

  assert.equal(r.status, 403);
  assert.deepEqual(pedidas, ["users.manage"]);
});

// ── OS ÂNGULOS DA FOTO DE EVOLUÇÃO ──────────────────────────────────────────
//
// Os quatro de fábrica viraram o PADRÃO da instância em vez do limite dela. O
// que estes testes seguram é a permissão de cada lado da porta: ler é para quem
// abre uma ficha, gravar é para quem avalia.
function montaAngulos({ guardados, permissoes = [] } = {}) {
  const salvos = [];
  const pedidas = [];
  const photoSides = require("../../lib/assessmentPhotoSides.js");

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify() {
          return USER;
        },
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (permissoes.length && !permissoes.includes(permissao)) {
            res.status(403).send({ msg: "sem permissão" });
            return false;
          }
          return USER;
        },
      },
    },
    api: {
      tenant: {
        async assessmentPhotoSides() {
          return photoSides.daInstancia(guardados);
        },
        async saveAssessmentPhotoSides(entrada) {
          const limpo = photoSides.normalizar(entrada);
          if (limpo) salvos.push(limpo);
          return limpo;
        },
      },
    },
  });

  TenantController(app);
  return { app, salvos, pedidas };
}

test("quem nunca configurou lê os quatro de fábrica, e o teto vem junto", async () => {
  const { app, pedidas } = montaAngulos();
  const r = await call(app, "get", "/me/tenant/assessment-photo-sides");

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sides.map((l) => l.key), ["front", "right", "left", "back"]);
  assert.equal(r.body.max, 12);
  // Ler é `assessments.view`: a tela da avaliação precisa da lista para desenhar
  // as vagas, e quem só consulta ficha também a abre.
  assert.deepEqual(pedidas, ["assessments.view"]);
});

test("gravar exige a permissão de quem avalia, não a de quem administra", async () => {
  const { app, salvos, pedidas } = montaAngulos({ permissoes: ["assessments.manage"] });

  const r = await call(app, "put", "/me/tenant/assessment-photo-sides", {
    body: { sides: [{ key: "front" }, { label: "Duplo bíceps" }] },
  });

  assert.equal(r.status, 200);
  assert.deepEqual(pedidas, ["assessments.manage"]);
  assert.deepEqual(r.body.sides, [
    { key: "front", label: "" },
    { key: "duplo-biceps", label: "Duplo bíceps" },
  ]);
  assert.equal(salvos.length, 1);
});

test("corpo que não é lista é recusado — gravar vazio apagaria os ângulos da casa", async () => {
  const { app, salvos } = montaAngulos({ permissoes: ["assessments.manage"] });
  const r = await call(app, "put", "/me/tenant/assessment-photo-sides", { body: {} });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "invalid_photo_sides");
  assert.deepEqual(salvos, []);
});

test("lista vazia de propósito PASSA — é a conta que não fotografa", async () => {
  const { app, salvos } = montaAngulos({ permissoes: ["assessments.manage"] });
  const r = await call(app, "put", "/me/tenant/assessment-photo-sides", { body: { sides: [] } });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sides, []);
  assert.deepEqual(salvos, [[]]);
});
