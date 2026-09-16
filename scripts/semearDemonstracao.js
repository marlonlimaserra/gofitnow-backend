// SEMEIA A INSTÂNCIA DE DEMONSTRAÇÃO, para as fotos do site.
//
// Reexecutável: apaga e recria o conteúdo da instância `demo` a cada rodada, e
// sorteia uma senha nova. É o que permite refotografar as telas a cada mudança
// de marca sem recadastrar nada à mão.
//
// ── OS TRÊS DEFEITOS QUE ELE JÁ TEVE (16/09/2026) ─────────────────────────
//
// Nenhum dos três deu erro. Todos produziram um resultado plausível e errado —
// e é por isso que este script existe em vez de eu fazer à mão:
//
//   1. senha com pbkdf2, quando o projeto usa `sha512(salt + ":" + senha)`.
//      A conta nasceria sem conseguir entrar.
//   2. `admin: true` sem o PAPEL. "Authorization is by PERMISSION, never by
//      'is this an admin'" (ReqProtected): a conta entrava e não via menu nenhum.
//   3. os catálogos lidos no banco escopado, quando moram no `centralDb()` —
//      e com o filtro `instance` sobrescrito pelo `lib/escopo.js`. Saiu
//      "treinos: 5 com 0 exercícios cada", sem uma linha de erro.
//
//   node scripts/semearDemonstracao.js
//
// ── Por que uma instância própria, e não a conta do Marlon ────────────────
//
// As seis imagens da seção "Telas" são de 15/08: marca antiga, sem os menus de
// Aulões e Financeiro. Refotografá-las exige entrar no app — e entrar na conta
// dele tem dois problemas, sendo o segundo o que decide: eu precisaria da senha,
// e as telas mostrariam nomes de 217 pessoas reais numa página pública de
// vendas.
//
// Uma instância de demonstração resolve os dois, e de vez: refotografa-se a cada
// mudança de marca, e o que aparece é dado inventado.
//
// ── PELOS MODELOS, e não pelo driver ──────────────────────────────────────
//
// A primeira versão deste script escrevia o usuário à mão e calculava a senha
// com pbkdf2. O projeto usa `sha512(salt + ":" + senha)` — a conta teria nascido
// com uma senha que nunca casa, e eu só descobriria na tela de login.
//
// É a mesma lição dos dobros de teste de hoje: quem reescreve a regra prova a
// própria reescrita. `insertTrainer` e `insertStudent` garantem o mesmo
// algoritmo, o mesmo documento e o mesmo vínculo que um cadastro de verdade.
//
// ── A ARMADILHA DO `admin: true` ──────────────────────────────────────────
//
// Ele NÃO dá permissão nenhuma. O `ReqProtected` é explícito: "Authorization is
// by PERMISSION, never by 'is this an admin'" — quem manda é o PAPEL, pelo
// `_id`. Sem ele a conta entra e não vê menu nenhum, e eu tiraria seis fotos de
// telas vazias sem entender por quê.
//
// Por isso o papel Administrador é buscado por nome DEPOIS do provisionamento, e
// o script para se não o achar.
//
// ── O CATÁLOGO VEM DE GRAÇA ───────────────────────────────────────────────
//
// Exercícios e alimentos compartilhados moram com `instance: null`
// (`daInstancia()` = `{ $in: [null, <a minha>] }`), então a instância nova já
// nasce com os 1.400 exercícios e os alimentos com foto. O treino e a dieta da
// demonstração são montados com itens REAIS do catálogo, escolhidos por nome —
// o que faz as miniaturas aparecerem nas fotos.
require("dotenv").config();

const defaultModules = require("../defaultModules.js");
const appModels = require("../appModels.js");
const ensureSchema = require("../database/schema.js");
const instanceContext = require("../lib/instance.js");
const crypto = require("crypto");

const INSTANCIA = "demo";
const PROF = { name: "Marina Alencar", email: "demo@vafit.app" };

const app = {};
app.mongodb = require("../config/mongodb.js");
for (const k in defaultModules) app[k] = defaultModules[k];
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

