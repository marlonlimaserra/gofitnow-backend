const ensureSchema = require("../database/schema.js");
const instanceContext = require("../lib/instance.js");

// Rotas INTERNAS — chamadas por outro serviço nosso, nunca por um navegador.
//
// Existe uma só, e ela existe por um motivo de dono: o schema de uma instância
// (quais collections, quais índices) é conhecimento DESTE backend. O painel do
// center precisa criar clientes, mas duplicar o schema lá significaria dois
// lugares para atualizar e um deles sempre atrasado.
//
// Então o center registra o cliente no `center` e PEDE o provisionamento aqui.
// Uma fonte de verdade, e o painel não precisa saber o que é uma collection.
//
// A porta é uma chave compartilhada no ambiente, e não sessão: quem chama é um
// serviço, não uma pessoa. Sem a chave configurada a rota não existe — melhor
// não ter porta do que ter uma porta sem tranca.
module.exports = function (app) {
  const chave = process.env.INTERNAL_KEY || "";

  if (!chave) {
    console.log("[internal] INTERNAL_KEY ausente — rotas internas desativadas");
    return;
  }

  function autorizado(req, res) {
    const mandada = String(req.headers["x-internal-key"] || "");

    // Comparação de tamanho fixo: um `!==` normal vaza, pelo tempo, quantos
    // caracteres iniciais estão certos.
    const a = Buffer.from(mandada.padEnd(chave.length).slice(0, chave.length));
    const b = Buffer.from(chave);
    const ok = mandada.length === chave.length && app.crypto.timingSafeEqual(a, b);

    if (!ok) {
      // 404 e não 403: para quem não tem a chave, esta rota não existe.
      res.status(404).send({ msg: "not_found" });
      return false;
    }

    return true;
  }

  // Cria (ou confere) as collections e os índices de uma instância.
  //
  // Idempotente de propósito: o center pode repetir a chamada depois de uma
  // falha de rede sem risco, e um deploy novo alcança clientes criados pela
  // versão anterior.
  app.post("/internal/instances/:instance/provision", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.params.instance);
    if (!nome) return res.status(400).send({ msg: "invalid_instance" });

    // O registro tem de existir ANTES: provisionar um banco para um cliente que
    // ninguém cadastrou deixaria um banco órfão que nada apaga.
    const registro = await app.api.center.byInstance(nome);
    if (!registro) return res.status(404).send({ msg: "instance_not_registered" });

    await ensureSchema.ensureInstance(app, nome);

    res.send({ ok: true, instance: nome, db: app.mongodb.dbNameFor(nome) });
  });

  // Quantas coisas existem numa instância. O painel mostra para dar noção de
  // uso; é leitura pura.
  app.get("/internal/instances/:instance/stats", async function (req, res) {
    if (!autorizado(req, res)) return;

    const nome = instanceContext.normalize(req.params.instance);
    if (!nome) return res.status(400).send({ msg: "invalid_instance" });

    const registro = await app.api.center.byInstance(nome);
    if (!registro) return res.status(404).send({ msg: "instance_not_registered" });

    const db = await app.mongodb.instanceDb(nome);
    const conta = async (nomeCol, filtro = {}) => {
      try {
        return await db.collection(nomeCol).countDocuments(filtro);
      } catch (error) {
        // Collection que ainda não existe conta zero — é o que ela é.
        return 0;
      }
    };

    res.send({
      instance: nome,
      professionals: await conta("users", { type: "trainer" }),
      people: await conta("users", { type: "student" }),
      workouts: await conta("workouts"),
      apiKeys: await conta("api_keys", { revokedAt: null }),
    });
  });
};
