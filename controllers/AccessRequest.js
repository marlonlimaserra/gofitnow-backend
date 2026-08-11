const templates = require("../lib/emailTemplates.js");

module.exports = function (app) {
  // Adding a person starts with the e-mail, not with a form. The address is
  // what tells us whether this human already exists in the platform — and if
  // they do, the professional does not get to register a second copy of them
  // or to see their data. They have to ask.

  app.post("/people/lookup", async function (req, res) {
    const professional = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (professional === false) return;

    const email = String((req.body || {}).email || "").trim();

    if (!app.validator.isEmail(email)) {
      res.status(400).send({ msg: req.t("errors.invalidEmail") });
      return;
    }

    const found = await app.api.user.dataByEmail(email);

    // A consulta e uma leitura, mas revela se um endereco tem conta. Registrar
    // e o que permite perceber alguem varrendo e-mails para descobrir quem
    // esta na plataforma.
    app.insertUserActionHistory(req, professional, "lookup_person", {
      category: "people",
      local: { target_type: "people", target_id: found ? found._id + "" : null },
      extra: { email: email.toLowerCase(), found: !!found },
    });

    // Nobody uses this address: the professional registers the person here.
    if (!found) {
      res.send({ status: "free" });
      return;
    }

    if (String(found._id) === String(professional._id)) {
      res.send({ status: "self" });
      return;
    }

    if (await app.api.link.exists(professional._id, found._id)) {
      res.send({ status: "linked", person: { _id: found._id, name: found.name } });
      return;
    }

    const pending = await app.api.accessRequest.pendingBetween(professional._id, found._id);
    if (pending) {
      res.send({ status: "pending", requestedAt: pending.createdAt });
      return;
    }

    // The account exists but is none of this professional's business yet, so
    // the answer carries NO name, no phone, no id — only the fact that the
    // address is taken, which is the minimum needed to offer "request access".
    res.send({ status: "exists" });
  });

  app.post("/access-requests", async function (req, res) {
    const professional = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (professional === false) return;

    const email = String((req.body || {}).email || "").trim();

    if (!app.validator.isEmail(email)) {
      res.status(400).send({ msg: req.t("errors.invalidEmail") });
      return;
    }

    const person = await app.api.user.dataByEmail(email);
    if (!person) {
      res.status(404).send({ msg: req.t("errors.noAccountWithEmail") });
      return;
    }
    if (String(person._id) === String(professional._id)) {
      res.status(400).send({ msg: req.t("errors.emailIsYours") });
      return;
    }
    if (await app.api.link.exists(professional._id, person._id)) {
      res.status(409).send({ msg: req.t("errors.alreadyInYourList") });
      return;
    }

    const token = await app.api.accessRequest.create(professional._id, person._id);
    const url = `${app.helpers.mailer.appUrl()}/access-request?token=${token}`;

    const body = templates.accessRequest({
      // O e-mail sai no idioma da PESSOA que vai decidir, não no do profissional
      // que pediu. É ela quem lê e quem dá o consentimento.
      lang: person.lang,
      name: person.name,
      professionalName: professional.name,
      professionalEmail: professional.email,
      url: url,
      days: app.api.accessRequest.validityDays,
    });

    let sent;
    try {
      sent = await app.helpers.mailer.send({ to: person.email, ...body });
    } catch (error) {
      console.error("[access-request] mail failed:", error.message);
      res.status(502).send({ msg: req.t("errors.emailSendFailed") });
      return;
    }

    app.insertUserActionHistory(req, professional, "request_access", {
      category: "people",
      local: { target_type: "people", target_id: person._id + "" },
      extra: { email: person.email, name: person.name },
    });

    const payload = { msg: req.t("ok.requestSent") };
    if (sent.preview) payload.preview = sent.preview;

    res.status(201).send(payload);
  });

  // What the professional is still waiting on. Without this the request would
  // disappear from the screen the moment it was sent.
  app.get("/access-requests", async function (req, res) {
    const professional = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (professional === false) return;

    const rows = await app.api.accessRequest.listPendingOf(professional._id);

    const people = await Promise.all(rows.map((r) => app.api.user.data(r.person)));

    res.send(
      rows.map((r, i) => ({
        _id: r._id,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        // The professional already knows this address — they typed it.
        person: people[i] ? { name: people[i].name, email: people[i].email } : null,
      }))
    );
  });

  app.delete("/access-requests/:id", async function (req, res) {
    const professional = await app.helpers.ReqProtected.can(req, res, "people.create");
    if (professional === false) return;

    const ok = await app.api.accessRequest.cancel(professional._id, req.params.id);
    if (!ok) {
      res.status(404).send({ msg: req.t("errors.requestNotFound") });
      return;
    }

    app.insertUserActionHistory(req, professional, "cancel_access_request", {
      category: "people",
      local: { target_type: "access_requests", target_id: req.params.id + "" },
    });

    res.send({ msg: req.t("ok.requestCancelled") });
  });

  // ── The person's side. Public: the token arrived in their inbox, which is
  // the same proof the password reset relies on. Requiring a login here would
  // lock out exactly the people who never set a password.

  app.get("/access-requests/:token", async function (req, res) {
    const request = await app.api.accessRequest.verify(req.params.token);
    if (!request) {
      res.status(400).send({ msg: req.t("errors.requestNoLongerValid") });
      return;
    }

    const professional = await app.api.user.data(request.professional);
    const person = await app.api.user.data(request.person);

    if (!professional || !person) {
      res.status(400).send({ msg: req.t("errors.requestNoLongerValid") });
      return;
    }

    res.send({
      person: { name: person.name },
      professional: { name: professional.name, email: professional.email },
      requestedAt: request.createdAt,
    });
  });

  app.post("/access-requests/:token/respond", async function (req, res) {
    const request = await app.api.accessRequest.verify(req.params.token);
    if (!request) {
      res.status(400).send({ msg: req.t("errors.requestNoLongerValid") });
      return;
    }

    const approve = (req.body || {}).approve === true;

    await app.api.accessRequest.respond(request._id, approve ? "approved" : "denied");

    if (approve) {
      await app.api.link.link(request.professional, request.person, "request");
    }

    const person = await app.api.user.data(request.person);
    const professional = await app.api.user.data(request.professional);

    app.insertUserActionHistory(req, person, approve ? "approve_access" : "deny_access", {
      category: "people",
      local: { target_type: "people", target_id: request.person + "" },
      extra: {
        professional: professional ? professional.name : null,
        professionalEmail: professional ? professional.email : null,
        via: "link_email",
      },
    });

    res.send({
      msg: approve ? "Acesso liberado." : "Pedido recusado.",
      approved: approve,
    });
  });
};
