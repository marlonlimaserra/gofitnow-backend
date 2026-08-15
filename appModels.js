// Models are instantiated with `app` and live under app.api.*
const models = {};

// O registro das instâncias. Mora no banco CENTRAL — é a única coisa que sabe
// que existe mais de um cliente.
models.center = require("./model/Center_model.js");

models.user = require("./model/User_model.js");
models.auth = require("./model/Auth_model.js");
models.workout = require("./model/Workout_model.js");
models.diet = require("./model/Diet_model.js");
models.assessment = require("./model/Assessment_model.js");
models.assessmentPhoto = require("./model/AssessmentPhoto_model.js");
models.chat = require("./model/Chat_model.js");
models.appointment = require("./model/Appointment_model.js");
models.service = require("./model/Service_model.js");
models.finance = require("./model/Finance_model.js");
models.availability = require("./model/Availability_model.js");
models.bookingPage = require("./model/BookingPage_model.js");
models.food = require("./model/Food_model.js");
models.exercise = require("./model/Exercise_model.js");
models.passwordReset = require("./model/PasswordReset_model.js");
models.role = require("./model/Role_model.js");
models.link = require("./model/Link_model.js");
models.actionHistory = require("./model/ActionHistory_model.js");
models.workoutTemplate = require("./model/WorkoutTemplate_model.js");
models.autoFill = require("./model/AutoFill_model.js");
models.avatar = require("./model/Avatar_model.js");
models.apiKey = require("./model/ApiKey_model.js");
models.apiCall = require("./model/ApiCall_model.js");
models.tenant = require("./model/Tenant_model.js");
models.ai = require("./model/Ai_model.js");
models.aiSession = require("./model/AiSession_model.js");
models.brandImage = require("./model/BrandImage_model.js");

module.exports = models;
