const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Lead_model = require("../../model/Lead_model.js");
const funil = require("../../lib/funilDeLeads.js");

// O FUNIL, por dentro — e ele mora na MESMA coleção das pessoas.
//
// *"agente só muda uma chave false ou true, e pronto, todos os dados já
// aparecem em aluno sem ter que copiar nada de um lugar para o outro"*
// (01/10/2026).
//
// O que estes casos guardam é exatamente o preço dessa escolha: numa coleção
// compartilhada, esquecer o `type` uma vez é devolver aluno na lista de leads —
// ou, pior, apagar a ficha de um.
const ID = "64b000000000000000000001";
const TRAINER = "64b0000000000000000000ff";

function monta({ existente, docs = [] } = {}) {
  const visto = { filtros: [] };

  const col = {
    aggregate(pipeline) {
      visto.pipeline = pipeline;
      return {
        async toArray() {
          return [{ rows: docs, total: [{ n: docs.length }], porEtapa: [] }];
        },
      };
    },
    async insertOne(doc) {
      visto.inserido = doc;
      return { insertedId: new ObjectId(ID) };
    },
    async findOne(filtro) {
      visto.filtros.push(filtro);
      return existente;
    },
    async updateOne(filtro, mudanca) {
      visto.filtros.push(filtro);
      visto.atualizado = mudanca.$set;
      return { matchedCount: existente ? 1 : 0 };
    },
    async deleteOne(filtro) {
      visto.filtros.push(filtro);
      return { deletedCount: 1 };
    },
  };

  const app = {
    mongodb: { async connectToServer() { return { collection: (n) => ((visto.colecao = n), col) }; } },
    api: {
      role: { clientName: "Cliente", async dataByName() { return { _id: new ObjectId(TRAINER) }; } },
      link: {
        async link(trainerId, personId, origem) {
          visto.vinculo = { trainerId: String(trainerId), personId: String(personId), origem };
        },
        async setNotes(trainerId, personId, texto) {
          visto.notas = { trainerId: String(trainerId), personId: String(personId), texto };
        },
      },
    },
  };

  return { modelo: new Lead_model(app), visto };
}

function matches(pipeline) {
  return pipeline.filter((e) => e.$match).map((e) => e.$match);
}

test("os leads moram em `users`, e não numa coleção própria", async () => {
  const { modelo, visto } = monta();
  await modelo.pagina({});
  assert.equal(visto.colecao, "users");
});

test("TODO filtro carrega o tipo — é o que separa lead de aluno na mesma coleção", async () => {
  const { modelo, visto } = monta();
  await modelo.pagina({});

  // E na PRIMEIRA etapa: por correção e porque é o índice que o banco usa.
  assert.deepEqual(matches(visto.pipeline)[0], { type: "lead" });
});

test("apagar exige o tipo — senão um id de ALUNO apagaria a ficha dele", async () => {
  // É o filtro mais importante do modelo: a rota recebe um id de fora.
  const { modelo, visto } = monta({ existente: { _id: new ObjectId(ID) } });
  await modelo.remove(ID);

  assert.equal(visto.filtros.at(-1).type, "lead");
});

test("buscar e editar também só alcançam leads", async () => {
  const { modelo, visto } = monta({ existente: { _id: new ObjectId(ID), name: "Ana" } });

  await modelo.data(ID);
  assert.equal(visto.filtros.at(-1).type, "lead");

  await modelo.update(ID, { etapa: "contato" });
  for (const f of visto.filtros) assert.equal(f.type, "lead");
});

test("busca por palavra NÃO vira busca por telefone vazia", async () => {
  // A armadilha: `digitos("ana")` é string vazia, e `{ $regex: "" }` casa com
  // TODOS os documentos — a busca devolveria a base inteira, calada.
  const { modelo, visto } = monta();
  await modelo.pagina({ busca: "ana" });

  const ors = matches(visto.pipeline).find((m) => m.$or)?.$or || [];
  assert.equal(ors.filter((c) => c["lead.phoneSort"]).length, 0);
});

test("busca por número procura só os dígitos, sem a pontuação", async () => {
  const { modelo, visto } = monta();
  await modelo.pagina({ busca: "(21) 98682-5831" });

  const ors = matches(visto.pipeline).find((m) => m.$or)?.$or || [];
  assert.equal(ors.find((c) => c["lead.phoneSort"])["lead.phoneSort"].$regex, "21986825831");
});

test("a busca por nome ignora acento", async () => {
  const { modelo, visto } = monta();
  await modelo.pagina({ busca: "Jéssica" });

  const ors = matches(visto.pipeline).find((m) => m.$or)?.$or || [];
  assert.equal(ors.find((c) => c["lead.nameSort"])["lead.nameSort"].$regex, "jessica");
});

test("etapa que não existe no catálogo não vira filtro", async () => {
  const { modelo, visto } = monta();
  await modelo.pagina({ etapas: "novo,inventada" });

  assert.deepEqual(matches(visto.pipeline).find((m) => m["lead.etapa"])["lead.etapa"].$in, ["novo"]);
});

