const test = require("node:test");
const assert = require("node:assert/strict");

const { catalogo, traduzir, quantas, usaVinculo } = require("../../lib/condicoes");

// O FILTRO AVANÇADO — e o que ele NÃO pode deixar passar.
//
// *"coloque uma aba 'Básico' e outra 'Avançado' […] aí dá para pôr várias
// condições"* (10/10/2026).
//
// ── POR QUE ESTE ARQUIVO É QUASE TODO SOBRE SEGURANÇA ─────────────────────
//
// Porque uma árvore de condições vinda da tela é a coisa mais perto de "SQL
// escrito pelo usuário" que este sistema tem. Se ela virasse consulta
// diretamente:
//
//   • `{"campo":"password"}` transformaria a lista num ORÁCULO — pergunta-se
//     "senha começa com a?" e conta-se o resultado;
//   • `{"operador":"$where"}` executaria código no banco;
//   • um `contém` com `(a+)+$` travaria o Mongo com um regex explosivo.
//
// Nada disso depende de alguém ser malicioso com a nossa tela: basta um
// `curl`. Por isso o catálogo AUTORIZA, em vez de a tela mandar o caminho.

test("o catálogo não entrega o mapa do banco para o navegador", () => {
  // Ele desenha o seletor; não diz onde o dado mora. `campo` e `montar` ficam
  // no servidor — publicá-los seria dizer a quem sonda exatamente o que
  // tentar.
  for (const c of catalogo()) {
    assert.equal(c.campo, undefined);
    assert.equal(c.montar, undefined);
    assert.ok(c.chave && c.categoria && c.tipo);
    assert.ok(Array.isArray(c.operadores) && c.operadores.length);
  }
});

test("condição FORA do catálogo é descartada — não vira consulta", () => {
  // O caso do oráculo de senha.
  const r = traduzir({
    grupos: [{ condicoes: [{ campo: "password", operador: "contem", valor: "a" }] }],
  });

  assert.equal(r, null);
});

test("operador inventado cai no primeiro da lista daquele tipo, nunca é usado cru", () => {
  const r = traduzir({
    grupos: [{ condicoes: [{ campo: "nome", operador: "$where", valor: "Marlon" }] }],
  });

  // `contem` é o primeiro operador de texto. O que não pode é `$where`
  // aparecer em lugar nenhum da consulta.
  assert.deepEqual(r, { name: { $regex: "Marlon", $options: "i" } });
  assert.ok(!JSON.stringify(r).includes("$where"));
});

test("o texto do usuário é ESCAPADO antes de virar regex", () => {
  // Sem isto, `.*` devolve a base inteira e `(a+)+$` trava o banco.
  const r = traduzir({
    grupos: [{ condicoes: [{ campo: "nome", operador: "contem", valor: ".*" }] }],
  });

  assert.equal(r.name.$regex, "\\.\\*");
});

test("opção fora da lista daquela condição é descartada", () => {
  const r = traduzir({
    grupos: [{ condicoes: [{ campo: "sexo", operador: "e", valor: "qualquer coisa" }] }],
  });

  assert.equal(r, null);
});

test("unidade só aceita um ObjectId de verdade", () => {
  assert.equal(
    traduzir({ grupos: [{ condicoes: [{ campo: "unidade", operador: "e", valor: "sou-eu" }] }] }),
    null
  );

  const r = traduzir({
    grupos: [{ condicoes: [{ campo: "unidade", operador: "e", valor: "000000000000000000000001" }] }],
  });
  assert.equal(String(r.unit), "000000000000000000000001");
});

// ── A ÁRVORE ───────────────────────────────────────────────────────────────

test("condições de um grupo se juntam com E ou com OU", () => {
  const condicoes = [
    { campo: "email", operador: "preenchido" },
    { campo: "whatsapp", operador: "preenchido" },
  ];

  assert.ok(traduzir({ grupos: [{ juntar: "e", condicoes }] }).$and);
  assert.ok(traduzir({ grupos: [{ juntar: "ou", condicoes }] }).$or);
});

test("dois grupos se juntam entre si, e o de dentro continua valendo", () => {
  const r = traduzir({
    juntar: "ou",
    grupos: [
      {
        juntar: "e",
        condicoes: [
          { campo: "email", operador: "preenchido" },
          { campo: "acesso_app", operador: "e", valor: true },
        ],
      },
      { condicoes: [{ campo: "passagem", operador: "e", valor: false }] },
    ],
  });

  assert.equal(r.$or.length, 2);
  assert.equal(r.$or[0].$and.length, 2);
  assert.deepEqual(r.$or[1], { passagemLiberada: false });
});

test("uma condição só NÃO ganha envelope de $and", () => {
  // `{$and: [x]}` funciona e é ruído: polui o log da consulta e o plano de
  // execução de toda busca simples.
  const r = traduzir({ grupos: [{ condicoes: [{ campo: "email", operador: "preenchido" }] }] });

  assert.deepEqual(r, { email: { $nin: [null, ""] } });
});

