-- GitHub Actions workflows on g1t: the workflows on each repository's
-- default branch, their runs and jobs, the jobs' logs, and the secrets and
-- variables they read. Every timestamp is RFC 3339 UTC.

-- Workflows as they are on the default branch: for listing, schedules and
-- manual runs. Runs for pushes and pull requests read the file at their
-- own commit.
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- owner/name.
  repo TEXT NOT NULL,
  -- .github/workflows/ci.yml
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  -- The events that start it, as a JSON array.
  events TEXT NOT NULL,
  -- Its schedules' cron lines, as a JSON array.
  crons TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  -- active or disabled; kept when the file changes.
  state TEXT NOT NULL DEFAULT 'active',
  -- How many runs it has had, for run numbers.
  run_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, path)
);
CREATE INDEX workflows_scheduled ON workflows (state, crons);

CREATE TABLE synced (
  repo_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  number INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  -- The GitHub event and activity type.
  event TEXT NOT NULL,
  action TEXT,
  git_ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  pull INTEGER,
  -- pending (waiting for its concurrency group), queued, in_progress, completed.
  status TEXT NOT NULL,
  conclusion TEXT,
  -- Why the run could not start, such as a workflow file that does not read.
  error TEXT,
  actor TEXT,
  actor_id TEXT,
  -- The workflow file as of the run's commit.
  source TEXT NOT NULL,
  -- The github context's fields and the event's payload (RunInfo).
  info TEXT NOT NULL,
  -- workflow_dispatch inputs, as JSON.
  inputs TEXT NOT NULL DEFAULT '{}',
  -- 0 for a pull request from outside the workspace: its jobs get no
  -- secrets and no token that can write.
  trusted INTEGER NOT NULL DEFAULT 1,
  concurrency_group TEXT,
  -- What started it, so an event starts each workflow once.
  event_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (repo_id, path, event_key)
);
CREATE INDEX runs_by_repo ON runs (repo_id, id);
CREATE INDEX runs_by_workflow ON runs (workflow_id, id);
CREATE INDEX runs_by_status ON runs (status);
CREATE INDEX runs_by_group ON runs (repo_id, concurrency_group, status);
CREATE INDEX runs_by_sha ON runs (repo_id, sha);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- The workspace, for its limit on jobs running at once.
  namespace TEXT NOT NULL,
  -- Its key under jobs:, and which matrix combination it is (0 without one).
  key TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  needs TEXT NOT NULL DEFAULT '[]',
  -- The matrix combination, as JSON; null until it is expanded.
  matrix TEXT,
  -- waiting (for its needs), queued, in_progress, completed.
  status TEXT NOT NULL,
  conclusion TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  annotations TEXT NOT NULL DEFAULT '[]',
  outputs TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  token_hash TEXT,
  timeout_minutes INTEGER NOT NULL DEFAULT 60,
  -- continue-on-error: a failure that does not fail the run.
  continue_on_error INTEGER NOT NULL DEFAULT 0,
  -- strategy.max-parallel: how many of its matrix may run at once.
  max_parallel INTEGER,
  -- The last time its sandbox reported anything.
  seen_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_by_run ON jobs (run_id, key, ordinal);
CREATE INDEX jobs_by_status ON jobs (status, namespace);

CREATE TABLE logs (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  step INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

-- Secrets and variables, a repository's or a workspace's. A secret's value
-- is sealed, bound to its row's id.
CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  -- repository or workspace.
  scope TEXT NOT NULL,
  -- The repository's id, or the workspace's slug.
  owner TEXT NOT NULL,
  -- secret or variable.
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner, kind, name)
);
