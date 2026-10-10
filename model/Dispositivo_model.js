const { ObjectId } = require("mongodb");
const crypto = require("node:crypto");
const instanceContext = require("../lib/instance.js");
const arquivos = require("../lib/arquivos.js");

// OS LEITORES DA PORTA — hoje o Control iD iDFace, amanhã o que vier.
//
// ── O PROBLEMA QUE ESTE ARQUIVO RESOLVE ────────────────────────────────────
//
// Um leitor facial não faz login. Ele não tem navegador, não guarda sessão e
// não manda cabeçalho nosso: ele foi configurado uma vez, numa tela de toque,
// com um endereço e nada mais. Então a credencial dele tem de caber NO
// ENDEREÇO — é o único campo que existe.
//
// E tem um segundo problema, pior: o banco é um só, separado por `instance`, e
// quem diz a instância é o `instanceGate` lendo cabeçalho ou subdomínio. O
// leitor não manda nem um nem outro. Sem instância, os modelos estouram de
// propósito (ver `lib/instance.js`), e com razão: um `undefined` que virasse "o
// banco padrão" gravaria a entrada de um aluno na academia de outro cliente.
//
// ── A SAÍDA: A CREDENCIAL CARREGA A INSTÂNCIA ──────────────────────────────
//
//     https://backend.vafit.app/cid/marlon.AMAS.12323874178234/dao
//                                     └──┬──┘ └──┬──┘
//                                   instância   segredo
//
// É o mesmo desenho do `state` na volta do login do Google: quem chega de fora
// sem cabeçalho nenhum traz a instância embrulhada no que ele carrega, e o
// servidor confere antes de abrir o banco.
//
// A instância NÃO é segredo — é nome de subdomínio, está na cara de todo mundo.
// Quem autentica é o segredo, e dele guardamos só o hash: um vazamento do banco
// não entrega o que configurar num leitor.
//
// ── POR QUE UM REGISTRO POR APARELHO, E NÃO UM POR ACADEMIA ────────────────
//
// Porque o dia em que houver um leitor na entrada e outro na sala de
// musculação, revogar o da musculação não pode derrubar a entrada. E porque o
// `dispositivo` do check-in existe justamente para separar os dois na
// frequência.
function Dispositivo_model(app) {
  this.app = app;
}

Dispositivo_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("access_devices");
};

// ── O SEGREDO: QUATRO LETRAS E QUATORZE DÍGITOS ───────────────────────────
//
//     marlon.AMAS.12323874178234
//     └──┬─┘ └─┬┘ └──────┬─────┘
//   instância letras   dígitos
//
// Começou como base64url de 32 caracteres. Virou só dígito a pedido dele —
// *"tá muito grande, vai ser uma merda pra colocar, tem como ser só número?"*
// — e aí ele mesmo puxou de volta: *"mais segurança também, só número fica
// fácil de alguém hackear"*. Ele está certo, e a conta mostra por quê:
//
//   base64, 32 caracteres  ~2^192   seguro demais para o que protege
//   14 dígitos             ~2^46,5  defensável só com as duas travas do controller
//   4 letras + 14 dígitos  ~2^65    volta a se sustentar sozinho
//
// As quatro letras valem 24^4 (~2^18,3) e custam uma troca de teclado na tela
// do aparelho. É o preço que ele aceitou pagar, e compra 18 bits.
//
// ── POR QUE 24 LETRAS, E NÃO 26 ───────────────────────────────────────────
//
// Fora `I` e `O`. Quem digita está de pé na frente de um leitor, lendo de uma
// tela de celular, e `I`/`1` e `O`/`0` são o par que todo mundo troca. Dois
// bits a menos valem menos que uma ligação de "não está aceitando a senha".
//
// ── POR QUE O PONTO NO MEIO NÃO ATRAPALHA ─────────────────────────────────
//
// `separarCredencial` corta no PRIMEIRO ponto: o que vem antes é a instância,
// todo o resto é o segredo — ponto interno incluído. Nome de instância nunca
// tem ponto (ver o PADRAO em `lib/instance.js`), então o primeiro é sempre o
// divisor certo.
const LETRAS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sem I e sem O
const QUANTAS_LETRAS = 4;
const QUANTOS_DIGITOS = 14;

function gerarSegredo() {
  let letras = "";
  for (let i = 0; i < QUANTAS_LETRAS; i += 1) {
    letras += LETRAS[crypto.randomInt(0, LETRAS.length)];
  }

  let digitos = "";
  // Dígito a dígito, com sorteio criptográfico em cada um. Montar a partir de
  // um inteiro grande esbarraria no limite de precisão do Number.
  for (let i = 0; i < QUANTOS_DIGITOS; i += 1) digitos += String(crypto.randomInt(0, 10));

  return letras + "." + digitos;
}

// SHA-256 e não bcrypt, de propósito: este segredo tem 192 bits de entropia
// gerados por nós, não é senha escolhida por gente. Contra força bruta num
// hash de 192 bits aleatórios, o custo do bcrypt não compra nada — e aqui ele
// custaria caro, porque o leitor bate neste endpoint a cada poucos segundos.
function hashDoSegredo(segredo) {
  return crypto.createHash("sha256").update(String(segredo)).digest("hex");
}

// Comparação em tempo constante: o segredo é verificado a cada requisição do
// leitor, e um `===` vaza o tamanho do prefixo correto pelo tempo de resposta.
function iguais(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Separa `instancia.segredo`. O ponto é o divisor porque o segredo é base64url,
// que nunca contém ponto, e o nome de instância também não (ver o PADRAO em
// `lib/instance.js`). Então o primeiro ponto é sempre o certo.
function separarCredencial(credencial) {
  const texto = String(credencial || "");
  const ponto = texto.indexOf(".");
  if (ponto <= 0) return null;

  const instancia = instanceContext.normalize(texto.slice(0, ponto));
  const segredo = texto.slice(ponto + 1);
  // 12 e não 16: o segredo passou a ter 14 dígitos. O piso existe para barrar
  // "marlon.1" antes de qualquer consulta ao banco, não para validar formato.
  if (!instancia || segredo.length < 12) return null;

  return { instancia, segredo };
}

Dispositivo_model.prototype.separarCredencial = separarCredencial;

// ── ACHAR O APARELHO PELA CREDENCIAL ───────────────────────────────────────
//
// Roda JÁ DENTRO do contexto da instância — quem chama é o controller, depois
// de ter conferido na central que a instância existe. Aqui só resta saber se o
// segredo é de alguém.
// ── UM APARELHO, DUAS CREDENCIAIS ─────────────────────────────────────────
//
// A segunda existe por uma razão concreta: o canal de MONITOR não se configura
// na tela do aparelho — só pela API —, e o aparelho está atrás do roteador da
// academia, fora do nosso alcance. A saída é mandar a configuração pelo canal
// de push, que já está aberto.
//
// Só que para montar o endereço do monitor é preciso o segredo EM CLARO, e nós
// guardamos só o hash. Gerar outro e trocar resolveria — mas trocaria também o
// do push, e se o comando falhasse no meio o aparelho ficaria sem nenhum
// caminho de volta. Seria tirar a escada enquanto se está em cima dela.
//
// Então o monitor ganha uma credencial PRÓPRIA. O push continua com a dele,
// intocado, e um comando que falhe não derruba nada.
Dispositivo_model.prototype.porSegredo = async function (segredo) {
  const hash = hashDoSegredo(segredo);
  const col = await this.collection();
  const doc = await col.findOne({
    $or: [{ segredoHash: hash }, { segredoDoMonitorHash: hash }],
    ativo: { $ne: false },
  });
  if (!doc) return null;

  // Confere de novo em tempo constante, contra a que casou. A busca por hash já
  // é exata, mas se um dia a consulta virar por prefixo ou índice parcial, esta
  // linha continua valendo — e ela custa microssegundos.
  const casou = doc.segredoHash === hash ? doc.segredoHash : doc.segredoDoMonitorHash;
  if (!casou || !iguais(casou, hash)) return null;

  // QUAL das duas casou. Desde que o monitor passou a andar em texto puro na
  // porta 80, saber isso deixou de ser detalhe: é o que permite ao controller
  // recusar o segredo do PUSH numa requisição sem TLS. Não é persistido — vale
  // para esta requisição e morre com ela.
  doc.canal = doc.segredoHash === hash ? "push" : "monitor";

  return doc;
};

// ── CRIAR ──────────────────────────────────────────────────────────────────
//
// Devolve o segredo EM CLARO uma única vez, como toda chave de API deste
// backend. Quem não copiou agora gera outro — é mais honesto que guardar
// recuperável.
Dispositivo_model.prototype.criar = async function (dados = {}) {
  const col = await this.collection();
  const segredo = gerarSegredo();

  const doc = {
    nome: String(dados.nome || "").trim().slice(0, 80) || "Leitor da entrada",
    // O `deviceId` do aparelho chega sozinho na primeira batida (ele se
    // identifica em toda requisição). Nasce vazio de propósito: pedir que
    // alguém digite o número de série antes de instalar é um passo a mais para
    // errar, e o aparelho já sabe dizer quem é.
    deviceId: "",
    unit: ObjectId.isValid(dados.unit) ? new ObjectId(String(dados.unit)) : null,
    segredoHash: hashDoSegredo(segredo),
    ativo: true,
    // ── A CATRACA HONRA AS PENDÊNCIAS? ────────────────────────────────────
    //
    // Desligado por padrão, e isso é escolha. Pendência nasceu explicitamente
    // sem travar nada — *"só cadastra como pendência, não precisa travar até o
    // login dele no app"* — e um leitor novo que começasse barrando gente por
    // causa de uma camiseta não entregue seria uma surpresa na porta da
    // academia, no primeiro dia.
    bloquearComPendencia: false,
    ultimoContato: null,
    serie: "",
    firmware: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const r = await col.insertOne(doc);

  return {
    ...doc,
    _id: r.insertedId,
    // `instancia.segredo` — a credencial inteira, pronta para colar na tela do
    // aparelho. Montada aqui porque é o único lugar que tem o segredo em claro.
    credencial: instanceContext.required() + "." + segredo,
  };
};

// ── GERAR OUTRA CREDENCIAL ─────────────────────────────────────────────────
//
// *"eita. permita ver a url de novo"* (06/10/2026) — e não dá: guardamos só o
// hash. Mostrar de novo exigiria guardar recuperável, que é o oposto do que a
// palavra "segredo" promete.
//
// O que dá é trocar. E isso não é um remendo para quem fechou a janela sem
// copiar: é a operação que faz falta no dia em que a credencial vazar, o
// aparelho for roubado ou o técnico que a instalou sair da empresa.
//
// ── O VÍNCULO COM O APARELHO É DESFEITO JUNTO ─────────────────────────────
//
// `deviceId` volta a vazio de propósito. Credencial nova quer dizer aparelho
// reconfigurado — pode ser outro aparelho —, e manter a trava apontando para o
// anterior recusaria justamente o leitor novo, com 401 e nenhuma pista do
// motivo.
Dispositivo_model.prototype.novaCredencial = async function (id) {
  if (!ObjectId.isValid(id)) return null;

  const segredo = gerarSegredo();
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(String(id)) },
    {
      $set: {
        segredoHash: hashDoSegredo(segredo),
        deviceId: "",
        ultimoContato: null,
        updatedAt: new Date(),
      },
    }
  );

  if (!r.matchedCount) return null;
  return instanceContext.required() + "." + segredo;
};

