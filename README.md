# GoFitNow — Backend

API do GoFitNow (personal trainers e alunos). Estrutura herdada do `monit-backend`,
mas **só MongoDB** — sem MySQL, Redis, RabbitMQ ou AWS.

> **Convenção:** tudo que é banco de dados — coleções, campos e valores de enum
> — é em **inglês**. Português fica só nos textos da interface e nas mensagens
> de erro que o usuário lê.

## Requisitos

- Node.js 18+
- MongoDB rodando localmente

## Configuração

O `.env` tem **apenas a URL do Mongo**:

```
MONGODB_URI=mongodb://127.0.0.1:27017/gofitnow
```

O nome do banco (`gofitnow`) sai da própria URI. A porta da API tem default no
código (`3030`); só defina `EXPRESS_PORT` se precisar mudar.

## Rodando

```bash
npm install
npm run db:init      # cria coleções e índices (opcional — o boot já faz isso)
npm start            # nodemon app.js
```

Para já criar o primeiro usuário (nasce **trainer + admin**):

```bash
npm run db:init -- "Seu Nome" "voce@email.com" "suasenha"
```

## Produção

Roda em `179.198.120.67`, exposta em **https://backend.gofitnow.fit**.

```
/opt/gofitnow-backend            código
/opt/gofitnow-backend/.env       só a MONGODB_URI (chmod 600)
gofitnow-backend.service         systemd, usuário `gofitnow` (sem shell)
/etc/nginx/sites-available/backend.gofitnow.fit
```

Porta e host ficam no **systemd**, não no `.env` — assim o `.env` segue com
apenas a URL do Mongo. O node escuta em `127.0.0.1:3030`, então a porta não é
alcançável da internet; quem atende é o nginx.

```bash
systemctl status gofitnow-backend      # estado
journalctl -u gofitnow-backend -f      # logs
systemctl restart gofitnow-backend     # reiniciar
```

SSL do Let's Encrypt via `certbot --nginx`, com renovação pelo `certbot.timer`
(testada com `--dry-run`). HTTP redireciona para HTTPS com 301.

**Publicar uma versão nova:**

```bash
# na máquina local, dentro de gofitnow-backend/
tar -czf /tmp/api.tar.gz --exclude=node_modules --exclude=.git --exclude=.env .
scp /tmp/api.tar.gz root@179.198.120.67:/tmp/
ssh root@179.198.120.67 '
  tar -xzf /tmp/api.tar.gz -C /opt/gofitnow-backend &&
  cd /opt/gofitnow-backend &&
  npm install --omit=dev --no-audit --no-fund &&
  chown -R gofitnow:gofitnow /opt/gofitnow-backend &&
  systemctl restart gofitnow-backend'
```

## Estrutura

```
app.js                 entry — wiring do Express, models, helpers e rotas
appRoutes.js           mapa de controllers
appModels.js           mapa de models  → app.api.*
appHelpers.js          mapa de helpers → app.helpers.*
defaultModules.js      moment, crypto, validator, uuid → app.*
config/mongodb.js      conexão única com o Mongo
database/schema.js     coleções + índices (idempotente, roda no boot)
database/init.js       script standalone (npm run db:init)
controllers/           rotas HTTP
model/                 acesso às coleções
helper/                AuthSession, ReqProtected
```

## Coleções

| Coleção            | Conteúdo                                          |
| ------------------ | ------------------------------------------------- |
| `users`            | toda pessoa: trainer ou student                   |
| `user_tokens`      | sessões ativas (TTL de 30 dias em `expiresAt`)    |
| `workouts`         | treinos do aluno (período, objetivo, professor)   |
| `workout_sessions` | dias do treino, com os exercícios embutidos       |
| `exercises`        | catálogo de exercícios de cada trainer            |

### O documento `users`

```js
{
  name, email,
  password, salt,        // null enquanto o student não tem acesso liberado
  type: "trainer" | "student",
  admin: true | false,   // flag SEPARADA do type
  trainer: ObjectId,     // só em type="student" — o dono da ficha
  phone, birthDate, goal, weight, height, notes,
  active, createdAt, updatedAt
}
```

**Papéis**

- `type: "trainer"` — cadastra e enxerga os próprios alunos.
- `type: "student"` — enxerga só a si; `trainer` aponta pro dono.
- `admin: true` — enxerga o menu **Clientes** e cadastra os trainers da
  plataforma. É ortogonal ao type: um admin normalmente é também um trainer.

A senha é SHA-512 de `salt + ":" + password`, com salt sorteado por usuário.
`password` e `salt` nunca saem da API — no lugar vai `hasAccess: boolean`.

O índice único de e-mail é **parcial** (`{ email: { $type: "string" } }`):
student sem acesso pode não ter e-mail, e sem o filtro o segundo student sem
e-mail colidiria com o primeiro. E-mail vazio é gravado como campo ausente,
nunca como `""`.