// ── UMA ENTRADA POR CAMPO, COM O PADRÃO CERTO ──────────────────────────────
//
// *"'tem e-mail' e 'e-mail', mais fácil deixar só e-mail, e por padrão já vem
// 'Está preenchido'"* (10/10/2026).

test("o campo aparece UMA vez no catálogo, não duas", () => {
  const chaves = catalogo().map((c) => c.chave);

  assert.ok(chaves.includes("email"));
  assert.ok(!chaves.includes("tem_email"));
  assert.ok(!chaves.includes("tem_telefone"));
  // E nenhum campo repetido, em geral.
  assert.equal(new Set(chaves).size, chaves.length);
});

test("o padrão é por CONDIÇÃO: de nome se pergunta o que contém; de e-mail, se existe", () => {
  // Um padrão por TIPO acertaria sempre um e erraria sempre o outro — os dois
  // são texto.
  const de = (chave) => catalogo().find((c) => c.chave === chave).operadores[0];

  assert.equal(de("nome"), "contem");
  assert.equal(de("email"), "preenchido");
  assert.equal(de("whatsapp"), "preenchido");
});

test("sem operador declarado, cai no padrão da condição", () => {
  // É a mesma queda que a tela usa, e é por isso que o padrão vira ORDEM em
  // vez de um conceito novo.
  assert.deepEqual(traduzir({ grupos: [{ condicoes: [{ campo: "email" }] }] }), {
    email: { $nin: [null, ""] },
  });
});

test("árvore vazia é NULL — e não um $or vazio, que estoura no Mongo", () => {
  assert.equal(traduzir(null), null);
  assert.equal(traduzir({ grupos: [] }), null);
  assert.equal(traduzir({ grupos: [{ condicoes: [] }] }), null);
  // Grupo em que TODAS as condições são inválidas some junto.
  assert.equal(traduzir({ grupos: [{ condicoes: [{ campo: "nao_existe" }] }] }), null);
});

// ── AS DERIVADAS ───────────────────────────────────────────────────────────

test("acesso ao app é senha E não-bloqueado — nunca um campo só", () => {
  // É como `hasAccess` sempre foi calculado. Tratá-lo como campo aqui criaria
  // uma segunda verdade, e as duas divergiriam na primeira mudança.
  const r = traduzir({ grupos: [{ condicoes: [{ campo: "acesso_app", operador: "e", valor: true }] }] });

  assert.deepEqual(r, { password: { $nin: [null, ""] }, appBloqueado: { $ne: true } });
});

test("passagem liberada lê a AUSÊNCIA do campo como liberada", () => {
  // Quem foi cadastrado antes do campo existir não o tem, e essas pessoas
  // entram. Ler ausência como "bloqueado" acusaria a academia inteira no dia
  // do deploy.
  const r = traduzir({ grupos: [{ condicoes: [{ campo: "passagem", operador: "e", valor: true }] }] });

  assert.deepEqual(r, { passagemLiberada: { $ne: false } });
});

test("'entre' exige as DUAS pontas", () => {
  const meio = { campo: "cadastrado_em", operador: "entre", valor: "2026-01-01" };
  assert.equal(traduzir({ grupos: [{ condicoes: [meio] }] }), null);

  const r = traduzir({
    grupos: [{ condicoes: [{ ...meio, valor2: "2026-02-01" }] }],
  });
  assert.ok(r.createdAt.$gte instanceof Date && r.createdAt.$lt instanceof Date);
});

test("a contagem é a do SERVIDOR, e só conta o que vale", () => {
  // Contar na tela daria outro número no dia em que o servidor descartasse
  // uma condição — e o botão diria "3 filtros" sobre uma lista filtrada por 2.
  const arvore = {
    grupos: [
      {
        condicoes: [
          { campo: "email", operador: "preenchido" },
          { campo: "nao_existe", operador: "e", valor: true },
          { campo: "nome", operador: "contem", valor: "" },
        ],
      },
    ],
  };

  assert.equal(quantas(arvore), 1);
});

// ── SEXO: DOIS VALORES E UMA AUSÊNCIA ──────────────────────────────────────
//
// *"sexo seria masculino feminino e sem sexo"* (10/10/2026). Eu tinha
// inventado um `other` que não existe no cadastro.

test("'sem sexo' pega as TRÊS formas da ausência", () => {
  // Vazio (quem desmarcou no formulário), nulo, e o campo que não existe
  // (fichas anteriores a ele). São a mesma resposta para quem pergunta, e um
  // `{sex: ""}` pegaria só a primeira.
  const r = traduzir({ grupos: [{ condicoes: [{ campo: "sexo", operador: "e", valor: "sem" }] }] });

  assert.deepEqual(r, { sex: { $in: [null, ""] } });
});