// ── CONFIGURAR O MONITOR À DISTÂNCIA ──────────────────────────────────────
//
// Enfileira um `set_configuration` para o aparelho buscar no próximo push. Ele
// aplica, e a partir daí cada passagem de aluno chega como `dao`.
//
// `request_timeout` em 5000: é o que a Control iD documenta como padrão. Um
// valor curto demais faz o aparelho desistir de avisar e PERDER o evento —
// e evento de catraca perdido não volta.
Dispositivo_model.prototype.configurarMonitor = async function (id, host) {
  if (!ObjectId.isValid(id)) return null;

  const segredo = gerarSegredo();
  const credencial = instanceContext.required() + "." + segredo;

  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(String(id)) },
    { $set: { segredoDoMonitorHash: hashDoSegredo(segredo), updatedAt: new Date() } }
  );
  if (!r.matchedCount) return null;

  await this.enfileirarComando(id, {
    verb: "POST",
    endpoint: "set_configuration",
    body: {
      monitor: {
        request_timeout: "5000",
        hostname: String(host),
        // ── PORTA 80, EM TEXTO PURO, E POR QUE NAO HA ESCOLHA ───────────
        //
        // O canal de monitor do iDFace NAO fala TLS. O push fala, porque o
        // `push_remote_address` leva a URL inteira, com `https://`; o monitor
        // recebe hostname + porta + caminho, SEM esquema, e manda HTTP cru.
        // Apontado para a 443, o nginx respondia 400 ("The plain HTTP request
        // was sent to HTTPS port") -- 213 recusas, e nenhuma passagem de aluno
        // virando check-in. Tentamos sete nomes de parametro de TLS e o
        // firmware recusou todos; na 8.8.3, `curl_pinned_certificate` e
        // `curl_bearer_token` seguem sendo recurso do iDFace Max.
        //
        // Entao a 80, com a decisao dele (09/10/2026), e com o estrago cercado:
        // o que anda exposto e a credencial DO MONITOR, que so sabe contar o
        // que ja aconteceu -- `comDispositivo` recusa o segredo do push em
        // qualquer requisicao sem TLS. Sem nome, sem CPF, sem foto.
        port: "80",
        path: "cid/" + credencial,
      },
    },
  });

  return credencial;
};

// ── PERGUNTAR AO APARELHO O QUE ELE GUARDOU ───────────────────────────────
//
// O aparelho aceitou o `set_configuration` e respondeu sucesso — e mesmo assim
// o monitor não começou a falar. Entre "ele não guardou" e "guardou e não
// ligou" há uma diferença que muda o conserto, e adivinhar custa horas.
//
// Então perguntamos. A resposta volta pelo `/result`, que já aparece no
// histórico cru da tela: quem olha vê o que o firmware respondeu, palavra por
// palavra.
//
// Os nomes dos parâmetros vêm da documentação da Control iD — `get_configuration`
// recebe um objeto onde cada chave é um módulo e o valor é a LISTA do que se
// quer. Lista vazia não quer dizer "tudo": quer dizer nada.
// ── E, DESDE 09/10/2026, A PERGUNTA QUE IMPORTA: ELE SABE FAZER TLS? ──────
//
// Descobrimos que o monitor fala **HTTP puro na porta 443** — o nginx devolvia
// 400 ("The plain HTTP request was sent to HTTPS port"), 213 vezes, enquanto o
// push, que recebe a URL inteira com `https://`, funcionava. São dois clientes
// HTTP dentro do mesmo firmware, e só um sabe que era para criptografar.
//
// A diferença está na forma da configuração: o push recebe ESQUEMA; o monitor
// recebe `hostname`, `port` e `path` soltos. Se existir uma chave que ligue TLS
// no monitor, ela conserta isso sem abrir mão da criptografia — e o único jeito
// de descobrir o nome dela é perguntando, porque a documentação da Control iD
// bloqueia leitura automática e inventar nome de campo é o que faz este
// firmware recusar o lote inteiro.
//
// Os candidatos vão em comandos SEPARADOS, um por tentativa: assim uma chave
// que não existe derruba só a própria pergunta, e não as outras. O que o
// aparelho responder — inclusive o erro — aparece no histórico cru.
//
// ── A PRIMEIRA RODADA (09/10/2026) RECUSOU AS SETE ───────────────────────
//
//   "Node or attribute not found. Node path:
//    config->modules->module[name=monitor]->param[name=tls]"
//
// Mesma resposta para `https`, `ssl`, `secure`, `use_https`, `protocol` e
// `scheme`. Os chutes acabaram ali — e aí a resposta veio do changelog da
// própria Control iD, não de mais adivinhação:
//
//   **v6.22.3 (10/11/2025)** — "Added bearer-token and public pinned
//   certificate settings for curl requests in monitor, online, and push modes"
//
// Ou seja: a partir dessa versão o monitor passa a falar por **curl**, com
// `curl_pinned_certificate` e `curl_bearer_token`, "para reforçar a
// autenticação do dispositivo num servidor remoto **via HTTPS**".
//
// Então a pergunta certa não é mais "qual é o nome da chave de TLS" — é **que
// versão este aparelho está rodando**. Se estes dois parâmetros não existirem,
// o firmware é anterior a 6.22.3, e atualizar é o conserto. Se existirem, o
// monitor sabe fazer HTTPS e o problema é outro.
const CHAVES_DE_TLS = ["curl_pinned_certificate", "curl_bearer_token"];

Dispositivo_model.prototype.perguntarConfiguracao = async function (id) {
  const ok = await this.enfileirarComando(id, {
    verb: "POST",
    endpoint: "get_configuration",
    body: {
      monitor: ["request_timeout", "hostname", "port", "path"],
      push_server: ["push_remote_address", "push_request_timeout", "push_request_period"],
    },
  });
  if (!ok) return false;

  for (const chave of CHAVES_DE_TLS) {
    await this.enfileirarComando(id, {
      verb: "POST",
      endpoint: "get_configuration",
      body: { monitor: [chave] },
    });
  }

  // E a versão, dita pelo próprio aparelho. Vale mais que deduzir pela
  // ausência de um parâmetro: diz de uma vez o quanto ele está atrás.
  await this.enfileirarComando(id, { verb: "POST", endpoint: "system_information", body: {} });

  // ── E O CADASTRO, NA MESMA PERGUNTA ────────────────────────────────────
  //
  // Eram dois botões com nomes parecidos — "Perguntar ao aparelho" e "Ver quem
  // está cadastrado" — fazendo coisas diferentes. Criei essa confusão hoje e
  // ela cobrou na hora: as respostas que importavam vieram pelo botão errado.
  //
  // Agora é UMA pergunta. Nenhuma das duas respostas é cara, as duas levam o
  // mesmo minuto de espera, e quem está depurando quer o retrato inteiro —
  // não metade dele e a dúvida sobre qual metade pediu.
  await this.perguntarCadastro(id);

  return true;
};

