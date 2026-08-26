# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.42.2] - 2026-08-26

### Fixed
- **The attached schedule is the schedule the app exports, not a second one.** 0.42.0 attached a document invented for the mail: a day-by-day summary with the release facts and a generated-by line. The deployments view has exported a schedule since long before that — application, version, target code, the project's own per-target columns, date and weekday, one row per target (`buildScheduleRows`, behind the „PDF" and „XLS" buttons) — and the client was being sent something that was almost, but not, the same. Two schedules that nearly agree are worse than either: nothing said which one was authoritative. The attachment is now built from the same rows, with the same title, subtitle and columns, and it takes the export's filename too, so „the schedule you sent us" and „the schedule I exported" are one file with one name. Everything the mail's own generator had added on its own is gone, along with the five i18n keys that described it.
- The weekday in that document is recomputed in the instance's notification language: the on-screen export is titled in the operator's UI language, which is right for a download and wrong for a document leaving for the client.
- The table is drawn on a landscape page with a width cap per column. On a portrait page a six-column schedule wrapped „Kod celu" onto two lines and broke „2026-08-27" across them, and the application column of a five-application release took a third of the width.

## [0.42.1] - 2026-08-26

### Fixed
- **A browser tab left open across an update says so.** The UI is one file, so a tab loaded before the instance was updated keeps composing with the code it downloaded — and that is not theoretical: three client approval requests went out in one afternoon from three different versions of this file, the last of them 68 seconds after the release that started attaching the schedule, without the attachment. Nothing on screen said anything. The version badge now compares what the tab loaded with what the backend reports (`GET /api/version` already carried it) and turns into „⚠ nowa wersja 0.42.0 - odśwież", which reloads on click; the check repeats every half hour, so a tab open all day finds out at all. The confirmation dialog of the client mail says it too, naming both versions, because that is the one message where sending a stale composition reaches somebody outside the team.
- **A sent client mail is logged, with what it carried.** „The client got no schedule" was unanswerable: a successful send left no trace on the server, so a mail composed by a tab too old to send an attachment looked exactly like a mail whose PDF had failed to render. Deliveries now log the subject, the number of recipients and either the attached file with its size or why there is none — the same treatment webhook deliveries have had since 0.30.0.

## [0.42.0] - 2026-08-26

### Added
- **The approval request carries the schedule as a PDF.** The mail describes the release and asks for a decision, but the part the client actually circulates is the schedule — which office gets it on which day — and a mail body is not what gets forwarded to twenty branches or printed and taken to a meeting. Every request now leaves with `Harmonogram-<id>.pdf` attached: title, deployment id and project, the release facts, then a day-by-day table of date and the targets planned for that day, over as many pages as it takes. It is drawn per send rather than stored, because the schedule is edited until the moment it is sent and an attachment a day out of date is worse than none, and it is read through the same helpers as the schedule view (`plannedDayCounts`, `targetCodeAt`, `getDateForDay`) so it says exactly what the app says, including the days the release manager moved by hand and the weekends the project skips. The confirmation dialog names the file and the number of days before anything goes out, the body says the schedule is attached (a reader who prints the mail has to know), and a document that fails to render never blocks the mail: it is sent without it and the sender is told, so they can follow it up by hand.
- Bounds and layout live in one pure module (`backend/src/schedulePdf.js`, unit-tested): 400 rows, 6 columns, one clamp per cell, a filename a mail client cannot rewrite, and a truncated schedule reports what was cut instead of looking complete. The font is committed beside it — the 14 standard PDF fonts are WinAnsi-encoded and have no `ą`, `ę`, `ł`, `ś` or `ż`, so an office named „Oddział Świdnica" rendered in Helvetica arrives with holes in it. DejaVu Sans is embedded as a subset (the whole document is ~25 kB), is redistributable, and being in the image means a bare `npm start` and the container produce the same file.
- New dependency: **pdfkit** (no transitive packages of its own), plus `nodemailer` attachments passed through `sendMail`.

## [0.41.0] - 2026-08-26

### Added
- **The approval request names the release in its subject.** Every one of these mails arrived as „RollDesk - Prośba o akceptację (Produkcja)": the same subject for every rollout of every project, so two requests waiting for a decision could not be told apart in the client's mailbox, a reply quoting nothing named no release, and a reader deciding what to open first learned nothing without opening it. The subject now carries what identifies this one rollout: the deployment id we ask them to quote, the leading application and its version with a count of the rest, the environment and the day it starts (`RollDesk DEP-2026-0075: Kierowca v9.9.9 (+4 aplikacje), Produkcja, start 2026-08-27, prośba o akceptację`). The leading version with a count rather than all five, because the full list is the body's first line and a subject much past 120 characters is cut by the reader's mail client exactly where the start date is. The start date is read by the same helper the body uses, so the two cannot name different days.
- **Who is asked is decided per rollout.** The client's saved addresses opened as a list to edit before the mail goes out, one recipient per line („Name <address>" or a bare address), so a release touching one system can go to the person who owns it and somebody's deputy can be added for this one message without any of it becoming permanent client configuration. Addresses are validated and deduplicated as they are entered, with the same bounds the API applies, so a typo is a message in the dialog rather than a bounce. The copy list stays out of it deliberately: it is our own service mailbox and where the client's reply has to land, which is a setting, not a per-mail choice.
- **A project signs its own client mail.** The request left the instance from a no-reply sender and ended on a link, which reads as machine-generated. Project settings now carry the sign-off appended to it, with **„Insert the default"** to start from a footer that names nobody but says where to change it, so an unconfigured project still sends something a person would write. Stored in the project's JSONB and bounded on both sides (`backend/src/projectMail.js`, unit-tested), because the form is not the only way to reach that endpoint. The signature travels as its own field on `POST /api/notifications/notify` so it lands *under* the link to the rollout, which the backend appends: the message asks the reader to open the deployment and ends in a colon, so the order of message, link and signature is now composed in one place and unit-tested (`mailBodyParts`).

- **The approval request is a laid-out HTML mail.** Its HTML part was the plain body in one paragraph, which is what it looked like: the versions, the fixed tickets, the schedule and the ask all in the same size, and the link to the rollout as a bare URL at the bottom. It is the one message RollDesk sends to somebody outside the team, and it sits in the client's mailbox next to the hand-written mail it replaced. It now arrives as a card: the deployment id as the heading and a link, the release facts under it, the fixes as a table of ticket and description, the changelog quoted in its own box, the ask with a button that opens the rollout (and the address spelled out under it for a client that strips the styling), then the signature. The wording and the language stay in the browser, which composes them as it composes every notification; what a heading, a list or a button looks like is decided on the backend (`mailHtml.js`) — inline styles and tables only, no `<style>`, no image, no script, every person-typed value escaped and every list bounded, all of it unit-tested. The plain-text part is unchanged and still carries everything, so a text-only client loses the layout and nothing else.

### Changed
- **No long dashes in anything a reader sees.** The em dash was the app's separator everywhere — in the UI, in every notification and in the mail to the client — and it is not what people write here. Both dictionaries, the markup and the strings the backend sends (mail subjects, API errors, the PATCH change summary) now use a plain hyphen. Comments in the source keep their own style. Values stored with the old spelling are still read: „no repository" written as a long dash still means empty, and an inbox row filed as „RollDesk — …" still has its prefix stripped in the drawer.

### Fixed
- **The mail no longer goes out silently without its list of fixes.** „These versions fix these tickets" is the whole point of the document, and the list comes from the release package — so a rollout planned without one, or from a package with no issues on it, sent the description alone and nobody noticed until the client could not act on it. The confirmation now says so, naming the package when there is one, while the fixes are still on the deployment's own package and can still be corrected. The fixes themselves are listed one per line as `ticket: what it was`.

## [0.40.0] - 2026-08-26

### Added
- **The client can be asked for their approval by e-mail, from the rollout itself.** „These versions are on the test environment, they fix these tickets, please approve the production rollout" was written by hand in Outlook for every release — while RollDesk held every fact in it: the versions from the package, the issues with their titles, the schedule, and the link to the rollout. The approval request it did send reached the client portal and our own Teams channel, which is not where that conversation happens, and the notice on the schedule form claimed an e-mail went out that never did (both strings now say what actually happens). A deployment waiting on a client's decision has an **„Ask the client"** button next to the reminder: it composes the message — id and project, the application versions, environment, target count and start, then the fixed issues one line at a time with what each of them was, the release description, and the ask — and sends it. Sent on a button rather than automatically because which rollout is worth asking about, and when, is a judgement: the test environment has to be in and checked first, and a client mailed on every published schedule stops reading them.
- **A client carries the addresses that message goes to.** Two lists in the client editor, because the message has two audiences with different jobs: the people at the client who are asked to decide (To), and our own side — a service-management or escalation mailbox — copied on it (Cc). Kept on the client rather than on each project, because it is the same people whichever of their projects is going out. The clients list says which clients can be asked at all, so „nobody is on the list" is visible without opening each one.
- **The copy list is also what the client's reply reaches.** The instance sends from a no-reply address, so a client who simply presses Reply — which is how these answers actually arrive — would have been answering nobody. The copied addresses are set as `Reply-To`, deliberately not as a third setting an operator has to keep in step by hand: an answer landing in the wrong mailbox is silent, because the client believes they replied. With no copy list the mail says nothing about replying, and the confirmation says why before it goes out.
- The whole audience gets **one message** rather than one per address, so the recipients are on a thread with each other and the service mailbox holds one copy instead of five (`groupEmail` on `POST /api/notifications/notify`, with `cc`; every other event still sends per mailbox, unchanged). An address that is on both lists is addressed, not also copied; a malformed address is reported rather than dropped, because an address missing from a mail the client is expected to answer is only discovered when the answer never comes. The rules are pure and unit-tested in `backend/src/clientMail.js`, and the send is recorded on the deployment's timeline and in the audit trail — „we asked the client on this date" is what the rest of the process leans on while a rollout waits.

## [0.39.0] - 2026-08-26

### Added
- **The new-deployment form lists the issues the release fixes, not just the versions.** The order of a rollout is planned from the issues — the office waiting for a fix must not be the last one to receive it — and the form said „fixed issues: 7", which is a number nobody can build an order from. Under the applications there is now the package's issue list as everyone else reads it: the service-desk ticket, the work item behind it, its title and the office that reported it, each id linked into its tracker. It is read live from the package, read-only like the versions above it, and a release that lists no issue says so instead of showing an empty panel. Until now the only ways to see this while planning were to open the packages view in a second tab or to read the mail announcing the handover — and on an instance with e-mail notifications switched off, the second one does not exist.
- **The generated schedule says which issue each target reported.** The reporting offices were already lifted to the front of the rollout (0.23.0), but nothing in the preview said why, so the order looked arbitrary and the release manager reordering it by hand was working blind. Every production row that reported one of the fixed issues now carries its ticket ids under the target name, with the issue titles in the tooltip — and because the preview's search reads that cell, a ticket id now finds the target waiting for it.
- **An office that matches no target is called out on the issue it came from.** The office is read off the service-desk ticket and a target is registered under whatever name the project uses, so the two agree only when the spelling does — and a name that does not match is silently not moved up. The row now says so, next to the office it concerns, including when the office is simply outside the targets this deployment was narrowed to. Only on a path with a production step: a test-only rollout goes to one instance and has no order to influence.

## [0.38.0] - 2026-08-25

### Fixed
- **The deployer's panel says what is being installed.** On a rollout of one application released as a set of services — „Portal e-Usług", eighteen containers — the report was two buttons, „Confirm installed" and „Report failed", and nothing on the page named the eighteen versions the deployer was being asked to vouch for. The list existed, but only behind a collapsed `🧩 Serwisy` button in the action bar, and on a single-application rollout the form itself said nothing at all: the only way to find out what was going out was to open the release package. The services are now on screen in the panel — as a checklist where the deployer is reporting, and as a panel that starts open everywhere else in the deployer's view (a rollout awaiting the client, a batch rollout reported per target, and any rollout a reader opens).
- **A rollout planned before its package listed services now shows them anyway.** The service list is copied onto a deployment when it is planned, so a package that had its eighteen services ticked *afterwards* — or one assembled before packages carried services at all — left the rollout with an application and no services, and the panel had nothing to show. The deployment falls back to its package's list, matched by application name *and* version. Only the gap is filled: a deployment that carries its own copy keeps it, so correcting a package for the next release still cannot rewrite what went out, and a package since bumped to a newer version does not lend its services to a rollout of the older one.
- **„Partly installed" is counted in whatever the rollout was reported in.** A release of eighteen containers with seventeen up was labelled „0 of 1 applications" — true of the application, and read by everyone as a rollout that achieved nothing. The figure now says „17 of 18 services" wherever it appears: the deployer's row and report, the outcome badge, the client's badge, the timeline, the toast, the audit trail and the Teams/e-mail notification. A rollout that mixes a set of services with an ordinary application keeps the application count, which is the only unit both halves can be counted in.

