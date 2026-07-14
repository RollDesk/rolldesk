// Authentication endpoints backing the first-run setup wizard, password login
// and TOTP MFA. Mounted at /api/auth. These routes are open (not behind
// requireAuth) but each self-guards: /setup 409s once configured, and the MFA
// steps require the matching short-lived stage token.
import { Router } from 'express';
import { query } from '../db.js';
import { config } from '../config.js';
import { clientIpFromRequest } from '../ipAllowlist.js';
import { credentialLimiter, mfaCodeLimiter } from '../rateLimit.js';
import { sendMail } from '../mailer.js';
import {
  emailDomain,
  getEnabledProviderByDomain,
  getProviderById,
  buildLoginRedirect,
  completeLogin,
  takeState,
  saveHandoff,
  takeHandoff,
} from '../sso.js';
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  signStageToken,
  requireStage,
  generateMfaSecret,
  generateInviteToken,
  otpauthUrl,
  qrDataUrl,
  verifyTotp,
  sha256hex,
} from '../auth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL_MS = 3 * 24 * 60 * 60 * 1000; // reset link validity: 3 days

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

  // SSO enforcement: for a domain with an enabled provider, password login is
  // disabled for everyone except local admins (a break-glass fallback so a
  // misconfigured IdP cannot lock the whole domain out). The same response is
  // returned whether or not the account exists, so it never reveals existence.
  const dom = emailDomain(email);
  const ssoRow = dom ? await getEnabledProviderByDomain(dom) : null;
  if (ssoRow && (!user || user.role !== 'admin')) {
    return res.status(403).json({
      error: 'This domain uses single sign-on. Please sign in with SSO.',
      sso: true,
      provider: ssoRow.provider,
    });
  }

  const ok = user && (await verifyPassword(password, user.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  // Archived accounts keep their history but can no longer sign in.
  if (user.archived) return res.status(403).json({ error: 'This account has been archived' });

  const stage = user.mfa_enabled ? 'mfa-login' : 'mfa-setup';
  const token = signStageToken(user, stage);
  res.json({ stage, token });
});

// POST /api/auth/forgot — self-service password reset request. Always returns a
// generic success so it never reveals whether an account exists. When the
// account exists and is active, issue a single-use reset link (valid 7 days)
// and e-mail it; the user then sets a new password via the #/invite/<token>
// link (the same flow used for admin-issued resets).
router.post('/forgot', credentialLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  if (!EMAIL_RE.test(email)) return res.status(422).json({ error: 'A valid email is required' });
  try {
    const user = await findUserByEmail(email);
    if (user && !user.archived) {
      const { raw, hash } = generateInviteToken();
      const expires = new Date(Date.now() + RESET_TTL_MS).toISOString();
      await query(
        'UPDATE users SET invite_token = $1, invite_expires = $2 WHERE id = $3',
        [hash, expires, user.id]
      );
      const base = config.appBaseUrl || '';
      const link = `${base}/#/invite/${raw}`;
      const body =
        `A password reset was requested for your RollDesk account.\n` +
        `Set a new password: ${link}\n` +
        `This link expires in 3 days.\n\n` +
        `If you didn't request this, you can safely ignore this e-mail.`;
      try {
        await sendMail({
          to: user.email,
          subject: 'RollDesk — reset your password',
          text: body,
          html: `<p>${body.replace(/\n/g, '<br>')}</p>`,
        });
      } catch (err) {
        console.warn('[auth] Could not send reset e-mail:', err.message);
      }
    }
  } catch (err) {
    console.warn('[auth] forgot-password error:', err.message);
  }
  res.json({ ok: true });
});

// --- Single sign-on (OIDC) -----------------------------------------------
// These endpoints are open. `lookup` tells the login screen whether to offer
// SSO; `start` redirects to the IdP; `callback` is the IdP's redirect target;
// `exchange` swaps the one-time handoff code for the session JWT.

function ssoErrorRedirect(res, reason) {
  const base = config.appBaseUrl || '';
  res.redirect(`${base}/?sso_error=${encodeURIComponent(reason)}`);
}

// GET /api/auth/sso/lookup?email= — does this e-mail's domain use SSO?
router.get('/sso/lookup', async (req, res) => {
  const dom = emailDomain(req.query.email);
  const row = dom ? await getEnabledProviderByDomain(dom) : null;
  res.json({ sso: !!row, provider: row ? row.provider : null, domain: dom });
});

