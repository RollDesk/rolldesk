// Project endpoints (with apps stored in the JSONB data column).
import { Router } from 'express';
import { query, pool } from '../db.js';
import { requireWriteRole, requireAdminRole, isClient, clientScope } from '../rbac.js';
import { normalizeTrackerSettings, trackerLinkPatterns, trackerProjects } from '../tracker.js';
import { trackerSettingsForStorage, trackerStatus } from '../trackerService.js';
import { normalizeClientMove, staleClientGrants } from '../projectClient.js';

const router = Router();

// The project's `data` JSONB carries the tracker credentials (encrypted), so the
// stored shape is not safe to hand back verbatim. Everything except the secrets
// is public to the team; the secrets are replaced by a boolean saying whether one
// is on file, which is all the admin UI needs to render "configured".
function publicTracker(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    azureOrgUrl: t.azureOrgUrl || '',
    // The list is what the form edits; the single name stays for anything reading
    // the older shape (a project configured before the list existed carries only
    // that one, which trackerProjects() reads as a one-entry list).
    azureProjects: trackerProjects(t),
    azureProject: t.azureProject || '',
    // `smProblemField` is what this setting was called before the field names
    // became configurable; a project stored then still carries it.
    ticketField: t.ticketField || t.smProblemField || '',
    haloBaseUrl: t.haloBaseUrl || '',
    ticketPath: t.ticketPath || '',
    ticketLinkPath: t.ticketLinkPath || '',
    officeField: t.officeField || '',
    azurePatSet: !!t.azurePatEnc,
    haloApiKeySet: !!t.haloApiKeyEnc,
  };
}

// The link patterns a reader needs to open an issue id, derived from the same
// settings. Sent with the project rather than only from /api/version because they
// are per-project: two projects may live in different Azure organisations and
// report to different service desks, so one instance-wide pattern cannot be right
// for both. The UI falls back to the environment settings when a project has none.
function trackerLinks(raw) {
  const { workItemUrl, issueTrackerUrl } = trackerLinkPatterns(raw);
  if (!workItemUrl && !issueTrackerUrl) return undefined;
  return { workItemUrl: workItemUrl || undefined, issueTrackerUrl: issueTrackerUrl || undefined };
}

function rowToObj(r) {
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  const out = Object.assign(
    { key: r.key, clientName: r.client_name, name: r.name,
      defaultDays: r.default_days, defaultTime: r.default_time,
      clientVisible: r.client_visible },
    data
  );
  // Never let an encrypted PAT leave the backend, even though it could not be
  // read without the key: a secret that is not sent cannot be logged, cached by
  // a proxy, or left in a browser's memory.
  if (data.tracker) {
    out.tracker = publicTracker(data.tracker);
    out.trackerLinks = trackerLinks(data.tracker);
  }
  return out;
}

// GET /api/projects — client accounts only see the client-visible projects they
// were granted; the team sees everything.
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM projects ORDER BY client_name, name');
  let list = rows.map(rowToObj);
  if (isClient(req)) {
    const { projects } = await clientScope(req);
    list = list.filter(p => p.clientVisible !== false && projects.includes(p.key));
    // Which trackers we integrate with is internal plumbing, not part of what a
    // client is shown about their own project. The link patterns go with it: they
    // name our Azure organisation and our service desk, and neither is reachable
    // by a client account, so a client reads the ids as text.
    list = list.map((p) => {
      const q = Object.assign({}, p);
      delete q.tracker;
      delete q.trackerLinks;
      return q;
    });
  }
  res.json(list);
});

router.put('/:key', requireWriteRole, async (req, res) => {
  const b = req.body || {};
  const data = Object.assign({}, b);
  ['key','clientName','name','defaultDays','defaultTime','clientVisible'].forEach(k=>delete data[k]);

  // What is already stored for this project, read once: the tracker credentials
  // this PUT must not lose, and the client that owns it.
  const { rows: prevRows } = await query(
    `SELECT client_name, data->'tracker' AS tracker, data->>'client' AS client
       FROM projects WHERE key = $1`,
    [req.params.key]
  );
  const prev = prevRows[0] || null;

  // The tracker block is the one part of `data` that cannot be stored as it
  // arrives: the PAT and the Halo API key are encrypted at rest (as the SSO
  // client secrets are), and a blank secret field means "keep the stored one"
  // rather than "erase it" — the browser is never sent a secret to send back.
  delete data.tracker;
  if (b.tracker !== undefined) {
    if (b.tracker === null) {
      // An explicit null clears the whole integration for this project.
    } else {
      const shaped = normalizeTrackerSettings(b.tracker);
      if (!shaped.ok) return res.status(422).json({ error: shaped.error });
      data.tracker = trackerSettingsForStorage(
        shaped.data,
        { azurePat: b.tracker.azurePat, haloApiKey: b.tracker.haloApiKey },
        prev && prev.tracker
      );
    }
  } else if (prev && prev.tracker) {
    // A PUT that does not mention the tracker (every existing caller, including
    // the project editor) must not drop credentials an admin set up earlier.
    data.tracker = prev.tracker;
  }

  // Which client owns an existing project is changed only by the move endpoint
  // below, never by a whole-object save. This PUT replaces the project with what
  // the browser holds, and a tab that loaded the project before it was moved
  // still holds the old client — accepting that would silently move the project
  // back without revoking anything, which is the leak the move endpoint prevents.
  // A brand-new project (no stored row) takes its client from the body as before.
  let clientName = b.clientName || 'Client';
  if (prev && prev.client) {
    data.client = prev.client;
    // The display name still follows the body while the key agrees, so renaming a
    // client and saving one of its projects keeps repairing a stale name.
    if (String(b.client || '') !== String(prev.client)) clientName = prev.client_name;
  }

  const { rows } = await query(
    `INSERT INTO projects (key, client_name, name, default_days, default_time, client_visible, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key) DO UPDATE
       SET client_name=EXCLUDED.client_name, name=EXCLUDED.name,
           default_days=EXCLUDED.default_days, default_time=EXCLUDED.default_time,
           client_visible=EXCLUDED.client_visible, data=EXCLUDED.data
     RETURNING *`,
    [req.params.key, clientName, b.name || req.params.key,
     b.defaultDays || 5, b.defaultTime || '20:00',
     b.clientVisible !== false, data]
  );
  res.json(rowToObj(rows[0]));
});