### Changed
- **An application released as a set of services is reported service by service.** 0.34.0 kept the report per application on the grounds that „Portal e-Usług installed" is the answer the process asks for — which is right about the answer and wrong about the work: eighteen containers go out one at a time, and the ordinary failure of such a release is that seventeen come up and one does not (a missing image, a secret, a migration). The panel now lists every service with its version and a tick, all of them ticked to begin with, so confirming that the whole release went out is one press of **Wszystkie** on the application rather than eighteen clicks — and unticking is reserved for what actually did not come up. Which containers are still owed is then a fact on the record: named in the timeline, in the notification and in the summary a reader sees, instead of „Portal e-Usług failed" sending the next deployer to install all eighteen again.
- The process answer is unchanged and still **derived, never typed**: an application is „installed" only when its whole set is in, and a set that disagrees makes the deployment „partly installed" even as the only application on it. The rule lives in `backend/src/appProgress.js` with its tests, mirrored in the browser and pinned to the module by `appProgressMirror.test.js`, so the panel and an automation caller land on the same status.
- `appResults` entries carry an optional `services` list (`{name, version?, status, reason?}`) in the deployment's `data` JSONB, so this needed no migration. A `PATCH` that contradicts itself — an application called „installed" beside a service that failed — is refused with a 422 rather than quietly corrected, the same rule the rest of the module follows. A release manager setting a status by hand rewrites the service lines with it, so the record it leaves is one the API would accept.

## [0.37.0] - 2026-08-25

### Added
- **A project can be moved to another client.** Until now the client was decided when the project was created and never again: a delivery taken over by another company, two clients merging, or simply the wrong client picked on day one left one way out — delete the project and create it again under the right client, which throws away every deployment ever recorded against it. The project editor has a „Client" card with the client picker and a „Move project" button; the project keeps its applications, targets, deployment defaults, tracker configuration, release packages, deployments and the whole history, and appears under the new client in the tab strip, the Clients view and every filter. Administrators only, because which client a project belongs to decides who may read it.
- **Moving a project revokes the client-side access granted for the previous client.** The accounts on the „Client-side access" card belong to the client the project used to be delivered for, and after a move their grant would be a window into another company's rollouts — as often as not a competitor's. The move and the revocation happen in one database transaction, the confirmation dialog says how many accounts will lose the project before anything is changed, and the toast afterwards says how many did. Our own deployers, testers and project managers keep their assignments: for them the grant is a work assignment, not a client's view of their own data. Access for the new client's people is granted afterwards on the same card, deliberately not automatic — being a client of ours does not mean everyone there should see the rollouts.

### Fixed
- **A client account can no longer read a project that belongs to a different client, even if it still holds a grant for it.** The scope of a client account was its list of granted projects alone, so a grant left behind by a move — one re-added by hand, or a move interrupted half-way — was enough to read another client's deployments, packages and attachments. Every read for a client account is now intersected with the projects that actually belong to that client (projects with no client recorded are unaffected, so nothing that worked before stops working). The same reason a whole-project save no longer changes the client of an existing project: a browser tab that loaded the project before it was moved held the old client, and saving anything from it — a renamed target, a new application — would have quietly moved the project back with nobody's access revoked. The client changes through the move only.

## [0.36.0] - 2026-08-22

### Changed
- **All three deployment lists now open a rollout the same way: as a page of its own.** The release manager's list had that page, and 0.35.0 replaced it with a row that expanded in place — which turned out to be the worse of the two: the detail carries a day schedule, a target queue and a timeline, and inside a table cell each of those became a scroll pane nested in a scroll pane. The page is back, and the deployer's panel and the client's portal — which had always expanded their rows — now do the same. One interaction for „open this rollout", so somebody who works in two of these views does not carry two mental models. Every page has the same chrome: „← Back to the list", and the row it came from as a heading (applications and versions, then project · environment · date) — a page opened out of a list has to say which row it is. Escape closes it in all three, switching views in the rail closes it, and the scroll offsets of the day plan and the queue survive the re-render that every edit inside the page causes.
- With the list off screen while a deployment is open, **the package is named again on the action bar** — id, name and a copy button, for every role rather than only the ones that may edit it. Nothing repeats it there now, which is what made it redundant while the row was visible. The client's page carries the same line, since the id heads the fixed-issue list they read.

## [0.35.1] - 2026-08-22

### Added
- **The package id in a deployment row can be copied with one press.** The same button the packages list has, on the id where it is actually read from: somebody asking about a rollout needs the handover it came from, and „PKG-2026-0036" was being retyped into mails by hand. Present in the deployments list, the deployer's panel and the client's portal — every list that names the package a rollout was planned from.

## [0.35.0] - 2026-08-22

### Changed
- **A deployment opens under its row again, instead of replacing the list with a page of its own.** The page put the record and the list it came from on two screens: a reader who had filtered forty rollouts down to find one had to close the page to glance at the next row, and the list came back scrolled to its top. The row expands in place — the same interaction as the deployer's panel, the packages list and every other expandable row in the app, so „click a row to see it" now means one thing everywhere. Clicking the row again closes it, Escape still closes it, and a `#deployments/<id>` link opens the row and scrolls it into view instead of landing on a page. The heading the page used to print (project, applications, date) was the row's own content, so the detail starts straight at the action bar. The scroll offsets of the day plan and the target queue are preserved across the re-render that every schedule edit causes, exactly as they were on the page.
- **The package id in a deployment row now carries the package's name** — „📦 PKG-2026-0036 · Sierpniowy hotfix". The id is what gets quoted in a mail and the name is what people say out loud; a row that showed only the id made the reader open the package to find out which one it was.
- **The browser tab reads „RollDesk : Wdrożenia"** rather than separating the view with an em dash, which in a narrow tab was read as part of the product name.

### Fixed
- **The package id is no longer printed twice, a centimetre apart.** With the deployment open, its action bar repeated the „📦 PKG-…" that the row directly above already showed, which read as two different packages. The bar keeps only the way through to the package — the „Edit the package" shortcut, which is offered to the roles that may open one — and names the package in its tooltip.

## [0.34.2] - 2026-08-22

### Fixed
- **Selecting text in a list row no longer throws the selection away.** Copying a package id off the packages list was impossible: every row opens its detail by clicking the row itself, so releasing the mouse after dragging across the id counted as a click, the row's timeline opened, the whole table was re-rendered — and the selection pointed at nodes that no longer existed. The highlight vanished at the moment of letting go, before anybody could press Ctrl+C. A click that ended a text selection is now not treated as a click on the row, which is safe to decide from „is anything selected" because the browser collapses the selection on mousedown: an ordinary click always reaches the handler with nothing selected. Fixed for all six lists that open on a row click — packages, applications, API tokens, and the deployments list in the release manager's, the deployer's and the client's view — rather than only where it was reported.

### Added
- **A copy button beside the package id in the packages list.** The id is the string every other view, every export and every mail quotes a release by, so it is the value most often carried out of the app by hand; the deployment id has had this button on its action bar for a while, and the id that heads a package row did not. Icon only, with the label in the tooltip.

## [0.34.1] - 2026-08-21

### Fixed
- **A dialog raised from a form now opens in front of it, not behind it.** „Wklej listę" in the package editor put its window *under* the editor: the prompt was at `z-index:999` and the form modals at `1002`, so the dialog that had the keyboard focus was invisible and the page looked frozen. The prompt and the confirmation are second-level — they are raised *by* the forms — so they now sit above all of them (`1011` and `1010`), and the layering is written down next to them.
- The same bug was hiding a confirmation nobody could answer: **adding an application to a rollout that is already running** is confirmed from inside the edit-deployment dialog, and that confirmation was at `1000` under the dialog's `1001`. Saving appeared to do nothing.
- **Escape in a prompt no longer closes the form behind it.** The form-modal handler did not check for an open prompt, so cancelling the paste dialog dismissed the package editor with it — and the draft went too.

## [0.34.0] - 2026-08-21

### Added
- **An application can be released as a set of services, each with its own version.** „Portal e-Usług" is nineteen containers cut from one release — seventeen at `2.7.0-dev.27504` while the frontend is still on `2.6.0-dev.27503` — and a package row carrying one application and one version could not say that. It was not expressible by adding the application nineteen times either: the name is the identity everywhere downstream (the install report, the per-application progress, the client's changelog, the worklist), so nineteen rows would have multiplied every one of them. The services now hang off the application, and the release stays one row.
- **A service inherits the release version unless it says otherwise.** The version box on a service is optional and its placeholder names what it will inherit, so the normal case — one train version, a couple of stragglers — is one version typed once and an override where it differs. What is stored is only the difference, which means correcting the release version afterwards still reaches every service that was not deliberately pinned away from it. „Portal e-Usług v2.7.0-dev.27504" therefore stays true everywhere it was already printed.
- **Nothing is selected by default, and only the selected services go out.** A release is as often one service out of nineteen as it is all of them, so the list is opt-in with **Wszystkie** / **Żaden** one press away — a pre-ticked list would have quietly claimed eighteen services were going out because nobody went through it. Filling in every service is never required.
- **The list of services is named once, on the application in its project** (one per line, `:tag` allowed and dropped — the version belongs to a release, not to a catalogue), and a package then only ticks. A service the catalogue does not know can still be added inside the package, so a new service in a release does not block a tester, who cannot edit the project. A service the project has dropped stays on the packages that were assembled with it.
- **The image list can be pasted.** `📋 Wklej listę` takes what a pipeline prints — `pudo/auth-service:2.7.0-dev.27504`, one per line — ticks what it matches (ignoring any registry path in front of the name), adds what it does not, makes the version most of the list shares the release version when none was typed, and leaves only the ones that differ on their rows. That paste is where these versions come from; retyping nineteen of them by hand is the work this replaces.
- **Where the services are read:** a `🧩 Serwisy · 18` panel in the action bar of the deployer panel and of the deployments list, with the pinned versions marked and the inherited ones greyed; the count on the application in every list that shows one; the schedule form naming the pinned versions before the rollout is planned; a collapsed block in the client's portal; and the count plus the exceptions in the Teams/e-mail notification — the count and what differs, not nineteen lines of the same string in a message that is cut at 1200 characters anyway.
- The project manager's approval is **cleared by a change to the services**, exactly as it is by a change to a version: dropping one, adding one or pinning one is a different release from the one that was cleared.
- Reporting the install stays **per application**: the deployer installs the set, and „Portal e-Usług installed" is the answer the process asks for. The service list is what tells them what the set is.

## [0.33.1] - 2026-08-21

### Fixed
- **A changed role takes effect at once, without signing out.** Two testers were promoted to administrator so they could run RollDesk over a holiday, and afterwards they saw almost nothing — an administrator's navigation over a tester's permissions, every screen behind it answering 403. The session JWT carried the role it was minted with and `SESSION_TTL` is **30 days**, while the UI reads the account from `/api/auth/me`, i.e. the database: the change was applied on the half that hides controls and not on the half that enforces them. Signing out and in again fixed it, which is exactly the workaround nobody should need. A session now acts with the role the *account* has — read per request, next to the project scope that was already read that way, and the same way the `rd_live_…` token path always worked.
- The other direction was the more serious one: **taking a permission away now takes it away.** An administrator demoted to tester (or moved off a project) kept an administrator's writes for as long as their session lasted — up to a month — because nothing re-checked the token's claim. The same lookup closes it, and an account archived while a tab is open is signed out on its next request instead of being left with a working session.
- **The tab notices, too.** A role or project-scope change reaches an open tab within a minute: the navigation and the current view are re-applied, the rollouts and projects are re-read, and a message names the new role — so „you are an administrator now" arrives where the person is, rather than the next time they happen to sign in.

## [0.33.0] - 2026-08-21

### Added
- **A tester sees the deployment schedules.** The role could reach the packages list and nothing else, so the people who assemble a release had no way to learn when it goes out — they asked. The **deployer panel** is now open to a tester as a reader: the rollouts of the projects they were granted, with the dates, the deployer instructions, the changelog, the per-day schedule, the XLS worklist, the progress and the results that were reported. Read-only, and not by hiding buttons: reporting a result, correcting one, assigning a deployer and commenting are all writes the API refuses for this role (`requireWriteRole` is admin / release manager / deployer), so the panel leaves them out rather than offering something that would come back a 403. The panel's own description says which of the two panels the reader is in.
- A „rollout finished" notification now **opens the rollout for a tester too**. Those cards are filed for the role (`completed`, `failure`), but the id was routed to whichever view the role had — the packages list, which does not contain deployments — so following one landed on a list without the record it named. It routes to the deployer panel now, and every other role is unaffected.

