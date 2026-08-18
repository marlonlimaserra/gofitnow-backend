const instanceContext = require("../lib/instance.js");

// De QUEM é este e-mail.
//
// É a pergunta que `app.gofitnow.fit` faz antes de existir sessão. Todo o resto
// do sistema descobre o cliente pelo ENDEREÇO — `bruna.gofitnow.fit` diz
// "bruna", e o `instanceGate` confere isso contra a central. Mas o portal
// genérico não é o endereço de ninguém de propósito, então lá o endereço não
// diz nada, e a única pista que a pessoa tem para dar é o e-mail dela.
//
// ── Por que a central não basta ───────────────────────────────────────────
//
// A coleção `instances` TEM um campo `email`, e ele já é único — mas é o e-mail
// do DONO da instância. São 2 desses hoje, contra 218 pessoas que fazem login:
// os outros 216 moram em `gofitnow_<instancia>.users` e a central nunca soube
// deles. Procurar só na central acertaria o Marlon e a Bruna e falharia com
// todos os alunos e pacientes.
//
// ── Por que varrer as instâncias, e não manter um índice ──────────────────
//
// A alternativa era uma coleção central `email → instância`, mantida a cada
// usuário criado, editado e removido. É mais rápida e é uma dívida: no dia em
// que um desses gatilhos falhar, alguém não consegue mais entrar, e o sintoma
// ("meu e-mail não existe") não aponta para a causa.
//
// Aqui a varredura é a VERDADE e o cache é só velocidade. Com duas instâncias
// são duas consultas; o cache faz a segunda tentativa da mesma pessoa custar
// zero. Se um dia forem cem clientes, o que entra é um índice central — e ele
// entra como cache deste método, não como fonte: erro de índice volta a varrer
// em vez de trancar a porta.
function Portal_model(app) {
  this.app = app;
}

// O cache é POSITIVO E NEGATIVO, com prazos diferentes.
//
// Achou: 10 minutos, porque a resposta quase nunca muda — a pessoa não troca de
// clínica no meio da tarde.
//
// Não achou: 30 segundos, e curto de propósito. Alguém que acabou de ser
// cadastrado tenta entrar em seguida, e um "não existe" guardado por dez minutos
// transformaria o convite recém-aceito em "o sistema não me conhece".
const ACHOU_MS = 10 * 60 * 1000;
const NAO_ACHOU_MS = 30 * 1000;

const cache = new Map();

function lido(email) {
  const item = cache.get(email);
  if (!item) return undefined;
  if (Date.now() > item.vence) {
    cache.delete(email);
    return undefined;
  }
  return item.valor;
}

function guardar(email, valor) {
  const prazo = valor.length ? ACHOU_MS : NAO_ACHOU_MS;
  cache.set(email, { valor, vence: Date.now() + prazo });
  return valor;
}

Portal_model.prototype.forget = function () {
  cache.clear();
};

function normalizar(email) {
  return String(email || "").trim().toLowerCase();
}

// Devolve a lista de instâncias em que este e-mail entra.
//
// LISTA, e não uma só: a mesma pessoa pode ser aluna de uma academia e paciente
// de uma clínica, e o e-mail dela existe nos dois bancos. Devolver a primeira
// que aparecer faria a segunda ser inalcançável pelo portal, sem nenhum aviso —
// e quem descobriria seria o cliente, tentando entrar e caindo no lugar errado.
Portal_model.prototype.instancesForEmail = async function (email) {
  const limpo = normalizar(email);
  if (!limpo || !limpo.includes("@")) return [];

  const guardado = lido(limpo);
  if (guardado !== undefined) return guardado;

  const registros = await this.app.api.center.list();
  const ativas = registros.filter((r) => r.active !== false && r.active !== 0);

  const achadas = [];

  for (const registro of ativas) {
    // O dono primeiro: é uma comparação em memória, com o que a central já
    // devolveu, e resolve o caso do profissional sem abrir banco nenhum.
    if (normalizar(registro.email) === limpo) {
      achadas.push(registro);
      continue;
    }

    // Cada instância é consultada DENTRO do contexto dela: os modelos leem a
    // instância do contexto assíncrono e estouram fora dele, de propósito.
    try {
      const usuario = await instanceContext.run(registro.instance, () =>
        this.app.api.user.dataByEmail(limpo)
      );
      if (usuario) achadas.push(registro);
    } catch (error) {
      // Um cliente com banco fora do ar não pode derrubar a busca dos outros.
      // Ele fica de fora desta resposta e volta na próxima — melhor um resultado
      // incompleto que nenhum.
      console.error(
        `[portal] não consegui procurar em ${registro.instance}: ${error.message}`
      );
    }
  }

  return guardar(limpo, achadas);
};

