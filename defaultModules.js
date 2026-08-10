// Módulos que ficam pendurados no `app` e são usados pelos models/controllers
// como app.moment, app.crypto, etc. Mesmo padrão do monit-backend.
const fs = require("fs");
const url = require("url");
const crypto = require("crypto");
const moment = require("moment");
const validator = require("validator");
const { v4: uuidv4 } = require("uuid");

module.exports = {
  fs,
  url,
  crypto,
  moment,
  validator,
  uuidv4,
};
