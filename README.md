# GoFitNow — Backend

GoFitNow API (personal trainers and their students). The structure comes from
`monit-backend`, but this one is **MongoDB only** — no MySQL, Redis, RabbitMQ
or AWS.

> **Language convention:** everything in the codebase is **English** — file
> names, identifiers, comments, HTTP routes, collections and fields. Only what
> the end user reads is Portuguese: the `msg` in error responses. The product
> is Brazilian; the code is not.

## Requirements

- Node.js 18+
- MongoDB running locally

## Configuration

The `.env` holds **only the Mongo URL**:

```
MONGODB_URI=mongodb://127.0.0.1:27017/gofitnow
```

The database name (`gofitnow`) comes from the URI itself. The API port defaults
in code (`3030`); set `EXPRESS_PORT` only if you need to change it.

## Running

```bash
npm install
npm run db:init      # collections and indexes (boot does this too)
npm start            # nodemon app.js
```

To create the first user (born **trainer + admin**):

```bash
npm run db:init -- "Your Name" "you@email.com" "yourpassword"
```

## Production

Runs on `179.198.120.67`, served at **https://backend.gofitnow.fit**.

```
/opt/gofitnow-backend            code
/opt/gofitnow-backend/.env       MONGODB_URI only (chmod 600)
gofitnow-backend.service         systemd, user `gofitnow` (no shell)
/etc/nginx/sites-available/backend.gofitnow.fit
```

Port and host live in **systemd**, not in `.env` — that keeps `.env` down to
the Mongo URL. Node listens on `127.0.0.1:3030`, so the port is unreachable
from the internet; nginx is what answers.

```bash
systemctl status gofitnow-backend      # state
journalctl -u gofitnow-backend -f      # logs
gofitnow-deploy                        # git pull + install + restart
gofitnow-deploy --status               # which commit is live
```

TLS from Let's Encrypt via `certbot --nginx`, renewed by `certbot.timer`. HTTP
redirects to HTTPS with a 301.

## Layout

```
app.js                 entry — wires Express, models, helpers and routes
appRoutes.js           controller map
appModels.js           model map  → app.api.*
appHelpers.js          helper map → app.helpers.*
defaultModules.js      moment, crypto, validator, uuid → app.*
config/mongodb.js      the single Mongo connection
database/schema.js     collections + indexes (idempotent, runs at boot)
database/init.js       standalone script (npm run db:init)
controllers/           HTTP routes
model/                 collection access
helper/                AuthSession, ReqProtected
```

## Collections

| Collection         | Holds                                          |
| ------------------ | ---------------------------------------------- |
| `users`            | every person: trainer or student               |
| `user_tokens`      | live sessions (30-day TTL on `expiresAt`)      |
| `workouts`         | a student's workouts (period, goal, teacher)   |
| `workout_sessions` | workout days, with exercises embedded          |
| `exercises`        | each trainer's exercise catalog                |

### The `users` document

```js
{
  name, email,
  password, salt,        // null while a student has no access yet
  type: "trainer" | "student",
  admin: true | false,   // a flag SEPARATE from type
  trainer: ObjectId,     // student only — the profile's owner
  phone, birthDate, goal, weight, height, notes,
  active, createdAt, updatedAt
}
```

**Roles**

- `type: "trainer"` — creates and sees their own students.
- `type: "student"` — only sees themself; `trainer` points to the owner.
- `admin: true` — sees the **Clients** menu and registers the platform's
  trainers. Orthogonal to type: an admin is usually a trainer too.

The password is SHA-512 of `salt + ":" + password`, with a per-user salt.
`password` and `salt` never leave the API — `hasAccess: boolean` goes instead.

The unique e-mail index is **partial** (`{ email: { $type: "string" } }`): a
student without access may have no e-mail, and without the filter the second
such student would collide with the first. An empty e-mail is stored as an
absent field, never as `""`.

## Authentication

