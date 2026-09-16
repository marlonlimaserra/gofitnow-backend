const test = require("node:test");
const assert = require("node:assert/strict");

const Modulo_model = require("../../model/Modulo_model.js");
const modulos = require("../../lib/modulos.js");
const instanceContext = require("../../lib/instance.js");

// OS DOIS PORTÕES DE UM MÓDULO.
//
//   o PLANO inclui?   — decide o painel, marcando no plano
//   a CONTA liberou?  — decide o cliente, pelo botão da notícia
//
// ── O QUE ESTE ARQUIVO PROTEGE ────────────────────────────────────────────
//
// Um erro aqui não dá erro: ele APAGA MENU de quem está usando. O cliente entra
// de manhã e o Financeiro não está mais lá — sem mensagem, sem log, sem nada
// para ele reportar além de "sumiu".
//
// Por isso quase todo teste daqui é sobre o caminho do "não sei": campo ausente,
// plano sem o campo, cliente sem plano, leitura que falhou. Todos têm de ABRIR.
// O erro barato é o que mostra um menu a mais; o caro é o que esconde.

// Um dobro que responde o que o MODELO responde, e não o que eu gostaria.
// `liberados()` devolve `null` quando não há documento — é essa distinção entre
// "nada liberado" e "não sei" que o resto depende, então o dobro a preserva.
function comBanco({ doc, doPlano }) {
  const app = {
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              async findOne() {
                return doc;
              },
            };
          },
        };
      },
    },
    api: {
      center: {
        async modulosDoPlano() {
          return doPlano;
        },
      },
    },
  };

  return new Modulo_model(app);
}

// `menusEscondidos` lê a instância do contexto para perguntar o plano ao
// registro central, então todo teste roda dentro de um.
function dentroDeUmCliente(fn) {
  return instanceContext.run("teste", fn);
}

const TODOS = modulos.MENUS_CONTROLADOS;

test("o catálogo não está vazio — sem ele todo teste daqui passa por acidente", () => {
  assert.ok(modulos.CHAVES.length >= 2);
  assert.ok(TODOS.includes("/aulaoes"));
  assert.ok(TODOS.includes("/financeiro"));
});

test("conta SEM documento e plano SEM o campo: não esconde nada", async () => {
  // O estado de TODA conta no instante do deploy. Se este teste falhar, o
  // deploy apaga Aulões e Financeiro de todo mundo.
  const m = comBanco({ doc: null, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual(await m.menusEscondidos(), []);
  });
});

test("conta que liberou nada esconde tudo — este é o caso de conta NOVA", async () => {
  const m = comBanco({ doc: { chave: "modulos", lista: [] }, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual((await m.menusEscondidos()).sort(), [...TODOS].sort());
  });
});

test("liberou aulão: some o financeiro, fica o aulão", async () => {
  const m = comBanco({ doc: { chave: "modulos", lista: ["aulao"] }, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual(await m.menusEscondidos(), ["/financeiro"]);
  });
});

test("o PLANO manda: liberou os dois, mas o plano só inclui um", async () => {
  // O portão que impede o cliente do plano de entrada de ligar, pela notícia,
  // um módulo que ele não comprou.
  const m = comBanco({
    doc: { chave: "modulos", lista: ["aulao", "financeiro"] },
    doPlano: ["aulao"],
  });
  await dentroDeUmCliente(async () => {
    assert.deepEqual(await m.menusEscondidos(), ["/financeiro"]);
  });
});

test("plano que inclui tudo e conta que liberou tudo: nada escondido", async () => {
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: [...modulos.CHAVES],
  });
  await dentroDeUmCliente(async () => {
    assert.deepEqual(await m.menusEscondidos(), []);
  });
});

test("plano com lista VAZIA esconde tudo, mesmo com a conta tendo liberado", async () => {
  // `[]` no plano é escolha — alguém desmarcou tudo no formulário. Diferente de
  // `null`, que é plano nunca editado.
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: [],
  });
  await dentroDeUmCliente(async () => {
    assert.deepEqual((await m.menusEscondidos()).sort(), [...TODOS].sort());
  });
});

