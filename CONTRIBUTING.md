# Contributing to RollDesk

Thanks for taking the time to contribute! RollDesk is a small, dependency-light project — you can be productive within minutes. This guide explains how to set up your environment, the conventions we follow, and how to get a change merged.

New here? Start with the [README](README.md) for what the project is and how it's structured.

---

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project layout (where things live)](#project-layout-where-things-live)
- [Making a change](#making-a-change)
- [Coding conventions](#coding-conventions)
- [Database changes](#database-changes)
- [Never commit secrets or real data](#never-commit-secrets-or-real-data)
- [Tests](#tests)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Reporting bugs & requesting features](#reporting-bugs--requesting-features)
- [Good first issues](#good-first-issues)

---

## Code of conduct

Be respectful, assume good intent, and keep discussion focused on the work. Harassment or hostile behaviour isn't tolerated. Disagreements are fine — resolve them with evidence (code, tests, benchmarks) rather than opinion alone.

---

## Ways to contribute

- **Code** — features, bug fixes, refactors, tests.
- **Docs** — improve the README, this guide, code comments, or inline help text.
- **Triage** — reproduce bugs, add detail to issues, propose designs.

You don't need permission for small fixes. For larger or design-affecting changes, open an issue first so we can agree on the approach before you invest time.

---

## Development setup

Prerequisites: **Node.js 20+**, **Docker** + the Docker Compose plugin, and **git**.

Clone over SSH:

```bash
git clone git@github.com:RollDesk/rolldesk.git
cd rolldesk
```

### Option A — full stack in Docker (closest to production)

```bash
cp .env.example .env          # set POSTGRES_PASSWORD; leave ALLOWED_IPS empty for local use
docker compose up --build
```

- UI: http://localhost:8080 · API: http://localhost:8080/api/deployments · Health: http://localhost:8080/health

On first open you'll hit the **setup wizard** (there is no default user): create an admin, then complete the forced **TOTP MFA enrollment** with any authenticator app. The dev compose file sets a throwaway `JWT_SECRET`; set a real one for anything non-local (`openssl rand -hex 32`).

Load sample data (optional):

```bash
cp backend/src/seeds/local.sql.example backend/src/seeds/local.sql   # then edit if you like
docker compose exec backend npm run seed
```

### Option B — backend only (fast iteration)

Point `DATABASE_URL` at any reachable PostgreSQL:

```bash
cd backend
npm install
export DATABASE_URL=postgres://rolldesk:rolldesk@localhost:5432/rolldesk
npm run migrate    # apply schema
npm run seed       # optional local data
npm start          # http://localhost:3000
npm test           # run the test suite
```

### Option C — UI only

The frontend is a single static file. For pure UI work, open `frontend/app/index.html` directly in a browser — with no backend it runs in **demo mode** on in-memory placeholder data.

---

## Project layout (where things live)

| You want to change… | Look here |
|----------------------|-----------|
| The UI (all views, styles, client-side logic) | `frontend/app/index.html` |
| nginx serving / proxy / IP allowlist | `frontend/nginx.conf.template`, `frontend/docker-entrypoint.sh` |
| API endpoints | `backend/src/routes/` |
| Config / env handling | `backend/src/config.js` |
| IP access control | `backend/src/ipAllowlist.js` |
| DB connection | `backend/src/db.js` |
| Migrations (schema) | `backend/src/migrations/` |
| Migration runner | `backend/src/migrate.js` |
| Local seed / seeder | `backend/src/seeds/`, `backend/src/seed.js` |
| Email notifications | `backend/src/mailer.js` |
| Tests | `backend/test/` |
| CI/CD | `.github/workflows/` |

---

## Making a change

1. Create a topic branch from `main`:
   ```bash
   git checkout -b feat/short-description   # or fix/…, docs/…, refactor/…, test/…
   ```
2. Make the change. Keep it focused — one logical change per branch/PR.
3. Add or update tests for any logic you touch.
4. Run the tests locally: `cd backend && npm test`.
5. Commit using [Conventional Commits](#commit-messages) and open a [pull request](#pull-requests).

---

## Coding conventions

- **Language:** all code, comments, and user-facing text are in **English**.
- **Backend is ES modules** (`"type": "module"`) — use `import`/`export`, not `require`.
- **Keep it dependency-light.** Prefer the standard library and the few existing deps over adding new ones. The test runner is Node's built-in `node:test` — no test framework needed. If you believe a new dependency is warranted, call it out in the PR.
- **Write testable code:** keep pure logic in small exported helpers and wrap I/O around them (see `ipAllowlist.js` and `migrate.js` for the pattern — pure functions + a thin factory/middleware).
- **Comments explain *why*, not *what*.** Don't narrate the code; note intent, trade-offs, or constraints.
- **Match the existing style** (indentation, naming, structure) of the file you're editing. There's no separate formatter step; keep diffs clean and minimal.
- **Config comes from the environment** (`config.js`) — don't hard-code hosts, credentials, or IPs.

---

## Database changes

- **Never edit an existing migration** that may have run somewhere. Add a new file instead.
- Create it in `backend/src/migrations/` using the zero-padded prefix convention, e.g. `002_add_deployment_owner.sql` (`001_init.sql` — the consolidated initial schema — already exists).
- Keep statements **idempotent** where practical (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `ADD COLUMN IF NOT EXISTS`).
- Migrations run automatically on backend start and via `npm run migrate`; each runs once, in its own transaction, tracked in `schema_migrations`.
- Migrations are **schema only** — no client/project/sample data. Sample data goes in the git-ignored local seed (below).

---

## Never commit secrets or real data

This is important:

- **No secrets** — credentials, tokens, private keys, or `.env` files. `.env` is git-ignored; keep it that way.
- **No real client, project, or personal data.** Real project/app/people definitions belong in `backend/src/seeds/local.sql`, which is **git-ignored** and excluded from Docker images. The committed example (`local.sql.example`) uses fabricated orgs (`ACME`, `Globex`) and generic names/emails — keep committed samples fake.
- The same applies to the UI's built-in demo data and to screenshots.

If you spot real data or a secret in the history, flag it in an issue immediately.

---

## Tests

- Run: `cd backend && npm test` (uses `node --test`).
- Add tests alongside the existing ones in `backend/test/` (files named `*.test.js`).
- Cover the pure logic of anything you change; prefer fast, dependency-free unit tests.
- CI runs the suite before building any image, and a release is blocked if tests fail — so a green local run should mean a green pipeline.

---

## Commit messages

We use [**Conventional Commits**](https://www.conventionalcommits.org/):

```
<type>(optional scope): short summary

optional body explaining the why
optional footer, e.g. "Refs #123" or "Closes #123"
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`.

Examples:

```
feat(api): add PATCH endpoint to reassign a deployment
fix(ipAllowlist): strip ::ffff: prefix before matching
docs: document the release pipeline
```

Reference related issues with `#<number>`. Keep the summary in the imperative mood ("add", not "added").

---

## Pull requests

Before you open a PR:

- [ ] Tests pass locally (`npm test`).
- [ ] New/changed logic is covered by tests.
- [ ] No secrets or real data added.
- [ ] Docs updated if behaviour changed (README / this file / inline help).
- [ ] The branch is focused and reasonably small.

Opening the PR:

- Give it a clear title (Conventional-Commit style is welcome) and a description that explains **the why**, not just the what.
- Link related issues (`Closes #123`).
- Prefer small, reviewable PRs. If a change is large, consider splitting it.
- Keep the PR description up to date if the behaviour changes during review.
- Address review comments with follow-up commits; we'll squash-merge unless there's a reason not to.

---

## Reporting bugs & requesting features

Open a GitHub issue and include, for bugs:

- What you did, what you expected, and what actually happened.
- Steps to reproduce (a minimal case is ideal).
- Environment (how you ran it: `docker compose`, standalone backend, browser only), and any relevant logs.

For features, describe the problem you're trying to solve and the proposed behaviour. Screenshots/mockups help for UI ideas — just make sure they contain no real data.

---

## Good first issues

Nice entry points into the codebase:

- Multi-user management (the auth backend supports one bootstrapped admin; the in-app Users screen is still demo data).
- A real "forgot password" / reset flow (the panel exists but isn't wired to the backend).
- Project editing via the existing `PUT /api/projects` API.
- More API-level tests (e.g. route behaviour with a test database).
- Breaking the single-file UI (`frontend/app/index.html`) into maintainable pieces.

Thanks again for contributing!
