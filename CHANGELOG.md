# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 0.4.0

### Added
- Hash-based routing: each top-level view is reflected in the URL (e.g. `#deployments`), so the browser Back/Forward buttons work, refreshing restores the current view, and views can be deep-linked/bookmarked. The browser tab title now updates to match the active view (and language).
- Real event notifications: deployment **pause**, **client comments** and **completed** events now actually deliver to the configured client webhooks (Slack/Teams) and, for completion, the project's post-deployment e-mail — via a new backend `POST /api/notifications/notify` endpoint. Delivery is reported per recipient, so partial failures are surfaced to the user (previously these events were only logged). Additional events (**schedule created**, **approval request**, **client decision**, **failure on a target**) are now wired to the same delivery path.
- **Real multi-user management.** The Users screen is now backed by real accounts in the database (`/api/users`, admin only): invite a user (name, role, per-project/client access), and they receive a single-use link to set their own password and enroll TOTP MFA on first sign-in. The link is shown in-app (copyable) and e-mailed when SMTP is configured. Admins can edit, archive/restore, resend invitations and issue password-reset links; archived accounts can no longer sign in, and the last administrator can't be demoted or self-archived. Client accounts created while defining a project (or from a deployment-approval prompt) are now real invited accounts too. Replaces the previous in-memory user roster.
- **Real personal access tokens** for the automation API. Tokens are generated server-side (prefix `rd_live_`), shown once, and stored only as a SHA-256 hash in a new `api_tokens` table. The data API (`/api/deployments`, `/api/projects`, …) now accepts `Authorization: Bearer rd_live_…` in addition to a session JWT, so scripts/CI can authenticate. Tokens can be created (with optional expiry), listed (masked, with last-used), and revoked from the profile; token management itself requires an interactive session. Replaces the previous in-memory mock token list and its fake usage history.
- Translations are now split into per-language bundles (`frontend/app/i18n/pl.js`, `en.js`) loaded before the app. Adding a language is a matter of copying a file and including it — no longer editing a large inline dictionary in `index.html`.

### Changed
- **No more demo/offline mode.** The frontend always requires the backend (it authenticates and loads all data from the API); there is no in-memory fallback. Docs updated to drop the "connected vs demo" wording and the removed database-connection badge.
- Removed the "Test as" role switcher from the Users screen. Permissions now follow the real signed-in account (from `/api/auth/me`) rather than a manual demo toggle.

### Fixed
- The Help view and API documentation, the whole profile view (sign-in security, change password, API tokens, sign-in history), the change-history view, and the Users and Clients views are now fully translated to Polish (labels, table headers, dynamically rendered rows, role names/descriptions and action buttons), and re-render on language switch.
- Additional Polish translations in the deployment detail/deployer panel: timeline label and "Schedule created by …" entry, "Add a comment"/"Save comment", the Changelog label, "Pause deployment", "Generate a message for users", and the "Edit" action.
- The project slug in the top bar is now shown only on project-scoped views (Projects, New deployment, Applications). It no longer lingers on global views such as Deployments, where it referred to a previously opened project and was misleading.

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
