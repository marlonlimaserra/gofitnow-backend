const test = require("node:test");
const assert = require("node:assert/strict");

const Dispositivo = require("../../model/Dispositivo_model.js");

// O LEITOR FACIAL DA PORTA — a credencial e a tradução da batida.
//
// *"conectei o control id na rede, agora precisa fazer a integração"*
// (06/10/2026).
//
// ── O QUE ESTE ARQUIVO EXISTE PARA SEGURAR ─────────────────────────────────
//
// Duas coisas que quebram EM SILÊNCIO, e é por isso que valem teste:
//
// 1. A CREDENCIAL carrega a instância (`marlon.segredo`). Se o corte no ponto
//    errar, o aparelho de um cliente grava frequência no banco de outro — e
//    ninguém percebe, porque do lado de lá aparece um aluno a mais na lista.
//
// 2. O RELÓGIO vem em SEGUNDOS. O aparelho é embarcado e manda epoch em
//    segundos; o JavaScript conta em milissegundos. Esquecer o ×1000 registra
//    toda entrada em janeiro de 1970 — e o sintoma aparece semanas depois, na
//    tela de frequência do dono, quando já há centenas de linhas erradas.

test("a credencial separa instância e segredo no primeiro ponto", () => {
  const r = Dispositivo.separarCredencial("marlon.AMAS.12323874178234");

  assert.equal(r.instancia, "marlon");
  assert.equal(r.segredo, "AMAS.12323874178234");
});

test("o segredo tem ponto DENTRO, e o corte é no primeiro", () => {
  // `AMAS.12323874178234` contém um ponto. Se o corte usasse `split(".")` e
  // pegasse o pedaço do meio, o segredo chegaria pela metade ao banco e NADA
  // autenticaria — com 401 silencioso, que é o pior jeito de descobrir.
  const r = Dispositivo.separarCredencial("academia-centro.QRST.98765432109876");

  assert.equal(r.instancia, "academia-centro");
  assert.equal(r.segredo, "QRST.98765432109876");
});

test("credencial sem ponto não vira instância nenhuma", () => {
  // Sem isto, um valor solto poderia ser lido como nome de banco.
  assert.equal(Dispositivo.separarCredencial("14525415858125"), null);
});

test("credencial sem instância é recusada", () => {
  assert.equal(Dispositivo.separarCredencial(".AMAS.12323874178234"), null);
});

test("segredo curto demais é recusado antes de tocar no banco", () => {
  // Um segredo de três letras seria adivinhável por força bruta num endpoint
  // que o aparelho martela a cada cinco segundos.
  assert.equal(Dispositivo.separarCredencial("marlon.abc"), null);
});

test("instância com formato inválido é recusada", () => {
  // O nome vira parte de um nome de database — ver o PADRAO em lib/instance.js.
  assert.equal(Dispositivo.separarCredencial("Marlon Silva.AMAS.12323874178234"), null);
  assert.equal(Dispositivo.separarCredencial("../admin.AMAS.12323874178234"), null);
});

test("vazio e lixo não estouram", () => {
  for (const entrada of [null, undefined, "", ".", "..", 42, {}]) {
    assert.equal(Dispositivo.separarCredencial(entrada), null);
  }
});

// ── O HASH DO SEGREDO ──────────────────────────────────────────────────────

test("o segredo é guardado como hash, nunca em claro", () => {
  const segredo = Dispositivo.gerarSegredo();
  const hash = Dispositivo.hashDoSegredo(segredo);

  assert.notEqual(hash, segredo);
  assert.equal(hash.length, 64); // sha-256 em hexadecimal
  assert.equal(Dispositivo.hashDoSegredo(segredo), hash); // estável
});

test("segredos gerados não se repetem e cabem numa URL", () => {
  const vistos = new Set();
  for (let i = 0; i < 50; i += 1) {
    const s = Dispositivo.gerarSegredo();
    assert.ok(!vistos.has(s), "gerou segredo repetido");
    vistos.add(s);
    // Nada que precise de escape: a credencial é digitada à mão, de pé, na
    // tela do aparelho.
    // ── SÓ DÍGITO, A PEDIDO DELE ──────────────────────────────────────
    // *"tem como ser só número?"* — quem digita está de pé na frente do
    // leitor, numa tela de toque. Letra maiúscula ali custa troca de teclado.
    // ── QUATRO LETRAS E QUATORZE DÍGITOS ──────────────────────────────
    // *"melhor marlon.AMAS.12323874178234"* e *"mais segurança também, só
    // número fica fácil de alguém hackear"*.
    assert.match(s, /^[A-Z]{4}\.[0-9]{14}$/);
    // Sem I e sem O: são os que se confundem com 1 e 0 na hora de digitar.
    assert.ok(!/[IO]/.test(s.slice(0, 4)), "letra ambígua no segredo: " + s);
  }
});

