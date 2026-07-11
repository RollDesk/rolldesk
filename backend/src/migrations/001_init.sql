-- RollDesk schema. Deployments are stored as a full object (JSONB) + columns for filtering.
-- This migration is schema-only. Client/project sample data is NOT committed — it lives in
-- local, uncommitted test data (see backend/src/seeds/). Load it with `npm run seed`.

CREATE TABLE IF NOT EXISTS projects (
  key            TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_days   INTEGER NOT NULL DEFAULT 5,
  default_time   TEXT NOT NULL DEFAULT '20:00',
  client_visible BOOLEAN NOT NULL DEFAULT true,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL,
  env          TEXT,
  status       TEXT,
  internal     BOOLEAN NOT NULL DEFAULT false,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments (project_key);
CREATE INDEX IF NOT EXISTS idx_deployments_status  ON deployments (status);
