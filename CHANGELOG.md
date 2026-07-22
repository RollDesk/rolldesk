# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-07-22

### Added
- **Deployer panel filter tabs.** A row of tabs at the top of the deployer panel (All / Awaiting client / To report / Completed / Reports) shows one group at a time, so a large number of distributions stays readable instead of one long scrolling page.
- **Timeline preview for completed distributions.** Completed cards in the deployer panel now have a "Show timeline" toggle so the deployer can review everything that happened without leaving the panel.
- **Batch correction lets you choose the outcome.** For a completed distribution the correction form now offers "change to successful" and "keep failure (change reason)" — the same explicit choice single deployments already had — instead of silently inferring it.
- **Exact-count day limits + soft validation.** The per-day breakdown field is now labelled *Exact count* and shows a non-blocking warning when the locations pinned to a day exceed the exact count set for that type (e.g. limit 1 "big office" but 2 pinned).
- **Remove a custom target column.** Each custom column in the target list has a "✕" button to delete it (and its data from every target) — useful after re-importing a CSV with a different column set (e.g. a leftover "Miejscowość").
- **Assign any deployer.** The assignee selector now lists project-scoped deployers first and then every other active deployer, so a lead can hand a distribution to a colleague who is not project-scoped. Each assignment change is recorded on the deployment timeline.
- **Richer notifications.** Teams/webhook and e-mail notifications now include the environment (ŚT/PROD) in the subject and body and note who reported/approved (manual), for day reports, completions, failures and client approvals.
- **Multiple changelog attachments.** The "Changelog attachment" field in *New deployment* now accepts several files; all of them are uploaded, virus-scanned and shown as download links in the client portal and the deployments list.
- **Attachment for deployer instructions.** *Instructions for deployers* now has its own file field (e.g. an additional script); attached files are available in the deployer panel next to the instructions.

### Fixed
- **Locations that succeed on a later day no longer show as "to finish".** When a target that failed earlier is later marked successful (on any subsequent day), it is removed from the failed list, so a finished distribution correctly shows nothing left to complete. "Mark the rest as installed" also clears any remaining failures.
- **Failure notifications are actually sent.** Reporting a failed location now also dispatches the standard *Failure* event (which clients subscribe to by default), so a webhook/e-mail is delivered even if the newer per-day event is not enabled.
- **Client approval is announced.** Approving a schedule from the client portal now sends a webhook/e-mail (with environment and who approved), not only a timeline entry.

### Notes
- **Could not verify:** the reported "draft with ŚT+PROD only shows ŚT (production planned deployment missing)" case could not be reproduced from the code — both the test and production records are created and rendered. It needs a concrete reproduction from a live instance (ideally with the browser console open) to pin down.

## [0.9.1] - 2026-07-20

### Added
- **Per-project option: test environments also require client approval.** A new toggle in *Project → Deployment defaults* ("Test environment also requires client approval") makes test-env deployments (e.g. ŚT) wait for the client's sign-off, appear in the client portal to approve, and stay in the deployer's "Awaiting client approval" group — exactly like production. Off by default, so existing behaviour is unchanged.

### Fixed
- **Polish translations** for several leftover English strings: "Mark the rest", "X locations / working days", "Distribution start / Start / at", "Instructions for the deployer", the schedule-generated toast, and the "to finish / complete" progress labels. Weekday names (e.g. "Monday") in the deployer's waiting list and in notifications now follow the selected language.

## [0.9.0] - 2026-07-20

### Added
- **Per-day limit by a custom column now sources real values.** The "Restrict type" dropdown in *Spread across days* lists the actual values of the chosen attribute (target type, or a custom column such as "Rodzaj Urzędu") read from the project's targets — no more stale `SP/UM/UD` placeholder.
- **Assign a deployer to a deployment.** In the deployer panel each deployment has an assignee selector scoped to the deployers granted access to that project (plus "assign to me"); changing it no longer resets any unsaved "failed" ticks or reason text.
- **Daily installation-status notifications.** A new subscribable *Daily installation status* event sends the per-day summary (installed / failed counts, failed list and reason) to the client's webhooks / project e-mail after each day is reported — not only on completion. This also covers notifying on a failed location.
- **Client-approval badge in the deployer panel.** Production cards now show "✓ approved by client" (or the pending/commented/rejected state) directly, instead of only on the timeline.
- **Deployer panel grouped by project.** Active deployments are grouped under a per-project subheader.
- **Reports & history (read-only).** A collapsible panel in the deployer view lists completed installations filtered by "completed from" date and status (all / successful / with failures), with CSV export.

