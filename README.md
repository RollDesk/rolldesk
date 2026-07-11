# RollDesk

**RollDesk is a self-hostable web app for planning, tracking, and coordinating software deployments ("rollouts") to client projects across test and production environments.**

It gives everyone involved in a release — the release manager, the person doing the deployment, and the client — a single shared view of *what* is being deployed, *when*, *to which targets*, and its *current status*. Instead of spreadsheets and chat messages, a deployment lives as one record with a schedule, a status, an assignee, client sign-off, and an audit trail.

The whole thing ships as a small, runnable package: a static UI + an Express API + PostgreSQL, all in Docker, with IP-based access control and ready-to-use CI/CD.

> **Status:** early / functional prototype. The infrastructure, API, database, and CI/CD are real; the UI is a rich mockup and authentication is not yet real (see [Project status](#project-status)).

---

## Table of contents

- [What problem it solves](#what-problem-it-solves)
- [Core concepts](#core-concepts)
- [Roles & features](#roles--features)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started (local development)](#getting-started-local-development)
- [Configuration](#configuration)
- [Database: migrations & seeding](#database-migrations--seeding)
- [HTTP API](#http-api)
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
| **Deployment** | One rollout record: which project/apps/versions, to which environment(s), on what schedule, its status, assignee, client approval, and results. |
| **Status** | Lifecycle of a deployment: `scheduled` → `installed`, or `failed` / `rolledback` / `aborted`; a rollout can also be `paused`. |
| **Mode** | A deployment is either a **test-only** install (installed once, manually) or a **batch** rollout (spread across many production targets over several days). |

---

## Roles & features

The UI is organised around the people involved in a release:

- **Release Manager** — defines projects (apps, targets, post-deployment notifications), schedules new deployments, and monitors the deployments board.
- **Deployer** — a focused panel to carry out the assigned installs and report results.
- **Client** — a read-oriented view of the schedule and status for the projects they can see, with approval/notes.
- **Administrator** — manages users, clients, notification rules (email/Teams), and reviews the change history (audit log).
- **Account** — profile, help, and sign-out.

Cross-cutting features: schedule shifting mid-rollout, pause/resume with a reason, per-event notifications, an append-only audit trail, and IP-restricted access.

---

## Architecture

```mermaid
flowchart LR
    U[Browser] -->|HTTP :8080| N

    subgraph Docker
      N[frontend: nginx<br/>static UI + IP allowlist + /api proxy]
      B[backend: Express API<br/>IP allowlist + migrations on start]
      D[(PostgreSQL<br/>db-data volume)]
      N -->|/api, /health| B
      B --> D
    end
```

- **frontend** — an nginx container that serves the single-page UI (`frontend/app/index.html`), proxies `/api` and `/health` to the backend, and enforces an IP allowlist built from `ALLOWED_IPS`.
- **backend** — an Express API that persists data to PostgreSQL, runs database migrations on startup, applies a second IP-allowlist layer, and can send email notifications via SMTP.
- **db** — PostgreSQL. Deployments and projects are stored with filterable columns plus a `JSONB` `data` column holding the full object, so the UI can evolve its shape without constant migrations.

**Connected vs demo mode:** the UI auto-detects the backend. With the backend up (via `docker compose`) it runs in **CONNECTED** mode — loading from and saving to the database (a "● database connected" indicator shows bottom-right). Opened as a bare file with no backend, it runs in **DEMO** mode on in-memory placeholder data ("○ demo mode").

---

## Tech stack

- **Frontend:** a single self-contained `index.html` (vanilla HTML/CSS/JS, no build step), served by **nginx**.
- **Backend:** **Node.js 20**, **Express 4**, **pg**, **nodemailer**, **ipaddr.js** (ES modules).
- **Database:** **PostgreSQL 16**.
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

The frontend is a static file — for pure UI work you can just open `frontend/app/index.html` in a browser (it falls back to demo mode without a backend).

---

## Configuration

All configuration comes from environment variables (see `.env.example`). Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HTTP_PORT` | `8080` | Host port the frontend (nginx) listens on. |
| `ALLOWED_IPS` | *(empty)* | Comma/space-separated IPs and CIDR ranges allowed to reach the UI + API. Empty = no restriction (**dev only**). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `rolldesk` | Database credentials. |
| `DATABASE_URL` | *(built from the above)* | Backend connection string. |
| `TRUST_PROXY` | `1` (in compose) | Trust `X-Forwarded-For` for the real client IP behind a proxy. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | *(empty)* | SMTP for email notifications; if `SMTP_HOST` is unset, sending is skipped. |
| `IMAGE_PREFIX` / `TAG` | — | Used by `docker-compose.prod.yml` to pick which registry images/version to run. |

### Restricting access by IP

```
ALLOWED_IPS=203.0.113.4, 198.51.100.0/24, 10.8.0.0/24
```

Filtering runs at **nginx** (whole UI + API) and again in the **backend**. IPv4/IPv6 single addresses and CIDR ranges are supported. Typically you allow your office's public IP and the team VPN subnet.

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

---

## HTTP API

All endpoints are under `/api` (IP-filtered). `/health` is unfiltered for monitoring.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deployments` | List (filters: `project`, `env`, `status`). |
| GET | `/api/deployments/:id` | Details of one deployment. |
| POST | `/api/deployments` | Create (id from body or generated). |
| PUT | `/api/deployments/:id` | Create or update the full object (used by the UI). |
| DELETE | `/api/deployments/:id` | Delete. |
| GET | `/api/projects` | List projects (with default days/time and apps). |
| PUT | `/api/projects/:key` | Create or update a project. |
| GET | `/health` | Liveness + DB reachability. |

Deployment statuses: `scheduled`, `installed`, `failed`, `rolledback`, `aborted`, `paused`.

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

**Ready:** Docker infrastructure, durable PostgreSQL with an automatic migration runner (schema-only migrations; sample data in local, uncommitted seeds), a persisting API, IP restriction (nginx + backend), CI that tests/builds/deploys, and the served UI.

**Known limitations / next steps:**

- **Authentication is a mockup** — the login/2FA screen accepts any 6-digit code. Real auth is the top priority and depends on how the team wants to sign in.
- **Writes are "last write wins"** (no concurrency locks) — fine for a small team, to be hardened under load.
- **Project/app definitions** currently originate in the UI; moving them fully behind the `GET/PUT /api/projects` API is a natural next step.
- The **UI is one large `index.html`** — great for a zero-build mockup, a candidate for componentisation as it grows.

---

## License

No license file is included yet. Add one before distributing or open-sourcing this project.
