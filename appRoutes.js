// Each controller is a function (app) => { app.get(...); app.post(...) }.
const routes = {};

routes.Index = require("./controllers/Index.js");
routes.Auth = require("./controllers/Auth.js");
// O "entrar com ___" — Google e Facebook pelo mesmo controlador. Separado de
// Auth porque o assunto é outro: aqui a prova de identidade vem de fora.
routes.Oauth = require("./controllers/Oauth.js");
routes.User = require("./controllers/User.js");
routes.AdminUser = require("./controllers/AdminUser.js");
routes.Role = require("./controllers/Role.js");
routes.ActionHistory = require("./controllers/ActionHistory.js");
routes.Student = require("./controllers/Student.js");
routes.Workout = require("./controllers/Workout.js");
routes.Exercise = require("./controllers/Exercise.js");
routes.Diet = require("./controllers/Diet.js");
routes.Supplement = require("./controllers/Supplement.js");
routes.Exam = require("./controllers/Exam.js");
routes.My = require("./controllers/My.js");
routes.Anamnesis = require("./controllers/Anamnesis.js");
routes.Prescription = require("./controllers/Prescription.js");
routes.Assessment = require("./controllers/Assessment.js");
routes.Chat = require("./controllers/Chat.js");
routes.Appointment = require("./controllers/Appointment.js");
routes.Service = require("./controllers/Service.js");
routes.Finance = require("./controllers/Finance.js");
// O cardápio que a ACADEMIA vende aos alunos dela, e as linhas que comparam um
// plano com o outro. Controller próprio e não dentro de Finance: aquele já tem
// dezoito rotas, e plano não é lançamento — é catálogo.
//
// `Membership` e não `Plan`: o `Plan.js` logo acima é o plano do PRODUTO, com a
// Stripe. Os dois se chamam "Planos" na tela, e só na tela.
routes.Membership = require("./controllers/Membership.js");
// CONTAS A PAGAR. Controller próprio e não dentro de Finance pela mesma razão
// de Membership: aquele já tem dezoito rotas, e conta a pagar é o outro lado do
// caixa — dinheiro que SAI, para fornecedor que não tem cadastro aqui.
routes.Payable = require("./controllers/Payable.js");
routes.Supplier = require("./controllers/Supplier.js");
routes.Employee = require("./controllers/Employee.js");
routes.DocumentTemplate = require("./controllers/DocumentTemplate.js");
routes.PersonDocument = require("./controllers/PersonDocument.js");
routes.Checkin = require("./controllers/Checkin.js");
routes.Structure = require("./controllers/Structure.js");
routes.Unit = require("./controllers/Unit.js");
routes.GroupClass = require("./controllers/GroupClass.js");
routes.Booking = require("./controllers/Booking.js");
// Os AULÕES: aula em grupo com data, lugar e vagas. Vizinho de Booking porque
// os dois são o calendário visto de fora.
routes.Aulao = require("./controllers/Aulao.js");
routes.Food = require("./controllers/Food.js");
routes.WorkoutTemplate = require("./controllers/WorkoutTemplate.js");
routes.DietTemplate = require("./controllers/DietTemplate.js");
routes.AutoFill = require("./controllers/AutoFill.js");
routes.Avatar = require("./controllers/Avatar.js");
routes.ApiKey = require("./controllers/ApiKey.js");
routes.Tenant = require("./controllers/Tenant.js");
routes.Plan = require("./controllers/Plan.js");
routes.Support = require("./controllers/Support.js");
routes.Idea = require("./controllers/Idea.js");
// As novidades do produto e o botão que libera um módulo. Vizinho das ideias e
// do suporte porque os três leem o CENTRAL: é a conversa entre o produto e quem
// o usa, e ela não é dado de cliente.
routes.Novidade = require("./controllers/Novidade.js");
// A porta de saída: excluir a própria conta. Exigência das duas lojas, e a
// única forma de alguém sair do sistema por conta própria.
routes.Account = require("./controllers/Account.js");
routes.Affiliate = require("./controllers/Affiliate.js");
routes.UserCategory = require("./controllers/UserCategory.js");
routes.TabCounts = require("./controllers/TabCounts.js");
routes.Portal = require("./controllers/Portal.js");
routes.ClientError = require("./controllers/ClientError.js");
routes.RecipeCategory = require("./controllers/RecipeCategory.js");
routes.Ai = require("./controllers/Ai.js");
routes.Brand = require("./controllers/Brand.js");
// Chamadas por outro serviço nosso (o painel do center), não por navegador.
routes.Internal = require("./controllers/Internal.js");
// A porta MCP: onde um modelo opera o sistema por ferramenta, e não pela tela.
routes.Mcp = require("./controllers/Mcp.js");
// Levar a lista embora: planilha e papel, para qualquer cliente. Duas rotas
// para todas as listas — ver `lib/listasExportaveis.js`.
routes.Exportar = require("./controllers/Exportar.js");

module.exports = routes;
