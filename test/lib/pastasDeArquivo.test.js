const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const instanceContext = require("../../lib/instance.js");
const arquivos = require("../../lib/arquivos.js");

// ESTE ARQUIVO EXISTE PORQUE O DEFEITO ACONTECEU TRÊS VEZES.
//
// `lib/arquivos.js` tem uma tabela de pastas e RECUSA o que não está nela. A
// recusa é o comportamento certo: inventar o caminho deixaria um cliente
// escrevendo numa pasta que ninguém declarou.
//
// O problema é o outro lado. Quem cria um modelo de imagem escreve
// `prefixo: "funcionarios"` e não tem por que saber que existe uma segunda
// lista, noutro arquivo, que precisa concordar. Nada avisa: o código compila, o
// teste passa, a tela desenha o botão — e o upload estoura em produção.
//
// ── A CONTAGEM ──────────────────────────────────────────────────────────
//
//   16/09/2026 — aulão. Registrado depois do erro, com um comentário pedindo
//                desculpa na tabela.
//   18/09/2026 — unidade e aula coletiva, as duas. Ninguém notou: as duas telas
//                subiram sem que ninguém tentasse pôr uma foto.
//   19/09/2026 — fornecedor e funcionário. O do funcionário apareceu na tela de
//                erros do painel no mesmo dia, e foi ele que revelou os outros
//                três, com ZERO fotos gravadas cada um.
//
// Um erro que se repete três vezes não é descuido de quem escreveu: é uma
// regra que só existe na cabeça de quem já tropeçou nela. Aqui ela vira teste.
const RAIZ = path.join(__dirname, "..", "..");
const MODELOS = path.join(RAIZ, "model");

// `prefixo: "alguma-coisa"` — como a fábrica de modelos de imagem o declara.
const PREFIXO = /prefixo:\s*"([^"]+)"/g;

function prefixosUsados() {
  const achados = new Map();

  for (const nome of fs.readdirSync(MODELOS).filter((f) => f.endsWith(".js"))) {
    const texto = fs.readFileSync(path.join(MODELOS, nome), "utf8");
    for (const m of texto.matchAll(PREFIXO)) achados.set(m[1], nome);
  }

  return achados;
}

test("toda pasta que um modelo usa está DECLARADA em lib/arquivos.js", () => {
  const faltando = [];

  // A prova é pelo COMPORTAMENTO, e não comparando duas listas: `chaveDoCliente`
  // é o caminho real, e é ele que estoura em produção. Comparar tabelas deixaria
  // passar o dia em que a montagem da chave mudar de lugar.
  instanceContext.run("teste", () => {
    for (const [prefixo, arquivo] of prefixosUsados()) {
      try {
        arquivos.chaveDoCliente(prefixo, "68c9f6b1a2b3c4d5e6f70011");
      } catch (erro) {
        faltando.push(`${prefixo} (${arquivo}) — ${erro.message}`);
      }
    }
  });

  assert.deepEqual(
    faltando,
    [],
    "pasta que um modelo de imagem usa e `lib/arquivos.js` não conhece — " +
      "o upload aceita na tela e estoura no servidor"
  );
});

test("há prefixos para conferir — um teste que não vê nada passaria calado", () => {
  // Se a varredura parar de achar (a fábrica mudar de forma, a pasta mudar de
  // nome), o caso acima passaria vazio e viraria enfeite.
  assert.ok(prefixosUsados().size >= 4, "a varredura de prefixos não achou nada");
});

test("uma pasta inventada continua sendo RECUSADA", () => {
  // O outro lado da moeda: a tabela existe para recusar. Um teste que só
  // conferisse a lista poderia ser satisfeito abrindo a porta para tudo.
  instanceContext.run("teste", () => {
    assert.throws(
      () => arquivos.chaveDoCliente("pasta-que-ninguem-declarou", "abc"),
      /pasta desconhecida/
    );
  });
});

