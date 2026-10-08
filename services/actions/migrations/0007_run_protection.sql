-- Keeping runs safe: what a job's token may do, environments' protection
-- rules, approval for pull requests from outside, a job's own concurrency
-- group, and a cache scoped by ref. Builds on 0006 (repo_settings and the
-- cache's version). See src/protection.rs, src/plan.rs and src/cache.rs.

-- A repository's choices for its workflows, beside 0006's artifact
-- retention. Null is "not chosen":
--   default_permissions: read or write, what a workflow without
--     `permissions:` gets. Unchosen, a repository made before this
--     migration ran keeps write, as it had; a newer one takes its
--     workspace's default (read unless the workspace says otherwise).
--   approval_policy: which pull requests' runs wait for approval:
--     first_time_contributors, outside_contributors (the default) or
--     all_external_contributors.
--   can_approve_pulls: whether a job's token may open and approve pull
--     requests (off unless chosen, and only where the workspace allows).
ALTER TABLE repo_settings ADD COLUMN default_permissions TEXT;
ALTER TABLE repo_settings ADD COLUMN approval_policy TEXT;
ALTER TABLE repo_settings ADD COLUMN can_approve_pulls INTEGER;

-- When restricted tokens began: repositories made before keep read and
-- write unless someone chooses otherwise, as GitHub kept them for older
-- repositories. Written once.
CREATE TABLE IF NOT EXISTS actions_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO actions_meta (key, value) VALUES ('restricted_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- A workspace's policy for its repositories' tokens. A workspace without a
-- row has the defaults: new repositories start read-only, any repository
-- may choose write, and jobs may not open or approve pull requests.
CREATE TABLE IF NOT EXISTS workspace_actions_settings (
  -- The workspace's slug, lowercase.
  namespace TEXT PRIMARY KEY,
  -- read or write: what a new repository's workflows get by default.
  default_permissions TEXT NOT NULL DEFAULT 'read',
  -- read or write: the most a repository's default may be.
  max_permissions TEXT NOT NULL DEFAULT 'write',
  -- Whether its repositories may let jobs open and approve pull requests.
  can_approve_pulls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
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
-- `approval` is JSON {"state": "required" | "approved", "reason",
-- "approvedBy"}; `approved_by` a username.
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
-- which no other ref reads. 0006's `version` (the hash of an entry's paths
-- and compression, which the toolkit and g1t's runner both send) is now
-- part of the key, and its `upload` stays.
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
  upload TEXT,
  UNIQUE (repo_id, scope, key, version)
);
INSERT INTO cache_entries_v2 (id, repo_id, namespace, scope, key, version, object, size, status, created_at, last_used_at, upload)
SELECT id, repo_id, namespace, 'legacy:' || id, key, version, object, size, 'expired', created_at, last_used_at, NULL FROM cache_entries;
DROP TABLE cache_entries;
ALTER TABLE cache_entries_v2 RENAME TO cache_entries;
CREATE INDEX IF NOT EXISTS cache_entries_by_use ON cache_entries (repo_id, status, last_used_at);
CREATE INDEX IF NOT EXISTS cache_entries_by_status ON cache_entries (status, last_used_at);
CREATE INDEX IF NOT EXISTS cache_entries_by_namespace ON cache_entries (namespace, status);
CREATE INDEX IF NOT EXISTS cache_entries_by_scope ON cache_entries (repo_id, scope, status, created_at);
