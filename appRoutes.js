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
routes.Assessment = require("./controllers/Assessment.js");
routes.Chat = require("./controllers/Chat.js");
routes.Appointment = require("./controllers/Appointment.js");
routes.Service = require("./controllers/Service.js");
routes.Finance = require("./controllers/Finance.js");
routes.Booking = require("./controllers/Booking.js");
routes.Food = require("./controllers/Food.js");
routes.WorkoutTemplate = require("./controllers/WorkoutTemplate.js");
routes.AutoFill = require("./controllers/AutoFill.js");
routes.Avatar = require("./controllers/Avatar.js");
routes.ApiKey = require("./controllers/ApiKey.js");
routes.Tenant = require("./controllers/Tenant.js");
routes.Portal = require("./controllers/Portal.js");
routes.ClientError = require("./controllers/ClientError.js");
routes.RecipeCategory = require("./controllers/RecipeCategory.js");
routes.Ai = require("./controllers/Ai.js");
routes.Brand = require("./controllers/Brand.js");
// Chamadas por outro serviço nosso (o painel do center), não por navegador.
routes.Internal = require("./controllers/Internal.js");
// A porta MCP: onde um modelo opera o sistema por ferramenta, e não pela tela.
routes.Mcp = require("./controllers/Mcp.js");

module.exports = routes;