### Fixed
- **Real timestamps everywhere.** Removed leftover mockup dates (`2026-07-04`) that were still overriding the schedule-creation date, the global "today" used for day logic, and correction/reply comments — the timeline and change history now show the real date/time of each action.
- **`failed` carries over to the next day on the first save.** Reporting a day with failures now completes that day and moves the failed targets to the next available day immediately, instead of requiring several attempts.
- **Timeline shows when a day was reported.** "Deployed to N / Failed for N" entries use the moment the deployer saved the result, not the planned day date.
- **XLS schedule keeps the app version as text.** Exported `.xls` no longer lets Excel (Polish locale) turn a version like `1.2.3` into a date (`01.02.2003`); the version and target-code cells are forced to text.

## [0.8.0] - 2026-07-19

### Added
- **Per-day limit by a custom target column.** When building a schedule you can now choose whether the per-day *Restrict … / Max count* limit applies to the target *type* (default) or to any custom target column (e.g. a "size" or "region" column), so you can cap how many targets of a given attribute value go out on a day.
- **Pin locations to a specific day.** Each day in the per-day breakdown has a *Pin locations* field — type target codes/labels separated by `;` (or commas/spaces) to force those targets onto that day (e.g. pilot locations on day 1). Pinned targets count against that day's total.
- **Location search in the deployment queue.** The remaining-locations queue in the deployment details now has a search box to quickly find a target before moving it between days.
- **Richer, localized schedule notifications.** "Schedule created" / "Approval request" notifications (Teams, Slack, e-mail) now include the deployment ID, applications/versions, environment, number of locations and working days, the start date/time and who created the schedule — fully translated to the selected UI language. Teams cards keep the line breaks so the details stay readable.

### Changed
- **Re-importing a CSV updates existing targets.** Importing a targets CSV again now refreshes the type and custom-column values of targets that already exist (matched by name) and picks up new columns, instead of silently skipping known names.

### Fixed
- **Timeline timestamps are real.** Status changes, comments and approvals are now stamped with the actual current date/time instead of a fixed placeholder date, so the change history and timeline show when things really happened.
- **Drafts no longer appear in the Deployer panel.** A deployment saved as a draft stays out of the deployer's active/completed lists until it is published.

## [0.7.0] - 2026-07-16