const ALUNOS = [
  ["Camila Ferraz",    "camila.ferraz@exemplo.com",    "11987650001", "female", "1994-03-12", "Hipertrofia"],
  ["Rodrigo Vasques",  "rodrigo.vasques@exemplo.com",  "11987650002", "male",   "1988-07-25", "Emagrecimento"],
  ["Helena Brandão",   "helena.brandao@exemplo.com",   "11987650003", "female", "1991-11-03", "Condicionamento"],
  ["Tiago Mendonça",   "tiago.mendonca@exemplo.com",   "11987650004", "male",   "1996-01-18", "Força"],
  ["Larissa Coutinho", "larissa.coutinho@exemplo.com", "11987650005", "female", "1999-05-30", "Hipertrofia"],
  ["Otávio Bezerra",   "otavio.bezerra@exemplo.com",   "11987650006", "male",   "1985-09-08", "Saúde geral"],
  ["Beatriz Nogueira", "beatriz.nogueira@exemplo.com", "11987650007", "female", "1993-12-21", "Emagrecimento"],
  ["Gustavo Peixoto",  "gustavo.peixoto@exemplo.com",  "11987650008", "male",   "1990-04-14", "Hipertrofia"],
];

// Datas relativas a AGORA, e não escritas à mão: um script com "2026-09-18"
// dentro tira fotos com a agenda vazia em outubro.
const agora = new Date();

// ── O FUSO DA DEMONSTRAÇÃO, e o defeito que ele corrige ───────────────────
//
// A primeira versão fazia `x.setHours(8, 0)` e pronto. `setHours` usa o relógio
// do PROCESSO, e o servidor roda em `Etc/UTC` — então "08:00" virou 08:00 UTC,
// que é 05:00 em São Paulo.
//
// O resultado estava gravado e plausível: um aulão de praia às 5 da manhã, e a
// agenda inteira deslocada três horas. Nas fotos do site apareceria um estúdio
// que atende das 05:00 às 11:00.
//
// É o defeito que o Marlon lembrava ("teve algum dia que deu problema de
// horário"), e é a razão de o servidor estar em UTC ser CERTO: em -3 este erro
// teria se escondido, e reapareceria no primeiro cliente de fora do Brasil.
//
// `tempo.instante` monta o instante a partir da hora de PAREDE num fuso — o
// mesmo caminho que a agenda e o formulário do aulão usam.
const tempo = require("../lib/tempo.js");
const FUSO = tempo.PADRAO;

function emDias(d, hora = 9, min = 0) {
  const x = new Date(agora);
  x.setDate(x.getDate() + d);

  // A data de parede é lida no fuso da conta, não no do processo: perto da
  // meia-noite UTC o dia em São Paulo ainda é o anterior, e somar dias no
  // relógio errado erraria o dia além da hora.
  const p = tempo.paredeDe(x, FUSO);
  return tempo.instante({ ano: p.ano, mes: p.mes, dia: p.dia, hora, minuto: min }, FUSO);
}
// "AAAA-MM-DD" no fuso da conta. `toISOString()` daria o dia de UTC, e um
// vencimento gerado às 22h em São Paulo cairia no dia seguinte.
function diaISO(d) {
  const x = new Date(agora);
  x.setDate(x.getDate() + d);
  return tempo.paredeDe(x, FUSO).data;
}

