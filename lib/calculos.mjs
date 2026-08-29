// ⚠️  ARQUIVO ESPELHADO — NÃO EDITE AQUI.
//
// A fonte é o site:
//   gofitnow-frontend/src/views/student/assessments/calculos.js
//
// Cópia byte a byte, feita por `node scripts/formulasDoSite.mjs`, e há teste
// (test/lib/formulasEspelhadas.test.js) que quebra se os dois divergirem.
//
// Por que espelho e não import: são três programas diferentes. O site precisa das
// fórmulas no NAVEGADOR (o formulário recalcula a cada tecla), o app precisa delas
// no aparelho, e o backend precisa delas para montar o documento da avaliação.
// Reescrever seria manter três versões da mesma matemática — e a divergência entre
// elas é MUDA.

// As contas da avaliação física.
//
// Separadas da tela porque são a única parte com regra de verdade, e porque
// errar aqui é diferente de errar um layout: um percentual de gordura errado vai
// para um laudo, e a pessoa toma decisão em cima dele.
//
// Toda fórmula abaixo traz a FONTE no comentário. Sem isso, ninguém consegue
// conferir um número contra a literatura seis meses depois — e conferir é
// exatamente o que um profissional faz quando o resultado surpreende.
//
// Unidades, fixas em todo o módulo: peso em kg, altura em METROS, circunferência
// e dobra cutânea em cm e mm respectivamente. Misturar cm e m em altura é o erro
// clássico deste tipo de conta, e é por isso que só existe uma unidade aqui.

const numero = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const arredondar = (n, casas = 2) => {
  const f = 10 ** casas;
  return Math.round(n * f) / f;
};

// ── Altura ────────────────────────────────────────────────────────────────
//
// Sempre em METROS, venha ela como vier.
//
// O campo pede metros e mostra "m" ao lado, e ainda assim 175 é o que se
// digita — é o número que a pessoa sabe de cor. Não há ambiguidade a resolver
// aqui: gente mede entre 0,5 e 2,5 m, ou entre 50 e 250 cm, e as duas faixas
// não se encostam em lugar nenhum.
//
// Antes disto, 175 produzia IMC 0 — e 0 aparecia na tela classificado como
// "abaixo do peso". A ideia era que um resultado absurdo se denunciasse
// sozinho; ele não se denunciou, porque "abaixo do peso" é uma frase perfeitamente
// normal de se ler num laudo.
export function alturaMetros(valor) {
  const n = numero(valor);
  if (!n) return null;

  return n > 3 ? arredondar(n / 100) : n;
}

// ── IMC ───────────────────────────────────────────────────────────────────
//
// Peso dividido pela altura ao quadrado. A faixa é a da OMS.
export function imc(peso, altura) {
  const p = numero(peso);
  const a = alturaMetros(altura);
  if (!p || !a) return null;

  return arredondar(p / (a * a));
}

// As faixas da OMS para adultos. `key` é a chave de tradução; o rótulo sai na
// tela, porque este módulo não conhece idioma.
export const FAIXAS_IMC = [
  { key: "underweight", ate: 18.5 },
  { key: "normal", ate: 25 },
  { key: "overweight", ate: 30 },
  { key: "obese1", ate: 35 },
  { key: "obese2", ate: 40 },
  { key: "obese3", ate: Infinity },
];

export function classificarImc(valor) {
  if (typeof valor !== "number") return null;
  return FAIXAS_IMC.find((f) => valor < f.ate)?.key || null;
}

// ── Relação cintura-quadril ───────────────────────────────────────────────
//
// Indicador de distribuição de gordura. Os cortes de risco são diferentes entre
// homens e mulheres — usar um só para os dois classificaria metade das pessoas
// errado.
export function rcq(cintura, quadril) {
  const c = numero(cintura);
  const q = numero(quadril);
  if (!c || !q) return null;

  return arredondar(c / q);
}

export function classificarRcq(valor, sexo) {
  if (typeof valor !== "number") return null;

  // OMS: risco aumentado a partir de 0,90 (homens) e 0,85 (mulheres).
  const corte = sexo === "female" ? { bom: 0.8, moderado: 0.85 } : { bom: 0.9, moderado: 0.95 };

  if (valor < corte.bom) return "low";
  if (valor < corte.moderado) return "moderate";
  return "high";
}

