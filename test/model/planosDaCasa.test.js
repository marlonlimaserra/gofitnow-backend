const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Membership_model = require("../../model/Membership_model.js");
const MembershipBenefit_model = require("../../model/MembershipBenefit_model.js");

// OS PLANOS QUE A ACADEMIA VENDE, e as linhas que os comparam.
//
// *"como pretendo oferecer para academias, ai eu crio a recorrencia com um
// plano"* e *"dentro de planos crie uma aba categoria de plano, pode colar
// essas coisas ai de sim ou nao"*.
//
// `membership` e não `plan`: "plano" neste servidor já é o do PRODUTO, o que
// nós vendemos para a academia. Eu escrevi `controllers/Plan.js` por cima do
// que existia antes de perceber — os testes do checkout acusaram.

const A = new ObjectId("6a7f8e18ac5f3b34bb4e4a01");
const B = new ObjectId("6a7f8e18ac5f3b34bb4e4a02");

function colecaoFalsa(docs = []) {
  const escritas = [];
  return {
    docs,
    escritas,
    find: () => ({ sort: () => ({ toArray: async () => docs }) }),
    findOne: async (f) => docs.find((d) => String(d._id) === String(f._id)) || null,
    countDocuments: async (f) => {
      if (!f || !Object.keys(f).length) return docs.length;
      escritas.push({ contar: f });
      return docs.filter((d) => String(d.beneficios?.[0] || d.membership || "") === String(Object.values(f)[0])).length;
    },
    insertOne: async (doc) => {
      escritas.push({ inserir: doc });
      return { insertedId: A };
    },
    updateOne: async (f, op) => {
      escritas.push({ atualizar: op.$set, onde: f });
      return { matchedCount: 1 };
    },
    updateMany: async (f, op) => {
      escritas.push({ atualizarVarios: op.$set, onde: f });
      return { matchedCount: 1 };
    },
    deleteOne: async () => ({ deletedCount: 1 }),
  };
}

function montarPlano({ planos = [], recorrencias = [] } = {}) {
  const col = colecaoFalsa(planos);
  const recs = colecaoFalsa(recorrencias);
  const faxina = [];

  const model = new Membership_model({
    api: {
      recurrence: { collection: async () => recs },
      // A FAXINA DE CAPAS roda em toda gravação. O dobro registra o que ela
      // mandaria manter — é o que permite afirmar que uma edição que não
      // menciona a capa não apaga a que já existe.
      membershipImage: {
        async pruneUnused(id, emUso) {
          faxina.push({ id: String(id), emUso });
          return 0;
        },
        async removeAllOf(id) {
          faxina.push({ apagouTudo: String(id) });
          return 0;
        },
      },
    },
  });
  model.collection = async () => col;

  return { model, col, recs, faxina };
}

test("o plano guarda IDS de benefício, sem repetir e sem lixo", async () => {
  // A lista chega do formulário e pode vir com o mesmo id duas vezes (dois
  // cliques) ou com texto que não é id nenhum. Guardar os dois faria a tabela
  // desenhar a mesma linha duas vezes.
  const { model, col } = montarPlano();

  await model.insert({
    name: "Black",
    amount: 15990,
    beneficios: [String(A), String(A), "não é id", String(B), null],
  });

  const doc = col.escritas.find((e) => e.inserir).inserir;
  assert.equal(doc.beneficios.length, 2);
  assert.deepEqual(doc.beneficios.map(String), [String(A), String(B)]);
});

test("só UM destaque por conta — o novo tira o dos outros", async () => {
  // Na vitrine ele é o cartão amarelo, o "Mais vantajoso". Dois gritando ao
  // mesmo tempo não destacam nada, e a tela não saberia qual desenhar em cima.
  const { model, col } = montarPlano();

  await model.insert({ name: "Black", destaque: true });

  const limpeza = col.escritas.find((e) => e.atualizarVarios);
  assert.ok(limpeza, "os outros precisam ser desmarcados");
  assert.deepEqual(limpeza.atualizarVarios, { destaque: false });
  assert.equal(limpeza.onde.destaque, true, "só mexe em quem estava destacado");
});

