// Version / update information for the UI badge. Mounted at /api/version.
//
// The running version is local; `latest` comes from GitHub through a cache in
// versionCache (one upstream call per TTL per instance, not one per browser
// tab). Deliberately kept out of /health, which must stay fast and free of
// outbound dependencies.
import { Router } from 'express';
import { config } from '../config.js';
import { versionCache } from '../versionCheck.js';

const router = Router();

router.get('/', async (_req, res) => {
  const state = await versionCache.get();
  res.json({
    version: config.version,
    latest: state.latest,
    checkedAt: state.checkedAt,
    // Present only when the last attempt failed; the UI turns this into a
    // tooltip so "latest unknown" says why (rate limit vs. no network).
    error: state.error || undefined,
  });
});

export default router;