test("a chave sai com o cliente na frente, e nada sobe de pasta", () => {
  instanceContext.run("marlon", () => {
    assert.equal(
      arquivos.chaveDoCliente("funcionarios", "68c9f6b1a2b3c4d5e6f70011"),
      "marlon/funcionarios/68c9f6b1a2b3c4d5e6f70011"
    );

    // `..` num id mal validado é um cliente escrevendo na pasta de outro.
    assert.throws(() => arquivos.chaveDoCliente("funcionarios", ".."), /inválido/);
    assert.throws(() => arquivos.chaveDoCliente("funcionarios", "a/b"), /inválido/);
  });
});

// ── E O QUE A FALHA DEIXAVA PARA TRÁS ─────────────────────────────────────
//
// `modeloDeImagens.save` insere a ficha ANTES de gravar os bytes, porque a
// chave do arquivo precisa do id. Quando o passo seguinte estourava, ficava no
// banco uma ficha de foto com `mime` e `size` e nenhum byte em lugar nenhum.
//
// Uma imagem que não é imagem é pior que imagem nenhuma: conta na faxina,
// aparece na contagem, e a rota que a lê devolve 404 para um id que existe. Foi
// exatamente o que sobrou do upload de funcionário que falhou em produção.
const { modeloDeImagens } = require("../../lib/modeloDeImagens.js");

function fakeModelo() {
  const docs = new Map();
  let proximo = 1;

  const Modelo = modeloDeImagens({ collection: "x_images", dono: "x", prefixo: "funcionarios" });
  const model = new Modelo({});

  model.collection = async () => ({
    async insertOne(doc) {
      const { ObjectId } = require("mongodb");
      const _id = new ObjectId(String(proximo++).padStart(24, "0"));
      docs.set(String(_id), doc);
      return { insertedId: _id };
    },
    async updateOne(filtro) {
      return { matchedCount: docs.has(String(filtro._id)) ? 1 : 0 };
    },
    async deleteOne(filtro) {
      const tinha = docs.delete(String(filtro._id));
      return { deletedCount: tinha ? 1 : 0 };
    },
  });

  return { model, docs };
}

test("gravação que falha NÃO deixa ficha de foto órfã", async () => {
  const { model, docs } = fakeModelo();
  const original = arquivos.ondeGuardar;
  arquivos.ondeGuardar = async () => {
    throw new Error("balde fora do ar");
  };

  try {
    await instanceContext.run("teste", () =>
      assert.rejects(
        () => model.save("68c9f6b1a2b3c4d5e6f70011", "image/png", Buffer.from("x")),
        /balde fora do ar/
      )
    );
  } finally {
    arquivos.ondeGuardar = original;
  }

  assert.equal(docs.size, 0, "a ficha ficou no banco sem bytes");
});

test("o erro CONTINUA subindo — quem chamou precisa saber", async () => {
  // Engolir a falha faria a tela dizer "foto salva" para uma foto que não
  // existe, que é o único desfecho pior que o erro.
  const { model } = fakeModelo();
  const original = arquivos.ondeGuardar;
  arquivos.ondeGuardar = async () => {
    throw new Error("balde fora do ar");
  };

  try {
    await instanceContext.run("teste", () =>
      assert.rejects(() => model.save("68c9f6b1a2b3c4d5e6f70011", "image/png", Buffer.from("x")))
    );
  } finally {
    arquivos.ondeGuardar = original;
  }
});

test("gravação que dá certo mantém a ficha", async () => {
  const { model, docs } = fakeModelo();

  const r = await instanceContext.run("teste", () =>
    model.save("68c9f6b1a2b3c4d5e6f70011", "image/png", Buffer.from("x"))
  );

  assert.ok(r.id);
  assert.equal(docs.size, 1);
});

