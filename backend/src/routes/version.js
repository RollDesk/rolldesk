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
    // Language the UI must compose outgoing notifications in, so a notification
    // does not inherit the language of whoever happened to trigger it. Empty
    // means "follow my own UI language". This endpoint carries it because the UI
    // already calls it right after sign-in, before any event can be dispatched.
    notifyLang: config.notifyLang || undefined,
    // Link pattern for the issue ids listed on a release package ({id} is
    // substituted). Carried here for the same reason as notifyLang: the UI has
    // this response before it renders any package or deployment.
    issueTrackerUrl: config.issueTrackerUrl || undefined,
    // Present only when the last attempt failed; the UI turns this into a
    // tooltip so "latest unknown" says why (rate limit vs. no network).
    error: state.error || undefined,
  });
});

export default router;