test("editar MESCLA — o que a chamada não menciona, ela não toca", async () => {
  // A lição que `updateCharge` custou caro: montar o documento inteiro a cada
  // escrita transforma um PUT parcial em apagamento silencioso.
  const { model, col } = montarPlano({ planos: [{ _id: A, name: "Black", amount: 15990 }] });

  await model.update(String(A), { active: false });

  const gravado = col.escritas.find((e) => e.atualizar).atualizar;
  // `rascunho: false` entra em toda gravação de propósito — é o que promove o
  // rascunho a plano. O que NÃO pode entrar é campo que a chamada não mencionou.
  assert.deepEqual(Object.keys(gravado).sort(), ["active", "rascunho", "updatedAt"]);
  assert.equal(gravado.amount, undefined, "o preço não pode ser zerado por tabela");
  assert.equal(gravado.name, undefined, "nem o nome");
});

test("apagar um plano que alguém assinou é RECUSADO, com o número", async () => {
  // A recorrência guarda o id dele como origem, e uma origem que aponta para o
  // nada é uma linha que ninguém explica meses depois. O NÚMERO vai junto: "não
  // dá" sem dizer quantos deixa a pessoa procurando onde.
  const { model } = montarPlano({
    planos: [{ _id: A, name: "Black" }],
    recorrencias: [{ _id: B, membership: A }],
  });

  const r = await model.remove(String(A));
  assert.equal(r.erro, "inUse");
  assert.equal(r.quantas, 1);
});

test("plano sem assinante nenhum apaga", async () => {
  const { model } = montarPlano({ planos: [{ _id: A, name: "Black" }] });
  assert.deepEqual(await model.remove(String(A)), { ok: true });
});

test("a fidelidade é número de MESES, contida em faixa sã", async () => {
  // Um dia ela vai decidir alguma coisa — quanto falta para cancelar sem multa.
  // "12 meses" escrito à mão não decide nada, e 9999 meses não é fidelidade.
  const { model, col } = montarPlano();

  await model.insert({ name: "Black", fidelidadeMeses: "12" });
  assert.equal(col.escritas.find((e) => e.inserir).inserir.fidelidadeMeses, 12);

  col.escritas.length = 0;
  await model.insert({ name: "X", fidelidadeMeses: -5 });
  assert.equal(col.escritas.find((e) => e.inserir).inserir.fidelidadeMeses, 0, "sem fidelidade");
});

// ── OS BENEFÍCIOS: as linhas da tabela ────────────────────────────────────

function montarBeneficio({ beneficios = [], planos = [] } = {}) {
  const col = colecaoFalsa(beneficios);
  const dosPlanos = colecaoFalsa(planos);

  const model = new MembershipBenefit_model({
    api: { membership: { collection: async () => dosPlanos } },
  });
  model.collection = async () => col;

  return { model, col };
}

test("benefício sem nome não entra", async () => {
  // Uma linha em branco na tabela de comparação é uma linha que ninguém
  // consegue responder sim nem não.
  const { model } = montarBeneficio();
  assert.equal(await model.insert({ name: "   " }), null);
});

test("apagar um benefício marcado em algum plano é RECUSADO", async () => {
  // Apagar mudaria calado o que três planos oferecem, e quem apagou não veria
  // nenhum deles.
  const { model } = montarBeneficio({
    beneficios: [{ _id: A, name: "Acesso a aulas coletivas" }],
    planos: [{ _id: B, beneficios: [A] }],
  });

  const r = await model.remove(String(A));
  assert.equal(r.erro, "inUse");
  assert.equal(r.quantos, 1);
});

test("a ordem é gravada inteira, de uma vez", async () => {
  // "Meio reordenada" é um estado que ninguém sabe consertar olhando a tela.
  const { model, col } = montarBeneficio();
  await model.reorder([String(B), String(A)]);

  const ordens = col.escritas.filter((e) => e.atualizar).map((e) => e.atualizar.order);
  assert.deepEqual(ordens, [0, 1]);
});

test("reordenar com lixo no meio não grava lixo", async () => {
  const { model, col } = montarBeneficio();
  await model.reorder([String(A), "não é id", String(B)]);

  assert.equal(col.escritas.filter((e) => e.atualizar).length, 2);
});


// ── CLONAR ────────────────────────────────────────────────────────────────

