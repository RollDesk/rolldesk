# RollDesk

**RollDesk is a self-hostable web app for planning, tracking, and coordinating software deployments ("rollouts") to client projects across test and production environments.**

It gives everyone involved in a release — the release manager, the person doing the deployment, and the client — a single shared view of *what* is being deployed, *when*, *to which targets*, and its *current status*. Instead of spreadsheets and chat messages, a deployment lives as one record with a schedule, a status, an assignee, client sign-off, and an audit trail.

The whole thing ships as a small, runnable package: a static UI + an Express API + PostgreSQL, all in Docker, with IP-based access control and ready-to-use CI/CD.

> **Status:** early / functional prototype. The infrastructure, API, database, authentication, and CI/CD are real; the UI is still a rich single-file app (see [Project status](#project-status)).

---

## Table of contents

- [What problem it solves](#what-problem-it-solves)
- [Core concepts](#core-concepts)
- [Roles & features](#roles--features)
- [Architecture](#architecture)
- [Architecture assumptions](ARCHITECTURE.md) — reusable checklist of adopted design decisions
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started (local development)](#getting-started-local-development)
- [Configuration](#configuration)
- [Database: migrations & seeding](#database-migrations--seeding)
- [HTTP API](#http-api)
- [Authentication](#authentication)
- [Tests](#tests)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Project status](#project-status)
- [License](#license)

---

## What problem it solves

Rolling out software to a client is rarely a single "deploy" button. A release often means:

- pushing several applications, at different versions,
- first to one or more **test** environments, then to **production**,
- where production may be **many locations/targets** (e.g. dozens of sites), rolled out over several days,
- with a **client** who needs to see and approve the plan,
- and a clear record of who did what, when, and whether it succeeded or was rolled back.

RollDesk models exactly that: a **deployment** carries its schedule, target list, status, assignee, client notes/approval, results, and comments — visible to the right people, with notifications and a change history.

---

## Core concepts

| Term | Meaning |
|------|---------|
| **Client** | An organisation RollDesk delivers to. Has one or more projects (e.g. `acme`, `globex`). |
| **Project** | A deliverable belonging to a client (e.g. `acme:core`). Defines its **applications**, **test environments**, and default scheduling (days/time). |
| **Application** | A deployable unit within a project (a service/repo), with tracked deployed versions. |
| **Deployment target** | A destination a project deploys to — a non-production (test) environment or a named production location. |
| **Release package** | What the test team hands over: the application versions tested together, one description of the changes that go out, and the list of issues they fix as identifiers only (Azure work item, the HaloITSM ticket from its "SM Problem" field, and the office that reported it). Every deployment is planned from a package — it never restates its own versions or changelog. |
| **Deployment** | One rollout record: which project/apps/versions, to which environment(s), on what schedule, its status, assignee, client approval, and results. |
| **Status** | Lifecycle of a deployment: `scheduled` → `installed`, or `failed` / `rolledback` / `aborted`; a rollout can also be `paused`. |
| **Mode** | A deployment is either a **test-only** install (installed once, manually) or a **batch** rollout (spread across many production targets over several days). |

### From a release package to a rollout

A deployment is always planned **from a package** — picking one is the first field of the form and there is no manual path for typing applications and versions by hand, so what is installed is what was tested. The package fills the read-only application list (warning where a version is older than or equal to what production already runs) and the changelog.

Each fixed issue on a package is **identifiers only**: the Azure Boards work item the testers file, the HaloITSM ticket named in that work item's `SM Problem` field, and — when it is known — the office that reported it. What the release actually changes is described **once for the whole package**, in its own section, rather than a line per issue. Both ids are shown to the deployer during the rollout, linked through `ISSUE_TRACKER_URL` / `WORKITEM_URL` when those are configured.

The **deployer instructions and the changelog files also belong to the package**, not to the deployment: they describe the build, so they are written once and every rollout of that build shows the same thing — including the ones planned after a correction. A deployment displays them read-only with a link to the package for whoever may edit it, and keeps only its own changelog *text*, because a release manager may still adjust what one client is sent. Files are uploaded under the audience they are for: a changelog file is client-facing, an instruction file is not, and a file whose kind cannot be read falls to the narrower audience (`visiblePackageFiles` in `backend/src/releasePackage.js`).

The reported offices drive the **rollout order**: `prioritizeReportingTargets` (in `backend/src/releasePackage.js`, mirrored in the UI) moves the production targets named on the package's issues to the front of the generated schedule, matching either a target's code or its label, case-insensitively. The office waiting for the fix should not be the last one to receive it.

### Configuring the work-item lookup

Typing a work item id on a package can fill the HaloITSM ticket and the reporting office in by itself. What it takes to do that is **per project and entered by an administrator** in the project editor, not in the environment — the organisation, the project inside it, the field the ticket id sits in and the service desk's own host all differ per installation, and one RollDesk instance serves several clients:

| Setting | Example | Notes |
|---|---|---|
| Work tracker organisation URL | `https://dev.azure.com/org` | Must be `https://`. |
| Work tracker project | `PiK` | The project inside that organisation. |
| Ticket field | `Custom.SMProblem` | The work item field carrying the service-desk ticket. Blank falls back to the common reference name. |
| Personal access token | — | Encrypted at rest and never returned to the browser; an empty box leaves the stored value unchanged. Read-only work-item scope is enough. |
| Service desk URL | `https://haloitsm.example.com` | Must be `https://`. |
| Ticket path | `/api/Tickets/{id}` | Must start with `/` and contain `{id}`. |
| Office field | *(blank)* | Which ticket field names the reporting office. Blank tries the usual keys. |
| API key | — | Same handling as the PAT. |

The two halves are **independent and both optional**. With only the work tracker configured, an id resolves to its ticket number but no office; with neither, the fields stay manual and nothing else changes. `ISSUE_TRACKER_URL` and `WORKITEM_URL` are separate from all of this — they only turn ids already on a package into links, and are environment-wide because they describe where the reader's browser should go, not what the backend queries.

---

## Roles & features

The UI is organised around the people involved in a release:

- **Release Manager** — defines projects (apps, targets, post-deployment notifications), schedules new deployments, and monitors the deployments board.
- **Tester** — assembles release packages for the projects they were granted: the application versions tested together, what the release changes, and the ids of the issues it fixes. No access to schedules, targets or client decisions.
- **Deployer** — a focused panel to carry out the assigned installs and report results.
- **Client** — a read-oriented view of the schedule and status for the projects they can see, with approval/notes.
- **Administrator** — manages users, clients, notification rules (email/Teams), and reviews the change history (audit log).
- **Account** — profile, help, and sign-out.

Cross-cutting features: release packages handed over from testing to release management, a rollout order that puts the offices which reported the fixed issues first, schedule shifting mid-rollout, pause/resume with a reason, per-event notifications, an append-only audit trail, and IP-restricted access.

---

## Architecture

Adopted design decisions (for reuse on similar apps) are listed in [ARCHITECTURE.md](ARCHITECTURE.md).

```mermaid
flowchart LR
    U[Browser] -->|HTTP :8080| N

    subgraph Docker
      N[frontend: nginx<br/>static UI + IP allowlist + /api proxy]
      B[backend: Express API<br/>IP allowlist + migrations on start]
      D[(PostgreSQL<br/>db-data volume)]
      A[clamav: clamd<br/>virus scanning]
      N -->|/api, /health| B
      B --> D
      B -->|INSTREAM scan| A
    end
```

- **frontend** — an nginx container that serves the single-page UI (`frontend/app/index.html`), proxies `/api` and `/health` to the backend, and enforces an IP allowlist built from `ALLOWED_IPS`.
- **backend** — an Express API that persists data to PostgreSQL, runs database migrations on startup, applies a second IP-allowlist layer, virus-scans uploaded attachments via ClamAV, and can send email notifications via SMTP.
- **db** — PostgreSQL. Deployments and projects are stored with filterable columns plus a `JSONB` `data` column holding the full object, so the UI can evolve its shape without constant migrations. Uploaded files are kept in an `attachments` table.
- **clamav** — a ClamAV (clamd) container that scans uploaded attachments before they are stored.

**Backend required:** the UI is served by nginx and always talks to the backend. On startup it authenticates against the API (first-run setup wizard, then password + TOTP MFA) and loads all data from PostgreSQL. There is no offline/demo mode — if the backend is unavailable the login screen reports it and the app stays locked until the API is reachable.

---

## Tech stack

- **Frontend:** a single self-contained `index.html` (vanilla HTML/CSS/JS, no build step), served by **nginx**.
- **Backend:** **Node.js 20**, **Express 4**, **pg**, **nodemailer**, **multer** (file uploads), **ipaddr.js** (ES modules).
- **Database:** **PostgreSQL 18**.
- **Infra/CI:** **Docker** + **Docker Compose**, **GitHub Actions**, images published to **GHCR**.
- **Tests:** Node's built-in `node:test` runner (zero extra dependencies).

---

## Repository layout

```
rolldesk/
├── docker-compose.yml            # local/dev stack: frontend + backend + postgres (builds images)
├── docker-compose.prod.yml       # production stack: runs pre-built images from a registry
├── .env.example                  # configuration template (copy to .env)
├── .github/workflows/
│   └── deploy.yml                # test → build & publish images to GHCR (versioned on git tags)
├── frontend/                     # nginx serving the UI + /api proxy + IP allowlist
│   ├── Dockerfile
│   ├── nginx.conf.template
│   ├── docker-entrypoint.sh      # builds the "allow" list from ALLOWED_IPS
│   └── app/index.html            # the entire application UI
└── backend/                      # Express + PostgreSQL + IP allowlist
    ├── Dockerfile
    ├── package.json
    ├── src/
    │   ├── index.js              # app entrypoint (runs migrations, then listens)
    │   ├── config.js             # env-driven configuration
    │   ├── db.js                 # pg pool
    │   ├── ipAllowlist.js        # IP/CIDR access control (pure helpers + middleware)
    │   ├── migrate.js            # migration runner (also a CLI)
    │   ├── seed.js               # local test-data loader (also a CLI)
    │   ├── mailer.js             # SMTP notifications
    │   ├── routes/               # deployments, projects, health
    │   ├── migrations/           # versioned schema SQL (committed)
    │   └── seeds/                # local.sql.example (committed) + local.sql (git-ignored)
    └── test/                     # unit tests (node:test)
```

---

## Getting started (local development)

### Run the full stack with Docker (recommended)

```bash
cp .env.example .env
# set at least POSTGRES_PASSWORD; leave ALLOWED_IPS empty for local use
docker compose up --build
```

- UI: `http://localhost:8080`
- API: `http://localhost:8080/api/deployments`
- Health: `http://localhost:8080/health`

Migrations run automatically on backend start. To load sample data, see [seeding](#local-test-data-not-committed).

**First run:** there is no default user. The first time you open the UI you're shown a **setup wizard** to create the administrator account. On that account's first login you must **enroll TOTP MFA** (scan the QR code with an authenticator app); every later login then requires the 6-digit code. See [Authentication](#authentication).

### Run the backend on its own (fast iteration)

You need a PostgreSQL reachable via `DATABASE_URL`.

```bash
cd backend
npm install
export DATABASE_URL=postgres://rolldesk:rolldesk@localhost:5432/rolldesk
npm run migrate   # apply schema
npm run seed      # optional: load backend/src/seeds/local.sql
npm start         # http://localhost:3000
```

The frontend is a static file, but it needs the backend to authenticate and load data. For UI work, run the backend (or the full `docker compose` stack) and open the app through nginx rather than opening the file directly.

---

## Configuration

All configuration comes from environment variables (see `.env.example`). Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HTTP_PORT` | `8080` | Host port the frontend (nginx) listens on. |
| `ALLOWED_IPS` | *(empty)* | Comma/space-separated IPs and CIDR ranges allowed to reach the UI + API. Empty = no restriction (**dev only**). |
| `APP_BASE_URL` | *(empty)* | Public URL where the app is reachable (e.g. `https://rolldesk.example.com`). When set, outgoing notifications (webhooks / e-mail / Teams) turn the deployment id into a link that opens that deployment (`<APP_BASE_URL>/#deployments/<id>`); a notification with no deployment gets a link to the app instead. **Required for SSO** (used to build the OIDC redirect URI). |
| `APP_TIMEZONE` | `Europe/Warsaw` (in compose) | IANA zone for the timestamps the backend writes on deployment timelines and in the change history. The container image has no zone of its own, so without this those entries are stamped in UTC while the ones the browser writes use the viewer's local time — two hours apart in Polish summer, on the same timeline. An unknown zone falls back to the runtime's with a warning. |
| `NOTIFY_LANG` | `pl` (in compose) | Language outgoing notifications (e-mail, Slack, Teams, webhooks) are written in — `pl` or `en`. A notification is composed in the browser of whoever triggered the event, so leaving this empty means it inherits *that person's* UI language, and the UI defaults to English: the same client could be told about one deployment in English and the next in Polish. Anything other than `pl`/`en` is ignored with a warning. |
| `ISSUE_TRACKER_URL` | *(empty)* | URL pattern of the service desk the fixed issues are reported in, used to turn the HaloITSM ticket ids on a release package into links (also for the client, who sees what a rollout closes). `{id}` marks where the ticket id goes — e.g. `https://haloitsm.example.com/tickets?id={id}` — because trackers differ in where the id belongs and the ids are stored exactly as they were typed. A value without `{id}` is ignored with a warning; empty means the ids stay plain text. |
| `WORKITEM_URL` | *(empty)* | The same, for the Azure Boards work item the testers file the fix under — e.g. `https://dev.azure.com/org/project/_workitems/edit/{id}`. Independent of `ISSUE_TRACKER_URL`: configuring one and not the other is a normal setup. |
| `SSO_ENC_KEY` | *(derived from `JWT_SECRET`)* | Key used to encrypt stored SSO/OIDC client secrets at rest (AES-256-GCM). Set a dedicated random value in production (`openssl rand -hex 32`). See [Single sign-on (SSO)](#single-sign-on-sso). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `rolldesk` | Database credentials. |
| `DATABASE_URL` | *(built from the above)* | Backend connection string. |
| `JWT_SECRET` | *(dev: ephemeral)* | Secret used to sign session tokens. **Required in production** — the backend refuses to start without it. Generate with `openssl rand -hex 32`. In dev, if unset, an ephemeral secret is used (sessions reset on restart). |
| `SESSION_TTL` / `MFA_STAGE_TTL` | `30d` / `10m` | Lifetime of a session token, and of the short-lived token carried between login and the MFA step. A session token carries no server-side state and **cannot be revoked**: it stays valid for its full lifetime, so archiving an account ends its *next* login, not a session already in progress. Lower this where that matters more than signing in again. |
| `MFA_ISSUER` | `RollDesk` | Label shown for the account in the user's authenticator app. |
| `TRUST_PROXY` | `1` (in compose) | Trust `X-Forwarded-For` for the real client IP behind a proxy. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | *(empty)* | SMTP for email notifications; if `SMTP_HOST` is unset, sending is skipped. |
| `GRAPH_ENABLED` | `0` | Feature flag for posting Teams notifications via Graph. Off by default — RollDesk uses per-client webhooks. Set to `1` only after the Entra app has the required Graph application permissions + admin consent. Diagnostics (`/api/teams/graph/*`) work regardless. |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | *(empty)* | Microsoft Graph app (Entra ID) used to post threaded Teams notifications. Leave empty to use per-client webhooks instead. See [Microsoft Teams notifications](#microsoft-teams-notifications-microsoft-graph). |
| `TEAMS_TEAM_ID` / `TEAMS_CHANNEL_ID` | *(empty)* | Target Teams team + channel for Graph notifications. Discover them via `GET /api/teams/graph/teams` and `/channels?teamId=…` (admin). |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `clamav` / `3310` | clamd host/port for virus-scanning uploads. Compose points these at the bundled `clamav` container; leave `CLAMAV_HOST` empty to disable scanning. |
| `CLAMAV_FAIL_MODE` | `reject` | When the scanner is unreachable: `reject` (block the upload — fail closed) or `allow` (accept unscanned — fail open). |
| `IMAGE_PREFIX` / `TAG` | — | Used by `docker-compose.prod.yml` to pick which registry images/version to run. |

### Restricting access by IP

```
ALLOWED_IPS=203.0.113.4, 198.51.100.0/24, 10.8.0.0/24
```

Filtering runs at **nginx** (whole UI + API) and again in the **backend**. IPv4/IPv6 single addresses and CIDR ranges are supported. Typically you allow your office's public IP and the team VPN subnet.

### Virus scanning of uploads

Uploaded attachments are streamed to a **ClamAV** container (`clamav`, speaking clamd's INSTREAM protocol) before they are stored. An infected file is rejected with `422` and never written to the database. On first start ClamAV downloads its signature database (a few minutes); the signatures are cached in the `clamav-data` volume. If the scanner is unreachable, `CLAMAV_FAIL_MODE` decides whether uploads are blocked (`reject`, default) or accepted unscanned (`allow`). Set `CLAMAV_HOST=` (empty) to turn scanning off entirely.

> The official `clamav/clamav` image is amd64-only; the dev compose pins `platform: linux/amd64` so it also runs on Apple Silicon via emulation.

---

## Database: migrations & seeding

The backend includes a small, dependency-free **migration runner** (`backend/src/migrate.js`). Versioned SQL files in `backend/src/migrations/` are applied **in filename order, exactly once**, tracked in a `schema_migrations` table.

- Migrations run **automatically when the backend starts**, before it accepts traffic — so schema changes ship with your code.
- Each migration runs in its own transaction and rolls back on failure (the backend then exits non-zero rather than serving a half-migrated schema).
- Run them manually with `npm run migrate` (uses `DATABASE_URL`).

### Adding a migration

Create a new file in `backend/src/migrations/` with the zero-padded prefix convention, e.g. `002_add_column.sql`. Keep it idempotent where practical (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). It's applied on the next backend start or `npm run migrate`.

### Local test data (not committed)

`001_init.sql` creates **schema only** — no client/project data is committed. Sample data lives in local, uncommitted files so nothing real ever lands in the repo:

- `backend/src/seeds/local.sql` — your local test data. **Git-ignored** and excluded from Docker images.
- `backend/src/seeds/local.sql.example` — a committed, generic template.

```bash
cp backend/src/seeds/local.sql.example backend/src/seeds/local.sql   # then edit
cd backend && npm run seed            # loads local.sql (skips silently if absent)
# or against the running stack:
docker compose exec backend npm run seed
```

The dev `docker-compose.yml` mounts `backend/src/seeds` into the backend container so the git-ignored file is available at runtime.

### Using an external / managed database

By default the stack runs its own PostgreSQL container (`db`) and the backend connects to it. To point RollDesk at an **external database** instead (e.g. Amazon RDS, Cloud SQL, Azure Database, or an existing on-prem PostgreSQL), override `DATABASE_URL` and don't start the bundled `db` service:

1. **Set `DATABASE_URL`** to your server's connection string. It takes precedence over the per-part `POSTGRES_*` values:

```bash
# .env
DATABASE_URL=postgres://USER:PASSWORD@db.example.com:5432/rolldesk?sslmode=require
```

   Include `?sslmode=require` (or stricter) for managed providers that enforce TLS. The database/user must already exist; the backend creates the tables itself by running the migrations on startup.

2. **Start only the services you need** (skip the local `db`):

```bash
# dev compose (build local images)
docker compose up -d --build backend frontend clamav
# or production compose (pre-built images)
docker compose -f docker-compose.prod.yml up -d backend frontend clamav
```

Because migrations run automatically on backend start, the external database is provisioned on first launch — no manual step required (you can still run `npm run migrate` manually against `DATABASE_URL` if you prefer). The bundled `db` service and its `db-data` volume are simply left unused; you can delete the `db` block from your compose file if you never want it.

### Using an external ClamAV

The same idea applies to virus scanning: the `clamav` container is a convenience, not a requirement. To use a **shared/managed ClamAV (clamd)** instead, point the backend at it and skip the bundled container:

```bash
# .env
CLAMAV_HOST=clamav.internal.example.com
CLAMAV_PORT=3310
```

Then start the stack without the `clamav` service (e.g. `docker compose up -d backend frontend`, plus `db` if you use the bundled database). Set `CLAMAV_HOST=` (empty) to disable scanning altogether. See [Virus scanning of uploads](#virus-scanning-of-uploads) for the fail-open/fail-closed behaviour (`CLAMAV_FAIL_MODE`).

### Microsoft Teams notifications (Microsoft Graph)

RollDesk can post deployment notifications straight into a **Microsoft Teams channel**, grouped **per deployment**: the first event for a deployment starts a message and every later event (approval request, schedule created, per-day report, completion) is posted as a **reply in that thread**. This is optional and **off by default** (`GRAPH_ENABLED=0`) — while the flag is off, RollDesk uses the per-client Incoming Webhooks as before. Flip `GRAPH_ENABLED=1` once the Entra app has the right permissions.

Setup:

1. Register an app in **Entra ID** (Azure AD) and create a **client secret**.
2. Grant it Microsoft Graph **application** permissions (minimal for one channel: `Team.ReadBasic.All`, `Channel.ReadBasic.All`, and for posting `ChannelMessage.Send` — then **Grant admin consent**). See the curl checklist below the env block.
3. Put the values in `.env` (never commit them):

```bash
# .env
GRAPH_ENABLED=0            # keep 0 until permissions work; then set to 1
GRAPH_TENANT_ID=...        # directory (tenant) id
GRAPH_CLIENT_ID=...        # application (client) id
GRAPH_CLIENT_SECRET=...    # client secret value
TEAMS_TEAM_ID=...          # target team
TEAMS_CHANNEL_ID=...       # target channel
```

4. If you don't know the team/channel ids, start the app and call (as an admin): `GET /api/teams/graph/teams` and `GET /api/teams/graph/channels?teamId=<id>`. `GET /api/teams/graph/status` reports whether the integration is enabled/configured, the token is obtainable, and posting is possible.

> **Important:** Microsoft restricts sending channel messages with **application (app-only)** permissions. If your tenant blocks it, keep `GRAPH_ENABLED=0` and use webhooks; Graph diagnostics still work for listing teams/channels. Rotate the client secret in Entra ID after setup if it was shared during configuration.

---

## HTTP API

All endpoints are under `/api` (IP-filtered). `/health` is unfiltered for monitoring. The `/api/deployments` and `/api/projects` routes require a valid session token (`Authorization: Bearer <token>`); the `/api/auth` routes issue those tokens (see [Authentication](#authentication)).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/status` | — | Whether an admin account exists yet (`{ configured }`). |
| POST | `/api/auth/setup` | — | Create the first admin. `409` once configured. |
| POST | `/api/auth/login` | — | Verify password; returns a stage token (`mfa-setup` or `mfa-login`). |
| POST | `/api/auth/mfa/setup` | stage | Start MFA enrollment; returns `otpauthUrl` + QR data URL. |
| POST | `/api/auth/mfa/verify` | stage | Verify the first code, enable MFA, return a session token. |
| POST | `/api/auth/mfa/login` | stage | Verify a code for an enrolled user, return a session token. |
| GET | `/api/auth/me` | session | Current user (`{ id, email, role }`). |
| GET | `/api/deployments` | session | List (filters: `project`, `env`, `status`). |
| GET | `/api/deployments/:id` | session | Details of one deployment. |
| POST | `/api/deployments` | session (admin/rm/deployer) | Create (id from body or generated). |
| PUT | `/api/deployments/:id` | session (admin/rm/deployer) | Create or update the full object (used by the UI). |
| PATCH | `/api/deployments/:id` | session (admin/rm/deployer) | Change individual fields, leaving the rest of the stored object alone (see [Partial updates](#partial-updates-patch)). |
| DELETE | `/api/deployments/:id` | session (admin/rm/deployer) | Delete (cascades to its attachments). |
| POST | `/api/deployments/:id/attachments` | session | Upload a file (`multipart/form-data`, field `file`); returns its metadata. |
| GET | `/api/deployments/:id/attachments` | session | List a deployment's attachment metadata (no bytes). |
| GET | `/api/attachments/:id` | session | Download the stored file bytes. |
| DELETE | `/api/attachments/:id` | session | Delete a single attachment. |
| GET | `/api/projects` | session | List projects (with default days/time and apps). |
| PUT | `/api/projects/:key` | session (admin/rm/deployer) | Create or update a project. |
| GET | `/api/packages` | session | Release packages (filters: `project`, `status`). Scoped to the caller's projects; clients only see `ready` ones. |
| GET | `/api/packages/:id` | session | One release package. `404` when it is out of the caller's scope. |
| POST | `/api/packages` | session (admin/rm/tester) | Create a package (id generated, e.g. `PKG-2026-0007`). |
| PUT | `/api/packages/:id` | session (admin/rm/tester) | Replace a package. |
| DELETE | `/api/packages/:id` | session (admin/rm/tester) | Delete a package. `409`, naming the deployments, when one still refers to it. |
| GET | `/api/audit` | session | Change-history entries, newest first. |
| POST | `/api/audit` | session | Append one change-history entry. |
| GET | `/api/state/:key` | session | Read a shared collection (`roster`, `clients`, `notifications`). |
| PUT | `/api/state/:key` | session | Replace a shared collection (last-write-wins). |
| POST | `/api/notifications/test` | session | Send a test message to a Teams webhook (`{channel:'teams', url}`) or e-mail (`{channel:'email', address}`). |
| GET | `/api/teams/graph/status` | session | Whether the Microsoft Graph / Teams integration is configured, a token is obtainable, and posting is possible. |
| GET | `/api/teams/graph/teams` | admin | List Teams teams visible to the app (to discover `TEAMS_TEAM_ID`). |
| GET | `/api/teams/graph/channels?teamId=…` | admin | List a team's channels (to discover `TEAMS_CHANNEL_ID`). |
| GET | `/api/users/assignable` | session (non-client) | Minimal roster of active deployers for the "assign deployer" dropdown. |
| GET | `/health` | — | Liveness + DB reachability. |

Deployment statuses: `scheduled`, `installed`, `failed`, `rolledback`, `aborted`. A paused distribution is *not* a status — it is the separate boolean `paused` field (with `pauseReason`) on the deployment, so a paused rollout keeps the status it had.

### Partial updates (PATCH)

`PUT` replaces the **whole** stored object. That suits the UI, which always holds the full deployment in memory, but it makes automation risky: a script that only wants to flip a status has to `GET`, mutate and `PUT` the entire record back, and one serialization slip on the way silently drops the schedule, comments or counts. `PATCH` merges instead — send only the fields you want to change:

```bash
curl -X PATCH http://localhost:8080/api/deployments/DEP-2026-0032 \
  -H "Authorization: Bearer rd_live_…" \
  -H "Content-Type: application/json" \
  -d '{"status":"installed"}'
```

In PowerShell, note that `curl` is an alias for `Invoke-WebRequest`, which does not understand `-H`/`-d`. Call `curl.exe` explicitly, or use the native cmdlet:

```powershell
$h = @{ Authorization = "Bearer rd_live_…" }
Invoke-RestMethod -Method Patch -Uri "http://localhost:8080/api/deployments/DEP-2026-0032" `
  -Headers $h -ContentType "application/json" -Body '{"status":"installed"}'
```

#### Which fields to send

A PATCH body uses the field names as they are stored on the deployment. `GET /api/deployments/:id` returns the whole stored object, so it is the authoritative list for a given record — you never have to guess. The ones a script sets most often:

| Field | Type | Meaning |
|---|---|---|
| `status` | text | Status of a **single-target** deployment: `scheduled`, `installed`, `failed`, `rolledback`, `aborted`. |
| `counts` | object | Progress of a **multi-target** rollout: `{installed, scheduled}`. The progress bar is derived from this, not from `status`. |
| `paused` | boolean | Pause the distribution (with `pauseReason`). A pause is not a status — the deployment keeps the one it had. |
| `date` / `time` | `YYYY-MM-DD` / `HH:MM` | When a single-target deployment runs. |
| `installerNotes` | text | Instructions shown to the deployer in their panel. |
| `changelog` | text | Release description, shown on the deployment and in notifications. |
| `assignedTo` | text | The deployer assigned to carry it out. |
| `env` | text | `Production`, or one of the project's test environment names. |

#### Multi-target ("batch") rollouts

A deployment with `mode: "batch"` spreads many targets over working days and **does not display a `status`**: the UI treats it as complete when nothing is left to do, i.e. when `counts.scheduled` reaches `0`. Patching `{"status":"installed"}` on such a record therefore used to store a field nothing reads — the change appeared on the timeline and in the history while the row still showed `312/400, in progress`.

Since that is plainly what the caller meant, a PATCH setting `status` to `installed` on a batch record now also **closes the rollout**: everything still in `counts.scheduled` moves to `counts.installed`, and `failedLocations`/`pendingQueue` are emptied — exactly what the UI's "mark the rest as installed" button does. The timeline entry names the progress that moved (`counts 312/400 → 400/400`), not just the status.

To report *partial* progress, send the counts instead:

```powershell
$h = @{ Authorization = "Bearer rd_live_…" }
# 312 of 400 targets installed, 88 left
Invoke-RestMethod -Method Patch -Uri "http://localhost:8080/api/deployments/DEP-2026-0047" `
  -Headers $h -ContentType "application/json" `
  -Body '{"counts":{"installed":312,"scheduled":88}}'
```

Behaviour:

- **The merge is shallow.** A key in the body replaces that key's whole value — `{"counts":{"scheduled":0}}` replaces `counts`, it does not merge into it (so send both halves of `counts`). Keys you don't send are left untouched. `null` clears a field.
- **It will not create a deployment.** Patching an unknown id is a `404`, not an upsert (use `PUT`/`POST` to create).
- **`status` is validated** against the list above; an unknown value is a `422` rather than a stored string the UI can't render.
- **`projectKey` cannot be changed** — moving a deployment to another project changes who may read it, which is a different operation. `422`; use `PUT`.
- **It is idempotent.** A patch that changes nothing returns `200` with the stored object and writes no history entry.
- **The change is recorded server-side** on the deployment's timeline and in the change history (actor = the token owner's e-mail), because an API caller has no UI to do it. The stamp is written in `APP_TIMEZONE` (see [Configuration](#configuration)) so it lines up with the entries the browser writes.
- **Client accounts are rejected** (`403`), as with every other write.

#### A ready-made script

`examples/Update-RollDeskDeployment.ps1` wraps all of the above for the cases an
installation script actually needs, so a rollout script does not have to encode
the single-vs-batch rules itself. It reads the deployment first and sends the
field that applies to that record, then reports what RollDesk stored.

```powershell
$env:RD_TOKEN = 'rd_live_…'   # keep the token out of the command line

# Progress of a rollout: 312 of 400 done
.\examples\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
    -Id DEP-2026-0047 -Installed 312 -Remaining 88

# The last targets are done — close the rollout
.\examples\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
    -Id DEP-2026-0047 -Complete

# A single-target deployment failed
.\examples\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
    -Id DEP-2026-0051 -Status failed

# Pause with a reason
.\examples\Update-RollDeskDeployment.ps1 -BaseUrl https://rolldesk.example.com `
    -Id DEP-2026-0047 -Pause -Reason "Client asked to hold until Monday"
```

Also accepts `-Notes`, `-Changelog`, `-AssignedTo`, `-Resume`, and `-WhatIf` to
print the request without sending it. `Get-Help .\examples\Update-RollDeskDeployment.ps1 -Full`
documents every parameter. Works on Windows PowerShell 5.1 and PowerShell 7+.

---

## Authentication

RollDesk ships with **no default account** and stays locked until one is created.

1. **First run — setup wizard.** `GET /api/auth/status` reports `configured: false`, so the UI shows a wizard to create the initial admin (`POST /api/auth/setup`). Passwords are hashed with bcrypt.
2. **Login.** `POST /api/auth/login` verifies the password and returns a short-lived *stage* token indicating the next step.
3. **Mandatory MFA.** On the admin's first login, MFA enrollment is forced: the UI shows a QR code (from `POST /api/auth/mfa/setup`) to scan with an authenticator app, and `POST /api/auth/mfa/verify` confirms the first code and enables MFA. Later logins require the 6-digit code via `POST /api/auth/mfa/login`.
4. **Session.** A successful MFA step returns a session JWT (signed with `JWT_SECRET`, `SESSION_TTL` lifetime — 30 days by default). The UI stores it in `localStorage` and sends it as `Authorization: Bearer` on every `/api` call. A `401` clears the token and returns to the login screen. The token is self-contained: there is no server-side session list, so it cannot be revoked before it expires — archiving an account blocks the next login, not a session already open. Logging out discards the browser's copy.

TOTP MFA uses [`otplib`](https://www.npmjs.com/package/otplib); QR codes are rendered with [`qrcode`](https://www.npmjs.com/package/qrcode); tokens use [`jsonwebtoken`](https://www.npmjs.com/package/jsonwebtoken).

### Single sign-on (SSO)

An administrator can enable **OpenID Connect single sign-on per e-mail domain** (Administrator → Single sign-on). When a domain has an enabled provider, its users sign in through their identity provider instead of a password. SSO is provider-agnostic and built on [`openid-client`](https://www.npmjs.com/package/openid-client):

- **Microsoft Entra ID / Azure AD** — enter the *Tenant (Directory) ID*; the issuer is derived automatically.
- **Google** — no extra fields; the Google issuer is used.
- **Other (generic OIDC)** — paste the provider's issuer / discovery URL.

Key behaviour:

- **No just-in-time provisioning.** The signing-in e-mail must already match an account created by an admin (Users screen); unknown or archived accounts are rejected. MFA is handled by the identity provider, so RollDesk does not additionally enforce its own TOTP for SSO logins.
- **Enforced per domain, with an admin fallback.** For a domain with SSO enabled, password login is disabled for everyone except local `admin` users — a break-glass fallback so a misconfigured IdP can't lock the whole domain out.
- **Setup.** Set `APP_BASE_URL` (used to build the redirect URI) and, in production, a dedicated `SSO_ENC_KEY`. In the identity provider, register a **Web** application and add the redirect URI shown in the SSO form: `<APP_BASE_URL>/api/auth/sso/callback`. Then add the domain in RollDesk with the client ID and client secret (the secret is stored encrypted and never returned to the browser). Use **Test** to validate the issuer via OIDC discovery.

The OIDC flow is Authorization Code + PKCE. The client secret is encrypted at rest (AES-256-GCM). The short-lived authorization state and the one-time session-handoff code are kept in memory, so — like the auth rate limiter — SSO expects a single backend instance (or sticky sessions).

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as RollDesk backend
    participant IdP as Identity provider
    B->>API: GET /api/auth/sso/start?email=user@domain
    API-->>B: 302 to IdP (PKCE + state + nonce)
    B->>IdP: authenticate (+ IdP MFA)
    IdP-->>B: 302 to /api/auth/sso/callback?code
    B->>API: callback -> exchange code, match user, mint session
    API-->>B: 302 to /#/sso/<one-time-code>
    B->>API: POST /api/auth/sso/exchange -> session JWT
```

---

## Tests

Backend unit tests use Node's built-in runner — no extra dependencies:

```bash
cd backend
npm install
npm test
```

They cover the IP allowlist (exact IPs, CIDR ranges, IPv4/IPv6, the `X-Forwarded-For` proxy path, 403 rejection), environment configuration parsing, and the migration runner's ordering/pending logic. CI runs them before building any image.

---

## Deployment

### Build & publish images (CI)

`.github/workflows/deploy.yml` runs the automated tests, then builds and pushes both Docker images to GHCR. **The pipeline ends at publishing the images — it does not deploy to a server.** `GITHUB_TOKEN` is provided automatically and is the only credential needed.

It triggers on pushes to `main`, on version tags, and manually (`workflow_dispatch`). Image tags produced:

| Trigger | Image tags |
|---------|-----------|
| push to `main` | `latest`, `<commit-sha>` |
| push tag `vX.Y.Z` | `latest`, `<commit-sha>`, `X.Y.Z` |

Cut a versioned image from a tag:

```bash
git tag v1.4.0 && git push origin v1.4.0
# produces ghcr.io/<owner>/<repo>-backend:1.4.0 and -frontend:1.4.0
```

### Deploying to a server (manual)

Deployment is decoupled from CI — run the published images on any Docker host that has a production `.env` (see `.env.example`) and `docker-compose.prod.yml`:

```bash
export IMAGE_PREFIX=ghcr.io/RollDesk/rolldesk
export TAG=1.4.0          # the version to run (or `latest`)
docker login ghcr.io
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Migrations are baked into the backend image and applied automatically on startup, so no extra steps are needed.

### HTTPS

Terminate TLS in front of the app (Caddy/Traefik/nginx with Let's Encrypt) forwarding to the frontend port. Keep IP restriction here (`ALLOWED_IPS`) or move it to the proxy/firewall.

---

## Contributing

Contributions are welcome — the repo is small and has no heavy toolchain. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide. In short:

1. Clone via SSH: `git clone git@github.com:RollDesk/rolldesk.git`
2. Branch off `main`: `git checkout -b feat/short-description` (or `fix/…`, `docs/…`).
3. Make your change and **run the backend tests** (`cd backend && npm test`).
4. Commit using **[Conventional Commits](https://www.conventionalcommits.org/)** and reference issues like `#123`.
5. Open a small, focused pull request describing the *why*.

Key rules: **no secrets or real client data in commits** (real data goes in the git-ignored `backend/src/seeds/local.sql`); English comments/UI text; ES-module, dependency-light backend; and **schema changes go in a new migration**, never edits to an existing one.

---

## Project status

**Ready:** Docker infrastructure, durable PostgreSQL with an automatic migration runner (schema-only migrations; sample data in local, uncommitted seeds), a persisting API, real authentication (first-run setup wizard, bcrypt password login, mandatory TOTP MFA, JWT sessions guarding the API, self-service password reset, and optional per-domain OpenID Connect SSO for Azure/Entra ID, Google or any OIDC provider), multi-user management (admin-invited accounts with a real set-password flow, roles, per-project access, archive/restore), personal access tokens for the automation API (`Authorization: Bearer rd_live_…`), IP restriction (nginx + backend), CI that tests/builds/deploys, and the served UI.

**Known limitations / next steps:**

- **SSO state is in-memory.** Single sign-on keeps its authorization state and one-time handoff codes in the backend process, so it expects a single instance (or sticky sessions) — the same constraint as the auth rate limiter.
- **Writes are "last write wins"** (no concurrency locks) — fine for a small team, to be hardened under load.
- **Project/app definitions** currently originate in the UI; moving them fully behind the `GET/PUT /api/projects` API is a natural next step.
- The **UI is one large `index.html`** — great for zero-build iteration, a candidate for componentisation as it grows.

---

## License

Released under the **[MIT License](LICENSE)** — see the [`LICENSE`](LICENSE) file for the full text.
