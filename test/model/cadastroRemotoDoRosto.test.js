const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Dispositivo = require("../../model/Dispositivo_model.js");

// O CADASTRO REMOTO DO ROSTO — a saga de três comandos.
//
// *"me lembro que pedi, para ser um dialog para também cadastrar as fotos que
// vão ser cadastradas na catraca"* (10/10/2026).
//
// ── POR QUE ISTO PRECISA DE TESTE ──────────────────────────────────────────
//
// Porque tudo aqui falha em SILÊNCIO, e do lado de fora os defeitos são
// indistinguíveis: uma pessoa parada na frente de uma porta que não abre.
//
// 1. A ORDEM. O id do usuário é escolhido pelo APARELHO e só se conhece na
//    resposta do primeiro comando. Enfileirar os três de uma vez mandaria a
//    foto para `user_id: undefined` — e o firmware recusa o lote inteiro sem
//    dizer por quê.
//
// 2. O SÓSIA. Clicar duas vezes em "liberar" não pode criar um segundo usuário
//    com o mesmo rosto: a frequência da pessoa se parte em duas e ninguém
//    percebe, porque as duas metades parecem corretas.
//
// 3. QUEM JÁ ESTÁ LÁ. Cadastrado na mão, na tela do aparelho, sem foto na
//    ficha — é exatamente a pessoa do *"está cadastrado e a catraca não
//    libera"*. Exigir foto dela recusaria o conserto por falta do que não faz
//    falta.
//
// 4. O ROSTO RECUSADO. O aparelho pode dizer "não achei rosto nessa imagem", e
//    essa frase precisa chegar em quem cadastrou. Sem isso o usuário existe,
//    está ligado à regra, não tem rosto — e a catraca "não funciona".

// ── AS DUAS LEITURAS PURAS ────────────────────────────────────────────────

test("o id criado é lido da resposta nua", () => {
  assert.equal(Dispositivo.lerIdCriado({ ids: [8] }), 8);
});

test("o id criado é lido da resposta EMBRULHADA em response", () => {
  // É assim que este firmware fala quando a resposta atravessa o push: JSON
  // dentro de JSON. Ler só a forma nua deixaria a saga parada no passo 1, para
  // sempre, sem erro nenhum.
  assert.equal(Dispositivo.lerIdCriado({ response: '{"ids":[37]}' }), 37);
});

test("sem id na resposta, não se inventa um", () => {
  // Zero é o caso perigoso: `user_id: 0` no iDFace é "não reconheci quem está
  // na minha frente", e um vínculo apontando para ele ligaria toda passagem
  // desconhecida a uma pessoa de verdade.
  assert.equal(Dispositivo.lerIdCriado({ ids: [0] }), null);
  assert.equal(Dispositivo.lerIdCriado({ ids: [] }), null);
  assert.equal(Dispositivo.lerIdCriado({ response: "não sou json" }), null);
  assert.equal(Dispositivo.lerIdCriado({}), null);
});

test("a foto aceita vem com success e sem erros", () => {
  const r = Dispositivo.lerResultadoDaFoto({
    results: [{ user_id: 8, success: true, scores: { sharpness_quality: 700 } }],
  });

  assert.equal(r.ok, true);
  assert.equal(r.erro, "");
});

test("a foto recusada traz a mensagem do firmware, inteira", () => {
  // Sem tradução nossa: no dia em que ele inventar um código novo, uma frase
  // nossa seria uma frase errada.
  const r = Dispositivo.lerResultadoDaFoto({
    response: '{"results":[{"user_id":8,"success":false,"errors":[{"code":2,"message":"No face found"}]}]}',
  });

  assert.equal(r.ok, false);
  assert.equal(r.erro, "No face found");
});

test("success true COM erros ainda é recusa", () => {
  const r = Dispositivo.lerResultadoDaFoto({
    results: [{ user_id: 8, success: true, errors: [{ code: 8, message: "Low sharpness" }] }],
  });

  assert.equal(r.ok, false);
});

// ── A SAGA, COM O BANCO DE MENTIRA ────────────────────────────────────────

