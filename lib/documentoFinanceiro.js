const { rotulos } = require("./rotulosDeDocumento.js");
const {
  TINTA, FRACO, LINHA, escapar, dinheiro, formatarData, formatarDataHora, secao, cartoes, pagina,
} = require("./documentoBase.js");

// O EXTRATO FINANCEIRO DE UMA PESSOA, em HTML, montado no servidor.
//
// Pedido do Marlon em 17/09/2026, na aba Financeiro da ficha: *"bote checkbox
// aqui com opções etc... pode exportar xlsx e pdf com a logo bonita foto e dados
// do cliente"*. A PLANILHA sai na tela (`views/financeiro/exportar.js`), porque
// ninguém abre planilha para olhar — abre para somar. O PDF sai daqui.
//
// ── Por que no servidor, como a avaliação e a dieta ───────────────────────
//
// Mesma razão das outras duas folhas: o app precisa do MESMO extrato, e uma
// versão desenhada em React nasceria de outro código. Duas folhas do mesmo
// dinheiro divergem na primeira mudança, e divergem caladas — ninguém confere um
// PDF do site contra um do celular. Aqui é um HTML só, e dele saem as quatro
// saídas (ver, imprimir, baixar, e-mail).
//
// ── AUTOSSUFICIENTE e com estilo INLINE ──────────────────────────────────
//
// As mesmas duas regras da base: nada de `<link>`, `<script>` ou `src` externo —
// a FOTO entra como `data:` URI —, e todo estilo em `style=`, porque cliente de
// e-mail remove `<style>` e é ele quem tem a regra mais dura.
//
// ── ESTE MÓDULO NÃO FALA COM O BANCO ─────────────────────────────────────
//
// Quem busca as cobranças, os pagamentos, a foto e a logo é a rota. Aqui entram
// dados prontos e sai texto — que é o que torna o extrato testável sem MongoDB,
// e é o mesmo contrato de `documentoAvaliacao` e `documentoDieta`.

// ── O DINHEIRO QUE ENTROU MESMO ──────────────────────────────────────────
//
// A MESMA regra de `entrou()` no modelo: pendente é promessa e reembolsado é
// dinheiro que voltou. Somá-los faria o extrato dizer que a pessoa está quite
// quando ela não está — e este papel é o que ela leva para casa.
const entrou = (p) => (p.status || "paid") === "paid";

// A situação de uma cobrança é CALCULADA, e não um campo.
//
// "Paga" é consequência de os pagamentos cobrirem o valor, e "vencida" é o
// relógio. Só `canceled` está gravado. Ler o campo aqui faria a folha dizer
// "em aberto" numa cobrança com os pagamentos listados logo abaixo dela.
function situacao(t, cobranca, pago, hoje) {
  if (cobranca.status === "canceled") return { texto: t("finance.canceled"), cor: FRACO };

  const falta = Math.max(0, (cobranca.amount || 0) - pago);
  if (falta === 0) return { texto: t("finance.statusPaid"), cor: "#059669" };

  const vence = cobranca.dueDate ? new Date(cobranca.dueDate).getTime() : 0;
  if (vence && vence < hoje) return { texto: t("finance.late"), cor: "#e11d48" };

  return { texto: t("finance.open"), cor: TINTA };
}

