# RollDesk — self-hostable deployment tracker

A complete, runnable package: **UI + backend (API) + PostgreSQL database**, all in Docker, with **IP-based access control** and ready-to-use **CI/CD on GitHub** that deploys to your own server over SSH.

```
rolldesk/
├── docker-compose.yml            # local/dev stack: frontend + backend + postgres (builds images)
├── docker-compose.prod.yml       # production stack: runs pre-built images from a registry
├── .env.example                  # configuration (copy to .env)
├── .github/workflows/
│   ├── deploy.yml                # on push to main: test → build & push images (GHCR) → deploy over SSH
│   └── release.yml               # on version tag/release: test → build & push versioned images
├── frontend/                     # nginx serving the UI + /api proxy + IP allowlist
│   ├── Dockerfile
│   ├── nginx.conf.template
│   ├── docker-entrypoint.sh      # builds the "allow" list from ALLOWED_IPS
│   └── app/index.html            # the application (RollDesk UI)
└── backend/                      # Express + PostgreSQL + IP allowlist
    ├── Dockerfile
    ├── package.json
    ├── src/…                     # index, config, db, mailer, ipAllowlist, migrate, seed, routes, migrations, seeds
    └── test/…                    # unit tests (Node built-in test runner)
```

---

## Can this be hosted "on GitHub"?

Short answer: **GitHub Pages is not enough.** Pages only serves static files — it cannot run a database or a backend, and it cannot enforce IP restrictions.

A sensible split:
- **GitHub** → source code repository + automated Docker image builds (the workflow in `.github/workflows/deploy.yml` publishes images to `ghcr.io`) + automated deployment.
- **Target server** (a VPS or an internal server) running Docker → the whole application, including the database, runs here.
- **IP restriction** → handled by nginx (and additionally in the backend), controlled by the `ALLOWED_IPS` variable.

Data is stored durably in PostgreSQL (the `db-data` volume), so it survives container restarts.

---

## Quick start (locally or on a server)

```bash
cp .env.example .env
# set ALLOWED_IPS, the database password, and (optionally) SMTP_HOST
docker compose up --build
```

- UI: `http://SERVER:8080`
- API: `http://SERVER:8080/api/deployments`
- Health: `http://SERVER:8080/health`

