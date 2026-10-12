-- A build a g1t Actions job runs in its own checkout (`start_from_workflow`,
-- `g1t-runner deploy`): the run and job that opened it. The job pays for
-- its own time, so such a build's seconds are not charged again here.
-- Null for builds g1t's sandboxes ran.
ALTER TABLE deployments ADD COLUMN run_id TEXT;
ALTER TABLE deployments ADD COLUMN job_id TEXT;
