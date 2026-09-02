// Models are instantiated with `app` and live under app.api.*
const models = {};

// O registro das instâncias. Mora no banco CENTRAL — é a única coisa que sabe
// que existe mais de um cliente.
models.center = require("./model/Center_model.js");
models.affiliate = require("./model/Affiliate_model.js");
// O suporte que este cliente RECEBE da GoFitNow — chamados, perguntas
// frequentes e o WhatsApp de quem atende. Tudo mora no central.
models.support = require("./model/Support_model.js");
// A identidade que atravessa os clientes: e-mail, senha e foto de cada pessoa,
// uma vez só. Também na central — ver o comentário do modelo.
models.allUser = require("./model/AllUser_model.js");

models.user = require("./model/User_model.js");
models.auth = require("./model/Auth_model.js");
models.workout = require("./model/Workout_model.js");
models.diet = require("./model/Diet_model.js");
models.supplement = require("./model/Supplement_model.js");
models.exam = require("./model/Exam_model.js");
models.anamnesis = require("./model/Anamnesis_model.js");
models.anamnesisLink = require("./model/AnamnesisLink_model.js");
models.prescription = require("./model/Prescription_model.js");
models.assessment = require("./model/Assessment_model.js");
models.assessmentPhoto = require("./model/AssessmentPhoto_model.js");
models.chat = require("./model/Chat_model.js");
models.appointment = require("./model/Appointment_model.js");
models.service = require("./model/Service_model.js");
models.finance = require("./model/Finance_model.js");
// As formas de pagamento de cada conta. Eram uma lista fixa dentro do financeiro.
models.paymentMethod = require("./model/PaymentMethod_model.js");
models.availability = require("./model/Availability_model.js");
models.bookingPage = require("./model/BookingPage_model.js");
models.food = require("./model/Food_model.js");
models.foodImage = require("./model/FoodImage_model.js");
models.exercise = require("./model/Exercise_model.js");
models.passwordReset = require("./model/PasswordReset_model.js");
models.portal = require("./model/Portal_model.js");
models.clientError = require("./model/ClientError_model.js");
models.recipeCategory = require("./model/RecipeCategory_model.js");
models.userCategory = require("./model/UserCategory_model.js");
models.role = require("./model/Role_model.js");
models.link = require("./model/Link_model.js");
models.actionHistory = require("./model/ActionHistory_model.js");
models.workoutTemplate = require("./model/WorkoutTemplate_model.js");
models.dietTemplate = require("./model/DietTemplate_model.js");
models.autoFill = require("./model/AutoFill_model.js");
models.avatar = require("./model/Avatar_model.js");
models.apiKey = require("./model/ApiKey_model.js");
models.apiCall = require("./model/ApiCall_model.js");
models.tenant = require("./model/Tenant_model.js");
models.ai = require("./model/Ai_model.js");
models.aiSession = require("./model/AiSession_model.js");
models.brandImage = require("./model/BrandImage_model.js");
// As chaves do "entrar com ___" — lidas do banco da CENTRAL, onde a tela
// "Chaves e apps" do painel as grava. Estes modelos só leem.
//
// O que é IGUAL nos dois (chaves, bilhete, TTL, endereço de volta) mora em
// `Oauth_model.js`, de onde os dois herdam.
models.oauthGoogle = require("./model/OauthGoogle_model.js");
models.oauthFacebook = require("./model/OauthFacebook_model.js");

module.exports = models;