// ── A FICHA DA PESSOA: foto à esquerda, dados à direita ──────────────────
//
// Tabela e `valign`, não flex — a folha é a mesma no corpo do e-mail, e cliente
// de e-mail antigo não implementa flex: sairia tudo empilhado.
//
// Sem foto, a coluna some em vez de virar um quadrado cinza. Um retângulo vazio
// num extrato não informa nada e dá a impressão de imagem quebrada.
function ficha(t, person, foto, lang, fuso) {
  const dados = [
    [t("people.phone"), person?.phone],
    [t("auth.email"), person?.email],
    [t("people.birthDate"), person?.birthDate ? formatarData(person.birthDate, lang, fuso) : ""],
  ].filter(([, valor]) => valor);

  if (!foto && !dados.length) return "";

  const contato = dados
    .map(
      ([rotulo, valor]) =>
        `<div style="margin-top:3px;font-size:12px;color:${FRACO};">${escapar(rotulo)}: <span style="color:${TINTA};">${escapar(valor)}</span></div>`
    )
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px;">
    <tr>
      ${
        foto
          ? `<td valign="top" width="1" style="padding-right:14px;">
               <img src="${escapar(foto)}" alt="" width="72" height="72" style="width:72px;height:72px;border-radius:8px;border:1px solid ${LINHA};display:block;object-fit:cover;" />
             </td>`
          : ""
      }
      <!-- SEM O NOME AQUI: ele já é o título da folha, três linhas acima.
           *"ta mostrando o nome duas vezes"*. Esta ficha é o CONTATO — é para
           onde se olha quando se vai ligar ou mandar mensagem. -->
      <td valign="middle">
        ${contato}
      </td>
    </tr>
  </table>`;
}

// ── O ESPAÇO ENTRE AS COLUNAS É PADDING, e não `border-spacing` ──────────
//
// A primeira versão tinha `padding:8px 0` — zero nas laterais —, e as duas
// últimas colunas saíram COLADAS: o cabeçalho lia "FALTASITUAÇÃO" e a linha,
// "R$ 0,00Paga". Valor à direita encostando em texto à esquerda não deixa nem
// um espaço de fonte entre os dois.
//
// Padding lateral, e não `border-spacing` na tabela: com `border-collapse`
// ligado (que é o que faz a linha divisória ser uma só) o `border-spacing` é
// ignorado. E `cellpadding` não vale para quem lê o HTML como e-mail moderno.
const CABECA = `font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${FRACO};padding:0 10px 6px;border-bottom:1px solid ${LINHA};`;
const CELULA = `font-size:12px;color:${TINTA};padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top;`;

// ── AS COBRANÇAS, com os pagamentos DENTRO de cada uma ───────────────────
//
// Os pagamentos ficavam numa lista à parte, e o mesmo R$ 80,00 aparecia duas
// vezes na folha — uma na cobrança "Paga", outra embaixo — parecendo dinheiro em
// dobro. Foi a mesma correção feita na tela da ficha, e o papel herdou.
//
// Cada pagamento é uma LINHA própria da tabela e não uma lista dentro da célula:
// numa tabela, uma lista aninhada quebra em cliente de e-mail antigo, e o que se
// quer aqui — data, forma e valor alinhados com as colunas de cima — é
// exatamente o que uma linha dá de graça.
function tabelaDeCobrancas(t, cobrancas, pagamentosPor, moedaPadrao, lang, fuso, nomeDaForma) {
  if (!cobrancas.length) return "";

  const hoje = new Date().setHours(0, 0, 0, 0);

  const linhas = cobrancas
    .map((c) => {
      const moeda = c.currency || moedaPadrao;
      const doLote = pagamentosPor[String(c._id)] || [];
      const pago = doLote.filter(entrou).reduce((soma, p) => soma + (p.amount || 0), 0);
      const sit = situacao(t, c, pago, hoje);

      // CANCELADA não tem "falta": ela saiu do "Cobrado" lá em cima, e escrever
      // "falta R$ 40,00" numa linha que não é mais dívida faria a coluna não
      // fechar com o total — três linhas canceladas e ninguém entende a conta.
      const cancelada = c.status === "canceled";
      const falta = cancelada ? null : Math.max(0, (c.amount || 0) - pago);

      const cobranca = `<tr>
        <td style="${CELULA}padding-left:0;white-space:nowrap;color:${FRACO};font-variant-numeric:tabular-nums;">${c.numero ? "#" + escapar(c.numero) : ""}</td>
        <td style="${CELULA}">${escapar(c.description || "—")}</td>
        <td style="${CELULA}white-space:nowrap;">${escapar(formatarData(c.dueDate, lang, fuso))}</td>
        <td style="${CELULA}text-align:right;white-space:nowrap;font-weight:600;">${escapar(dinheiro(c.amount, moeda))}</td>
        <td style="${CELULA}text-align:right;white-space:nowrap;">${escapar(dinheiro(pago, moeda))}</td>
        <td style="${CELULA}text-align:right;white-space:nowrap;">${falta === null ? "—" : escapar(dinheiro(falta, moeda))}</td>
        <td style="${CELULA}padding-right:0;text-align:right;white-space:nowrap;color:${sit.cor};font-weight:600;">${escapar(sit.texto)}</td>
      </tr>`;

      // O recuo (`padding-left`) é o que diz que a linha pertence à de cima.
      // Sem ele, um pagamento parcial vira uma segunda cobrança aos olhos de
      // quem lê a folha sem o sistema ao lado.
      const recebidos = doLote
        .map(
          (p) => `<tr>
            <td colspan="4" style="${CELULA}padding-left:14px;color:${FRACO};">
              ${escapar(formatarData(p.date, lang, fuso))} · ${escapar(nomeDaForma(p.method))}${p.note ? " · " + escapar(p.note) : ""}
            </td>
            <td style="${CELULA}text-align:right;white-space:nowrap;color:${entrou(p) ? "#059669" : FRACO};">${escapar(dinheiro(p.amount, p.currency || moeda))}</td>
            <td colspan="2" style="${CELULA}padding-right:0;"></td>
          </tr>`
        )
        .join("");

      return cobranca + recebidos;
    })
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
    <tr>
      <!-- O NÚMERO abre a linha: é o que se dita ao telefone quando alguém
           liga perguntando "qual fatura?". -->
      <th align="left" style="${CABECA}padding-left:0;">${escapar(t("finance.colNumber"))}</th>
      <th align="left" style="${CABECA}">${escapar(t("finance.colWhat"))}</th>
      <th align="left" style="${CABECA}">${escapar(t("finance.colDue"))}</th>
      <th align="right" style="${CABECA}">${escapar(t("finance.colAmount"))}</th>
      <th align="right" style="${CABECA}">${escapar(t("finance.paid"))}</th>
      <th align="right" style="${CABECA}">${escapar(t("finance.left"))}</th>
      <th align="right" style="${CABECA}padding-right:0;">${escapar(t("finance.colStatus"))}</th>
    </tr>
    ${linhas}
  </table>`;
}