// ── Frequência cardíaca máxima ────────────────────────────────────────────
//
// Tanaka (2001): 208 − 0,7 × idade. Substituiu o "220 − idade" na literatura
// porque aquele subestima em quem passa dos 40 — e é justamente essa faixa que
// mais depende do número para prescrever intensidade.
export function fcMaxima(idade) {
  const i = numero(idade);
  if (!i) return null;

  return Math.round(208 - 0.7 * i);
}

// ── Percentual de gordura ─────────────────────────────────────────────────
//
// Siri (1961) converte densidade corporal em percentual de gordura. É a etapa
// final comum a todos os protocolos de dobras.
function siri(densidade) {
  if (!densidade || densidade <= 0) return null;
  const pct = 495 / densidade - 450;
  return pct > 0 && pct < 75 ? arredondar(pct) : null;
}

// A soma das dobras que o protocolo pede — ou `null` se faltar UMA delas.
//
// Faltando uma, não há resultado. A tentação é somar o que tem e seguir, mas
// uma soma de três dobras entrando numa fórmula de quatro não devolve erro:
// devolve um percentual baixo e verossímil, que ninguém confere.
function somar(dobras, campos) {
  const valores = campos.map((c) => numero(dobras?.[c]));
  if (valores.some((v) => !v)) return null;

  return valores.reduce((a, b) => a + b, 0);
}

// Jackson & Pollock, 3 dobras.
//   Homens (1978):  peitoral, abdominal, coxa
//   Mulheres (1980): tríceps, supra-ilíaca, coxa
//
// As dobras NÃO são as mesmas entre os sexos — aplicar as do homem numa mulher
// dá um número plausível e errado, que é o pior tipo de erro.
export function pollock3(dobras, idade, sexo) {
  const i = numero(idade);
  if (!i) return null;

  const campos =
    sexo === "female"
      ? ["triceps", "suprailiac", "thigh"]
      : ["chest", "abdominal", "thigh"];

  const s = somar(dobras, campos);
  if (!s) return null;

  const densidade =
    sexo === "female"
      ? 1.0994921 - 0.0009929 * s + 0.0000023 * s * s - 0.0001392 * i
      : 1.10938 - 0.0008267 * s + 0.0000016 * s * s - 0.0002574 * i;

  return siri(densidade);
}

// Jackson & Pollock, 7 dobras: peitoral, axilar média, tríceps, subescapular,
// abdominal, supra-ilíaca e coxa. As sete são as mesmas para os dois sexos; o
// que muda são os coeficientes.
export function pollock7(dobras, idade, sexo) {
  const i = numero(idade);
  if (!i) return null;

  const campos = [
    "chest",
    "midaxillary",
    "triceps",
    "subscapular",
    "abdominal",
    "suprailiac",
    "thigh",
  ];

  const s = somar(dobras, campos);
  if (!s) return null;

  const densidade =
    sexo === "female"
      ? 1.097 - 0.00046971 * s + 0.00000056 * s * s - 0.00012828 * i
      : 1.112 - 0.00043499 * s + 0.00000055 * s * s - 0.00028826 * i;

  return siri(densidade);
}

// Guedes (1985), 3 dobras. Equação brasileira: foi validada em universitários
// brasileiros, e é por isso que ela existe ao lado da de Pollock — as
// generalizadas americanas superestimam a gordura na nossa população.
//
//   Homens:   tríceps, supra-ilíaca, abdominal
//   Mulheres: subescapular, supra-ilíaca, coxa
export function guedes3(dobras, idade, sexo) {
  const campos =
    sexo === "female"
      ? ["subscapular", "suprailiac", "thigh"]
      : ["triceps", "suprailiac", "abdominal"];

  const s = somar(dobras, campos);
  if (!s) return null;

  // Log na base 10 da SOMA, não de cada dobra. A idade não entra: Guedes é a
  // única das seis que dispensa a data de nascimento.
  const densidade =
    sexo === "female"
      ? 1.1665 - 0.07063 * Math.log10(s)
      : 1.17136 - 0.06706 * Math.log10(s);

  return siri(densidade);
}

