// Authentication endpoints backing the first-run setup wizard, password login
// and TOTP MFA. Mounted at /api/auth. These routes are open (not behind
// requireAuth) but each self-guards: /setup 409s once configured, and the MFA
// steps require the matching short-lived stage token.
import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { clientIpFromRequest } from '../ipAllowlist.js';
import { credentialLimiter, mfaCodeLimiter } from '../rateLimit.js';
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  signStageToken,
  requireStage,
  generateMfaSecret,
  otpauthUrl,
  qrDataUrl,
  verifyTotp,
} from '../auth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Record a successful sign-in for the given user (best-effort — never blocks
// the login itself if the insert fails).
async function recordLoginHistory(userId, req) {
  try {
    const ip = clientIpFromRequest(req, config.trustProxy) || null;
    const ua = (req.headers && req.headers['user-agent']) || null;
    await query(
      'INSERT INTO login_history (user_id, ip, user_agent) VALUES ($1, $2, $3)',
      [userId, ip, ua]
    );
  } catch (err) {
    console.warn('[auth] Could not record login history:', err.message);
  }
}

async function userCount() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n;
}

async function findUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// GET /api/auth/status — whether an admin account exists yet.
router.get('/status', async (_req, res) => {
  const configured = (await userCount()) > 0;
  res.json({ configured });
});

// POST /api/auth/setup — create the first admin. 409 once configured.
router.post('/setup', credentialLimiter, async (req, res) => {
  if ((await userCount()) > 0) {
    return res.status(409).json({ error: 'Already configured' });
  }
  const email = String((req.body && req.body.email) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!EMAIL_RE.test(email)) return res.status(422).json({ error: 'A valid email is required' });
  if (password.length < 8) return res.status(422).json({ error: 'Password must be at least 8 characters' });

  const password_hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id, email, role`,
    [email, password_hash]
  );
  // Created but not usable until they log in and enroll MFA.
  res.status(201).json({ id: rows[0].id, email: rows[0].email });
});

// POST /api/auth/login — verify password, hand back a stage token telling the
// client whether to enroll MFA or enter an existing code.
router.post('/login', credentialLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const user = await findUserByEmail(email);
  const ok = user && (await verifyPassword(password, user.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const stage = user.mfa_enabled ? 'mfa-login' : 'mfa-setup';
  const token = signStageToken(user, stage);
  res.json({ stage, token });
});

// POST /api/auth/mfa/setup — (stage=mfa-setup) generate + store a pending
// secret and return the otpauth URL + QR data URL to display.
router.post('/mfa/setup', requireStage('mfa-setup'), async (req, res) => {
  const user = await findUserById(req.auth.sub);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  if (user.mfa_enabled) return res.status(409).json({ error: 'MFA already enabled' });

  const secret = generateMfaSecret();
  await query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, user.id]);
  const otpauth = otpauthUrl(user.email, secret);
  const qr = await qrDataUrl(otpauth);
  res.json({ otpauthUrl: otpauth, qrDataUrl: qr });
});

// POST /api/auth/mfa/verify — (stage=mfa-setup) verify the first code, enable
// MFA and return a full session token.
router.post('/mfa/verify', mfaCodeLimiter, requireStage('mfa-setup'), async (req, res) => {
  const user = await findUserById(req.auth.sub);
  if (!user || !user.mfa_secret) return res.status(400).json({ error: 'MFA setup not started' });
  const code = (req.body && req.body.code) || '';
  if (!verifyTotp(code, user.mfa_secret)) return res.status(401).json({ error: 'Invalid code' });

  await query('UPDATE users SET mfa_enabled = true, last_login_at = now() WHERE id = $1', [user.id]);
  await recordLoginHistory(user.id, req);
  res.json({ token: signSessionToken(user) });
});

// POST /api/auth/mfa/login — (stage=mfa-login) verify a code for an already
// enrolled user and return a full session token.
router.post('/mfa/login', mfaCodeLimiter, requireStage('mfa-login'), async (req, res) => {
  const user = await findUserById(req.auth.sub);
  if (!user || !user.mfa_enabled || !user.mfa_secret) {
    return res.status(400).json({ error: 'MFA is not enabled' });
  }
  const code = (req.body && req.body.code) || '';
  if (!verifyTotp(code, user.mfa_secret)) return res.status(401).json({ error: 'Invalid code' });

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await recordLoginHistory(user.id, req);
  res.json({ token: signSessionToken(user) });
});

// GET /api/auth/login-history — recent sign-ins for the current session's user.
router.get('/login-history', requireStage('session'), async (req, res) => {
  const { rows } = await query(
    `SELECT logged_in_at, ip, user_agent
       FROM login_history
      WHERE user_id = $1
      ORDER BY logged_in_at DESC
      LIMIT 100`,
    [req.auth.sub]
  );
  res.json(rows.map(r => ({ at: r.logged_in_at, ip: r.ip, userAgent: r.user_agent })));
});

// GET /api/auth/me — the current session's user.
router.get('/me', requireStage('session'), async (req, res) => {
  const user = await findUserById(req.auth.sub);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  res.json({ id: user.id, email: user.email, role: user.role });
});

// POST /api/auth/mfa/reconfigure — (session) generate a NEW pending secret for
// the signed-in user and return its QR. The active authenticator keeps working
// until the new code is confirmed via /mfa/reconfigure/verify.
router.post('/mfa/reconfigure', requireStage('session'), async (req, res) => {
  const user = await findUserById(req.auth.sub);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const secret = generateMfaSecret();
  await query('UPDATE users SET mfa_pending_secret = $1 WHERE id = $2', [secret, user.id]);
  const otpauth = otpauthUrl(user.email, secret);
  const qr = await qrDataUrl(otpauth);
  res.json({ otpauthUrl: otpauth, qrDataUrl: qr });
});

// POST /api/auth/mfa/reconfigure/verify — (session) confirm a code from the new
// authenticator; on success the pending secret becomes the active one.
router.post('/mfa/reconfigure/verify', mfaCodeLimiter, requireStage('session'), async (req, res) => {
  const user = await findUserById(req.auth.sub);
  if (!user || !user.mfa_pending_secret) {
    return res.status(400).json({ error: 'MFA reconfigure not started' });
  }
  const code = (req.body && req.body.code) || '';
  if (!verifyTotp(code, user.mfa_pending_secret)) return res.status(401).json({ error: 'Invalid code' });

  await query(
    'UPDATE users SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL, mfa_enabled = true WHERE id = $1',
    [user.id]
  );
  res.json({ ok: true });
});

export default router;