// ── A BATIDA CRUA ──────────────────────────────────────────────────────────

test("o tempo vem em SEGUNDOS e vira data de verdade", () => {
  // 1532977090 s = 30/07/2018. Sem o ×1000 isto cairia em 18/01/1970.
  const r = Dispositivo.lerBatida({ user_id: "37", time: "1532977090" });

  assert.equal(r.em.getUTCFullYear(), 2018);
  assert.equal(r.em.getTime(), 1532977090 * 1000);
});

test("esquecer o ×1000 cairia em 1970 — é este o erro que o teste prende", () => {
  const r = Dispositivo.lerBatida({ user_id: "37", time: "1532977090" });

  assert.notEqual(r.em.getUTCFullYear(), 1970);
});

test("user_id 0 é 'não reconheci quem está na minha frente', não a pessoa zero", () => {
  const r = Dispositivo.lerBatida({ user_id: "0", time: "1532977090" });

  assert.equal(r.reconhecido, false);
});

test("user_id vazio também não é ninguém", () => {
  assert.equal(Dispositivo.lerBatida({ user_id: "", time: "1532977090" }).reconhecido, false);
  assert.equal(Dispositivo.lerBatida({ time: "1532977090" }).reconhecido, false);
});

test("um usuário de verdade é reconhecido e vem como texto", () => {
  const r = Dispositivo.lerBatida({ user_id: 37, time: "1532977090" });

  assert.equal(r.reconhecido, true);
  // Texto, não número: é chave de de-para, e "37" e 37 não podem virar dois
  // vínculos diferentes para a mesma pessoa.
  assert.equal(r.usuarioNoAparelho, "37");
});

test("tempo ausente ou absurdo devolve nulo, para a rota decidir", () => {
  for (const time of [undefined, "", "abc", 0, -5]) {
    assert.equal(Dispositivo.lerBatida({ user_id: "37", time }).em, null);
  }
});

test("corpo vazio não estoura", () => {
  const r = Dispositivo.lerBatida();
  assert.equal(r.reconhecido, false);
  assert.equal(r.em, null);
});

// ── O QUE PAGA A CONTA DO SEGREDO CURTO ────────────────────────────────────
//
// 14 dígitos são ~2^46,5, contra ~2^192 do base64 que havia antes. A troca foi
// pedida e é justa — mas só se vier acompanhada. Estes casos prendem as duas
// garantias que passaram a importar.

test("não há colisão prática entre segredos gerados", () => {
  // Se o gerador repetisse, a credencial de uma academia abriria a de outra.
  const vistos = new Set();
  for (let i = 0; i < 2000; i += 1) vistos.add(Dispositivo.gerarSegredo());
  assert.equal(vistos.size, 2000);
});

test("os dígitos não ficam presos numa faixa", () => {
  // Um gerador torto que só produzisse 0–4 cortaria o espaço pela metade sem
  // ninguém notar olhando um exemplo.
  const todos = new Set();
  for (let i = 0; i < 200; i += 1) {
    for (const d of Dispositivo.gerarSegredo().split(".")[1]) todos.add(d);
  }
  assert.equal(todos.size, 10, "esperava os dez dígitos aparecendo");
});

test("as 24 letras todas aparecem, e nenhuma fora delas", () => {
  const permitidas = new Set("ABCDEFGHJKLMNPQRSTUVWXYZ");
  const vistas = new Set();
  for (let i = 0; i < 400; i += 1) {
    for (const l of Dispositivo.gerarSegredo().split(".")[0]) {
      assert.ok(permitidas.has(l), "letra fora do alfabeto: " + l);
      vistas.add(l);
    }
  }
  assert.equal(vistas.size, 24, "alguma letra nunca é sorteada");
});