// ── PERGUNTAR QUEM ESTÁ CADASTRADO NO APARELHO ────────────────────────────
//
// *"esse aluno tá cadastrado mas a catraca não libera"* (09/10/2026).
//
// Quem decide abrir é o APARELHO, sozinho, com o cadastro que ele tem dentro
// dele — não com o nosso. `passagemLiberada` é a nossa metade de um aperto de
// mão cuja outra metade ainda não existe: nunca mandamos uma pessoa para lá.
//
// Antes de escrever o cadastro remoto é preciso ver o que já está gravado,
// porque desenhar isso no escuro custa um dia: um iDFace recusa a passagem em
// DOIS casos que parecem o mesmo de fora —
//
//   • não conhece o rosto (não há `users`), ou
//   • conhece e não tem permissão (não há `access_rules` ligada a ele).
//
// A resposta volta pelo `/result` e aparece no histórico cru, palavra por
// palavra, que é onde quem está depurando já está olhando.
Dispositivo_model.prototype.perguntarCadastro = async function (id) {
  // Um comando por objeto: o protocolo responde um `load_objects` por vez, e
  // um lote com cinco objetos faria o firmware recusar tudo em silêncio.
  // ── OS GRUPOS ENTRARAM DEPOIS, E MUDARAM O DIAGNÓSTICO ────────────────
  //
  // *"eu bloqueei o acesso, mas ainda está liberando"* (10/10/2026). O
  // `destroy_objects` em `user_access_rules` tinha respondido `{"changes":1}`
  // — o vínculo foi mesmo apagado — e a porta continuou abrindo. Quem libera,
  // então, não é só o vínculo da PESSOA.
  //
  // A pista estava no nome das regras que ele já tinha contado: "Regra de
  // acesso padrão para o **Grupo 1**". O iDFace governa acesso por GRUPO
  // também, e usuário criado sem grupo declarado cai no padrão — que tem
  // regra ligada à porta. Sem ler estes três, o caminho que realmente abre a
  // porta é invisível daqui.
  const objetos = [
    "users",
    "access_rules",
    "user_access_rules",
    "portal_access_rules",
    "groups",
    "user_groups",
    "group_access_rules",
  ];

  for (const object of objetos) {
    const ok = await this.enfileirarComando(id, {
      verb: "POST",
      endpoint: "load_objects",
      body: { object },
    });
    if (!ok) return false;
  }

  return objetos.length;
};

// ── OS AJUSTES DO LEITOR ─────────────────────────────────────────────────
//
// *"bote aqui uma aba chamada configurações, a primeira vai ser um checkbox,
// 'bloquear se houver pendências'"* (10/10/2026).
//
// Por APARELHO, e não por academia: a porta da rua e a catraca da sala de
// musculação não precisam ter a mesma régua — barrar na entrada quem deve uma
// camiseta é uma decisão, barrar no caminho para o treino é outra.
Dispositivo_model.prototype.ajustar = async function (id, ajustes = {}) {
  if (!ObjectId.isValid(id)) return null;

  const set = { updatedAt: new Date() };
  if (ajustes.bloquearComPendencia !== undefined) {
    set.bloquearComPendencia = Boolean(ajustes.bloquearComPendencia);
  }

  const col = await this.collection();
  const r = await col.findOneAndUpdate(
    { _id: new ObjectId(String(id)) },
    { $set: set },
    { returnDocument: "after", projection: { segredoHash: 0, segredoDoMonitorHash: 0 } }
  );

  return r?.value || r || null;
};