const APARELHO = new ObjectId("000000000000000000000001");
const PESSOA = new ObjectId("000000000000000000000002");

// Uma imagem minúscula, mas JPEG de verdade no que importa aqui: o mime vem do
// documento do avatar, não dos bytes.
const BYTES = Buffer.from("imagem");

function montar({
  regraDaPorta = 2,
  avatar = { mime: "image/jpeg", data: BYTES },
  vinculos = [],
  cadastro = {},
} = {}) {
  const comandos = [];
  const gravados = [...vinculos];

  const modelo = new Dispositivo({
    api: {
      avatar: { data: async () => avatar },
      user: { data: async () => ({ name: "Marlon" }) },
    },
  });

  modelo.collection = async () => ({
    findOne: async () => ({
      _id: APARELHO,
      nome: "Entrada",
      cadastro: { regraDaPorta, ...cadastro },
    }),
  });

  modelo.colecaoDeComandos = async () => ({
    insertOne: async (doc) => comandos.push(doc),
  });

  modelo.colecaoDeVinculos = async () => ({
    // `situacaoNaPorta` varre os vínculos da pessoa em TODOS os aparelhos de
    // uma vez, em vez de um `findOne` por leitor.
    find: (filtro) => ({
      toArray: async () =>
        gravados.filter((v) => !filtro.person || String(v.person) === String(filtro.person)),
    }),
    findOne: async (filtro) =>
      gravados.find(
        (v) =>
          (!filtro.person || String(v.person) === String(filtro.person)) &&
          (!filtro.usuarioNoAparelho || v.usuarioNoAparelho === filtro.usuarioNoAparelho)
      ) || null,
    deleteOne: async (filtro) => {
      const i = gravados.findIndex((v) => v === filtro._id || v._id === filtro._id);
      if (i >= 0) gravados.splice(i, 1);
    },
    updateOne: async (filtro, mudanca) => {
      const achado = gravados.find(
        (v) => v.usuarioNoAparelho === filtro.usuarioNoAparelho
      );
      if (achado) Object.assign(achado, mudanca.$set);
      else gravados.push({ ...filtro, ...mudanca.$set });
    },
  });

  // O `cadastro` vai junto: é dele que `situacaoNaPorta` tira a data da
  // leitura e a lista de quem tem rosto. Sem ele o dublê respondia "não sei"
  // por falta de dado, e os testes passavam pelo motivo errado.
  modelo.listar = async () => [
    { _id: APARELHO, nome: "Entrada", cadastro: { regraDaPorta, ...cadastro } },
  ];

  return { modelo, comandos, gravados };
}

test("liberar alguém novo manda UM comando: criar o usuário", async () => {
  const { modelo, comandos } = montar();

  const r = await modelo.cadastrarNoAparelho(APARELHO, PESSOA);

  assert.equal(r.criando, true);
  assert.equal(comandos.length, 1);
  assert.equal(comandos[0].endpoint, "create_objects");
  assert.equal(comandos[0].body.object, "users");
  // A matrícula é o NOSSO id — é o fio que reconstrói o vínculo se a resposta
  // deste comando se perder.
  assert.equal(comandos[0].body.values[0].registration, String(PESSOA));
  // E o bilhete que faz a saga continuar quando o `/result` chegar.
  assert.equal(comandos[0].prosseguir.tipo, "cadastro");
});

test("a foto e a regra saem SÓ depois que o aparelho devolve o id", async () => {
  const { modelo, comandos, gravados } = montar();

  await modelo.cadastrarNoAparelho(APARELHO, PESSOA);
  const criar = comandos[0];

  await modelo.prosseguirCadastro(APARELHO, { ...criar, dispositivo: APARELHO }, { ids: [9] });

  assert.equal(comandos.length, 3);
  assert.equal(comandos[1].endpoint, "user_set_image_list");
  assert.equal(comandos[1].body.user_images[0].user_id, 9);
  assert.equal(comandos[1].body.user_images[0].image, BYTES.toString("base64"));
  // BOOLEANO, não 1: a doc diz "0 ou 1" e o firmware recusa o lote inteiro
  // com `Invalid member 'match' (boolean expected, got uint64)`.
  assert.equal(comandos[1].body.match, true);

  assert.equal(comandos[2].endpoint, "create_objects");
  assert.equal(comandos[2].body.object, "user_access_rules");
  assert.deepEqual(comandos[2].body.values[0], { user_id: 9, access_rule_id: 2 });

  // O vínculo é gravado ANTES da foto e da regra: é ele que faz a próxima
  // batida virar check-in, e não depende de mais nada dar certo.
  assert.equal(gravados.length, 1);
  assert.equal(gravados[0].usuarioNoAparelho, "9");
});