test("'não é' vale também para a ausência, e para os dois valores", () => {
  // A condição derivada recebe o OPERADOR junto. Sem ele, "sexo não é
  // feminino" viraria "sexo é feminino" — e ninguém confere uma lista que
  // parece certa.
  assert.deepEqual(
    traduzir({ grupos: [{ condicoes: [{ campo: "sexo", operador: "nao_e", valor: "sem" }] }] }),
    { sex: { $nin: [null, ""] } }
  );
  assert.deepEqual(
    traduzir({ grupos: [{ condicoes: [{ campo: "sexo", operador: "nao_e", valor: "female" }] }] }),
    { sex: { $ne: "female" } }
  );
});

test("valor inventado não chega na condição derivada", () => {
  // A lista de opções é conferida ANTES do `montar`. A primeira versão
  // deixava passar, e uma derivada que recebe o que não espera é o buraco que
  // o catálogo existe para fechar.
  assert.equal(
    traduzir({ grupos: [{ condicoes: [{ campo: "sexo", operador: "e", valor: "attack" }] }] }),
    null
  );
});

// ── DATA É DIA DE CALENDÁRIO, E NÃO INSTANTE ───────────────────────────────
//
// *"acho que faltou 'data exata', quero pegar o que tem naquele dia"*
// (10/10/2026).
//
// O operador novo expôs um defeito que eu tinha acabado de reintroduzir:
// `new Date("2026-10-10")` é meia-noite em UTC, que no Brasil é 21h do dia 9.
// `periodoDeCadastro` já descrevia isso por escrito, e eu fiz igual errado do
// lado. Dói mais no "nesse dia": três horas de deslocamento devolvem o
// conjunto errado de gente, com cara de conjunto certo.

const SP = "America/Sao_Paulo";

test("'nesse dia' é o dia INTEIRO, no fuso da conta", () => {
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "cadastrado_em", operador: "e", valor: "2026-10-10" }] }] },
    SP
  );

  // 00:00 em São Paulo é 03:00 em UTC — e o fim é o dia seguinte com `$lt`,
  // senão o dia escolhido ficaria inteiro de fora.
  assert.equal(r.createdAt.$gte.toISOString(), "2026-10-10T03:00:00.000Z");
  assert.equal(r.createdAt.$lt.toISOString(), "2026-10-11T03:00:00.000Z");
});

test("comparar com um INSTANTE não acharia ninguém", () => {
  // Ninguém é cadastrado exatamente às 00:00:00.000. Se "é" virasse
  // igualdade, a resposta seria sempre lista vazia — e lista vazia parece
  // "não tem ninguém nesse dia", não "a pergunta está errada".
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "cadastrado_em", operador: "e", valor: "2026-10-10" }] }] },
    SP
  );

  assert.ok(r.createdAt.$gte instanceof Date);
  assert.equal(r.createdAt.$eq, undefined);
});

test("'a partir de' e 'antes' também passam pelo fuso", () => {
  const de = traduzir(
    { grupos: [{ condicoes: [{ campo: "cadastrado_em", operador: "depois", valor: "2026-10-10" }] }] },
    SP
  );
  assert.equal(de.createdAt.$gte.toISOString(), "2026-10-10T03:00:00.000Z");

  const ate = traduzir(
    { grupos: [{ condicoes: [{ campo: "cadastrado_em", operador: "antes", valor: "2026-10-10" }] }] },
    SP
  );
  assert.equal(ate.createdAt.$lt.toISOString(), "2026-10-10T03:00:00.000Z");
});

test("data que não é um dia de calendário é descartada", () => {
  // Nada de `new Date` aceitando "amanhã", "10/10/2026" ou lixo: o formato é
  // AAAA-MM-DD, que é o que a tela manda.
  for (const ruim of ["amanhã", "10/10/2026", "2026-13-40x", ""]) {
    assert.equal(
      traduzir({ grupos: [{ condicoes: [{ campo: "cadastrado_em", operador: "e", valor: ruim }] }] }, SP),
      null
    );
  }
});

test("o 'entre' fecha no dia seguinte do FIM, e não no começo dele", () => {
  const r = traduzir(
    {
      grupos: [
        {
          condicoes: [
            { campo: "cadastrado_em", operador: "entre", valor: "2026-10-01", valor2: "2026-10-31" },
          ],
        },
      ],
    },
    SP
  );

  // 31 inclusive: o corte é a meia-noite do dia 1º de novembro.
  assert.equal(r.createdAt.$lt.toISOString(), "2026-11-01T03:00:00.000Z");
});

// ── O WHATSAPP É O TELEFONE, E ELE É GUARDADO COMO FOI DIGITADO ────────────
//
// *"faltou o campo whatsapp"* (10/10/2026).

