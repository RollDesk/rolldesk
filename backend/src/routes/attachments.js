// Attachment endpoints — files are stored as raw bytes (BYTEA) in the DB.
//
// Upload/list are scoped to a deployment; download/delete address a single
// attachment by its own id. All routes sit behind requireAuth (mounted in
// index.js), so the browser downloads via an authenticated fetch + blob rather
// than a plain <a href> (which couldn't carry the Bearer token).
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';

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
router.post('/deployments/:id/attachments', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: 'No file uploaded (form field "file")' });
  const dep = await query('SELECT id FROM deployments WHERE id = $1', [req.params.id]);
  if (!dep.rows.length) return res.status(404).json({ error: 'Deployment not found' });
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
  const { rows } = await query(
    `SELECT id, deployment_id, filename, mime, byte_size, uploaded_at
       FROM attachments WHERE deployment_id = $1 ORDER BY uploaded_at ASC`,
    [req.params.id]
  );
  res.json(rows.map(meta));
});

// GET /api/attachments/:attId — stream the stored bytes back for download.
router.get('/attachments/:attId', async (req, res) => {
  const { rows } = await query(
    'SELECT filename, mime, content FROM attachments WHERE id = $1',
    [req.params.attId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const a = rows[0];
  const asciiName = (a.filename || 'attachment').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`
  );
  res.send(a.content);
});

// DELETE /api/attachments/:attId
router.delete('/attachments/:attId', async (req, res) => {
  await query('DELETE FROM attachments WHERE id = $1', [req.params.attId]);
  res.json({ deleted: true, id: req.params.attId });
});

export default router;
