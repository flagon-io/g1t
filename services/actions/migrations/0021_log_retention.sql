-- Job logs are deleted LOG_RETENTION_DAYS after their job finished
-- (src/retention.rs). A job, or an earlier attempt, whose log is gone is
-- marked so the hourly sweep does not look at it again; the job itself,
-- its steps and its summary stay.
ALTER TABLE jobs ADD COLUMN logs_purged_at TEXT;
ALTER TABLE job_attempts ADD COLUMN logs_purged_at TEXT;
CREATE INDEX IF NOT EXISTS jobs_logs_due ON jobs (finished_at) WHERE logs_purged_at IS NULL;
CREATE INDEX IF NOT EXISTS job_attempts_logs_due ON job_attempts (finished_at) WHERE logs_purged_at IS NULL;