### Changed
- **Reading a notification clears it.** The bell's count only ever went down when somebody pressed *Mark all as read*: opening the drawer changed nothing, and neither did opening the one notification you came for — so the badge kept saying 7 to a reader who had read all seven, which is a badge that stops being read. Two things clear a card now: **opening it** (the record it is about is what dealing with it means), and simply **having had it on screen** — everything rendered while the drawer was open is marked read when the drawer closes. The badge answers „arrived since you last looked" instead of „never pressed the button", and *Mark all as read* stays for the rest: anything older than the page being shown, the „I have been away for a week" case.
- The unread mark itself is unchanged while the drawer is open, because that is what makes the new cards findable in a list that also holds ninety days of archive — and **↺ still means „I am not done with this"**: a card put back is remembered for as long as the drawer stays open and survives the clearing on close, so the one gesture that protects a rollout you have to come back to after lunch is not undone by closing the drawer.

## [0.32.1] - 2026-08-20

### Fixed
- **The ℹ hover help is shown once.** Every info icon carried the same sentence twice — the application's dark popover and the browser's own tooltip, drawn on top of it, so the dark copy sat behind the light one and neither could be read. The `title` was there because the popover, being a child of the icon, was clipped by the scrolling panel around it (the tall "New deployment" form), which made the help look like it did nothing. The help text now lives in a single floating layer under `<body>`, positioned in viewport coordinates and flipped above the icon when there is no room below, so nothing can clip it and the native duplicate is gone. The sentence stays available to a screen reader as the icon's accessible name — the visible glyph is only "i". The same fix applies to the compact **P / NP** badges, whose "click to change" hint now sits inside the one tooltip rather than in a second one beside it.

## [0.32.0] - 2026-08-20

### Added
- **A link to a build that cannot be opened says so before it is saved.** „Pobranie paczki nie działa" turned out to be Azure Storage answering `PublicAccessNotPermitted`: the build links point at `…blob.core.windows.net` with no SAS token, and public access is switched off on those accounts by policy — so the browser refuses and it reads as a fault in RollDesk. The package editor now flags an Azure Storage address without a token (`…?sv=…&sig=…`) as it is typed, and the deployer's build chip is marked rather than opening a page that says the package cannot be downloaded. RollDesk cannot mint the token — it belongs to the storage account — but it can stop the link from travelling silently.
- **A release that has gone out leaves the packages list.** The list grew by a row per release for ever, so a hundred packages stood between the test team and the two they were working on. It now opens on **W toku** — everything except the releases already deployed — with **Wdrożone** one click away, next to the existing Draft and Handed-over filters and *All*. A deployed package carries a green **Wdrożony** badge naming the rollout that did it and its date, so it is recognisable when somebody does go looking for it.
- The state is **derived from the rollouts, never stored**: a package counts as deployed once one of its rollouts has finished, using the same predicate the deployments list and the deployer panel use for their *completed* bucket — so the three cannot disagree, and there is no third status to keep in step with what the deployers report (`draft`/`ready` remains the test team's own path and the approval remains the project manager's decision).

## [0.31.3] - 2026-08-20

### Changed
- **The packages list reads like the deployments list.** The row opens on the same chevron, in the same place, rotating the same way — it had a caret of its own that read as a bullet. And the id leads with the name in bold underneath it, rather than the other way round: the id is what every export and every other view refers to, the name is what people say out loud.

## [0.31.2] - 2026-08-20

### Changed
- **Package names are `słowo-słowo` in lower case** (`zardzewiały-żubr`) rather than a capitalised phrase: the name sits next to an id and is used as a handle — pasted into a chat message, a branch name, a file name — and a space in the middle is a nuisance in every one of those. A name typed by hand in the old shape still counts as taken, so nothing can end up with two spellings of one name.
- **A name for every release that never had one.** `npm run name:packages` (with `--dry-run`) names the packages assembled before names existed, oldest first, without touching the ones already named or moving anybody's `updated_at`. Idempotent, so it can be run again after the next import.

### Fixed
- **"The project manager approved it and it still says waiting."** Pressing *Approve* opened a comment box whose confirming button said only **OK**, so dismissing it — with Escape, the backdrop, or Cancel — silently cancelled the approval that opened it. The button now says **Approve**, and the comment stays optional.
- **An edit that invalidates an approval says so.** Changing the applications or their versions drops the project manager's approval (they cleared a specific build) and the API has reported that since 0.30.0 — but the editor said nothing, so a corrected version quietly put the release back into *waiting*. Saving now warns that the release has to be approved again.
- **The approver's name appears on the row without a reload.** The approve and withdraw responses go through the same shaping as the packages list, which is what resolves an address to a display name.

## [0.31.1] - 2026-08-20

### Changed
- The control that asks for another package name is a **circular arrow (↻)** beside the name field rather than a die — the same glyph the work-item lookup uses for "read this again", which is what the button does.

## [0.31.0] - 2026-08-20

### Added
- **A rollout can say that no client sign-off is needed, without hiding it from the client.** Those were one checkbox: "internal deployment" both hid the rollout from the client *and* waived the approval, so a rollout the client had already agreed to out of band still sat in the deployer's *waiting for the client* bucket — and the only way to let them install was to record an approval that never happened. The schedule form now has **No client sign-off needed** next to the internal flag: the rollout stays visible in the portal, nobody is asked for a decision, no approval request is sent, and the deployer can install straight away. Every view reads the flag, so the record says *approval not required* instead of showing an empty decision.
- **The notification drawer is something you can act on.** Each card carries an **✕** that marks it read (and a **↺** that puts it back — "I am not done with this" is a real state), plus *Mark all as read* for a week away. The drawer opens on **New**: the ten newest that have not been dealt with, with everything else — cleared, or older than those ten — one click away under **Archive**. Opening the bell no longer marks everything read behind the reader's back, which was the worst of both: a badge that went quiet while the list still showed ninety days of history.
- **Whoever is blocked by the approval gate can ask for it.** An unapproved package shows **Ask for approval** to everyone who cannot approve it themselves; it sends the handover notification again, marked as a reminder and naming who is asking. Until now the only lever was to walk over to the project manager's desk.
- **An application can be added to a project from the deployment editor.** The application a schedule missed is regularly one the project never had, so *add another application to this rollout* could not stop at the applications that already exist. The same dialog opens from the rollout being edited, for its project, and the new application goes straight onto the rollout.

- **A release package is born with a name.** `PKG-2026-0031` is an identifier, not something anybody says at a stand-up, so releases were being called "ten pakiet z wtorku" — which stops working the moment there are two. A new package now arrives already named (*Zardzewiały żubr*, *Solidne jezioro*), a different name every time and never one already in use; type over it whenever the release deserves its own name, and press 🎲 for another. The names are generated server-side because that is the only place that knows every package in the instance, and the word lists live in one pure module with its grammar under test — a Polish adjective agrees with its noun, and „zardzewiały sowa" is not a name. The list shows the name in bold with the id under it, which is the order they are read in.

### Changed
- **The timeline and the notification cards name people, not e-mail addresses.** The address stays in the record — it is the stable identity, and a renamed person must not rewrite history — but the display name is resolved server-side and is what is shown. The project manager's approval comment is quoted on the package timeline, where the decision it explains is.
- **"Ready" no longer claims a release manager may use the package.** It says *Handed over — waiting for the project manager's approval*, which is what the status has meant since 0.30.0.

### Fixed
- **A work item is no longer chosen for somebody who is still typing its id.** `81989` passes through `8198`, which is itself a real work item, so the automatic lookup filled the row with the wrong bug mid-number — and Enter took the first suggestion whether or not anybody had looked at it. Suggestions are now navigated with ↓/↑ and taken only when one is highlighted; the row is filled when a suggestion is picked, when the field is left, or when ⟳ is pressed.

### Notes for operators
- **Webhook deliveries are logged**, both accepted and rejected, with the target's host, the subject and the response body on a failure. "The comment never arrived in the Teams channel" was unanswerable before: the browser showed a toast whoever pressed the button may not have read, and the server kept no trace, so a webhook that had started rejecting one kind of message looked exactly like a webhook nobody had triggered. The URL itself is never logged — these carry their own signature.
- The `noApproval` flag lives in the deployment's JSONB; nothing to migrate, and an older client simply does not set it.

## [0.30.0] - 2026-08-20

### Added
- **A release is cleared for deployment by the project manager, and nothing can be planned from it before that.** The process always had this step and RollDesk never did: the test team handed a package over and a release manager planned a rollout from it, while the decision on whether that release goes out at all happened in a mail thread. A handed-over package now says **Awaiting the project manager** and carries an **Approve** button for them, with an optional comment for the team ("only after the maintenance window"). Until it is approved the schedule form will not plan from it — the package stays visible in the picker, disabled, with the reason on the row, because a package that silently vanishes is what sends somebody hunting through the list. The rule is enforced by the API and not only by the form (a script with a personal access token has the same gate), and the approval can be withdrawn again for a release that is cleared and then stopped. An approval survives a correction to the description, the notes or the issue list, and is **dropped when the build changes** — an application added, a version bumped, the test-only flag set — because that is no longer the release that was cleared.
- **A new role: Project Manager.** A role of its own rather than a release manager with an extra button: the two are different people here, and a PM given a release manager's account would get every write in the application. A project manager sees the packages and the rollouts of the projects they were granted (scoped like a deployer or a tester), approves releases, and writes nothing else. An administrator can approve as well, so a single PM being away is not a stopped process.
- **The notifications follow the new order.** *Release package handed over* now goes to the project manager, whose decision it is waiting for — it used to go to the release manager, who could then plan a rollout from a package nobody had cleared. A new event, **Release package approved for deployment**, goes to the release manager and the deployer: that is the moment the rollout can actually be planned. Both are in the bell drawer for everyone the routing names, in the browser notification for the roles that act on them, and in the per-client webhook catalogue.
- **A package opens its own timeline.** Clicking a row in Packages expands the life of that release: when it was created and by whom, when it was handed over, when the project manager cleared it (with their comment), and which rollout picked it up, with the rollout's planned start. All of it was already recorded and none of it was visible — "when did the PM approve this" was answered by asking the PM.
- **A work item fills itself in while the id is typed.** Entering an id and then pressing ⟳ (or clicking into another field) was the wrong way round: the tester reads a number off the board and wants to be shown which work item it is. Typing two or more digits now offers matching work items — id, title, type, state and the tracker project — the way the tracker's own search box does, and picking one (or pausing on a complete id) fills the ticket, the office, the title and the state by itself. The manual refresh still works, and typing the ids by hand still works when the tracker's search service is unavailable or the instance is not on hosted Azure DevOps.
- **An application can be added to a project from the package editor.** Assembling a package is where somebody notices that an application was never added to the project — and it meant leaving the half-filled package, going to Projects, adding it, and starting again. The same dialog now opens from the application list in the package editor, for that package's project, and the new application lands on the row that asked for it.

### Changed
- **A project names several tracker projects, not one.** One product's bugs are commonly filed across two or three projects of the same Azure DevOps organisation (the main application, the e-services portal, the next major version), and a single configured project meant every id from the others fell through to the organisation-wide route — which a project-scoped access token answers with 403. The setting is now a comma-separated list, tried in turn before the organisation-wide fallback, and **a refusal on one project no longer ends the lookup**: the next project may hold the item. The status line in the project settings and in the package editor names every project an id will be searched in.

### Notes for operators
- Migration `013_package_approval.sql` marks every package **already handed over** as approved, flagged as done automatically during the upgrade (the UI says so, since those records name no approver). A gate that retroactively blocked releases waiting to go out this week would stop the process on the day of the upgrade — it applies to what is handed over from now on.
- The new role is a value in the existing `role` column; no schema change, and an account can be moved to it in Users.
- Existing tracker settings keep working untouched: a single `azureProject` is read as a one-entry list, and the list is stored alongside it so a downgrade still finds a configured project.
- Work-item suggestions use Azure DevOps' **search** service (`almsearch.dev.azure.com`), which is a separate service with its own permission — a token that can read work items is not guaranteed to be allowed to search them. When it refuses, or the organisation is not on hosted Azure DevOps, suggestions are absent and the id lookup is unaffected. The backend needs outbound HTTPS to that host for the feature to work.

## [0.29.0] - 2026-08-20

