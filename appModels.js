// Models are instantiated with `app` and live under app.api.*
const models = {};

// O registro das instâncias. Mora no banco CENTRAL — é a única coisa que sabe
// que existe mais de um cliente.
models.center = require("./model/Center_model.js");
models.affiliate = require("./model/Affiliate_model.js");
// O suporte que este cliente RECEBE da GoFitNow — chamados, perguntas
// frequentes e o WhatsApp de quem atende. Tudo mora no central.
models.support = require("./model/Support_model.js");
// As ideias: sugeridas e votadas aqui, respondidas no painel. Como o suporte,
// elas moram no banco CENTRAL — o produto é um só, e o voto tem de somar.
models.idea = require("./model/Idea_model.js");
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
// Os AULÕES: aula em grupo com data, lugar e vagas. Vizinho de 
// porque são as duas coisas que o profissional OFERECE — e o comentário do
// modelo explica por que o aulão não cabia dentro de serviço.
models.aulao = require("./model/Aulao_model.js");
// As fotos de um aulão: capa e galeria. Collection PRÓPRIA e não `brand_images`
// — a coleta de lixo daquela apaga o que o tema não usa, e apagaria as fotos de
// todo aulão no primeiro salvamento de aparência.
models.aulaoImage = require("./model/AulaoImage_model.js");
// O numerador de cada conta: é dele que sai o "#12" que se fala ao telefone.
// O `_id` do Mongo tem 24 caracteres e não serve para isso.
models.counter = require("./model/Counter_model.js");
models.finance = require("./model/Finance_model.js");
// A mensalidade, a anuidade, o pacote trimestral — a REGRA que gera cobrança.
// Collection própria e não um campo na cobrança: a regra é infinita e a cobrança
// é um fato, e guardar as duas juntas faria um total somar dinheiro que ainda
// não existe.
models.recurrence = require("./model/Recurrence_model.js");
// CONTAS A PAGAR — a luz, o telefone, o aluguel, a folha.
//
// Collection própria e não uma cobrança com sinal trocado: a cobrança pertence
// a uma PESSOA da conta e aceita pagamento parcial; a conta pertence a um
// fornecedor que não tem cadastro aqui e é paga de uma vez. Juntá-las faria
// toda consulta de aluno carregar um `$ne` de tipo — e no dia em que alguém
// esquecesse, a conta de luz entraria como receita.
models.payable = require("./model/Payable_model.js");
// OS FORNECEDORES — quem recebe o que sai. Cadastro e não texto livre: com
// campo livre, "Enel", "ENEL" e "Enel SP" viram três, e "quanto paguei para a
// Enel este ano" deixa de ter resposta.
models.supplier = require("./model/Supplier_model.js");
models.supplierImage = require("./model/SupplierImage_model.js");
// ── A EQUIPE DA CASA ────────────────────────────────────────────────────────
//
// Quatro modelos: a ficha, a linha do tempo do que aconteceu com ela, a folha
// de ponto e a foto. Ver `controllers/Employee.js` para por que salário é uma
// permissão separada.
models.employee = require("./model/Employee_model.js");
models.employeeRecord = require("./model/EmployeeRecord_model.js");
models.employeeTime = require("./model/EmployeeTime_model.js");
models.employeeImage = require("./model/EmployeeImage_model.js");
// O CARDÁPIO que a casa vende aos ALUNOS dela — "Black", "Fit", "Smart" — e as
// linhas da tabela que compara um com o outro. Modelos separados porque são
// coisas separadas: o plano é o que se vende, o benefício é o que se compara.
//
// `membership` e não `plan`: "plano" neste servidor já é o do PRODUTO, o que
// nós vendemos para a academia (`controllers/Plan.js`, com a Stripe). Duas
// camadas de assinatura, dois nomes.
models.membership = require("./model/Membership_model.js");
models.membershipBenefit = require("./model/MembershipBenefit_model.js");
// A capa de cada plano. Collection própria pela mesma razão da do aulão: a
// coleta de lixo da marca apagaria as fotos no primeiro salvamento de
// aparência.
models.membershipImage = require("./model/MembershipImage_model.js");

// AS UNIDADES — os lugares onde a casa atende, e a foto de cada um.
//
// `unit` e não `branch`/`location`: o Marlon as chamou de unidades, e é a
// palavra que a tela mostra. Nomear o modelo pelo que ele é na conversa é o
// que evita o dia em que alguém procura `unidade` e não acha nada.
models.unit = require("./model/Unit_model.js");
models.unitImage = require("./model/UnitImage_model.js");

// AS AULAS COLETIVAS — a grade que se repete toda semana — e quem entrou na de
// hoje. Duas collections porque são duas verdades: a aula é permanente, o
// check-in é do DIA.
models.groupClass = require("./model/GroupClass_model.js");
models.groupClassCheckin = require("./model/GroupClassCheckin_model.js");
models.groupClassImage = require("./model/GroupClassImage_model.js");
// A aula de UM DIA: o que muda de uma ocorrência para a outra — hoje, se ela
// está fechada para inscrição.
models.groupClassSession = require("./model/GroupClassSession_model.js");
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
// O que esta conta LIBEROU. Um módulo novo não acende menu no deploy: a notícia
// chega primeiro, com o vídeo e a documentação, e quem libera é o admin da conta.
models.modulo = require("./model/Modulo_model.js");
// As notícias do produto. Lidas do CENTRAL, da mesma coleção que alimenta a
// página /novidades do site — uma notícia, dois públicos.
models.novidade = require("./model/Novidade_model.js");
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
