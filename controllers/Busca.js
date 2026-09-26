// A BUSCA GLOBAL — uma pergunta, todas as listas.
//
// *"crie lá em cima um 'search' que, quando eu clicar, abre algo assim para
// pesquisar: 'aluno' ou algum menu; veja o que vem hoje no sistema, faturas
// etc."* (26/09/2026).
//
// ── UMA ROTA, E NÃO SETE CHAMADAS DA TELA ────────────────────────────────
//
// A tela poderia bater em `/people?search=`, `/workouts?search=`… e juntar. Não
// pode, por duas razões práticas: cada tecla digitada viraria sete requisições
// (e sete cancelamentos), e a permissão de cada lista teria de ser decidida no
// navegador — que é o lugar onde ela não vale nada.
//
// Aqui é uma requisição por busca, e cada grupo só é consultado se a pessoa
// PODE vê-lo. O que ela não pode nem é procurado, quanto mais devolvido.
//
// ── O QUE ESTA ROTA NÃO FAZ ──────────────────────────────────────────────
//
// Ela não pagina e não ordena por relevância. Cada grupo devolve as CINCO
// primeiras e o total — quem quer a lista inteira clica no "ver todos", que
// leva para a tela da lista com o termo já aplicado. Uma busca global que tenta
// ser a tela de lista vira uma tela de lista pior.
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

const TETO_POR_GRUPO = 5;

module.exports = function (app) {
  app.get("/busca", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const termo = String(req.query.q || "").trim();

    // Uma letra acha tudo e não informa nada — e faz sete consultas por tecla
    // enquanto alguém ainda está começando a escrever.
    if (termo.length < 2) return res.send({ termo, grupos: [] });

    const pode = (p) => app.helpers.ReqProtected.has(user, p);

    // A CERCA DA UNIDADE (26/09/2026). A busca não tem seletor de unidade, mas
    // quem só alcança Niterói não pode achar Paraty por aqui — seria a porta
    // dos fundos da mesma casa que acabou de ganhar tranca.
    const cerca = lenteDeUnidade.recorte(user, "");
    const grupos = [];

    const juntar = (chave, total, itens) => {
      if (itens.length) grupos.push({ chave, total, itens });
    };

    // As buscas são independentes: uma lista que estoura (um índice faltando,
    // um filtro estranho) não pode levar a busca inteira junto. Cada uma cai
    // para "sem resultado" e as outras continuam.
    const tentar = async (fn) => {
      try {
        return await fn();
      } catch (erro) {
        console.error("[busca] um grupo falhou:", erro.message);
        return null;
      }
    };

    // ── PESSOAS ──────────────────────────────────────────────────────────
    if (pode("people.view")) {
      const r = await tentar(() =>
        app.api.user.pageStudents(user._id, { search: termo, limit: TETO_POR_GRUPO, ...cerca })
      );

      juntar(
        "pessoas",
        r?.total || 0,
        (r?.rows || []).map((p) => ({
          id: String(p._id),
          titulo: p.name,
          subtitulo: p.email || p.phone || "",
          rota: `/people/${p._id}`,
        }))
      );
    }

    // ── TREINOS ──────────────────────────────────────────────────────────
    if (pode("workouts.view")) {
      const r = await tentar(() =>
        app.api.workout.pageAll(user._id, { search: termo, limit: TETO_POR_GRUPO, status: "all", ...cerca })
      );

      juntar(
        "treinos",
        r?.total || 0,
        (r?.rows || []).map((w) => ({
          id: String(w._id),
          titulo: w.name,
          subtitulo: w.student?.name || "",
          // Direto no treino, e não na lista: quem procurou pelo nome dele quer
          // abri-lo.
          rota: w.student?._id ? `/people/${w.student._id}/workouts/${w._id}` : "/workouts",
        }))
      );
    }

    // ── DIETAS ───────────────────────────────────────────────────────────
    if (pode("diets.view")) {
      const r = await tentar(() =>
        app.api.diet.pageAll(user._id, { search: termo, limit: TETO_POR_GRUPO, ...cerca })
      );

      juntar(
        "dietas",
        r?.total || 0,
        (r?.rows || []).map((d) => ({
          id: String(d._id),
          titulo: d.name,
          subtitulo: d.student?.name || "",
          rota: d.student?._id ? `/people/${d.student._id}?tab=diet` : "/dietas",
        }))
      );
    }

    // ── COBRANÇAS (as "faturas") ─────────────────────────────────────────
    if (pode("finance.view")) {
      const r = await tentar(() =>
        app.api.finance.carteira({ busca: termo, limite: TETO_POR_GRUPO, pagina: 1, ...cerca })
      );

      juntar(
        "cobrancas",
        r?.total || 0,
        (r?.rows || []).map((c) => ({
          id: String(c._id),
          titulo: c.description || c.student?.name || "",
          subtitulo: c.student?.name || "",
          valor: c.amount,
          rota: "/financeiro",
        }))
      );
    }

    // ── FUNCIONÁRIOS ─────────────────────────────────────────────────────
    if (pode("employees.view")) {
      const r = await tentar(() =>
        app.api.employee.listar({ busca: termo, limite: TETO_POR_GRUPO, pagina: 1, ...cerca })
      );

      juntar(
        "funcionarios",
        r?.total || 0,
        (r?.rows || []).map((f) => ({
          id: String(f.id || f._id),
          titulo: f.name || f.nome,
          subtitulo: f.role || f.cargo || "",
          rota: `/funcionarios/${f.id || f._id}`,
        }))
      );
    }

    // ── CONTAS A PAGAR e FORNECEDORES ────────────────────────────────────
    //
    // Os dois atrás da mesma permissão do financeiro, como as telas.
    if (pode("finance.view")) {
      const contas = await tentar(() =>
        app.api.payable.listar({ busca: termo, limite: TETO_POR_GRUPO, pagina: 1, ...cerca })
      );

      juntar(
        "contas",
        contas?.total || 0,
        (contas?.rows || []).map((c) => ({
          id: String(c.id || c._id),
          titulo: c.description || c.descricao || "",
          subtitulo: c.supplierName || c.fornecedor || "",
          valor: c.amount ?? c.valor,
          rota: "/contas",
        }))
      );

      const fornecedores = await tentar(() =>
        app.api.supplier.pagina({ busca: termo, limite: TETO_POR_GRUPO, pagina: 1 })
      );

      juntar(
        "fornecedores",
        fornecedores?.total || 0,
        (fornecedores?.rows || []).map((f) => ({
          id: String(f.id || f._id),
          titulo: f.name || f.nome,
          subtitulo: f.category || f.categoria || "",
          rota: "/contas?aba=fornecedores",
        }))
      );
    }

    res.send({ termo, grupos });
  });
};
