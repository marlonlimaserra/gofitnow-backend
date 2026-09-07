const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Idea = require("../../model/Idea_model.js");

// AS IDEIAS, do lado de quem sugere.
//
// O outro lado (estado, resposta oficial, apagar) mora no center-backend e tem
// os testes dele. Aqui o que precisa de guarda é o que só existe deste lado:
//
//   o TETO POR DIA, que é a única barreira contra um script abrindo mil ideias
//   e enterrando as de todo mundo;
//   e o que NÃO PODE VAZAR na resposta — a instância de quem sugeriu.

function colecao(docs = []) {
  const casa = (d, q) =>
    Object.entries(q).every(([k, v]) => {
      // `$or` é a busca em título OU detalhes. Ele não é um campo, é um ramo do
      // filtro — e sem este caso o dublê o trataria como campo chamado "$or".
      if (k === "$or") return v.some((sub) => casa(d, sub));
      if (v && typeof v === "object" && v.$in) {
        return v.$in.some((x) => String(x) === String(d[k]));
      }
      if (v && typeof v === "object" && v.$gte) return new Date(d[k]) >= v.$gte;
      // `{ apagado: { $ne: true } }` — o filtro que tira os apagados da conta.
      // Sem ele o dublê contava tudo, e o teste do contador reprovava código
      // correto. Operador que o dublê não conhece tem de ser ERRO, e não um
      // "casa com qualquer coisa" silencioso.
      if (v && typeof v === "object" && "$ne" in v) return d[k] !== v.$ne;
      // `$regex` é a busca. O dublê a aplica de verdade — é o que faz o teste do
      // parêntese escapado medir o ESCAPE, e não a tolerância do dublê.
      if (v && typeof v === "object" && v.$regex) {
        return new RegExp(v.$regex, v.$options || "").test(String(d[k] ?? ""));
      }
      if (v && typeof v === "object" && !(v instanceof Date) && !ObjectId.isValid(v)) {
        throw new Error("operador não previsto no dublê: " + JSON.stringify(v));
      }
      if (k.includes(".")) {
        const valor = k.split(".").reduce((o, p) => (o == null ? o : o[p]), d);
        return String(valor) === String(v);
      }
      return String(d[k]) === String(v);
    });

  const col = {
    docs,
    async insertOne(doc) {
      const _id = new ObjectId();
      docs.push({ ...doc, _id });
      return { insertedId: _id };
    },
    async findOne(q, opts = {}) {
      const doc = docs.find((d) => casa(d, q));
      return doc ? projetar(doc, opts.projection) : null;
    },
    async deleteOne(q) {
      const i = docs.findIndex((d) => casa(d, q));
      if (i < 0) return { deletedCount: 0 };
      docs.splice(i, 1);
      return { deletedCount: 1 };
    },
    async countDocuments(q = {}) {
      return docs.filter((d) => casa(d, q)).length;
    },
    async updateOne(q, upd, opts = {}) {
      const doc = docs.find((d) => casa(d, q));
      if (doc) {
        Object.assign(doc, upd.$set || {});
        return { matchedCount: 1 };
      }
      if (opts.upsert) {
        docs.push({ ...(upd.$set || {}), _id: new ObjectId() });
        return { matchedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0 };
    },
    find(q = {}, opts = {}) {
      let saida = docs.filter((d) => casa(d, q));
      let proj = opts.projection || null;
      const cadeia = {
        sort() {
          return cadeia;
        },
        limit() {
          return cadeia;
        },
        project(p) {
          proj = p;
          return cadeia;
        },
        async toArray() {
          return saida.map((d) => projetar(d, proj));
        },
      };
      return cadeia;
    },
  };

  return col;
}

// ── O DUBLÊ HONRA A PROJEÇÃO, e isto não é capricho ───────────────────────
//
// A primeira versão deste arquivo a ignorava, e o teste do vazamento de
// instância FALHOU por causa do dublê, não do código — ele devolvia o documento
// inteiro onde o Mongo devolveria três campos.
//
// Um dublê que ignora projeção mente nas duas direções: reprova código correto
// (foi o que aconteceu) e, pior, aprovaria um `find` que perdesse a projeção num
// refactor — que é exatamente o vazamento que o teste existe para pegar.
function projetar(doc, proj) {
  if (!proj) return doc;

  const inclui = Object.entries(proj).filter(([, v]) => v);
  if (!inclui.length) return doc;

  // `_id` volta sempre, a não ser que se peça para excluir — é o comportamento
  // do Mongo, e um dublê que o omitisse quebraria toda comparação por id.
  const saida = proj._id === 0 ? {} : { _id: doc._id };

  for (const [caminho] of inclui) {
    if (caminho === "_id") continue;

    const partes = caminho.split(".");
    const valor = partes.reduce((o, k) => (o == null ? o : o[k]), doc);
    if (valor === undefined) continue;

    // Caminho com ponto ("autor.nome") reconstrói o galho, e SÓ o galho pedido:
    // é o que faz `autor.instance` ficar de fora.
    let alvo = saida;
    for (const k of partes.slice(0, -1)) {
      alvo[k] = alvo[k] || {};
      alvo = alvo[k];
    }
    alvo[partes[partes.length - 1]] = valor;
  }

  return saida;
}

function monta() {
  const posts = colecao();
  const votos = colecao();
  const comentarios = colecao();

  // ── AS TRÊS COLLECTIONS SÃO TRÊS, E ISSO ME PEGOU ──────────────────────
  //
  // A primeira versão era `nome === "idea_posts" ? posts : votos` — ou seja,
  // `idea_comments` caía na collection de VOTOS. O voto que nasce junto com a
  // ideia passou a contar como comentário, e o contador respondia 2 onde o fio
  // tinha 1 documento.
  //
  // Um dublê que junta duas collections numa não é um atalho: é um teste que
  // mede outra coisa. Aqui ele reprovou código correto; num caso um pouco
  // diferente teria aprovado código errado.
  const bancos = { idea_posts: posts, idea_votes: votos, idea_comments: comentarios };

  // `centralDb`, e não `connectToServer`: as ideias moram no banco CENTRAL, como
  // os chamados e a FAQ. Um dublê que respondesse pelo banco do cliente
  // esconderia justamente o defeito que importa aqui.
  const model = new Idea({
    mongodb: {
      async centralDb() {
        return {
          collection: (nome) => {
            const col = bancos[nome];
            // Estourar, e não devolver uma collection qualquer: é o que faz um
            // nome novo aparecer como erro em vez de virar dado no lugar errado.
            if (!col) throw new Error("collection não prevista no dublê: " + nome);
            return col;
          },
        };
      },
    },
  });

  return { model, posts, votos, comentarios };
}

const EU = { instance: "marlon", userId: "u1", nome: "Marlon" };
const COLEGA = { instance: "marlon", userId: "u2", nome: "Professor" };

test("o teto por dia barra a décima primeira", async () => {
  // O quadro é público a TODOS os clientes: uma pessoa com um script abriria mil
  // ideias e enterraria as de todo mundo. O estrago não é o banco — é o quadro
  // deixar de servir para priorizar.
  const { model } = monta();

  for (let i = 0; i < Idea.POR_DIA; i += 1) {
    const r = await model.criar({ titulo: "Ideia número " + i }, EU);
    assert.equal(r.ok, true, "a " + i + "ª deveria passar");
  }

  const demais = await model.criar({ titulo: "A décima primeira" }, EU);
  assert.equal(demais.ok, false);
  assert.equal(demais.erro, "muitas_hoje");
});

test("o teto é por PESSOA, e não por cliente", async () => {
  // Uma academia com seis professores tem seis pessoas com ideias. Somar todos
  // faria a sexta não poder escrever a dela por causa das do primeiro.
  const { model } = monta();

  for (let i = 0; i < Idea.POR_DIA; i += 1) {
    await model.criar({ titulo: "Ideia do dono " + i }, EU);
  }

  const doColega = await model.criar({ titulo: "A ideia do professor" }, COLEGA);
  assert.equal(doColega.ok, true, "o colega não paga pelo teto do dono");
});

test("o de ONTEM não conta — é teto por dia, não total", async () => {
  // Quem tem dez ideias boas em dois meses deve poder escrever todas.
  const { model, posts } = monta();

  for (let i = 0; i < Idea.POR_DIA; i += 1) {
    await model.criar({ titulo: "Ideia antiga " + i }, EU);
  }
  // Envelhece as dez em dois dias.
  const doisDias = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  posts.docs.forEach((d) => {
    d.criadoEm = doisDias;
  });

  const hoje = await model.criar({ titulo: "A ideia de hoje" }, EU);
  assert.equal(hoje.ok, true);
});

test("a ideia nasce com o voto de quem a escreveu", async () => {
  const { model, posts, votos } = monta();
  const r = await model.criar({ titulo: "Duplicar uma dieta inteira" }, EU);

  assert.equal(r.ok, true);
  assert.equal(posts.docs[0].votos, 1);
  assert.equal(posts.docs[0].status, "aberta");
  assert.equal(votos.docs[0].instance, "marlon");
});

test("A INSTÂNCIA NÃO VOLTA NA LISTA — só o nome", async () => {
  // Ela é o que separa um cliente do outro no central. Mandá-la ao produto
  // contaria a um cliente quem são os outros clientes.
  //
  // A projeção é o que garante isso, e projeção é fácil de perder num refactor:
  // um `find(filtro)` sem o segundo argumento devolveria o documento inteiro, e
  // nada na tela mudaria — o vazamento seria só no JSON.
  const { model } = monta();
  await model.criar({ titulo: "Duplicar uma dieta" }, EU);

  const rows = await model.listar(EU);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].autor.nome, "Marlon");
  assert.equal(
    JSON.stringify(rows).includes("marlon"),
    false,
    "a instância vazou na resposta da lista"
  );
});