test("chave inventada no documento da conta é ignorada, não vira menu", async () => {
  const m = comBanco({
    doc: { chave: "modulos", lista: ["aulao", "modulo-que-nao-existe"] },
    doPlano: null,
  });
  await dentroDeUmCliente(async () => {
    assert.deepEqual(await m.menusEscondidos(), ["/financeiro"]);
  });
});

test("`lista` que não é array conta como vazia, e não estoura", async () => {
  const m = comBanco({ doc: { chave: "modulos", lista: "aulao" }, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual((await m.menusEscondidos()).sort(), [...TODOS].sort());
  });
});

test("`liberados` separa NADA LIBERADO de NÃO SEI", async () => {
  // A distinção que o resto do arquivo depende, testada direto: `[]` e `null`
  // são respostas diferentes, e tratá-las igual é o defeito que apaga menu.
  const semDoc = comBanco({ doc: null, doPlano: null });
  const comDocVazio = comBanco({ doc: { chave: "modulos", lista: [] }, doPlano: null });

  await dentroDeUmCliente(async () => {
    assert.equal(await semDoc.liberados(), null);
    assert.deepEqual(await comDocVazio.liberados(), []);
  });
});

test("liberar recusa módulo que não existe, antes de gravar", async () => {
  // Sem esta trava, um POST com qualquer texto no caminho encheria o documento
  // da conta de chaves inventadas que nada nunca leria.
  let gravou = false;
  const app = {
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              async updateOne() {
                gravou = true;
              },
              async findOne() {
                return null;
              },
            };
          },
        };
      },
    },
    api: { center: { async modulosDoPlano() { return null; } } },
  };

  const m = new Modulo_model(app);
  await dentroDeUmCliente(async () => {
    const r = await m.liberar("nao-existe");
    assert.equal(r.ok, false);
    assert.equal(r.erro, "modulo_desconhecido");
    assert.equal(gravou, false, "não pode ter chegado ao banco");
  });
});

test("o semeador: BOOT semeia cheio, CADASTRO semeia enxuto", async () => {
  // Os dois chamadores querem coisas opostas, e é isto que o parâmetro existe
  // para não confundir. Semear vazio no boot apagaria os menus de quem já usa.
  for (const [tudo, esperado] of [
    [true, [...modulos.CHAVES]],
    [false, modulos.padroes()],
  ]) {
    let inserido = null;
    const app = {
      mongodb: {
        async connectToServer() {
          return {
            collection() {
              return {
                async findOne() {
                  return null;
                },
                async insertOne(doc) {
                  inserido = doc;
                },
              };
            },
          };
        },
      },
      api: { center: { async modulosDoPlano() { return null; } } },
    };

    const m = new Modulo_model(app);
    await dentroDeUmCliente(() => m.semear({ tudo }));

    assert.deepEqual(inserido.lista.sort(), [...esperado].sort());
    assert.equal(inserido.semeadoComo, tudo ? "conta-anterior-ao-recurso" : "conta-nova");
  }
});

test("o semeador NÃO escreve por cima de quem já tem documento", async () => {
  // Ele roda a cada boot. Sem esta guarda, todo reinício desfaria o que o
  // cliente liberou — ou pior, com `tudo: true`, liberaria tudo para sempre.
  let insercoes = 0;
  const app = {
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              async findOne() {
                return { _id: "ja-existe" };
              },
              async insertOne() {
                insercoes++;
              },
            };
          },
        };
      },
    },
    api: { center: { async modulosDoPlano() { return null; } } },
  };

  const m = new Modulo_model(app);
  const r = await dentroDeUmCliente(() => m.semear({ tudo: true }));

  assert.equal(r.criado, false);
  assert.equal(insercoes, 0);
});
