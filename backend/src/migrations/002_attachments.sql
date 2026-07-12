-- File attachments stored directly in the database.
--
-- The changelog file attached when scheduling a deployment (and any future
-- per-deployment file) is kept here as raw bytes (BYTEA) alongside its
-- filename and MIME type. Attachments belong to a deployment and are removed
-- automatically when that deployment is deleted.
--
-- Storing blobs in Postgres keeps the whole app self-contained (no extra object
-- store); large files are capped by the upload limit in the API instead.

CREATE TABLE IF NOT EXISTS attachments (
  id            BIGSERIAL PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size     INTEGER NOT NULL,
  content       BYTEA NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_deployment
  ON attachments (deployment_id, uploaded_at);
