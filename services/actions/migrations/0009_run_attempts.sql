-- Runs as GitHub keeps them: every attempt with its own jobs and logs, a
-- step's job summary ($GITHUB_STEP_SUMMARY), debug re-runs, and cancelling
-- that lets a job clean up. See src/plan.rs (rerun, cancel_run, job_report)
-- and src/views.rs (run, logs, summaries).

-- A job's summary, a step at a time: the Markdown each step wrote to
-- $GITHUB_STEP_SUMMARY, masked by the runner. Kept under the same id as the
-- job's logs (a live job's, or an earlier attempt's: job_attempts.log_id).
CREATE TABLE IF NOT EXISTS job_summaries (
  job_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  PRIMARY KEY (job_id, step)
);

-- A run's earlier attempts: how each ended, and who started it.
CREATE TABLE IF NOT EXISTS run_attempts (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  repo_id TEXT NOT NULL,
  conclusion TEXT,
  -- Who started this attempt: the run's actor for the first, whoever
  -- re-ran it for the rest.
  actor TEXT,
  debug INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, attempt)
);

-- Each job of an earlier attempt as it ended. `id` is the snapshot's own
-- id, shown as the job's id when that attempt is viewed; `log_id` is where
-- its logs and summary are kept: the snapshot's id once the job ran again,
-- or the live job's while that one still carries the result (a job a
-- "re-run failed jobs" left alone).
CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  log_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  conclusion TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  annotations TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  environment TEXT,
  labels TEXT,
  runner_name TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS job_attempts_by_run ON job_attempts (run_id, attempt);
CREATE INDEX IF NOT EXISTS job_attempts_by_log ON job_attempts (log_id);

-- Who started the current attempt (the run's actor until it is re-run),
-- and whether it runs with debug logging.
ALTER TABLE runs ADD COLUMN triggering_actor TEXT;
ALTER TABLE runs ADD COLUMN debug INTEGER NOT NULL DEFAULT 0;

-- Cancelling: a running job is told to stop and given time to run its
-- `if: always()` and `cancelled()` steps and its post steps. Past the grace
-- period it is stopped outright.
ALTER TABLE jobs ADD COLUMN cancel_requested_at TEXT;