// PUT /api/projects/:key/client — move the project under another client.
//
// Deliberately its own endpoint rather than a field of the project PUT: the move
// is not only a rename. It has to revoke the client-side access granted while the
// project belonged to the old client, and both halves must happen together — a
// project that has changed hands while the previous client's accounts still hold
// a grant is exactly the leak this endpoint exists to prevent. So it runs in one
// transaction, and it is admin-only (see requireAdminRole).
//
// Everything else about the project — its key, applications, targets, settings,
// deployments, release packages and history — is untouched. Deployment events
// start going to the new client's webhooks, because those are read per project
// from its client at send time.
router.put('/:key/client', requireAdminRole, async (req, res) => {
  const key = req.params.key;

  const { rows: stateRows } = await query(`SELECT data FROM app_state WHERE key = 'clients'`);
  const shaped = normalizeClientMove(req.body, stateRows.length ? stateRows[0].data : null);
  if (!shaped.ok) return res.status(422).json({ error: shaped.error });
  const { clientKey, clientName } = shaped.data;

  const { rows: projRows } = await query('SELECT * FROM projects WHERE key = $1', [key]);
  if (!projRows.length) return res.status(404).json({ error: 'Not found' });
  const project = projRows[0];
  const previous = (project.data && project.data.client) || '';

  // Two active projects of one client with the same name are indistinguishable in
  // every list and picker, so the target client is checked for the name the
  // project is bringing with it — the same rule the project rename applies.
  // `archived` lives in the JSONB, and comparing it as text avoids a cast error
  // on a value some older client wrote as something other than a JSON boolean.
  const { rows: dupRows } = await query(
    `SELECT key FROM projects
      WHERE key <> $1
        AND data->>'client' = $2
        AND lower(name) = lower($3)
        AND COALESCE(data->>'archived', 'false') <> 'true'
      LIMIT 1`,
    [key, clientKey, project.name]
  );
  if (dupRows.length) {
    return res.status(409).json({ error: 'A project with this name already exists for this client' });
  }

  const conn = await pool.connect();
  let moved;
  let revoked = [];
  try {
    await conn.query('BEGIN');
    const { rows: updated } = await conn.query(
      `UPDATE projects
          SET client_name = $2,
              data = jsonb_set(COALESCE(data, '{}'::jsonb), '{client}', to_jsonb($3::text), true)
        WHERE key = $1
        RETURNING *`,
      [key, clientName, clientKey]
    );
    moved = updated[0];

    // Client accounts holding this project. Read inside the transaction so a
    // grant added while the move is in flight is either revoked here or made
    // after the project already belongs to the new client.
    const { rows: holders } = await conn.query(
      `SELECT id, email, name, role, projects, client_key
         FROM users
        WHERE role = 'client' AND projects @> to_jsonb($1::text)`,
      [key]
    );
    const stale = staleClientGrants(
      holders.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        projects: Array.isArray(r.projects) ? r.projects.map(String) : [],
        clientKey: r.client_key,
      })),
      key,
      clientKey
    );
    for (const u of stale) {
      await conn.query('UPDATE users SET projects = $2::jsonb WHERE id = $1', [
        u.id,
        JSON.stringify(u.projects.filter((k) => k !== key)),
      ]);
    }
    await conn.query('COMMIT');
    revoked = stale.map((u) => ({ id: u.id, email: u.email, name: u.name || '' }));
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  res.json({ project: rowToObj(moved), previousClient: previous, revoked });
});

// GET /api/projects/:key/tracker — what an admin sees in the integration form:
// the URLs and field name, plus whether each secret is on file. Never the secrets.
router.get('/:key/tracker', requireWriteRole, async (req, res) => {
  const { rows } = await query(`SELECT data->'tracker' AS tracker FROM projects WHERE key = $1`, [req.params.key]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const raw = rows[0].tracker;
  const shown = publicTracker(raw);
  res.json(Object.assign(shown, {
    status: trackerStatus(Object.assign({}, shown, {
      // trackerStatus only asks whether a secret exists, so a placeholder stands
      // in for it — no decryption, and nothing secret leaves this function.
      azurePat: shown.azurePatSet ? 'set' : '',
      haloApiKey: shown.haloApiKeySet ? 'set' : '',
    })),
  }));
});

// DELETE /api/projects/:key — remove a project and its deployments. Team only.
router.delete('/:key', requireWriteRole, async (req, res) => {
  const key = req.params.key;
  await query('DELETE FROM deployments WHERE project_key = $1', [key]);
  const { rowCount } = await query('DELETE FROM projects WHERE key = $1', [key]);
  res.json({ deleted: rowCount > 0, key });
});

export default router;