test("o voto alterna, e o de outra pessoa soma", async () => {
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);

  const doColega = await model.alternarVoto(id, COLEGA);
  assert.equal(doColega.votos, 2);

  const tirei = await model.alternarVoto(id, EU);
  assert.equal(tirei.votei, false);
  assert.equal(tirei.votos, 1);
});

test("a lista FALHA ABERTA em vazio quando o central não responde", async () => {
  // A tela de ajuda é onde a pessoa vai justamente quando algo está fora do ar.
  // Um erro do central ali viraria uma página de erro em cima de um problema.
  const model = new Idea({
    mongodb: {
      async centralDb() {
        throw new Error("central fora do ar");
      },
    },
  });

  assert.deepEqual(await model.listar(EU), []);
  assert.equal(await model.data(String(new ObjectId()), EU), null);
});

test("título curto é recusado, e sem instância também", async () => {
  const { model } = monta();
  assert.equal((await model.criar({ titulo: "abc" }, EU)).erro, "sem_titulo");
  assert.equal((await model.criar({ titulo: "Uma boa ideia" }, {})).erro, "sem_autor");
});

// ── OS COMENTÁRIOS ─────────────────────────────────────────────────────────
//
// *"Quero que as pessoas comentem etc."*
//
// A regra que mais dói se quebrar é a de apagar: o dono está no FILTRO do banco,
// e não numa conferência antes do delete. Um `findOne` + `if` + `delete` tem uma
// janela entre a checagem e a ação, e deixa a decisão a três linhas de distância
// de quem a executa — é assim que um refactor apaga a checagem sem apagar o
// delete.