### Added
- **Editable per-day distribution.** After a schedule is created you can now set the number of targets planned for any not-yet-completed day directly (the surplus/shortfall is moved to/from the other days), in addition to moving individual targets between days.
- **Custom target fields in the schedule.** Extra target columns (e.g. „nazwa urzędu") are now carried into the in-app schedule table, the PDF and the XLS export.
- **Edit a planned deployment.** Release managers and administrators get an *Edit* action on unfinished deployments to change application versions, the start time and the changelog; changes are recorded in the timeline and change history.
- **Draft deployments.** A production schedule can be saved as a *draft* — it stays hidden from the client and sends no notifications until the release manager presses *Notify the client*, which publishes it and sends the schedule/approval notifications to the configured recipients.
- **App link in notifications.** Teams/Slack notifications for a created schedule / approval request now include the changelog inline and a link back to open the schedule in RollDesk (webhooks cannot carry file attachments).

### Changed
- **Schedule PDF & XLS are localized.** Titles, subtitles, column headers, the print button and the day-of-week now follow the selected UI language (Polish/English) instead of always being English.
- Client schedule decisions (approve / comment / propose another date) are now persisted through a dedicated `POST /api/deployments/:id/decision` endpoint that clients are allowed to call and which writes the change-history entry server-side.

### Fixed
- **The version footer stays in the bottom-left corner** on tall views (Deployer panel, Users, Change history) — the sidebar is now pinned to the viewport instead of scrolling away with long tables.
- **Moving a target across days works for every day**, not only between day 1 and 2 — the move now actually changes the per-day distribution rather than only reordering the queue.
- **Client approval is now recorded properly.** Approving a schedule records who approved it (the client's real name / organisation, never the e-mail login like „aaa"), adds a timeline entry and a change-history entry, and persists so the release manager sees it after a reload. Manual approval changes by the release manager are also logged with a real timestamp.

## [0.6.1] - 2026-07-16

### Added
- Optional **group** field on user accounts (Users tab), shown in the directory — a purely descriptive label to make managing users easier. New `user_group` column (migration `003_user_group.sql`).
- **Startup migration verification.** The backend still auto-applies pending migrations by default; setting `DB_MIGRATE=verify` makes it only check the schema and refuse to start when migrations are pending (apply them via a separate `node src/migrate.js` step). `/health` now reports migration status (`applied` count, `pending` list) and is marked `degraded` when the database has drifted behind the code.

### Changed
- **Deployer panel is now scoped to the deployer's projects.** A user with the Deployer role only sees deployments of the projects they were granted in the Users tab (enforced on the backend for `GET /api/deployments` too). `GET /api/auth/me` now returns the account's `projects` and `clientKey`.
- **Client panel works from real accounts.** A Client user's portal is built automatically from the projects an admin granted them (no more demo "scenario" needed); admins/release managers can still preview each client's view.
- Consistent **date/time formatting** across the Deployments views (ISO `YYYY-MM-DD` dates, 24-hour `HH:MM` times) instead of a mix of `DD/MM/YYYY`, `DD.MM` and locale times.
- More **Polish translations**: deployment-details Day schedule and Location queue, the deployer-panel cards (today's batch, saved-result and correction views), and the schedule preview.
- The **end-user message generator** ("Generate a message") is now fully localized — the modal, tag buttons, the default template and the substituted values (dates, versions, attachments) follow the selected UI language. Its greeting changed from "Dear Sir or Madam" to "Hello,".
- The **change history** now renders localized entries. New entries store a translation key + parameters (migration `005_audit_i18n.sql`) so the Object, Action and Details columns display in the current language; older entries keep their stored English text as a fallback.

### Fixed
- The first **"Generate schedule"** after manually spreading targets across days now honours that manual per-day split instead of falling back to an even split.
- **Duplicate project names** are rejected for the same client.

## [0.6.0] - 2026-07-15

### Added
- **Role-based access control.** The signed-in role now drives both the navigation and the API. A **client** account only sees the Client panel (plus profile/help) and is redirected away from team screens; the backend independently rejects client access to create/update/delete of deployments and projects, to the change history and shared settings, and to notifications, and scopes deployment/project reads to the client's own, non-internal projects. Roles: admin (everything), release manager (projects/deployments/history), deployer (deployer panel), client (client panel).
- **Delete actions for admins**: delete a client (blocked while it still owns projects), delete a project (with its deployments), and delete a deployment — with confirmation. New `DELETE /api/projects/:key` endpoint.
- **Bulk target management**: select multiple deployment targets and delete them at once; CSV target import now maps extra columns to custom target fields (using the header row for names).
- **CSV location import in the New Project form** (name + optional type), which switches the project into multi-location mode automatically.
- Editable **user role** when editing a user (the last administrator still can't be demoted).

### Changed
- Deployment-target edits (add/remove/rename/retype, custom fields, CSV import, bulk delete) now save to the database immediately, instead of only when saving default settings.
- Switching tabs re-fetches that view's data from the server, so changes made by other users appear without a full page reload.
- New projects no longer fabricate a placeholder repository URL for each application; the repository is set later in the Applications tab.

### Fixed
- The manual per-day location breakdown set when planning a rollout is now honoured after saving (targets/day counts and dates), instead of being re-spread evenly.
- A deployment can no longer be scheduled with a start date in the past (the date pickers are constrained to today and the date is validated on save).

## [0.5.0] - 2026-07-12

### Added
- **Single sign-on (OIDC) per e-mail domain**, configured by an admin (Administrator → Single sign-on). Provider-agnostic via [`openid-client`](https://www.npmjs.com/package/openid-client): Microsoft Entra ID / Azure AD (enter the Tenant ID), Google, or any generic OIDC issuer. When a domain has an enabled provider, its users sign in through the identity provider (Authorization Code + PKCE) instead of a password; the login screen detects the domain and offers the provider button. There is no just-in-time provisioning — the account must already exist (created by an admin). New endpoints: `GET/POST/PUT/DELETE /api/sso` (+ `/:id/test`) for admin config, and `/api/auth/sso/lookup|start|callback|exchange` for the login flow. IdP client secrets are stored encrypted at rest (AES-256-GCM, `SSO_ENC_KEY`); a `sso_providers` table is added by a new migration.

### Changed
- For a domain with SSO enabled, **password login is disabled for non-admins** (local `admin` accounts keep password login as a break-glass fallback so a misconfigured IdP can't lock the domain out).
- `APP_BASE_URL` is now also required for SSO (used to build the redirect URI `<APP_BASE_URL>/api/auth/sso/callback`). New `SSO_ENC_KEY` environment variable (falls back to a value derived from `JWT_SECRET`).

## [0.4.1] - 2026-07-12

### Added
- Discreet language switcher in the top bar (next to the profile) and inside the login/setup/invite cards, rendered as understated, icon-less text toggles.

### Fixed
- **Self-service password reset is now real.** The "Forgot your password?" flow calls a new public `POST /api/auth/forgot` endpoint, which issues a single-use reset link (valid 3 days) and e-mails it; the new password is set via the existing `#/invite/<token>` flow. The account e-mail field is editable, and the previous mock "set password" step was removed. (Requires SMTP for delivery; admins can still issue reset links from the Users screen.)

## [0.4.0] - 2026-07-12

### Added
- Hash-based routing: each top-level view is reflected in the URL (e.g. `#deployments`), so the browser Back/Forward buttons work, refreshing restores the current view, and views can be deep-linked/bookmarked. The browser tab title now updates to match the active view (and language).
- Real event notifications: deployment **pause**, **client comments** and **completed** events now actually deliver to the configured client webhooks (Slack/Teams) and, for completion, the project's post-deployment e-mail — via a new backend `POST /api/notifications/notify` endpoint. Delivery is reported per recipient, so partial failures are surfaced to the user (previously these events were only logged). Additional events (**schedule created**, **approval request**, **client decision**, **failure on a target**) are now wired to the same delivery path.
- **Real multi-user management.** The Users screen is now backed by real accounts in the database (`/api/users`, admin only): invite a user (name, role, per-project/client access), and they receive a single-use link to set their own password and enroll TOTP MFA on first sign-in. The link is shown in-app (copyable) and e-mailed when SMTP is configured. Admins can edit, archive/restore, resend invitations and issue password-reset links; archived accounts can no longer sign in, and the last administrator can't be demoted or self-archived. Client accounts created while defining a project (or from a deployment-approval prompt) are now real invited accounts too. Replaces the previous in-memory user roster.
- **Real personal access tokens** for the automation API. Tokens are generated server-side (prefix `rd_live_`), shown once, and stored only as a SHA-256 hash in a new `api_tokens` table. The data API (`/api/deployments`, `/api/projects`, …) now accepts `Authorization: Bearer rd_live_…` in addition to a session JWT, so scripts/CI can authenticate. Tokens can be created (with optional expiry), listed (masked, with last-used), and revoked from the profile; token management itself requires an interactive session. Replaces the previous in-memory mock token list and its fake usage history.
- **CSV import of deployment targets.** Targets can be bulk-loaded from a CSV file (first column = name, second = type). Comma- and semicolon-separated files and UTF-8 are supported; a header row and duplicate names are skipped, and the type is matched loosely (PL/EN) to Production/Non-production. Documented in the Help view.
- Translations are now split into per-language bundles (`frontend/app/i18n/pl.js`, `en.js`) loaded before the app. Adding a language is a matter of copying a file and including it — no longer editing a large inline dictionary in `index.html`.

### Changed
- **No more demo/offline mode.** The frontend always requires the backend (it authenticates and loads all data from the API); there is no in-memory fallback. Docs updated to drop the "connected vs demo" wording and the removed database-connection badge.
- Removed the "Test as" role switcher from the Users screen. Permissions now follow the real signed-in account (from `/api/auth/me`) rather than a manual demo toggle.
- Pausing a deployment now actually halts progress: the installer's confirm/report and "mark the rest" actions are blocked until the deployment is resumed, and the progress badge shows "Paused". The pause-reason dialog now requires a reason (validated in place; pressing OK on an empty reason no longer closes the dialog — only Cancel does).
- The login-screen language switcher was redesigned as compact flag pills (🇵🇱 PL / 🇬🇧 EN) instead of two full-width buttons.

### Fixed
- The Help view and API documentation, the whole profile view (sign-in security, change password, API tokens, sign-in history), the change-history view, and the Users and Clients views are now fully translated to Polish (labels, table headers, dynamically rendered rows, role names/descriptions and action buttons), and re-render on language switch.
- Full Polish translation of the deployment detail/deployer panel and the pause/resume flow: the timeline, the "Schedule created by …" entry (with duplicate i18n keys de-duplicated so placeholders fill correctly), status labels in the progress dropdown, the pause/resume dialogs and badges, the failure-report dialog, the deployment-ID bar (now with right-aligned action buttons), the client-decision prompt, and the target-list description.
- Deployment **status changes are now recorded on the timeline** and in the audit log, and the schedule "created by" entry attributes the **signed-in user** (with a timestamp) instead of a generic "Release Manager".
- The client-decision prompt ("who on the client side made this decision?") now offers a pick-list of the client's known people while remaining free-text.
- Added cache-busting to the i18n bundles so translation updates are picked up without a hard refresh.
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

[0.4.0]: https://github.com/RollDesk/rolldesk/releases/tag/v0.4.0
[0.3.0]: https://github.com/RollDesk/rolldesk/releases/tag/v0.3.0
[0.2.1]: https://github.com/RollDesk/rolldesk/releases/tag/v0.2.1
[0.2.0]: https://github.com/RollDesk/rolldesk/releases/tag/v0.2.0
