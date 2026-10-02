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

test("conta SEM documento e plano SEM o campo: não tira nada de quem já tinha", async () => {
  // O estado de TODA conta no instante do deploy. Se este teste falhar, o
  // deploy apaga Aulões e Financeiro de todo mundo.
  //
  // Desde 27/09/2026 ele não afirma mais "esconde NADA": um módulo que o
  // PLANO decide continua escondido sem plano, e é o certo — o que ele
  // guarda é que nada SAI da tela de quem já usa.
  const m = comBanco({ doc: null, doPlano: null });
  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    assert.deepEqual(escondeu.sort(), escondidos({ naConta: [...modulos.CHAVES] }));
    assert.ok(!escondeu.includes("/aulaoes"));
    assert.ok(!escondeu.includes("/financeiro"));
  });
});

test("conta que liberou nada esconde os de LANÇAMENTO — e só eles", async () => {
  // Antes escondia tudo. Desde 27/09/2026 o plano manda: módulo que não pede
  // botão de notícia aparece sem a conta ter apertado nada.
  const m = comBanco({ doc: { chave: "modulos", lista: [] }, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual((await m.menusEscondidos()).sort(), escondidos({ naConta: [] }));
  });
});

// Os caminhos que SOBRAM escondidos. Derivado do catálogo, e não escrito à
// mão: um módulo novo — e já houve três — não pode exigir voltar aqui para
// somar caminhos numa lista literal.
//
// `naConta` é o que a conta liberou pela notícia; `noPlano` é o que o plano
// inclui (`null` = inclui tudo). A regra é a do modelo: o plano manda em
// todos, e só os de LANÇAMENTO ainda pedem o botão.
function escondidos({ naConta = [], noPlano = null } = {}) {
  const efetivos = modulos.CHAVES.filter((k) => {
    const pede = modulos.pedeLiberacao(k);
    const dentro = noPlano === null ? modulos.temSemPlano(k) : noPlano.includes(k);
    return dentro && (!pede || naConta.includes(k));
  });
  return modulos.MODULOS.filter((mo) => !efetivos.includes(mo.key))
    .flatMap((mo) => mo.menus)
    .sort();
}

test("liberou aulão: some o resto, fica o aulão", async () => {
  const m = comBanco({ doc: { chave: "modulos", lista: ["aulao"] }, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual((await m.menusEscondidos()).sort(), escondidos({ naConta: ["aulao"] }));
  });
});

test("o PLANO manda: liberou os dois, mas o plano só inclui um", async () => {
  // O portão que impede o cliente do plano de entrada de ligar, pela notícia,
  // um módulo que ele não comprou.
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: ["aulao"],
  });
  await dentroDeUmCliente(async () => {
    assert.deepEqual(
      (await m.menusEscondidos()).sort(),
      escondidos({ naConta: [...modulos.CHAVES], noPlano: ["aulao"] })
    );
  });
});

// ── O PLANO SOZINHO BASTA, PARA QUEM NÃO PEDE NOTÍCIA ───────────────────
//
// *"crio um plano chamado desenvolvimento onde fica tudo liberado"*
// (27/09/2026). É este caso: conta que nunca apertou botão nenhum, num plano
// que inclui tudo.
test("plano de desenvolvimento acende o que não pede notícia, sem a conta liberar", async () => {
  const m = comBanco({
    doc: { chave: "modulos", lista: [] },
    doPlano: [...modulos.CHAVES],
  });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    // `redesSociais` não pede notícia: o plano basta.
    assert.ok(!escondeu.includes("/configuration/instagram"));
    assert.ok(!escondeu.includes("/configuration/facebook"));
    // Os de lançamento continuam esperando o botão — o plano inclui, a conta
    // ainda não quis.
    assert.ok(escondeu.includes("/aulaoes"));
    assert.ok(escondeu.includes("/financeiro"));
  });
});

test("tirar do plano esconde MESMO o que não pede notícia", async () => {
  // O outro lado: é assim que uma tela fica escondida de todo mundo até
  // ficar pronta — tirando-a dos planos.
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: ["aulao", "financeiro"],
  });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    assert.ok(escondeu.includes("/configuration/instagram"));
    assert.ok(!escondeu.includes("/aulaoes"));
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
    assert.deepEqual((await m.menusEscondidos()).sort(), escondidos({ naConta: ["aulao"] }));
  });
});

test("`lista` que não é array conta como vazia, e não estoura", async () => {
  const m = comBanco({ doc: { chave: "modulos", lista: "aulao" }, doPlano: null });
  await dentroDeUmCliente(async () => {
    assert.deepEqual((await m.menusEscondidos()).sort(), escondidos({ naConta: [] }));
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

// ── SEM PLANO, O QUE NÃO ESTÁ PRONTO NÃO VAZA ────────────────────────────
//
// Cinco das sete contas não tinham plano quando isto foi escrito. Com a regra
// antiga ("sem plano inclui tudo") a tela ainda não pronta apareceria
// justamente nelas — o oposto do que o recurso serve para fazer.
test("conta SEM plano: mantém os de lançamento, mas não ganha o que o plano decide", async () => {
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: null,
  });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    // Aulões e Financeiro continuam: a conta de cortesia já os usa, e tirar
    // seria apagar do dia dela uma coisa que ela tem.
    assert.ok(!escondeu.includes("/aulaoes"));
    assert.ok(!escondeu.includes("/financeiro"));
    // Redes sociais não: sem plano, ninguém decidiu — e o que não foi
    // decidido fica escondido.
    assert.ok(escondeu.includes("/configuration/instagram"));
  });
});