test("sem id na resposta, a saga PARA — não cria nada e não repete", async () => {
  const { modelo, comandos, gravados } = montar();

  await modelo.cadastrarNoAparelho(APARELHO, PESSOA);
  await modelo.prosseguirCadastro(
    APARELHO,
    { ...comandos[0], dispositivo: APARELHO },
    { response: "erro qualquer" }
  );

  assert.equal(comandos.length, 1);
  assert.equal(gravados.length, 0);
});

test("liberar duas vezes NÃO cria um sósia", async () => {
  // O segundo clique encontra o vínculo e reaproveita o id que já é dele.
  const { modelo, comandos } = montar({
    vinculos: [{ dispositivo: APARELHO, person: PESSOA, usuarioNoAparelho: "9" }],
  });

  const r = await modelo.cadastrarNoAparelho(APARELHO, PESSOA);

  assert.equal(r.jaExistia, true);
  assert.equal(r.usuario, 9);
  assert.ok(!comandos.some((c) => c.body?.object === "users"));
  assert.equal(comandos[0].endpoint, "user_set_image_list");
  assert.equal(comandos[1].body.object, "user_access_rules");
});

test("quem já está no aparelho é liberado MESMO sem foto na ficha", async () => {
  // A pessoa do *"está cadastrado e a catraca não libera"*: cadastrada na mão,
  // na tela do leitor, e sem foto aqui. Exigir a foto recusaria o conserto.
  const { modelo, comandos } = montar({
    avatar: null,
    vinculos: [{ dispositivo: APARELHO, person: PESSOA, usuarioNoAparelho: "9" }],
  });

  const r = await modelo.cadastrarNoAparelho(APARELHO, PESSOA);

  assert.equal(r.usuario, 9);
  assert.equal(r.semFoto, true);
  assert.equal(comandos.length, 1);
  assert.equal(comandos[0].body.object, "user_access_rules");
});

test("cadastro NOVO sem foto é recusado, e com o motivo", async () => {
  // Criar um usuário sem rosto num leitor facial é criar um registro que nunca
  // vai abrir nada — e que depois confunde quem procura o defeito.
  const { modelo, comandos } = montar({ avatar: null });

  assert.equal((await modelo.cadastrarNoAparelho(APARELHO, PESSOA)).erro, "sem_foto");
  assert.equal(comandos.length, 0);
});

test("foto em webp é recusada AQUI, não pelo firmware", async () => {
  // O nosso upload aceita webp; o iDFace lê JPG e PNG. Recusar com nome é
  // melhor que mandar e receber um erro que ninguém sabe ler.
  const { modelo } = montar({ avatar: { mime: "image/webp", data: BYTES } });

  assert.equal((await modelo.cadastrarNoAparelho(APARELHO, PESSOA)).erro, "formato_da_foto");
});

test("foto acima do limite não sai daqui", async () => {
  // O aparelho recusa requisição acima de 1 MB e o base64 infla um terço.
  const { modelo } = montar({
    avatar: { mime: "image/jpeg", data: Buffer.alloc(800 * 1024) },
  });

  assert.equal((await modelo.cadastrarNoAparelho(APARELHO, PESSOA)).erro, "foto_grande");
});