Database migrations run automatically when the backend starts (see [Database migrations](#database-migrations)).

---

## Restricting access to your team (by IP)

In `.env`, set the addresses/subnets your team connects from:

```
ALLOWED_IPS=203.0.113.4, 198.51.100.0/24, 10.8.0.0/24
```

- Single IPs and CIDR ranges are supported (IPv4/IPv6).
- Filtering runs on **nginx** (entire UI + API) and in the **backend** (a second layer).
- Leaving the list empty = no restriction (testing only).

Typically you add your office's public address and the VPN subnet the team uses.

> If the app sits behind an additional load balancer, make sure the real client IP arrives in the `X-Forwarded-For` header (the backend sets `TRUST_PROXY=1`).

---

## Continuous deployment to your server over SSH

On every push to `main`, the workflow (`.github/workflows/deploy.yml`) runs three jobs:

1. **test** — installs backend dependencies and runs the unit tests.
2. **build-and-push** — builds the frontend and backend images and pushes them to GHCR:
   - `ghcr.io/<owner>/<repo>-backend`
   - `ghcr.io/<owner>/<repo>-frontend`
   - tagged with both `latest` and the commit SHA.
3. **deploy** — connects to your server over SSH, copies `docker-compose.prod.yml`, then runs `docker compose pull && docker compose up -d`. Database migrations are baked into the backend image and applied automatically on startup, so nothing else needs to be copied.

### Server prerequisites

- Docker + the Docker Compose plugin installed.
- A deployment directory (e.g. `/opt/rolldesk`) containing a `.env` file with your production values (`POSTGRES_PASSWORD`, `ALLOWED_IPS`, `SMTP_*`, `HTTP_PORT`, …). See `.env.example`.
- An SSH user that can run `docker`.

### Required GitHub repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Description |
|--------|-------------|
| `SSH_HOST` | Server hostname or IP |
| `SSH_USER` | SSH username |
| `SSH_KEY` | Private SSH key (PEM) for that user |
| `SSH_PORT` | SSH port (e.g. `22`) |
| `DEPLOY_PATH` | Absolute path to the deployment directory on the server (e.g. `/opt/rolldesk`) |

`GITHUB_TOKEN` is provided automatically and is used both to push images and to pull them on the server.

> **Tip:** create a GitHub Environment named `production` (referenced by the deploy job) to add required reviewers or environment-scoped secrets.

### Manual deployment (without the workflow)

On the server you can pull and run the published images directly:

```bash
export IMAGE_PREFIX=ghcr.io/<owner>/<repo>
export TAG=latest
docker login ghcr.io
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

---

## Release pipeline (versioned images)

Separately from the main-branch continuous deployment, `.github/workflows/release.yml` builds **versioned release images**. It triggers whenever you publish a GitHub Release or push a version tag matching `v*.*.*`, and runs two jobs:

1. **test** — runs the automated backend tests (the release is blocked if they fail).
2. **build-release-images** — builds and pushes both images to GHCR, tagged with the release version **and** `latest`:
   - `ghcr.io/<owner>/<repo>-backend:<version>`
   - `ghcr.io/<owner>/<repo>-frontend:<version>`

For example, publishing release `v1.4.0` produces `...-backend:1.4.0` and `...-frontend:1.4.0`.

Cut a release with a tag:

```bash
git tag v1.4.0
git push origin v1.4.0
# or create a Release in the GitHub UI
```

To run a specific release on the server, set `TAG=<version>` in the deployment `.env` and re-run `docker compose pull && docker compose up -d`.

---

## HTTPS (production)

For production, terminate TLS in front of the app — the simplest option is a reverse proxy (Caddy/Traefik/nginx) with a Let's Encrypt certificate, forwarding to the frontend port. You can keep the IP restriction in this package (`ALLOWED_IPS`) or move it to the proxy/firewall.

---

## Database migrations

The backend includes a small, dependency-free migration runner (`backend/src/migrate.js`). Versioned SQL files live in `backend/src/migrations/` and are applied **in filename order, exactly once**, tracked in a `schema_migrations` table.

- Migrations run **automatically when the backend starts** — before it accepts any traffic. This works on first boot and on every subsequent deploy, so schema changes ship with your code (unlike the old "run only on an empty database" approach).
- Each migration runs in its own transaction and is rolled back if it fails (the backend then exits non-zero instead of serving a half-migrated schema).
- You can also run them manually against the configured `DATABASE_URL`:

```bash
cd backend
npm run migrate
```

### Adding a migration

Create a new file in `backend/src/migrations/` using the zero-padded prefix convention, e.g. `002_add_column.sql`. Keep statements idempotent where practical (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). On the next backend start (or `npm run migrate`) it will be applied and recorded.

> **Upgrading an existing database** created via the previous init-on-empty approach: the runner is idempotent, so `001_init.sql` is simply re-run (no-op) and recorded in `schema_migrations`; later migrations then apply normally.

### Local test data (not committed)

The committed migration (`001_init.sql`) creates **schema only** — it contains no client/project data. Real client and project definitions are kept as **local, uncommitted test data** so they never land in the repository:

- `backend/src/seeds/local.sql` — your local test data. **Git-ignored** (and excluded from Docker images).
- `backend/src/seeds/local.sql.example` — a committed, generic example showing the format.

Load your local seed into the database:

```bash
cd backend
npm run seed                 # loads src/seeds/local.sql (skips silently if absent)
# or against the dev stack:
docker compose exec backend npm run seed
```

To create your own: `cp backend/src/seeds/local.sql.example backend/src/seeds/local.sql`, edit it, then run the seed command. The dev `docker-compose.yml` mounts `backend/src/seeds` into the backend container so the git-ignored file is available at runtime.

---

## API (data persisted in the database)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/deployments` | list (filters: `project`, `env`, `status`) |
| GET | `/api/deployments/:id` | details |
| POST | `/api/deployments` | create (saved to the database) |
| PUT | `/api/deployments/:id` | create or update the full object |
| DELETE | `/api/deployments/:id` | delete |
| GET | `/api/projects` | projects (with default number of days and time) |
| PUT | `/api/projects/:key` | create or update a project |

Statuses: `scheduled`, `installed`, `failed`, `rolledback`, `aborted`, `paused`.

---

## Tests

The backend ships with unit tests (Node's built-in test runner — no extra dependencies):

```bash
cd backend
npm install
npm test
```

They cover the IP allowlist (exact IPs, CIDR ranges, IPv4/IPv6, the `X-Forwarded-For` proxy path, and 403 rejection), environment configuration parsing, and the migration runner's ordering/pending logic. These tests also run automatically in CI before any image is built.

---

## What is ready, and what comes next

**Ready:** infrastructure (Docker), a durable PostgreSQL database with an automatic migration runner (schema-only migrations; client/project data lives in local, uncommitted seed files), an API that persists data, IP restriction (nginx + backend), CI that builds images and deploys them to your server over SSH, and the served UI.

**UI connected to the database:** the UI detects the backend automatically. When it is available (started via `docker compose`), the app runs in CONNECTED mode — it loads deployments from the database on startup and saves every change (creating a deployment, changing status, pausing/resuming, assigning an operator, client approval/notes, rescheduling, reporting a result, comments). A "● database connected" indicator is shown in the bottom-right corner. When the backend is absent (e.g. the file is opened locally), the UI runs in DEMO mode on in-memory data — "○ demo mode (no database)".

**Next steps / notes:** writes use a "last write wins" approach (no concurrency locks) — sufficient for a small team, to be extended under heavier load. Project/app definitions are currently built into the UI and seeded into the database via a migration; editing projects with API persistence is the natural next extension (the `GET/PUT /api/projects` endpoints already exist). Login in the UI is still a mockup (2FA accepts any 6-digit code) — real authentication can be added once you decide how the team should sign in.
