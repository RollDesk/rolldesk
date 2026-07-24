// Microsoft Teams (Graph) diagnostics.
//   GET /api/teams/graph/status              — is Graph configured / token OK / can post
//   GET /api/teams/graph/teams               — list joined teams (admin, discovery)
//   GET /api/teams/graph/channels?teamId=... — list channels of a team (admin)
// Status is available to any signed-in non-client (the SPA probes it to decide
// whether to dispatch notifications). Listing teams/channels is admin-only, as
// it can enumerate the organisation's Teams structure.
import { Router } from 'express';
import { forbidClient } from '../rbac.js';
import * as teamsGraph from '../teamsGraph.js';

const router = Router();

router.use(forbidClient);

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required' });
  }
  next();
}

router.get('/graph/status', async (_req, res) => {
  res.json(await teamsGraph.status());
});

router.get('/graph/teams', requireAdmin, async (_req, res) => {
  if (!teamsGraph.isConfigured()) return res.status(400).json({ error: 'Graph is not configured' });
  try {
    res.json({ teams: await teamsGraph.listTeams() });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

router.get('/graph/channels', requireAdmin, async (req, res) => {
  if (!teamsGraph.isConfigured()) return res.status(400).json({ error: 'Graph is not configured' });
  const teamId = String(req.query.teamId || '').trim();
  if (!teamId) return res.status(422).json({ error: 'teamId is required' });
  try {
    res.json({ channels: await teamsGraph.listChannels(teamId) });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

export default router;
