// O TETO DO PLANO, aplicado de verdade.
//
// ── O que existia até 30/08/2026 ──────────────────────────────────────────
//
// O painel guardava seis limites por plano, a tela os mostrava, e NENHUM deles
// era consultado por rota nenhuma — só `brandImages`, no upload de imagem. Não é
// uma suspeita: o plano `basico` dizia "1 treino, 0 profissionais" enquanto a
// instância `marlon` tinha 628 treinos e 218 usuários.
//
// Um limite que ninguém verifica é pior que nenhum limite: ele parece uma
// promessa cumprida, tanto para quem vende quanto para quem compra.
//
// ── Os três estados, e por que zero não é "nada" ──────────────────────────
//
//   null / vazio   ILIMITADO — o plano inclui, sem teto
//   0              NÃO INCLUÍDO — o plano não tem este módulo
//   n              até n
//
// Zero é um limite de verdade, e é o que desliga um módulo. A mensagem dos dois
// casos é DIFERENTE de propósito: "seu plano não inclui agenda" manda falar com
// quem vende, e "você chegou a 50 pessoas" manda apagar ou subir de plano. A
// mesma frase para os dois faria metade das pessoas procurar a saída errada.
//
// ── Falha ABERTA, e é uma decisão ─────────────────────────────────────────
//
// Se o central não responde, `limitsFor` devolve `{}` e todo mundo passa. É a
// mesma escolha que já estava escrita lá: um limite inventado barraria um
// cliente que pagou, e isso é pior do que não barrar. Uma queda do painel não
// pode virar uma queda do produto.

const tetos = require("./tetosEstruturais.js");

// A contagem é de quem chama, e não daqui.
//
// Cada recurso conta de um jeito — pessoa ativa não é pessoa apagada, treino é
// por instância e chave de API tem dono. Uma função aqui com um `switch` de
// treze casos concentraria conhecimento que é dos modelos, e cada caso novo
// mexeria neste arquivo.
async function checar(app, instance, chave, contar) {
  const limites = await app.api.center.limitsFor(instance);
  const teto = limites ? limites[chave] : null;

  // Ilimitado. `undefined` também: um plano criado antes desta chave existir não
  // pode passar a barrar o que sempre deixou passar.
  if (teto === null || teto === undefined) return null;
  if (!Number.isInteger(teto) || teto < 0) return null;

  if (teto === 0) return { code: "not_in_plan", chave };

  // A contagem só acontece quando existe teto: sem isto, todo POST do sistema
  // ganharia um `countDocuments` para descobrir que não havia limite nenhum.
  const quantos = await contar();
  if (quantos < teto) return null;

  return { code: "plan_limit", chave, max: teto, atual: quantos };
}

// Responde 409 e devolve `true` quando barrou — para quem chama parar com um
// `if`, no mesmo formato dos outros portões do produto.
//
// 409 e não 403: não é falta de permissão, é o estado do mundo. A pessoa TEM o
// direito de criar; o que acabou foi a cota.
async function barrou(app, req, res, chave, contar) {
  const estouro = await checar(app, req.instance, chave, contar);
  if (!estouro) return false;

  res.status(409).send({
    msg:
      estouro.code === "not_in_plan"
        ? req.t("errors.notInPlan", { o: req.t("planLimits." + chave) })
        : req.t("errors.planLimitReached", { o: req.t("planLimits." + chave), max: estouro.max }),
    code: estouro.code,
    limit: chave,
    max: estouro.max,
  });

  return true;
}