// ── APAGAR APAGA DOS DOIS LUGARES ─────────────────────────────────────────
//
// *"quando exclui algo, você exclui de lá?"*
//
// Não excluía, em dois caminhos: remover a foto de perfil tirava a ficha do
// Mongo e deixava o objeto no balde, e excluir a CONTA não tirava nem a ficha.
//
// Objeto sem documento que aponte para ele é lixo invisível: nenhuma varredura
// o alcança, nenhuma tela o mostra, e ele só aparece na fatura.
const Avatar_model = require("../../model/Avatar_model.js");

function fakeAvatar(comChave) {
  const apagadas = [];
  const docs = { presente: true };

  const model = new Avatar_model({
    api: {
      user: {
        async collection() {
          return { async updateOne() {} };
        },
      },
    },
  });

  model.collection = async () => ({
    async findOne() {
      return comChave ? { chave: "marlon/avatares/u1" } : { data: Buffer.from("x") };
    },
    async deleteOne() {
      docs.presente = false;
      return { deletedCount: 1 };
    },
  });

  // `espelhar` fala com o banco do painel; aqui ele não é o assunto.
  model.espelhar = async () => {};

  const original = arquivos.apagar;
  arquivos.apagar = async (chave) => {
    apagadas.push(chave);
    return true;
  };

  return { model, apagadas, docs, restaurar: () => (arquivos.apagar = original) };
}

test("remover a foto de perfil apaga o objeto do R2", async () => {
  const { model, apagadas, restaurar } = fakeAvatar(true);

  try {
    await model.delete("68c9f6b1a2b3c4d5e6f70011");
  } finally {
    restaurar();
  }

  assert.deepEqual(apagadas, ["marlon/avatares/u1"]);
});

test("foto que está no BANCO não tenta apagar no balde", async () => {
  // Durante a migração metade dos arquivos está de cada lado. Chamar o R2 com
  // `undefined` seria uma ida à rede para apagar nada.
  const { model, apagadas, restaurar } = fakeAvatar(false);

  try {
    await model.delete("68c9f6b1a2b3c4d5e6f70011");
  } finally {
    restaurar();
  }

  assert.deepEqual(apagadas, []);
});

test("R2 fora do ar NÃO impede a foto de sair do banco", async () => {
  // A foto já sumiu da tela; um botão de remover que falha por causa do balde
  // seria pior que um objeto órfão.
  const { model, docs, restaurar } = fakeAvatar(true);
  arquivos.apagar = async () => {
    throw new Error("balde fora do ar");
  };

  try {
    const ok = await model.delete("68c9f6b1a2b3c4d5e6f70011");
    assert.equal(ok, true);
    assert.equal(docs.presente, false);
  } finally {
    restaurar();
  }
});

test("excluir a CONTA manda apagar a foto junto", async () => {
  // Ela ficava com um documento apontando para um id que não existe mais, e os
  // bytes no R2 atrás dele.
  const User_model = require("../../model/User_model.js");
  const chamadas = [];

  const model = new User_model({
    api: {
      link: { async deleteAllOf() {} },
      avatar: {
        async delete(id) {
          chamadas.push(id);
          return true;
        },
      },
    },
  });

  model.collection = async () => ({ async deleteOne() { return { deletedCount: 1 }; } });

  await model.deleteAny("68c9f6b1a2b3c4d5e6f70011");
  assert.deepEqual(chamadas, ["68c9f6b1a2b3c4d5e6f70011"]);
});

test("falha ao apagar a foto NÃO impede a conta de ser excluída", async () => {
  // O pedido de exclusão de dados tem prazo; a foto órfã é o menor dos males.
  const User_model = require("../../model/User_model.js");

  const model = new User_model({
    api: {
      link: { async deleteAllOf() {} },
      avatar: {
        async delete() {
          throw new Error("balde fora do ar");
        },
      },
    },
  });

  model.collection = async () => ({ async deleteOne() { return { deletedCount: 1 }; } });

  assert.equal(await model.deleteAny("68c9f6b1a2b3c4d5e6f70011"), true);
});
