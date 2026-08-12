// Configuration read from environment variables.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { isValidTimeZone } from './stamp.js';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// Application version, read from package.json so /health can report it.
const require = createRequire(import.meta.url);
let version = '0.0.0';
try {
  version = require('../package.json').version || version;
} catch {
  /* fall back to default if package.json can't be read */
}

// JWT signing secret. Required in production; in development we fall back to an
// ephemeral random secret (sessions won't survive a backend restart) and warn.
const jwtSecretFromEnv = (process.env.JWT_SECRET || '').trim();
const jwtSecret = jwtSecretFromEnv || (isProd ? '' : crypto.randomBytes(32).toString('hex'));

// Zone the human-readable timeline/audit stamps are written in. The container
// image has no zone of its own, so without this the backend wrote UTC while the
// browser wrote local time and the two interleaved wrongly on the same timeline.
// A bad value falls back to the runtime's zone rather than failing every write.
const timeZoneFromEnv = (process.env.APP_TIMEZONE || process.env.TZ || '').trim();
let timeZone = timeZoneFromEnv;
if (timeZoneFromEnv && !isValidTimeZone(timeZoneFromEnv)) {
  console.warn(`[config] APP_TIMEZONE "${timeZoneFromEnv}" is not a known IANA zone — using the system zone`);
  timeZone = '';
}

// Language outgoing notifications are written in.
//
// A notification is composed in the browser of whoever triggered the event, so
// it used to inherit *that person's* UI language — and the UI defaults to English
// until someone picks otherwise. One deployment could therefore be announced to
// the client in English and the next in Polish, depending on who clicked. The
// recipients are a fixed audience per instance, so the language belongs to the
// instance, not to the operator.
//
// Empty means "whatever the operator's UI is set to" — the previous behaviour,
// kept so an existing deployment does not change language on upgrade.
const NOTIFY_LANGS = ['pl', 'en'];
const notifyLangFromEnv = (process.env.NOTIFY_LANG || '').trim().toLowerCase();
let notifyLang = notifyLangFromEnv;
if (notifyLangFromEnv && !NOTIFY_LANGS.includes(notifyLangFromEnv)) {
  console.warn(
    `[config] NOTIFY_LANG "${notifyLangFromEnv}" is not one of ${NOTIFY_LANGS.join('/')} — using the sender's UI language`
  );
  notifyLang = '';
}

// URL pattern of the issue tracker the test team files fixes in, with `{id}`
// standing for the ticket id (e.g. https://haloitsm.example.com/tickets?id={id}).
// A pattern rather than a base URL because trackers differ in where the id goes,
// and the ids themselves are stored verbatim as the testers type them. Empty =
// issue ids are shown as plain text.
//
// There are two, because a fixed issue carries two ids: the work item the test
// team files in Azure Boards, and the HaloITSM ticket named in that work item's
// "SM Problem" field. ISSUE_TRACKER_URL links the HaloITSM ticket (the id the
// client and the deployer recognise); WORKITEM_URL links the Azure work item.
function trackerPattern(name) {
  const value = (process.env[name] || '').trim();
  if (value && !value.includes('{id}')) {
    console.warn(
      `[config] ${name} has no {id} placeholder — those ids will be shown as plain text`
    );
    return '';
  }
  return value;
}
const issueTrackerUrl = trackerPattern('ISSUE_TRACKER_URL');
const workItemUrl = trackerPattern('WORKITEM_URL');