### Added
- **A notification drawer in RollDesk itself — the bell in the top bar.** Every channel RollDesk had delivered somewhere else: a webhook post into a Teams channel, an e-mail into a mailbox, a browser notification onto the screen for a few seconds and then nowhere. So "what happened while I was in a meeting" had no answer inside the application, a notification dismissed by accident had never existed, and an instance with no webhook configured told its own team nothing at all. The bell keeps the record — the count of what is new, and the list of what happened, newest first — and the browser notification goes back to being only the interruption. **A card opens the record it is about**: a click (or Enter) on a notification about a rollout opens that deployment, and one about a release package opens that package, so nobody reads an id in the drawer and then searches a filtered list for it. Escape, the × or the page behind it closes the drawer.
- **The drawer records more than the browser notification interrupts about, and records it even when the interruption is switched off.** All sixteen events of the catalogue are filed, including the ones deliberately left out of the push routing because a phone that buzzes for a daily report gets its notifications blocked within a week — the daily installation status, a corrected install, a comment, an approval request, a package created, a rollout completed. And unticking an event on the account page now means "do not interrupt me", not "do not tell me": the row still appears in the drawer. What the drawer does not relax is who may be told what — the routing is the same server-side authorization as the push (`backend/src/inboxTargets.js`, pure and unit-tested): a deployer or tester only ever sees the projects they were granted, an administrator sees everything, nobody is told about their own action, and **client accounts have no drawer at all** — the bell is not shown to them and the endpoints refuse them.
- **A release package has an address.** `#packages/<id>` opens that package, the way `#deployments/<id>` has always opened a deployment — it clears the filters that could be hiding the row and highlights it. Browser notifications about a package now land there too, instead of opening the app's front page and leaving the reader to find it.

### Changed
- **An event with no webhook, no e-mail and no push still reaches the team.** The browser used to stay silent when a project had no channel configured, which meant an instance without webhooks, SMTP and a VAPID keypair notified nobody about anything. Every dispatch is now filed in the recipients' drawer server-side, and the confirmation says what actually happened ("recorded in RollDesk for 4 people") instead of "sent (0)".

### Notes for operators
- Migration `012_notifications.sql` adds the `notifications` table (one row per recipient, so the unread count is an indexed count rather than a scan). Additive: a downgrade leaves it in place and unread.
- The drawer is a recent-history view, not an audit trail — filed notifications are **deleted after 90 days**, swept on write. The change history remains the append-only record.
- Notification bodies are stored as the sender's browser composed them, in the instance's notification language (`NOTIFY_LANG`) — the same text every other channel receives. Only the event label and the drawer's own furniture follow the reader's UI language.
- No new dependency, no new environment variable, and nothing to configure: the bell works on an instance with no webhook, no SMTP and no VAPID keypair.

## [0.28.1] - 2026-08-19

### Changed
- **RollDesk asks for notification permission on sign-in instead of waiting to be found.** The events were already on by default for every role — what was missing was the browser's own consent, and nobody grants that by browsing to a settings card. A dialog now appears shortly after signing in, naming the two or three events this account would actually receive ("you will be told when a package is handed over" is why someone says yes; "turn on notifications" is not), and the browser's prompt follows only if the answer is yes. Answering "not now" costs nothing and is re-asked a week later; it is deliberately not re-asked on every sign-in, because that is precisely what teaches people to click the fastest dismissing button — which on the browser's own prompt is **Block**, and Block is permanent and unaskable by any code afterwards.

### Notes for operators
- **An application cannot grant the browser's notification permission.** There is no API for it, by design: `Notification.requestPermission()` is only honoured from a user gesture (Chrome, Edge and Safari reject a call made on page load; Firefox ignores it), the prompt can be answered only once, and Chrome shows a muted bell instead of a dialog for sites with a low acceptance rate. Asking through our own dialog first is what protects that single chance.
- The only way to make notifications genuinely non-optional across a fleet is a **managed browser policy** pushed by Intune or group policy — `NotificationsAllowedForUrls` for Chrome and Edge, `Permissions.Notification.Allow` in `policies.json` for Firefox, set to the instance's own origin. With that in place no prompt appears and the subscription is created on the first sign-in. `.env.example` carries the exact keys.
- Two limits no policy removes: notifications require HTTPS (a service worker needs a secure origin), and Safari on iOS/iPadOS delivers Web Push only to a site added to the Home Screen — a normal tab there cannot receive it.

## [0.28.0] - 2026-08-19

### Added
- **Browser notifications, routed by role.** A notification left RollDesk only as a webhook post or an e-mail, and both are read where the recipient happens to be looking — so the two moments that actually start work were discovered by opening the app: a package handed over for scheduling, and a schedule ready for whoever will install it. Those two now reach the people who act on them as a native browser notification, which arrives with the RollDesk tab closed as long as the browser is running (Web Push, VAPID). Six more events join them because not knowing them blocks work or costs a wasted trip: the client signing off on a schedule, a deployer being named on a rollout, a target's date moving, a distribution being paused, a failure on a target, and a client rejecting or commenting on a schedule. A release manager, a deployer and a tester each get the subset their role acts on; an administrator sees all of it, because a single-role account that both administers and installs would otherwise hear about nothing. The routing is server-side (`backend/src/pushTargets.js`, pure and unit-tested) because who may be told what is an authorization question: a deployer or tester is limited to the projects they were granted, and **client accounts are excluded entirely** — they have the portal and e-mail, and our operational traffic is not theirs to be interrupted by. Nobody is notified about their own action. Deliberately narrower than the webhook catalogue: a daily report per rollout, or a comment, would train people to block notifications for the whole site, so those stay on the channels they were already on.
- **Notification settings on the account page.** Enable or disable notifications per browser (a subscription belongs to a device, so the office machine and the laptop are separate), tick the events you want, send yourself a test, and revoke a device you no longer use. An untouched tick means the default for your role, so an event added later reaches you instead of being silently muted — the same rule the per-client webhook map follows. The card explains itself when it cannot work: an unsupported browser, a page served over plain http (a service worker needs a secure origin), permission blocked in the browser's own settings, or an instance with no VAPID keypair configured.

### Changed
- **An event with no webhook and no e-mail on file is no longer reported as a failed dispatch.** It may have reached people as a browser notification, and a red toast on a delivered event is worse than no toast.

### Operations
- Browser notifications are **off until an operator generates a VAPID keypair** (`npx web-push generate-vapid-keys`) and sets `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`; with either missing the app behaves exactly as it did before the feature existed. See `.env.example`. Rotating the pair invalidates every stored subscription, so every browser has to be re-enabled — which is why it is not derived from `JWT_SECRET`.
- The backend needs outbound HTTPS to the browsers' push services (`fcm.googleapis.com`, `updates.push.services.mozilla.com`).
- Migration `011_push_subscriptions.sql` adds the subscription table and a `notify_prefs` column on `users`. Both are additive; a downgrade leaves them in place and unread.
- New backend dependency: `web-push` (9 packages transitively). The payload has to be encrypted per subscription (RFC 8291) and the request signed as a VAPID JWT (RFC 8292); Node has the primitives, but the composition is exacting and getting it subtly wrong means notifications that never arrive.
- nginx serves `/sw.js` with `Cache-Control: no-cache` — the browser compares the fetched bytes against the installed worker to decide whether to update, so a cached copy would pin an old notification handler in place.

## [0.27.0] - 2026-08-19

### Added
- **An install is reported per application, and a half-finished one can say so.** A deployment installs a list of applications, but the record only ever said whether *the deployment* succeeded — so an install where the server stopped answering after the second of four applications had no honest answer available. The deployer had to call the whole thing installed or failed and put the truth in a comment. A single-target rollout carrying more than one application is now reported as a row per application: tick the ones that went in, give one reason for the rest, save. The deployment's own status follows from that — installed, failed, or the new **partly installed**, which carries the count ("2 of 4 applications") wherever the status is shown. A partly installed rollout stays in the deployer panel's *To report* list, and reopening the same list pre-ticked from what was last reported is how the two applications a dead server left behind are finished off. On a multi-target rollout the same question is asked per target: marking a target failed opens a per-application list, so "which applications is WORD-7 still owed" is a fact the report carries instead of something a reader reconstructs. The per-application outcome is on the API too (`appResults`, and `partial` among the status values), so a script reports what the panel reports.
- **A release package can say it is only ever installed on the test environment.** Some changes are verified on the test instance and never promoted, and the process for those is a different one — the test team tells the operating team directly, and nobody plans, approves or escalates a production rollout that is not going to happen. There was nowhere to record that, so the extra step was taken anyway and then cancelled by hand, over mail, once per package. The package editor has a **Test environment only** box; a package marked that way shows a badge on the packages list, and picking it in the new-deployment form preselects the *Test environment only* path and says which package that came from. The rollout carries the mark too, so the deployer sees on their own row that nothing follows the install.

### Fixed
- **An application added to a running rollout no longer inherits the days it was not part of.** Adding a fourth application to a rollout on its fourth day marked it installed everywhere the first three had already been — the progress was kept per target, so "120 of 400 done" was read as 120 done for every application on the list, including the one that had just joined. An application added part-way through now records where it joined, its progress is counted from there, and the deployer panel and the deployment page list the coverage per application as soon as they differ. The release manager is told what the new application will and will not reach before the edit is stored, the timeline records it, the per-application XLS worklist starts at the day the application joined, and the *installations done* counter stops counting an application that has not had the targets it was planned for.
- **A work item is found even when it was filed under a neighbouring tracker project.** The lookup only ever asked the tracker project configured for the RollDesk project, and that route answers "not found" for a work item that belongs to a different project in the same organisation — so entering a bug number filled in the title, ticket and state for one project and silently did nothing for the next one over. The organisation-wide route is now tried as a fallback, and when the item turns out to live somewhere else the row says which tracker project answered, instead of leaving a stale setting looking like a working one.
- **The package editor says whether the work-item lookup is configured at all.** Two projects of the same client are configured separately, and a project with no tracker organisation, project or token on file answered an entered work item id with nothing — which reads as a broken lookup rather than as a setting nobody has filled in. The state is now stated under the project picker before an id is typed, naming the tracker project it will ask.
- **A stray click no longer throws away a form that is being filled in.** Clicking the page behind an open dialog, or pressing Escape, closed it and discarded everything typed — twenty fields, a list of applications and a list of work items, in the case of the release-package editor. Both gestures are now refused while a dialog has unsaved changes, and say so. Cancel still discards, because that is the button that means it.
- **A failed, rolled-back or aborted status pill is styled.** Those three were rendered through the same mechanism as *scheduled* and *installed* but had no colour rule of their own, so a failure sat next to a green success as an unstyled label.

## [0.26.0] - 2026-08-17

### Added
- **A release package announces itself.** Nothing was sent when a package was created or handed over, so whoever plans the rollout learnt about a release by opening the app and looking — and a package could sit ready for days with nobody asked to schedule it. Two events join the notification catalogue, **Release package created** and **Release package ready to deploy**, routed through the same per-client webhooks as the deployment events. The ready one names the applications and versions, the number of issues, who assembled it, the description of the changes, and closes with the request to plan the rollout. Only the transitions notify: editing a draft, or saving a ready package again, stays silent.
- **Applications can be added to a deployment that is already scheduled.** The editor only offered a version box per application, so a schedule generated with an application missing — the package has it, whoever planned the rollout did not tick it — had to be deleted and planned again. The dialog now lists the applications of the package and of the project that are not on the deployment yet, adds them with the tested version filled in, and removes the ones that do not belong (never the last one: a deployment has to install something). What changed is recorded in the audit trail and on the deployment's timeline, as with every other edit here.

### Fixed
- **An application added to a project survives a refresh.** The application appeared in the table and in the audit trail, but the project was never saved, so the entry existed only in the browser tab that added it and was gone on the next reload. Renaming one had the same fate.
- **A comment on a deployment reaches the Teams channel.** Every event added to the catalogue after a webhook was saved was silently muted for that webhook: a missing entry in its event map was read as "off", and only re-saving the client could have filled it in. A missing entry now means what `defaultEventMap()` always intended — enabled — so comments, status corrections and any future event reach the webhooks that were configured before they existed. Only an explicitly unticked event stays quiet.
- **A deployment that needs no client approval says so.** An internal rollout, or one in a project that waived sign-off, showed the approval control defaulting to "awaiting approval", and the only way to make the row read correctly was to record an approval the client was never asked for. Those deployments now show **No approval needed** in the deployments list and in the deployer panel, and their timeline no longer claims a request was sent.
- **"Clear all" clears the filters.** The button was rendered with its handler written in double quotes inside a double-quoted attribute, which ended the attribute early — so in the deployer panel, the deployments list, the client portal and the change history, pressing it did nothing at all.
- **Filters reset when a view is re-entered.** Filters set in the deployer panel (or the deployments list, client portal, change history, packages) survived a trip to another tab, so coming back showed a table hiding most of its rows with nothing on screen explaining why. Entering a view now starts from its defaults; sorting and the open record are left alone, and a link to one deployment still widens the filters to show it.
- **A test-only deployment cannot be narrowed to production targets.** Choosing "Test environment only" left **Deploy to selected production targets only** on screen and ticked, so the deployment ended up carrying a list of offices it never touches. The field is hidden on that path and any picked scope is dropped.