test("buscar o número acha as duas formas: com e sem formatação", () => {
  // `(21) 97168-5171` e `21971685171` convivem no banco. Um `contém` cru
  // acharia um e não o outro — e quem cola o número copiado do telefone não
  // acharia a ficha que está bem ali.
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "whatsapp", operador: "contem", valor: "(21) 97168" }] }] },
    "UTC"
  );

  const bate = new RegExp(r.phone.$regex);
  assert.ok(bate.test("(21) 97168-5171"));
  assert.ok(bate.test("21971685171"));
  assert.ok(bate.test("+55 21 97168 5171"));
});

test("'é' num telefone é TERMINA COM — igualdade literal nunca acharia nada", () => {
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "whatsapp", operador: "e", valor: "971685171" }] }] },
    "UTC"
  );

  assert.ok(r.phone.$regex.endsWith("$"));
  assert.ok(new RegExp(r.phone.$regex).test("(21) 97168-5171"));
  assert.ok(!new RegExp(r.phone.$regex).test("971685171 9"));
});

test("busca de telefone SEM dígito nenhum é descartada", () => {
  assert.equal(
    traduzir({ grupos: [{ condicoes: [{ campo: "whatsapp", operador: "contem", valor: "abc" }] }] }, "UTC"),
    null
  );
});

// ── O STATUS NÃO MORA NA PESSOA ────────────────────────────────────────────
//
// *"faltou o status"* (10/10/2026). Ativo/inativo é do VÍNCULO entre o
// profissional e a pessoa, e só existe depois da junção. O filtro básico
// resolve recortando ids antes do pipeline; aqui não dá — dentro de um OU,
// "ativo OU tem foto" não se expressa por recorte de ids.

test("o status vira filtro no campo que a JUNÇÃO produz", () => {
  assert.deepEqual(
    traduzir({ grupos: [{ condicoes: [{ campo: "status", operador: "e", valor: "ativo" }] }] }),
    { active: 1 }
  );
  assert.deepEqual(
    traduzir({ grupos: [{ condicoes: [{ campo: "status", operador: "e", valor: "inativo" }] }] }),
    { active: 0 }
  );
  assert.deepEqual(
    traduzir({ grupos: [{ condicoes: [{ campo: "status", operador: "nao_e", valor: "ativo" }] }] }),
    { active: { $ne: 1 } }
  );
});

test("a árvore AVISA quando precisa da junção — ela é cara e não sobe à toa", () => {
  // Correlacionada por pessoa: com 215 pessoas custa 32ms antes do corte e
  // 5ms depois. Subi-la sempre faria toda busca pagar por um filtro que
  // quase ninguém usa.
  assert.equal(usaVinculo({ grupos: [{ condicoes: [{ campo: "status" }] }] }), true);
  assert.equal(usaVinculo({ grupos: [{ condicoes: [{ campo: "email" }] }] }), false);
  assert.equal(usaVinculo(null), false);

  // Num grupo qualquer da árvore, não só no primeiro.
  assert.equal(
    usaVinculo({ grupos: [{ condicoes: [{ campo: "email" }] }, { condicoes: [{ campo: "status" }] }] }),
    true
  );
});

// ── O PREÇO DA DESCOBERTA AUTOMÁTICA ───────────────────────────────────────
//
// *"em breve vamos ter um montão de condições, e tenho medo de dar conflito
// quando outro programador for mexer; no SprintHub cada filtro é um arquivo
// separado"* (10/10/2026).
//
// Uma condição por arquivo acaba com o conflito, e `index.js` lê a pasta —
// acrescentar uma passou a tocar um arquivo novo e nenhum existente.
//
// O preço é que a lista virou implícita: não dá para `grep` nela, e um arquivo
// esquecido na pasta vira condição no ar. Estes casos são o que paga esse
// preço — sem eles, um arquivo torto chega à produção e só aparece quando
// alguém tenta usá-lo.

const OPERADORES_CONHECIDOS = [
  "e",
  "nao_e",
  "contem",
  "nao_contem",
  "vazio",
  "preenchido",
  "maior",
  "menor",
  "depois",
  "antes",
  "entre",
];

test("toda condição da pasta tem a forma completa", () => {
  const categorias = require("../../lib/condicoes").CATEGORIAS.map((c) => c.chave);

  for (const c of catalogo()) {
    assert.ok(c.chave, "condição sem chave");
    assert.ok(
      categorias.includes(c.categoria),
      `${c.chave}: categoria "${c.categoria}" não existe em categorias.js`
    );
    assert.ok(c.icone, `${c.chave}: sem ícone — a linha ficaria torta na lista`);
    assert.ok(c.operadores?.length, `${c.chave}: tipo "${c.tipo}" não tem operadores`);

    for (const op of c.operadores) {
      assert.ok(OPERADORES_CONHECIDOS.includes(op), `${c.chave}: operador desconhecido "${op}"`);
    }
  }
});

