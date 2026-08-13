// Each controller is a function (app) => { app.get(...); app.post(...) }.
const routes = {};

routes.Index = require("./controllers/Index.js");
routes.Auth = require("./controllers/Auth.js");
routes.User = require("./controllers/User.js");
routes.AdminUser = require("./controllers/AdminUser.js");
routes.Role = require("./controllers/Role.js");
routes.ActionHistory = require("./controllers/ActionHistory.js");
routes.Student = require("./controllers/Student.js");
routes.Workout = require("./controllers/Workout.js");
routes.Exercise = require("./controllers/Exercise.js");
routes.Diet = require("./controllers/Diet.js");
routes.Food = require("./controllers/Food.js");
routes.WorkoutTemplate = require("./controllers/WorkoutTemplate.js");
routes.AutoFill = require("./controllers/AutoFill.js");
routes.Avatar = require("./controllers/Avatar.js");
routes.ApiKey = require("./controllers/ApiKey.js");
routes.Tenant = require("./controllers/Tenant.js");
routes.Brand = require("./controllers/Brand.js");
// Chamadas por outro serviço nosso (o painel do center), não por navegador.
routes.Internal = require("./controllers/Internal.js");

module.exports = routes;