## [0.25.3] - 2026-08-17

### Fixed
- **An attachment larger than 1 MB reaches the API instead of bouncing off the proxy.** The backend accepts 25 MB per file, but nginx in front of it kept its default 1 MB body limit, so anything larger was refused by the proxy with a 413 the API never saw — and the upload failed for a reason nothing in the application could report. The `/api/` proxy now allows 26 MB, a little above the backend's own cap so the file-size limit is the one the API enforces and reports. Instances reached over HTTPS need the same setting on the TLS proxy in front of the container.

## [0.25.2] - 2026-08-13

### Changed
- **The packages list shows what a release changes, under the issues it fixes.** The column held identifiers and nothing else, which said how many things a release touched but not what it was — and now that the issue list is optional, that column was simply empty on the releases nobody filed a ticket for. The description of the changes is shown beneath the issues in the same column, as a preview with the whole text on hover, so the table answers "what is in this package" without opening the editor. The column is called **Fixed issues and changes**.
- **One button leads to the builds instead of a link after every version.** A release is normally one folder holding every installer, so the same address was repeated after each application — a stack of identical "build" links that crowded out the versions themselves. **Get the builds** appears once under the versions: it goes straight to the address when the applications share one, and opens a menu naming each application when a release really is spread over several. A network share still copies rather than pretending to be a link.

## [0.25.1] - 2026-08-13

### Changed
- **A package can be marked ready without listing a fixed issue.** Marking a package ready was refused until at least one work item was on the list, which blocked the releases that carry work no tracker item was ever filed for — a configuration change, a rebuild, a delivery agreed over a call. What makes a package ready is still the description of the changes, because that is the text the client is sent as the deployment's changelog; the issue list is now what it always was in practice, a reference for the deployer.

## [0.25.0] - 2026-08-12

### Added
- **An application version can say where its build is, and the deployer is handed that address.** A rollout began with the deployer asking, over chat, for the path of the file they were supposed to install — the package named the version and stopped there. The package editor now has a **Link to the build** field next to each version, and the address travels with the version everywhere it is shown: on the packages list, under the versions on the deployments list and the deployer panel, and as a chip on the deployer's action bar, which is where the rollout is actually worked. A web address becomes a link; a network share is offered as a path to copy, because a browser cannot navigate to a UNC path and a link that silently does nothing is worse than text. The address is read from the package rather than copied onto the deployment, so correcting it reaches the rollouts already planned — and it is deployer material, so it is stripped for a client account on a project that does not share deployment information, along with the instructions it belongs with.
- **One button writes the fixed issues into the release description.** The description is the text the client reads, and it was being typed out of the issue list directly above it, line by line, with a missing entry every few releases. **Move to the release description** appends a line per issue — its title, with the ticket it was filed under so the client can match a line to their own case. It appends rather than replaces and skips what is already written, so the sentence a release manager opens with survives the button, and pressing it again after adding one more issue adds only that one.

### Changed
- **The fixed-issue list drops the "Reporting office" column and calls the other one "Ticket".** Nobody read the office in the editor — it is looked up from the ticket and still stored, because the schedule uses it to put the offices waiting for a fix on the first rollout day, not because anyone types or checks it. Removing the column gives the title the width it was missing. "Halo ticket" is now just "Ticket": the service desk is a per-project setting, so naming one vendor in a column header was wrong on any instance that uses another.

## [0.24.3] - 2026-08-12

### Fixed
- **A ticket link can ask for the ticket's number, not only its stored reference.** A work item carries the reference a reader recognises — `PR-0164935` — but HaloITSM addresses that ticket in a URL as `164935`, so substituting the reference produced "ticket not found". A link template now also accepts **`{num}`**, which is the digits of the reference without its prefix or padding; `{id}` still substitutes it verbatim, for a desk that wants it that way. A reference with no digits at all falls back to the reference rather than linking to an empty id.
- **The placeholder hint says which address to copy.** HaloITSM serves one ticket from `/ticket` while `/tickets` renders a saved list, and the address in the browser's bar after clicking through a list is the list's — complete with its `area` and `selid` parameters. Copying it made every id reopen that list. The field's hint and example now name the single-ticket route and both placeholders.

## [0.24.2] - 2026-08-12

### Added
- **A work item's title and state are read with it and shown on the issue list.** The lookup already knew what the work item was called and what state it was in, and printed both once in a note next to the row, where they were gone as soon as the editor closed. Both are stored on the issue now and have their own columns: the title appears everywhere the fixed-issue list is — in the package editor as the tester enters the id, in the packages table, and on every deployment planned from the package — and the state is shown in the editor, so reopening a package says what was found rather than nothing. A list of bare numbers said how many things a release fixed but not what any of them were. The stored state is a snapshot of the day the issue was added, not a live value; the id links into the tracker and ⟳ re-reads the row.
- **The issue ids link into Azure DevOps and the service desk, per project.** The work item link is derived from the organisation and project already on file — one fewer URL to type, and one fewer pair to disagree. The service desk link is a new setting (**Link to one ticket**) because a service desk's web view is not derivable from its API host: HaloITSM opens a ticket inside a saved list, so the address carries that list's own parameters and only the installation knows them. A project's own patterns win over the instance-wide `ISSUE_TRACKER_URL`/`WORKITEM_URL`, so two projects in different organisations both link correctly; a project that configures nothing still falls back to them, and a client account gets the ids as plain text — neither of our trackers is reachable from outside.

### Changed
- **Packages are listed newest first.** The backend already answered in that order, but a package created during the session was appended to the loaded list, so a tester's own new package appeared at the bottom of the table they created it from until the next reload.
- **The release package is visible in the deployer panel and the client portal.** The id was only on the deployments list and the deployment page, so the two panels where a rollout is actually worked on and watched showed the versions without saying which handover they came from. It is now under the versions in both lists, and on the deployer's action bar next to the deployment id — read-only there, because a deployer matches the id against the build they were handed and has nothing to change in it. The way through to the package itself stays behind the roles that may open one.

## [0.24.1] - 2026-08-12

### Changed
- **The new-deployment form no longer asks for the changelog.** 0.24.0 moved the text onto the release package but left a copy of it on the form, pre-filled and editable — so the release manager was invited to change something that the package already said, and the copy then differed from what everyone else reads. Planning a deployment is now picking the package, and nothing else: the description, the deployer instructions and the files come from it, and the read-only panel that re-showed them below the form is gone too (it only asked for a second confirmation of the package just selected). A rollout that genuinely needs different wording is edited afterwards in the deployment editor, which is where the changelog field now lives — pre-filled with the package's text, and storing an override only when what is saved actually differs from it. A package that describes nothing at all is refused at planning time instead: the client would have been notified about a release that says nothing.
- **"Release packages" is "Packages" in the menu, above Deployments.** A package exists before the rollout it is planned into, so the menu now reads in the order the work happens.

## [0.24.0] - 2026-08-12

### Changed
- **The deployer instructions, the changelog and their files belong to the release package.** They describe the build, not the day it goes out, so they are written once on the package instead of being retyped on every rollout of the same versions — and a correction made after the first deployment now also reaches the ones planned later. The schedule form and the deployment editor show them read-only, with a link to the package for whoever may edit it; a deployment keeps only its own changelog text, because a release manager may still adjust what one client is sent. Files are uploaded to the package under the audience they are for: a changelog file is client-facing, an instruction file is not, and a file whose kind cannot be read falls to the narrower audience rather than leaking.
- **Opening a deployment opens a page, not a row.** The detail was a panel inside one table cell, which is why its day plan, its pending-target queue and its timeline each had to live in a short nested scroll pane. Each of those now has the width and the height it needs. Escape or "Back to the list" returns to the list, on the row that was open.
- **The release package id is on the deployments list**, under the versions it defines — the versions on a row are the package's, and there was no way to tell from the list which handover a rollout came from. The number of working days moved under the target count in the same row: two figures side by side read as one and widened the column.

### Fixed
- **A package's files were about to be hidden from every client.** The endpoint that lists them did not read each file's kind, so all of them would have been classified as deployer instructions and withheld — including the changelog files that exist to be sent out.

### Migration
- **Existing deployments are given the release package they should have been planned from** (`010_backfill_deployment_packages.sql`), filled from their own applications, versions, changelog and installer notes, with their attachments moved onto it under the audience the deployment recorded. One package per deployment, marked `ready` because the rollout already happened; deduplicating by version set would have been a guess about which rollouts shared a build. The fixed-issue list stays empty — the deployment never recorded it, and an empty list is the honest answer. Deployments with no applications are skipped, and a deployment that already pointed at a real package keeps its own files.

## [0.23.0] - 2026-08-12

### Added
- **The HaloITSM ticket behind each fix is on screen during the rollout.** A fixed issue on a release package now carries the id of the Azure Boards work item the testers file *and* the ticket named in that work item's `SM Problem` field — the service-desk case the fix actually answers. The deployer sees the ticket id, not only an internal work item number, which is what they are asked about when an office calls to check whether its report went out. `WORKITEM_URL` links the work item the way `ISSUE_TRACKER_URL` already links the ticket; both are patterns with an `{id}` placeholder and both are optional.
- **The offices that reported the fixes are rolled out to first.** An issue can name the office that reported it, and the generated schedule moves those production targets to the front of the order. Matching accepts a target's code or its label, case-insensitively, because a ticket names whichever the reporter used. The office waiting for a fix should not be the last one to receive it, which is what an alphabetical or as-entered order routinely made it.
- **A separate "Changes in this release" section on a package.** What the release contains is described once for the whole package, in its own field with room for real text.

### Changed
- **A package's issue list is identifiers only.** The per-issue description is gone: it produced a wall of half-sentences that read worse than one paragraph, and it duplicated what the tracker already holds. The issue table is now three columns — service-desk ticket, work item, reporting office — and the prose lives in the new changes section. A package marked **ready** must have both a non-empty issue list and a description of its changes; API clients sending a per-issue `description` have it dropped rather than stored.
- **A deployment is planned from a package, and only from a package.** The manual path — ticking applications and typing versions into the schedule form — is removed, along with the version-format and pick-an-application validation that existed only to guard it. Picking a package is now a required field, and the application list below it is read-only and derived, still warning where a version is older than or the same as what the target already runs. What gets installed is what was tested; the two could previously drift with nothing in the app noticing.

### Removed
- **The "is this change required by law?" question.** It was asked on every new deployment and answered the same way almost every time, and the red `§ LEGAL` badge it drove ended up on rollouts where it carried no information. Whether a statutory deadline applies is now part of the release description, where the reasoning can be stated instead of a boolean.

## [0.22.0] - 2026-08-11

### Added
- **Release packages, assembled by the test team.** What is being released and what it fixes was decided in the schedule form by whoever happened to be planning the rollout: the release manager typed the version out of a chat message and wrote the changelog from memory, while the people who actually tested the build had nowhere in the app to say what they had signed off. A new **Release packages** view lets the test team record the application versions that were tested together and the issues fixed in them — the tracker id as it is written in the tracker, plus a description of the change — and mark the package **ready**. Planning a deployment then means picking that package: the applications, their versions and the changelog fill in from it and stay editable, and the deployment stores only a reference, so an issue description corrected a week later also corrects what the client is reading. Packages stay editable at all times, deliberately; deleting one that a deployment points at is refused and names the deployments.
- **A `tester` role.** Testers manage packages for the projects they are assigned to and nothing else — no schedules, no targets, no client decisions — and their landing view is the package list. Projects are picked per account exactly as for a deployer.
- **The fixed-issue list is shown to the client.** A deployment built from a package carries its issues into the changelog block in the client portal, the deployer panel and the Deployments list, so "what is in this release" is answered where the release is read rather than in a separate mail.
- **`ISSUE_TRACKER_URL` turns issue ids into links.** A URL pattern with an `{id}` placeholder (e.g. `https://tracker.example.com/tickets?id={id}`) — a pattern rather than a base URL, because trackers differ in where the id belongs and the ids are stored exactly as the testers type them. Left empty, or given without `{id}`, the ids stay plain text.

### Changed
- **Write access to deployments and projects is now an allow-list.** The guard on those routes only ever rejected the `client` role, so every role that is not a client inherited release-manager write access — and the new `tester` role would have silently done the same. The six write routes (deployment `POST`/`PUT`/`PATCH`/`DELETE`, project `PUT`/`DELETE`) now name the roles allowed through, which also means the next role added is locked out until someone decides otherwise. The client's own approval endpoint is deliberately outside this guard.