test("nenhuma chave repetida — duas valeriam a última lida da pasta", () => {
  // E "a última lida" depende da ordem do sistema de arquivos, que muda de
  // máquina para máquina: seria um defeito que só aparece em produção.
  const chaves = catalogo().map((c) => c.chave);

  assert.equal(new Set(chaves).size, chaves.length);
});

test("condição de OPÇÃO declara as opções dela", () => {
  // Sem a lista, o tradutor não tem contra o que validar — e valor inventado
  // chegaria na consulta.
  for (const c of catalogo().filter((x) => x.tipo === "opcao")) {
    assert.ok(Array.isArray(c.opcoes) && c.opcoes.length, `${c.chave}: sem opcoes`);
  }
});

test("quem declara `padrao` o tem na própria lista de operadores", () => {
  // Um padrão que não existe seria ignorado em silêncio, e a tela abriria com
  // outro operador escolhido. `operadoresDe` põe o padrão na frente, então
  // basta conferir que o primeiro é um operador daquele tipo.
  for (const c of catalogo()) {
    assert.ok(OPERADORES_CONHECIDOS.includes(c.operadores[0]), `${c.chave}: padrão inválido`);
  }
});

// ── OS CAMPOS CUSTOMIZADOS VIRAM CONDIÇÕES ─────────────────────────────────
//
// *"faltou, em contato, os filtros dos campos customizados"* (10/10/2026).
//
// Eles não cabem num arquivo: "Convênio" é um campo que ESTA academia criou, e
// a de Paraty tem outros cinco. O que existe é uma regra — um gerador.

const { dinamicas } = require("../../lib/condicoes");

const appFalso = (campos) => ({ api: { customField: { list: async () => campos } } });

test("campo customizado procura em customFields.<alias>; NATIVO, na coluna", () => {
  // Onde o valor mora é o que decide, e errar devolve lista vazia — que
  // parece "ninguém tem esse convênio", não "procurei no lugar errado".
  return dinamicas(
    appFalso([
      { alias: "convenio", tipo: "texto", name: "Convênio" },
      { alias: "weight", tipo: "numero", nativo: true, rotuloPadrao: "customFields.native.weight" },
    ])
  ).then((geradas) => {
    const porChave = Object.fromEntries(geradas.map((c) => [c.chave, c]));

    assert.equal(porChave.campo_convenio.campo, "customFields.convenio");
    assert.equal(porChave.campo_weight.campo, "weight");
  });
});

test("a chave leva `campo_` na frente — senão um campo 'nome' sequestra a condição de nome", () => {
  return dinamicas(appFalso([{ alias: "nome", tipo: "texto", name: "Nome do convênio" }])).then(
    (geradas) => {
      assert.equal(geradas[0].chave, "campo_nome");
      // E a fixa continua de pé, com o campo dela.
      assert.deepEqual(
        traduzir({ grupos: [{ condicoes: [{ campo: "nome", operador: "e", valor: "Ana" }] }] }, "UTC"),
        { name: "Ana" }
      );
    }
  );
});

test("o tipo sai de como o valor é GUARDADO, e não do tipo da tela", () => {
  // "CPF" e "Convênio" são os dois texto para o banco; "Sim/Não" é booleano.
  return dinamicas(
    appFalso([
      { alias: "cpf", tipo: "cpf", name: "CPF" },
      { alias: "vip", tipo: "simNao", name: "VIP" },
      { alias: "nasc", tipo: "data", name: "Aniversário" },
      { alias: "visitas", tipo: "numero", name: "Visitas" },
    ])
  ).then((geradas) => {
    const tipo = (a) => geradas.find((c) => c.chave === "campo_" + a).tipo;

    assert.equal(tipo("cpf"), "texto");
    assert.equal(tipo("vip"), "booleano");
    assert.equal(tipo("nasc"), "data");
    assert.equal(tipo("visitas"), "numero");
  });
});

test("seletor COM opções vira escolha fechada; sem elas, vira texto", () => {
  // Um seletor sem opção é um campo que não dá para preencher.
  return dinamicas(
    appFalso([
      { alias: "plano", tipo: "seletor", name: "Plano", opcoes: [{ valor: "ouro" }, { valor: "prata" }] },
      { alias: "vazio", tipo: "seletor", name: "Vazio", opcoes: [] },
    ])
  ).then((geradas) => {
    const plano = geradas.find((c) => c.chave === "campo_plano");
    assert.equal(plano.tipo, "opcao");
    assert.deepEqual(plano.opcoes, ["ouro", "prata"]);

    assert.equal(geradas.find((c) => c.chave === "campo_vazio").tipo, "texto");
  });
});

test("a condição gerada TRADUZ, como qualquer outra", () => {
  return dinamicas(appFalso([{ alias: "convenio", tipo: "texto", name: "Convênio" }])).then(
    (geradas) => {
      const r = traduzir(
        { grupos: [{ condicoes: [{ campo: "campo_convenio", operador: "contem", valor: "uni" }] }] },
        "UTC",
        geradas
      );

      assert.deepEqual(r, { "customFields.convenio": { $regex: "uni", $options: "i" } });
    }
  );
});

