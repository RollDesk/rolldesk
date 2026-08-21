// Combined authentication guard for the data API. A request is accepted if it
// carries EITHER a full session JWT (issued by the login flow) OR a valid
// personal access token (prefix `rd_live_`, looked up by hash in api_tokens).
//
// This is what makes the automation API real: scripts/CI can call /api/* with
// `Authorization: Bearer rd_live_…` instead of going through the interactive
// login. Token-management endpoints deliberately do NOT use this guard — they
// require an interactive session so a token cannot mint or revoke other tokens.
import { query } from './db.js';
import { bearerToken, verifyToken, hashApiToken, isApiToken, resolveLiveAuth } from './auth.js';

export async function requireApiAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  // Personal access token path.
  if (isApiToken(token)) {
    try {
      const { rows } = await query(
        `SELECT t.id, t.user_id, t.expires_at, t.revoked_at, u.role, u.email
           FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1`,
        [hashApiToken(token)]
      );
      const row = rows[0];
      if (!row) return res.status(401).json({ error: 'Invalid token' });
      if (row.revoked_at) return res.status(401).json({ error: 'Token revoked' });
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ error: 'Token expired' });
      }
      // Best-effort last-used stamp; never blocks the request.
      query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id])
        .catch(() => {});
      req.auth = { sub: row.user_id, email: row.email, role: row.role, stage: 'session', via: 'token' };
      return next();
    } catch (err) {
      console.warn('[apiAuth] Token lookup failed:', err.message);
      return res.status(500).json({ error: 'Authentication error' });
    }
  }

  // Session JWT path. The claim proves who is calling; the role comes from the
  // account as it is now, exactly like the token lookup above reads `u.role` —
  // a session lives for 30 days and must not carry a role somebody has since
  // changed (see liveAuthDecision in auth.js).
  let claim;
  try {
    claim = verifyToken(token, { stage: 'session' });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const decision = await resolveLiveAuth(claim);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    req.auth = decision.auth;
    return next();
  } catch (err) {
    console.warn('[apiAuth] Live role lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication error' });
  }
}
