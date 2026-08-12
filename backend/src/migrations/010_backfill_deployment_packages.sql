-- Give every existing deployment the release package it should have been planned
-- from.
--
-- Packages became the only way to plan a deployment in 0.23.0, and in 0.24.0 the
-- changelog files and the deployer instructions moved onto the package too. Both
-- changes are forward-looking: a deployment created before them carries its
-- content on itself — apps and versions, changelog text, `installerNotes`, and
-- attachment rows pointing at the deployment. Nothing reads those paths as the
-- primary source any more, so without this backfill an existing rollout would
-- render an empty instructions block and its files would be unreachable from the
-- package view.
--
-- One package per deployment, not one per distinct app/version set. Deduplicating
-- would be a guess: two rollouts of the same versions may well have been the same
-- build, or a rebuild nobody recorded, and merging them silently would rewrite
-- history to say something we do not know. Status is 'ready' because the
-- deployment already happened — a draft is a package a release manager may not
-- pick, and refusing to plan a rollout that is already installed is nonsense.
--
-- Idempotent: keyed off `data->>'packageId' IS NULL`, so a second run finds
-- nothing to do. Deployments with no applications are skipped — a package needs
-- at least one app with a version to be valid, and inventing one would put a
-- version nobody tested on screen.

-- The id series has to continue past whatever is already stored, and it is
-- per-year, so the numbering is computed rather than assumed. Done in one
-- statement per step so the whole migration is a single transaction: either every
-- deployment gets its package or none does.
WITH candidates AS (
  SELECT d.id,
         d.project_key,
         d.data,
         d.created_at,
         ROW_NUMBER() OVER (ORDER BY d.created_at, d.id) AS n
    FROM deployments d
   WHERE d.data->>'packageId' IS NULL
     AND jsonb_typeof(d.data->'apps') = 'array'
     AND jsonb_array_length(d.data->'apps') > 0
),
-- The highest number already used in the current year, so the backfilled ids do
-- not collide with packages the test team created by hand.
base AS (
  SELECT COALESCE(MAX(
           NULLIF(regexp_replace(id, '^PKG-' || to_char(now(), 'YYYY') || '-', ''), '')::int
         ), 0) AS max_n
    FROM release_packages
   WHERE id ~ ('^PKG-' || to_char(now(), 'YYYY') || '-[0-9]+$')
),
numbered AS (
  SELECT c.*, 'PKG-' || to_char(now(), 'YYYY') || '-' ||
              lpad((b.max_n + c.n)::text, 4, '0') AS package_id
    FROM candidates c CROSS JOIN base b
),
inserted AS (
  INSERT INTO release_packages (id, project_key, name, status, created_by, data, created_at, updated_at)
  SELECT nm.package_id,
         nm.project_key,
         -- A label that says where the package came from, so nobody mistakes a
         -- backfilled record for one the test team assembled.
         'Backfilled from ' || nm.id,
         'ready',
         nm.data->>'createdBy',
         jsonb_strip_nulls(jsonb_build_object(
           'apps', nm.data->'apps',
           -- No issues: the deployment never recorded which tickets it fixed, and
           -- an empty list is the honest answer. This is the one respect in which
           -- a backfilled package is weaker than a real one, and it is why the
           -- 'ready' status is set here rather than earned through the API, whose
           -- validation requires an issue list.
           'issues', '[]'::jsonb,
           'changes', NULLIF(nm.data->>'changelog', ''),
           'instructions', NULLIF(nm.data->>'installerNotes', ''),
           'notes', 'Created by the 0.24.0 backfill from deployment ' || nm.id ||
                    '. The list of fixed issues was not recorded on the deployment.',
           'testedBy', NULL
         )),
         -- The package describes a build that existed when the deployment was
         -- planned, so it is dated with it rather than with the migration run.
         nm.created_at,
         now()
    FROM numbered nm
  RETURNING id
)
-- Link each deployment to its new package. `inserted` is not read here and does
-- not need to be: Postgres runs a data-modifying CTE exactly once and to
-- completion whether or not the primary query selects from it. The mapping is
-- re-derived from `numbered` instead, which is deterministic.
UPDATE deployments d
   SET data = d.data || jsonb_build_object('packageId', nm.package_id),
       updated_at = now()
  FROM numbered nm
 WHERE d.id = nm.id;

-- Move the deployments' files onto their packages, with the kind the deployment
-- recorded. `instructionAttachments` on the deployment named the ids that were
-- deployer-facing; everything else was changelog. The XOR constraint from
-- migration 009 means deployment_id has to be cleared in the same statement.
UPDATE attachments a
   SET package_id = d.data->>'packageId',
       deployment_id = NULL,
       kind = CASE
                WHEN d.data->'instructionAttachments' @> jsonb_build_array(jsonb_build_object('id', a.id::text))
                  THEN 'instructions'
                ELSE 'changelog'
              END
  FROM deployments d
 WHERE a.deployment_id = d.id
   AND d.data->>'packageId' IS NOT NULL
   -- Only the packages this migration just created own their files outright. A
   -- deployment that already pointed at a real package keeps its own attachments:
   -- they were uploaded for that one rollout, and moving them would put one
   -- rollout's files in front of every other deployment of the same build.
   AND d.data->>'packageId' LIKE 'PKG-%'
   AND EXISTS (
     SELECT 1 FROM release_packages p
      WHERE p.id = d.data->>'packageId'
        AND p.name LIKE 'Backfilled from %'
   );
