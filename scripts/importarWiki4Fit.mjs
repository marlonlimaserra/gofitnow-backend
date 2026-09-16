// IMPORTA OS ALUNOS DE UMA CONTA DO WIKI4FIT PARA DENTRO DE UMA INSTÂNCIA.
//
//   node scripts/importarWiki4Fit.mjs <instancia> <arquivo.json> [--pra-valer]
//
// Sem `--pra-valer` ele só RELATA o que faria. É ensaio por padrão de
// propósito: importar gente na base de um cliente que está usando o produto é
// difícil de desfazer, e a primeira rodada sempre revela um campo que veio
// diferente do esperado.
//
// ── DE ONDE VEM O ARQUIVO ─────────────────────────────────────────────────
//
// Do endpoint `/dashboard/users/_legacy` do painel do Wiki4Fit, com o Bearer da
// sessão de quem está migrando:
//
//   curl -H "Authorization: Bearer <token>" \
//     "https://integrations.wiki4fit.com.br/dashboard/users/_legacy?sort=name:asc&page=1&limit=500" \
//     -o alunos.json
//
// A resposta é um objeto com chaves "0", "1", "2"… e não um array — este script
// já trata os dois.
//
// O token dura 15 MINUTOS (`exp - iat` = 900s). Se der "não autorizado", é isso:
// pegue outro na aba de rede do navegador, não há nada errado com o script.
//
// ── O QUE NÃO É IMPORTADO, E POR QUÊ ──────────────────────────────────────
//
//   password    O Wiki4Fit manda um campo de senha em cada registro. Ele NÃO é
//               copiado, e não é descuido nem limitação: o hash de um sistema
//               não vale no outro (algoritmo e sal diferentes), então copiá-lo
//               não daria login a ninguém — só moveria credencial de gente de
//               um banco para outro, de graça. Aqui o aluno nasce SEM senha, que
//               é exatamente o que `insertStudent` já faz: existe como ficha, e
//               ganha acesso quando o profissional mandar o convite.
//
//   cpf         Não existe campo de CPF na ficha daqui. Guardá-lo num campo de
//               texto qualquer seria esconder dado sensível num lugar que
//               ninguém sabe que o contém — e CPF é dado que a LGPD trata com
//               mais rigor justamente por ser identificador nacional.
//
//   note        VEM, e vai para o lugar certo: a anotação privada do
//               profissional, que mora no VÍNCULO e não na pessoa
//               (`Link_model.setNotes`). Eu tinha dito que não havia campo —
//               procurei em `User_model` e não achei, porque ele não é da
//               pessoa: é da relação, e por isso outro profissional que
//               acompanhe a mesma pessoa não o vê.
//
//               Nunca SOBRESCREVE: se já houver anotação deste lado, a do
//               Wiki4Fit é descartada. Migração não pode apagar o que alguém
//               escreveu aqui depois.
//
//   enrollment, specialGroups, imageUrl, subscription*
//               Conceitos do outro produto sem correspondente aqui. Listados no
//               resumo, não inventados numa coluna nossa.
//
// ── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────
//
// A chave é o E-MAIL, normalizado. Rodar duas vezes não duplica ninguém: quem
// já existe é PULADO, nunca sobrescrito. Sobrescrever seria pior que duplicar —
// apagaria por cima o que o profissional já tiver ajustado aqui dentro.
//
// Quem vem SEM e-mail não tem chave, então não dá para saber se já entrou. Esses
// são importados na primeira vez e listados à parte, para uma segunda rodada não
// os repetir sem alguém olhar.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const defaultModules = require("../defaultModules.js");
const appModels = require("../appModels.js");
const instanceContext = require("../lib/instance.js");

const [, , INSTANCIA, ARQUIVO, ...resto] = process.argv;
const PRA_VALER = resto.includes("--pra-valer");

if (!INSTANCIA || !ARQUIVO) {
  console.error("uso: node scripts/importarWiki4Fit.mjs <instancia> <arquivo.json> [--pra-valer]");
  process.exit(1);
}

const app = {};
app.mongodb = require("../config/mongodb.js");
for (const k in defaultModules) app[k] = defaultModules[k];
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

// ── AS CONVERSÕES ─────────────────────────────────────────────────────────

// Nome e sobrenome são dois campos lá e um só aqui.
function nomeDe(r) {
  return [r.name, r.surname].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
}

// `SEXES` daqui aceita só "female" e "male". O que não casar vira vazio, e não
// um chute: um sexo errado na ficha entra em conta de gasto energético.
function sexoDe(bruto) {
  const v = String(bruto || "").trim().toLowerCase();
  if (["f", "female", "feminino", "mulher"].includes(v)) return "female";
  if (["m", "male", "masculino", "homem"].includes(v)) return "male";
  return "";
}