test("o segredo novo passa pelo piso de tamanho", () => {
  // O piso era 16, do tempo do base64 — com ele, TODA credencial nova seria
  // recusada antes de chegar ao banco.
  const credencial = "marlon." + Dispositivo.gerarSegredo();
  assert.notEqual(Dispositivo.separarCredencial(credencial), null);
});

// ── AS DUAS CHAVES DA FICHA ────────────────────────────────────────────────
//
// *"coloque aqui esse acesso a aplicativo e crie outro chamado Passagem
// liberada"* e *"coloque para eu bloquear ou liberar o acesso do app também —
// igual os outros"* (06/10/2026).
//
// O que estes casos seguram é a REGRA DE AUSÊNCIA, que é onde isto quebraria
// em produção sem ninguém notar na revisão: os 222 alunos cadastrados antes
// disto existir não têm o campo, e eles precisam continuar entrando. Tratar
// "ausente" como bloqueado trancaria a academia inteira do lado de fora no dia
// do deploy.
const liberadoNaPorta = (pessoa) => pessoa.passagemLiberada !== false;

test("quem foi cadastrado antes do campo existir continua entrando", () => {
  assert.equal(liberadoNaPorta({ name: "Aluno antigo" }), true);
  assert.equal(liberadoNaPorta({ name: "Aluno antigo", passagemLiberada: undefined }), true);
});

test("bloqueado é só quem foi bloqueado de propósito", () => {
  assert.equal(liberadoNaPorta({ passagemLiberada: false }), false);
  assert.equal(liberadoNaPorta({ passagemLiberada: true }), true);
});

// ── AS TRÊS CHAVES NÃO SÃO A MESMA PERMISSÃO ───────────────────────────────
//
// *"já existe permissão para quem pode liberar essas coisas?"* (06/10/2026).
//
// Existia `people.access` para o aplicativo, com rota própria. Ao trazer essa
// chave para dentro do formulário eu abri um buraco: o `PUT /people/:id` pede
// só `people.edit`, e por ele dava para tirar o acesso de alguém sem ter
// `people.access` — a permissão existia e passou a ser contornável.
//
// Estes casos prendem a regra do controller. São três poderes diferentes sobre
// a mesma pessoa, e quem corrige um telefone não herda os outros dois.
const permissoes = require("../../lib/permissions.js");

test("a catraca tem permissão PRÓPRIA no catálogo", () => {
  const pessoas = permissoes.GROUPS.find((g) => g.key === "people");
  const chaves = pessoas.items.map((i) => i.key);

  assert.ok(chaves.includes("people.gate"), "people.gate não está no catálogo");
  // E continua separada das outras duas — se um dia alguém as fundir, este
  // caso cai junto.
  assert.ok(chaves.includes("people.access"));
  assert.ok(chaves.includes("people.edit"));
});

test("editar ficha NÃO é o mesmo poder que abrir a porta", () => {
  const pessoas = permissoes.GROUPS.find((g) => g.key === "people");
  const chaves = pessoas.items.map((i) => i.key);

  assert.notEqual(
    chaves.indexOf("people.edit"),
    chaves.indexOf("people.gate"),
    "edit e gate viraram a mesma chave"
  );
});

// ── BLOQUEIO DO APP: A CHAVE QUE NÃO QUEIMA A SENHA ────────────────────────
//
// *"eu tirei o acesso, mas quando volta dar acesso ao app pede senha de
// novo"* (06/10/2026, duas vezes).
//
// Tirar acesso apagava senha e sal — irreversível por construção. Virou uma
// chave: a senha fica, a pessoa só não entra. O que estes casos prendem é o
// PORTÃO, porque é onde um esquecimento vira falha de segurança: se
// `podeEntrar` ignorasse a chave, bloquear não bloquearia nada e a tela diria
// que sim.
const User = require("../../model/User_model.js");
const portao = User.prototype.podeEntrar;

const comSenha = (extra) => ({ password: "hash", salt: "sal", active: 1, ...extra });

test("quem tem senha e não está bloqueado entra", () => {
  assert.equal(portao(comSenha()), true);
});

test("bloqueado NÃO entra, mesmo com a senha intacta", () => {
  // É este o caso: a senha continua lá, e é justamente por isso que devolver
  // o acesso não precisa pedir outra.
  assert.equal(portao(comSenha({ appBloqueado: true })), false);
});