(async () => {
  const central = await app.mongodb.centralDb();

  // ── 1. O REGISTRO ───────────────────────────────────────────────────────
  //
  // Sem ele o host não resolve para instância nenhuma e o login nem abre: é o
  // registro central que responde "de quem é este endereço".
  // ── O PLANO, resolvido pelo NOME e não chutado ──────────────────────────
  //
  // O registro guarda a CHAVE do plano (`plan: "recemformado"`), e os números
  // moram em `plans` no mesmo banco (ver `Center_model.limitsFor`, que casa por
  // `{ key: doc.plan }`). As chaves não saem do nome por regra — "Recém formado"
  // virou `recemformado`, sem hífen — e escrever `"seu-app"` aqui daria uma
  // instância apontando para plano inexistente: `limitsFor` devolveria `{}`, o
  // que por sorte é ilimitado, mas o selo do topo mostraria plano desconhecido
  // justamente na foto.
  //
  // Então procura-se pelo nome, com desempate em `nativeApps: true` — a marca do
  // plano mais alto, o único que não barra tela nenhuma.
  const planos = await central.collection("plans").find({}).toArray();
  const oPlano =
    planos.find((p) => String(p.name || "").toLowerCase() === "seu app") ||
    planos.find((p) => p.limits && p.limits.nativeApps === true) ||
    null;

  if (!oPlano) throw new Error("nenhum plano com nativeApps — confira a central");
  console.log("plano da demonstração:", oPlano.name, "(" + oPlano.key + ")");

  const inst = central.collection("instances");
  const jaTem = await inst.findOne({ instance: INSTANCIA });

  if (!jaTem) {
    await inst.insertOne({
      instance: INSTANCIA,
      name: "Estúdio Demonstração",
      email: PROF.email,
      hosts: [`${INSTANCIA}.vafit.app`],
      active: true,
      // Plano cheio de propósito: as fotos mostram o PRODUTO, e o teto do plano
      // de entrada barraria metade das telas — a foto sairia com o aviso de
      // limite estourado em cima.
      //
      // `aulaoes` não está nos limites de nenhum plano ainda, e isso está certo:
      // chave AUSENTE é ilimitada por decisão (ver `lib/limiteDoPlano.js` — "um
      // plano criado antes desta chave existir não a tem"; tratá-la como zero
      // desligaria um módulo no deploy, sem aviso, de todo cliente).
      plan: oPlano.key,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log("registro central: criado");
  } else {
    // Rodar de novo depois de uma troca de plano não pode deixar a foto com teto.
    await inst.updateOne(
      { instance: INSTANCIA },
      { $set: { plan: oPlano.key, active: true, hosts: [`${INSTANCIA}.vafit.app`], updatedAt: new Date() } }
    );
    console.log("registro central: já existia (plano e host reconfirmados)");
  }

  // ── 2. O PROVISIONAMENTO ────────────────────────────────────────────────
  //
  // Índices e papéis do sistema. É aqui que o Administrador nasce — e como a
  // instância é nova, ele nasce com a lista de permissões ATUAL, incluindo as
  // de aulão e financeiro que as instâncias antigas não receberam.
  await ensureSchema.ensureInstanceEssencial(app, INSTANCIA);
  console.log("papéis do sistema: prontos");

  // Senha sorteada e impressa UMA vez. Não vai para código nem fica em lugar
  // nenhum: quem tira as fotos usa e esquece.
  const senha = crypto.randomBytes(9).toString("base64url");

  await instanceContext.run(INSTANCIA, async () => {
    const db = await app.mongodb.connectToServer();

    // Refazer do zero a cada rodada. A instância é descartável, e um script que
    // acumula deixaria dezesseis alunos na segunda execução.
    for (const c of [
      "users", "professional_links", "workouts", "diets", "appointments",
      "charges", "payments", "aulaoes", "aulao_inscricoes", "services",
      "booking_pages", "availability",
    ]) {
      await db.collection(c).deleteMany({});
    }

    // ── O PAPEL, antes da conta ───────────────────────────────────────────
    const papel = await db.collection("roles").findOne({ name: app.api.role.adminName });
    if (!papel) throw new Error("papel " + app.api.role.adminName + " não existe — provisionamento falhou");

    const profId = await app.api.user.insertTrainer({
      name: PROF.name,
      email: PROF.email,
      password: senha,
      role: papel._id,
      admin: true,
    });
    // `insertTrainer` DEVOLVE `{erro}` em vez de lançar quando o nome de usuário
    // não presta. Sem este teste, o erro viraria um `_id` undefined e todos os
    // vínculos abaixo nasceriam apontando para o nada.
    if (!profId || profId.erro) throw new Error("profissional: " + JSON.stringify(profId));
    console.log("profissional:", PROF.name, String(profId));

    const alunos = [];
    for (const [name, email, phone, sex, birthDate, goal] of ALUNOS) {
      const id = await app.api.user.insertStudent(profId, {
        name, email, phone, sex, birthDate, goal,
        weight: 60 + Math.round(Math.random() * 30),
        height: 160 + Math.round(Math.random() * 25),
      });
      alunos.push({ id, name });
    }
    console.log("alunos:", alunos.length);

    // ── 3. O TREINO, com exercícios REAIS do catálogo ─────────────────────
    //
    // Escolhidos por nome para as miniaturas aparecerem na foto. O que não for
    // achado é simplesmente omitido: um treino com cinco linhas fotografa bem,
    // e um `null` no meio quebraria a tela.
    // ── O CATÁLOGO MORA NO CENTRAL, e eu li no lugar errado ─────────────
    //
    // Primeira versão: `db.collection("exercises")` com `db` vindo de
    // `connectToServer()`. Duas coisas erradas de uma vez.
    //
    // A primeira é o BANCO: `Exercise_model.collection()` usa `centralDb()` —
    // "este catálogo é de fora das instâncias", diz o comentário dele. No banco
    // escopado a coleção `exercises` simplesmente não existe.
    //
    // A segunda é o ESCOPO, e ela teria mordido mesmo no banco certo:
    // `lib/escopo.js` injeta `instance` em todo filtro que passa por
    // `connectToServer()`, e faz isso com `{...filtro, instance: <a minha>}` —
    // o meu `instance: { $in: [null] }` era SOBRESCRITO por `instance: "demo"`.
    // Eu pedia o catálogo compartilhado e recebia o da conta vazia.
    //
    // Resultado: "treinos: 5 com 0 exercícios cada", sem erro nenhum.
    //
    // `instance: null` no Mongo casa com nulo E com ausente, que é como as duas
    // coleções marcam o que é compartilhado.
    const central = await app.mongodb.centralDb();

    const catalogo = await central
      .collection("exercises")
      .find({ instance: null, active: { $ne: 0 } })
      .project({ name: 1, muscleGroup: 1, thumbUrl: 1, videoUrl: 1, nameSort: 1 })
      .toArray();

    function acharExercicio(termo) {
      const t = termo.toLowerCase();
      return (
        catalogo.find((e) => String(e.name || "").toLowerCase() === t) ||
        catalogo.find((e) => String(e.name || "").toLowerCase().includes(t)) ||
        null
      );
    }

    const PLANO = [
      ["supino reto", [["12", "40"], ["10", "45"], ["8", "50"]]],
      ["crucifixo",   [["12", "14"], ["12", "14"], ["10", "16"]]],
      ["desenvolvimento", [["12", "20"], ["10", "22"], ["10", "22"]]],
      ["tríceps",     [["15", "25"], ["12", "30"], ["12", "30"]]],
      ["abdominal",   [["20", ""], ["20", ""], ["20", ""]]],
    ];

    let treinos = 0;
    for (const aluno of alunos.slice(0, 5)) {
      const wid = await app.api.workout.insert(profId, aluno.id, {
        name: "Treino A — Superiores",
        goal: "Hipertrofia",
        teacherName: PROF.name,
        startDate: diaISO(-20),
        endDate: diaISO(40),
        totalSessions: 24,
        weekdays: ["mon", "wed", "fri"],
        tip: "Mantenha a escápula estabilizada nos empurrões.",
      });

      const exercicios = [];
      for (const [termo, series] of PLANO) {
        const e = acharExercicio(termo);
        if (!e) continue;
        exercicios.push({
          exerciseId: e._id,
          name: e.name,
          muscleGroup: e.muscleGroup || "",
          thumbUrl: e.thumbUrl || null,
          videoUrl: e.videoUrl || null,
          sets: series.map(([quantity, load]) => ({
            unit: "reps", quantity, load, rest: "60", restMax: "90",
          })),
        });
      }
      await app.api.workout.saveExercises(profId, wid, exercicios);
      treinos++;
    }
    console.log("treinos:", treinos, "com", PLANO.filter((p) => acharExercicio(p[0])).length, "exercícios cada");

    // ── 4. A DIETA, com alimentos do catálogo (e as fotos novas) ──────────
    // Mesmo banco e mesma armadilha do catálogo de exercícios — ver acima.
    const foods = await central
      .collection("foods")
      .find({ instance: null })
      .project({ name: 1, imageKey: 1, kcal: 1, protein: 1, carbs: 1, fat: 1, unit: 1 })
      .toArray();

    function acharAlimento(termo) {
      const t = termo.toLowerCase();
      return (
        foods.find((f) => String(f.name || "").toLowerCase() === t) ||
        foods.find((f) => String(f.name || "").toLowerCase().includes(t)) ||
        null
      );
    }

    const REFEICOES = [
      ["07:00", "Café da manhã", [["ovo", 2, "un"], ["pão", 50, "g"], ["mamão", 120, "g"]]],
      ["10:00", "Lanche da manhã", [["banana", 100, "g"], ["aveia", 30, "g"]]],
      ["12:30", "Almoço", [["arroz", 120, "g"], ["feijão", 80, "g"], ["frango", 150, "g"], ["brócolis", 80, "g"]]],
      ["16:00", "Lanche da tarde", [["iogurte", 170, "g"], ["castanha", 20, "g"]]],
      ["19:30", "Jantar", [["batata doce", 150, "g"], ["tilápia", 140, "g"], ["salada", 100, "g"]]],
    ];

    let dietas = 0;
    for (const aluno of alunos.slice(0, 4)) {
      const did = await app.api.diet.insert(profId, aluno.id, {
        name: "Plano alimentar — dia de treino",
        goal: aluno.name === "Rodrigo Vasques" ? "Emagrecimento" : "Hipertrofia",
        startDate: diaISO(-15),
        endDate: diaISO(45),
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        targetKcal: 2400, targetProtein: 165, targetCarbs: 280, targetFat: 70,
        note: "Beba 35 ml de água por quilo de peso ao longo do dia.",
      });

      const meals = [];
      for (const [time, name, itens] of REFEICOES) {
        const comidas = [];
        for (const [termo, quantity, unit] of itens) {
          const f = acharAlimento(termo);
          if (!f) continue;
          const fator = unit === "un" ? quantity : quantity / 100;
          comidas.push({
            foodId: f._id,
            name: f.name,
            quantity, unit,
            // A CHAVE DA FOTO, copiada do catálogo — é assim que a tela mostra a
            // imagem sem uma consulta por linha (ver `limparAlimento`).
            imageKey: f.imageKey || "",
            kcal: f.kcal ? Math.round(f.kcal * fator) : null,
            protein: f.protein ? Math.round(f.protein * fator * 10) / 10 : null,
            carbs: f.carbs ? Math.round(f.carbs * fator * 10) / 10 : null,
            fat: f.fat ? Math.round(f.fat * fator * 10) / 10 : null,
          });
        }
        if (comidas.length) meals.push({ time, name, foods: comidas });
      }
      await app.api.diet.saveMeals(profId, did, meals);
      dietas++;
    }
    const comFoto = foods.filter((f) => f.imageKey).length;
    console.log("dietas:", dietas, "|", comFoto, "alimentos do catálogo têm foto");

    // ── 5. OS SERVIÇOS, a agenda e a página pública ──────────────────────
    const svAval = await app.api.service.insert({
      name: "Avaliação física", minutes: 60, price: "150,00",
      description: "Bioimpedância, perimetria e testes de força.",
      capacity: 1, active: true,
    });
    const svTreino = await app.api.service.insert({
      name: "Treino assistido", minutes: 45, price: "90,00",
      description: "Acompanhamento individual na sala de musculação.",
      capacity: 1, active: true,
    });
    const svGrupo = await app.api.service.insert({
      name: "Funcional em dupla", minutes: 50, price: "70,00",
      description: "Circuito funcional para duas pessoas.",
      capacity: 2, active: true,
    });

    const AGENDA = [
      [0, 8, 0, svTreino, "Treino assistido", "scheduled"],
      [0, 9, 0, svTreino, "Treino assistido", "scheduled"],
      [0, 10, 0, svAval, "Avaliação física", "scheduled"],
      [0, 14, 0, svGrupo, "Funcional em dupla", "scheduled"],
      [1, 8, 0, svTreino, "Treino assistido", "scheduled"],
      [1, 9, 0, svTreino, "Treino assistido", "scheduled"],
      [1, 11, 0, svAval, "Avaliação física", "scheduled"],
      [2, 8, 0, svTreino, "Treino assistido", "scheduled"],
      [2, 15, 0, svGrupo, "Funcional em dupla", "scheduled"],
      [3, 9, 0, svTreino, "Treino assistido", "scheduled"],
      [4, 8, 0, svAval, "Avaliação física", "scheduled"],
      [-1, 9, 0, svTreino, "Treino assistido", "done"],
      [-1, 10, 0, svTreino, "Treino assistido", "done"],
      [-2, 8, 0, svAval, "Avaliação física", "done"],
    ];

    let i = 0;
    for (const [dia, h, m, servico, titulo, status] of AGENDA) {
      const aluno = alunos[i++ % alunos.length];
      await app.api.appointment.insert(
        profId, aluno.id,
        { date: emDias(dia, h, m), minutes: servico === svAval ? 60 : 45, title: titulo, service: servico, status },
        profId
      );
    }
    console.log("agenda:", AGENDA.length, "compromissos");

    await app.api.availability.save(profId, {
      active: true,
      weekdays: {
        mon: [{ from: "07:00", to: "12:00" }, { from: "14:00", to: "19:00" }],
        tue: [{ from: "07:00", to: "12:00" }, { from: "14:00", to: "19:00" }],
        wed: [{ from: "07:00", to: "12:00" }, { from: "14:00", to: "19:00" }],
        thu: [{ from: "07:00", to: "12:00" }, { from: "14:00", to: "19:00" }],
        fri: [{ from: "07:00", to: "12:00" }, { from: "14:00", to: "17:00" }],
        sat: [{ from: "08:00", to: "11:00" }],
        sun: [],
      },
      slotStep: 30, minNoticeHours: 12, horizonDays: 45,
    });

    await app.api.bookingPage.insert(
      {
        slug: "estudio",
        name: "Estúdio Demonstração",
        intro: "Escolha o melhor horário para a sua avaliação. Retorno em até 2 horas.",
        active: 1,
        showProfessional: true,
        services: [svAval, svTreino, svGrupo],
        professionals: [profId],
        // 45 de atendimento + 15 de respiro — o campo que entrou hoje, e é o que
        // faz a página pública mostrar 08:00 e depois 09:00.
        gapMinutes: 15,
      },
      profId
    );
    console.log("agenda pública: /agendar/estudio");

    // ── 6. O FINANCEIRO: pago, aberto e atrasado ─────────────────────────
    //
    // Os três estados de propósito: um financeiro só com tudo pago não mostra o
    // que a tela faz de útil, que é apontar quem está devendo.
    const COBRANCAS = [
      [0, "Mensalidade de setembro", "320,00", -10, "paid"],
      [1, "Mensalidade de setembro", "320,00", -10, "paid"],
      [2, "Mensalidade de setembro", "320,00", -10, "paid"],
      [3, "Mensalidade de setembro", "320,00", -22, "open"],
      [4, "Avaliação física", "150,00", -18, "open"],
      [5, "Mensalidade de setembro", "320,00", 5, "open"],
      [6, "Pacote 8 treinos", "640,00", 12, "open"],
      [7, "Mensalidade de setembro", "320,00", -3, "open"],
      [0, "Mensalidade de outubro", "320,00", 20, "open"],
      [1, "Avaliação física", "150,00", 8, "open"],
    ];

    let pagas = 0;
    for (const [idx, descricao, valor, vence, status] of COBRANCAS) {
      const aluno = alunos[idx];
      const cid = await app.api.finance.insertCharge(
        aluno.id,
        { description: descricao, amount: valor, dueDate: diaISO(vence), status },
        profId,
        "BRL"
      );
      if (status === "paid") {
        await app.api.finance.insertPayment(
          aluno.id,
          { amount: valor, date: diaISO(vence + 1), method: "pix", status: "paid", charge: String(cid) },
          profId,
          "BRL"
        );
        pagas++;
      }
    }
    console.log("financeiro:", COBRANCAS.length, "cobranças,", pagas, "pagas");

    // ── 7. O AULÃO ───────────────────────────────────────────────────────
    //
    // `showcase: false`. A vitrine do vafit.app é opt-in, e uma instância de
    // demonstração aparecendo lá diria ao visitante que existe um "Estúdio
    // Demonstração" com aula de verdade no sábado.
    // Guardado à parte: o vencimento da cobrança é o DIA DA AULA, e é a mesma
    // data que vai no aulão.
    const aulaoQuando = emDias(6, 8, 0);
    const PRECO_DO_AULAO = 4000;

    const feito = await app.api.aulao.insert(profId, {
      name: "Aulão de funcional no parque",
      description:
        "Uma hora de circuito ao ar livre, para todos os níveis. Leve garrafa de água, " +
        "toalha e tênis de corrida. Em caso de chuva, remarcamos para o sábado seguinte.",
      address: "Parque Villa-Lobos — Portão 3, São Paulo",
      startsAt: aulaoQuando,
      minutes: 60,
      seats: 30,
      priceCents: PRECO_DO_AULAO,
      published: true,
      showcase: false,
    });
    if (!feito.ok) throw new Error("aulão: " + feito.erro);
    const aulaoId = feito.id;

    // ── OS INSCRITOS, COM COBRANÇA, PRESENÇA E PAGAMENTO ────────────────
    //
    // A primeira versão só chamava `inscrever`, que é o MODELO — e a cobrança
    // não é dele: quem a cria é a rota (`controllers/Aulao.js`). Resultado: a
    // demonstração tinha um aulão de R$ 40 em que ninguém devia nada, e o botão
    // "Pagar" não aparecia em foto nenhuma.
    //
    // Aqui a cobrança é criada à mão com os MESMOS campos da rota — inclusive o
    // vencimento no dia da aula, que é a regra dela.
    //
    // E os três estados aparecem de propósito: alguns pagaram, alguns não,
    // alguns vieram e um faltou. Uma lista em que tudo está no mesmo estado não
    // mostra o que a tela faz.
    const PAGOS = 4;
    const PRESENTES = 6;
    const FALTOU = 7;

    let iAluno = 0;
    for (const aluno of alunos.slice(0, 8)) {
      const r = await app.api.aulao.inscrever(aulaoId, aluno.id).catch(() => null);
      if (!r || !r.ok) continue;

      const cobranca = await app.api.finance.insertCharge(
        aluno.id,
        {
          // O preço do aulão, escrito UMA vez.
          //
          // Estava `feito.priceCents ?? 4000`, e `feito` é o retorno do insert
          // ({ok, id, slug}) — não traz preço. Funcionava pelo fallback, por
          // sorte: quem lesse concluiria que o valor vem do aulão gravado, e no
          // dia em que o preço mudasse lá a cobrança continuaria em R$ 40.
          amount: PRECO_DO_AULAO,
          dueDate: aulaoQuando,
          description: "Aulão de funcional no parque",
          aulao: aulaoId,
        },
        profId,
        "BRL"
      );

      // Os primeiros pagaram. `quitarCobranca` é o mesmo caminho do botão
      // "marcar como pago", então a demonstração mostra o estado que o produto
      // produz — e não um que só o semeador saberia criar.
      if (iAluno < PAGOS) {
        await app.api.finance.quitarCobranca(String(cobranca), { method: "pix", createdBy: profId });
      }

      if (iAluno < PRESENTES) await app.api.aulao.marcarPresenca(aulaoId, aluno.id, true);
      else if (iAluno === FALTOU) await app.api.aulao.marcarPresenca(aulaoId, aluno.id, false);

      iAluno++;
    }

    console.log("aulão: 1 |", PAGOS, "pagos,", PRESENTES, "presentes, 1 falta");

    console.log("");
    console.log("─────────────────────────────────────────");
    console.log("  https://demo.vafit.app");
    console.log("  e-mail : " + PROF.email);
    console.log("  senha  : " + senha);
    console.log("─────────────────────────────────────────");
  });

  process.exit(0);
})().catch((e) => {
  console.error("erro:", e.message);
  console.error(e.stack);
  process.exit(1);
});
