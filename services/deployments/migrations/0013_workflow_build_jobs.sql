-- A workflow job's open builds are found by its id when it ends
-- (`workflow_job_ended`), to be failed if the job did not finish them.
CREATE INDEX IF NOT EXISTS deployments_job ON deployments (job_id) WHERE job_id IS NOT NULL;
