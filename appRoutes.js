// Each controller is a function (app) => { app.get(...); app.post(...) }.
const routes = {};

routes.Index = require("./controllers/Index.js");
routes.Auth = require("./controllers/Auth.js");
routes.User = require("./controllers/User.js");
routes.AdminUser = require("./controllers/AdminUser.js");
routes.Role = require("./controllers/Role.js");
routes.ActionHistory = require("./controllers/ActionHistory.js");
routes.Student = require("./controllers/Student.js");
routes.AccessRequest = require("./controllers/AccessRequest.js");
routes.Workout = require("./controllers/Workout.js");
routes.Exercise = require("./controllers/Exercise.js");
routes.WorkoutTemplate = require("./controllers/WorkoutTemplate.js");
routes.AutoFill = require("./controllers/AutoFill.js");
routes.Avatar = require("./controllers/Avatar.js");
routes.ApiKey = require("./controllers/ApiKey.js");
routes.Tenant = require("./controllers/Tenant.js");

module.exports = routes;
