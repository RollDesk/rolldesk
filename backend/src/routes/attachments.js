// Attachment endpoints — files are stored as raw bytes (BYTEA) in the DB.
//
// Upload/list are scoped to a deployment; download/delete address a single
// attachment by its own id. All routes sit behind requireAuth (mounted in
// index.js), so the browser downloads via an authenticated fetch + blob rather
// than a plain <a href> (which couldn't carry the Bearer token).
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { config } from '../config.js';
import { avEnabled, scanBuffer } from '../antivirus.js';
import {
  forbidClient, loadDeploymentAccess, canReadDeployment, isClient,
  projectSharesAdminInfo, instructionAttachmentIds,
  loadPackageAccess, canReadPackage, requirePackageRole,
} from '../rbac.js';
// The two file-kind rules live with the rest of the package logic so the route
// and the package payload cannot disagree about what is client-facing.
import { requestedFileKind, isInstructionFile, visiblePackageFiles } from '../releasePackage.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const router = Router();

// Shape returned to the client — never includes the raw bytes.
function meta(r) {
  return {
    id: String(r.id),
    deploymentId: r.deployment_id || undefined,
    packageId: r.package_id || undefined,
    filename: r.filename,
    kind: r.kind || 'changelog',
    mime: r.mime,
    size: Number(r.byte_size),
    uploadedAt: r.uploaded_at,
  };
}

// Virus-scan an upload before it is stored, when a ClamAV host is configured.
// Returns an error response body to send, or null when the file may be stored.
// Shared by both upload routes so a package file is scanned exactly like a
// deployment file — an unscanned path would be the one an attacker picks.
async function scanRejection(buffer) {
  if (!avEnabled()) return null;
  let result;
  try {
    result = await scanBuffer(buffer);
  } catch (err) {
    console.warn('[av] scan failed:', err.message);
    if (config.av.failMode !== 'allow') {
      return { status: 503, body: { error: 'Virus scan unavailable - upload rejected', detail: err.message } };
    }
    // fail-open: allow the upload but note it wasn't scanned.
    return null;
  }
  if (result && !result.clean) {
    return { status: 422, body: { error: 'File rejected by virus scan', virus: result.virus } };
  }
  return null;
}

// POST /api/deployments/:id/attachments  (multipart/form-data, field "file")
// Uploading is a team action: clients are rejected outright, and any other
// scoped role (e.g. a deployer) must have access to the target deployment.
router.post('/deployments/:id/attachments', forbidClient, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'No file uploaded (form field "file")' });
  const dep = await loadDeploymentAccess(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });
  if (!(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Deployment not found' });

  const rejected = await scanRejection(req.file.buffer);
  if (rejected) return res.status(rejected.status).json(rejected.body);

  const { originalname, mimetype, size, buffer } = req.file;
  const uploadedBy = req.auth && req.auth.sub ? req.auth.sub : null;
  const { rows } = await query(
    `INSERT INTO attachments (deployment_id, filename, mime, byte_size, content, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, deployment_id, package_id, kind, filename, mime, byte_size, uploaded_at`,
    [req.params.id, originalname, mimetype || 'application/octet-stream', size, buffer, uploadedBy]
  );
  res.status(201).json(meta(rows[0]));
});

// POST /api/packages/:id/attachments  (multipart/form-data, field "file")
// The changelog and instruction files belong to the build, so they are uploaded
// once onto the package. Writing one is a package action (admin/rm/tester), and
// the package must be inside the caller's scope.
router.post('/packages/:id/attachments', requirePackageRole, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'No file uploaded (form field "file")' });
  const pkg = await loadPackageAccess(req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  if (!(await canReadPackage(req, pkg))) return res.status(404).json({ error: 'Package not found' });

  const rejected = await scanRejection(req.file.buffer);
  if (rejected) return res.status(rejected.status).json(rejected.body);

  const { originalname, mimetype, size, buffer } = req.file;
  const uploadedBy = req.auth && req.auth.sub ? req.auth.sub : null;
  const { rows } = await query(
    `INSERT INTO attachments (package_id, kind, filename, mime, byte_size, content, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, deployment_id, package_id, kind, filename, mime, byte_size, uploaded_at`,
    [req.params.id, requestedFileKind(req.body), originalname,
     mimetype || 'application/octet-stream', size, buffer, uploadedBy]
  );
  res.status(201).json(meta(rows[0]));
});

