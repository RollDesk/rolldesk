# Architecture assumptions

Adopted architectural decisions for RollDesk. Use this as a checklist when building a similar self-hostable app.

## Product & deployment

- Self-hostable web app (not SaaS-first): Docker Compose, own database, configuration via `.env`.
- One shared product for business roles (release manager / deployer / client / admin), not separate apps.
- The UI always requires the API — no offline/demo mode; if the backend is down, the app stays on the login screen.
- CI builds and publishes images (GHCR); server deploy is manual (`compose up`), not automated from the pipeline.

## System layers

- **frontend** (nginx): static UI + proxy for `/api` and `/health` + IP allowlist.
- **backend** (Express): API, auth, migrations on startup, second IP-allowlist layer, uploads, notifications.
- **PostgreSQL**: source of truth.
- Optional sidecars (ClamAV, external DB/ClamAV) are enabled via env, not hard-coded.
- **Body-size limits belong to every hop, not just the API.** nginx's `client_max_body_size` has to
  be kept above the per-file cap in the upload route — its 1 MB default rejects an upload with a 413
  the application never sees — and any TLS proxy in front of the container needs the same setting.

## Frontend

- One rich page (`index.html` + vanilla JS/CSS), **no build step**, no framework.
- i18n in separate files (`pl.js` / `en.js`); canonical values in data stay English; labels are localized at display time.
- Code, comments, and UI source strings are English; translations live in the dictionaries.
- App version and i18n cache-bust query stay in sync with `package.json` / the release tag.

## Backend

- Node 20, ES modules, **dependency-light** (prefer the standard library and existing packages).
- Configuration only from the environment (`config.js`) — no hosts or secrets in code.
- Pure logic in small helpers + a thin I/O layer (easy unit tests).
- Tests: built-in `node:test`, no test framework; CI blocks a release on failure.

## Data model

- Hybrid storage: **filterable columns** + full object in **JSONB `data`** (projects, deployments) so the UI shape can evolve without constant migrations.
- Separate tables for: users, attachments (raw bytes), audit (append-only), `app_state` (whole UI collections, last-write-wins), API tokens, SSO.
- Versioned SQL migrations, idempotent where practical, **schema only**; sample data lives in a git-ignored seed.
- Migrations run automatically on startup (`DB_MIGRATE=auto`) or in `verify` mode (refuse to start if pending).

## Auth & security

- No default user; a first-run wizard creates the admin.
- Password + mandatory TOTP MFA (local accounts); session JWT as Bearer.
- Optional per-domain OIDC SSO; **no just-in-time provisioning** — the account must already exist; local admins keep a password break-glass.
- IP allowlist on both nginx and the backend.
- Uploads scanned by ClamAV (fail-closed by default).
- Secrets and real client data never land in the repo or images.

## Permissions (RBAC)

- Roles: admin, release manager, installer, client.
- The UI hides controls, but the **API enforces** scope (clients cannot bypass the UI).
- Client: only granted projects, no internal deployments, no project/deployment mutation, no audit.
- Installer: scoped by projects; admin / RM: full access.
- Visibility policies (e.g. whether the client sees admin notes) live as flags in the project JSONB.

## API & domain

- REST under `/api`; `/health` is unauthenticated (liveness + DB + migration status).
- Domain entities: Client → Project → Apps/Targets → Deployment (single vs batch).
- Explicit lifecycle statuses (`scheduled` / `installed` / `failed` / …); append-only audit trail.
- Two write shapes per entity: **`PUT` replaces the whole JSONB object** (what the UI, which holds it in memory, needs) and **`PATCH` merges named fields** (what a token-authenticated script needs, without a read-modify-write round trip). `PATCH` never upserts and validates the fields it owns.
- Event-driven notifications (email / webhook / optional Teams Graph), opt-in.
- Notification bodies are composed in the browser, so their language is pinned to the instance (`NOTIFY_LANG`, delivered to the UI by `/api/version`) rather than inherited from whoever triggered the event.

## Process & release

- Conventional Commits; branch named after the version (e.g. `0.12.0`); PR → `main` → annotated tag `vX.Y.Z`.
- Keep a Changelog; version kept in sync across backend, frontend, and i18n query params.
- Small, focused PRs; no secrets; run tests locally before opening a PR.

## Conscious trade-offs (copy or reject deliberately)

- Prototype UI as a single-file monolith — fast iteration at the cost of frontend scalability.
- JSONB-first — flexibility at the cost of a rigid SQL schema and query shape.
- Some auth pieces assume a single instance (in-memory rate limit / SSO state) — sticky sessions or one backend.
- No auto-deploy — the operator controls the server rollout.