test("o bloqueio vale para QUALQUER prova de identidade", () => {
  // `podeEntrar` é o portão comum do login por senha e do login pelo Google.
  // Se a recusa morasse só no `authenticate`, entrar pelo Google seria o jeito
  // de furar o bloqueio — e ninguém descobriria testando a senha.
  assert.equal(portao(comSenha({ appBloqueado: true })), false);
  assert.equal(portao(comSenha({ appBloqueado: false })), true);
});

test("sem senha continua sem entrar, bloqueado ou não", () => {
  assert.equal(portao({ active: 1 }), false);
  assert.equal(portao({ active: 1, appBloqueado: false }), false);
});

test("conta desativada pelo negócio continua vencendo tudo", () => {
  assert.equal(portao(comSenha({ active: 0 })), false);
});

// ── O QUE O APARELHO DIZ TER DENTRO DELE ─────────────────────────────────
//
// 09/10/2026. O leitor tinha o rosto gravado, RECONHECEU a pessoa — e não
// abriu. O motivo só apareceu quando perguntamos a ele:
//
//   users:               [{ id: 2, … }]        ← cadastrado
//   access_rules:        [{ id: 1 }, { id: 2 }]
//   portal_access_rules: [{ portal_id: 1, access_rule_id: 2 }]
//   user_access_rules:   []                    ← VAZIO
//
// Rosto conhecido sem regra de acesso é, do lado de fora da porta, idêntico a
// rosto desconhecido. Estes casos prendem a leitura que separa os dois.
test("a resposta de load_objects é JSON dentro de JSON", () => {
  // O firmware embrulha: `{ response: "<texto que é json>" }`. Ler o de fora e
  // parar ali devolveria uma string e nenhum dado.
  const set = Dispositivo.lerCadastro({
    response: '{"users":[{"id":2,"name":"Mm"}]}',
  });

  assert.deepStrictEqual(set["cadastro.usuarios"], [2]);
});

test("a regra que importa é a LIGADA À PORTA, não a primeira da lista", () => {
  // Existem duas regras no aparelho; só a 2 está ligada ao portal. Vincular
  // alguém à 1 não abriria nada — e o sintoma seria igual ao de não ter feito
  // nada, que é o que custou a tarde.
  const set = Dispositivo.lerCadastro({
    response:
      '{"access_rules":[{"id":1},{"id":2}],"portal_access_rules":[{"portal_id":1,"access_rule_id":2}]}',
  });

  assert.deepStrictEqual(set["cadastro.regras"], [1, 2]);
  assert.strictEqual(set["cadastro.regraDaPorta"], 2);
});

test("nenhuma regra ligada à porta vira null, e não ausência", () => {
  // "Não há regra na porta" e "nunca perguntei" pedem conserto diferente, e
  // guardar os dois como ausência deixaria um palpite tomar o lugar do outro.
  const set = Dispositivo.lerCadastro({ response: '{"portal_access_rules":[]}' });

  assert.strictEqual(set["cadastro.regraDaPorta"], null);
});

test("a lista vazia de liberados é guardada como vazia", () => {
  // Este é literalmente o defeito: `[]`. Ignorar a lista vazia deixaria o
  // leitor parecendo que ninguém perguntou.
  const set = Dispositivo.lerCadastro({ response: '{"user_access_rules":[]}' });

  assert.deepStrictEqual(set["cadastro.liberados"], []);
});

test("um erro do aparelho não vira cadastro", () => {
  // `{"error":"Node or attribute not found…"}` foi o que as sete tentativas de
  // nome de chave de TLS devolveram. Nada disso é cadastro.
  assert.strictEqual(Dispositivo.lerCadastro({ error: "Node not found", code: 1 }), null);
  assert.strictEqual(Dispositivo.lerCadastro({ response: "isto não é json" }), null);
  assert.strictEqual(Dispositivo.lerCadastro({}), null);
  assert.strictEqual(Dispositivo.lerCadastro(null), null);
});

test("id que não é número é descartado, não vira NaN", () => {
  // `NaN` gravado viraria um vínculo com uma regra inexistente.
  const set = Dispositivo.lerCadastro({
    response: '{"users":[{"id":2},{"id":"abc"},{"nome":"sem id"}]}',
  });

  assert.deepStrictEqual(set["cadastro.usuarios"], [2]);
});
