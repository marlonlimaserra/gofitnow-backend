const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const Assessment = require("../../controllers/Assessment.js");
const travaDeEnvio = require("../../lib/travaDeEnvio.js");

// Sem Chromium: estes casos são sobre o CORPO do e-mail e os anexos, não sobre a
// conversão. Levantar um navegador por caso levava quase um segundo cada.
process.env.PDF_DISABLED = "1";

// O DOCUMENTO INDO POR E-MAIL.
//
// ── O defeito que este arquivo existe para não deixar voltar ──────────────
//
// As fotos do corpo do e-mail não apareciam: o Gmail DESCARTA
// `<img src="data:…">`. Troquei por anexo embutido (`cid:`) e o corpo passou a
// funcionar — mas o PDF anexo, que é gerado do MESMO HTML por um Chromium que
// não resolve `cid:`, veio sem foto nenhuma.
//
// *"inverteu o problema kkk"*, como o Marlon descreveu. A regra que ficou:
// **cada saída recebe a versão que ela sabe ler**, e as duas nascem do mesmo dado.
const PESSOA = {
  _id: "p9",
  name: "Bruna Alves",
  email: "bruna@exemplo.com",
  sex: "female",
  birthDate: "1994-02-01",
};

const COLETA = {
  _id: "a2",
  student: "p9",
  date: "2026-08-26T00:00:00.000Z",
  weight: 78,
  height: 1.7,
  protocol: "pollock3",
  skinfolds: { triceps: 18, suprailiac: 22, thigh: 26 },
  circumferences: { waist: 78, hip: 96 },
  photos: { front: "2026-08-26T10:00:00.000Z" },
};

function monta(pessoa = PESSOA) {
  const enviados = [];

  const app = fakeApp({
    api: {
      assessment: {
        data: async () => COLETA,
        previousOf: async () => null,
      },
      assessmentPhoto: {
        data: async () => ({ mime: "image/jpeg", data: Buffer.from("BYTESDAFOTO") }),
      },
      user: { dataStudent: async () => pessoa },
      tenant: {
        assessmentPhotoSides: async () => [{ key: "front", label: "" }],
        timezoneOfInstance: async () => "America/Sao_Paulo",
        dataOfInstance: async () => ({ theme: { brand: "#0ea5e9" } }),
      },
    },
    helpers: {
      // `permiteTudo` devolve `{ pedidas, helpers }` — o que interessa aqui é o
      // `helpers.ReqProtected` de dentro.
      ...permiteTudo({ _id: "t1", name: "Marlon", lang: "pt-BR" }).helpers,
      mailer: {
        send: async (m) => {
          enviados.push(m);
          return { messageId: "x" };
        },
      },
    },
    // A trava lê a central; aqui ela responde "desligada" para não interferir.
    mongodb: {
      centralDb: async () => ({
        collection: () => ({ find: () => ({ toArray: async () => [{ key: "email.throttleEnabled", value: false }] }) }),
      }),
    },
  });

  Assessment(app);
  return { app, enviados };
}

beforeEach(() => travaDeEnvio.reset());

describe("o corpo e o anexo recebem versões diferentes", () => {
  test("o CORPO usa cid — é o que o Gmail sabe ler", async () => {
    const { app, enviados } = monta();
    await call(app, "post", "/assessments/a2/email");

    const html = enviados[0].html;
    assert.match(html, /src="cid:foto-front"/);
    // `data:` no corpo é exatamente o que sumia a foto.
    assert.doesNotMatch(html, /src="data:image/);
  });

  test("a foto vai como ANEXO EMBUTIDO — no corpo E na lista de anexos", async () => {
    const { app, enviados } = monta();
    await call(app, "post", "/assessments/a2/email");

    const foto = enviados[0].attachments.find((a) => a.cid === "foto-front");
    assert.ok(foto, "a foto não foi anexada");
    assert.strictEqual(foto.content.toString(), "BYTESDAFOTO");
  });

  test("a LOGO também vai por cid — ela é `data:` e o Gmail a descarta igual", async () => {
    const { app, enviados } = monta();
    await call(app, "post", "/assessments/a2/email");

    assert.match(enviados[0].html, /src="cid:logo-da-casa"/);
    assert.ok(enviados[0].attachments.some((a) => a.cid === "logo-da-casa"));
  });

  test("todo cid usado no corpo está DECLARADO num anexo", async () => {
    // Se divergirem, o e-mail chega com quadrado quebrado — e nada avisa, porque
    // o envio dá certo.
    const { app, enviados } = monta();
    await call(app, "post", "/assessments/a2/email");

    const usados = [...enviados[0].html.matchAll(/src="cid:([\w-]+)"/g)].map((m) => m[1]);
    const declarados = enviados[0].attachments.map((a) => a.cid).filter(Boolean);

    assert.ok(usados.length > 0, "o corpo não referenciou nenhum cid");
    for (const u of usados) assert.ok(declarados.includes(u), `o corpo usa ${u}, que ninguém declarou`);
  });
});

describe("a preferência de quem recebe", () => {
  test("quem desligou os documentos não recebe — e quem mandou fica sabendo", async () => {
    // *"vários e-mails que vamos enviar vai verificar essas notificações"*.
    // Devolver 200 sem mandar seria pior que não ter a preferência: quem
    // clicou ficaria esperando uma resposta a um e-mail que nunca saiu.
    const { app, enviados } = monta({
      ...PESSOA,
      preferences: { notify: { documento: false } },
    });

    const r = await call(app, "post", "/assessments/a2/email");

    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "notification_off");
    assert.strictEqual(enviados.length, 0);
  });

  test("desligar OUTRO assunto não cala o documento", async () => {
    const { app, enviados } = monta({
      ...PESSOA,
      preferences: { notify: { workout: false } },
    });

    await call(app, "post", "/assessments/a2/email");

    assert.strictEqual(enviados.length, 1);
  });

  test("quem nunca escolheu recebe", async () => {
    const { app, enviados } = monta();
    await call(app, "post", "/assessments/a2/email");

    assert.strictEqual(enviados.length, 1);
  });
});

describe("a trava de envio", () => {
  test("desligada na central, deixa mandar de novo", async () => {
    const { app, enviados } = monta();

    await call(app, "post", "/assessments/a2/email");
    await call(app, "post", "/assessments/a2/email");

    assert.strictEqual(enviados.length, 2);
  });
});
