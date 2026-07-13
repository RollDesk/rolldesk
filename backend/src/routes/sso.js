// Single sign-on provider management (admin only). Mounted at /api/sso behind a
// session guard; every handler additionally requires the caller to be an admin.
//
// Providers map an e-mail domain to an OIDC identity provider. The IdP client
// secret is accepted here, encrypted, and stored — it is never sent back to the
// client (responses only expose `hasSecret`). The read-only redirect URI to
// register in the IdP is returned so the admin can copy it.
import { Router } from 'express';
import { query } from '../db.js';
import {
  SSO_PROVIDERS,
  computeIssuer,
  encryptSecret,
  serializeProvider,
  listProviders,
  getProviderById,
  getOidcConfig,
  invalidateOidcConfig,
  ssoRedirectUri,
} from '../sso.js';

const router = Router();

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required' });
  }
  next();
}
router.use(requireAdmin);

function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^@/, '');
}

// GET /api/sso — all configured providers (without secrets) + the redirect URI.
router.get('/', async (_req, res) => {
  const rows = await listProviders();
  res.json({ redirectUri: ssoRedirectUri(), providers: rows.map(serializeProvider) });
});

// POST /api/sso — add a provider for a domain.
router.post('/', async (req, res) => {
  const b = req.body || {};
  const domain = normalizeDomain(b.domain);
  const provider = String(b.provider || 'azure').toLowerCase();
  if (!DOMAIN_RE.test(domain)) return res.status(422).json({ error: 'A valid e-mail domain is required' });
  if (!SSO_PROVIDERS.has(provider)) return res.status(422).json({ error: 'Unknown provider' });
  const clientId = String(b.clientId || '').trim();
  const clientSecret = String(b.clientSecret || '');
  if (!clientId) return res.status(422).json({ error: 'Client ID is required' });
  if (!clientSecret) return res.status(422).json({ error: 'Client secret is required' });

  let issuer;
  try {
    issuer = computeIssuer(provider, { tenant: b.tenant, issuer: b.issuer });
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  try {
    const { rows } = await query(
      `INSERT INTO sso_providers (domain, provider, issuer, client_id, client_secret_enc, enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [domain, provider, issuer, clientId, encryptSecret(clientSecret), b.enabled !== false]
    );
    res.status(201).json(serializeProvider(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SSO is already configured for this domain' });
    throw err;
  }
});

// PUT /api/sso/:id — update a provider. The client secret is only replaced when
// a non-empty value is supplied (so editing other fields keeps the stored one).
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await getProviderById(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  const domain = b.domain !== undefined ? normalizeDomain(b.domain) : existing.domain;
  const provider = b.provider !== undefined ? String(b.provider).toLowerCase() : existing.provider;
  if (!DOMAIN_RE.test(domain)) return res.status(422).json({ error: 'A valid e-mail domain is required' });
  if (!SSO_PROVIDERS.has(provider)) return res.status(422).json({ error: 'Unknown provider' });
  const clientId = b.clientId !== undefined ? String(b.clientId).trim() : existing.client_id;
  if (!clientId) return res.status(422).json({ error: 'Client ID is required' });

  let issuer = existing.issuer;
  if (b.provider !== undefined || b.tenant !== undefined || b.issuer !== undefined) {
    try {
      issuer = computeIssuer(provider, { tenant: b.tenant, issuer: b.issuer });
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
  }

  const secretEnc = b.clientSecret ? encryptSecret(String(b.clientSecret)) : existing.client_secret_enc;
  const enabled = b.enabled !== undefined ? !!b.enabled : existing.enabled;

  try {
    const { rows } = await query(
      `UPDATE sso_providers
          SET domain = $1, provider = $2, issuer = $3, client_id = $4,
              client_secret_enc = $5, enabled = $6, updated_at = now()
        WHERE id = $7
        RETURNING *`,
      [domain, provider, issuer, clientId, secretEnc, enabled, id]
    );
    invalidateOidcConfig(id);
    res.json(serializeProvider(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SSO is already configured for this domain' });
    throw err;
  }
});

// DELETE /api/sso/:id — remove a provider.
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query('DELETE FROM sso_providers WHERE id = $1', [id]);
  invalidateOidcConfig(id);
  res.json({ ok: true });
});

// POST /api/sso/:id/test — validate the config by running OIDC discovery against
// the issuer. Confirms the issuer is reachable and advertises the endpoints.
router.post('/:id/test', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await getProviderById(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const cfg = await getOidcConfig(row);
    const meta = cfg.serverMetadata();
    res.json({
      ok: true,
      issuer: meta.issuer,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

export default router;
