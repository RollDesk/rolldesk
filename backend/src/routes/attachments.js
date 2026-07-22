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
import { forbidClient, loadDeploymentAccess, canReadDeployment } from '../rbac.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

const router = Router();

// Shape returned to the client — never includes the raw bytes.
function meta(r) {
  return {
    id: String(r.id),
    deploymentId: r.deployment_id,
    filename: r.filename,
    mime: r.mime,
    size: Number(r.byte_size),
    uploadedAt: r.uploaded_at,
  };
}

// POST /api/deployments/:id/attachments  (multipart/form-data, field "file")
// Uploading is a team action: clients are rejected outright, and any other
// scoped role (e.g. a deployer) must have access to the target deployment.
router.post('/deployments/:id/attachments', forbidClient, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'No file uploaded (form field "file")' });
  const dep = await loadDeploymentAccess(req.params.id);
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });
  if (!(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Deployment not found' });

  // Virus-scan the upload before it is stored (when a ClamAV host is configured).
  if (avEnabled()) {
    let result;
    try {
      result = await scanBuffer(req.file.buffer);
    } catch (err) {
      console.warn('[av] scan failed:', err.message);
      if (config.av.failMode !== 'allow') {
        return res.status(503).json({ error: 'Virus scan unavailable — upload rejected', detail: err.message });
      }
      // fail-open: allow the upload but note it wasn't scanned.
    }
    if (result && !result.clean) {
      return res.status(422).json({ error: 'File rejected by virus scan', virus: result.virus });
    }
  }

  const { originalname, mimetype, size, buffer } = req.file;
  const uploadedBy = req.auth && req.auth.sub ? req.auth.sub : null;
  const { rows } = await query(
    `INSERT INTO attachments (deployment_id, filename, mime, byte_size, content, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, deployment_id, filename, mime, byte_size, uploaded_at`,
    [req.params.id, originalname, mimetype || 'application/octet-stream', size, buffer, uploadedBy]
  );
  res.status(201).json(meta(rows[0]));
});

// GET /api/deployments/:id/attachments — metadata list (no bytes).
router.get('/deployments/:id/attachments', async (req, res) => {
  const dep = await loadDeploymentAccess(req.params.id);
  if (!dep || !(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Not found' });
  const { rows } = await query(
    `SELECT id, deployment_id, filename, mime, byte_size, uploaded_at
       FROM attachments WHERE deployment_id = $1 ORDER BY uploaded_at ASC`,
    [req.params.id]
  );
  res.json(rows.map(meta));
});

// GET /api/attachments/:attId — stream the stored bytes back for download.
// Attachment ids are sequential, so we resolve the owning deployment and apply
// the same access check as the deployment itself (prevents id-guessing/IDOR).
router.get('/attachments/:attId', async (req, res) => {
  const { rows } = await query(
    'SELECT deployment_id, filename, mime, content FROM attachments WHERE id = $1',
    [req.params.attId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const dep = await loadDeploymentAccess(rows[0].deployment_id);
  if (!dep || !(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Not found' });
  const a = rows[0];
  const asciiName = (a.filename || 'attachment').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`
  );
  res.send(a.content);
});

// DELETE /api/attachments/:attId — team action, scoped to the owning deployment.
router.delete('/attachments/:attId', forbidClient, async (req, res) => {
  const { rows } = await query('SELECT deployment_id FROM attachments WHERE id = $1', [req.params.attId]);
  if (!rows.length) return res.json({ deleted: true, id: req.params.attId }); // already gone
  const dep = await loadDeploymentAccess(rows[0].deployment_id);
  if (!dep || !(await canReadDeployment(req, dep))) return res.status(404).json({ error: 'Not found' });
  await query('DELETE FROM attachments WHERE id = $1', [req.params.attId]);
  res.json({ deleted: true, id: req.params.attId });
});

export default router;