// Durnin & Womersley (1974), 4 dobras: bíceps, tríceps, subescapular e
// supra-ilíaca — as mesmas quatro nos dois sexos.
//
// O que muda aqui não são só os coeficientes por sexo: são coeficientes por
// FAIXA ETÁRIA. É o protocolo mais antigo dos seis e o mais usado fora do
// esporte, justamente por não exigir dobra de tronco nem de perna.
const DURNIN = {
  male: [
    { ate: 20, c: 1.162, m: 0.063 },
    { ate: 30, c: 1.1631, m: 0.0632 },
    { ate: 40, c: 1.1422, m: 0.0544 },
    { ate: 50, c: 1.162, m: 0.07 },
    { ate: Infinity, c: 1.1715, m: 0.0779 },
  ],
  female: [
    { ate: 20, c: 1.1549, m: 0.0678 },
    { ate: 30, c: 1.1599, m: 0.0717 },
    { ate: 40, c: 1.1423, m: 0.0632 },
    { ate: 50, c: 1.1333, m: 0.0612 },
    { ate: Infinity, c: 1.1339, m: 0.0645 },
  ],
};

export function durnin4(dobras, idade, sexo) {
  const i = numero(idade);
  if (!i) return null;

  const s = somar(dobras, ["biceps", "triceps", "subscapular", "suprailiac"]);
  if (!s) return null;

  const faixa = (sexo === "female" ? DURNIN.female : DURNIN.male).find((f) => i < f.ate);

  return siri(faixa.c - faixa.m * Math.log10(s));
}

// Faulkner (1968), 4 dobras: tríceps, subescapular, supra-ilíaca e abdominal.
//
// A única das seis que devolve o percentual DIRETO, sem passar por densidade —
// e a única igual para os dois sexos. É rápida e imprecisa nos extremos; está
// aqui porque continua sendo a mais pedida em avaliação de rotina no Brasil.
export function faulkner4(dobras) {
  const s = somar(dobras, ["triceps", "subscapular", "suprailiac", "abdominal"]);
  if (!s) return null;

  const pct = s * 0.153 + 5.783;
  return pct > 0 && pct < 75 ? arredondar(pct) : null;
}

// Petroski (1995), 4 dobras. A outra equação brasileira, e a mais recente das
// seis.
//
//   Homens:   subescapular, tríceps, supra-ilíaca, panturrilha medial
//   Mulheres: axilar média, supra-ilíaca, coxa, panturrilha medial
//
// Repare que a panturrilha entra nos dois — é a marca do protocolo, e o motivo
// de ele precisar de uma dobra que Pollock nunca pede.
export function petroski4(dobras, idade, sexo) {
  const i = numero(idade);
  if (!i) return null;

  const campos =
    sexo === "female"
      ? ["midaxillary", "suprailiac", "thigh", "calf"]
      : ["subscapular", "triceps", "suprailiac", "calf"];

  const s = somar(dobras, campos);
  if (!s) return null;

  const densidade =
    sexo === "female"
      ? 1.1954713 - 0.07513507 * Math.log10(s) - 0.00041072 * i
      : 1.10726863 - 0.00081201 * s + 0.00000212 * s * s - 0.00041761 * i;

  return siri(densidade);
}