test("e-mail vazio vira null, e não string — o índice único exige", async () => {
  // O índice é parcial (`$type: "string"`): ausência não colide com ausência,
  // `""` colidiria, e o SEGUNDO lead sem e-mail seria recusado pelo banco.
  const { modelo, visto } = monta();
  await modelo.insert({ name: "Ana", email: "   " });
  assert.equal(visto.inserido.email, null);
});

test("o funil fica aninhado em `lead`, longe dos campos da pessoa", async () => {
  const { modelo, visto } = monta();
  await modelo.insert({ name: "Ana", phone: "21999998888", origem: "instagram", interesse: "emagrecer" });

  assert.equal(visto.inserido.type, "lead");
  assert.equal(visto.inserido.name, "Ana");
  assert.equal(visto.inserido.phone, "21999998888");
  assert.equal(visto.inserido.lead.origem, "instagram");
  assert.equal(visto.inserido.lead.interesse, "emagrecer");
});

test("origem e etapa desconhecidas caem no padrão, e não em vazio", async () => {
  const { modelo, visto } = monta();
  await modelo.insert({ name: "Ana", origem: "tiktok", etapa: "sei la" });

  assert.equal(visto.inserido.lead.origem, funil.ORIGEM_PADRAO);
  assert.equal(visto.inserido.lead.etapa, funil.ETAPA_PADRAO);
});

test("data inválida vira null, e não `Invalid Date`", async () => {
  const { modelo, visto } = monta();
  await modelo.insert({ name: "Ana", nextContactAt: "amanhã" });
  assert.equal(visto.inserido.lead.nextContactAt, null);
});

test("editar um campo do funil não apaga os outros", async () => {
  // `{ lead: {...} }` inteiro substituiria o objeto e levaria origem e
  // interesse junto. O caminho com ponto muda um campo só.
  const { modelo, visto } = monta({
    existente: { _id: new ObjectId(ID), name: "Ana", lead: { origem: "instagram" } },
  });

  await modelo.update(ID, { etapa: "contato" });
  assert.equal(visto.atualizado["lead.etapa"], "contato");
  assert.equal(visto.atualizado.lead, undefined);
});

test("mudar só um telefone reescreve o par, lendo o outro do que já está salvo", async () => {
  const { modelo, visto } = monta({
    existente: { _id: new ObjectId(ID), name: "Ana", phone: "21111111111", lead: { whatsapp: "21222222222" } },
  });

  await modelo.update(ID, { whatsapp: "(21) 93333-3333" });
  assert.equal(visto.atualizado["lead.phoneSort"], "21111111111 21933333333");
});

// ── CONVERTER ────────────────────────────────────────────────────────────
test("converter troca o tipo e NÃO move o documento — o _id é o mesmo", async () => {
  const existente = { _id: new ObjectId(ID), name: "Ana", lead: { origem: "instagram" } };
  const { modelo, visto } = monta({ existente });

  const id = await modelo.converter(ID, TRAINER);

  assert.equal(String(id), ID, "o id mudou — era o ponto inteiro de não copiar");
  assert.equal(visto.atualizado.type, "student");
  assert.equal(visto.atualizado.active, 1);
});

test("converter cria o VÍNCULO — é ele que põe a pessoa na lista, não o tipo", async () => {
  const { modelo, visto } = monta({ existente: { _id: new ObjectId(ID), name: "Ana", lead: {} } });

  await modelo.converter(ID, TRAINER);
  assert.deepEqual(visto.vinculo, { trainerId: TRAINER, personId: ID, origem: "created" });
});

test("a origem SOBREVIVE à conversão — é o que responde 'o anúncio me trouxe quantos?'", async () => {
  const { modelo, visto } = monta({
    existente: { _id: new ObjectId(ID), name: "Ana", lead: { origem: "anuncio" } },
  });

  await modelo.converter(ID, TRAINER);

  // Nada no `$set` toca a origem; só a etapa e o carimbo de quando virou.
  assert.equal(visto.atualizado["lead.origem"], undefined);
  assert.equal(visto.atualizado["lead.etapa"], "convertido");
  assert.ok(visto.atualizado["lead.convertedAt"] instanceof Date);
});

test("converter duas vezes não cria dois vínculos", async () => {
  // Dois cliques no mesmo botão: o segundo não acha mais o documento como lead.
  const { modelo, visto } = monta({ existente: null });
  assert.equal(await modelo.converter(ID, TRAINER), null);
  assert.equal(visto.vinculo, undefined);
});

