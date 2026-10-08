-- Keeping runs safe: what a job's token may do, environments' protection
-- rules, approval for pull requests from outside, a job's own concurrency
-- group, and a cache scoped by ref. See src/protection.rs, src/plan.rs and
-- src/cache.rs.

-- A repository's choices for its workflows. A repository without a row
-- has the defaults.
CREATE TABLE IF NOT EXISTS repo_settings (
  repo_id TEXT PRIMARY KEY,
  -- What a workflow without `permissions:` gets: read (contents and
  -- packages read, the default) or write (every permission).
  default_permissions TEXT NOT NULL DEFAULT 'read',
  -- Which pull requests' runs wait for someone with Write to approve them:
  -- first_time_contributors, outside_contributors (the default) or
  -- all_external_contributors.
  approval_policy TEXT NOT NULL DEFAULT 'outside_contributors',
  updated_at TEXT,
  updated_by TEXT
);

-- An environment's protection rules. An environment without a row has
-- none: its jobs run as soon as their needs are done.
CREATE TABLE IF NOT EXISTS environments (
  repo_id TEXT NOT NULL,
  -- Lowercase, as secrets' environments are.
  name TEXT NOT NULL,
  -- JSON: [{"type": "user" | "team", "name": "ada" | "deployers"}], up to 6.
  reviewers TEXT NOT NULL DEFAULT '[]',
  -- Whoever started a run may not approve its jobs.
  prevent_self_review INTEGER NOT NULL DEFAULT 0,
  -- Minutes a job waits before it may start, 0 to 43200.
  wait_minutes INTEGER NOT NULL DEFAULT 0,
  -- all, protected (branches the rules protect) or selected (patterns).
  branch_policy TEXT NOT NULL DEFAULT 'all',
  -- JSON: [{"name": "release/*", "type": "branch" | "tag"}].
  branch_patterns TEXT NOT NULL DEFAULT '[]',
  -- Admins may approve without being a reviewer, skipping the wait.
  admins_bypass INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (repo_id, name)
);

-- A run's jobs held at an environment's rules: one row per run attempt and
-- environment, however many of its jobs name it, as one review approves
-- them all.
CREATE TABLE IF NOT EXISTS environment_gates (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  environment TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- waiting, approved or rejected.
  state TEXT NOT NULL,
  -- Whether a reviewer must approve it.
  needs_review INTEGER NOT NULL DEFAULT 0,
  -- When its wait timer lets it through; null without one.
  wait_until TEXT,
  reviewed_by TEXT,
  comment TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, attempt, environment)
);
CREATE INDEX IF NOT EXISTS environment_gates_waiting ON environment_gates (state, wait_until);

-- A run of a pull request from outside that waits to be approved:
-- `approval` is required, then approved; `approved_by` a username.
ALTER TABLE runs ADD COLUMN approval TEXT;
ALTER TABLE runs ADD COLUMN approved_by TEXT;
-- The run's concurrency group cancels what it replaces.
ALTER TABLE runs ADD COLUMN cancel_in_progress INTEGER NOT NULL DEFAULT 0;

-- A job's environment, read when its needs were done (an expression
-- included), and its own concurrency group.
ALTER TABLE jobs ADD COLUMN environment TEXT;
ALTER TABLE jobs ADD COLUMN concurrency_group TEXT;
ALTER TABLE jobs ADD COLUMN cancel_in_progress INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS jobs_by_group ON jobs (repo_id, concurrency_group, status) WHERE concurrency_group IS NOT NULL;

-- The cache, scoped by ref: an entry belongs to the ref whose run saved it
-- (refs/heads/main, refs/pull/3/merge), and a run restores from its own
-- ref, then its pull request's base branch, then the default branch. A
-- pull request from outside the repository saves under `untrusted:<ref>`,
-- which no other ref reads. `version` is the hash of the entry's paths and
-- compression, so the same key saved for other paths is another entry.
--
-- The unique key changes, so the table is made again. Entries saved
-- before scopes are marked expired: the next sweep deletes their objects
-- and rows, so nothing saved without a scope is ever restored.
CREATE TABLE cache_entries_v2 (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  object TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  UNIQUE (repo_id, scope, key, version)
);
INSERT INTO cache_entries_v2 (id, repo_id, namespace, scope, key, version, object, size, status, created_at, last_used_at)
SELECT id, repo_id, namespace, 'legacy:' || id, key, '', object, size, 'expired', created_at, last_used_at FROM cache_entries;
DROP TABLE cache_entries;
ALTER TABLE cache_entries_v2 RENAME TO cache_entries;
CREATE INDEX IF NOT EXISTS cache_entries_by_use ON cache_entries (repo_id, status, last_used_at);
CREATE INDEX IF NOT EXISTS cache_entries_by_status ON cache_entries (status, last_used_at);
CREATE INDEX IF NOT EXISTS cache_entries_by_namespace ON cache_entries (namespace, status);
CREATE INDEX IF NOT EXISTS cache_entries_by_scope ON cache_entries (repo_id, scope, status, created_at);