test("clonar copia o plano e nasce FORA DE VENDA", async () => {
  // *"bote um botão para clonar"*. Os planos de uma academia são quase o mesmo
  // plano — o "Fit" é o "Black" sem duas linhas.
  //
  // Fora de venda porque a cópia é rascunho: "Black (cópia)" na vitrine, com o
  // mesmo preço do Black, é o tipo de coisa que alguém publica sem querer e
  // descobre pelo cliente.
  const { model, col } = montarPlano({
    planos: [
      {
        _id: A,
        name: "Black",
        amount: 15990,
        cadencia: "monthly",
        fidelidadeMeses: 12,
        beneficios: [B],
        destaque: true,
        active: true,
        cover: B,
      },
    ],
  });

  await model.duplicate(String(A));
  const copia = col.escritas.find((e) => e.inserir).inserir;

  assert.equal(copia.name, "Black (cópia)");
  assert.equal(copia.amount, 15990);
  assert.equal(copia.fidelidadeMeses, 12);
  assert.deepEqual(copia.beneficios.map(String), [String(B)]);
  assert.equal(copia.active, false, "nasce fora de venda");
  // Destaque é único por conta: clonar o destacado tiraria o selo do original.
  assert.equal(copia.destaque, false);
});

test("a cópia NÃO leva a capa", async () => {
  // Duas linhas apontando para a MESMA imagem fariam a faxina de uma apagar a
  // foto da outra — o dono da verdade é cada plano.
  const { model, col } = montarPlano({
    planos: [{ _id: A, name: "Black", beneficios: [], cover: B }],
  });

  await model.duplicate(String(A));
  assert.equal(col.escritas.find((e) => e.inserir).inserir.cover, null);
});

test("clonar o que não existe devolve nada, e não um plano vazio", async () => {
  const { model } = montarPlano();
  assert.equal(await model.duplicate(String(A)), undefined);
});

// ── A CAPA ────────────────────────────────────────────────────────────────

test("a capa guarda o ID, mesmo quando a tela manda a URL inteira", async () => {
  // A tela manda de volta o endereço que recebeu do upload. Guardar a URL
  // prenderia o plano ao endereço do backend do dia em que a foto subiu.
  const { model, col } = montarPlano();

  await model.insert({ name: "Black", cover: `https://backend.exemplo/public/membership-image/marlon/${A}` });
  const doc = col.escritas.find((e) => e.inserir).inserir;

  assert.equal(String(doc.cover), String(A));
});

test("uma edição que não menciona a capa não apaga a que existe", async () => {
  // A faxina olha o que ficou GRAVADO, e não o que veio na chamada — é o mesmo
  // erro destrutivo do `updateCharge`, um andar abaixo.
  const { model, faxina } = montarPlano({ planos: [{ _id: A, name: "Black", cover: B }] });

  await model.update(String(A), { amount: 19990 });

  const ultima = faxina[faxina.length - 1];
  assert.deepEqual(ultima.emUso, [String(B)], "a capa gravada continua em uso");
});

test("apagar o plano apaga a capa junto", async () => {
  // Sem isto os bytes ficariam no bucket apontando para um plano que não
  // existe: nenhuma tela os alcançaria e nada os apagaria.
  const { model, faxina } = montarPlano({ planos: [{ _id: A, name: "Black" }] });

  await model.remove(String(A));
  assert.ok(faxina.some((f) => f.apagouTudo === String(A)));
});

// ── O RASCUNHO ────────────────────────────────────────────────────────────

test("o rascunho nasce vazio e FORA DE VENDA", async () => {
  // *"quando clicar em criar você já pode criar um rascunho, assim já deixa
  // enviar a foto"*. A capa pertence a um plano, e um plano que não existe não
  // tem id para ela.
  const { model, col } = montarPlano();

  await model.rascunho("BRL");
  const doc = col.escritas.find((e) => e.inserir).inserir;

  assert.equal(doc.name, "");
  assert.equal(doc.active, false, "nunca chega à vitrine");
  assert.equal(doc.rascunho, true);
  assert.equal(doc.cover, null);
});

test("gravar TIRA o carimbo de rascunho", async () => {
  // A partir daí ele é um plano como outro qualquer, e a faxina de abandonados
  // não pode mais alcançá-lo.
  const { model, col } = montarPlano({ planos: [{ _id: A, name: "", rascunho: true }] });

  await model.update(String(A), { name: "Black" });
  assert.equal(col.escritas.find((e) => e.atualizar).atualizar.rascunho, false);
});

test("a lista da tela não mostra rascunho", async () => {
  // Uma linha vazia no meio do cardápio é confusão sem ganho nenhum: quem
  // abandonou não vai procurá-la.
  const { model, col } = montarPlano();
  let filtro = null;
  col.find = (f) => {
    filtro = f;
    return { sort: () => ({ toArray: async () => [] }) };
  };

  await model.list();
  assert.deepEqual(filtro, { rascunho: { $ne: true } });
});