// Os pagamentos AVULSOS — adiantamento, venda solta, pagamento cuja cobrança foi
// apagada. Sem esta seção eles entrariam no "Recebido" do topo sem uma linha na
// folha dizendo de onde vieram, e a soma pareceria errada.
function tabelaDeAvulsos(t, pagamentos, moedaPadrao, lang, fuso, nomeDaForma) {
  if (!pagamentos.length) return "";

  const linhas = pagamentos
    .map(
      (p) => `<tr>
        <td style="${CELULA}padding-left:0;white-space:nowrap;">${escapar(formatarData(p.date, lang, fuso))}</td>
        <td style="${CELULA}">${escapar(nomeDaForma(p.method))}${p.note ? " · " + escapar(p.note) : ""}</td>
        <td style="${CELULA}padding-right:0;text-align:right;white-space:nowrap;color:${entrou(p) ? "#059669" : FRACO};font-weight:600;">${escapar(dinheiro(p.amount, p.currency || moedaPadrao))}</td>
      </tr>`
    )
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
    <tr>
      <th align="left" style="${CABECA}padding-left:0;">${escapar(t("finance.date"))}</th>
      <th align="left" style="${CABECA}">${escapar(t("finance.methodLabel"))}</th>
      <th align="right" style="${CABECA}padding-right:0;">${escapar(t("finance.colAmount"))}</th>
    </tr>
    ${linhas}
  </table>`;
}

// ── OS TOTAIS SÃO DO QUE ESTÁ NA FOLHA ───────────────────────────────────
//
// Quando a pessoa marca três cobranças e manda imprimir, o topo tem de somar
// essas três. Repetir o saldo da conta inteira faria a folha mostrar um
// "Cobrado" que não bate com nenhuma linha abaixo dele — e o extrato existe
// justamente para alguém conferir linha por linha.
//
// Cancelada não entra no cobrado: ela existe como registro, não como dívida. É a
// mesma regra do `balanceOf`.
function somar(cobrancas, pagamentos) {
  let cobrado = 0;
  let recebido = 0;

  for (const c of cobrancas) {
    if (c.status === "canceled") continue;
    cobrado += c.amount || 0;
  }

  for (const p of pagamentos) {
    if (!entrou(p)) continue;
    recebido += p.amount || 0;
  }

  return { cobrado, recebido, saldo: cobrado - recebido };
}

function documentoFinanceiro({
  person,
  charges = [],
  payments = [],
  moeda = "BRL",
  // O nome da forma de pagamento vem do catálogo da conta, e a rota o resolve:
  // "cheque" gravado tem de sair como "Cheque". Sem catálogo, cai na tradução.
  formas = {},
  foto = null,
  lang = "pt-BR",
  fuso = "UTC",
  marca = null,
  emitidoEm = new Date(),
}) {
  const t = rotulos(lang);

  const nomeDaForma = (chave) =>
    formas[chave] || t(`finance.method.${chave || "other"}`) || String(chave || "");

  const pagamentosPor = {};
  const avulsos = [];

  for (const p of payments) {
    if (!p.charge) {
      avulsos.push(p);
      continue;
    }
    const k = String(p.charge);
    (pagamentosPor[k] = pagamentosPor[k] || []).push(p);
  }

  const total = somar(charges, payments);

  const corpo = [
    ficha(t, person, foto, lang, fuso),
    `<div style="margin-top:18px;"></div>`,
    cartoes([
      [t("finance.charged"), dinheiro(total.cobrado, moeda)],
      [t("finance.paid"), dinheiro(total.recebido, moeda)],
      // Saldo NEGATIVO é crédito: quem pagou o semestre adiantado tem dinheiro a
      // favor, e escrever "A receber −R$ 200" seria mentira. A tela já faz essa
      // troca de rótulo; o papel faz a mesma.
      [
        total.saldo < 0 ? t("finance.credit") : t("finance.due"),
        dinheiro(Math.abs(total.saldo), moeda),
      ],
    ]),
    // ── A TABELA DE COBRANÇAS VEM SEM TÍTULO ────────────────────────────
    //
    // *"pode remover o texto Cobranças"*. Ela é o corpo da folha, e o cabeçalho
    // dela já diz o que cada coluna é. Um título anunciando o óbvio rouba a
    // linha que separa os totais da tabela.
    //
    // Os avulsos ABAIXO continuam com o deles: sem "Pagamentos" escrito, uma
    // segunda tabela apareceria do nada e pareceria continuação da primeira.
    secao("", tabelaDeCobrancas(t, charges, pagamentosPor, moeda, lang, fuso, nomeDaForma)),
    secao(t("finance.payments"), tabelaDeAvulsos(t, avulsos, moeda, lang, fuso, nomeDaForma)),
    charges.length || avulsos.length
      ? ""
      : `<p style="margin:24px 0 0;text-align:center;font-size:12px;color:${FRACO};">${escapar(t("finance.empty"))}</p>`,
  ].join("");

  return pagina({
    lang,
    titulo: t("finance.statement"),
    nome: person?.name,
    // COM HORA, aqui e no rodapé: dois extratos do mesmo dia precisam ser
    // distinguíveis, e é no mesmo dia que eles saem.
    subtitulo: `${t("finance.statement")} · ${formatarDataHora(emitidoEm, lang, fuso)}`,
    corpo,
    rodape: `${person?.name || ""} · ${formatarDataHora(emitidoEm, lang, fuso)}`,
    marca,
  });
}

module.exports = { documentoFinanceiro, dinheiro, somar };
