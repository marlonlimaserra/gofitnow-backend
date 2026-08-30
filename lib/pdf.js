// HTML → PDF, com o Chromium do servidor.
const redis = require("./redis.js");
//
// ── Por que um navegador de verdade, e não uma biblioteca de PDF ──────────
//
// O pedido do Marlon foi explícito sobre o porquê: *"pode ser os dois, aí a
// pessoa clica ver PDF, aí mostra o HTML pronto, aí se ela clicar baixar PDF aí
// o servidor gera o PDF com esse html"*. **Com esse HTML** — o mesmo, não um
// parecido.
//
// Uma biblioteca de PDF (pdfkit e afins) obrigaria a redesenhar o documento
// numa segunda linguagem de desenho, e aí existiriam duas versões para
// divergir: exatamente o que a arquitetura toda foi montada para evitar. O
// navegador lê o HTML que já existe e imprime o que a pessoa acabou de ver.
//
// ── O custo, e como ele é pago ────────────────────────────────────────────
//
// Chromium come uns 200 MB enquanto está aberto, numa máquina de 4 GB que já
// tem o Mongo dentro. Por isso, aqui:
//
//   • só a rota de BAIXAR paga isto — ver e imprimir são HTML puro;
//   • um navegador só, reaproveitado entre pedidos (abrir custa ~1 s);
//   • uma página por vez (a fila abaixo), para dois cliques simultâneos não
//     virarem dois Chromium;
//   • ele FECHA sozinho depois de ocioso, devolvendo a memória. Manter 200 MB
//     presos o dia inteiro por causa de um recurso raro é o troco errado;
//   • e o resultado é GUARDADO por conteúdo (ver `pdfDeHtml`), então o mesmo
//     documento pedido duas vezes só custa uma.

// ── QUANTO O NAVEGADOR ESPERA ANTES DE FECHAR ────────────────────────────
//
// Eram 2 minutos, e a conta estava errada — medida no servidor em 30/08/2026:
//
//   primeiro PDF (subindo o navegador) : 4.545 ms
//   PDFs seguintes                     :   532 ms
//
// Nove vezes mais caro. Com dois minutos de espera e o uso esparso de hoje,
// QUASE TODO PDF pagava os 4,5 segundos — o navegador nunca chegava a ser
// reaproveitado, que era exatamente o motivo de ele existir.
//
// Vinte minutos cobre a sessão de trabalho de verdade: fechar a avaliação,
// baixar, olhar, mandar por e-mail. O troco são ~200 MB presos por mais tempo, e
// eles voltam sozinhos quando ninguém usa.
const OCIOSO_MS = 20 * 60 * 1000;
const TEMPO_LIMITE_MS = 30 * 1000;

let puppeteer = null;
let procurado = false;

// O puppeteer é opcional DE PROPÓSITO.
//
// Ele arrasta um Chromium de ~150 MB, e nem toda máquina que roda esta base
// precisa dele: numa de desenvolvimento, `npm install` sem ele deve funcionar, e
// ver/imprimir/e-mail continuam inteiros — só o botão de baixar some.
//
// Um `require` no topo do arquivo transformaria "sem puppeteer" em "servidor não
// sobe".
function carregar() {
  if (procurado) return puppeteer;
  procurado = true;

  try {
    puppeteer = require("puppeteer");
  } catch {
    console.warn("[pdf] puppeteer ausente — a rota de baixar PDF responde 503");
    puppeteer = null;
  }

  return puppeteer;
}

function pdfDisponivel() {
  // `PDF_DISABLED=1` desliga sem desinstalar nada. Serve a duas coisas: teste
  // que exercita a rota de e-mail sem levantar um Chromium por caso, e uma
  // válvula para desligar a conversão em produção sem deploy, no dia em que ela
  // estiver comendo a memória da máquina.
  if (process.env.PDF_DISABLED === "1") return false;

  return carregar() !== null;
}

let navegador = null;
let abrindo = null;
let desligar = null;

function adiarDesligamento() {
  clearTimeout(desligar);
  desligar = setTimeout(fechar, OCIOSO_MS);
  // Um timer pendente segura o processo vivo. Este aqui existe para ECONOMIZAR
  // recurso — não pode ser o motivo de o servidor não conseguir encerrar.
  desligar.unref?.();
}