Trainer and student sign in through the same route. Login returns `session`,
which the frontend sends in the `session` header on every authenticated route.

```
POST   /auth/register     { name, email, password }  → creates a plain TRAINER
POST   /auth              { email, password }        → { session, user }
GET    /auth/verify                                  → { user }
POST   /auth/logout
PUT    /auth/password     { currentPassword, newPassword } → { session }
```

`/auth/register` never creates an admin or a student: admin is granted by
another admin at `/clients`, and a student is created by their trainer at
`/students`.

## Endpoints

```
GET    /                                API name and version
GET    /health                          API + Mongo ping

GET    /me                              own user (a student also gets
PUT    /me         { name, email }      `trainerInfo`)

# --- admin only ---
GET    /clients           ?search=&active=     platform trainers
GET    /clients/summary
GET    /clients/:id
POST   /clients           { name, email, password, phone, admin, active }
PUT    /clients/:id
DELETE /clients/:id

# --- trainer only ---
GET    /students          ?search=&active=
GET    /students/summary
GET    /students/:id
POST   /students          { name, email, password?, phone, birthDate,
                            goal, weight, height, notes, active }
PUT    /students/:id
DELETE /students/:id/access             revokes the login, keeps the profile
DELETE /students/:id

GET    /students/:studentId/workouts    { rows, counts } — counts feeds the
POST   /students/:studentId/workouts      Current/Past/Future/All tabs
GET    /workouts/:id                    workout + sessions
PUT    /workouts/:id
DELETE /workouts/:id                    takes its sessions with it
POST   /workouts/:id/duplicate          { studentId? } copies with sessions

POST   /workouts/:id/sessions           { name, calories? }
GET    /sessions/:id
PUT    /sessions/:id
DELETE /sessions/:id
PUT    /sessions/:id/exercises          { exercises: [...] } saves the whole list

GET    /exercises         ?search=&group=&page=&limit=
GET    /exercises/groups                muscle groups in use
POST   /exercises         { name, muscleGroup, videoUrl, defaultTip }
GET    /exercises/:id
PUT    /exercises/:id
DELETE /exercises/:id
```

A student's `password` is optional: without it the profile exists but cannot
log in. With it, the e-mail becomes required — that is how they sign in.

### Workouts and sessions

`workouts` holds the workout; `workout_sessions` holds each day with the
**exercises embedded** in the document. A session has ~10 exercises and they
are never read without it — a separate collection would only add a join per
screen.

Each set carries `unit`, `quantity`, `load`, `intensity`, `speed` and `rest`.

Status (`current` / `past` / `future`) is derived from the period against
today, comparing `YYYY-MM-DD` — a workout ending today stays current all day.

### Exercise catalog

Each trainer builds their own; there is no third-party library. `muscleGroup`
is free text and the filter lists the distinct values that trainer has used, so
the taxonomy grows from usage.

`nameSort` (name trimmed, lowercased, unaccented) is what sorts and what search
queries — Mongo's binary sort would push capitalized names to the front, and
"gluteo" would not find "glúteo".

Deleting from the catalog does **not** touch assembled workouts: the session
copies the name and thumbnail, so it stays readable without the source
exercise.

## Guards

The frontend menu hides; the backend refuses. Every route goes through
`app.helpers.ReqProtected`:

| Method           | Who passes           | Who is blocked |
| ---------------- | -------------------- | -------------- |
| `verify`         | any signed-in user   | 401 without a session |
| `verifyTrainer`  | `type === "trainer"` | 403            |
| `verifyAdmin`    | `admin === true`     | 403            |

Rules the backend enforces on its own:

- A student is always scoped to the session's trainer — the owner id never
  comes from the body or the query.
- The last active admin cannot be demoted, deactivated or deleted.
- Nobody deletes their own account from the Clients menu.
- A trainer with students attached is not deleted (it would orphan the
  profiles) — deactivate them or move the students first.
