// Cada controller é uma função (app) => { app.get(...); app.post(...) }.
const routes = {};

routes.Index = require("./controllers/Index.js");
routes.Auth = require("./controllers/Auth.js");
routes.User = require("./controllers/User.js");
routes.Cliente = require("./controllers/Cliente.js");
routes.Aluno = require("./controllers/Aluno.js");
routes.Treino = require("./controllers/Treino.js");
routes.Exercicio = require("./controllers/Exercicio.js");

module.exports = routes;