test("comentar guarda o texto, marca como NÃO oficial e soma no contador", async () => {
  const { model, posts } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);

  const r = await model.comentar(id, "  Isso me pouparia meia hora.  ", EU);

  assert.equal(r.ok, true);
  assert.equal(r.fio.length, 1);
  assert.equal(r.fio[0].texto, "Isso me pouparia meia hora.", "o texto é aparado");
  assert.equal(r.fio[0].oficial, false, "oficial é gravado FALSO, e não omitido");
  assert.equal(r.fio[0].nome, "Marlon");
  assert.equal(r.comentarios, 1);
  assert.equal(posts.docs[0].comentarios, 1, "o contador fica no post, para a lista");
});

test("comentário vazio é recusado, inclusive só com espaços", async () => {
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);

  for (const vazio of ["", "   ", "\n\n"]) {
    const r = await model.comentar(id, vazio, EU);
    assert.equal(r.erro, "sem_texto", JSON.stringify(vazio));
  }
});

test("comentar em ideia que não existe dá 'não encontrado', e não cria nada", async () => {
  const { model, votos } = monta();
  const r = await model.comentar(String(new ObjectId()), "oi", EU);
  assert.equal(r.erro, "nao_encontrado");
  assert.equal(votos.docs.length, 0);
});

test("o `meu` diz quem pode apagar — e é por PESSOA, não por cliente", async () => {
  // A tela não tem o id de quem está logado (a sessão é um cabeçalho), então
  // quem decide o que é "meu" é o servidor. Sem isso, ou ninguém veria a
  // lixeira, ou todos a veriam em tudo.
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);
  await model.comentar(id, "eu escrevi", EU);
  await model.comentar(id, "o colega escreveu", COLEGA);

  const paraMim = await model.comentariosDe(id, EU);
  assert.deepEqual(
    paraMim.map((c) => c.meu),
    [true, false]
  );

  const paraOColega = await model.comentariosDe(id, COLEGA);
  assert.deepEqual(
    paraOColega.map((c) => c.meu),
    [false, true]
  );
});