test("sem as geradas em mãos, a condição delas é DESCARTADA — não vira consulta torta", () => {
  // Quem traduz precisa passar o catálogo gerado. Esquecer disso tem de
  // devolver `null`, e não um `$match` num campo inventado.
  assert.equal(
    traduzir({ grupos: [{ condicoes: [{ campo: "campo_convenio", operador: "contem", valor: "uni" }] }] }, "UTC"),
    null
  );
});

test("gerador que falha não derruba o filtro inteiro", () => {
  // O resto do catálogo continua servindo, e a condição que faltou some —
  // como uma que ainda não foi escrita.
  const quebrado = { api: { customField: { list: async () => { throw new Error("banco fora"); } } } };

  return dinamicas(quebrado).then((geradas) => assert.deepEqual(geradas, []));
});

test("o `objetivo` fixo SAIU — ele é nativo do catálogo de campos", () => {
  // Duas entradas para o mesmo campo é o que o `StudentForm` já cometeu uma
  // vez: "não recolocar à mão, apareceriam duas vezes".
  assert.ok(!catalogo().some((c) => c.chave === "objetivo"));
});

// ── OS SEIS DOMÍNIOS ───────────────────────────────────────────────────────
//
// *"quero condição de dieta, financeiro, avaliação física, aula coletiva,
// frequência, pendências — tudo"* (10/10/2026).
//
// Cada um mora em outra collection, e por isso cada condição declara a JUNÇÃO
// que precisa. O que estes casos seguram é o que não dá erro quando está
// errado: o campo da pessoa muda de nome entre as collections, e apontar para
// o errado devolve lista vazia — que parece "ninguém deve nada".

const { juntasDe } = require("../../lib/condicoes");
const instanceContext = require("../../lib/instance.js");

const CTX = { hoje: new Date("2026-10-10T12:00:00Z"), dia: "2026-10-10" };

// Montar os estágios exige CONTEXTO DE INSTÂNCIA, e isso não é detalhe de
// teste: o `$lookup` carimba o cliente dentro da sub-pipeline, porque o
// `lib/escopo.js` não alcança lá — sem ele a junção varreria os documentos de
// todos os clientes a cada pessoa da página. Chamar fora do contexto estoura,
// e é bom que estoure.
const estagiosDe = (chave) =>
  instanceContext.run("marlon", () => {
    const [junta] = juntasDe({ grupos: [{ condicoes: [{ campo: chave }] }] });
    return junta.estagios(CTX);
  });

test("as junções são deduplicadas por domínio", () => {
  // Três perguntas de frequência têm de custar UMA varredura de `checkins`,
  // e não três por pessoa da página.
  const arvore = {
    grupos: [
      {
        condicoes: [
          { campo: "frequencia_total", operador: "maior", valor: 5 },
          { campo: "frequencia_ultima", operador: "antes", valor: "2026-09-01" },
          { campo: "cobranca_aberta", operador: "e", valor: true },
        ],
      },
    ],
  };

  assert.deepEqual(juntasDe(arvore).map((j) => j.chave), ["freq", "fin"]);
});

test("sem condição de outro domínio, nenhuma junção sobe", () => {
  // A junção é cara e correlacionada por pessoa. A lista comum não pode pagar
  // por um filtro que quase ninguém usa.
  assert.deepEqual(juntasDe({ grupos: [{ condicoes: [{ campo: "email" }] }] }), []);
  assert.deepEqual(juntasDe(null), []);
});

test("cada domínio aponta para o campo de pessoa CERTO", () => {
  // `checkins` e `pendencies` dizem `person`; `charges`, `assessments` e
  // `diets` dizem `student`. Trocar não dá erro: devolve lista vazia.
  const campoDe = (chave) => {
    const [lookup] = estagiosDe(chave);
    const [{ $match: casa }] = lookup.$lookup.pipeline;
    return casa.$expr.$eq[0];
  };

  assert.equal(campoDe("frequencia_total"), "$person");
  assert.equal(campoDe("pendencia_aberta"), "$person");
  assert.equal(campoDe("cobranca_aberta"), "$student");
  assert.equal(campoDe("avaliacao_tem"), "$student");
  assert.equal(campoDe("dieta_vigente"), "$student");
  assert.equal(campoDe("aula_total"), "$person");
});

test("quem nunca veio tem ZERO, e não campo ausente", () => {
  // Um campo que não existe não casa com `$lt` nem com `$gte` — quem
  // filtrasse "menos de 3 visitas" perderia justamente quem tem zero.
  const [, campos] = estagiosDe("frequencia_total");

  assert.deepEqual(campos.$addFields.freqTotal.$ifNull[1], 0);
});