// A ficha guarda a data como texto `AAAA-MM-DD`. O que chegar em ISO completo é
// cortado; o que não for data reconhecível vira vazio em vez de "Invalid Date".
function nascimentoDe(bruto) {
  const v = String(bruto || "").trim();
  if (!v) return "";
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function telefoneDe(bruto) {
  return String(bruto || "").trim();
}

function emailDe(bruto) {
  return String(bruto || "").trim().toLowerCase();
}

// ── QUEM RECEBE ───────────────────────────────────────────────────────────
//
// Os alunos entram VINCULADOS a um profissional — é o vínculo que faz alguém
// aparecer na lista de alguém (`insertStudent` já o cria). Sem escolher o certo,
// 65 pessoas entrariam no banco invisíveis para todo mundo.
//
// A escolha é o admin mais antigo da instância: numa conta de personal, é ele.
// Se houver mais de um, o script MOSTRA e exige `--profissional <id>`.
async function escolherProfissional(pedido) {
  const db = await app.mongodb.connectToServer();
  const admins = await db
    .collection("users")
    .find({ type: { $ne: "student" }, active: 1 }, { projection: { name: 1, email: 1, createdAt: 1 } })
    .sort({ createdAt: 1 })
    .toArray();

  if (!admins.length) throw new Error("nenhum profissional ativo nesta instância");

  if (pedido) {
    const achado = admins.find((a) => String(a._id) === String(pedido));
    if (!achado) throw new Error("profissional " + pedido + " não encontrado");
    return achado;
  }

  if (admins.length > 1) {
    console.log("\nMais de um profissional nesta instância. Escolha com --profissional <id>:");
    for (const a of admins) console.log("  ", String(a._id), "|", a.name);
    throw new Error("profissional não escolhido");
  }

  return admins[0];
}

// ── A IMPORTAÇÃO ──────────────────────────────────────────────────────────

const cru = JSON.parse(readFileSync(ARQUIVO, "utf8"));
const registros = Array.isArray(cru) ? cru : Object.values(cru);

await instanceContext.run(INSTANCIA, async () => {
  const db = await app.mongodb.connectToServer();
  const pedido = resto[resto.indexOf("--profissional") + 1];
  const prof = await escolherProfissional(resto.includes("--profissional") ? pedido : null);

  console.log("instância :", INSTANCIA);
  console.log("recebe    :", prof.name, "(" + prof._id + ")");
  console.log("no arquivo:", registros.length, "registros");
  console.log("modo      :", PRA_VALER ? "GRAVANDO" : "ensaio (nada é escrito)");
  console.log("");

  const jaExistem = new Set(
    (await db.collection("users").find({}, { projection: { email: 1 } }).toArray())
      .map((u) => emailDe(u.email))
      .filter(Boolean)
  );

  const resumo = { criados: 0, pulados: 0, semEmail: 0, semNome: 0, comNota: 0, comCpf: 0, notasGravadas: 0, notaPreservada: 0 };
  const semEmail = [];

  for (const r of registros) {
    const nome = nomeDe(r);
    if (!nome) { resumo.semNome++; continue; }

    const email = emailDe(r.email);
    if (r.note) resumo.comNota++;
    if (r.cpf) resumo.comCpf++;

    const jaEstava = Boolean(email && jaExistem.has(email));
    if (!email) { resumo.semEmail++; semEmail.push(nome); }

    // ── ACHAR OU CRIAR ────────────────────────────────────────────────────
    //
    // Quem já existe não é recriado nem sobrescrito — mas o `_id` dele é
    // preciso mesmo assim, porque a ANOTAÇÃO é um segundo dado, que pode
    // faltar mesmo em quem já entrou. Foi o caso desta migração: os 64 alunos
    // entraram numa rodada em que eu ainda achava que não havia campo de
    // observação, e as duas notas ficaram para trás.
    let pessoaId = null;

    if (jaEstava) {
      resumo.pulados++;
      const doc = await db.collection("users").findOne({ email }, { projection: { _id: 1 } });
      pessoaId = doc?._id || null;
    } else if (PRA_VALER) {
      pessoaId = await app.api.user.insertStudent(prof._id, {
        name: nome,
        email,
        phone: telefoneDe(r.phoneNumber),
        birthDate: nascimentoDe(r.birthDate),
        sex: sexoDe(r.gender),
        // `enabled: false` lá vira inativo aqui: quem o outro sistema desligou
        // não deve reaparecer ativo na lista de ninguém.
        active: r.enabled === false ? 0 : 1,
        // password DE PROPÓSITO ausente — ver o cabeçalho.
      });
      resumo.criados++;
      if (email) jaExistem.add(email);
    } else {
      resumo.criados++;
      if (email) jaExistem.add(email);
    }

    // ── A ANOTAÇÃO ────────────────────────────────────────────────────────
    //
    // Depois de existir a pessoa, e só quando não houver anotação deste lado.
    const nota = String(r.note || "").trim();
    if (nota && pessoaId) {
      const atual = await app.api.link.notesOf(prof._id, pessoaId);
      if (atual) {
        resumo.notaPreservada++;
      } else if (PRA_VALER) {
        await app.api.link.setNotes(prof._id, pessoaId, nota);
        resumo.notasGravadas++;
      } else {
        resumo.notasGravadas++;
      }
    } else if (nota) {
      resumo.notasGravadas++;
    }
  }

  console.log("criados        :", resumo.criados);
  console.log("já existiam    :", resumo.pulados, "(pulados pelo e-mail)");
  console.log("sem nome       :", resumo.semNome, "(ignorados)");
  console.log("sem e-mail     :", resumo.semEmail, "— entram, mas uma segunda rodada os repetiria");
  if (semEmail.length) console.log("                ", semEmail.length, "pessoa(s); confira antes de rodar de novo");
  console.log("");
  console.log("observações    :", resumo.comNota, "no arquivo →", resumo.notasGravadas, "na anotação do vínculo");
  if (resumo.notaPreservada) {
    console.log("                ", resumo.notaPreservada, "preservada(s): já havia anotação aqui, e a daqui ganha");
  }
  console.log("");
  console.log("NÃO vieram:");
  console.log("  CPF          :", resumo.comCpf, "registro(s) tinham `cpf` (não há campo aqui)");
  console.log("  senha        : nenhuma, por decisão — ver o cabeçalho do script");

  if (!PRA_VALER) console.log("\nEnsaio. Para gravar, repita com --pra-valer");
});

process.exit(0);
