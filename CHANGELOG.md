# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-12

### Added
- In-memory rate limiting on the authentication endpoints (`/api/auth/login`, `/setup`, and the TOTP `mfa/*` steps) to slow down password and code guessing. Only failed attempts count toward the limit, so legitimate users are never locked out; no external store (e.g. Redis) is required.
- Notification webhooks are now configured per **client** (with per-event routing, enable/disable, and a "Send test" button). Deployment events for a project are delivered to that project's client webhooks. Creating a new client — including inline while creating a project — now requires at least one webhook.
- `APP_BASE_URL` setting: the public URL of the app. When set, outgoing notifications (webhook test messages and e-mail) include a clickable link back to RollDesk. The webhook test also now sends the correct payload shape for Slack vs Teams incoming webhooks.
- Per-project "skip weekends" setting (Deployment defaults). When disabled, the auto-generated rollout schedule includes Saturdays and Sundays; the rollout-preview note reflects the active setting.
- Project post-deployment notification split into separate e-mail and webhook (Teams) fields, each with a "Send test" button (older single-target values are migrated automatically).

### Changed
- Removed the generic global Notifications view. Event notifications are now tied to the client (webhooks) and the project (opt-in post-deployment e-mail), instead of a project-agnostic recipient list. E-mail notifications remain disabled by default — webhooks are the primary channel.

### Fixed
- The login screen (setup wizard, sign-in, MFA, password reset) is now fully translated and honours the selected language. The language choice is persisted (survives logout and reload), and a language switcher was added to the login screen itself.
- Translate the deployment version input placeholder ("version, e.g. …") to Polish.
- Add missing Polish translations in the deployer reporting panel ("To report", completed-corrections section); affected views now also refresh on language switch.

## [0.2.1] - 2026-07-12

### Added
- Enriched `/health` endpoint reporting overall status, app version, uptime, timestamp, and a database connectivity check with latency (returns `503` when the database is unreachable).

### Fixed
- Backend no longer crashes when the database connection drops; idle pool errors are handled so the service stays up and reports a degraded `/health` instead.

## [0.2.0] - 2026-07-12

First fully functional release: real authentication, database-backed state, and file security.

### Added
- First-run setup wizard, password login (bcrypt) with JWT sessions, and mandatory TOTP MFA.
- Server-side login history and IP allowlisting (nginx + backend).
- Attachments stored in the database, with ClamAV virus scanning in a separate container.
- Database persistence for profile, projects, deployments, clients, user roster, audit log, and notification settings.
- PL/EN translations across the UI, with a dictionary-consistency unit test.
- App version check against the latest GitHub release.
- Deployment start time, editable project defaults, and audited deployment date/time changes.
- Client account creation from the approval prompt; test webhook/email button.
- Dependabot (npm, Docker, GitHub Actions) and docs for external DB / ClamAV.

### Changed
- Starts with empty databases; consolidated migrations into a single `001_init.sql`.
- Upgraded PostgreSQL 18, nginx 1.31, Express 5, nodemailer 9.

### Removed
- Demo mode: mock login, seeded demo data, and the database-connection badge.

[0.2.1]: https://github.com/RollDesk/rolldesk/releases/tag/v0.2.1
[0.2.0]: https://github.com/RollDesk/rolldesk/releases/tag/v0.2.0
