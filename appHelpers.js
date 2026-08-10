// Helpers são instanciados com o `app` e ficam em app.helpers.*
const helpers = {};

helpers.authSession = require("./helper/AuthSession.js");
helpers.ReqProtected = require("./helper/ReqProtected.js");

module.exports = helpers;
