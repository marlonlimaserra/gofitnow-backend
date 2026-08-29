// Põe o vocabulário e o idioma da conta NO DOCUMENTO ONDE O CÓDIGO OS PROCURA.
//
//   node database/vocabularioParaConta.js            mostra o que faria
//   node database/vocabularioParaConta.js --aplicar  aplica
//
// ── Por que existe ────────────────────────────────────────────────────────
//
// A palavra que o profissional usa (aluno / paciente / cliente) morava em
// `users.peopleSingular` — de cada pessoa. Passou a ser da CONTA.
//
// Só que "da conta" mudou de endereço duas vezes. Primeiro foi um documento por
// usuário (`{ user: dono }`); depois virou UM documento por instância, em
// `configurations`, com a chave `{ chave: "instancia" }`.
//
// Na segunda mudança a leitura foi migrada e a ESCRITA não. Durante esse período
// salvar o vocabulário criava um documento `{ user: dono }` em `configurations`
// que nenhum leitor procurava — e o defeito foi calado, porque o degrau de
// compatibilidade (`users.peopleSingular`) continuava respondendo com a palavra
// ANTIGA. A tela dizia "salvo" e não mudava nada.
//
// Este script recolhe as duas pontas soltas, nesta ordem de precedência:
//
//   1. o documento órfão `{ user: dono }` — a escolha MAIS RECENTE, feita no
//      período do defeito, e a única que se perderia
//   2. `users.peopleSingular` do dono — o endereço original
//
// ── Roda POR INSTÂNCIA ────────────────────────────────────────────────────
//
// Cada cliente tem o banco dele. O script recebe a instância, ou varre todas as
// que a central conhece.
require("dotenv").config();

const mongodb = require("../config/mongodb.js");
const instanceContext = require("../lib/instance.js");

const aplicar = process.argv.includes("--aplicar");

const CHAVE = { chave: "instancia" };

function limpar(v) {
  return String(v || "").trim().toLowerCase().slice(0, 30);
}

async function umaInstancia(instancia) {
  return instanceContext.run(instancia, async () => {
    const db = await mongodb.connectToServer();
    const users = db.collection("users");
    const configuracoes = db.collection("configurations");

    // O dono: o trainer mais antigo. A mesma regra do `Tenant_model`.
    const dono = await users.findOne({ type: "trainer" }, { sort: { createdAt: 1 } });
    if (!dono) return `${instancia}: sem dono, pulando`;

    const daCasa = await configuracoes.findOne(CHAVE);
    // O órfão: o documento que a escrita quebrada criou. Ele NÃO tem `chave`.
    const orfao = await configuracoes.findOne({ user: dono._id, chave: { $exists: false } });

    const recados = [];
    const set = {};

    // ── QUEM VENCE: o MAIS RECENTE, e não "a casa por ser a casa" ──────────
    //
    // As duas pontas podem ter palavra, e a do órfão costuma ser a mais nova —
    // ela é justamente a que foi salva no período do defeito. Preferir a casa
    // por princípio jogaria fora a última escolha da pessoa, que é o único dado
    // que este script existe para não perder.
    const quando = (doc) => new Date(doc?.updatedAt || doc?.createdAt || 0).getTime();

    const palavraDaCasa =
      limpar(daCasa?.peopleSingular) && limpar(daCasa?.peoplePlural)
        ? { singular: limpar(daCasa.peopleSingular), plural: limpar(daCasa.peoplePlural) }
        : null;
    const palavraDoOrfao =
      limpar(orfao?.peopleSingular) && limpar(orfao?.peoplePlural)
        ? { singular: limpar(orfao.peopleSingular), plural: limpar(orfao.peoplePlural) }
        : null;

    // ── VOCABULÁRIO ────────────────────────────────────────────────────────
    let escolhida = palavraDaCasa;
    let origem = "casa";

    if (palavraDoOrfao && (!palavraDaCasa || quando(orfao) > quando(daCasa))) {
      escolhida = palavraDoOrfao;
      origem = "órfão";
    }

    if (!escolhida) {
      const singular = limpar(dono.peopleSingular);
      const plural = limpar(dono.peoplePlural);
      if (singular && plural) {
        escolhida = { singular, plural };
        origem = "users";
      }
    }

    if (!escolhida) {
      recados.push("palavra: ninguém escolheu, fica pessoa/pessoas");
    } else if (
      palavraDaCasa &&
      escolhida.singular === palavraDaCasa.singular &&
      escolhida.plural === palavraDaCasa.plural
    ) {
      recados.push(`palavra já certa na casa (${escolhida.singular}/${escolhida.plural})`);
    } else {
      set.peopleSingular = escolhida.singular;
      set.peoplePlural = escolhida.plural;
      recados.push(`palavra ${escolhida.singular}/${escolhida.plural} (de ${origem})`);
    }

    // ── IDIOMA DA CONTA ────────────────────────────────────────────────────
    if (orfao?.language && (!daCasa?.language || quando(orfao) > quando(daCasa))) {
      if (orfao.language !== daCasa?.language) {
        set.language = orfao.language;
        recados.push(`idioma ${orfao.language} (de órfão)`);
      }
    } else if (daCasa?.language) {
      recados.push(`idioma já na casa (${daCasa.language})`);
    }

    // ── O ÓRFÃO SÓ SAI QUANDO NADA SE PERDE ────────────────────────────────
    //
    // Ele é um documento que nenhum leitor procura, e deixá-lo faria a próxima
    // rodada achar que ainda há o que recuperar. Mas apagá-lo enquanto ele
    // guarda uma palavra que não foi para a casa seria destruir a única cópia —
    // então nesse caso ele fica, e o script diz por quê.
    const palavraFinal = escolhida || palavraDaCasa;
    const orfaoJaEstaNaCasa =
      !palavraDoOrfao ||
      (palavraFinal &&
        palavraDoOrfao.singular === palavraFinal.singular &&
        palavraDoOrfao.plural === palavraFinal.plural);
    const idiomaDoOrfaoJaEstaNaCasa =
      !orfao?.language || orfao.language === (set.language || daCasa?.language);

    const podeApagarOrfao = Boolean(orfao) && orfaoJaEstaNaCasa && idiomaDoOrfaoJaEstaNaCasa;
    if (orfao && !podeApagarOrfao) recados.push("órfão MANTIDO — ele guarda algo que não foi para a casa");

    if (!Object.keys(set).length && !podeApagarOrfao) {
      return `${instancia}: nada a fazer — ${recados.join("; ")}`;
    }
    if (!aplicar) {
      return `${instancia}: FARIA ${recados.join("; ")}${podeApagarOrfao ? "; apagaria o órfão" : ""}`;
    }

    if (Object.keys(set).length) {
      await configuracoes.updateOne(
        CHAVE,
        { $set: { ...set, updatedAt: new Date() }, $setOnInsert: { ...CHAVE, createdAt: new Date() } },
        { upsert: true }
      );
    }

    // O campo antigo em `users` NÃO é apagado — apagar tornaria a migração
    // irreversível, e o degrau de compatibilidade do leitor ainda o usa.
    if (podeApagarOrfao) await configuracoes.deleteOne({ _id: orfao._id });

    return `${instancia}: ✓ ${recados.join("; ")}${podeApagarOrfao ? "; órfão apagado" : ""}`;
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
