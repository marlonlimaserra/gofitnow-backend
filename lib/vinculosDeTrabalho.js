// O VÍNCULO DE UM FUNCIONÁRIO — CLT, PJ, estágio, autônomo.
//
// *"crie mais um item no menu, chamado funcionários, para a gente cadastrar o
// funcionário, ver folha de ponto, salário, advertências, anotações e outras
// coisas que funcionário pode ter que eu não sei"*.
//
// ── POR QUE O VÍNCULO É A PRIMEIRA COISA QUE A FICHA PERGUNTA ────────────
//
// Porque ele muda o que o resto da ficha significa. O CLT tem CTPS, PIS, férias
// e 13º; o PJ emite nota e não tem nenhum dos quatro; o estagiário tem bolsa e
// termo de compromisso, não salário. Uma ficha só, sem o vínculo, mostraria
// campo de CTPS para o personal que é PJ — e é assim que se ensina alguém a
// preencher errado.
//
// ── ELES NÃO GERAM REGRA, e isso é de propósito ─────────────────────────
//
// Nada aqui calcula rescisão, FGTS ou INSS. Isto é um CADASTRO, não uma folha
// de pagamento: quem calcula encargo é a contabilidade, com o software dela e a
// responsabilidade dela.
//
// O que este módulo faz é guardar o que a academia precisa ter à mão — quem
// trabalha aqui, desde quando, ganhando quanto, e o que aconteceu no caminho.
// No dia em que ele quiser calcular, a conversa começa por aqui.
//
// `clt` e não `carteira_assinada`: a chave é contrato e viaja para o app; o
// rótulo é apresentação e é traduzido.
const VINCULOS = [
  // A ORDEM é a da frequência numa academia pequena: a recepção e a limpeza são
  // CLT, os professores quase sempre PJ, e o estagiário aparece uma vez por ano.
  { id: "clt", rotulo: "employees.bond.clt", padrao: "CLT" },
  { id: "pj", rotulo: "employees.bond.pj", padrao: "PJ" },
  { id: "autonomo", rotulo: "employees.bond.autonomous", padrao: "Autônomo" },
  { id: "estagio", rotulo: "employees.bond.intern", padrao: "Estágio" },
  { id: "aprendiz", rotulo: "employees.bond.apprentice", padrao: "Jovem aprendiz" },
  { id: "temporario", rotulo: "employees.bond.temporary", padrao: "Temporário" },
  { id: "socio", rotulo: "employees.bond.partner", padrao: "Sócio" },
  { id: "voluntario", rotulo: "employees.bond.volunteer", padrao: "Voluntário" },
];

const IDS = VINCULOS.map((v) => v.id);

// ── QUEM TEM CARTEIRA ─────────────────────────────────────────────────────
//
// É o que decide se a ficha mostra CTPS e PIS/PASEP. O aprendiz tem os dois: o
// contrato de aprendizagem é registrado em carteira, e esquecer isso faria a
// ficha dele nascer incompleta.
const COM_CARTEIRA = ["clt", "aprendiz", "temporario"];

function existe(id) {
  return IDS.includes(String(id || ""));
}

function paraTela(t) {
  return VINCULOS.map((v) => ({
    id: v.id,
    label: t ? t(v.rotulo) : v.padrao,
    carteira: COM_CARTEIRA.includes(v.id),
  }));
}

module.exports = { VINCULOS, IDS, COM_CARTEIRA, existe, paraTela };