Dispositivo_model.prototype.listar = async function () {
  const col = await this.collection();
  return col
    .find({}, { projection: { segredoHash: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
};

// Um leitor pelo id, sem o hash do segredo. Quem chama precisa saber se ele já
// deu sinal — é isso que decide se apagar pede senha.
Dispositivo_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await this.collection();
  return col.findOne({ _id: new ObjectId(String(id)) }, { projection: { segredoHash: 0 } });
};

Dispositivo_model.prototype.remover = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// ── O APARELHO DEU SINAL ───────────────────────────────────────────────────
//
// Chamado em toda batida e no heartbeat. Guarda o que o aparelho contou sobre
// si: é por aqui que o `deviceId` aparece sem ninguém digitar, e é o que a tela
// usa para dizer "visto há 12 segundos" em vez de deixar o dono adivinhando se
// o leitor está vivo.
//
// `updateOne` seco, sem ler antes: isto roda a cada poucos segundos por
// aparelho, e uma leitura a mais aqui é leitura a mais para sempre.
Dispositivo_model.prototype.tocar = async function (id, dados = {}) {
  if (!ObjectId.isValid(id)) return;

  const mudanca = { ultimoContato: new Date() };
  if (dados.deviceId) mudanca.deviceId = String(dados.deviceId).slice(0, 40);
  if (dados.serie) mudanca.serie = String(dados.serie).slice(0, 40);
  if (dados.firmware) mudanca.firmware = String(dados.firmware).slice(0, 40);

  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
};

// ── QUEM É O "user_id 37" DO APARELHO ──────────────────────────────────────
//
// O evento que chega do leitor diz `user_id: "37"` — o número interno DELE. Não
// é o nosso `_id`, e não tem como ser: o aparelho é anterior ao nosso cadastro
// e guarda um inteiro, não um ObjectId.
//
// Então existe um de-para, numa collection própria. Por que não um campo no
// usuário: porque a mesma pessoa pode ter número diferente em cada leitor (a
// academia cadastrou na entrada e de novo na musculação), e um campo só não
// comporta isso sem virar objeto aninhado que ninguém indexa direito.
//
// ── E QUANDO NÃO HÁ VÍNCULO ────────────────────────────────────────────────
//
// Acontece, e muito: a academia cadastra o rosto no aparelho antes de alguém
// ligar as pontas. A resposta NÃO é descartar o evento — descartar é perder
// frequência em silêncio, que é justamente o que esta funcionalidade existe
// para não deixar acontecer.
//
// O evento vira uma pendência: fica guardado com o número cru, e a tela mostra
// "alguém passou às 7h12 e não sei quem é" com um botão para vincular. Feito o
// vínculo, as pendências daquele número viram check-in retroativo.
Dispositivo_model.prototype.colecaoDeVinculos = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("access_device_users");
};

Dispositivo_model.prototype.pessoaDoUsuario = async function (dispositivo, usuarioNoAparelho) {
  const col = await this.colecaoDeVinculos();
  const doc = await col.findOne({
    dispositivo: new ObjectId(String(dispositivo)),
    usuarioNoAparelho: String(usuarioNoAparelho),
  });
  return doc?.person ? String(doc.person) : null;
};

Dispositivo_model.prototype.vincular = async function (dispositivo, usuarioNoAparelho, pessoa) {
  if (!ObjectId.isValid(dispositivo) || !ObjectId.isValid(pessoa)) return false;

  const col = await this.colecaoDeVinculos();
  await col.updateOne(
    {
      dispositivo: new ObjectId(String(dispositivo)),
      usuarioNoAparelho: String(usuarioNoAparelho),
    },
    {
      $set: { person: new ObjectId(String(pessoa)), updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  return true;
};

// ── A FILA DE COMANDOS DO PUSH ─────────────────────────────────────────────
//
// O aparelho pergunta a cada poucos segundos se há algo a fazer. Quase sempre
// não há — e é por isso que a leitura tem de ser barata: um `findOne` com
// índice, sem agregação e sem escrita quando a fila está vazia.
//
// `pegarEMarcar` e não "pegar": dois workers podem atender o mesmo aparelho (o
// backend roda em cluster). Sem marcar na mesma operação, o mesmo comando sairia
// duas vezes — e "cadastrar o Fulano" duas vezes é inofensivo, mas "abrir a
// porta" duas vezes não é.
Dispositivo_model.prototype.colecaoDeComandos = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("access_device_commands");
};

Dispositivo_model.prototype.proximoComando = async function (dispositivo) {
  if (!ObjectId.isValid(dispositivo)) return null;

  const col = await this.colecaoDeComandos();
  const doc = await col.findOneAndUpdate(
    { dispositivo: new ObjectId(String(dispositivo)), enviadoEm: null },
    { $set: { enviadoEm: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: "after" }
  );

  const comando = doc?.value || doc;
  if (!comando?.endpoint) return null;

  // Exatamente o formato que o aparelho espera. Nada a mais: campo
  // desconhecido no corpo faz firmware embarcado recusar o lote inteiro.
  return {
    verb: comando.verb || "POST",
    endpoint: comando.endpoint,
    body: comando.body || {},
    contentType: comando.contentType || "application/json",
  };
};

Dispositivo_model.prototype.enfileirarComando = async function (dispositivo, comando = {}) {
  if (!ObjectId.isValid(dispositivo) || !comando.endpoint) return false;

  const col = await this.colecaoDeComandos();
  await col.insertOne({
    dispositivo: new ObjectId(String(dispositivo)),
    verb: comando.verb || "POST",
    endpoint: String(comando.endpoint),
    body: comando.body || {},
    contentType: comando.contentType || "application/json",
    enviadoEm: null,
    resultado: null,
    // ── O BILHETE QUE FAZ A SAGA CONTINUAR ────────────────────────────────
    //
    // Quase todo comando acaba em si: sai, o aparelho responde, fim. O
    // cadastro do rosto não — ele precisa do id que o APARELHO escolhe, e só
    // sabe disso quando a resposta chega. Então o primeiro comando sai com um
    // bilhete dizendo de quem ele é, e `guardarResultado` lê o bilhete para
    // disparar os próximos. A continuação mora no comando, e não numa fila
    // nova: quem apaga o comando apaga a saga junto, que é o certo.
    prosseguir: comando.prosseguir || null,
    // ── DE QUEM É ESTE COMANDO ────────────────────────────────────────────
    //
    // *"tem como pôr 'aguardando aparelho confirmar'? assim sei que já foi
    // liberado"* (10/10/2026). O crachá da ficha ficava verde no instante do
    // clique, e o aparelho só saberia um minuto depois — entre os dois havia
    // uma janela em que a tela dizia uma coisa e a porta fazia outra.
    //
    // Para a ficha poder dizer "aguardando", ela precisa saber se sobrou
    // comando SEU na fila. O `prosseguir` já carregava a pessoa, mas só nos
    // dois comandos que continuam uma saga; a regra e o bloqueio não tinham
    // dono. Agora o dono é campo do comando, e vale para todos.
    pessoa: ObjectId.isValid(comando.pessoa) ? new ObjectId(String(comando.pessoa)) : null,
    createdAt: new Date(),
  });
  return true;
};

// O aparelho conta como foi. Guardamos no comando mais recente que saiu — é o
// que ele está respondendo, porque o protocolo é um comando por vez.
Dispositivo_model.prototype.guardarResultado = async function (dispositivo, resultado) {
  if (!ObjectId.isValid(dispositivo)) return;

  const col = await this.colecaoDeComandos();
  const achado = await col.findOneAndUpdate(
    { dispositivo: new ObjectId(String(dispositivo)), enviadoEm: { $ne: null }, resultado: null },
    { $set: { resultado, respondidoEm: new Date() } },
    { sort: { enviadoEm: -1 } }
  );
  // O driver devolveu `{value}` por muito tempo e hoje devolve o documento;
  // `proximoComando` já convive com os dois, e aqui pelo mesmo motivo.
  const comando = achado?.value || achado;

  await this.guardarCadastro(dispositivo, resultado);

  // Toda recusa vai para o registro próprio, seja de que comando for. Antes
  // das continuações: se a saga parar aqui, o motivo já está guardado.
  if (comando) await this.registrarFalha(dispositivo, comando, resultado);

  // O comando tinha bilhete? Então a resposta não é o fim: é o meio.
  if (comando?.prosseguir?.tipo === "cadastro") {
    await this.prosseguirCadastro(dispositivo, comando, resultado);
  }
  if (comando?.prosseguir?.tipo === "foto") {
    await this.guardarResultadoDaFoto(comando, resultado);
  }
};

// ── O QUE DEU ERRADO, GUARDADO À PARTE ────────────────────────────────────
//
// *"crie um log de erros aí em leitores"* / *"salve os erros em uma collection
// separada para a gente tratar depois"* (10/10/2026).
//
// O histórico cru já tem tudo — e é esse o problema: tem TUDO. Cem linhas de
// push de rotina para cada recusa, e a recusa é uma linha igual às outras, com
// a mensagem enterrada dentro de um JSON escapado. Foi assim que o
// `Invalid member 'match' (boolean expected, got uint64)` passou despercebido
// enquanto o usuário era criado e a regra ligada: de fora, parecia ter dado
// certo.
//
// Então o erro sai do meio do barulho e vira registro próprio, com `tratado:
// false` — porque metade deles é defeito NOSSO, descoberto só quando o
// firmware recusa, e a fila de "o que ainda não entendemos" precisa de um
// lugar onde não se perca.

// A FALHA, lida de qualquer uma das três formas que este firmware usa.
//
// Elas não se parecem, e é por isso que esta função existe num lugar só:
//
//   { "error": "…", "code": 1 }                        o lote inteiro recusado
//   { "response": "{\"error\":\"…\"}" }                 o mesmo, embrulhado
//   { "results": [ { "success": false, "errors": […] } ] }   item a item
//
// Devolve `null` quando deu certo. Pura e exportada: é o teste que cobra.
function lerFalha(resultado) {
  if (!resultado || typeof resultado !== "object") return null;

  const direto = (o) =>
    o && typeof o.error === "string" && o.error
      ? { mensagem: o.error, codigo: Number.isFinite(Number(o.code)) ? Number(o.code) : null }
      : null;

  const naSuperficie = direto(resultado);
  if (naSuperficie) return naSuperficie;

  let lido = resultado;
  if (typeof lido.response === "string") {
    try {
      lido = JSON.parse(lido.response);
    } catch {
      return null;
    }
  }
  if (!lido || typeof lido !== "object") return null;

  const embrulhado = direto(lido);
  if (embrulhado) return embrulhado;

  for (const item of Array.isArray(lido.results) ? lido.results : []) {
    const erros = Array.isArray(item?.errors) ? item.errors : [];
    if (item?.success === false || erros.length) {
      const primeiro = erros[0] || {};
      return {
        mensagem: String(primeiro.message || primeiro.code || "recusado"),
        codigo: Number.isFinite(Number(primeiro.code)) ? Number(primeiro.code) : null,
      };
    }
  }

  if (lido.success === false) return { mensagem: "recusado", codigo: null };

  return null;
}

// O corpo do comando vai junto, porque é ele que explica a recusa — mas SEM a
// imagem. Uma foto em base64 são 40 KB por registro, e guardar rosto dentro de
// um log de erro é montar acervo de biometria por acidente, que é exatamente o
// que esta integração decidiu não ter.
function semImagem(body) {
  if (!body || typeof body !== "object") return {};

  const copia = JSON.parse(JSON.stringify(body));
  if (Array.isArray(copia.user_images)) {
    copia.user_images = copia.user_images.map((u) => ({ ...u, image: "<foto>" }));
  }
  return copia;
}

Dispositivo_model.prototype.colecaoDeErros = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("access_device_errors");
};

Dispositivo_model.prototype.registrarFalha = async function (dispositivo, comando, resultado) {
  const falha = lerFalha(resultado);
  if (!falha) return false;

  const col = await this.colecaoDeErros();
  await col.insertOne({
    dispositivo: new ObjectId(String(dispositivo)),
    endpoint: String(comando?.endpoint || ""),
    corpo: semImagem(comando?.body),
    mensagem: falha.mensagem,
    codigo: falha.codigo,
    // De quem era o comando, quando dava para saber. É o que liga "a foto foi
    // recusada" a uma ficha, em vez de a um número de usuário.
    pessoa: comando?.prosseguir?.pessoa || null,
    // A fila do que ainda não foi tratado. Ninguém marca isto pela tela hoje —
    // o campo existe para que o dia em que alguém for tratar não comece por
    // adivinhar o que já foi visto.
    tratado: false,
    em: new Date(),
  });

  console.warn(
    "[controlid] " + (comando?.endpoint || "?") + " recusado pelo aparelho: " + falha.mensagem
  );
  return true;
};

// ── A FILA, COM O ESTADO DE CADA PEDIDO ──────────────────────────────────
//
// *"pode registrar esses pedidos, e quando aparelho solicitar, registrar que o
// pedido foi 'respondido'"* (10/10/2026).
//
// As datas sempre estiveram no documento do comando — `createdAt`, `enviadoEm`,
// `respondidoEm`. O que não existia era TELA: do lado de fora, mandar um
// comando era clicar num botão, ver um aviso verde e esperar. Entre "o aparelho
// ainda não veio buscar" e "veio, levou e não gostou" há uma diferença que
// muda o que fazer, e as duas se pareciam com silêncio.
//
// Quatro estados, e cada um aponta para um culpado diferente:
//
//   na fila     o aparelho ainda não perguntou   → é a rede dele, ou está off
//   entregue    levou e não respondeu            → travou aplicando
//   respondido  deu certo                        → nada a fazer
//   recusado    respondeu que não                → é NOSSO, e a mensagem diz
function estadoDoComando(c) {
  if (!c?.enviadoEm) return "na_fila";
  if (!c.resultado) return "entregue";
  return lerFalha(c.resultado) ? "recusado" : "respondido";
}

Dispositivo_model.prototype.fila = async function (dispositivo) {
  if (!ObjectId.isValid(dispositivo)) return [];

  const col = await this.colecaoDeComandos();
  const linhas = await col
    .find({ dispositivo: new ObjectId(String(dispositivo)) })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  return linhas.map((c) => ({
    _id: String(c._id),
    endpoint: c.endpoint,
    // Sem a imagem, pela mesma razão do registro de erros: 40 KB de base64 por
    // linha, viajando até a tela a cada 20 segundos, para mostrar "<foto>".
    corpo: semImagem(c.body),
    estado: estadoDoComando(c),
    criadoEm: c.createdAt,
    enviadoEm: c.enviadoEm || null,
    respondidoEm: c.respondidoEm || null,
    mensagem: (lerFalha(c.resultado) || {}).mensagem || "",
  }));
};

Dispositivo_model.prototype.erros = async function (dispositivo) {
  if (!ObjectId.isValid(dispositivo)) return [];

  const col = await this.colecaoDeErros();
  return col
    .find({ dispositivo: new ObjectId(String(dispositivo)) })
    .sort({ em: -1 })
    .limit(50)
    .toArray();
};

// ── O QUE O APARELHO DIZ TER DENTRO DELE ──────────────────────────────────
//
// A resposta de `load_objects` chega como TEXTO dentro de `{ response: "…" }`
// — JSON embrulhado em JSON, que é como esse firmware fala. Aqui ele é aberto
// e o que interessa fica guardado no leitor.
//
// Por que guardar em vez de perguntar na hora: o aparelho responde pelo canal
// de push, de minuto em minuto. Uma tela que precisasse da regra de acesso
// para desenhar um botão ficaria um minuto esperando — ou, pior, perguntaria
// e seguiria sem a resposta.
//
// Só o que a decisão precisa. O NOME de quem está cadastrado no aparelho não
// vem: ele não acrescenta nada à regra e seria uma segunda cópia de dado de
// pessoa, num lugar que ninguém lembraria de limpar.
// A leitura é PURA e exportada: é ela que o teste cobra. O que sobra no método
// é o acesso ao banco, que não tem regra nenhuma para errar.
function lerCadastro(resultado) {
  const texto = resultado && typeof resultado.response === "string" ? resultado.response : "";
  if (!texto) return null;

  let lido;
  try {
    lido = JSON.parse(texto);
  } catch {
    return null; // Resposta que não é objeto (um erro, por exemplo) não ensina nada aqui.
  }
  if (!lido || typeof lido !== "object") return null;

  const numeros = (lista, campo) =>
    lista.map((x) => Number(x?.[campo])).filter((n) => Number.isFinite(n));

  const set = {};

  if (Array.isArray(lido.users)) {
    set["cadastro.usuarios"] = numeros(lido.users, "id");

    // ── QUEM TEM ROSTO GRAVADO ──────────────────────────────────────────
    //
    // `image_timestamp` é 0 quando o usuário não tem foto. Num leitor FACIAL,
    // usuário sem foto é um registro que não vai abrir nada nunca — e de fora
    // isso é idêntico a "não está cadastrado" e a "está sem regra". Eram três
    // causas para o mesmo sintoma e só duas eram visíveis daqui; esta era a
    // que faltava.
    set["cadastro.comFoto"] = lido.users
      .filter((u) => Number(u?.image_timestamp) > 0)
      .map((u) => Number(u?.id))
      .filter((n) => Number.isFinite(n));

    // ── A MATRÍCULA É O NOSSO ID, E É O FIO QUE RECONSTRÓI O VÍNCULO ─────
    //
    // Quem cadastramos daqui vai com `registration` = o ObjectId da pessoa.
    // Se a resposta do `create_objects` se perder (o aparelho reinicia, a rede
    // cai no meio), o vínculo nunca é gravado — e sem ele a próxima tentativa
    // criaria um SEGUNDO usuário com o mesmo rosto, que é como a frequência de
    // uma pessoa se parte em duas. Com a matrícula lida aqui, `guardarCadastro`
    // reencontra quem é quem sem perguntar nada a ninguém.
    set["cadastro.matriculas"] = lido.users
      .map((u) => ({ id: Number(u?.id), matricula: String(u?.registration || "").trim() }))
      .filter((u) => Number.isFinite(u.id) && u.matricula);
  }
  if (Array.isArray(lido.access_rules)) set["cadastro.regras"] = numeros(lido.access_rules, "id");
  if (Array.isArray(lido.portal_access_rules)) {
    // A regra LIGADA À PORTA. É ela que decide quem passa — uma regra solta,
    // sem portal, não abre nada. Sem nenhuma, `null`: dizer "não há" é
    // diferente de não ter perguntado, e é o que impede um palpite depois.
    const [primeira] = numeros(lido.portal_access_rules, "access_rule_id");
    set["cadastro.regraDaPorta"] = primeira === undefined ? null : primeira;
  }
  if (Array.isArray(lido.user_access_rules)) {
    set["cadastro.liberados"] = numeros(lido.user_access_rules, "user_id");
  }

  if (!Object.keys(set).length) return null;
  return set;
}

Dispositivo_model.prototype.guardarCadastro = async function (dispositivo, resultado) {
  const set = lerCadastro(resultado);
  if (!set) return;

  set["cadastro.em"] = new Date();

  const col = await this.collection();
  await col.updateOne({ _id: new ObjectId(String(dispositivo)) }, { $set: set });

  // Perguntar quem está lá dentro CONSERTA vínculo perdido, de graça. Toda
  // matrícula que é um id nosso vira vínculo — se já existir, o `upsert` não
  // muda nada; se tiver sumido, volta. É por isso que "Perguntar ao aparelho"
  // é o primeiro conselho quando algo não bate.
  for (const { id, matricula } of set["cadastro.matriculas"] || []) {
    if (ObjectId.isValid(matricula)) await this.vincular(dispositivo, id, matricula);
  }
};

// ── LIGAR UMA PESSOA DO APARELHO À REGRA QUE ABRE A PORTA ─────────────────
//
// O defeito que isto conserta (09/10/2026): o aparelho tinha o rosto do Marlon
// gravado, reconheceu ele — e não abriu, porque `user_access_rules` estava
// VAZIO. Rosto conhecido sem regra de acesso é exatamente igual, do lado de
// fora, a rosto desconhecido. Foi preciso perguntar ao aparelho para saber
// qual dos dois era.
//
// A regra usada é a que o `portal_access_rules` diz estar ligada à porta.
// Inventar um número aqui seria criar um vínculo com uma regra que não abre
// nada — e o sintoma seria o mesmo de não ter feito nada.
// A REGRA QUE ABRE A PORTA, ou `null`.
//
// Num lugar só porque `Number(null)` é ZERO — e zero passa em `Number.isFinite`.
// Era assim que a conferência estava escrita nos dois chamadores, e um aparelho
// com `portal_access_rules` VAZIO (que é precisamente o caso que ela existe
// para pegar: `lerCadastro` grava `null` ali) escapava dela e enfileirava
// `access_rule_id: 0`. Uma regra zero não abre nada, e o sintoma é idêntico ao
// de não ter feito nada — o mesmo defeito de 09/10/2026, uma camada mais fundo.
// Pego por teste, não por leitura.
function regraDaPorta(doc) {
  const n = doc?.cadastro?.regraDaPorta;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

Dispositivo_model.prototype.liberarNoAparelho = async function (
  dispositivo,
  usuarioNoAparelho,
  pessoa
) {
  if (!ObjectId.isValid(dispositivo)) return { erro: "nao_encontrado" };

  const usuario = Number(usuarioNoAparelho);
  if (!Number.isFinite(usuario)) return { erro: "usuario_invalido" };

  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(String(dispositivo)) });
  if (!doc) return { erro: "nao_encontrado" };

  // Sem o cadastro lido, não dá para saber qual regra abre a porta. Quem chama
  // transforma isto em "pergunte ao aparelho primeiro" — e não num palpite.
  const regra = regraDaPorta(doc);
  if (regra === null) return { erro: "sem_regra" };

  const ok = await this.enfileirarComando(dispositivo, {
    verb: "POST",
    endpoint: "create_objects",
    body: {
      object: "user_access_rules",
      values: [{ user_id: usuario, access_rule_id: regra }],
    },
    pessoa,
  });

  return ok ? { regra } : { erro: "nao_encontrado" };
};

// ── O CADASTRO REMOTO DO ROSTO ─────────────────────────────────────────────
//
// *"me lembro que pedi, para ser um dialog para também cadastrar as fotos que
// vão ser cadastradas na catraca"* (10/10/2026).
//
// Até aqui `passagemLiberada` era meia mão: marcávamos na ficha e nunca
// mandávamos ninguém para o aparelho. Quem punha rosto no leitor era uma
// pessoa de pé na frente dele, no menu do firmware — e foi exatamente isso que
// produziu o *"esse aluno tá cadastrado mas a catraca não libera"*: dois
// cadastros separados, sem nada ligando um ao outro, e o de lá invisível daqui.
//
// Agora a ficha manda. São TRÊS comandos, nesta ordem, e não cabem num só:
//
//   1. `create_objects` / `users`              → o aparelho devolve o id DELE
//   2. `user_set_image_list`                   → a foto em base64, para esse id
//   3. `create_objects` / `user_access_rules`  → esse id na regra da porta
//
// O passo 2 depende de um id que só existe depois do 1, e o canal entrega um
// comando por vez: não há como enfileirar os três e torcer. Então o 1 sai com
// um bilhete (`prosseguir`) dizendo de quem ele é, e a resposta que chega em
// `/result` é quem dispara o 2 e o 3. Uma saga curta, guardada no próprio
// documento do comando — sem fila nova e sem agendador.
//
// Entre o clique e o rosto no aparelho passa um ciclo de push por comando: até
// três minutos. A tela diz isso, porque "cadastrei e não abriu na hora" é
// exatamente o tipo de dúvida que vira chamado.

// O id que o aparelho acabou de criar. `create_objects` responde `{"ids":[8]}`
// — que pode chegar nu ou embrulhado em `{response:"…"}`, porque é assim que
// este firmware fala quando atravessa o push. Aceitar as duas formas custa
// quatro linhas; descobrir qual era na madrugada custa a noite.
function lerIdCriado(resultado) {
  let ids = Array.isArray(resultado?.ids) ? resultado.ids : null;

  if (!ids && typeof resultado?.response === "string") {
    try {
      const lido = JSON.parse(resultado.response);
      if (Array.isArray(lido?.ids)) ids = lido.ids;
    } catch {
      return null;
    }
  }

  const n = Number(ids?.[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// O que o aparelho achou da foto.
//
//   { "results": [ { "user_id": 8, "success": false,
//                    "errors": [ { "code": 2, "message": "No face found" } ] } ] }
//
// É a única notícia que interessa a quem acabou de cadastrar, e ela é a razão
// de usarmos `user_set_image_list` e não o envio de foto única: o único que
// responde alguma coisa. Sem isto o cadastro falharia EM SILÊNCIO — o usuário
// existiria no aparelho, ligado à regra, sem rosto —, e de fora isso é
// idêntico a "a catraca não funciona".
//
// A mensagem do firmware vai inteira para a tela, sem tradução nossa: no dia
// em que ele inventar um código novo, uma frase nossa seria uma frase errada.
function lerResultadoDaFoto(resultado) {
  let lido = resultado;

  if (typeof lido?.response === "string") {
    try {
      lido = JSON.parse(lido.response);
    } catch {
      return null;
    }
  }

  // ── A RECUSA DO LOTE INTEIRO NÃO TEM A FORMA DE UM RESULTADO ─────────
  //
  // Quando o firmware não gosta do CORPO — um campo com o tipo errado — ele
  // não responde `results` nenhum: devolve `{error, code}` solto. Era o caso
  // do `match: 1`, e este leitor devolvia `null` para ele. Resultado: a recusa
  // não ia para o vínculo, não ia para o log, e o cadastro falhava em
  // silêncio — exatamente o que esta função existe para impedir.
  if (lido && typeof lido === "object" && typeof lido.error === "string") {
    return { ok: false, erro: lido.error };
  }

  const item = Array.isArray(lido?.results) ? lido.results[0] : lido;
  if (!item || typeof item !== "object") return null;
  if (item.success === undefined && !Array.isArray(item.errors)) return null;

  const erros = Array.isArray(item.errors) ? item.errors : [];
  return {
    ok: Boolean(item.success) && !erros.length,
    erro: erros.length ? String(erros[0].message || erros[0].code || "") : "",
  };
}

// ── UM VÍNCULO PODE APONTAR PARA QUEM NÃO EXISTE MAIS ────────────────────
//
// Apagar um usuário pela TELA do aparelho é operação normal — ele fez isso em
// 10/10/2026, meia hora depois de este código subir. O vínculo continua aqui,
// apontando para um id que lá dentro não existe mais, e o cadastro mandaria a
// foto para um fantasma: o aparelho recusa, a tela mostra um erro que ninguém
// sabe ler, e a pessoa segue sem passar.
//
// Mas só dá para desconfiar quando há COMO SABER. A regra é a data: se o
// aparelho nos contou a lista de usuários DEPOIS de o vínculo ter sido feito, e
// esse id não estava nela, ele foi apagado. Se a leitura é mais velha que o
// vínculo, ela não sabe de nada — e derrubar o vínculo por causa dela criaria
// exatamente o sósia que o vínculo existe para evitar.
//
// Na dúvida, o vínculo FICA. Um cadastro que falha com mensagem é melhor que um
// segundo usuário com o mesmo rosto, que falha calado e parte a frequência da
// pessoa em duas.
function vinculoMorreu(doc, vinculo) {
  const lido = doc?.cadastro?.em;
  const lista = doc?.cadastro?.usuarios;
  if (!lido || !vinculo?.updatedAt || !Array.isArray(lista)) return false;

  if (new Date(lido) <= new Date(vinculo.updatedAt)) return false;

  return !lista.includes(Number(vinculo.usuarioNoAparelho));
}

// O aparelho recusa requisição acima de 1 MB e o base64 infla um terço. 700 KB
// de imagem cabem com folga — e acima disso a recusa é NOSSA, com nome, em vez
// de um erro mudo do firmware que ninguém saberia ler.
const LIMITE_DA_FOTO = 700 * 1024;

// A foto que vai para o leitor é a MESMA da ficha, e isso é decisão.
//
// Uma "foto da catraca" separada viraria, em um mês, duas fotos diferentes da
// mesma pessoa — e ninguém saberia dizer qual das duas o aparelho está usando
// para reconhecer. Trocar a foto da ficha passa a ser trocar o rosto na porta,
// que é o que qualquer um espera que aconteça.
Dispositivo_model.prototype.fotoParaOAparelho = async function (pessoa) {
  if (!ObjectId.isValid(pessoa)) return { erro: "nao_encontrado" };

  const doc = await this.app.api.avatar.data(pessoa);
  if (!doc) return { erro: "sem_foto" };

  // O iDFace lê JPG e PNG. O nosso recorte produz JPEG, então isto é para a
  // foto que entrou por outro caminho — webp passa no nosso filtro de upload e
  // não passa no dele.
  const mime = String(doc.mime || "").toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png") return { erro: "formato_da_foto" };

  const bytes = await arquivos.bytesDoDocumento(doc);
  if (!bytes || !bytes.length) return { erro: "sem_foto" };
  if (bytes.length > LIMITE_DA_FOTO) return { erro: "foto_grande" };

  return { base64: Buffer.from(bytes).toString("base64") };
};

// O número que ESTA pessoa tem dentro DESTE aparelho, ou `null`. É o vínculo
// lido ao contrário — `pessoaDoUsuario` responde a batida que chega, este
// responde a ficha que manda.
Dispositivo_model.prototype.usuarioDaPessoa = async function (dispositivo, pessoa) {
  if (!ObjectId.isValid(dispositivo) || !ObjectId.isValid(pessoa)) return null;

  const col = await this.colecaoDeVinculos();
  const doc = await col.findOne({
    dispositivo: new ObjectId(String(dispositivo)),
    person: new ObjectId(String(pessoa)),
  });

  const n = Number(doc?.usuarioNoAparelho);
  return Number.isFinite(n) ? n : null;
};

Dispositivo_model.prototype.enfileirarFoto = async function (dispositivo, usuario, base64, pessoa) {
  return this.enfileirarComando(dispositivo, {
    verb: "POST",
    endpoint: "user_set_image_list",
    body: {
      // A trava contra a mesma pessoa cadastrada duas vezes: o aparelho
      // recusa a foto se esse rosto já estiver em OUTRO usuário. Sem ela, a
      // frequência de alguém se parte em duas sem ninguém notar.
      //
      // ── `true`, E NÃO `1` ────────────────────────────────────────────
      //
      // A documentação da Control iD descreve `match` como "0 ou 1". O
      // firmware quer BOOLEANO, e recusa o lote inteiro com
      // `Invalid member 'match' (boolean expected, got uint64)`. Custou o
      // primeiro cadastro remoto de verdade (10/10/2026): o usuário foi
      // criado, a regra foi ligada, e o rosto não entrou.
      match: true,
      user_images: [
        { user_id: Number(usuario), timestamp: Math.floor(Date.now() / 1000), image: base64 },
      ],
    },
    prosseguir: {
      tipo: "foto",
      pessoa: ObjectId.isValid(pessoa) ? new ObjectId(String(pessoa)) : null,
      usuario: Number(usuario),
    },
    pessoa,
  });
};

Dispositivo_model.prototype.cadastrarNoAparelho = async function (dispositivo, pessoa) {
  if (!ObjectId.isValid(dispositivo) || !ObjectId.isValid(pessoa)) {
    return { erro: "nao_encontrado" };
  }

  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(String(dispositivo)) });
  if (!doc) return { erro: "nao_encontrado" };

  // Sem saber qual regra abre a porta, cadastrar o rosto produz alguém que o
  // aparelho RECONHECE e não deixa entrar — o defeito de 09/10/2026 outra vez,
  // agora fabricado por nós. Melhor parar e mandar perguntar ao aparelho.
  if (regraDaPorta(doc) === null) return { erro: "sem_regra" };

  const foto = await this.fotoParaOAparelho(pessoa);

  // ── QUEM JÁ ESTÁ LÁ DENTRO SÓ PRECISA DA REGRA ────────────────────────
  //
  // E por isso a foto é conferida DEPOIS deste desvio, não antes. Quem foi
  // cadastrado na mão, na tela do aparelho, costuma não ter foto na ficha — e
  // era justamente essa pessoa que o *"está cadastrado e a catraca não
  // libera"* deixava de fora. Recusar o vínculo com a regra por falta de uma
  // foto que o aparelho já tem seria recusar o conserto por falta do que não
  // faz falta.
  //
  // A foto vai junto quando existir: é a forma de uma troca de foto na ficha
  // chegar ao leitor. Clicar duas vezes em "liberar" é comum, e nada aqui
  // cria um sósia — o id é o que já era dele.
  const vinculos = await this.colecaoDeVinculos();
  const vinculo = await vinculos.findOne({
    dispositivo: new ObjectId(String(dispositivo)),
    person: new ObjectId(String(pessoa)),
  });

  // Apagado na tela do aparelho? Então o vínculo não vale mais. Some com ele e
  // segue para o cadastro novo, em vez de mandar a foto para um id que lá
  // dentro não existe.
  if (vinculo && vinculoMorreu(doc, vinculo)) {
    console.warn("[controlid] vínculo apontava para usuário apagado no aparelho: " + vinculo.usuarioNoAparelho);
    await vinculos.deleteOne({ _id: vinculo._id });
  }

  const jaTem = vinculo && !vinculoMorreu(doc, vinculo) ? Number(vinculo.usuarioNoAparelho) : null;
  if (jaTem !== null && Number.isFinite(jaTem)) {
    if (foto.base64) await this.enfileirarFoto(dispositivo, jaTem, foto.base64, pessoa);
    const r = await this.liberarNoAparelho(dispositivo, jaTem, pessoa);
    if (r.erro) return { erro: r.erro };
    return { usuario: jaTem, regra: r.regra, jaExistia: true, semFoto: Boolean(foto.erro) };
  }

  // Daqui para baixo é cadastro NOVO, e aí a foto é obrigatória: criar um
  // usuário sem rosto num leitor facial é criar um registro que nunca vai
  // abrir nada — e que depois aparece na lista do aparelho confundindo quem
  // procura o defeito.
  if (foto.erro) return { erro: foto.erro };

  const alvo = await this.app.api.user.data(pessoa);
  // 60 caracteres: é o que cabe no campo do firmware, e o nome existe lá para
  // quem olha a tela do aparelho — não para a gente, que tem a ficha.
  const nome = String(alvo?.name || "").trim().slice(0, 60);
  if (!nome) return { erro: "nao_encontrado" };

  const ok = await this.enfileirarComando(dispositivo, {
    verb: "POST",
    endpoint: "create_objects",
    body: {
      object: "users",
      values: [
        {
          name: nome,
          // A MATRÍCULA É O NOSSO ID, e não é enfeite: se a resposta deste
          // comando se perder, o vínculo nunca é gravado e a próxima tentativa
          // criaria um segundo usuário com o mesmo rosto. Com o id gravado lá,
          // um "Perguntar ao aparelho" reencontra quem é quem — ver a
          // reconciliação em `guardarCadastro`.
          registration: String(pessoa),
        },
      ],
    },
    prosseguir: { tipo: "cadastro", pessoa: new ObjectId(String(pessoa)) },
    pessoa,
  });

  return ok ? { criando: true } : { erro: "nao_encontrado" };
};

// O segundo tempo da saga: a resposta do `create_objects` chegou e agora
// existe um id.
Dispositivo_model.prototype.prosseguirCadastro = async function (dispositivo, comando, resultado) {
  const pessoa = comando?.prosseguir?.pessoa;
  if (!pessoa) return;

  const usuario = lerIdCriado(resultado);
  if (!usuario) {
    // Não inventa e não repete: repetir criaria um usuário a cada tentativa, e
    // a correção certa é "Perguntar ao aparelho", que reconcilia pela matrícula.
    console.warn("[controlid] create_objects/users voltou sem id — cadastro parado no passo 1");
    return;
  }

  // O VÍNCULO PRIMEIRO, antes da foto e antes da regra. Ele é o que faz a
  // próxima batida virar check-in, e não depende de mais nada dar certo: se a
  // foto for recusada e alguém cadastrar o rosto na mão, a pessoa já está
  // ligada à ficha certa e as pendências se aproveitam sozinhas.
  await this.vincular(dispositivo, usuario, pessoa);

  const foto = await this.fotoParaOAparelho(pessoa);
  if (foto.base64) await this.enfileirarFoto(dispositivo, usuario, foto.base64, pessoa);

  await this.liberarNoAparelho(dispositivo, usuario, pessoa);
};

// O terceiro tempo: o aparelho disse o que achou da foto. Fica gravado no
// VÍNCULO, que é onde a tela da ficha vai procurar — "o rosto está lá" e "o
// rosto foi recusado por falta de nitidez" são respostas diferentes, e a
// segunda precisa chegar em quem cadastrou.
Dispositivo_model.prototype.guardarResultadoDaFoto = async function (comando, resultado) {
  const lido = lerResultadoDaFoto(resultado);
  if (!lido) return;

  const col = await this.colecaoDeVinculos();
  await col.updateOne(
    {
      dispositivo: new ObjectId(String(comando.dispositivo)),
      usuarioNoAparelho: String(comando.prosseguir.usuario),
    },
    { $set: { fotoEm: lido.ok ? new Date() : null, fotoErro: lido.ok ? "" : lido.erro } }
  );

  if (!lido.ok) console.warn("[controlid] o aparelho recusou a foto: " + lido.erro);
};

// ── TIRAR DA PORTA SEM APAGAR O ROSTO ─────────────────────────────────────
//
// Bloquear derruba só o VÍNCULO com a regra. O usuário e a foto ficam no
// aparelho, e isso é decisão e não economia: quem volta a pagar na quinta
// entra na quinta, sem posar de novo na frente do leitor. É o mesmo raciocínio
// de tirar o acesso ao app sem apagar a senha.
//
// Apagar o rosto de verdade existe num lugar só, e é outro: excluir a ficha.
Dispositivo_model.prototype.bloquearNoAparelho = async function (
  dispositivo,
  usuarioNoAparelho,
  pessoa
) {
  const usuario = Number(usuarioNoAparelho);
  if (!ObjectId.isValid(dispositivo) || !Number.isFinite(usuario)) {
    return { erro: "nao_encontrado" };
  }

  const ok = await this.enfileirarComando(dispositivo, {
    verb: "POST",
    endpoint: "destroy_objects",
    body: {
      object: "user_access_rules",
      where: { user_access_rules: { user_id: usuario } },
    },
    pessoa,
  });

  return ok ? { usuario } : { erro: "nao_encontrado" };
};

// ── A PENDÊNCIA MUDOU: A PORTA PRECISA SABER ─────────────────────────────
//
// A trava não pode valer só no momento em que alguém vira a chave da ficha. A
// camiseta é entregue na quinta e a pessoa tem de entrar na quinta — não no dia
// em que alguém lembrar de reabrir a catraca dela na mão.
//
// Então toda vez que uma pendência nasce, é resolvida, reaberta ou apagada,
// isto roda e reaplica o que a ficha já dizia. Não decide nada por conta
// própria: `passagemLiberada` continua sendo a vontade da casa, e esta função
// só recalcula o que ela significa hoje.
//
// Sai barato quando não há leitor nenhum, que é o caso da maioria: uma consulta
// à lista, que já é cacheada, e volta.
Dispositivo_model.prototype.reavaliarPassagem = async function (pessoa) {
  const aparelhos = await this.listar();
  if (!aparelhos.some((a) => a.bloquearComPendencia)) return [];

  const alvo = await this.app.api.user.data(pessoa);
  if (!alvo) return [];

  return this.sincronizarPassagem(pessoa, alvo.passagemLiberada !== false);
};

// ── O QUE ESTA PESSOA TEM DENTRO DE CADA LEITOR ──────────────────────────
//
// *"poderia mostrar a 'foto cadastrada' também"* (10/10/2026).
//
// A caixa de bloqueio prometia que *"o rosto continua gravado no aparelho"* —
// e dizia isso para todo mundo, inclusive para quem nunca esteve lá. Promessa
// que às vezes é falsa é pior que promessa nenhuma: quem bloqueia confiando
// nela vai ter de chamar a pessoa para posar de novo, e só descobre no dia.
//
// Quem responde é o APARELHO, não nós. `comFoto` sai do `image_timestamp` que
// ele mesmo reporta; `fotoEm`/`fotoErro` são o que ele respondeu ao nosso
// envio. A diferença importa: "mandamos a foto" e "ele tem a foto" são coisas
// diferentes, e foi a segunda que ele pediu para ver.
//
// `temRosto: null` é "ainda não perguntamos" — e dizer isso é melhor que
// chutar um dos dois.
Dispositivo_model.prototype.situacaoNaPorta = async function (pessoa) {
  if (!ObjectId.isValid(pessoa)) return [];

  const aparelhos = await this.listar();
  if (!aparelhos.length) return [];

  const col = await this.colecaoDeVinculos();
  const vinculos = await col.find({ person: new ObjectId(String(pessoa)) }).toArray();

  // ── O QUE AINDA NÃO CHEGOU NO APARELHO ────────────────────────────────
  //
  // Comando enfileirado e sem resposta é a janela em que a tela diz uma coisa
  // e a porta faz outra. Enquanto houver um, a ficha mostra "aguardando o
  // aparelho" em vez do crachá verde — que é o pedido de 10/10/2026, e também
  // o melhor sintoma que temos de um leitor desligado: a espera não some.
  const comandos = await this.colecaoDeComandos();
  const esperando = await comandos
    .find({ pessoa: new ObjectId(String(pessoa)), resultado: null })
    .toArray();

  return aparelhos.map((aparelho) => {
    const v = vinculos.find((x) => String(x.dispositivo) === String(aparelho._id));
    const usuario = v ? Number(v.usuarioNoAparelho) : NaN;
    const temVinculo = Number.isFinite(usuario);
    // ── DUAS CONFIRMAÇÕES, E A MAIS NOVA GANHA ──────────────────────────
    //
    // O aparelho diz que tem o rosto de duas maneiras, em momentos
    // diferentes: respondendo ao ENVIO (`success` + as notas da imagem, que
    // viram `fotoEm`) e listando os usuários num `load_objects` depois
    // (`image_timestamp`, que vira `cadastro.comFoto`).
    //
    // A primeira versão disto tratava a LISTA como autoridade sempre — e ela
    // é uma foto do passado. Com a leitura das 17:35 e o envio das 18:04, a
    // tela dizia *"não sei dizer se o rosto está gravado"* sobre uma foto que
    // o aparelho tinha acabado de aceitar com nitidez 956. Não saber e saber
    // que sim são respostas diferentes, e dar a primeira quando se tem a
    // segunda manda a pessoa perguntar de novo por nada.
    //
    // É a mesma régua de `vinculoMorreu`: a leitura só derruba o que é mais
    // ANTIGO que ela.
    const lidoEm = aparelho?.cadastro?.em;
    const comFoto = aparelho?.cadastro?.comFoto;
    const leituraMaisNova =
      lidoEm && (!v?.fotoEm || new Date(lidoEm) > new Date(v.fotoEm));

    let temRosto = null;
    if (v?.fotoErro) temRosto = false;
    else if (temVinculo && Array.isArray(comFoto) && leituraMaisNova) {
      temRosto = comFoto.includes(usuario);
    } else if (v?.fotoEm) temRosto = true;

    return {
      dispositivo: String(aparelho._id),
      nome: aparelho.nome || "",
      usuario: temVinculo ? usuario : null,
      temRosto,
      enviadaEm: v?.fotoEm || null,
      recusa: v?.fotoErro || "",
      pendente: esperando.some((c) => String(c.dispositivo) === String(aparelho._id)),
    };
  });
};

// ── A FICHA MANDA NA PORTA ────────────────────────────────────────────────
//
// Uma academia costuma ter um leitor, mas pode ter dois — a entrada e a sala
// de musculação. A chave da ficha vale para a CASA, não para um aparelho:
// virar a passagem tem de alcançar todos, senão a pessoa fica liberada numa
// porta e bloqueada na outra, e descobrir isso custa uma tarde.
//
// Devolve uma linha por aparelho, e é o que a tela mostra. NÃO lança: um leitor
// sem o cadastro lido não pode impedir que o outro seja atualizado, e um erro
// aqui não pode desfazer a chave que já foi gravada na ficha.
Dispositivo_model.prototype.sincronizarPassagem = async function (pessoa, liberado) {
  const aparelhos = await this.listar();
  const saida = [];

  // ── A PENDÊNCIA PODE VETAR A LIBERAÇÃO ────────────────────────────────
  //
  // Só é contada se ALGUM aparelho pedir — a conta é uma consulta a mais, e
  // academia que não usa a trava não deve pagar por ela em toda virada de
  // chave.
  //
  // O veto não mexe em `passagemLiberada`: a chave da ficha continua dizendo o
  // que a casa QUER, e a pendência diz o que vale hoje. Misturar os dois faria
  // a camiseta entregue na quinta deixar a pessoa bloqueada para sempre, com a
  // ficha dizendo que ela está liberada.
  const alguemVeta = aparelhos.some((a) => a.bloquearComPendencia);
  const pendencias = alguemVeta ? await this.app.api.pendency.contarAbertasDe(pessoa) : 0;

  for (const aparelho of aparelhos) {
    const quem = { dispositivo: String(aparelho._id), nome: aparelho.nome || "" };
    const vetado = Boolean(aparelho.bloquearComPendencia) && pendencias > 0;

    try {
      if (liberado && !vetado) {
        saida.push({ ...quem, ...(await this.cadastrarNoAparelho(aparelho._id, pessoa)) });
        continue;
      }

      const usuario = await this.usuarioDaPessoa(aparelho._id, pessoa);
      // Nunca esteve neste aparelho: não há o que bloquear. Mandar o comando
      // assim mesmo traria `{"changes":0}` e a tela mostraria erro onde não há.
      if (usuario === null) {
        saida.push({ ...quem, semVinculo: true, porPendencia: vetado });
        continue;
      }

      saida.push({
        ...quem,
        ...(await this.bloquearNoAparelho(aparelho._id, usuario, pessoa)),
        // Por que ficou bloqueado, para a tela não dizer que a casa bloqueou
        // quem a casa liberou.
        porPendencia: vetado && liberado,
      });
    } catch (erro) {
      console.error("[controlid] sincronizar passagem:", erro.message);
      saida.push({ ...quem, erro: "falhou" });
    }
  }

  return saida;
};

// ── O QUE FICOU PARA TRÁS ──────────────────────────────────────────────────
//
// Ligado o vínculo, as batidas que chegaram antes dele viram check-in de
// verdade — com a data em que aconteceram, não a de agora. É o que faz "a
// academia cadastrou no leitor na segunda e no sistema na quinta" não custar
// três dias de frequência.
//
// Passa pelo `checkin.registrar`, e não por insert direto, de propósito: assim
// a janela de 30 minutos contra repetição vale também para o retroativo.
Dispositivo_model.prototype.aproveitarPendencias = async function (
  dispositivo,
  usuarioNoAparelho,
  pessoa
) {
  if (!ObjectId.isValid(dispositivo) || !ObjectId.isValid(pessoa)) return 0;

  const db = await this.app.mongodb.connectToServer();
  const col = db.collection("access_device_pendings");
  const filtro = {
    dispositivo: new ObjectId(String(dispositivo)),
    usuarioNoAparelho: String(usuarioNoAparelho),
  };

  const pendentes = await col.find(filtro).sort({ em: 1 }).toArray();
  const aparelho = await (await this.collection()).findOne({ _id: new ObjectId(String(dispositivo)) });

  let contadas = 0;
  for (const p of pendentes) {
    const r = await this.app.api.checkin.registrar(pessoa, {
      em: p.em,
      origem: "catraca",
      unit: aparelho?.unit || null,
      dispositivo: aparelho?.nome || "",
    });
    if (r.ok && !r.repetido) contadas += 1;
  }

  await col.deleteMany(filtro);
  return contadas;
};

// ── LER UMA BATIDA CRUA DO APARELHO ────────────────────────────────────────
//
// Função pura, fora do modelo, porque é aqui que mora o detalhe que quebra em
// silêncio: **o aparelho manda o tempo em SEGUNDOS**. É firmware embarcado, não
// manda ISO 8601. O JavaScript conta em milissegundos — sem o ×1000, toda
// entrada da academia é registrada em 17 de janeiro de 1970, e o dono só
// descobre semanas depois, olhando a tela de frequência.
//
// `reconhecido` separa duas coisas que o protocolo junta no mesmo campo:
// `user_id: "0"` não é a pessoa de número zero, é "o aparelho NÃO reconheceu
// quem está na frente dele" — rosto de fora, cartão alheio. Guardar isso como
// pendência encheria a tela de fantasmas que ninguém consegue vincular.
function lerBatida(valores = {}) {
  const usuarioNoAparelho = String(valores?.user_id ?? "").trim();
  const segundos = Number(valores?.time);
  const valido = Number.isFinite(segundos) && segundos > 0;

  return {
    usuarioNoAparelho,
    // Sem tempo utilizável, quem chama decide — a hora de agora é melhor que
    // descartar a entrada, mas essa escolha é da rota, não desta função.
    em: valido ? new Date(segundos * 1000) : null,
    reconhecido: usuarioNoAparelho !== "" && usuarioNoAparelho !== "0",
  };
}

// ── O QUE CHEGA, CRU ───────────────────────────────────────────────────────
//
// *"bote um botão para ver o histórico e dados bruto do que chega"*
// (06/10/2026).
//
// Integração com aparelho é caixa-preta até alguém abrir: o firmware manda o
// que quer, no formato dele, e quando algo não funciona a pergunta é sempre a
// mesma — "o que ele mandou, exatamente?". Sem isto a resposta é ler log de
// servidor por SSH, que é o mesmo que não ter resposta.
//
// ── O QUE NÃO ENTRA AQUI, E POR QUÊ ────────────────────────────────────────
//
// A pergunta de rotina do push ("tem comando pra mim?") é respondida com vazio
// 99,9% das vezes e chega de minuto em minuto. Guardá-la encheria a tela de
// linhas idênticas e esconderia a única que importa. Push só é registrado
// quando SAI um comando.
//
// A foto da identificação também não: ela é recebida e descartada (ver o
// cabeçalho de `controllers/ControlId.js`), e guardá-la aqui seria criar pela
// porta dos fundos o acervo de rostos que a decisão de LGPD recusou pela porta
// da frente. Fica registrado que chegou, sem o conteúdo.
// ── DESCARTAR UMA PENDÊNCIA ──────────────────────────────────────────────
//
// *"pode remover isso aqui"* (10/10/2026) — apontando para as 5 passagens do
// Usuário 2, que tinham acabado de ficar órfãs: ele apagou esse usuário na
// tela do aparelho, e o número nunca mais vai voltar a passar.
//
// Pendência existe para virar check-in retroativo quando alguém disser de quem
// é. A que nunca vai ter dono não é trabalho pendente — é sujeira em cima do
// que ainda precisa de resposta, e o custo dela é a lista inteira deixar de
// ser olhada.
//
// **Descartar APAGA frequência que nunca foi contada.** Por isso é um clique
// com confirmação, e por isso não há "descartar tudo": quem limpa uma lista
// inteira de uma vez não leu nenhuma linha.
Dispositivo_model.prototype.descartarPendencias = async function (dispositivo, usuarioNoAparelho) {
  if (!ObjectId.isValid(dispositivo)) return 0;

  const db = await this.app.mongodb.connectToServer();
  const r = await db.collection("access_device_pendings").deleteMany({
    dispositivo: new ObjectId(String(dispositivo)),
    usuarioNoAparelho: String(usuarioNoAparelho),
  });

  return r.deletedCount || 0;
};

Dispositivo_model.prototype.colecaoDeEventos = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("access_device_events");
};

// `original` é o texto exato que chegou pelo fio, quando quem chama o tem.
// Serve para o caso que custou três dias: um corpo que a gente não conseguiu
// ler vira `{}` depois do parse, e guardar esse `{}` esconderia justamente o
// byte que explica o problema. Com o original, o histórico mostra o que o
// firmware mandou — não a nossa leitura dele.
Dispositivo_model.prototype.registrarEvento = async function (
  dispositivo,
  tipo,
  corpo,
  original
) {
  if (!ObjectId.isValid(dispositivo)) return;

  const col = await this.colecaoDeEventos();
  // O corpo cru, limitado a 4 KB. É generoso para o que o aparelho manda e
  // impede que um firmware falante — ou uma foto que escapou — encha a
  // collection com um documento só.
  let cru = "";
  try {
    cru = JSON.stringify(corpo ?? {}).slice(0, 4096);
  } catch {
    cru = '"(corpo ilegível)"';
  }

  // Só quando o parse não rendeu nada E havia texto: aí o `{}` é mentira.
  if (cru === "{}" && typeof original === "string" && original.trim()) {
    cru = original.slice(0, 4096);
  }

  await col.insertOne({
    dispositivo: new ObjectId(String(dispositivo)),
    tipo: String(tipo).slice(0, 40),
    cru,
    em: new Date(),
  });
};

Dispositivo_model.prototype.eventos = async function (dispositivo) {
  if (!ObjectId.isValid(dispositivo)) return [];

  const col = await this.colecaoDeEventos();
  return col
    .find({ dispositivo: new ObjectId(String(dispositivo)) })
    .sort({ em: -1 })
    .limit(100)
    .toArray();
};

// ── AS BATIDAS ÓRFÃS, AGRUPADAS ────────────────────────────────────────────
//
// A tela não quer trezentas linhas "usuário 37 às 7h12, usuário 37 às 7h14":
// quer saber que **existe um usuário 37 que ninguém vinculou**, há quantas
// batidas e desde quando. Vinculado uma vez, o grupo inteiro vira frequência.
Dispositivo_model.prototype.pendencias = async function (dispositivo) {
  if (!ObjectId.isValid(dispositivo)) return [];

  const db = await this.app.mongodb.connectToServer();
  return db
    .collection("access_device_pendings")
    .aggregate([
      { $match: { dispositivo: new ObjectId(String(dispositivo)) } },
      {
        $group: {
          _id: "$usuarioNoAparelho",
          quantas: { $sum: 1 },
          primeira: { $min: "$em" },
          ultima: { $max: "$em" },
        },
      },
      { $sort: { ultima: -1 } },
      { $limit: 200 },
      { $project: { _id: 0, usuarioNoAparelho: "$_id", quantas: 1, primeira: 1, ultima: 1 } },
    ])
    .toArray();
};

Dispositivo_model.lerCadastro = lerCadastro;

module.exports = Dispositivo_model;
module.exports.lerBatida = lerBatida;
module.exports.gerarSegredo = gerarSegredo;
module.exports.hashDoSegredo = hashDoSegredo;
module.exports.separarCredencial = separarCredencial;
module.exports.lerIdCriado = lerIdCriado;
module.exports.lerResultadoDaFoto = lerResultadoDaFoto;
module.exports.lerFalha = lerFalha;
module.exports.estadoDoComando = estadoDoComando;
module.exports.semImagem = semImagem;