test("sem a regra da porta lida, não se cadastra ninguém", async () => {
  // Cadastrar o rosto sem saber qual regra abre produz alguém que o aparelho
  // RECONHECE e não deixa entrar — o defeito de 09/10/2026, agora fabricado
  // por nós.
  // `null` é o que `lerCadastro` grava quando `portal_access_rules` volta
  // VAZIO — ou seja, o caso exato que esta guarda existe para pegar. Ela
  // deixava passar: a conferência era `Number.isFinite(Number(regra))`, e
  // `Number(null)` é zero. Enfileirava `access_rule_id: 0`, que não abre nada.
  const { modelo, comandos } = montar({ regraDaPorta: null });
  assert.equal((await modelo.cadastrarNoAparelho(APARELHO, PESSOA)).erro, "sem_regra");
  assert.equal(comandos.length, 0);

  // E zero dito com todas as letras também não é regra.
  const zero = montar({ regraDaPorta: 0 });
  assert.equal((await zero.modelo.cadastrarNoAparelho(APARELHO, PESSOA)).erro, "sem_regra");
  assert.equal(zero.comandos.length, 0);
});

test("a recusa da foto fica gravada no vínculo", async () => {
  const { modelo, gravados } = montar({
    vinculos: [{ dispositivo: APARELHO, person: PESSOA, usuarioNoAparelho: "9" }],
  });

  await modelo.guardarResultadoDaFoto(
    { dispositivo: APARELHO, prosseguir: { tipo: "foto", usuario: 9 } },
    { results: [{ user_id: 9, success: false, errors: [{ code: 2, message: "No face found" }] }] }
  );

  assert.equal(gravados[0].fotoErro, "No face found");
  assert.equal(gravados[0].fotoEm, null);
});

test("bloquear derruba a regra e NÃO apaga o rosto", async () => {
  // Quem volta a pagar na quinta entra na quinta, sem posar de novo na frente
  // do leitor.
  const { modelo, comandos } = montar({
    vinculos: [{ dispositivo: APARELHO, person: PESSOA, usuarioNoAparelho: "9" }],
  });

  const r = await modelo.sincronizarPassagem(PESSOA, false);

  assert.equal(comandos.length, 1);
  assert.equal(comandos[0].endpoint, "destroy_objects");
  assert.equal(comandos[0].body.object, "user_access_rules");
  assert.deepEqual(comandos[0].body.where, { user_access_rules: { user_id: 9 } });
  assert.equal(r[0].usuario, 9);
  // Nada de `destroy_objects` em `users`: o rosto fica.
  assert.ok(!comandos.some((c) => c.body?.object === "users"));
});

test("bloquear quem nunca esteve no aparelho não manda comando nenhum", async () => {
  // Mandar assim mesmo traria `{"changes":0}` e a tela mostraria erro onde não
  // há erro.
  const { modelo, comandos } = montar();

  const r = await modelo.sincronizarPassagem(PESSOA, false);

  assert.equal(comandos.length, 0);
  assert.equal(r[0].semVinculo, true);
});

test("vínculo que aponta para usuário APAGADO no aparelho é descartado", async () => {
  // *"bom, exclui da catraca"* (10/10/2026) — apagar um usuário pela tela do
  // leitor é operação normal. Sem isto, o vínculo sobrevivente mandaria a foto
  // para um id que lá dentro não existe, e a pessoa seguiria sem passar com um
  // erro de firmware na tela.
  const { modelo, comandos, gravados } = montar({
    vinculos: [
      {
        _id: "v1",
        dispositivo: APARELHO,
        person: PESSOA,
        usuarioNoAparelho: "2",
        updatedAt: new Date("2026-10-10T14:00:00Z"),
      },
    ],
    // O aparelho contou a lista DEPOIS do vínculo, e o 2 não está nela.
    cadastro: { em: new Date("2026-10-10T15:00:00Z"), usuarios: [] },
  });

  const r = await modelo.cadastrarNoAparelho(APARELHO, PESSOA);

  assert.equal(r.criando, true);
  assert.equal(comandos[0].body.object, "users");
  assert.equal(gravados.length, 0);
});