test("'tem cobrança vencida' lê a mais ANTIGA em aberto, sem segunda junção", () => {
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "cobranca_vencida", operador: "e", valor: true }] }] },
    "UTC",
    [],
    CTX
  );

  assert.deepEqual(r, { finPrimeira: { $lt: CTX.hoje } });
});

test("o valor em aberto é digitado em REAIS e comparado em centavos", () => {
  // `amount` está em centavos no banco. Quem digita "100" quer cem reais, e
  // comparar com 100 acharia quem deve um real.
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "cobranca_valor", operador: "maior", valor: "100" }] }] },
    "UTC",
    [],
    CTX
  );

  assert.deepEqual(r, { finSoma: { $gt: 10000 } });
});

test("a aula coletiva conta PRESENTE, e não inscrito", () => {
  // `inscrito` é "disse que vem". Contar inscrição como presença faria
  // "frequentou mais de 10 aulas" devolver quem só clica em "vou".
  const [lookup] = estagiosDe("aula_total");
  const recorte = lookup.$lookup.pipeline[1].$match;

  assert.deepEqual(recorte, { status: "presente" });
});

test("a dieta vigente compara com o DIA em texto, não com um instante", () => {
  // As datas das dietas são "AAAA-MM-DD". Comparar com um `Date` não casaria
  // com nada, e a lista viria vazia sem erro nenhum.
  const [lookup] = estagiosDe("dieta_vigente");
  const recorte = JSON.stringify(lookup.$lookup.pipeline[1].$match);

  assert.ok(recorte.includes("2026-10-10"));
  assert.ok(!recorte.includes("T12:00"));
});

test("o contexto é de AGORA — condição de vencimento não congela no boot", () => {
  // Guardar a data no módulo faria o servidor responder com o dia em que ele
  // subiu, e o defeito só apareceria no dia seguinte.
  const outroDia = { hoje: new Date("2027-01-01T00:00:00Z"), dia: "2027-01-01" };
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "cobranca_vencida", operador: "e", valor: true }] }] },
    "UTC",
    [],
    outroDia
  );

  assert.equal(r.finPrimeira.$lt.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("a junção carimba o CLIENTE dentro da sub-pipeline", () => {
  // `lib/escopo.js` não alcança dentro de um `$lookup`: a sub-pipeline é outra
  // consulta. Correção não depende disso (os ids são ObjectId, únicos
  // globais), mas desempenho sim — sem o carimbo, a junção varre os
  // documentos de TODOS os clientes a cada pessoa da página.
  const [lookup] = estagiosDe("frequencia_total");

  assert.equal(lookup.$lookup.pipeline[0].$match.instance, "marlon");
});

// ── A DIETA: MACROS E ALIMENTOS ────────────────────────────────────────────
//
// *"quero poder escolher dieta com kcal acima de ou abaixo etc., mesma coisa
// para carboidratos e gorduras, e também por alimento: tem o alimento x, não
// tem o alimento x"* (10/10/2026).
//
// ── POR QUE ESTA JUNÇÃO É A MAIS PESADA DO CATÁLOGO ──────────────────────
//
// Os totais NÃO estão gravados — `comTotais` os calcula na leitura, porque
// *"um total gravado é um total que pode discordar da lista logo abaixo
// dele"*. Então a junção refaz a mesma conta dentro do banco, e o que precisa
// ficar preso aqui é que ela a refaz IGUAL.

test("a junção da dieta apenas LÊ o resumo gravado", () => {
  // *"acho que seria bom salvar o total no mongo mesmo"* (10/10/2026). A
  // primeira versão desmontava refeição por refeição e alimento por alimento
  // DENTRO do banco, por pessoa da página, para refazer uma conta já feita
  // quando alguém salvou o plano.
  const [lookup] = estagiosDe("dieta_kcal");
  const etapas = lookup.$lookup.pipeline;

  // Nada de abrir arrays aqui: quem soma é `Diet_model.resumoDoPlano`, na
  // escrita.
  assert.ok(!etapas.some((e) => e.$unwind));
  assert.ok(etapas.some((e) => JSON.stringify(e).includes("$resumo.kcal")));
});

test("'tem o alimento' procura por CONTÉM, e escapa o que foi digitado", () => {
  // Ninguém digita "Frango grelhado 120g" — digita "frango". E um `.*` solto
  // devolveria toda dieta que existe.
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "dieta_alimento", operador: "contem", valor: "fran.go" }] }] },
    "UTC",
    [],
    CTX
  );

  assert.equal(r.dietaAlimentos.$regex, "fran\\.go");
  assert.equal(r.dietaAlimentos.$options, "i");
});

