// User directory + management (admin only). Mounted at /api/users behind a
// session guard; every handler additionally requires the caller to be an admin.
//
// Users created here are real login accounts: they start without a password and
// receive a single-use invitation link (shown in the UI and, if SMTP is
// configured, e-mailed). Following the link sets their password; MFA is then
// enrolled on first sign-in via the normal login flow.
import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { sendMail } from '../mailer.js';
import { generateInviteToken } from '../auth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(['admin', 'rm', 'installer', 'client']);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Only admins may manage users.
function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required' });
  }
  next();
}
router.use(requireAdmin);

function serialize(row) {
  return {
    id: row.id,
    name: row.name || (row.email ? row.email.split('@')[0] : ''),
    email: row.email,
    role: row.role,
    projects: Array.isArray(row.projects) ? row.projects : [],
    clientKey: row.client_key || null,
    archived: !!row.archived,
    archivedReason: row.archived_reason || '',
    // No password set yet AND an invite is outstanding → still pending.
    invitePending: !row.password_hash,
    mfaEnabled: !!row.mfa_enabled,
  };
}

// Create a fresh invite token for a user, store its hash + expiry, and return
// the link (plus best-effort e-mail delivery). Used by invite/resend/reset.
async function issueInvite(user, actorEmail) {
  const { raw, hash } = generateInviteToken();
  const expires = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  await query('UPDATE users SET invite_token = $1, invite_expires = $2 WHERE id = $3', [hash, expires, user.id]);

  const base = config.appBaseUrl || '';
  const link = `${base}/#/invite/${raw}`;
  const isReset = !!user.mfa_enabled;
  const subject = isReset ? 'RollDesk — set a new password' : 'RollDesk — you have been invited';
  const body = isReset
    ? `A password reset was requested for your RollDesk account.\nSet a new password: ${link}\nThis link expires in 7 days.`
    : `You have been invited to RollDesk${actorEmail ? ' by ' + actorEmail : ''}.\nSet your password and enable two-factor authentication: ${link}\nThis link expires in 7 days.`;

  let emailed = false, emailError = null;
  try {
    const r = await sendMail({ to: user.email, subject, text: body, html: `<p>${body.replace(/\n/g, '<br>')}</p>` });
    emailed = !r.skipped;
    if (r.skipped) emailError = 'SMTP not configured';
  } catch (err) {
    emailError = err.message;
  }
  // The link is returned so the admin can copy/share it even without SMTP.
  return { link, emailed, emailError, expires };
}

// GET /api/users — the whole directory.
router.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT id, email, role, name, projects, client_key, archived, archived_reason,
            password_hash, mfa_enabled
       FROM users ORDER BY archived ASC, created_at ASC`
  );
  res.json(rows.map(serialize));
});

// POST /api/users — invite a new user.
router.post('/', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim() || null;
  const role = String(b.role || '').trim();
  const projects = Array.isArray(b.projects) ? b.projects.map(String) : [];
  const clientKey = b.clientKey ? String(b.clientKey) : null;

  if (!EMAIL_RE.test(email)) return res.status(422).json({ error: 'A valid e-mail is required' });
  if (!ROLES.has(role)) return res.status(422).json({ error: 'Invalid role' });

  const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.rows[0]) return res.status(409).json({ error: 'A user with this e-mail already exists' });

  const { rows } = await query(
    `INSERT INTO users (email, role, name, projects, client_key, invited_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id, email, role, name, projects, client_key, archived, archived_reason, password_hash, mfa_enabled`,
    [email, role, name, JSON.stringify(projects), clientKey, (req.auth && req.auth.email) || null]
  );
  const user = rows[0];
  const invite = await issueInvite(user, req.auth && req.auth.email);
  res.status(201).json(Object.assign(serialize(user), { invite }));
});

// PUT /api/users/:id — update name / role / project access.
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
  const b = req.body || {};
  const name = String(b.name || '').trim() || null;
  const role = String(b.role || '').trim();
  const projects = Array.isArray(b.projects) ? b.projects.map(String) : [];
  const clientKey = b.clientKey ? String(b.clientKey) : null;
  if (!ROLES.has(role)) return res.status(422).json({ error: 'Invalid role' });

  // Don't let the last admin be demoted (would lock everyone out of user mgmt).
  if (req.auth && req.auth.sub === id && role !== 'admin') {
    const admins = await query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND NOT archived`);
    if (admins.rows[0].n <= 1) return res.status(409).json({ error: 'Cannot demote the last administrator' });
  }

  const { rows } = await query(
    `UPDATE users SET name = $1, role = $2, projects = $3::jsonb, client_key = $4
      WHERE id = $5
      RETURNING id, email, role, name, projects, client_key, archived, archived_reason, password_hash, mfa_enabled`,
    [name, role, JSON.stringify(projects), clientKey, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(serialize(rows[0]));
});

// POST /api/users/:id/archive — soft-delete (blocks sign-in, keeps history).
router.post('/:id/archive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
  if (req.auth && req.auth.sub === id) return res.status(409).json({ error: 'You cannot archive your own account' });
  const reason = String((req.body && req.body.reason) || '').trim() || null;
  const { rows } = await query(
    `UPDATE users SET archived = true, archived_reason = $2 WHERE id = $1
      RETURNING id, email, role, name, projects, client_key, archived, archived_reason, password_hash, mfa_enabled`,
    [id, reason]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(serialize(rows[0]));
});

// POST /api/users/:id/restore — undo archive.
router.post('/:id/restore', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
  const { rows } = await query(
    `UPDATE users SET archived = false, archived_reason = NULL WHERE id = $1
      RETURNING id, email, role, name, projects, client_key, archived, archived_reason, password_hash, mfa_enabled`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(serialize(rows[0]));
});

// POST /api/users/:id/resend-invite — re-issue the invitation link.
router.post('/:id/resend-invite', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await query('SELECT id, email, mfa_enabled FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const invite = await issueInvite(rows[0], req.auth && req.auth.email);
  res.json({ ok: true, invite });
});

// POST /api/users/:id/reset-password — issue a set-new-password link.
router.post('/:id/reset-password', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await query('SELECT id, email, mfa_enabled FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const invite = await issueInvite(rows[0], req.auth && req.auth.email);
  res.json({ ok: true, invite });
});

export default router;