// ── OS TETOS DE ESTRUTURA: quantos cabem DENTRO de um ─────────────────────
//
// "Alimentos por refeição", "exercícios por treino", "séries por exercício",
// "categorias de foto". Eles são de outra natureza que os limites acima, e três
// diferenças mudam o código:
//
//   1. A CONTAGEM VEM DO PEDIDO, não do banco. Não há `countDocuments` que
//      responda "quantos alimentos tem esta refeição que está chegando agora".
//   2. O CORTE É `>` E NÃO `>=`. Os outros são checados ANTES de criar mais um
//      ("já tem 50 pessoas, não pode a 51ª"). Aqui o pedido inteiro chega junto:
//      trinta alimentos com teto trinta é exatamente o permitido, e barrar seria
//      barrar o limite anunciado.
//   3. VAZIO É O PADRÃO DO SISTEMA, e nunca "ilimitado". Um teto anti-abuso que
//      desaparece quando o painel não respondeu não é um teto — ver a explicação
//      inteira em lib/tetosEstruturais.js, que é quem sabe os números.
//
// Responde 409 com o MESMO `code: "plan_limit"` dos outros. É de propósito: o
// dialog da vitrine no frontend acende por esse código, e "seu plano permite até
// 30 em alimentos por refeição" é a mesma conversa que "seu plano permite até 1
// em avaliações físicas".
async function barrouQuantidade(app, req, res, chave, quantos) {
  const limites = await app.api.center.limitsFor(req.instance);
  const teto = tetos.doPlano(limites, chave);

  if (Number(quantos) <= teto) return false;

  res.status(409).send({
    msg: req.t("errors.planLimitReached", { o: req.t("planLimits." + chave), max: teto }),
    code: "plan_limit",
    limit: chave,
    max: teto,
  });

  return true;
}

// O teto que vale, sem responder nada. Para quem precisa CORTAR em vez de
// recusar — é o caso das categorias de foto, cuja tela salva a lista inteira e
// cujo excedente é lixo de interface, não pedido legítimo.
async function tetoDoPlano(app, instance, chave) {
  const limites = await app.api.center.limitsFor(instance);
  return tetos.doPlano(limites, chave);
}

// ── AS CHAVES DE SIM/NÃO ──────────────────────────────────────────────────
//
// `appearance` e `whitelabel` não são teto, são permissão. A pergunta é "pode?",
// não "quantos?", e a contagem não existe.
//
// AUSENTE é SIM. Um plano criado antes destas chaves existirem não as tem, e
// tratá-las como "não" tiraria a aparência de quem já a usava — no dia do
// deploy, sem aviso, de todo cliente. É a mesma regra dos tetos: o que o plano
// não diz, ele não proíbe.
//
// Só um `false` explícito, gravado por alguém que desmarcou a caixa, desliga.
async function permite(app, instance, chave) {
  const limites = await app.api.center.limitsFor(instance);
  return !limites || limites[chave] !== false;
}

// Responde 403 e devolve `true` quando o plano não permite.
//
// 403 aqui e 409 no teto, e a diferença é real: teto é estado do mundo ("apague
// algo e volte"), permissão é o contrato ("seu plano não faz isso"). Quem lê o
// código da resposta precisa saber se existe conserto do lado de cá.
async function barrouChave(app, req, res, chave) {
  if (await permite(app, req.instance, chave)) return false;

  res.status(403).send({
    msg: req.t("errors.notInPlan", { o: req.t("planLimits." + chave) }),
    code: "not_in_plan",
    limit: chave,
  });

  return true;
}

// Contar os documentos DAQUELE cliente numa collection.
//
// O escopo é quem garante o "daquele cliente": `connectToServer()` devolve o
// banco já embrulhado por `lib/escopo.js`, que injeta `instance` em todo filtro.
// Contar aqui sem passar instância nenhuma não é descuido — é o contrário de
// descuido, porque escrever o filtro à mão em treze lugares é treze chances de
// esquecer num deles e contar o sistema inteiro.
function contarNa(app, collection, filtro = {}) {
  return async () => {
    const db = await app.mongodb.connectToServer();
    return db.collection(collection).countDocuments(filtro);
  };
}

module.exports = {
  checar,
  barrou,
  contarNa,
  permite,
  barrouChave,
  barrouQuantidade,
  tetoDoPlano,
};