## [0.21.1] - 2026-08-11

### Fixed
- **Opening a deployment in the deployer panel jumped the list back to the top.** Expanding a row re-renders the list, and that render replaces the whole wrapper — including the scrolling pane, whose offset starts at zero on the new node. Opening the last of forty deployments therefore threw the reader back to the first one and the list had to be scrolled down again. The offset is now carried over to the pane that replaces it. The client portal's list was affected in the same way and is fixed with it; the Deployments table swaps only its rows and never had the problem.

## [0.21.0] - 2026-08-11

### Changed
- **The deployer panel's schedule export is one XLS per application.** A deployment carrying five applications produced a single sheet with `A / B / C / D / E` in every application cell — a document about five rollouts that is a worklist for none of them. **⬇ XLS** now downloads one file per application, each naming only its own application and version and covering that application's targets and dates, under a file name of `<deployment id>-<application>.xls`. The files are written a fraction of a second apart, because browsers drop all but the first of a burst of downloads started in the same instant. Drafts stay excluded, as before.
- **A session lasts 30 days instead of 12 hours.** The default put everyone through password + TOTP every morning, since a session started during one working day always expired before the next. `SESSION_TTL` still overrides it, and both compose files now pass the variable through — previously setting it in `.env` had no effect on a containerised install. Note that a session token cannot be revoked server-side, so a longer window is also a longer period in which an archived account's open session keeps working; lower it where that matters more.

### Removed
- **CSV exports.** The Deployments tab and the deployer panel each offered a list-level **⬇ CSV** next to the filters plus a per-record one in the row's action bar, all of them re-renderings of rows already on screen or already in the XLS. The deployer panel keeps the XLS only; the Deployments tab keeps the PDF, which is the client-facing schedule document.

### Fixed
- **Withdrawing a client's approval was a silent, one-click action.** Setting the approval column back to "Awaiting approval" was the only decision change that saved without an audit entry, without a timeline note, and without clearing the previous decision's stamp — so a record could read "awaiting approval" while still carrying „approved by X on <date>", with nothing in the change history to say who undid it or when. Because the column is a bare drop-down, a stray scroll over it was enough to do this, and the deployment silently left the deployer panel's working list (it is filtered to approved records) with no one being told. The transition now asks for confirmation naming the deployment and the approval about to be discarded, clears the stale stamp, writes an audit entry and a timeline note, and redraws the deployer panel. Dismissing the confirmation leaves the control showing the decision that is actually recorded.

## [0.20.0] - 2026-08-11

### Added
- **A single deployment can be downloaded as CSV.** An open record offered its schedule as XLS and PDF, but the only CSV was the list-level one covering everything currently filtered — the wrong sheet to hand to someone working one rollout. A **⬇ CSV** button now sits next to XLS and PDF in both the deployer panel and the Deployments list, exporting that record's application × target rows under its own file name. Drafts are excluded, like the other two exports.

## [0.19.0] - 2026-08-10

### Added
- **The deployer panel counts the applications it has to deploy.** The counter row reported deployments, days and targets, but never how many applications the visible rollouts actually cover — and a single record can carry five of them. A fifth tile now shows the distinct applications across the filtered list, counted per name, so an application appearing in two rollouts is still one application to install.

### Changed
- **The deployer panel's CSV is one row per application per target.** It exported one row per deployment record, which collapsed the whole rollout into a single line: a release of 5 applications to 3 targets came out as one row instead of the 15 installations it describes. The export now enumerates every application × target pair, with the target code, its scheduled date and its own status (installed / failed / scheduled), which is the worklist a deployer actually works from. The Deployments list export is unchanged — it is a register of records, not a worklist.

## [0.18.1] - 2026-08-06

### Fixed
- **`IMAGE_PREFIX` pointed at a placeholder.** `.env.example` and `docker-compose.prod.yml` both defaulted to `ghcr.io/your-org/rolldesk`, so a server following the documented production path pulled from a registry that does not exist. Both now default to `ghcr.io/rolldesk/rolldesk` — the prefix CI actually publishes to — and the compose header spells out the `docker login ghcr.io` the private packages need, plus the `pull` / `up -d` rollout.

## [0.18.0] - 2026-08-06

The review notes from 6 August: two paths through "New deployment" could not be
completed at all, the deployer panel was missing the two events it most needed to
send, and a correction could not be made until the whole rollout was over.

### Added
- **A deployment can cover part of the estate.** "Number of targets covered" is derived from the project's production targets and therefore read-only, which left no way to release to a single WORD — the only production rollout possible was "all of them". Tick *Deploy to selected production targets only* and pick the targets: the count, the day split, the preview, the per-day breakdown and the saved record all follow the subset. A one-target rollout now also names the target that was picked instead of the project's main office.
- **Whether a change is required by law is part of the plan.** New deployments ask it explicitly, and the answer rides with the record: the deployer panel marks such a rollout with a red **§ LEGAL** badge in the list and in the open record, because a statutory deadline is what decides whether a failure can simply be moved to next week.
- **Two webhook events that were missing.** *Comment added to a deployment* and *Installation status corrected* now dispatch like every other event — a correction on PROD or on a test environment, and a note between the release manager and the deployer, used to reach only whoever happened to open the record. Both are enabled by default on existing webhooks as well as new ones, so nothing needs reconfiguring.

### Fixed
- **A test-only deployment can be approved.** "Approve schedule" only ever became enabled by generating a schedule, and the test-only path has no rollout to generate, so the path could be chosen but never confirmed — the deployment was unreachable. It is approvable as soon as the path is set; discarding a generated preview no longer un-approves it either.
- **A correction can be made while the rollout is still running.** The correction form was rendered only for a finished deployment, so a mistake on day 1 had to wait until the last planned day had closed. It now sits under the day report for a running batch too, restricted to the targets that deployment covers, and refuses to mark a target from a day that has not run yet as installed — that is reporting, not correcting.
- **A draft no longer claims to be awaiting approval.** Typing a comment on a draft showed *Awaiting approval* in the approval column while the row still carried the *Draft* badge. A draft has not been sent to anyone, so it carries no approval state; the state is minted when the draft is published.
- **Table headers no longer wrap one letter per line.** `overflow-wrap: anywhere` shrinks an element's minimum width to a single character, which let the day-breakdown columns collapse until „DZIEŃ" read *D/Z/I/E/Ń*. Long unbreakable strings still break; ordinary words do not. The per-day pin field also gave up its fixed width, which had pushed the whole table behind a horizontal scrollbar.
- **The view name is printed once.** Every screen repeated its own title under the one in the top bar — *New deployment* directly above *New deployment*. The in-view heading is gone; the description is the lead line.

## [0.17.0] - 2026-08-01

A UX review pass over every tab the previous releases did not touch, plus one
instance-level setting for the language notifications go out in.

### Added
- **`NOTIFY_LANG`** pins the language of outgoing notifications (e-mail, Slack, Teams, webhooks) to the instance. Bodies are composed in the browser of whoever triggered the event, so they used to inherit *that person's* UI language — and the UI defaults to English, so the same client could be told about one deployment in English and the next in Polish. Set `pl` or `en`; anything else is ignored with a warning, and leaving it empty keeps the old behaviour. The value reaches the UI on `/api/version`, which it already calls right after sign-in.
- **Search in Help.** The page had grown past what anyone reads top to bottom. The search box filters the topics and the role descriptions to the ones that match and highlights the term inside them; the API section, which is collapsed by default, reports how many of its endpoints match instead of hiding.
- **Active filters are visible and removable.** Every filtered list (deployments, deployer panel, client portal, clients, change history) shows what is currently narrowing it as labelled pills with a close button, plus "Clear all". Filter controls now carry captions, and the free-text ones a magnifier, so a search box is no longer indistinguishable from a dropdown.
- **A searchable target picker.** Correcting a batch result meant typing a target code into a plain field backed by a `<datalist>` — invisible on some browsers and unsearchable on the rest. It is now a list you can scroll, filter by typing, and drive from the keyboard.
- **Expandable rows say so.** A chevron in the first cell marks the rows that open, and it turns when they do. Previously the only hint that a row was clickable was that clicking it worked.
- **A title beside the date.** Deployment rows and the deployer panel now lead with what is being deployed and where (`Word v2.1 → Central branch`) instead of a bare timestamp.
- **A per-row actions menu.** Users, clients and SSO providers keep a visible "Edit" and move the rest — reset password, resend invite, reset MFA, archive, delete, test — into a ⋯ menu, so the actions stop running off the right edge of the row.
- **Role on the profile.** The profile header shows which role the signed-in account has; it was only inferable from which tabs were present.

### Changed
- **Log out moved out of the sidebar into the avatar menu**, next to the account it ends — it is not a place in the app — and now asks for confirmation, naming what a sign-out costs (unsaved changes, and a password plus 2FA code to get back in).
- **Adding and editing a user, a client or an SSO provider happens in a dialog**, like every other add/edit in the app. Two of the three used to expand inline, so the same task looked like two different features depending on the tab.
- **Multi-select masses became pills.** Granting a user their projects, or a webhook its events, was a wall of bare checkboxes; the choices are now outlined pills that fill in when selected, so what is on is readable at a glance.
- **The client edit form has sections.** Identity and webhooks are separated with headings, each webhook has labelled name and URL fields, and "Send test" and "Remove" sit in a footer instead of trailing off the end of the row.
- **Save buttons are right-aligned everywhere,** with the primary action last and the cancel/secondary before it — including the correction forms in the deployer panel, where "Change to successful" is now the primary and "Keep failed" the quiet alternative.
- **A start is one control.** Editing a planned deployment offered a time field with no date; single rollouts now edit date and time together in one input, and batch rollouts keep only the shared start time, because their dates belong to the day breakdown.
- **The profile page fits on one screen.** The name and e-mail come first, under the heading; the interface-language switch takes the width of its two pills instead of a full-page band; and security, password, tokens and sign-in history are balanced across the two columns.
- **Help boxes share a height** within a row, so a two-sentence topic no longer sits next to a ten-sentence one in a visibly shorter card.
- **Chat notifications post one headline, not two.** Slack and Teams render the subject above the body, which stacked "RollDesk — Approval request" over "DEP-2026-0054 — WORD". The event now folds onto the body's own first line, so the deployment id leads and can be a link — a heading field cannot carry one. E-mail keeps its subject, where it is a real envelope field.

### Fixed
- **The API-token section of the profile was permanently broken on older databases.** `api_tokens` was added to `001_init.sql` after that migration had already run on some instances, and the migration ledger records filenames rather than content — so the edited file never re-applied and those databases have no such table. Every request to `/api/tokens` failed with `relation "api_tokens" does not exist`. `007_api_tokens_backfill.sql` creates it where it is missing and is a no-op everywhere else.
- **Saving a correction with empty fields reported success.** The deployer panel's correction forms accepted a blank target code or reason and showed the success toast anyway. Both now mark the offending field and list what is missing in a banner at the top of the form, like the rest of the app.
- **A stray project breadcrumb beside the profile controls.** The top bar rendered the `client / project` slug in its right-hand group, so opening Projects made a line appear next to the avatar and language menu, as if a breadcrumb were loading into the profile. It now sits under the title it qualifies.
- **Table headers are grey.** A white header on top of white rows disappeared as soon as the table scrolled.

## [0.16.0] - 2026-07-30

### Added
- **A spinner while the data loads.** Opening the app showed an empty project list and an empty deployments table for as long as the first API call took, so on a slow link it read as "there is nothing here" before the rows appeared. The projects list, the deployments table, the deployer panel and the client portal now each show a loading row until their data arrives; the indicator is suppressed once anything has loaded, so a genuinely empty list still says so. Respects `prefers-reduced-motion`.
- **`examples/Update-RollDeskDeployment.ps1`** — a ready-to-run PowerShell wrapper around `PATCH /api/deployments/:id` for what a rollout script needs: report progress, close a rollout, mark a single target installed or failed, pause/resume, set notes, changelog or assignee. It reads the deployment first and sends the field that applies to that record, because which field carries progress depends on whether the deployment is single- or multi-target — the rule a hand-written script most often gets wrong. Takes the token from `RD_TOKEN`, supports `-WhatIf`, and works on Windows PowerShell 5.1 and PowerShell 7+.
- **The API documentation covers partial updates.** The in-app help and the README now list the patchable fields with their types and meanings, spell out the multi-target case, and show working `curl` and PowerShell calls. Previously there was no description of how to build a script that changes one thing about a deployment.
- **Notifications for two events that had none:** a deployer being assigned to a deployment (names who was assigned, and to what), and a target's deployment date changing (names the deployment, the target and the new date). Both are opt-in per client webhook like every other event.
- **Sorting by clicking a column header.** The deployments list was fixed at most-recently-added, which made finding a particular rollout in a long list slow. Every data column — project, application, targets, environment, date, progress, approval — is now sortable by clicking its header; a small arrow pair marks the sorted column and its direction, and clicking cycles ascending → descending → back to the default order. The same sorting works in the deployer panel and the client portal, which previously had none. Records with no value in the sorted column go last whichever way it points, ties keep the default order, and progress compares completion rather than the raw count, so 9/10 ranks above 50/400.
- **The change list can be saved as a `.txt` file** from the schedule form, for pasting into a ticket or attaching to a mail. CRLF line endings, since these files get opened in Notepad.
- **A day report says what happens next** — the next day's date and target count, how many targets are left to finish, or that the rollout is done. The report used to end with the day's counts, so a reader could not tell whether the rollout continues tomorrow, is finished, or is waiting on retries.
- **Timestamps written through the API respect `APP_TIMEZONE`.** A deployment patched by a script was stamped in UTC while the browser wrote local time, so API-written timeline entries appeared two hours behind the rest during Polish summer time. The zone is validated at startup and defaults to the container's `TZ`.