test("'não tem o alimento' pega também quem não tem dieta nenhuma", () => {
  // Quem não tem plano não tem frango. É a leitura certa da pergunta, e quem
  // quiser o contrário soma "dieta vigente".
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "dieta_alimento", operador: "nao_contem", valor: "frango" }] }] },
    "UTC",
    [],
    CTX
  );

  assert.ok(r.dietaAlimentos.$not instanceof RegExp);
});

test("os quatro macros existem e apontam para campos DIFERENTES", () => {
  // Escrever os quatro à mão seriam quatro chances de errar um nome — e
  // `carbs` respondendo com `fat` é um defeito que ninguém confere.
  // Pelo que a condição TRADUZ: `catalogo()` esconde o `campo` de propósito —
  // publicar o caminho no banco seria dizer a quem sonda exatamente o que
  // tentar.
  const campoDe = (m) => {
    const r = traduzir(
      { grupos: [{ condicoes: [{ campo: "dieta_" + m, operador: "maior", valor: 1 }] }] },
      "UTC",
      [],
      CTX
    );
    return Object.keys(r)[0];
  };

  const campos = ["kcal", "proteina", "carboidrato", "gordura"].map(campoDe);

  assert.deepEqual(campos, ["dietaKcal", "dietaProtein", "dietaCarbs", "dietaFat"]);
  assert.equal(new Set(campos).size, 4);
});

test("as seis condições de dieta compartilham UMA junção", () => {
  // Ela é a mais cara do catálogo: desmonta refeição por refeição dentro do
  // banco. Pedir duas seria pagar isso duas vezes por pessoa da página.
  const arvore = {
    grupos: [
      {
        condicoes: [
          { campo: "dieta_kcal", operador: "maior", valor: 2000 },
          { campo: "dieta_alimento", operador: "contem", valor: "frango" },
          { campo: "dieta_vigente", operador: "e", valor: true },
        ],
      },
    ],
  };

  assert.deepEqual(juntasDe(arvore).map((j) => j.chave), ["dieta"]);
});

test("o array de nomes é ACHATADO antes de virar consulta", () => {
  // São DOIS níveis desde que o resumo passou a ser gravado: um array de
  // nomes por dieta, e a pessoa pode ter mais de uma vigente. Sem achatar, o
  // `$regex` procuraria num array de arrays e não casaria com nada — e o
  // filtro diria que ninguém come frango.
  const [, campos] = estagiosDe("dieta_alimento");

  assert.ok(campos.$addFields.dietaAlimentos.$reduce);
  assert.ok(campos.$addFields.dietaAlimentos.$reduce.in.$concatArrays);
});

// ── AS AULAS COLETIVAS: QUAL, QUANTAS, QUANDO ──────────────────────────────
//
// *"em aulas coletivas, quero que tenha: frequentou a aula X, quantas vezes,
// última vez"* (10/10/2026).

test("as três perguntas de aula compartilham UMA junção", () => {
  const arvore = {
    grupos: [
      {
        condicoes: [
          { campo: "aula_total", operador: "maior", valor: 5 },
          { campo: "aula_ultima", operador: "antes", valor: "2026-09-01" },
          { campo: "aula_qual", operador: "e", valor: "000000000000000000000001" },
        ],
      },
    ],
  };

  assert.deepEqual(juntasDe(arvore).map((j) => j.chave), ["aula"]);
});

test("frequentar a mesma aula quatro vezes não faz quatro aulas", () => {
  // `$addToSet` e não `$push`: a pergunta é "frequentou esta aula?", e a
  // contagem de vezes é outra condição.
  const [lookup] = estagiosDe("aula_qual");
  const grupo = lookup.$lookup.pipeline.find((e) => e.$group);

  assert.ok(grupo.$group.lista.$addToSet);
});

test("'frequentou a aula X' só aceita um id de verdade", () => {
  assert.equal(
    traduzir({ grupos: [{ condicoes: [{ campo: "aula_qual", operador: "e", valor: "pilates" }] }] }, "UTC", [], CTX),
    null
  );

  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "aula_qual", operador: "e", valor: "000000000000000000000001" }] }] },
    "UTC",
    [],
    CTX
  );
  assert.equal(String(r.aulaLista), "000000000000000000000001");
});

test("'não frequentou' pega também quem nunca foi a aula nenhuma", () => {
  // Quem não vai a aula alguma não vai a esta. Leitura literal — quem quiser
  // o contrário soma "aulas que frequentou: mais de 0".
  const r = traduzir(
    { grupos: [{ condicoes: [{ campo: "aula_qual", operador: "nao_e", valor: "000000000000000000000001" }] }] },
    "UTC",
    [],
    CTX
  );

  assert.ok(r.aulaLista.$ne);
});

test("a lista de aulas é uma FONTE viva, resolvida pela tela", () => {
  // Aulas nascem e morrem o tempo todo. Um catálogo com as de ontem dentro
  // seria pior que nenhum.
  const def = catalogo().find((c) => c.chave === "aula_qual");

  assert.equal(def.fonte, "aulas");
});
