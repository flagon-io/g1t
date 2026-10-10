-- The agent run a task handed to a self-hosted runner belongs to, so the
-- Runners page can link a runner's agent work to it and leave it out of
-- what runs on g1t's cloud. Null for tasks handed over before this.
ALTER TABLE runner_tasks ADD COLUMN run_id TEXT;

-- What runs in g1t's sandboxes for a workspace now, for the Runners page:
-- jobs without labels, by the lowercased workspace and status.
CREATE INDEX IF NOT EXISTS jobs_cloud_lower ON jobs (lower(namespace), status) WHERE labels IS NULL;