test("leitura VELHA do aparelho não derruba vínculo nenhum", async () => {
  // A trava só vale quando há como saber. Uma lista lida ANTES do vínculo não
  // sabe dele — e desconfiar dela criaria o sósia que o vínculo existe para
  // evitar. Na dúvida, o vínculo fica.
  const { modelo, comandos } = montar({
    vinculos: [
      {
        _id: "v1",
        dispositivo: APARELHO,
        person: PESSOA,
        usuarioNoAparelho: "9",
        updatedAt: new Date("2026-10-10T16:00:00Z"),
      },
    ],
    cadastro: { em: new Date("2026-10-10T15:00:00Z"), usuarios: [] },
  });

  const r = await modelo.cadastrarNoAparelho(APARELHO, PESSOA);

  assert.equal(r.usuario, 9);
  assert.ok(!comandos.some((c) => c.body?.object === "users"));
});

test("a recusa do LOTE INTEIRO também é lida — ela não tem forma de resultado", async () => {
  // Quando o firmware não gosta do corpo, ele não devolve `results` nenhum:
  // devolve `{error, code}` solto. Era o caso do `match: 1`, e o leitor
  // devolvia `null` — a recusa não ia para o vínculo nem para o log, e o
  // cadastro falhava em silêncio.
  const r = Dispositivo.lerResultadoDaFoto({
    error: "Invalid member 'match' (boolean expected, got uint64)",
    code: 1,
  });

  assert.equal(r.ok, false);
  assert.match(r.erro, /boolean expected/);
});

test("a recusa do lote chega ao vínculo, para a tela poder contar", async () => {
  const { modelo, gravados } = montar({
    vinculos: [{ dispositivo: APARELHO, person: PESSOA, usuarioNoAparelho: "4" }],
  });

  await modelo.guardarResultadoDaFoto(
    { dispositivo: APARELHO, prosseguir: { tipo: "foto", usuario: 4 } },
    { error: "Invalid member 'match' (boolean expected, got uint64)", code: 1 }
  );

  assert.match(gravados[0].fotoErro, /boolean expected/);
});

// ── O REGISTRO DE ERROS ────────────────────────────────────────────────────
//
// *"salve os erros em uma collection separada para a gente tratar depois"*
// (10/10/2026). O que este bloco segura é a LEITURA: este firmware tem três
// formas de dizer "não", elas não se parecem, e deixar uma de fora é voltar ao
// cadastro que falha calado.

test("a recusa do lote inteiro é lida", () => {
  const r = Dispositivo.lerFalha({ error: "Invalid member 'match'", code: 1 });
  assert.equal(r.mensagem, "Invalid member 'match'");
  assert.equal(r.codigo, 1);
});

test("a recusa EMBRULHADA em response é lida", () => {
  const r = Dispositivo.lerFalha({ response: '{"error":"Node or attribute not found","code":3}' });
  assert.equal(r.mensagem, "Node or attribute not found");
  assert.equal(r.codigo, 3);
});

test("a recusa item a item é lida", () => {
  const r = Dispositivo.lerFalha({
    results: [{ user_id: 4, success: false, errors: [{ code: 2, message: "No face found" }] }],
  });
  assert.equal(r.mensagem, "No face found");
  assert.equal(r.codigo, 2);
});

test("o que deu CERTO não vira erro", () => {
  // O registro só vale se estiver vazio quando está tudo bem. Um log que
  // acumula sucesso é um log que ninguém abre.
  assert.equal(Dispositivo.lerFalha({ response: '{"ids":[4]}' }), null);
  assert.equal(Dispositivo.lerFalha({ results: [{ user_id: 4, success: true }] }), null);
  assert.equal(Dispositivo.lerFalha({ response: '{"changes":1}' }), null);
  assert.equal(Dispositivo.lerFalha({}), null);
});

test("a FOTO nunca entra no registro de erro", () => {
  // 40 KB de base64 por linha, e um acervo de rosto montado por acidente
  // dentro de um log — que é exatamente o que esta integração decidiu não ter.
  const limpo = Dispositivo.semImagem({
    match: true,
    user_images: [{ user_id: 4, timestamp: 123, image: "/9j/4AAQSkZJRgABAQ..." }],
  });

  assert.equal(limpo.user_images[0].image, "<foto>");
  assert.equal(limpo.user_images[0].user_id, 4);
  assert.equal(limpo.match, true);
});

