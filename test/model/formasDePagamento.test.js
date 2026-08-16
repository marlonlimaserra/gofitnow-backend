const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const PaymentMethod_model = require("../../model/PaymentMethod_model.js");

// As formas de pagamento de cada conta.
//
// Eram sete, fixas no código. O pedido foi poder criar, renomear, desativar e
// reordenar — e o risco de atender a esse pedido é o histórico: `method` fica
// gravado em todo pagamento, e uma forma que some deixa lançamentos apontando
// para o nada.
//
// A saída é a chave. `key` é o que o pagamento guarda e ela NUNCA muda; `name` é
// o que se lê na tela e muda quando quiser.
function monta(docs = []) {
  const dados = [...docs];
  const escritas = [];
  let pagamentosComMetodo = 0;

  const col = (nome) => ({
    find(query = {}) {
      let saida = dados.filter((d) =>
        Object.entries(query).every(([k, v]) => String(d[k]) === String(v))
      );
      const cursor = {
        sort(campo) {
          const [chave, dir] = Object.entries(campo)[0];
          saida = [...saida].sort((a, b) => (a[chave] - b[chave]) * dir);
          return cursor;
        },
        limit: (n) => ((saida = saida.slice(0, n)), cursor),
        async toArray() {
          return saida;
        },
      };
      return cursor;
    },
    async findOne(query) {
      return (
        dados.find((d) =>
          Object.entries(query).every(([k, v]) => String(d[k]) === String(v))
        ) || null
      );
    },
    async insertOne(doc) {
      const _id = new ObjectId();
      dados.push({ _id, ...doc });
      escritas.push({ tipo: "insert", doc });
      return { insertedId: _id };
    },
    async insertMany(docs) {
      for (const d of docs) dados.push({ _id: new ObjectId(), ...d });
      escritas.push({ tipo: "insertMany", total: docs.length });
    },
    async updateOne(query, mudanca) {
      const alvo = dados.find((d) => String(d._id) === String(query._id));
      if (alvo) Object.assign(alvo, mudanca.$set);
      escritas.push({ tipo: "update", query, mudanca });
      return { matchedCount: alvo ? 1 : 0 };
    },
    async deleteOne(query) {
      const antes = dados.length;
      const i = dados.findIndex((d) => String(d._id) === String(query._id));
      if (i >= 0) dados.splice(i, 1);
      escritas.push({ tipo: "delete" });
      return { deletedCount: antes - dados.length };
    },
    async countDocuments() {
      return nome === "payments" ? pagamentosComMetodo : dados.length;
    },
  });

  const app = {
    mongodb: {
      async connectToServer() {
        return { collection: (nome) => col(nome) };
      },
    },
  };

  return {
    modelo: new PaymentMethod_model(app),
    dados,
    escritas,
    usarEmPagamento: () => (pagamentosComMetodo = 1),
  };
}

const AS_SETE = ["pix", "cash", "credit", "debit", "transfer", "billet", "other"];

test("a conta que nunca abriu a tela já nasce com as sete", async () => {
  // Semear na primeira leitura, e não numa migração: instância nova, antiga e a
  // criada amanhã passam todas por aqui, e nenhuma depende de alguém lembrar de
  // rodar algo.
  const { modelo } = monta();

  const lista = await modelo.list();

  assert.deepEqual(lista.map((f) => f.key), AS_SETE);
  assert.ok(lista.every((f) => f.system));
});

test("as sete nascem SEM nome — o nome delas é a tradução", async () => {
  // Gravar "Dinheiro" congelaria o idioma de quem criou a conta: em inglês a
  // tela mostraria "Dinheiro". Quem renomear passa a ter nome próprio, e aí a
  // tradução sai de cena, que é o certo.
  const { modelo } = monta();

  const lista = await modelo.list();

  assert.ok(lista.every((f) => f.name === ""));
});

test("semeia UMA vez — abrir a tela dez vezes não cria setenta formas", async () => {
  const { modelo, escritas } = monta();

  await modelo.list();
  await modelo.list();
  await modelo.list();

  assert.equal(escritas.filter((e) => e.tipo === "insertMany").length, 1);
});

test("a forma nova entra no FIM", async () => {
  // No meio, ela mudaria de lugar o que as pessoas já sabem onde fica.
  const { modelo, dados } = monta();
  await modelo.list();

  await modelo.insert({ name: "Cheque" });

  const lista = await modelo.list();
  assert.equal(lista.at(-1).key, "cheque");
  assert.equal(lista.at(-1).order, 7);
});