// GET /api/auth/sso/start?domain=|email= — begin OIDC login (redirect to IdP).
router.get('/sso/start', async (req, res) => {
  try {
    if (!config.appBaseUrl) return ssoErrorRedirect(res, 'not-configured');
    const dom = String(req.query.domain || '').trim().toLowerCase() || emailDomain(req.query.email);
    const row = dom ? await getEnabledProviderByDomain(dom) : null;
    if (!row) return ssoErrorRedirect(res, 'no-provider');
    res.redirect(await buildLoginRedirect(row));
  } catch (err) {
    console.warn('[sso] start failed:', err.message);
    ssoErrorRedirect(res, 'start-failed');
  }
});

// GET /api/auth/sso/callback — IdP redirect target; exchange code -> session.
router.get('/sso/callback', async (req, res) => {
  try {
    if (req.query.error) return ssoErrorRedirect(res, 'idp-error');
    const state = String(req.query.state || '');
    const saved = state ? takeState(state) : null;
    if (!saved) return ssoErrorRedirect(res, 'expired');
    const row = await getProviderById(saved.providerId);
    if (!row || !row.enabled) return ssoErrorRedirect(res, 'no-provider');

    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const currentUrl = new URL(`${config.appBaseUrl}/api/auth/sso/callback${qs}`);
    const { email } = await completeLogin(row, currentUrl, saved);
    // The authenticated e-mail must belong to the domain we started SSO for.
    if (!email || emailDomain(email) !== saved.domain) return ssoErrorRedirect(res, 'denied');

    // No JIT provisioning: the account must already exist and be active.
    const user = await findUserByEmail(email);
    if (!user || user.archived) return ssoErrorRedirect(res, 'no-account');

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await recordLoginHistory(user.id, req);
    const code = saveHandoff(signSessionToken(user));
    res.redirect(`${config.appBaseUrl}/#/sso/${code}`);
  } catch (err) {
    console.warn('[sso] callback failed:', err.message);
    ssoErrorRedirect(res, 'callback-failed');
  }
});

// POST /api/auth/sso/exchange — swap the one-time handoff code for a session JWT.
router.post('/sso/exchange', async (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const token = takeHandoff(code);
  if (!token) return res.status(401).json({ error: 'Invalid or expired sign-in code' });
  res.json({ token });
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
  res.json({ id: user.id, email: user.email, role: user.role, name: user.name || null });
});

// GET /api/auth/invite/:token — validate an invitation / reset link. Open
// endpoint (the token IS the credential). Returns whom it's for and whether
// this is a first-time invite (enroll MFA next) or a password reset.
router.get('/invite/:token', async (req, res) => {
  const hash = sha256hex(String(req.params.token || ''));
  const { rows } = await query(
    'SELECT email, name, mfa_enabled, archived, invite_expires FROM users WHERE invite_token = $1',
    [hash]
  );
  const user = rows[0];
  if (!user || user.archived) return res.status(404).json({ error: 'Invalid or expired link' });
  if (user.invite_expires && new Date(user.invite_expires).getTime() < Date.now()) {
    return res.status(410).json({ error: 'This link has expired' });
  }
  res.json({ email: user.email, name: user.name, mode: user.mfa_enabled ? 'reset' : 'invite' });
});

// POST /api/auth/invite/:token — set the password for an invited/reset account
// and clear the token. The user then signs in normally (enrolling MFA on the
// first sign-in of a brand-new account).
router.post('/invite/:token', credentialLimiter, async (req, res) => {
  const hash = sha256hex(String(req.params.token || ''));
  const password = String((req.body && req.body.password) || '');
  if (password.length < 8) return res.status(422).json({ error: 'Password must be at least 8 characters' });

  const { rows } = await query(
    'SELECT id, archived, invite_expires FROM users WHERE invite_token = $1',
    [hash]
  );
  const user = rows[0];
  if (!user || user.archived) return res.status(404).json({ error: 'Invalid or expired link' });
  if (user.invite_expires && new Date(user.invite_expires).getTime() < Date.now()) {
    return res.status(410).json({ error: 'This link has expired' });
  }

  const password_hash = await hashPassword(password);
  await query(
    'UPDATE users SET password_hash = $1, invite_token = NULL, invite_expires = NULL WHERE id = $2',
    [password_hash, user.id]
  );
  res.json({ ok: true });
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
