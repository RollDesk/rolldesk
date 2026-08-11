-- Release packages: what the test team hands over to the release manager.
--
-- A package is the unit that has actually been tested together — a list of
-- application versions plus the issues fixed in them (tracker ids and a
-- description of each change). The release manager then picks a package instead
-- of retyping versions and a changelog, so what gets deployed is what was
-- signed off, and the client can read which issues the rollout closes.
--
-- Same hybrid storage as projects/deployments: the filterable values get real
-- columns, the whole object also lives in `data` so the UI shape can evolve
-- without a migration. `data` holds `apps` ([{name, version}]) and `issues`
-- ([{id, description}]).
--
-- Schema only — no sample packages (see backend/src/seeds/).
CREATE TABLE IF NOT EXISTS release_packages (
  id          TEXT PRIMARY KEY,          -- e.g. PKG-2026-0001
  project_key TEXT NOT NULL,
  name        TEXT,                      -- optional human label ("March hotfix")
  status      TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'ready'
  created_by  TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_release_packages_project ON release_packages (project_key);
CREATE INDEX IF NOT EXISTS idx_release_packages_status  ON release_packages (status);

-- The role column carries a fifth value from now on: 'tester'. Testers assemble
-- release packages for the projects they were granted and have no write access
-- to projects or deployments. There is no CHECK constraint on users.role (see
-- 001_init.sql), so this migration only records the widened vocabulary — the
-- allowed set is enforced in the API (routes/users.js) and the UI.
COMMENT ON COLUMN users.role IS
  'admin | rm | tester | installer | client';