// ── O ÍCONE DO BENEFÍCIO ──────────────────────────────────────────────────

function montarBeneficioComIcone({ anterior = null, achado = undefined } = {}) {
  const iconify = require("../../lib/iconify.js");
  const originalBuscar = iconify.buscar;
  const buscas = [];

  iconify.buscar = async (nome) => {
    buscas.push(nome);
    if (achado !== undefined) return achado;
    return { nome, body: '<path d="M1 2"/>', caixa: "0 0 24 24" };
  };

  const col = colecaoFalsa(anterior ? [anterior] : []);
  col.findOne = async () => anterior;

  const model = new MembershipBenefit_model({ api: { membership: { collection: async () => colecaoFalsa() } } });
  model.collection = async () => col;

  return { model, col, buscas, restaurar: () => { iconify.buscar = originalBuscar; } };
}

test("escolher um ícone busca o DESENHO e guarda junto", async (t) => {
  // A vitrine abre dentro do site do cliente: um ícone que só aparece se um
  // terceiro responder é um buraco no cartão de venda dele. Por isso o SVG é
  // buscado uma vez, aqui, e guardado.
  const { model, col, buscas, restaurar } = montarBeneficioComIcone();
  t.after(restaurar);

  await model.insert({ name: "Chuveiro", icone: "mdi:shower" });

  assert.deepEqual(buscas, ["mdi:shower"]);
  const doc = col.escritas.find((e) => e.inserir).inserir;
  assert.equal(doc.iconeSvg, '<path d="M1 2"/>');
  assert.equal(doc.iconeCaixa, "0 0 24 24");
});

test("o MESMO ícone de antes não é buscado de novo", async (t) => {
  // É o caso de toda edição que mexe só no nome do benefício, e ele é o mais
  // comum: sem isto, renomear "Chuveiro" para "Chuveiros" iria à internet.
  const { model, buscas, restaurar } = montarBeneficioComIcone({
    anterior: { _id: A, icone: "mdi:shower", iconeSvg: '<path d="M1 2"/>' },
  });
  t.after(restaurar);

  await model.update(String(A), { name: "Chuveiros", icone: "mdi:shower" });
  assert.deepEqual(buscas, [], "nada a buscar");
});

test("tirar o ícone apaga o desenho junto", async (t) => {
  // Senão o cartão continuaria mostrando o de antes, e a pessoa acharia que o
  // "sem ícone" não funcionou.
  const { model, col, restaurar } = montarBeneficioComIcone({
    anterior: { _id: A, icone: "mdi:shower", iconeSvg: '<path d="M1 2"/>' },
  });
  t.after(restaurar);

  await model.update(String(A), { icone: "" });

  const gravado = col.escritas.find((e) => e.atualizar).atualizar;
  assert.equal(gravado.icone, "");
  assert.equal(gravado.iconeSvg, "");
});

test("busca que FALHA grava o benefício sem ícone, em vez de não gravar", async (t) => {
  // O nome do benefício é o conteúdo; o ícone é enfeite. Uma rede lenta não pode
  // impedir alguém de cadastrar.
  const { model, col, restaurar } = montarBeneficioComIcone({ achado: null });
  t.after(restaurar);

  await model.insert({ name: "Chuveiro", icone: "mdi:shower" });

  const doc = col.escritas.find((e) => e.inserir).inserir;
  assert.equal(doc.icone, "", "não guarda nome sem desenho — seriam dois estados para um");
  assert.equal(doc.iconeSvg, "");
});

test("o SVG NÃO entra pelo corpo do pedido", async (t) => {
  // Aceitá-lo seria aceitar markup arbitrário de quem controla o navegador — e
  // ele vai inline para uma página pública.
  const { model, col, restaurar } = montarBeneficioComIcone();
  t.after(restaurar);

  await model.insert({
    name: "Chuveiro",
    icone: "mdi:shower",
    iconeSvg: "<script>alert(1)</script>",
    iconeCaixa: "0 0 9 9",
  });

  const doc = col.escritas.find((e) => e.inserir).inserir;
  assert.equal(doc.iconeSvg, '<path d="M1 2"/>', "o que vale é o que o servidor buscou");
  assert.equal(doc.iconeCaixa, "0 0 24 24");
});
