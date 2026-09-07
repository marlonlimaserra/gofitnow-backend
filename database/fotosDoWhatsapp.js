require("dotenv").config();

const mongodb = require("../config/mongodb.js");
const instanceContext = require("../lib/instance.js");
const fotoDoWhatsapp = require("../lib/fotoDoWhatsapp.js");

// BUSCA A FOTO DO WHATSAPP DE QUEM JÁ ESTÁ CADASTRADO.
//
// A busca automática (ver `lib/fotoDoWhatsapp.js`) só alcança quem for cadastrado
// de hoje em diante. Este script alcança o passado — na instância do Marlon são
// 216 pessoas, e a maioria com telefone.
//
// ── AS TRAVAS ─────────────────────────────────────────────────────────────
//
//   1. NÃO FAZ NADA sem `--executar`. Sem a flag, conta quantos seriam.
//   2. Exige `--instancia=nome`. Não existe "todos os clientes de uma vez":
//      isso consultaria o WhatsApp por milhares de números de uma vez, e é o
//      caminho mais curto para o número ser banido.
//   3. Vai DEVAGAR. Uma pausa entre consultas — ver `PAUSA_MS`.
//   4. Só quem NÃO tem foto. Quem já tem escolheu a dele.
//
// ── POR QUE A PAUSA ───────────────────────────────────────────────────────
//
// O uazapi fala com o WhatsApp Web em nome de um número real. Duzentas consultas
// em rajada é exatamente o padrão que a Meta usa para identificar automação — e
// o preço é o número banido, com as conversas dele.
//
// Uma por segundo faz 216 pessoas levarem uns quatro minutos. É lento de
// propósito.
//
// uso:
//   node database/fotosDoWhatsapp.js --instancia=marlon
//   node database/fotosDoWhatsapp.js --instancia=marlon --executar
//   node database/fotosDoWhatsapp.js --instancia=marlon --executar --limite=20

const executar = process.argv.includes("--executar");
const arg = (nome) => (process.argv.find((a) => a.startsWith(`--${nome}=`)) || "").split("=")[1];

const instancia = arg("instancia");
const limite = Number(arg("limite")) || 0;

const PAUSA_MS = 1000;

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!instancia) {
    console.error("uso: node database/fotosDoWhatsapp.js --instancia=<nome> [--executar] [--limite=N]");
    process.exitCode = 1;
    return;
  }

  // O `app` que as libs esperam, montado à mão: este processo roda fora do
  // servidor, e `buscarParaPessoa` precisa de `mongodb`, `api.user` e
  // `api.avatar`.
  const appModels = require("../appModels.js");
  const app = { mongodb };
  app.api = {};
  for (const [nome, Modelo] of Object.entries(appModels)) {
    app.api[nome] = new Modelo(app);
  }

  await instanceContext.run(instancia, async () => {
    const cfg = await fotoDoWhatsapp.configuracao(app);
    if (!cfg.ligado) {
      console.error(
        "O WhatsApp está DESLIGADO na central (ou sem host/token).\n" +
          "Ligue em Configuração › WhatsApp e teste a conexão antes de rodar isto."
      );
      process.exitCode = 1;
      return;
    }

    const users = await app.api.user.collection();

    // Quem tem telefone e NÃO tem foto. O `avatarAt` é o campo que as telas
    // leem para saber se existe foto — é ele que diz quem falta.
    const filtro = {
      type: "student",
      phone: { $nin: [null, ""] },
      avatarAt: { $exists: false },
    };

    const quantos = await users.countDocuments(filtro);
    console.log(`${quantos} pessoa(s) com telefone e sem foto em "${instancia}".`);

    if (!executar) {
      console.log("\n— ENSAIO. Nada foi buscado. Use --executar.\n");
      return;
    }

    const lista = await users
      .find(filtro, { projection: { _id: 1, name: 1, phone: 1 } })
      .limit(limite || 0)
      .toArray();

    console.log(`Buscando ${lista.length}, uma por segundo. Isso leva ~${Math.ceil(lista.length / 60)} min.\n`);

    let achadas = 0;
    for (const [i, pessoa] of lista.entries()) {
      const ok = await fotoDoWhatsapp.buscarParaPessoa(app, pessoa._id, pessoa.phone);
      if (ok) achadas += 1;

      console.log(
        `  ${String(i + 1).padStart(4)}/${lista.length}  ${ok ? "✓" : "·"}  ${pessoa.name}`
      );

      // A pausa é DEPOIS de cada uma, menos a última — esperar um segundo para
      // então terminar é um segundo à toa.
      if (i < lista.length - 1) await esperar(PAUSA_MS);
    }

    console.log(`\n${achadas} de ${lista.length} tinham foto no WhatsApp.`);
    if (achadas < lista.length) {
      console.log(
        "Quem não tinha: número sem WhatsApp, sem foto de perfil, ou com a foto\n" +
          "restrita a contatos. Nada a corrigir."
      );
    }
  });
}

main()
  .catch((erro) => {
    console.error("falhou:", erro);
    process.exitCode = 1;
  })
  .finally(() => mongodb.close?.());
