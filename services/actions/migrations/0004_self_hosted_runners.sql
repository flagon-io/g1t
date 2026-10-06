-- Self-hosted runners: a workspace's or a repository's own machines, which
-- run its workflow jobs (and, when it says so, its agents' work) instead
-- of g1t's sandboxes. See `g1t_contracts::runners`.
--
-- Every statement can run twice: a table or index that exists is left as
-- it is. The columns added to `jobs` are new in this file only.

-- Which of a workspace's repositories may use its runners. Each workspace
-- gets a default group (every repository) the first time it is needed.
CREATE TABLE IF NOT EXISTS runner_groups (
  id TEXT PRIMARY KEY,
  -- The workspace's slug.
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  -- Repository names (without the workspace), as a JSON array. Empty: all.
  repositories TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace, name)
);

CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- A repository's own runner: only that repository's jobs. Null for the
  -- workspace's, which serve the repositories its group allows.
  repo_id TEXT,
  repo TEXT,
  group_id TEXT,
  name TEXT NOT NULL,
  -- JSON array, lowercase: self-hosted, the OS, the architecture, then
  -- whatever it was given.
  labels TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  ephemeral INTEGER NOT NULL DEFAULT 0,
  -- SHA-256 of its credential. The one before a rotation stays valid
  -- until the new one is first used.
  credential_hash TEXT NOT NULL,
  previous_hash TEXT,
  rotated_at TEXT NOT NULL,
  -- What it is running: a job's or a task's id, and which.
  work_id TEXT,
  work_kind TEXT,
  -- An ephemeral runner that took its one job takes no more.
  spent INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runners_by_name ON runners (workspace, COALESCE(repo_id, ''), name);
CREATE INDEX IF NOT EXISTS runners_by_credential ON runners (credential_hash);
CREATE INDEX IF NOT EXISTS runners_by_previous ON runners (previous_hash) WHERE previous_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS runners_by_work ON runners (work_id) WHERE work_id IS NOT NULL;

-- Registration tokens: an hour each, for as many runners as register with
-- them until then. Kept as a hash.
CREATE TABLE IF NOT EXISTS runner_registrations (
  token_hash TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo_id TEXT,
  repo TEXT,
  group_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runner_registrations_by_workspace ON runner_registrations (workspace, created_at);

-- Where g1t's own work runs, and whether forks' pull requests may use the
-- runners: a workspace's (owner = its slug), or a repository's own
-- (owner = its id), which overrides the workspace's.
CREATE TABLE IF NOT EXISTS runner_settings (
  owner TEXT PRIMARY KEY,
  -- workspace or repository.
  scope TEXT NOT NULL,
  agents INTEGER NOT NULL DEFAULT 0,
  -- JSON array of labels agent work needs.
  agent_labels TEXT NOT NULL DEFAULT '["self-hosted"]',
  fork_pulls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Agent work (an agent's run, checks, a review, the merge queue) handed to
-- a self-hosted runner by the runner service's sandbox, which is told how
-- it ended. Its environment is sealed at rest and dropped once claimed.
CREATE TABLE IF NOT EXISTS runner_tasks (
  id TEXT PRIMARY KEY,
  -- The sandbox (a Durable Object's id) waiting on it.
  sandbox TEXT NOT NULL UNIQUE,
  workspace TEXT NOT NULL,
  repo_id TEXT,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  labels TEXT NOT NULL,
  env TEXT,
  timeout_minutes INTEGER NOT NULL,
  -- queued, in_progress, completed.
  status TEXT NOT NULL,
  runner_id TEXT,
  runner_name TEXT,
  exit_code INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  seen_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runner_tasks_by_status ON runner_tasks (status, workspace);

-- A job whose runs-on names self-hosted runners: what it asks for (a JSON
-- array; null for g1t's own sandboxes), when it started waiting, and the
-- runner that took it.
ALTER TABLE jobs ADD COLUMN labels TEXT;
ALTER TABLE jobs ADD COLUMN queued_at TEXT;
ALTER TABLE jobs ADD COLUMN runner_id TEXT;
ALTER TABLE jobs ADD COLUMN runner_name TEXT;
CREATE INDEX IF NOT EXISTS jobs_self_hosted ON jobs (namespace, status) WHERE labels IS NOT NULL;