test("NÃO DÁ PARA APAGAR O COMENTÁRIO DE OUTRA PESSOA", async () => {
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);
  await model.comentar(id, "o colega escreveu", COLEGA);

  const doColega = (await model.comentariosDe(id, COLEGA))[0];

  const tentativa = await model.apagarComentario(String(doColega._id), EU);
  assert.equal(tentativa.ok, false);
  // O mesmo erro de "não existe", de propósito: dizer "existe, mas não é seu"
  // conta a quem tentou que aquele id é de alguém.
  assert.equal(tentativa.erro, "nao_encontrado");

  assert.equal((await model.comentariosDe(id, COLEGA)).length, 1, "o comentário continua lá");
});

test("apagar o próprio funciona e baixa o contador", async () => {
  const { model, posts } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);
  await model.comentar(id, "primeiro", EU);
  await model.comentar(id, "segundo", EU);
  assert.equal(posts.docs[0].comentarios, 2);

  const meu = (await model.comentariosDe(id, EU))[0];
  const r = await model.apagarComentario(String(meu._id), EU);

  assert.equal(r.ok, true);
  assert.equal(r.comentarios, 1);
  assert.equal(posts.docs[0].comentarios, 1);
  assert.equal(r.fio.length, 1);
  assert.equal(r.fio[0].texto, "segundo");
});

test("o teto de comentários por dia barra, e é por pessoa", async () => {
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);

  for (let i = 0; i < Idea.COMENTARIOS_POR_DIA; i += 1) {
    const r = await model.comentar(id, "comentário " + i, EU);
    assert.equal(r.ok, true, "o " + i + "º deveria passar");
  }

  const demais = await model.comentar(id, "um a mais", EU);
  assert.equal(demais.erro, "muitos_hoje");

  // O colega não paga pelo teto de quem falou demais.
  const doColega = await model.comentar(id, "eu também acho", COLEGA);
  assert.equal(doColega.ok, true);
});

test("O userId E A INSTÂNCIA NÃO SAEM no fio — só nome, texto e as marcas", async () => {
  // Mesmo princípio da lista de ideias: a instância é o que separa um cliente do
  // outro no central, e mandá-la contaria a um cliente quem são os outros.
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);
  await model.comentar(id, "oi", EU);

  const fio = await model.comentariosDe(id, EU);
  const json = JSON.stringify(fio);

  assert.equal(json.includes("marlon"), false, "a instância vazou no fio");
  assert.equal(json.includes("u1"), false, "o userId vazou no fio");
  assert.deepEqual(Object.keys(fio[0]).sort(), [
    "_id",
    "apagado",
    "criadoEm",
    "meu",
    "nome",
    "oficial",
    "pai",
    "texto",
  ]);
});

test("o fio vem na ideia aberta como `fio`, e o contador continua número", async () => {
  // O MESMO nome nos dois lugares fazia `idea.comentarios` ser 3 na lista e um
  // array no detalhe. A tela mistura os dois, e o contador mostraria
  // `[object Object]` — sem erro em lugar nenhum.
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);
  await model.comentar(id, "oi", EU);

  const doc = await model.data(id, EU);
  assert.equal(Array.isArray(doc.fio), true);
  assert.equal(doc.comentarios, 1);
  assert.equal(typeof doc.comentarios, "number");
});

test("a lista traz o NÚMERO de comentários, e não o fio", async () => {
  const { model } = monta();
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, EU);
  await model.comentar(id, "oi", EU);

  const rows = await model.listar(EU);
  assert.equal(rows[0].comentarios, 1);
  assert.equal(rows[0].fio, undefined, "o fio na lista seriam centenas de documentos por tela");
});

