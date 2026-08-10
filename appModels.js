// Models are instantiated with `app` and live under app.api.*
const models = {};

models.user = require("./model/User_model.js");
models.auth = require("./model/Auth_model.js");
models.workout = require("./model/Workout_model.js");
models.exercise = require("./model/Exercise_model.js");

module.exports = models;