test("pedir 'convertido' alcança quem JÁ virou aluno — senão o filtro é morto", async () => {
  // Converter troca o tipo, então quem virou aluno sai do funil. Sem isto, a
  // etapa "convertido" seria um filtro que nunca devolve nada — e a pessoa
  // concluiria que o sistema perdeu os dados dela.
  const { modelo, visto } = monta();
  await modelo.pagina({ etapas: "convertido" });

  const primeiro = matches(visto.pipeline)[0];
  assert.ok(primeiro.$or, "o recorte continuou preso a type: lead");
  assert.deepEqual(primeiro.$or[1], { type: "student", "lead.convertedAt": { $exists: true } });
});

test("na fila do dia a dia, quem converteu NÃO aparece", async () => {
  // Quem converteu não é trabalho pendente.
  const { modelo, visto } = monta();
  await modelo.pagina({ etapas: "novo,contato" });

  assert.deepEqual(matches(visto.pipeline)[0], { type: "lead" });
});

test("converter leva o WhatsApp para o telefone quando não há telefone", async () => {
  // A ficha de pessoa tem UM telefone; o lead tem dois. Quem preencheu só o
  // WhatsApp virava aluno sem telefone nenhum — achado convertendo de verdade.
  const { modelo, visto } = monta({
    existente: { _id: new ObjectId(ID), name: "Ana", phone: "", lead: { whatsapp: "21911112222" } },
  });

  await modelo.converter(ID, TRAINER);
  assert.equal(visto.atualizado.phone, "21911112222");
});

test("mas não sobrescreve o telefone que já existe", async () => {
  const { modelo, visto } = monta({
    existente: { _id: new ObjectId(ID), name: "Ana", phone: "2133334444", lead: { whatsapp: "21911112222" } },
  });

  await modelo.converter(ID, TRAINER);
  assert.equal(visto.atualizado.phone, "2133334444");
});

// ── OS MESMOS CAMPOS DA FICHA ────────────────────────────────────────────
//
// *"todos os campos que já tem em alunos"* (01/10/2026). O que se guarda aqui
// é a PARIDADE: um campo com nome diferente teria de ser copiado — ou
// redigitado — no dia da conversão.
test("o lead guarda os campos da ficha com os MESMOS nomes", async () => {
  const { modelo, visto } = monta();
  await modelo.insert({
    name: "Ana",
    birthDate: "1990-05-02",
    sex: "female",
    goal: "emagrecer",
    weight: "72.5",
    height: "165",
  });

  // No topo do documento, e não dentro de `lead`: é o que a ficha de pessoa lê.
  assert.equal(visto.inserido.birthDate, "1990-05-02");
  assert.equal(visto.inserido.sex, "female");
  assert.equal(visto.inserido.goal, "emagrecer");
  assert.equal(visto.inserido.weight, 72.5);
  assert.equal(visto.inserido.height, 165);
});

test("sexo inventado não é gravado", async () => {
  const { modelo, visto } = monta();
  await modelo.insert({ name: "Ana", sex: "qualquer" });
  assert.equal(visto.inserido.sex, "");
});

test("peso vazio é null, e não zero — zero é um peso", async () => {
  // Um lead sem peso informado apareceria pesando nada no dia em que virasse
  // ficha.
  const { modelo, visto } = monta();
  await modelo.insert({ name: "Ana", weight: "", height: undefined });
  assert.equal(visto.inserido.weight, null);
  assert.equal(visto.inserido.height, null);
});

test("converter leva a observação do funil para o VÍNCULO", async () => {
  // Ela muda de lugar porque muda de dono: no lead é do funil; na pessoa,
  // "minhas observações" moram no vínculo.
  const { modelo, visto } = monta({
    existente: { _id: new ObjectId(ID), name: "Ana", lead: { note: "ligou duas vezes" } },
  });

  await modelo.converter(ID, TRAINER);
  assert.deepEqual(visto.notas, { trainerId: TRAINER, personId: ID, texto: "ligou duas vezes" });
});

test("sem observação, nada é escrito no vínculo", async () => {
  const { modelo, visto } = monta({ existente: { _id: new ObjectId(ID), name: "Ana", lead: {} } });
  await modelo.converter(ID, TRAINER);
  assert.equal(visto.notas, undefined);
});

test("a lista já devolve a linha no formato da tela, com o funil no topo", async () => {
  // `paraTela` NÃO é idempotente: aplicada duas vezes, ela procura `lead` num
  // objeto que já foi achatado e devolve os padrões. Foi o que aconteceu —
  // origem e observação sumiam só na LISTA, enquanto o lead avulso vinha certo.
  const { modelo } = monta({
    docs: [
      {
        _id: new ObjectId(ID),
        name: "Ana",
        lead: { origem: "anuncio", note: "ligou duas vezes", interesse: "emagrecer" },
      },
    ],
  });

  const r = await modelo.pagina({});

  assert.equal(r.rows[0].origem, "anuncio");
  assert.equal(r.rows[0].note, "ligou duas vezes");
  assert.equal(r.rows[0].interesse, "emagrecer");
  assert.equal(r.rows[0].lead, undefined, "a linha ainda carrega o objeto aninhado");
});
