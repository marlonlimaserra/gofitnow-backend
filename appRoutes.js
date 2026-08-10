// Each controller is a function (app) => { app.get(...); app.post(...) }.
const routes = {};

routes.Index = require("./controllers/Index.js");
routes.Auth = require("./controllers/Auth.js");
routes.User = require("./controllers/User.js");
routes.Client = require("./controllers/Client.js");
routes.Student = require("./controllers/Student.js");
routes.Workout = require("./controllers/Workout.js");
routes.Exercise = require("./controllers/Exercise.js");

module.exports = routes;
