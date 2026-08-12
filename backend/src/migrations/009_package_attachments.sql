-- Attachments can belong to a release package, not only to a deployment.
--
-- The changelog and the deployer instructions describe the build, not the day it
-- goes out: they were typed on every deployment of the same package, which meant
-- retyping them and, worse, letting the copies drift. They now live on the
-- package, and so do their files — a deployment renders them read-only from the
-- package it was planned from.
--
-- `deployment_id` therefore becomes nullable and a `package_id` is added. Exactly
-- one of the two must be set: an attachment with neither owner would be
-- unreachable (every read path resolves the owner first to decide access), and
-- one with both would have two different access rules.
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS package_id TEXT REFERENCES release_packages(id) ON DELETE CASCADE;

ALTER TABLE attachments
  ALTER COLUMN deployment_id DROP NOT NULL;

-- What the file is: the changelog the client reads, or the deployer instructions.
-- On a deployment the two were told apart by an id list in its JSONB; a package
-- needs the same distinction because instruction files stay team-only unless the
-- project shares admin information, and a rule that important should not depend
-- on a filename convention. 'changelog' is the default so existing rows (all of
-- them client-facing changelogs) keep their current visibility.
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'changelog';

-- Added as a named constraint so re-running the migration is a no-op rather than
-- a duplicate: Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attachments_one_owner'
  ) THEN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_one_owner
      CHECK ((deployment_id IS NOT NULL) <> (package_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attachments_package
  ON attachments (package_id, uploaded_at);