### Fixed
- **The Users list drops the e-mail column.** The e-mail is the account's identifier, not an attribute independent of the name, and giving it a column of its own pushed Projects out of view on a laptop screen. It now sits under the full name in small type, the same pattern as the client name under a project.
- **A status correction now persists.** Reporting a failure and then correcting it to success changed the row, but nothing was saved — after a refresh the deployment was back to `failed`, and the deployments list never showed that a correction had happened. The correction is now written to the deployment, the timeline and the audit trail, for both batch and single-target records.
- **The "left to finish" counter counts locations, not attempts.** Marking the same target as failed on four consecutive days reported "4 to finish" when one location was outstanding. Repeat failures now collapse onto the location, keeping the attempt count as a detail; records written before this fix are collapsed on read too.
- **A comment records who wrote it.** Comments added from the deployer panel were attributed to "Deployer", so with several people on a rollout there was no way to tell who had written one. They now carry the author's name.
- **Anyone who is not a client can be assigned to a deployment.** The assignable-people list was filtered to the `installer` role, so a person who administers RollDesk *and* installs on site — one account, one role — could not be assigned at all. Every non-client account is now assignable, with deployers and members of the project listed first.
- **Moving a target to another day no longer looks like a swap.** The move itself was correct, but the schedule view re-derived the running order from the project's site list whenever the rollout was already in progress, which silently undid every move and made it look as though two locations had traded places. Mid-rollout the view now reads the pending queue and the completed history, which is what the moves actually rewrite.
- **A target's move is recorded.** Moving a location to another day produced only a toast: nothing on the timeline, nothing in the audit trail, no notification. All three are now written.
- **The schedule tab shows the new date after a move.** The full schedule is rendered once and cached in the DOM, and nothing invalidated that cache — so after changing a target's day, the "schedule" tab kept showing the old date and weekday. Every change to the day distribution or the day dates now clears it.
- **A pinned location stays on the day it was pinned to.** Co-scheduled targets (a site and its branches) were moved onto the day where the group *first appeared*, which dragged a location the PM had pinned to a late day back to whichever early day the fill had put one of its branches on. A pinned member is now the anchor for its whole group.
- **A co-scheduled group is never split across days.** Approving a schedule re-ran the day assignment over a flattened target order, which had lost the day boundaries the grouping produced — so the approved PDF could put a site on Wednesday and its branch on Thursday, differing from the schedule that was previewed. The group is now the unit of scheduling from the start, and approving stores exactly the split that was shown. Group members also stay adjacent within their day instead of being listed after every other target.
- **A draft no longer reads as "awaiting the client's approval".** A draft has not been sent, so it cannot be waiting on a decision; the row said it was, because the approval control defaulted to "pending". It now shows a "draft" badge and offers the action that sends it.
- **A draft's schedule cannot be exported.** The PDF/XLS export is the document the client receives, and it was available on a draft — a provisional schedule could go out as if it were final. The buttons are hidden on a draft and the export refuses with an explanation.
- **The production start date is no longer the same as the test start date.** Both defaulted to today, so a new schedule proposed installing on test and production on the same day. Production now defaults to the next working day after the test start and follows it when the test date is edited, while a date deliberately pushed further out is left alone.
- **The per-day split validation is visible.** When the manual day breakdown did not add up to the number of targets, the save was blocked by a small toast in the bottom-right corner that is easy to miss on a tall form. It now uses the same red banner as every other validation failure.
- **A completion notification names the status.** The event is called "deployment completed (with status)", but the status was only in the body — and a Teams channel shows just the subject in its preview, so a recipient could not tell success from failure without opening it.
- **The team is told when a schedule is approved, however the approval arrived.** An approval clicked in the client portal was announced on the internal channel; the same approval recorded by the RM (client agreed by phone or e-mail) was not, so whether the team heard about it depended on which door the decision came through. The notification is internal only — the client made the decision, so it is not mailed back to them.

## [0.15.0] - 2026-07-30

### Added
- **A notification links to the deployment it is about.** `#deployments/<id>` is now a route: it opens that schedule's row expanded, scrolled to and briefly outlined. It widens the filters first — the default 14-day window and the status filters are the viewer's, not the sender's, so a link to an older or filtered-out deployment used to land on a list that did not contain it. The same link works for every role: a client cannot open the deployments list at all and a deployer works from the deployer panel, so the id is routed to whichever list that role does have (in the deployer panel it also turns the completed filter on, which is off by default). On a cold load the row does not exist yet when the link is routed — the link is followed before sign-in — so the focus is re-applied once the list arrives.

### Changed
- **The link is the deployment id, and the "Open the schedule in RollDesk" line is gone.** A notification carried a trailing instruction plus a bare URL to the list, which meant reading a sentence to get somewhere that still needed searching. The id already opens every body, so it is the link — as a Markdown link in a Teams card, `<url|id>` in Slack, an anchor in an HTML e-mail. The plain-text part of an e-mail spells the URL out under the body, since it cannot carry an anchor. A notification with no deployment id (or an instance with no `APP_BASE_URL`) still gets the generic link added in 0.14.1.
- The link is built from `APP_BASE_URL` server-side rather than from the browser's origin: the address the person creating a schedule happens to use is not necessarily the one the recipients reach the instance on.

## [0.14.2] - 2026-07-30

### Changed
- **Notifications are much shorter in a Teams channel.** A Teams card renders Markdown, where a lone newline collapses into a space — the body was therefore sent with *every* newline doubled into a paragraph break, which kept the lines apart but also put a blank line between each one. A schedule notification carrying an eleven-item changelog rendered at twice its height and read as an endless wall in the channel. Single line breaks are now Markdown hard breaks, so the lines stay separate with nothing between them; a blank line the author wrote deliberately (the one before the changelog) is still a paragraph break. The changelog itself is untouched — it is the point of the notification.
- **Related facts share a line instead of one label per line.** A schedule notification opened with six labelled lines (project, deployment, applications, environment, start, author); it now opens with three — `PIK_2 · DEP-2026-0046`, then `Pojazd v52.13.32 · Produkcja · 399 targets · 4 working days`, then start and author together. The same header (id — project, then versions · environment) is now shared by the failure, completed, day-report and decision notifications, which each built it inline and slightly differently.

### Fixed
- **A schedule notification no longer carries the link to the app twice.** The UI has always appended its own labelled link ("Open the schedule in RollDesk"), and 0.14.1 added the generic one to every delivery channel — so a Teams, Slack or e-mail notification about a schedule showed the same URL twice, once as a line and once as a card button. Each channel now suppresses its generic link when the body already contains the instance URL. Notifications the UI does not link (a target failure, a pause) are unaffected and keep the link 0.14.1 gave them.

## [0.14.1] - 2026-07-30