// ── OS MENUS DO PRODUTO VIRARAM MÓDULOS (27/09/2026) ─────────────────────
//
// *"aqui tem tudo isso... ali tem pouco"*. Onze menus, três módulos — o plano
// não alcançava o que existe.
//
// O risco desta mudança é o oposto do que ela serve para fazer: transformar
// Treinos num módulo pode APAGAR Treinos de quem já usa. Estes casos são a
// rede.

test("conta SEM plano continua com o produto inteiro", async () => {
  const m = comBanco({ doc: null, doPlano: null });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    // Cinco das sete contas estavam assim quando isto foi escrito. Se este
    // caso falhar, o deploy deixa cada uma com três menus.
    for (const caminho of ["/workouts", "/dietas", "/avaliacoes", "/agenda", "/estrutura"]) {
      assert.ok(!escondeu.includes(caminho), caminho + " sumiu de quem não tem plano");
    }
  });
});

test("o plano SUBTRAI: um plano de entrada é menor, e nada some por omissão", async () => {
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: ["treinos", "dietas", "aulao"],
  });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    assert.ok(!escondeu.includes("/workouts"));
    assert.ok(!escondeu.includes("/dietas"));
    assert.ok(escondeu.includes("/avaliacoes"));
    assert.ok(escondeu.includes("/estrutura"));
  });
});

test("Dashboard e Pessoas NÃO são módulos — não há plano que os apague", () => {
  // Um plano sem o Dashboard deixaria a pessoa numa tela em branco ao entrar;
  // sem Pessoas, o sistema não tem objeto. O que se limita ali é a
  // QUANTIDADE, que já é limite de plano.
  assert.ok(!modulos.MENUS_CONTROLADOS.includes("/"));
  assert.ok(!modulos.MENUS_CONTROLADOS.includes("/people"));
});

test("todo módulo declara o que acontece SEM plano — esquecer esconde a tela", () => {
  // `semPlano` ausente vale `false`, que é o certo para o que não está
  // pronto e catastrófico para um menu do produto. Um módulo novo sem o campo
  // sumiria das contas sem plano, e ninguém saberia por quê.
  for (const m of modulos.MODULOS) {
    assert.equal(
      typeof m.semPlano,
      "boolean",
      `o módulo "${m.key}" não diz se uma conta sem plano o tem`
    );
  }
});

// ── A PONTE ATÉ A FICHA DO ALUNO (27/09/2026) ────────────────────────────
//
// *"entrei no aluno e ainda aparece tudo"*, com o print das catorze abas. Os
// módulos escondiam MENUS, e a ficha tem chaves próprias — faltava dizer que
// Treinos, o módulo, também é a aba de treino do aluno.

test("tirar Treinos do plano esconde o menu E a aba da ficha", async () => {
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: modulos.CHAVES.filter((k) => k !== "treinos"),
  });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    assert.ok(escondeu.includes("/workouts"), "o menu");
    assert.ok(escondeu.includes("/people/tab/workouts"), "a aba da ficha");
    // Um recurso, dois lugares: esconder só um seria a pessoa achar a tela
    // pelo outro caminho.
    assert.ok(!escondeu.includes("/dietas"));
    assert.ok(!escondeu.includes("/people/tab/diet"));
  });
});

test("o que só existe na ficha também é módulo", async () => {
  // Suplementação, Prescrições, Anamnese, Exames, Frequência e Documentos não
  // têm menu na barra — e um plano precisa poder não incluí-los.
  const m = comBanco({
    doc: { chave: "modulos", lista: [...modulos.CHAVES] },
    doPlano: ["treinos"],
  });

  await dentroDeUmCliente(async () => {
    const escondeu = await m.menusEscondidos();
    for (const aba of ["supplement", "prescription", "anamnesis", "exam", "frequency", "documents"]) {
      assert.ok(escondeu.includes("/people/tab/" + aba), aba);
    }
  });
});

test("Histórico e Pendências NÃO são módulos — não são recurso que se vende", () => {
  // São a leitura do que já existe. Um plano sem histórico esconderia a
  // auditoria de quem mexeu na ficha, que é outra conversa — e a errada.
  assert.ok(!modulos.MENUS_CONTROLADOS.includes("/people/tab/historico"));
  assert.ok(!modulos.MENUS_CONTROLADOS.includes("/people/tab/pendencies"));
});

// ── TODO MÓDULO DIZ EM QUE GRUPO MORA ────────────────────────────────────
//
// *"separe numa categoria chamada 'configuração' pra ser fácil de eu achar"*
// (29/09/2026). A lista passou de trinta itens, e a central agrupa por este
// campo — um módulo sem grupo cairia num limbo que ninguém procura.
test("todo módulo declara um grupo conhecido", () => {
  const GRUPOS = ["menu", "ficha", "configuracao"];
  for (const m of modulos.MODULOS) {
    assert.ok(GRUPOS.includes(m.grupo), `o módulo "${m.key}" tem grupo "${m.grupo}"`);
  }
});

test("nenhum caminho é controlado por DOIS módulos", () => {
  // Duas chaves para a mesma tela deixariam metade acesa quando alguém
  // desmarcasse só uma — e o dono não teria como saber por quê.
  const vistos = new Map();
  for (const m of modulos.MODULOS) {
    for (const caminho of m.menus) {
      assert.ok(
        !vistos.has(caminho),
        `${caminho} está em "${m.key}" e em "${vistos.get(caminho)}"`
      );
      vistos.set(caminho, m.key);
    }
  }
});

test("as chaves de seção não colidem com as de menu", () => {
  // `plans` é o plano do PRODUTO, `users` é gente, `system` é ambíguo. Chave
  // de módulo é contrato: fica gravada no documento do plano, e renomear
  // apaga a escolha de quem já tinha.
  const repetidas = modulos.CHAVES.filter((k, i) => modulos.CHAVES.indexOf(k) !== i);
  assert.deepEqual(repetidas, []);
});
