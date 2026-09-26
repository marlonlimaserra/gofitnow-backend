const limiteDoPlano = require("../lib/limiteDoPlano.js");
const cat = require("../lib/catalogosDeEstrutura.js");
const arquivos = require("../lib/arquivos.js");
const instanceContext = require("../lib/instance.js");
const dominio = require("../lib/domain.js");

// A ESTRUTURA DA CASA — equipamentos e estoque.
//
// *"academia tem manutenção, tem gasto com produtos de limpeza; como a gente
// poderia controlar isso — o que saiu, o que entrou, equipamentos que precisam
// de manutenção etc."*
//
// ── PERMISSÃO PRÓPRIA, e não a do financeiro ────────────────────────────
//
// Foi a primeira ideia, porque comprar desinfetante é despesa e o financeiro já
// tem quem cuide. Mas o gesto de todo dia aqui é "saiu um galão de
// desinfetante", e quem o faz é a faxineira ou a recepção — que não têm, nem
// devem ter, acesso ao dinheiro da casa.
//
// Exigir `finance.manage` para dar baixa em material de limpeza faria a baixa
// não acontecer, e um estoque que ninguém baixa é um número errado com cara de
// número certo.
module.exports = function (app) {
  const contarEquipamentos = () => app.api.equipment.contagem();

  // A URL da foto é MONTADA na resposta, e o banco guarda só o id: gravar o
  // endereço prenderia o equipamento ao domínio do backend do dia em que a foto
  // subiu.
  const urlDaFoto = (instancia, id) =>
    id ? `${dominio.apiBaseUrl()}/public/equipment-image/${instancia}/${id}` : null;

  const comFoto = (req) => (e) => ({ ...e, photoUrl: urlDaFoto(req.instance, e.photo) });

  const catalogos = (req) => ({
    categoriasDeEquipamento: cat.paraTela(cat.EQUIPAMENTOS, req.t),
    estados: cat.paraTela(cat.ESTADOS, req.t),
    tiposDeManutencao: cat.paraTela(cat.MANUTENCOES, req.t),
    categoriasDeInsumo: cat.paraTela(cat.INSUMOS, req.t),
    medidas: cat.paraTela(cat.MEDIDAS, req.t),
    movimentos: cat.paraTela(cat.MOVIMENTOS, req.t),
  });

  // ── OS EQUIPAMENTOS ─────────────────────────────────────────────────────

  app.get("/equipments", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.view");
    if (user === false) return;

    const rows = await app.api.equipment.listar({
      busca: req.query.q,
      categoria: req.query.categoria,
      estado: req.query.estado,
      unit: req.query.unit,
      semUnidade: req.query.semUnidade === "1",
    });

    const moedas = await app.api.tenant.currencyOfInstance();
    const janela = periodo(req);

    res.send({
      rows: rows.map(comFoto(req)),
      // QUANTOS PEDEM ATENÇÃO é o número que a tela mostra em vermelho, e é a
      // razão de alguém abrir esta lista.
      precisandoDeAtencao: rows.filter((r) => r.precisaDeAtencao).length,
      // O RELATÓRIO DE GASTO vem junto da lista, e não numa tela à parte.
      //
      // *"para depois a gente poder gerar esses relatórios de gasto"* — e a
      // pergunta nasce olhando os aparelhos. Uma aba "relatórios" separada
      // obrigaria a sair daqui para responder algo sobre o que está aqui.
      //
      // O padrão são DOZE MESES porque manutenção é esparsa: no mês corrente,
      // que é a janela certa para o estoque, o número mais comum seria zero —
      // e um relatório que quase sempre mostra zero não é consultado.
      // Os relatórios seguem a MESMA lente da lista: sem isto, escolher
      // Paraty mostrava zero aparelhos com o gasto da casa inteira embaixo.
      gasto: await app.api.equipment.custoNoPeriodo({ ...janela, unit: req.query.unit }),
      // O relatório responde QUANTO; esta lista responde O QUÊ. Um total de
      // R$ 1.840 não diz que a esteira quebrou três vezes em maio.
      // `manutencoesDoPeriodo`, e não `manutencoes`: a ficha de UM equipamento
      // já usa esse nome para as manutenções DELE. Dois significados para a
      // mesma palavra na mesma API é o começo de um bug de leitura.
      manutencoesDoPeriodo: await app.api.equipment.manutencoesNoPeriodo({
        ...janela,
        unit: req.query.unit,
      }),
      periodo: { de: janela.de, ate: janela.ate },
      // O que já foi digitado antes, para o formulário completar sozinho. Vem
      // junto da lista porque é a mesma tela que abre o formulário — um pedido
      // à parte seria uma ida ao servidor no clique de "Novo equipamento".
      sugestoes: await app.api.equipment.sugestoes(),
      currency: moedas.currency,
      ...catalogos(req),
    });
  });

  app.get("/equipments/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.view");
    if (user === false) return;

    const eq = await app.api.equipment.data(req.params.id);
    if (!eq) return res.status(404).send({ msg: req.t("errors.equipmentNotFound") });

    res.send({
      ...comFoto(req)(eq),
      manutencoes: await app.api.equipment.listarManutencoes(req.params.id),
    });
  });

  app.post("/equipments", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    if (await limiteDoPlano.barrou(app, req, res, "equipments", contarEquipamentos)) return;

    const id = await app.api.equipment.insert(req.body || {});
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    app.insertUserActionHistory(req, user, "create_equipment", {
      category: "structure",
      local: { target_type: "equipments", target_id: String(id) },
    });

    res.status(201).send(comFoto(req)(await app.api.equipment.data(id)));
  });

  app.put("/equipments/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const ok = await app.api.equipment.update(req.params.id, req.body || {});
    if (!ok) return res.status(404).send({ msg: req.t("errors.equipmentNotFound") });

    res.send(comFoto(req)(await app.api.equipment.data(req.params.id)));
  });

  app.delete("/equipments/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const ok = await app.api.equipment.remove(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.equipmentNotFound") });

    res.send({ msg: req.t("ok.equipmentRemoved") });
  });

  // ── A FOTO ──────────────────────────────────────────────────────────────
  //
  // *"permita colocar foto do equipamento"*. Duas esteiras do mesmo modelo só
  // se distinguem pelo número de série, que está numa etiqueta atrás; a foto é
  // o que faz quem abre a lista saber de qual aparelho a ficha fala.
  //
  // Ela sobe em `data:` no corpo, como a da unidade e a do fornecedor: a tela
  // já reduz a imagem antes de enviar, e um `multipart` só para isto traria uma
  // dependência e um caminho de erro a mais.
  app.post("/equipments/:id/photo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const alvo = await app.api.equipment.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.equipmentNotFound") });

    const parsed = app.api.equipmentImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.equipmentImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaFoto(req.instance, salva.id) });
  });

  // A INSTÂNCIA está no caminho porque esta rota é ABERTA: ela chega sem sessão,
  // e as imagens moram no banco de um cliente.
  //
  // Não é vazamento: o endereço é o id opaco da foto, e ele só aparece embutido
  // na tela de quem já está dentro. O balde continua privado — quem serve os
  // bytes somos nós.
  app.get("/public/equipment-image/:instance/:id", async function (req, res) {
    const instance = instanceContext.normalize(req.params.instance);
    if (!instance) return res.status(404).end();

    const img = await instanceContext.run(instance, () =>
      app.api.equipmentImage.data(req.params.id)
    );
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';

    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.send(bytes);
  });

  app.post("/equipments/:id/manutencoes", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const eq = await app.api.equipment.data(req.params.id);
    if (!eq) return res.status(404).send({ msg: req.t("errors.equipmentNotFound") });

    const id = await app.api.equipment.lancarManutencao(req.params.id, req.body || {}, user);

    app.insertUserActionHistory(req, user, "create_maintenance", {
      category: "structure",
      local: { target_type: "equipment_maintenances", target_id: String(id) },
      extra: { equipamento: eq.name },
    });

    res.status(201).send({
      ...comFoto(req)(await app.api.equipment.data(req.params.id)),
      manutencoes: await app.api.equipment.listarManutencoes(req.params.id),
    });
  });

  app.delete("/equipments/:id/manutencoes/:manutencaoId", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const ok = await app.api.equipment.removerManutencao(req.params.id, req.params.manutencaoId);
    if (!ok) return res.status(404).send({ msg: req.t("errors.maintenanceNotFound") });

    res.send({ manutencoes: await app.api.equipment.listarManutencoes(req.params.id) });
  });

  // ── O ESTOQUE ───────────────────────────────────────────────────────────

  app.get("/supplies", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.view");
    if (user === false) return;

    const rows = await app.api.supply.listar({
      busca: req.query.q,
      categoria: req.query.categoria,
      soFaltando: req.query.faltando === "1",
      // *"a parte de estoque não respeita a unidade"*. O insumo é da casa e
      // não tem unidade — mas o MOVIMENTO tem, e a quantidade é gravada com
      // sinal. Com a lente, o saldo é recalculado somando os movimentos
      // daquela unidade; sem ela, continua o saldo da casa.
      unit: req.query.unit,
    });

    const moedas = await app.api.tenant.currencyOfInstance();
    const janela = periodo(req, inicioDoMes());

    res.send({
      rows,
      faltando: rows.filter((r) => r.faltando).length,
      // QUANTO ENTROU de dinheiro na janela, por categoria. É a resposta de
      // *"tem gasto com produtos de limpeza"* — e ela vem junto porque é a
      // mesma tela que a pergunta.
      // O INSUMO é do estoque da casa e não tem unidade; o MOVIMENTO tem —
      // é ele que diz qual unidade consumiu. Por isso o catálogo continua
      // inteiro e só o gasto e o histórico seguem a lente.
      gasto: await app.api.supply.gastoNoPeriodo({ ...janela, unit: req.query.unit }),
      // E o que saiu: o extrato de um insumo responde "como este desinfetante
      // chegou a três"; este responde "o que a casa consumiu em maio".
      // `movimentosDoPeriodo`: `movimentos` nesta mesma resposta é o CATÁLOGO
      // dos tipos (entrada, saída, ajuste), que vem de `catalogos(req)` logo
      // abaixo — e o spread dele apagaria esta lista, calado.
      movimentosDoPeriodo: await app.api.supply.movimentosNoPeriodo({
        ...janela,
        unit: req.query.unit,
      }),
      periodo: { de: janela.de, ate: janela.ate },
      currency: moedas.currency,
      ...catalogos(req),
    });
  });

  app.post("/supplies", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const id = await app.api.supply.insert(req.body || {});
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    res.status(201).send(await app.api.supply.data(id));
  });

  app.put("/supplies/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const ok = await app.api.supply.update(req.params.id, req.body || {});
    if (!ok) return res.status(404).send({ msg: req.t("errors.supplyNotFound") });

    res.send(await app.api.supply.data(req.params.id));
  });

  app.delete("/supplies/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.manage");
    if (user === false) return;

    const ok = await app.api.supply.remove(req.params.id);
    if (!ok) return res.status(404).send({ msg: req.t("errors.supplyNotFound") });

    res.send({ msg: req.t("ok.supplyRemoved") });
  });

  // ── MOVIMENTAR ──────────────────────────────────────────────────────────
  //
  // `structure.view` para LANÇAR, e não `structure.manage`. Parece errado e não
  // é: dar baixa é o gesto de todo dia, feito por quem está limpando; cadastrar
  // um insumo novo é decisão de quem organiza. Exigir a chave de gerente para a
  // baixa faria a baixa não acontecer.
  app.post("/supplies/:id/movimentos", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.view");
    if (user === false) return;

    const r = await app.api.supply.movimentar(req.params.id, req.body || {}, user);
    if (!r) return res.status(400).send({ msg: req.t("errors.invalidMove") });

    app.insertUserActionHistory(req, user, "create_supply_move", {
      category: "structure",
      local: { target_type: "supply_moves", target_id: String(req.params.id) },
      extra: { tipo: r.tipo, quantidade: r.quantidade },
    });

    res.status(201).send({
      insumo: await app.api.supply.data(req.params.id),
      extrato: await app.api.supply.extrato(req.params.id),
      porUnidade: await app.api.supply.saldosPorUnidade(req.params.id),
    });
  });

  app.get("/supplies/:id/movimentos", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "structure.view");
    if (user === false) return;

    const insumo = await app.api.supply.data(req.params.id);
    if (!insumo) return res.status(404).send({ msg: req.t("errors.supplyNotFound") });

    res.send({
      insumo,
      extrato: await app.api.supply.extrato(req.params.id),
      // ONDE ESTÁ: quanto deste insumo há em cada unidade. É a resposta para
      // "de qual unidade ele faz parte" — que não é um campo do insumo, e
      // sim a soma dos movimentos de cada lugar.
      porUnidade: await app.api.supply.saldosPorUnidade(req.params.id),
    });
  });

  // ── A JANELA ────────────────────────────────────────────────────────────
  //
  // *"senti falta de filtro de data, para saber tudo que ocorreu em certo
  // período"*.
  //
  // `ate` é o FIM do dia: uma data crua é meia-noite, e uma manutenção lançada
  // hoje de manhã ficaria de fora do próprio período — o defeito que faz alguém
  // desconfiar do relatório inteiro.
  //
  // `tudo=1` devolve a janela VAZIA, e é diferente de não mandar nada: sem
  // parâmetro vale o padrão da tela; com ele, a história inteira. Um "desde
  // sempre" escrito como uma data de 1970 mentiria no rótulo.
  function periodo(req, padraoDe) {
    if (req.query.tudo === "1") return {};

    const ate = dataDaQuery(req.query.ate) || new Date();
    ate.setHours(23, 59, 59, 999);

    let de = dataDaQuery(req.query.de);
    if (!de) {
      de = padraoDe ? new Date(padraoDe) : new Date(ate);
      // Sem padrão de quem chama, os últimos doze meses: manutenção é esparsa,
      // e um relatório que quase sempre mostra zero não é consultado.
      if (!padraoDe) {
        de.setMonth(de.getMonth() - 11);
        de.setDate(1);
      }
    }
    de.setHours(0, 0, 0, 0);

    return { de, ate };
  }

  // ── "2026-05-31" É UM DIA DO CALENDÁRIO, NÃO UM INSTANTE ────────────────
  //
  // `new Date("2026-05-31")` é meia-noite em UTC. Em São Paulo isso é o dia 30
  // às 21h — e a janela que termina em 31/05 perdia o dia 31 inteiro, calada.
  // Do outro lado, a que começa em 01/05 abria no dia 30 de abril.
  //
  // É a mesma armadilha que o ponto do funcionário já tinha encontrado, e a
  // saída é a mesma: montar a data pelas PARTES, no fuso de quem olha.
  function dataDaQuery(v) {
    if (!v) return null;

    const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    if (partes) {
      const d = new Date(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function inicioDoMes() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
};
