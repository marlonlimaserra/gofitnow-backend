// Models are instantiated with `app` and live under app.api.*
const models = {};

models.user = require("./model/User_model.js");
models.auth = require("./model/Auth_model.js");
models.workout = require("./model/Workout_model.js");
models.exercise = require("./model/Exercise_model.js");
models.passwordReset = require("./model/PasswordReset_model.js");
models.role = require("./model/Role_model.js");
models.link = require("./model/Link_model.js");
models.accessRequest = require("./model/AccessRequest_model.js");
models.actionHistory = require("./model/ActionHistory_model.js");
models.workoutTemplate = require("./model/WorkoutTemplate_model.js");
models.autoFill = require("./model/AutoFill_model.js");

module.exports = models;
