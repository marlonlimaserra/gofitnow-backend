// Move o vocabulário do documento do DONO para o documento da CONTA.
//
//   node database/vocabularioParaConta.js            mostra o que faria
//   node database/vocabularioParaConta.js --aplicar  aplica
//
// ── Por que existe ────────────────────────────────────────────────────────
//
// A palavra que o profissional usa (aluno / paciente / cliente) morava em
// `users.peopleSingular` — de cada pessoa. Passou a ser da conta, em
// `tenants.peopleSingular`.
//
// O leitor (`Tenant_model.wordsOfInstance`) tem um degrau de compatibilidade que
// ainda enxerga o lugar antigo, então nada quebra sem esta migração. Ela existe
// para o dado ficar onde o código espera, e para o degrau poder sair depois.
//
// ── Roda POR INSTÂNCIA ────────────────────────────────────────────────────
//
// Cada cliente tem o banco dele. O script recebe a instância, ou varre todas as
// que a central conhece.
require("dotenv").config();

const mongodb = require("../config/mongodb.js");
const instanceContext = require("../lib/instance.js");

const aplicar = process.argv.includes("--aplicar");

function limpar(v) {
  return String(v || "").trim().toLowerCase().slice(0, 30);
}

async function umaInstancia(instancia) {
  return instanceContext.run(instancia, async () => {
    const db = await mongodb.connectToServer();
    const users = db.collection("users");
    const tenants = db.collection("tenants");

    // O dono: o trainer mais antigo. A mesma regra do `Tenant_model`.
    const dono = await users.findOne({ type: "trainer" }, { sort: { createdAt: 1 } });
    if (!dono) return `${instancia}: sem dono, pulando`;

    const tenant = await tenants.findOne({ user: dono._id });

    if (limpar(tenant?.peopleSingular) && limpar(tenant?.peoplePlural)) {
      return `${instancia}: já está na conta (${tenant.peopleSingular}/${tenant.peoplePlural})`;
    }

    const singular = limpar(dono.peopleSingular);
    const plural = limpar(dono.peoplePlural);

    if (!singular || !plural) {
      return `${instancia}: o dono nunca escolheu — fica no padrão pessoa/pessoas`;
    }

    if (!aplicar) return `${instancia}: MOVERIA ${singular}/${plural}`;

    await tenants.updateOne(
      { user: dono._id },
      {
        $set: { peopleSingular: singular, peoplePlural: plural, updatedAt: new Date() },
        $setOnInsert: { user: dono._id, status: "none", createdAt: new Date() },
      },
      { upsert: true }
    );

    // O campo antigo NÃO é apagado nesta passada.
    //
    // Apagar junto tornaria a migração irreversível: se algo estiver errado no
    // lugar novo, a única cópia teria ido embora. Sai numa segunda passada, depois
    // de a tela confirmar que está lendo do lugar certo.
    return `${instancia}: ✓ ${singular}/${plural} movido (o campo antigo ficou)`;
  });
}

async function principal() {
  const pedida = process.argv.slice(2).find((a) => !a.startsWith("--"));

  // A lista de instâncias vem da central, como todo o resto do sistema.
  const db = await mongodb.centralDb();
  const registros = await db
    .collection("instances")
    .find({ active: { $ne: false } }, { projection: { instance: 1 } })
    .toArray();

  const alvos = pedida ? [pedida] : registros.map((r) => r.instance);

  console.log(aplicar ? "APLICANDO:" : "ENSAIO (use --aplicar para valer):");

  for (const instancia of alvos) {
    try {
      console.log("  " + (await umaInstancia(instancia)));
    } catch (error) {
      console.log(`  ${instancia}: ERRO — ${error.message}`);
    }
  }

  await mongodb.close();
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
