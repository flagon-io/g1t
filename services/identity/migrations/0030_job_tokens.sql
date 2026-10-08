-- Workflow jobs' tokens (G1T_TOKEN, and GITHUB_TOKEN as its alias): each
-- belongs to the repository's workspace, reaches one repository only, and
-- carries the scopes the job's `permissions:` give it. The actions service
-- revokes a job's tokens when the job ends. See src/job_tokens.rs.
--
-- `repo` is `owner/name`: a token with one is refused everywhere else.
-- `job_id` and `job_run_id` name the job and its run, which the audit log
-- records against what the token does. All three are null on every other
-- token, so nothing existing changes.
ALTER TABLE access_tokens ADD COLUMN repo TEXT;
ALTER TABLE access_tokens ADD COLUMN job_id TEXT;
ALTER TABLE access_tokens ADD COLUMN job_run_id TEXT;
CREATE INDEX access_tokens_job ON access_tokens (job_id) WHERE job_id IS NOT NULL;