// ── OS QUATRO ESTADOS DE UM PEDIDO ─────────────────────────────────────────
//
// *"pode registrar esses pedidos, e quando aparelho solicitar, registrar que o
// pedido foi 'respondido'"* (10/10/2026). Cada estado aponta para um culpado
// diferente, e confundi-los manda procurar o defeito no lugar errado.

test("sem ter saído, o pedido está NA FILA — o aparelho ainda não perguntou", () => {
  assert.equal(Dispositivo.estadoDoComando({ enviadoEm: null }), "na_fila");
});

test("saiu e não voltou: ENTREGUE — levou e não respondeu", () => {
  assert.equal(
    Dispositivo.estadoDoComando({ enviadoEm: new Date(), resultado: null }),
    "entregue"
  );
});

test("voltou bem: RESPONDIDO", () => {
  assert.equal(
    Dispositivo.estadoDoComando({ enviadoEm: new Date(), resultado: { response: '{"ids":[4]}' } }),
    "respondido"
  );
});

test("voltou com recusa: RECUSADO — e esse é defeito NOSSO", () => {
  assert.equal(
    Dispositivo.estadoDoComando({
      enviadoEm: new Date(),
      resultado: { error: "Invalid member 'match'", code: 1 },
    }),
    "recusado"
  );
});

// ── DUAS CONFIRMAÇÕES, E A MAIS NOVA GANHA ─────────────────────────────────
//
// O aparelho diz que tem o rosto de duas maneiras, em momentos diferentes:
// respondendo ao ENVIO (vira `fotoEm`) e listando os usuários depois
// (`image_timestamp` → `cadastro.comFoto`). A segunda é uma foto do passado.

const vinculoCom = (extra) => [{
  _id: "v1",
  dispositivo: APARELHO,
  person: PESSOA,
  usuarioNoAparelho: "4",
  ...extra,
}];

test("leitura VELHA não apaga uma foto que o aparelho acabou de aceitar", async () => {
  // O defeito, com print: a lista de usuários era das 17:35 e a foto foi
  // aceita às 18:04, com nitidez 956 — e a tela dizia "não sei dizer se o
  // rosto está gravado". Não saber e saber que sim são respostas diferentes.
  const { modelo } = montar({
    vinculos: vinculoCom({ fotoEm: new Date("2026-10-10T18:04:17Z"), fotoErro: "" }),
    cadastro: { em: new Date("2026-10-10T17:35:09Z"), comFoto: [] },
  });

  const [linha] = await modelo.situacaoNaPorta(PESSOA);
  assert.equal(linha.temRosto, true);
});

test("leitura NOVA que não lista a pessoa derruba a confirmação", async () => {
  // Aqui o aparelho falou depois, e disse que não tem. É "sei que não", e
  // vale mais que o nosso "mandamos e ele aceitou" de antes.
  const { modelo } = montar({
    vinculos: vinculoCom({ fotoEm: new Date("2026-10-10T17:00:00Z"), fotoErro: "" }),
    cadastro: { em: new Date("2026-10-10T18:30:00Z"), comFoto: [] },
  });

  const [linha] = await modelo.situacaoNaPorta(PESSOA);
  assert.equal(linha.temRosto, false);
});

test("sem envio e sem leitura, a resposta honesta é 'não sei'", async () => {
  const { modelo } = montar({ vinculos: vinculoCom({}), cadastro: {} });

  const [linha] = await modelo.situacaoNaPorta(PESSOA);
  assert.equal(linha.temRosto, null);
});

test("recusa registrada vence tudo — nem leitura nova a desfaz", async () => {
  const { modelo } = montar({
    vinculos: vinculoCom({ fotoEm: null, fotoErro: "No face found" }),
    cadastro: { em: new Date("2026-10-10T18:30:00Z"), comFoto: [4] },
  });

  const [linha] = await modelo.situacaoNaPorta(PESSOA);
  assert.equal(linha.temRosto, false);
  assert.equal(linha.recusa, "No face found");
});
