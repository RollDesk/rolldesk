// Personal access token management for the signed-in user. Mounted at
// /api/tokens behind requireStage('session') — these endpoints require an
// interactive session (a JWT), never an API token, so a token can't create or
// revoke tokens. The raw token value is returned exactly once, at creation.
import { Router } from 'express';
import { query } from '../db.js';
import { generateApiToken } from '../auth.js';

const router = Router();

function serialize(row) {
  const revoked = !!row.revoked_at;
  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now();
  return {
    id: Number(row.id),
    name: row.name || null,
    masked: row.prefix,
    created: row.created_at,
    expiry: row.expires_at || null,
    lastUsed: row.last_used_at || null,
    revoked,
    status: revoked ? 'revoked' : (expired ? 'expired' : 'active'),
  };
}

// GET /api/tokens — list the current user's tokens (never returns raw values).
router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, prefix, expires_at, last_used_at, revoked_at, created_at
       FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.auth.sub]
  );
  res.json(rows.map(serialize));
});

// POST /api/tokens — create a token. Body: { name?, expiresInDays? }.
// Returns the serialized token PLUS `token` (the raw value) once.
router.post('/', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 120) || null;
  const daysRaw = req.body && req.body.expiresInDays;
  let expiresAt = null;
  if (daysRaw !== undefined && daysRaw !== null && String(daysRaw) !== 'none') {
    const days = parseInt(daysRaw, 10);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return res.status(422).json({ error: 'expiresInDays must be a positive number of days (<= 3650)' });
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  const { raw, hash, masked } = generateApiToken();
  const { rows } = await query(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, expires_at, last_used_at, revoked_at, created_at`,
    [req.auth.sub, name, hash, masked, expiresAt]
  );
  res.status(201).json(Object.assign(serialize(rows[0]), { token: raw }));
});

// POST /api/tokens/:id/revoke — revoke one of the current user's tokens.
router.post('/:id/revoke', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid token id' });
  const { rows } = await query(
    `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND user_id = $2
      RETURNING id, name, prefix, expires_at, last_used_at, revoked_at, created_at`,
    [id, req.auth.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Token not found' });
  res.json(serialize(rows[0]));
});

export default router;