// Weltman (1987 para homens, 1988 para mulheres). Circunferência abdominal, sem
// adipômetro.
//
// Existe para um caso específico: pessoas com obesidade, em quem a dobra
// cutânea deixa de ser confiável — o adipômetro não fecha, e a pinça mede uma
// coisa diferente do que mediria num corpo magro. Por isso é um método à parte
// na tela, e não mais um protocolo de dobras.
//
//   Abdômen 1: na menor circunferência, entre a última costela e a crista ilíaca
//   Abdômen 2: na altura da cicatriz umbilical
export function weltman(abdomens, peso, altura, sexo) {
  const a1 = numero(abdomens?.abdomen1);
  const a2 = numero(abdomens?.abdomen2);
  const p = numero(peso);
  if (!a1 || !a2 || !p) return null;

  const media = (a1 + a2) / 2;

  let pct;
  if (sexo === "female") {
    const metros = alturaMetros(altura);
    const alturaCm = metros ? arredondar(metros * 100, 1) : null;
    // Só a equação feminina usa a altura. Sem ela não há resultado — estimar
    // uma altura para fechar a conta seria inventar o dado que mais pesa.
    if (!alturaCm) return null;
    pct = 0.11077 * media - 0.17666 * alturaCm + 0.14354 * p + 51.03301;
  } else {
    pct = 0.31457 * media - 0.10969 * p + 10.8336;
  }

  return pct > 0 && pct < 75 ? arredondar(pct) : null;
}

// ── O catálogo dos protocolos ─────────────────────────────────────────────
//
// Um lugar só com quem é quem: a tela lê daqui para montar o select, para
// destacar as dobras que o protocolo escolhido exige e para saber se ainda
// falta preencher alguma. Sem isto, a lista de dobras exigidas viveria
// duplicada entre a fórmula e o formulário — e um dia elas discordariam.
export const PROTOCOLOS = [
  {
    key: "pollock3",
    dobras: 3,
    fonte: "Jackson & Pollock, 1978/1980",
    sites: { male: ["chest", "abdominal", "thigh"], female: ["triceps", "suprailiac", "thigh"] },
    calcular: pollock3,
  },
  {
    key: "guedes3",
    dobras: 3,
    fonte: "Guedes, 1985",
    sites: {
      male: ["triceps", "suprailiac", "abdominal"],
      female: ["subscapular", "suprailiac", "thigh"],
    },
    calcular: guedes3,
  },
  {
    key: "durnin4",
    dobras: 4,
    fonte: "Durnin & Womersley, 1974",
    sites: {
      male: ["biceps", "triceps", "subscapular", "suprailiac"],
      female: ["biceps", "triceps", "subscapular", "suprailiac"],
    },
    calcular: durnin4,
  },
  {
    key: "faulkner4",
    dobras: 4,
    fonte: "Faulkner, 1968",
    sites: {
      male: ["triceps", "subscapular", "suprailiac", "abdominal"],
      female: ["triceps", "subscapular", "suprailiac", "abdominal"],
    },
    calcular: faulkner4,
  },
  {
    key: "petroski4",
    dobras: 4,
    fonte: "Petroski, 1995",
    sites: {
      male: ["subscapular", "triceps", "suprailiac", "calf"],
      female: ["midaxillary", "suprailiac", "thigh", "calf"],
    },
    calcular: petroski4,
  },
  {
    key: "pollock7",
    dobras: 7,
    fonte: "Jackson, Pollock & Ward, 1980",
    sites: {
      male: ["chest", "midaxillary", "triceps", "subscapular", "abdominal", "suprailiac", "thigh"],
      female: [
        "chest",
        "midaxillary",
        "triceps",
        "subscapular",
        "abdominal",
        "suprailiac",
        "thigh",
      ],
    },
    calcular: pollock7,
  },
];

export const PROTOCOLO_PADRAO = "pollock3";

export function protocoloDe(key) {
  return PROTOCOLOS.find((p) => p.key === key) || PROTOCOLOS[0];
}

// As dobras que o protocolo escolhido exige DESTE corpo. É o que a tela usa
// para acender umas e apagar as outras: quem mede Pollock 3 num homem não
// precisa saber que existe panturrilha.
export function sitesExigidos(key, sexo) {
  const p = protocoloDe(key);
  return p.sites[sexo === "female" ? "female" : "male"];
}

