// Helpers are instantiated with `app` and live under app.helpers.*
const helpers = {};

helpers.authSession = require("./helper/AuthSession.js");
helpers.ReqProtected = require("./helper/ReqProtected.js");
helpers.mailer = require("./helper/Mailer.js");

module.exports = helpers;