// ── RESPONDER A UM COMENTÁRIO ──────────────────────────────────────────────
//
// *"Permita alguém responder embaixo também do meu comentário, ou eu responder
// meu próprio comentário."*
//
// Duas regras carregam este bloco, e as duas são invisíveis lendo a tela:
//
//   UM NÍVEL SÓ — responder a uma resposta anexa ao MESMO pai;
//   APAGAR O PAI NÃO APAGA AS RESPOSTAS — ele fica vazio, como lugar. Cascatear
//   daria a quem escreveu o pai o poder de apagar o texto de outras pessoas.

const primeiro = async (model, quem = EU) => {
  const { id } = await model.criar({ titulo: "Duplicar uma dieta" }, quem);
  await model.comentar(id, "o comentário de cima", quem);
  const fio = await model.comentariosDe(id, quem);
  return { id, pai: fio[0] };
};

test("responder guarda o `pai` e sai recuado na ordem", async () => {
  const { model } = monta();
  const { id, pai } = await primeiro(model);

  await model.comentar(id, "eu respondo", COLEGA, String(pai._id));

  const fio = await model.comentariosDe(id, EU);
  assert.equal(fio.length, 2);
  assert.equal(fio[0].pai, null, "o de cima é primeiro nível");
  assert.equal(fio[1].pai, String(pai._id), "a resposta aponta para ele");
  assert.equal(fio[1].texto, "eu respondo");
});

test("dá para responder ao PRÓPRIO comentário", async () => {
  // "…ou eu responder meu próprio comentário." Sem caso especial: é o que se faz
  // quando lembra de mais uma coisa, e proibir seria inventar regra para nada.
  const { model } = monta();
  const { id, pai } = await primeiro(model);

  const r = await model.comentar(id, "e mais uma coisa", EU, String(pai._id));

  assert.equal(r.ok, true);
  assert.equal(r.fio[1].pai, String(pai._id));
  assert.equal(r.fio[1].meu, true);
});

test("responder a uma RESPOSTA anexa ao mesmo pai — um nível só", async () => {
  // Não é limitação de banco: num diálogo de 600 px o terceiro recuo deixa a
  // quarta linha com espaço para três palavras.
  const { model } = monta();
  const { id, pai } = await primeiro(model);
  await model.comentar(id, "primeira resposta", COLEGA, String(pai._id));

  const fio = await model.comentariosDe(id, EU);
  const resposta = fio[1];

  await model.comentar(id, "resposta da resposta", EU, String(resposta._id));

  const depois = await model.comentariosDe(id, EU);
  assert.equal(depois.length, 3);
  // As duas apontam para o MESMO pai, e não uma para a outra.
  assert.equal(depois[1].pai, String(pai._id));
  assert.equal(depois[2].pai, String(pai._id));
});

test("pai de OUTRA ideia é ignorado, e a linha entra como primeiro nível", async () => {
  // Sem a conferência contra a ideia, a resposta ficaria pendurada num
  // comentário que não está naquele fio: apareceria como órfã e ninguém
  // entenderia por quê.
  const { model } = monta();
  const a = await primeiro(model);
  const b = await model.criar({ titulo: "Outra ideia qualquer" }, EU);

  const r = await model.comentar(b.id, "respondendo o de outra ideia", EU, String(a.pai._id));

  assert.equal(r.ok, true);
  assert.equal(r.fio[0].pai, null, "entra como primeiro nível, e não como erro");
});

test("pai inválido não estoura", async () => {
  const { model } = monta();
  const { id } = await primeiro(model);

  for (const ruim of ["não é id", "", null, String(new ObjectId())]) {
    const r = await model.comentar(id, "texto " + ruim, EU, ruim);
    assert.equal(r.ok, true, JSON.stringify(ruim));
  }
});

