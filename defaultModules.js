// Modules hung off `app` and used by models/controllers as app.moment,
// app.crypto and so on. Same pattern as monit-backend.
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