## Autenticação

Trainer e student entram pela mesma rota. O login devolve `session`, que o
frontend manda no header `session` em toda rota autenticada.

```
POST   /auth/register     { name, email, password }  → cria TRAINER comum
POST   /auth              { email, password }        → { session, user }
GET    /auth/verify                                  → { user }
POST   /auth/logout
PUT    /auth/senha        { currentPassword, newPassword } → { session }
```

`/auth/register` nunca cria admin nem student: admin só é marcado por outro
admin em `/clientes`, e student é criado pelo seu trainer em `/alunos`.

## Endpoints

```
GET    /health                          ping da API + Mongo

GET    /me                              próprio usuário (student recebe
PUT    /me         { name, email }      junto o `trainerInfo`)

# --- só admin ---
GET    /clientes          ?busca=&active=     trainers da plataforma
GET    /clientes/resumo
GET    /clientes/:id
POST   /clientes          { name, email, password, phone, admin, active }
PUT    /clientes/:id
DELETE /clientes/:id

# --- só trainer ---
GET    /alunos            ?busca=&active=
GET    /alunos/resumo
GET    /alunos/:id
POST   /alunos            { name, email, password?, phone, birthDate,
                            goal, weight, height, notes, active }
PUT    /alunos/:id
DELETE /alunos/:id/acesso               tira o login, mantém a ficha
DELETE /alunos/:id

# --- treinos (só trainer) ---
GET    /alunos/:studentId/treinos       { rows, counts } — counts alimenta as
POST   /alunos/:studentId/treinos         abas Atuais/Anteriores/Futuros/Todos
GET    /treinos/:id                     treino + sessões
PUT    /treinos/:id
DELETE /treinos/:id                     leva as sessões junto
POST   /treinos/:id/duplicar            { studentId? } copia com as sessões

POST   /treinos/:id/sessoes             { name, calories? }
GET    /sessoes/:id
PUT    /sessoes/:id
DELETE /sessoes/:id
PUT    /sessoes/:id/exercicios          { exercises: [...] } salva a lista toda

# --- catálogo de exercícios (só trainer) ---
GET    /exercicios        ?busca=&grupo=&page=&limit=
GET    /exercicios/grupos               grupos musculares em uso
POST   /exercicios        { name, muscleGroup, videoUrl, defaultTip }
GET    /exercicios/:id
PUT    /exercicios/:id
DELETE /exercicios/:id
```

### Treinos e sessões

`workouts` guarda o treino; `workout_sessions` guarda cada dia com os
**exercícios embutidos** no documento. Uma sessão tem ~10 exercícios e eles
nunca são lidos sem ela — coleção separada só custaria um join por tela.

Cada série tem `unit`, `quantity`, `load`, `intensity`, `speed` e `rest`.

O status (`current` / `past` / `future`) é derivado do período contra a data de
hoje, comparando `YYYY-MM-DD` — um treino que termina hoje segue atual o dia
inteiro.

### Catálogo de exercícios

Cada trainer monta o seu; não há biblioteca de terceiros. `muscleGroup` é texto
livre e o filtro lista os valores distintos que o próprio trainer cadastrou, ou
seja, a taxonomia nasce do uso.

`nameSort` (nome sem espaços nas pontas, minúsculo e sem acento) é o que ordena
e o que a busca consulta — o sort binário do Mongo jogaria as maiúsculas pra
frente, e "gluteo" não acharia "glúteo".

Excluir do catálogo **não** mexe nos treinos já montados: a sessão copia nome e
miniatura, então continua legível sem o exercício de origem.

`password` no student é opcional: sem ela a ficha existe mas ele não loga. Com
ela, o e-mail passa a ser obrigatório — é por ele que ele entra.

> Os **caminhos** das rotas continuam em português (`/alunos`, `/clientes`),
> acompanhando o vocabulário da interface. Só os payloads seguem o banco.

## Guardas

O menu do frontend esconde; o backend recusa. Toda rota passa por
`app.helpers.ReqProtected`:

| Método           | Quem passa              | Quem é barrado |
| ---------------- | ----------------------- | -------------- |
| `verify`         | qualquer usuário logado | 401 sem sessão |
| `verifyTrainer`  | `type === "trainer"`    | 403            |
| `verifyAdmin`    | `admin === true`        | 403            |

Regras que o backend garante sozinho:

- Student é sempre escopado no trainer da sessão — o id do dono nunca vem do
  body ou da query.
- O último admin ativo não pode se rebaixar, se desativar nem ser excluído.
- Ninguém exclui a própria conta pelo menu Clientes.
- Trainer com students vinculados não é excluído (deixaria fichas órfãs) —
  desative-o ou remova os alunos antes.
