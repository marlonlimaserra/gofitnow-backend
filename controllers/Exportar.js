const { LISTAS, existe, nomeDoArquivo, planilha, documento } = require("../lib/listasExportaveis.js");
const { rotulos } = require("../lib/rotulosDeDocumento.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");

// LEVAR A LISTA EMBORA — planilha e papel, para qualquer cliente.
//
// *"acho melhor o xlsx e pdf sempre serem gerados pelo backend, assim
// garantimos que sempre vai ser igual em todos os apps"* (23/09/2026).
//
// Duas rotas para TODAS as listas, e não duas por lista: quem descreve cada uma
// é `lib/listasExportaveis.js`, e aqui só se escolhe o formato. Uma lista nova
// não precisa de rota nova.
//
// ── A PERMISSÃO É A DA LISTA ─────────────────────────────────────────────
//
// Cada uma declara a sua, e é a MESMA da tela: quem pode ver a lista pode
// levá-la. Sem isso, estas duas rotas seriam uma porta lateral para ler o que a
// tela recusa.
//
// ── O PAPEL SAI EM HTML ──────────────────────────────────────────────────
//
// E não em PDF. O documento — conteúdo, colunas, ordem, logo — nasce aqui, que
// é o que a decisão dele pede; o que cada cliente faz é RASTERIZAR: o navegador
// pelo Ctrl+P, o app pelo `expo-print`. Os dois imprimem a mesma folha.
//
// Gerar os bytes do PDF aqui exigiria o Chromium, e nesta máquina ele é um SNAP
// — e snap recusa ser lançado de dentro de um serviço do systemd ("is not a
// snap cgroup"). Roda no terminal, morre sob o pm2. Enquanto for assim, o PDF
// se faz na ponta a partir deste HTML.

// Só a primeira letra: um `toUpperCase` no todo viraria "ALUNOS".
const maiuscula = (p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : "");

module.exports = function (app) {
  // ── DOIS CATÁLOGOS, UM `t` ────────────────────────────────────────────
  //
  // Os RÓTULOS DE COLUNA vêm do catálogo do site, espelhado em
  // `lib/i18n/documentos` — é o que faz a planilha dizer "Vencimento" com as
  // mesmas palavras da tela de onde ela saiu.
  //
  // Os CATÁLOGOS DO SERVIDOR (o vínculo do funcionário, o estado do
  // equipamento, o tipo de manutenção, o estado do pagamento) não existem no
  // site: eles nascem aqui, em `lib/i18n/locales`, e é o servidor que os
  // traduz para a tela por `paraTela(t)`.
  //
  // Um `t` só que tenta o primeiro e cai no segundo. A alternativa seria a
  // descrição de cada lista escolher qual dos dois usar por chave — e a
  // primeira escolhida errada saía como `structure.state.ok` impresso na folha.
  function rotulador(lang, req) {
    const doSite = rotulos(lang);

    return function t(chave, vars) {
      const achado = doSite(chave, vars);
      if (achado !== String(chave)) return achado;
      return req.t(chave, vars);
    };
  }

  async function preparar(req, res) {
    const nome = String(req.params.lista || "");

    if (!existe(nome)) {
      res.status(404).send({ msg: req.t("errors.notFound") });
      return null;
    }

    const lista = LISTAS[nome];

    const user = await app.helpers.ReqProtected.can(req, res, lista.permissao);
    if (user === false) return null;

    const lang = user.lang || req.language;
    const t = rotulador(lang, req);

    // Tudo o que a descrição da lista pode pedir, buscado UMA vez. Cada leitura
    // num `catch` que não derruba: uma configuração que falha não pode custar a
    // planilha inteira — uma coluna vazia é melhor que arquivo nenhum.
    const [unidades, moedas, palavras, fuso, formasDePagamento] = await Promise.all([
      app.api.unit.list().catch(() => []),
      app.api.tenant.currencyOfInstance().catch(() => null),
      app.api.tenant.wordsOfInstance().catch(() => null),
      app.api.tenant.timezoneOfInstance().catch(() => null),
      // COM as desativadas: um pagamento antigo em boleto continua tendo de
      // dizer "Boleto" depois de o boleto sair de uso.
      app.api.paymentMethod.list().catch(() => []),
    ]);

    const nomeDaUnidade = (id) =>
      (unidades || []).find((u) => String(u._id) === String(id || ""))?.name || "";

    // O nome que a casa deu à forma, e a tradução quando ela não deu nenhum —
    // o mesmo caminho da tela.
    const formas = (chave) => {
      const achada = (formasDePagamento || []).find((m) => m.key === String(chave || ""));
      return achada?.name || t("finance.method." + (chave || "other"));
    };

    // O VOCABULÁRIO da casa — "Aluno", "Paciente", "Cliente". A coluna do nome
    // usa a palavra que o cliente escolheu, como no painel.
    const words = {
      Singular: maiuscula(palavras?.singular),
      Plural: maiuscula(palavras?.plural),
    };

    const contexto = {
      user,
      query: req.query || {},
      t,
      lang,
      fuso,
      moeda: moedas?.currency || "BRL",
      words,
      nomeDaUnidade,
      formas,
    };

    const linhas = await lista.linhas(app, contexto);
    // As COLUNAS depois das linhas, e recebendo-as: é o que permite a uma lista
    // esconder a coluna de unidade quando a casa só tem uma — uma coluna que
    // nunca preenche é pior que coluna nenhuma.
    const colunas = lista.colunas(t, { ...contexto, linhas });

    return {
      titulo: lista.titulo(t, words),
      colunas,
      linhas,
      lang,
      fuso,
      // A planilha também precisa escrever uma frase: o aviso de que o teto
      // cortou a lista.
      t,
      // O que a tela filtrou, escrito na folha. Quem chama manda pronto: só a
      // tela sabe dizer "marcados: 4 de 30" ou "unidade Niterói".
      recorte: String(req.query.recorte || "").slice(0, 200),
    };
  }

  app.get("/exportar/:lista.xlsx", async function (req, res) {
    const dados = await preparar(req, res);
    if (!dados) return;

    const bytes = await planilha(dados);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${nomeDoArquivo(dados.titulo, "xlsx")}"`
    );
    res.send(Buffer.from(bytes));
  });

  app.get("/exportar/:lista.html", async function (req, res) {
    const dados = await preparar(req, res);
    if (!dados) return;

    const casa = await app.api.tenant.dataOfInstance().catch(() => null);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      documento({
        ...dados,
        // A logo em `data:` e não por URL: quem renderiza (o `expo-print`, o
        // Chromium) não tem sessão, e um `<img>` apontando para rota
        // autenticada sairia em branco no papel.
        marca: await logoDaCasa(casa?.theme),
      })
    );
  });
};