// Marinha americana (Hodgdon & Beckett, 1984). Só circunferências e altura —
// nenhum adipômetro necessário, que é o motivo de ela existir em quase todo
// software: dá para medir com uma fita métrica.
//
// Tudo em CENTÍMETROS aqui, inclusive a altura: a fórmula original é em
// polegadas, e estes coeficientes são a versão métrica dela.
export function marinha(medidas, altura, sexo) {
  const metros = alturaMetros(altura);
  const alturaCm = metros ? arredondar(metros * 100, 1) : null;
  const pescoco = numero(medidas?.neck);
  const cintura = numero(medidas?.waist);
  if (!alturaCm || !pescoco || !cintura) return null;

  let densidadeLog;

  if (sexo === "female") {
    const quadril = numero(medidas?.hip);
    if (!quadril) return null;
    // A mulher entra com o quadril: sem ele a fórmula feminina não existe.
    const soma = cintura + quadril - pescoco;
    if (soma <= 0) return null;
    densidadeLog =
      1.29579 - 0.35004 * Math.log10(soma) + 0.221 * Math.log10(alturaCm);
  } else {
    const diferenca = cintura - pescoco;
    // Cintura menor que o pescoço não é um corpo, é um erro de digitação — e o
    // log de número negativo devolveria NaN silencioso.
    if (diferenca <= 0) return null;
    densidadeLog =
      1.0324 - 0.19077 * Math.log10(diferenca) + 0.15456 * Math.log10(alturaCm);
  }

  const pct = 495 / densidadeLog - 450;
  return pct > 0 && pct < 75 ? arredondar(pct) : null;
}

// ── Massa gorda e massa magra ─────────────────────────────────────────────
export function composicao(peso, percentualGordura) {
  const p = numero(peso);
  if (!p || typeof percentualGordura !== "number") return null;

  const gordura = arredondar((p * percentualGordura) / 100, 1);
  return { fatMass: gordura, leanMass: arredondar(p - gordura, 1) };
}

// ── Faixa recomendada de gordura ──────────────────────────────────────────
//
// Pollock & Wilmore (1993). Depende de sexo E idade: 22% num homem de 25 anos é
// o teto da faixa; num de 45 é o meio dela. Um corte único chamaria de excesso
// o que é normal para a idade.
const FAIXAS_GORDURA = {
  male: [
    { ate: 35, min: 8, max: 22 },
    { ate: 56, min: 10, max: 25 },
    { ate: Infinity, min: 10, max: 25 },
  ],
  female: [
    { ate: 35, min: 20, max: 35 },
    { ate: 56, min: 23, max: 38 },
    { ate: Infinity, min: 25, max: 38 },
  ],
};

export function faixaGordura(idade, sexo) {
  const i = numero(idade);
  if (!i) return null;

  const { min, max } = (sexo === "female" ? FAIXAS_GORDURA.female : FAIXAS_GORDURA.male).find(
    (f) => i < f.ate
  );

  return { min, max };
}

export function classificarGordura(percentual, idade, sexo) {
  const faixa = faixaGordura(idade, sexo);
  if (!faixa || typeof percentual !== "number") return null;

  if (percentual < faixa.min) return "below";
  if (percentual > faixa.max) return "above";
  return "within";
}

// O peso que a pessoa teria dentro da faixa recomendada, mantida a massa magra.
//
// Uma FAIXA, não um número: o "peso ideal" de tabela é uma invenção — o que
// existe é o intervalo de peso em que o percentual de gordura fica saudável,
// e ele depende do quanto de músculo a pessoa carrega.
export function pesoIdeal(peso, percentualGordura, idade, sexo) {
  const c = composicao(peso, percentualGordura);
  const faixa = faixaGordura(idade, sexo);
  if (!c || !faixa) return null;

  // Mais gordura, mais peso: o teto de peso é o que corresponde ao TETO de
  // gordura da faixa, e o piso ao piso dela.
  return {
    min: arredondar(c.leanMass / (1 - faixa.min / 100), 1),
    max: arredondar(c.leanMass / (1 - faixa.max / 100), 1),
  };
}