// GET /api/packages/:id/attachments — metadata list (no bytes).
router.get('/packages/:id/attachments', async (req, res) => {
  const pkg = await loadPackageAccess(req.params.id);
  if (!pkg || !(await canReadPackage(req, pkg))) return res.status(404).json({ error: 'Not found' });
  const { rows } = await query(
    `SELECT id, deployment_id, package_id, kind, filename, mime, byte_size, uploaded_at
       FROM attachments WHERE package_id = $1 ORDER BY uploaded_at ASC`,
    [req.params.id]
  );
  // Instruction files stay team-only unless the project shares admin info, the
  // same rule the deployment list applies — moving the files onto the package
  // must not widen who can read them.
  const client = isClient(req);
  res.json(visiblePackageFiles(rows.map(meta), {
    isClient: client,
    // Only asked when it can change the answer: the lookup is a query, and for
    // every team role the result is discarded.
    sharesAdminInfo: client ? await projectSharesAdminInfo(pkg.project_key) : true,
  }));
});

// GET /api/deployments/:id/attachments — metadata list (no bytes).
router.get('/deployments/:id/attachments', async (req, res) => {
  const dep = await loadDeploymentAccess(req.params.id);
  if (!dep || !(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Not found' });
  const { rows } = await query(
    `SELECT id, deployment_id, package_id, kind, filename, mime, byte_size, uploaded_at
       FROM attachments WHERE deployment_id = $1 ORDER BY uploaded_at ASC`,
    [req.params.id]
  );
  let list = rows.map(meta);
  // Clients only see instruction files when the project shares admin info.
  if (isClient(req) && !(await projectSharesAdminInfo(dep.project_key))) {
    const { rows: depRows } = await query('SELECT data FROM deployments WHERE id = $1', [dep.id]);
    const instr = instructionAttachmentIds(depRows[0] && depRows[0].data);
    if (instr.size) list = list.filter((a) => !instr.has(String(a.id)));
  }
  res.json(list);
});

// GET /api/attachments/:attId — stream the stored bytes back for download.
// Attachment ids are sequential, so we resolve the owning deployment and apply
// the same access check as the deployment itself (prevents id-guessing/IDOR).
router.get('/attachments/:attId', async (req, res) => {
  const { rows } = await query(
    'SELECT deployment_id, package_id, kind, filename, mime, content FROM attachments WHERE id = $1',
    [req.params.attId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const a = rows[0];
  if (a.package_id) {
    const pkg = await loadPackageAccess(a.package_id);
    if (!pkg || !(await canReadPackage(req, pkg))) return res.status(404).json({ error: 'Not found' });
    if (isClient(req) && isInstructionFile(a) && !(await projectSharesAdminInfo(pkg.project_key))) {
      return res.status(404).json({ error: 'Not found' });
    }
  } else {
    const dep = await loadDeploymentAccess(a.deployment_id);
    if (!dep || !(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Not found' });
    // Instruction attachments stay team-only unless the project opts in.
    if (isClient(req) && !(await projectSharesAdminInfo(dep.project_key))) {
      const { rows: depRows } = await query('SELECT data FROM deployments WHERE id = $1', [dep.id]);
      const instr = instructionAttachmentIds(depRows[0] && depRows[0].data);
      if (instr.has(String(req.params.attId))) {
        return res.status(404).json({ error: 'Not found' });
      }
    }
  }
  const asciiName = (a.filename || 'attachment').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`
  );
  res.send(a.content);
});

// DELETE /api/attachments/:attId — team action, scoped to whichever of the two
// owners the file has.
router.delete('/attachments/:attId', forbidClient, async (req, res) => {
  const { rows } = await query(
    'SELECT deployment_id, package_id FROM attachments WHERE id = $1',
    [req.params.attId]
  );
  if (!rows.length) return res.json({ deleted: true, id: req.params.attId }); // already gone
  if (rows[0].package_id) {
    const pkg = await loadPackageAccess(rows[0].package_id);
    if (!pkg || !(await canReadPackage(req, pkg))) return res.status(404).json({ error: 'Not found' });
  } else {
    const dep = await loadDeploymentAccess(rows[0].deployment_id);
    if (!dep || !(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Not found' });
  }
  await query('DELETE FROM attachments WHERE id = $1', [req.params.attId]);
  res.json({ deleted: true, id: req.params.attId });
});

export default router;