test("a ordem é CADA PAI seguido das respostas dele", async () => {
  // Ordenar só por data misturaria tudo: uma resposta escrita hoje a um
  // comentário de ontem apareceria no fim, longe do que ela responde.
  const { model, comentarios } = monta();
  const { id, pai } = await primeiro(model);

  await model.comentar(id, "segundo de cima", EU);
  const doSegundo = (await model.comentariosDe(id, EU)).find((c) => c.texto === "segundo de cima");

  await model.comentar(id, "resposta ao primeiro", COLEGA, String(pai._id));
  await model.comentar(id, "resposta ao segundo", COLEGA, String(doSegundo._id));

  // Envelhece as respostas para provar que a ORDEM não é a data: as duas
  // respostas foram escritas depois dos dois pais.
  comentarios.docs.forEach((c, i) => {
    c.criadoEm = new Date(2026, 0, 1, 0, i);
  });

  const fio = await model.comentariosDe(id, EU);
  assert.deepEqual(
    fio.map((c) => c.texto),
    ["o comentário de cima", "resposta ao primeiro", "segundo de cima", "resposta ao segundo"]
  );
});

// ── APAGAR ─────────────────────────────────────────────────────────────────

test("apagar comentário COM resposta o deixa vazio, e as respostas ficam", async () => {
  const { model, comentarios } = monta();
  const { id, pai } = await primeiro(model);
  await model.comentar(id, "eu respondi isso", COLEGA, String(pai._id));

  const r = await model.apagarComentario(String(pai._id), EU);
  assert.equal(r.ok, true);

  // A linha continua na lista, marcada e sem texto.
  assert.equal(r.fio.length, 2);
  assert.equal(r.fio[0].apagado, true);
  assert.equal(r.fio[0].texto, "");
  assert.equal(r.fio[0].nome, "");
  assert.equal(r.fio[0].meu, false, "apagado não ganha lixeira de novo");

  // A RESPOSTA DE OUTRA PESSOA CONTINUA. Cascatear daria a quem escreveu o pai o
  // poder de apagar texto alheio: bastaria comentar, esperar respostas, apagar.
  assert.equal(r.fio[1].texto, "eu respondi isso");

  // E o texto saiu DO BANCO, não só da resposta da rota: guardar "só para o caso
  // de" seria manter o que a pessoa pediu para apagar.
  const noBanco = comentarios.docs.find((c) => String(c._id) === String(pai._id));
  assert.equal(noBanco.texto, "");
  assert.equal(noBanco.autor.nome, "");
  assert.equal(noBanco.apagado, true);
});

test("apagar comentário SEM resposta remove de verdade", async () => {
  const { model, comentarios } = monta();
  const { id, pai } = await primeiro(model);

  const r = await model.apagarComentario(String(pai._id), EU);

  assert.equal(r.ok, true);
  assert.equal(r.fio.length, 0);
  assert.equal(comentarios.docs.length, 0, "sem resposta pendurada, não há lugar para guardar");
});

test("o contador NÃO conta os apagados", async () => {
  // "3 comentários" numa ideia onde dois estão vazios promete mais do que a tela
  // entrega.
  const { model, posts } = monta();
  const { id, pai } = await primeiro(model);
  await model.comentar(id, "uma resposta", COLEGA, String(pai._id));
  assert.equal(posts.docs[0].comentarios, 2);

  const r = await model.apagarComentario(String(pai._id), EU);

  assert.equal(r.comentarios, 1);
  assert.equal(posts.docs[0].comentarios, 1);
});

test("continua NÃO dando para apagar a resposta de outra pessoa", async () => {
  const { model } = monta();
  const { id, pai } = await primeiro(model);
  await model.comentar(id, "resposta do colega", COLEGA, String(pai._id));

  const fio = await model.comentariosDe(id, COLEGA);
  const doColega = fio[1];

  const r = await model.apagarComentario(String(doColega._id), EU);
  assert.equal(r.erro, "nao_encontrado");
  assert.equal((await model.comentariosDe(id, EU))[1].texto, "resposta do colega");
});

test("o `pai` sai na resposta, e o userId continua sem sair", async () => {
  const { model } = monta();
  const { id, pai } = await primeiro(model);
  await model.comentar(id, "resposta", EU, String(pai._id));

  const fio = await model.comentariosDe(id, EU);
  assert.deepEqual(Object.keys(fio[0]).sort(), [
    "_id",
    "apagado",
    "criadoEm",
    "meu",
    "nome",
    "oficial",
    "pai",
    "texto",
  ]);
  assert.equal(JSON.stringify(fio).includes("marlon"), false, "a instância vazou");
  assert.equal(JSON.stringify(fio).includes('"u1"'), false, "o userId vazou");
});