export const config = {
  env,
  isProd,
  version,
  // Public base URL where RollDesk is reachable (e.g. https://rolldesk.example.com).
  // Used to embed clickable links back to the app in outgoing notifications.
  // Trailing slashes are trimmed so callers can safely append paths.
  appBaseUrl: (process.env.APP_BASE_URL || '').trim().replace(/\/+$/, ''),
  port: parseInt(process.env.PORT || '3000', 10),
  // IANA zone for the stamps stored on the deployment timeline and in the change
  // history (e.g. Europe/Warsaw). Empty = the runtime's own zone.
  timeZone,
  // Language outgoing notifications are composed in ('pl' | 'en'). Empty = follow
  // the UI language of whoever triggered the event (the historical behaviour).
  notifyLang,
  // Issue-tracker link patterns containing {id}; empty = no links.
  issueTrackerUrl,
  workItemUrl,
  trustProxy: process.env.TRUST_PROXY === '1',
  allowedIps: (process.env.ALLOWED_IPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://rolldesk:rolldesk@localhost:5432/rolldesk',
  // How the backend handles pending schema migrations on startup:
  //   'auto'   (default) — apply any pending migrations before serving traffic.
  //   'verify'           — do NOT apply; only check the DB is fully migrated and
  //                        refuse to start if migrations are pending (apply them
  //                        with a separate `node src/migrate.js` step / CI job).
  migrateMode: (process.env.DB_MIGRATE || 'auto').toLowerCase() === 'verify' ? 'verify' : 'auto',
  // Update check. The backend asks GitHub for the newest release and caches the
  // answer, so the browser never calls api.github.com itself (anonymous calls
  // are limited to 60/hour per IP — shared by everyone behind the same NAT).
  // GITHUB_TOKEN is optional and only raises that limit.
  versionCheck: {
    repo: (process.env.VERSION_CHECK_REPO || 'RollDesk/rolldesk').trim(),
    token: (process.env.GITHUB_TOKEN || '').trim(),
    ttlMs: parseInt(process.env.VERSION_CHECK_TTL_MS || String(60 * 60 * 1000), 10),
    timeoutMs: parseInt(process.env.VERSION_CHECK_TIMEOUT_MS || '5000', 10),
  },
  auth: {
    jwtSecret,
    jwtSecretFromEnv: !!jwtSecretFromEnv,
    // Session token lifetime, and the short-lived lifetime for the pending
    // MFA setup/login stage tokens.
    //
    // 30 days, not 12 hours: a 12h session expired overnight, so everyone
    // re-entered a password *and* a TOTP code every morning to read a rollout
    // schedule. That is friction with no security return here — the app is
    // already behind an IP allowlist at two layers, and the tax fell on the
    // people using it hourly, which is what pushes them to keep the password
    // somewhere convenient. Note there is no server-side revocation: a session
    // JWT stays valid for its full lifetime, so archiving an account does not
    // end a session already in progress (see the note in README). Shorten this
    // for a deployment where that matters.
    sessionTtl: process.env.SESSION_TTL || '30d',
    stageTtl: process.env.MFA_STAGE_TTL || '10m',
    // Issuer/label shown in the user's authenticator app.
    mfaIssuer: process.env.MFA_ISSUER || 'RollDesk',
  },
  // Single sign-on (OIDC) — per-domain providers are configured at runtime by an
  // admin and stored in the database. `encKey` protects the IdP client secrets at
  // rest (AES-256-GCM). If unset, it is derived from JWT_SECRET so development
  // works out of the box; set a dedicated random value in production. SSO also
  // requires APP_BASE_URL (used to build the redirect URI).
  sso: {
    encKey: (process.env.SSO_ENC_KEY || '').trim(),
  },
  // ClamAV virus scanning for uploaded attachments. When CLAMAV_HOST is set the
  // backend streams each upload to clamd (INSTREAM) before storing it. If a scan
  // can't be completed, failMode decides whether to reject ('reject', default —
  // fail closed) or accept ('allow', fail open) the upload.
  av: {
    host: (process.env.CLAMAV_HOST || '').trim(),
    port: parseInt(process.env.CLAMAV_PORT || '3310', 10),
    timeoutMs: parseInt(process.env.CLAMAV_TIMEOUT_MS || '30000', 10),
    failMode: (process.env.CLAMAV_FAIL_MODE || 'reject').toLowerCase() === 'allow' ? 'allow' : 'reject',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'RollDesk <no-reply@rolldesk.local>',
    // Set SMTP_TLS_REJECT_UNAUTHORIZED=false to accept self-signed certificates.
    tlsRejectUnauthorized: String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED ?? 'true') !== 'false',
  },
  // Microsoft Graph / Teams integration for threaded channel notifications
  // (thread = deployment id). All values come from environment variables only —
  // the client secret must never be committed. When tenantId/clientId/clientSecret
  // and a target team+channel are set, notifications are posted to the Teams
  // channel and grouped per deployment; otherwise the app falls back to the
  // existing per-client webhooks.
  graph: {
    // Feature flag: posting deployment notifications to Teams via Graph is OFF
    // by default. App-only channel posting needs Graph application permissions
    // + admin consent (and may be blocked by the tenant), so until that's sorted
    // RollDesk uses the per-client webhooks. Flip GRAPH_ENABLED=1 to turn it on.
    // Reading teams/channels for setup (diagnostics) works regardless of the flag.
    enabled: /^(1|true|yes|on)$/i.test((process.env.GRAPH_ENABLED || '').trim()),
    tenantId: (process.env.GRAPH_TENANT_ID || '').trim(),
    clientId: (process.env.GRAPH_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GRAPH_CLIENT_SECRET || '').trim(),
    teamId: (process.env.TEAMS_TEAM_ID || '').trim(),
    channelId: (process.env.TEAMS_CHANNEL_ID || '').trim(),
  },
};