// O que a TELA recebe: só endereço e nome, nunca o nome da instância.
//
// A instância é identificador interno, e o resto do sistema trata isso como
// segredo — o `/public/theme` recusa dizer de quem é um endereço justamente para
// não entregar o mapa "domínio → cliente" numa rota sem sessão. Aqui a tela não
// precisa dela: para redirecionar basta o host, e o `instanceGate` do outro lado
// volta a resolver instância por endereço como sempre fez.
//
// Instância sem host cai fora. Ela existe (`ensure` cria com `hosts: []`), e
// mandar a pessoa para um endereço que não responde é pior que dizer que não
// achou: ela ficaria numa página morta sem saber o que fazer.
Portal_model.prototype.destinosParaEmail = async function (email) {
  const achadas = await this.instancesForEmail(email);

  return achadas
    .filter((r) => Array.isArray(r.hosts) && r.hosts.length)
    .map((r) => ({ host: r.hosts[0], name: r.name || r.hosts[0] }));
};

// ── O NOME DA INSTÂNCIA de quem se cadastra sozinho ────────────────────────
//
// Até agora quem escolhia era o painel, uma por uma, com uma pessoa olhando.
// No autoatendimento não há essa pessoa, então o nome sai do nome digitado — é a
// única coisa que se sabe, e é o que a profissional reconhece no endereço dela.
//
// "Bruna Sampaio" → `bruna-sampaio`, e não `bruna`. O primeiro nome sozinho
// seria mais bonito e colide com muito mais frequência: já existe uma `bruna`, e
// a segunda Bruna a se cadastrar viraria `bruna2` — que é pior de ler que
// `bruna-sampaio` e não diz nada sobre quem é.
const TAMANHO_MAXIMO = 30;

function slugDoNome(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TAMANHO_MAXIMO)
    // O corte pode ter deixado um hífen na ponta, e o padrão de instância exige
    // começar e terminar em letra ou número.
    .replace(/-+$/g, "");
}

// Devolve um nome de instância LIVRE, ou "" quando não há nome possível.
//
// A conferência é contra a central e contra os nomes reservados — `admin`,
// `config`, `center`. Sem a segunda, alguém chamado "Admin" ganharia uma
// instância com nome que o resto do sistema trata de outro jeito.
//
// O sufixo numérico existe porque duas pessoas com o mesmo nome é questão de
// tempo, não hipótese. Vinte tentativas e desiste: se `bruna-sampaio20` já
// existe, o problema não é mais de nome.
Portal_model.prototype.slugLivre = async function (nome) {
  const base = slugDoNome(nome);
  if (!base) return "";

  for (let i = 0; i < 20; i++) {
    const tentativa = i === 0 ? base : `${base}${i + 1}`.slice(0, 40);

    if (!instanceContext.normalize(tentativa)) continue;
    if (instanceContext.RESERVADOS.has(tentativa)) continue;

    const existe = await this.app.api.center.byInstance(tentativa);
    if (!existe) return tentativa;
  }

  return "";
};

module.exports = Portal_model;
module.exports.slugDoNome = slugDoNome;