async function abrir() {
  if (navegador?.connected) return navegador;
  if (abrindo) return abrindo;

  const p = carregar();
  if (!p) throw new Error("puppeteer ausente");

  abrindo = p
    .launch({
      headless: true,
      // `--disable-dev-shm-usage`: em container o /dev/shm padrão tem 64 MB, e o
      // Chromium morre no meio de uma página grande sem dizer por quê. Manda ele
      // usar /tmp, que aqui tem 41 GB.
      //
      // Não há `--no-sandbox`: o serviço roda como `gofitnow`, não como root,
      // então o sandbox FUNCIONA — e ele é o que separa o decodificador de
      // imagem do resto da máquina. As fotos vêm de upload de usuário, que é
      // justamente o tipo de entrada para a qual o sandbox existe.
      args: ["--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    })
    .then((b) => {
      navegador = b;
      abrindo = null;
      // Se ele morrer sozinho (a máquina ficou sem memória, alguém matou o
      // processo), a referência tem de sumir — senão o próximo pedido tenta usar
      // um navegador fechado e falha para sempre.
      b.on("disconnected", () => {
        if (navegador === b) navegador = null;
      });
      return b;
    })
    .catch((erro) => {
      abrindo = null;
      throw erro;
    });

  return abrindo;
}

async function fechar() {
  const b = navegador;
  navegador = null;
  clearTimeout(desligar);
  if (b) await b.close().catch(() => {});
}

// ── UMA PÁGINA POR VEZ ────────────────────────────────────────────────────
//
// Cada aba aberta é memória, e numa máquina de 4 GB com Mongo dentro, cinco
// pedidos ao mesmo tempo derrubariam o servidor inteiro — não só o PDF. A fila
// troca "todos ao mesmo tempo" por "um depois do outro", que para um botão de
// baixar é diferença que ninguém percebe.
let fila = Promise.resolve();

function enfileirar(tarefa) {
  const resultado = fila.then(tarefa, tarefa);
  // A fila segue viva mesmo se uma tarefa falhar; sem este `catch` uma rejeição
  // envenenaria todos os pedidos seguintes.
  fila = resultado.then(
    () => {},
    () => {}
  );
  return resultado;
}

// ── O MESMO DOCUMENTO NÃO SE GERA DUAS VEZES ─────────────────────────────
//
// Baixar, mandar por e-mail, baixar de novo depois de conferir: é o mesmo
// conteúdo, e cada vez custava 532 ms de Chromium. Numa máquina de UM núcleo,
// esse meio segundo não atrasa só quem pediu o PDF — ele bloqueia todo mundo que
// estiver clicando qualquer coisa naquele instante.
//
// ── A CHAVE É O PRÓPRIO CONTEÚDO ─────────────────────────────────────────
//
// Um resumo do HTML, e não o id do documento com um carimbo de data. A diferença
// importa: o HTML já embute TUDO que muda a folha — os dados, o vocabulário da
// conta, a logo do cliente, o idioma de quem pediu, as fotos. Mudou qualquer uma
// dessas, o resumo muda, e a chave nova nasce vazia.
//
// Assim NÃO EXISTE invalidação para esquecer, que é onde cache costuma apodrecer:
// nunca há como servir um PDF velho, porque um PDF velho tem outra chave.
//
// O prazo de um dia é só sobre ESPAÇO. Repetição acontece em minutos.
const CACHE_MS = 24 * 60 * 60 * 1000;

function chaveDoConteudo(html, opcoes) {
  return (
    "pdf:" +
    require("node:crypto")
      .createHash("sha256")
      .update(String(html))
      .update(JSON.stringify(opcoes || {}))
      .digest("hex")
      .slice(0, 32)
  );
}

async function pdfDeHtml(html, opcoes = {}) {
  const chave = chaveDoConteudo(html, opcoes);

  // A leitura fica FORA da fila: ela não usa o navegador, e enfileirá-la faria
  // um acerto de cache esperar o PDF de outra pessoa terminar.
  const guardado = await redis.lerBytes(chave);
  if (guardado) return guardado;

  return enfileirar(async () => {
    // Conferido DE NOVO aqui dentro: dois pedidos do mesmo documento chegando
    // juntos passam ambos pela leitura acima (o cache ainda estava vazio) e
    // entram na fila. Sem esta segunda olhada, o segundo geraria o mesmo PDF que
    // o primeiro acabou de guardar — e dois cliques é o caso comum.
    const agora = await redis.lerBytes(chave);
    if (agora) return agora;

    const b = await abrir();
    const pagina = await b.newPage();

    try {
      // ── NADA SAI DAQUI PARA A REDE ──────────────────────────────────────
      //
      // O documento é autossuficiente por construção (tudo inline, fotos em
      // `data:`), então nenhum pedido externo deveria acontecer. Este bloqueio é
      // a garantia de que continua assim mesmo se alguém, um dia, colar um
      // `<img src="http...">` no gerador: sem ele, o servidor viraria um
      // buscador de URLs a mando do conteúdo da página, e a espera pela rede
      // apareceria como "o PDF demora".
      await pagina.setRequestInterception(true);
      pagina.on("request", (req) => {
        const url = req.url();
        if (url.startsWith("data:") || url === "about:blank") req.continue();
        else req.abort();
      });

      await pagina.setContent(html, { waitUntil: "load", timeout: TEMPO_LIMITE_MS });

      const pdf = await pagina.pdf({
        format: "A4",
        printBackground: true,
        // Sem isto, os fundos e as cores do documento saem branco no papel — e o
        // documento inteiro é feito de cartões coloridos.
        margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
        timeout: TEMPO_LIMITE_MS,
        ...opcoes,
      });

      const bytes = Buffer.from(pdf);

      // Guardado sem esperar: o PDF já está pronto para quem pediu, e uma ida ao
      // Redis não deve entrar no tempo de resposta dele.
      redis.guardarBytes(chave, bytes, CACHE_MS);

      return bytes;
    } finally {
      await pagina.close().catch(() => {});
      adiarDesligamento();
    }
  });
}

module.exports = { pdfDeHtml, pdfDisponivel, fecharNavegador: fechar };