// ── Idade ─────────────────────────────────────────────────────────────────
//
// Na DATA DA COLETA, não hoje: uma avaliação de dois anos atrás foi calculada
// com a idade de dois anos atrás, e recalcular com a de hoje mudaria um
// resultado já entregue.
export function idadeNa(nascimento, quando) {
  if (!nascimento) return null;

  // As DUAS datas lidas do mesmo jeito, como hora LOCAL.
  //
  // "1990-06-15" sozinho o JS lê como UTC; com "T00:00:00" ele lê como local.
  // Misturar os dois num fuso negativo tira um dia — e no dia do aniversário
  // isso tira um ano inteiro da idade, que entra direto na fórmula de dobras.
  const local = (valor) => {
    const texto = String(valor);
    return new Date(/^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto + "T00:00:00" : texto);
  };

  const nasc = local(nascimento);
  const data = quando ? local(quando) : new Date();
  if (Number.isNaN(nasc.getTime()) || Number.isNaN(data.getTime())) return null;

  let anos = data.getFullYear() - nasc.getFullYear();
  const mes = data.getMonth() - nasc.getMonth();
  if (mes < 0 || (mes === 0 && data.getDate() < nasc.getDate())) anos--;

  return anos > 0 && anos < 120 ? anos : null;
}

// ── Tudo de uma avaliação ─────────────────────────────────────────────────
//
// Uma função só, para a tela não precisar saber a ordem em que as contas
// dependem umas das outras — a composição depende do percentual, que depende da
// idade, que depende da data da coleta.
//
// O percentual "de referência" sai do MÉTODO escolhido na coleta — dobras,
// bioimpedância ou Weltman —, e nunca de uma mistura deles. Os três medem a
// mesma coisa por caminhos diferentes, e a diferença entre eles é grande o
// bastante para que somar ou promediar produza um número que nenhum dos três
// sustenta.
//
// Sem método declarado — toda avaliação salva antes desta tela existir — vale a
// ordem de confiabilidade: 7 dobras, 3 dobras, bioimpedância, marinha. A
// marinha é a última porque é a menos precisa, e usá-la tendo dobra em mãos
// seria escolher o pior dado disponível.
export function calcular(avaliacao, pessoa) {
  const idade = idadeNa(pessoa?.birthDate, avaliacao?.date);
  const sexo = pessoa?.sex;

  const valorImc = imc(avaliacao?.weight, avaliacao?.height);
  const valorRcq = rcq(avaliacao?.circumferences?.waist, avaliacao?.circumferences?.hip);

  const protocolo = protocoloDe(avaliacao?.protocol || PROTOCOLO_PADRAO);

  const gordura = {
    protocolo: protocolo.calcular(avaliacao?.skinfolds, idade, sexo),
    pollock7: pollock7(avaliacao?.skinfolds, idade, sexo),
    pollock3: pollock3(avaliacao?.skinfolds, idade, sexo),
    navy: marinha(avaliacao?.circumferences, avaliacao?.height, sexo),
    weltman: weltman(avaliacao?.weltman, avaliacao?.weight, avaliacao?.height, sexo),
    // A bioimpedância não é calculada: ela é DIGITADA, vinda do aparelho.
    bioimpedance: numero(avaliacao?.bioimpedance?.fatPercent),
  };

  const porMetodo = {
    skinfolds: gordura.protocolo,
    bioimpedance: gordura.bioimpedance,
    weltman: gordura.weltman,
  };

  // Com método declarado a resposta é a dele, mesmo quando é `null`: se quem
  // avaliou escolheu dobras e não terminou de preencher, a tela tem de dizer
  // "falta dobra" — e não responder com a bioimpedância do mês passado.
  const referencia = Object.hasOwn(porMetodo, avaliacao?.method || "")
    ? porMetodo[avaliacao.method]
    : gordura.pollock7 ?? gordura.pollock3 ?? gordura.bioimpedance ?? gordura.navy ?? null;

  return {
    idade,
    imc: valorImc,
    imcClass: classificarImc(valorImc),
    rcq: valorRcq,
    rcqClass: classificarRcq(valorRcq, sexo),
    fcMax: fcMaxima(idade),
    protocolo: protocolo.key,
    gordura,
    referencia,
    gorduraClass: classificarGordura(referencia, idade, sexo),
    faixaGordura: faixaGordura(idade, sexo),
    composicao: composicao(avaliacao?.weight, referencia),
    pesoIdeal: pesoIdeal(avaliacao?.weight, referencia, idade, sexo),
  };
}
