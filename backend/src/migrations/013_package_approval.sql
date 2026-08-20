-- The project manager's clearance for a release package.
--
-- The process always had this step and RollDesk never did: the test team handed a
-- package over, and a release manager planned a rollout from it without anyone
-- having said the release may go out. The clearance happened in a mail thread.
--
-- Stored as `data.approval` = {by, at, comment} on the package rather than as a
-- third status: `draft`/`ready` is the test team's own path (is the build
-- finished), while this is a decision taken next to it by somebody else — the same
-- reasoning that keeps the client's approval off a deployment's status. No schema
-- change is needed for that; this migration only backfills.
--
-- Every package already handed over counts as approved, marked `legacy` so the UI
-- can say why the record names no approver. Introducing a gate that retroactively
-- blocks releases which are waiting to go out this week would stop the process on
-- the day of the upgrade — the gate applies to what is handed over from now on.
UPDATE release_packages
   SET data = jsonb_set(
         data,
         ARRAY['approval'],
         jsonb_build_object(
           'by', NULL,
           'at', to_jsonb(to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
           'legacy', true
         ),
         true
       )
 WHERE status = 'ready'
   AND NOT (data ? 'approval');