### Fixed
- **Teams notifications sent through Microsoft Graph now carry the "Open RollDesk" link.** E-mail and webhook deliveries appended it, the Graph channel message did not — and because Graph *takes over* the per-client Teams webhooks when it is configured (so the same event isn't posted twice), the link was missing from exactly the notifications most people read. A target-failure alert arrived with the deployment id and reason but no way back into the app. The link is the instance's `APP_BASE_URL`, as in every other channel.
- **A notification body is escaped before being put into an HTML e-mail.** Failure reasons and target names are typed by a person, and the body was interpolated into the HTML part raw, so a `<` in a reason swallowed the rest of the line in an HTML mail client (`&` was mangled too). The plain-text part was always fine.
- **A malformed `APP_BASE_URL` is now treated as unset** rather than rendered as a link. Only `http`/`https` is accepted, so a typo cannot end up as a `javascript:` href in an e-mail or a Teams card.

### Changed
- **The per-channel link markup lives in one module** (`backend/src/appLink.js`, unit-tested) instead of being rebuilt inline for each of e-mail, Slack, Teams cards and Graph. That divergence is what let one channel quietly lose the link; it also removes a duplicated HTML-escaping helper from `teamsGraph.js`.

## [0.14.0] - 2026-07-30

### Added
- **`PATCH /api/deployments/:id` — change one field of a deployment without resending the whole record.** The only way to update a deployment was `PUT`, which replaces the entire stored object. That is what the UI wants (it holds the full deployment in memory), but for a script or CI job holding an `rd_live_…` token it meant read-modify-write for a one-field change, and any slip on the way — a truncated `ConvertTo-Json`, a hand-written body — silently wiped the schedule, the comments or the counts, with nothing in the response to say so. `PATCH` merges the fields you send and leaves the rest alone. The merge is shallow (a key replaces that key's whole value; `null` clears it), `status` is validated against `scheduled`/`installed`/`failed`/`rolledback`/`aborted` instead of being stored as a string the UI can't render, `projectKey` is refused because moving a deployment between projects changes who may read it, an unknown id is a `404` rather than an upsert, and a patch that changes nothing returns the stored object without writing history. Client accounts are rejected as with every other write, and deployers are limited to their granted projects. The change lands on the deployment's timeline and in the change history under the token owner's e-mail, since an API caller has no UI to record it.

### Fixed
- **The in-app API documentation describes the API this instance actually serves.** *Help → API documentation* advertised a fabricated host (`https://api.rolldesk.example/v1`) and endpoints that were never implemented (`PATCH /deployments/{id}/status`, `POST /deployments/{id}/targets/{code}/result`, `POST /deployments/{id}/comments`), with a footnote at the bottom admitting the whole section was illustrative — so anyone copying the example got a `404` from a host that does not resolve, which is exactly the wrong way to learn that. It now lists the real routes, uses this instance's own origin as the base URL so the examples run as they stand, and the footnote is gone because the API is real. Added a PowerShell variant of the example: `curl` there is an alias for `Invoke-WebRequest`, which rejects `-H`/`-d` with a parameter-binding error rather than anything that hints at the actual problem.
- **The documented list of deployment statuses no longer includes `paused`.** A paused distribution keeps its status — pausing is the separate `paused` / `pauseReason` field on the deployment — so both the README and the in-app docs described a value the app never stores.

## [0.13.3] - 2026-07-30

### Changed
- **The update check runs in the backend and is cached for an hour.** The version badge used to call `api.github.com` from every browser tab. GitHub allows 60 anonymous requests per hour *per IP*, so a few people behind one office NAT exhausted the quota and the badge showed "latest unknown" even though the release was published — and an instance behind a restrictive firewall could never check at all. The backend now asks GitHub once per hour per instance and serves the answer from `GET /api/version`; a failed check keeps the last known version and is retried after five minutes. When it does fail, the badge tooltip says why (a rate limit reads differently from no network) instead of always claiming GitHub was unreachable. `GITHUB_TOKEN` is optional and only raises the limit; `VERSION_CHECK_REPO` and `VERSION_CHECK_TTL_MS` are configurable.
- **The browser no longer talks to any third-party host**, so the nginx `Content-Security-Policy` drops `api.github.com` from `connect-src`.
- **Dependency and toolchain bumps.** `express-rate-limit` 7.5.1 → 8.6.0 (the auth limiters' behaviour is unchanged and covered by tests), the backend image moves from `node:20-alpine` to `node:26-alpine`, and the CI actions are updated (`actions/checkout` v7, `actions/setup-node` v7, `docker/login-action` v4, `docker/setup-buildx-action` v4, `docker/build-push-action` v7).

## [0.13.2] - 2026-07-30

### Added
- **An administrator can reset another user's two-factor authentication.** *Users* gets a "Reset 2FA" action on accounts that have an authenticator enrolled; it clears the stored secret so the account is walked through setup (a fresh QR code) on its next sign-in. This is the way out when someone loses their authenticator device — the secret is not recoverable, and until now nothing in the UI could clear it. The password is untouched (it is still required before the MFA step), the account owner is e-mailed that the reset happened, and the entry lands in the change history. Admins still reset their own authenticator from *Account*, which requires a current code first.

## [0.13.1] - 2026-07-29

### Changed
- **Deployer panel rows expand like the deployments list.** The trailing "Details ▾" / "Collapse ▲" column is gone — the row itself is the control, as it already was in *Deployments*, which never had that column.

## [0.13.0] - 2026-07-29

UX review pass over **Projects** and **Deployments**, with the resulting patterns applied to the rest of the app.

### Added
- **Inline form validation.** Saving a form with problems no longer shows a dialog naming one problem at a time (this replaces the 0.11.2 validation modals): every issue is listed in an error banner at the top of the form and the offending fields are marked in red with a message underneath. Applied to *New project*, *New deployment*, the schedule step, and the Users, Clients and SSO forms.
- **Header counters on a project.** Applications, production and non-production targets are shown as tiles — the same full-width summary row as the deployments list.
- **Client access card on a project.** Shows which Client-role people can see the project's deployments, with granting access done there or in Users.
- **A header on the deployer panel** (title, one-line purpose, summary tiles), matching the deployments list.

### Changed
- **Projects is a switcher, not a table.** One pill per project on a single line (client name shown only when there is more than one client), archived projects separated by a hairline, "New project" at the end of the strip. The selected project's configuration renders below.
- **Applications and targets are edited in a dialog** instead of an inline form that pushed the page around.
- **One consistent button order and shape.** Cancel on the left, the confirming action on the right — in dialogs, in form footers and in table rows. Add buttons all use the same ＋ glyph, and section headers all use the same title/description/actions layout.
- **One datetime field** wherever a moment in time is entered — editing a deployment row and the test/production start of a schedule (date and time were two controls that could drift apart). Cancel/Save in the standard order, and a pencil on *Edit*.
- **Framed, sticky table headers** on every list (deployments, deployer panel, client portal, users, clients, audit) — the header stays visible while scrolling and the corners are rounded.
- **Unified alerts.** Notes, warnings and confirmations share one alert component with a consistent icon and colour per kind.
- **"Mark the rest" moved into the progress cell** of a batch deployment as an icon, next to the number it acts on.
- **Shorter approval pill** (full wording in the tooltip) so it no longer stretches the column.
- **"Filter by" labels** on the filter rows, so it is clear what the controls do.

### Fixed
- **A zero counter no longer shouts.** The *Failed* tile is grey at zero and only turns red once there is something to see.
- **Editing a deployment row no longer scrolls the table away.** The scroll position is preserved across the re-render.
- **`index.html` is always revalidated** (`Cache-Control: no-cache`), so a version bump actually reaches the browser instead of a cached page requesting the previous version's translation bundles.
- **Missing and duplicated UI strings.** Client access, the *New project* step headings and the hidden-history note are translated; the doubled ＋ signs and the doubled ℹ icon in the test-only note are gone. The "new target field", "archive user" and "reply to the client comment" dialogs are localized too (they were hard-coded English).

## [0.11.2] - 2026-07-28

### Added
- **`SMTP_TLS_REJECT_UNAUTHORIZED`** — lets a self-hosted instance talk to an SMTP server with a self-signed certificate. Defaults to strict verification; passed through both compose files.

### Fixed
- **Validation dialogs, status webhooks, the `scheduleApproved` event and the test-environment badge** in the deployments views.
- **i18n bundle syntax** (straight quotes introduced by an editor).

## [0.12.0] - 2026-07-25

### Added
- **Share administrator information with the client.** A per-project setting (on create and in deployment defaults) controls whether deployer/admin notes and their files also appear in the client portal. Off by default; the API strips those fields for client accounts when the setting is off.

### Changed
- **Shorter queue move buttons.** First/last queue actions show only the arrows (⇤ / ⇥); the full label stays in the button tooltip.
- **Consistent “targets” wording.** UI labels that still said “locations” / “lok.” now use “targets” / “cele”; the redundant short unit next to the day count is gone.
- **Tighter schedule assignment preview.** Time sits under the date; the redundant P/NP badge is omitted there (only production targets appear — the Environment column already says so). In the targets list, type is a compact **P** / **NP** badge (full label on hover; click to toggle).
- **Post-deployment section help** moved into an info (ℹ) tooltip.
- **Repository link placeholder** is a generic `https://…` (not GitHub-specific).

### Fixed
- **Environment “Production” is localized in the UI** (e.g. Polish „Produkcja”) in lists, filters, schedule path badges, PDF titles, CSV export and notifications. The stored value stays `Production`.

## [0.11.1] - 2026-07-24

### Added
- **Action bar on expanded deployments.** Instructions, changelog, timeline (open by default), comment, schedule XLS/PDF, message, pause/resume, edit, reminder and delete share one compact bar; detail panels open one at a time.
- **Matching action bar on the deployer panel.** ID, assignee, changelog, timeline, comment, full schedule and XLS/PDF — without RM-only actions. Deployer instructions stay always visible under the bar.
- **CSV export of the current list.** ⬇ CSV on the deployments list and the deployer panel exports the rows matching the active filters (not available in the client portal).
- **Approval reminder shows the delivery channel.** Confirm dialog, button tooltip and toast name Teams (Graph) and/or configured webhooks.
- **Edit project name.** Open a project to rename it (display name only; the technical key is unchanged). Duplicate names for the same client are rejected.

### Changed
- **Deployer panel aligned with deployments.** Same table layout, multi-select status filter and summary stats row; duplicate page titles/descriptions removed (title stays in the top bar only — same cleanup on Projects and Deployments).
- **Default deployments status filter shows everything in range.** Scheduled, installed, failed, rolled back and aborted are all on; the 14-day range still limits history.
- **Shorter action labels.** e.g. Message, Reminder, ⬇ XLS / ⬇ PDF; schedule download filenames are `{deployment-id}-{app}`.
- **Reports & history removed from the deployer panel.** Replaced by the list CSV export; the separate "Reports" status option is gone.

### Fixed
- **Escape closes modals sensibly.** Esc closes the end-user message dialog; Esc closes Edit deployment only when nothing changed.
- **Changelog visible again for deployers** on active, waiting and completed rows.
- **Deployer-instructions placeholder is localized** in *New deployment* (was hard-coded English).

## [0.11.0] - 2026-07-24

### Added
- **Microsoft Teams via Microsoft Graph (threaded per deployment).** Optional integration behind the `GRAPH_ENABLED` feature flag (off by default — webhooks stay as today). When enabled and `GRAPH_*`/`TEAMS_*` are set, deployment notifications are posted to a Teams channel and grouped per deployment. Admin diagnostics: `GET /api/teams/graph/status|teams|channels`. Secrets live only in `.env`.
- **Send an approval reminder.** Deployments still awaiting the client's decision get a "Send reminder" action that re-sends the approval request and records it on the timeline and in the change history.
- **Move a target to any future day.** The deployment queue now has a "→ day…" picker to move a pending location to any upcoming day, not just the neighbouring one.
- **Co-schedule paired locations.** Targets that share a "Group / pair with" label are always scheduled on the same day (e.g. a branch and its backup server). New column in the target list.
- **Deployer panel grouped by Project → Application.** The active, awaiting and completed sections now carry clear project and application subheaders.
- **Report filters + unfinished locations.** The deployer reports panel gains project / environment / application filters and an "Unfinished locations" column (with failure reasons) that is included in the CSV export.
- **Assignable-deployers roster for non-admins.** Release managers and deployers can now populate the "assign deployer" dropdown via a new minimal `GET /api/users/assignable` endpoint (the full directory stays admin-only).

### Changed
- **Richer completion / day-report notifications.** Notifications now include the actual status, who reported it (manually), and a progress line (installed / total / remaining).
- **Exact-count day limits.** The per-day type limit now reliably targets exactly N of the chosen type by placing constrained targets first.
- **Schedule PDF opens cleanly.** The printable schedule no longer forces the browser print dialog on open — it opens in a tab with a Print button, so the main app stays usable.
- **Deployments list denser.** Time is shown in small type under the date (same pattern as the app version), and the client name sits under the project — the separate Client and Time columns are gone.
- **Deployer panel default view is the work queue only.** The "All" tab no longer embeds Reports and History — those stay on their own tabs. Cards are a flat list (one deployment per card), without Project → Application section headers.

### Fixed
- **Draft with test + production now keeps both.** Creating a draft that spans a test and a production environment saved both records reliably (the navigation no longer races the save and wipes the production record).
- **Deployer timeline shows who and when for single deployments.** Single test/prod marks record the actual report time and the deployer, and the timeline shows them instead of the planned date.
- **Failure reasons persist.** A failure reason is now kept as a permanent timeline entry that survives a later success or a force-complete.
- **Awaiting test-environment deployments are clearly flagged in the deployer panel** (environment tag on the "awaiting client approval" cards).
- **Info (ℹ) icon tooltips always show.** The hover help on the info icons (e.g. in *New deployment*) could appear to do nothing when the CSS popover was clipped by a scrolling panel; a native tooltip fallback now guarantees the text is shown.
- **No duplicate deployer attachments.** Instruction files were listed twice in deployment details (blue instructions box and again under the changelog); they now appear only in the instructions box.
- **More Polish translations** for the new deployer-panel, schedule and notification strings.

### Notes
- Teams Graph posting is behind `GRAPH_ENABLED` (default off). Sending channel messages with application (app-only) permissions is restricted by Microsoft; keep the flag off and use webhooks until permissions + tenant allow it. Rotate the Graph client secret in Entra ID after setup if it was shared during configuration.

## [0.10.1] - 2026-07-22

### Added
- **Remove individual attachments.** Files added to the changelog or deployer-instructions attachment fields now appear as chips with a "✕" so you can drop a single file before confirming the schedule (re-selecting appends instead of replacing).
- **Download attachments from the deployments list.** A deployment's changelog files and deployer-instruction files are now shown as download links in the expanded row on the deployments list — even when the deployment has no typed changelog.
- **Edit attachments and deployer instructions after creation.** The "Edit deployment" dialog now also edits the deployer instructions and lets you add/remove both changelog and deployer-instruction files (each file has a "✕"), alongside the version, start time and changelog it already handled.

### Changed
- **Deleting a project is always recoverable.** Delete now archives the project (even one with no deployments) instead of erasing it, so an accidental one-click delete can be undone with "Restore". Permanent deletion is a separate, explicit action on an already-archived project.
- **Compact forms via info (ℹ) icons.** Long helper paragraphs in *New deployment* and *Projects* were moved into small info icons — hover to read the full text. Covers: applications & versions, changelog/instructions attachments, dependencies, internal/draft flags, per-day breakdown, location assignment, the production-approval notice, start time, skip-weekends and the test-approval option.
- **Changelog is optional when a file is attached.** In *New deployment* you no longer have to type the release notes if you attach a changelog file (the file carries them). One of the two is still required.

### Security
- **Attachment access control (fixes IDOR).** Attachment download/list/upload/delete now verify that the caller may access the owning deployment (same scoping as the deployments API): clients are limited to their own non-internal projects, deployers to their granted projects, and clients can no longer upload or delete files. Previously any signed-in user could download or delete any file by guessing its (sequential) id.
- **Output escaping against stored XSS.** User-supplied text (changelog, client comments/replies, deployer instructions, timeline comments and attachment file names) is now HTML-escaped before rendering, so a crafted comment or file name can't execute script in another user's session.
- **HTTP security headers.** nginx now sends a Content-Security-Policy plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and a minimal `Permissions-Policy`.

### Fixed
- **No more confusing startup pop-up.** The untranslated "Loaded N deployment(s) from the database" toast that appeared on every screen at startup was removed — data hydration is now silent.

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
- **Deleting a project keeps its deployment history.** A project that has deployments is now *archived* (hidden from active lists and from creating new deployments) instead of being erased, and its deployments stay in the deployments list as read-only history. Archived projects can be restored or deleted permanently by an administrator. A project with no deployments is still removed outright.

### Changed
- **Users list is simpler.** The "What they can do" column was removed; the role's capabilities now appear as a tooltip when you hover the role badge.
- **Consistent list hover.** Rows in the deployments list, client portal and users table (and cards in the deployer panel) now share the same grey hover highlight as the projects list, making lists easier to scan.

### Fixed
- **More Polish translations.** Remaining English leaks are localized: the edit-row Save/Cancel buttons in the deployments list, and the "Schedule changed (…)" timeline entry. Weekday names now always follow the selected language (deterministic, no longer depending on the browser locale).
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