test("a chave sai do nome, sem acento e sem espaço", async () => {
  // Ela viaja em URL de relatório e vira coluna de planilha: "à vista / 50%" ali
  // seria um problema em três lugares.
  const { modelo, escritas } = monta();
  await modelo.list();

  await modelo.insert({ name: "Cartão da Recepção" });

  assert.equal(escritas.find((e) => e.tipo === "insert").doc.key, "cartao-da-recepcao");
});

test("nome curto demais é recusado", async () => {
  const { modelo } = monta();
  await modelo.list();

  assert.deepEqual(await modelo.insert({ name: "x" }), { erro: "name" });
  assert.deepEqual(await modelo.insert({ name: "  " }), { erro: "name" });
});

test("duas formas com a mesma chave seriam a mesma forma com dois nomes", async () => {
  const { modelo } = monta();
  await modelo.list();

  await modelo.insert({ name: "Cheque" });

  assert.deepEqual(await modelo.insert({ name: "cheque" }), { erro: "duplicate" });
});

test("renomear NÃO muda a chave — o histórico aponta para ela", async () => {
  // É a decisão que sustenta a tela inteira: "Boleto" pode virar "Boleto
  // bancário" sem que nenhum pagamento antigo perca o rumo.
  const { modelo, dados } = monta();
  await modelo.list();
  const boleto = dados.find((f) => f.key === "billet");

  await modelo.update(boleto._id, { name: "Boleto bancário" });

  assert.equal(boleto.name, "Boleto bancário");
  assert.equal(boleto.key, "billet");
});

test("desativada some do seletor e continua na lista de configuração", async () => {
  const { modelo, dados } = monta();
  await modelo.list();
  const boleto = dados.find((f) => f.key === "billet");

  await modelo.update(boleto._id, { active: 0 });

  assert.ok(!(await modelo.listActive()).some((f) => f.key === "billet"));
  assert.ok((await modelo.list()).some((f) => f.key === "billet"));
});

test("a chave de uma desativada continua VÁLIDA para um pagamento antigo", async () => {
  // Desativar tira do seletor, não invalida o passado. Recusar aqui impediria de
  // corrigir a observação de um pagamento em boleto depois de o boleto sair de
  // uso.
  const { modelo, dados } = monta();
  await modelo.list();
  await modelo.update(dados.find((f) => f.key === "billet")._id, { active: 0 });

  assert.ok((await modelo.keys()).includes("billet"));
});

test("as sete originais não se apagam", async () => {
  const { modelo, dados } = monta();
  await modelo.list();

  const feito = await modelo.delete(dados.find((f) => f.key === "pix")._id);

  assert.deepEqual(feito, { erro: "system" });
  assert.ok((await modelo.list()).some((f) => f.key === "pix"));
});

test("forma JÁ USADA não se apaga — o pagamento ficaria sem explicação", async () => {
  const { modelo, dados, usarEmPagamento } = monta();
  await modelo.list();
  await modelo.insert({ name: "Cheque" });
  usarEmPagamento();

  const cheque = dados.find((f) => f.key === "cheque");
  assert.deepEqual(await modelo.delete(cheque._id), { erro: "inUse" });
});

test("forma criada e nunca usada some quando se manda", async () => {
  const { modelo, dados } = monta();
  await modelo.list();
  await modelo.insert({ name: "Cheque" });

  const cheque = dados.find((f) => f.key === "cheque");
  assert.equal(await modelo.delete(cheque._id), true);
  assert.ok(!(await modelo.list()).some((f) => f.key === "cheque"));
});

test("a ordem vai inteira de uma vez", async () => {
  // Uma chamada por item deixaria a lista meio reordenada se a segunda falhasse
  // — e "meio reordenada" é um estado que ninguém conserta olhando a tela.
  const { modelo, dados } = monta();
  await modelo.list();

  const invertida = [...dados].reverse().map((f) => f._id);
  await modelo.reorder(invertida);

  const lista = await modelo.list();
  assert.deepEqual(lista.map((f) => f.key), [...AS_SETE].reverse());
});

test("reordenar com lixo não mexe na lista", async () => {
  const { modelo } = monta();
  await modelo.list();

  assert.equal(await modelo.reorder("pix,cash"), false);
  assert.equal(await modelo.reorder([]), false);
});
