-- The security suite: custom secret patterns, push protection bypasses
-- and their review, validity checks, code scanning from SARIF uploads,
-- the dependency graph, dependency review on pull requests, and the daily
-- counts the workspace's overview draws its trends from.

-- Whether the repository is private (paid features need the activation on
-- a private one), and its settings: JSON of the contracts'
-- RepoSecuritySettings, defaults when null.
ALTER TABLE repos ADD COLUMN private INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repos ADD COLUMN settings TEXT;

-- What a secret's issuer said when last asked, how it got past push
-- protection, and the custom pattern that found it.
ALTER TABLE secrets ADD COLUMN validity TEXT;
ALTER TABLE secrets ADD COLUMN validity_checked_at TEXT;
ALTER TABLE secrets ADD COLUMN bypass_reason TEXT;
ALTER TABLE secrets ADD COLUMN bypass_comment TEXT;
ALTER TABLE secrets ADD COLUMN bypassed_by TEXT;
ALTER TABLE secrets ADD COLUMN bypassed_at TEXT;
ALTER TABLE secrets ADD COLUMN bypass_approved_by TEXT;
ALTER TABLE secrets ADD COLUMN pattern_id TEXT;
ALTER TABLE secrets ADD COLUMN pattern_name TEXT;

-- Every place a secret was found: a secret is one alert however many
-- files, lines and commits hold it.
CREATE TABLE secret_locations (
  secret_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  -- push | history
  source TEXT NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (secret_id, path, line, commit_hash)
);
CREATE INDEX secret_locations_repo ON secret_locations (repo_id);

-- A workspace's security settings.
CREATE TABLE workspace_settings (
  namespace TEXT PRIMARY KEY,
  delegated_bypass INTEGER NOT NULL DEFAULT 0,
  validity_checks INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);

-- Custom patterns: a workspace's (repo_id null) or one repository's.
--   state: draft | published
CREATE TABLE custom_patterns (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  repo_id TEXT,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  before_text TEXT,
  after_text TEXT,
  -- JSON array of strings.
  test_strings TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX custom_patterns_scope ON custom_patterns (namespace, repo_id);

-- Requests to bypass push protection, when delegated bypass is on.
--   state: pending | approved | denied | cancelled
CREATE TABLE bypass_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  secret_id TEXT NOT NULL,
  requester TEXT NOT NULL,
  reason TEXT NOT NULL,
  comment TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  reviewer TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX bypass_requests_namespace ON bypass_requests (namespace, state, created_at);
CREATE INDEX bypass_requests_secret ON bypass_requests (secret_id);

-- SARIF uploads, each read at once into analyses.
--   status: complete | failed
CREATE TABLE sarif_uploads (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  -- JSON arrays: what was wrong, and the analyses made.
  errors TEXT NOT NULL DEFAULT '[]',
  analyses TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX sarif_uploads_repo ON sarif_uploads (repo_id, created_at);

-- One tool's run on one commit.
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  sarif_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_version TEXT,
  category TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  pull INTEGER,
  results INTEGER NOT NULL DEFAULT 0,
  new_alerts INTEGER NOT NULL DEFAULT 0,
  fixed_alerts INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX analyses_repo ON analyses (repo_id, created_at);
CREATE INDEX analyses_pull ON analyses (repo_id, pull, created_at);

-- Code scanning alerts on the default branch, one per tool, category and
-- fingerprint, numbered per repository.
--   status: open | dismissed | fixed
CREATE TABLE code_alerts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  tool TEXT NOT NULL,
  category TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_name TEXT,
  rule_description TEXT,
  help TEXT,
  help_uri TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  level TEXT NOT NULL,
  security_severity TEXT,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  start_column INTEGER,
  end_column INTEGER,
  status TEXT NOT NULL,
  first_commit TEXT NOT NULL,
  last_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fixed_at TEXT,
  dismiss_reason TEXT,
  dismiss_comment TEXT,
  dismissed_by TEXT,
  dismissed_at TEXT,
  issue INTEGER,
  UNIQUE (repo_id, tool, category, fingerprint),
  UNIQUE (repo_id, number)
);
CREATE INDEX code_alerts_repo ON code_alerts (repo_id, status);

-- Each analysis's results by fingerprint, so alerts can name the analyses
-- that reported them and pull requests their own results.
CREATE TABLE analysis_results (
  analysis_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  -- JSON of the result: rule, level, severities, message, location.
  result TEXT NOT NULL,
  PRIMARY KEY (analysis_id, fingerprint)
);
CREATE INDEX analysis_results_repo ON analysis_results (repo_id, fingerprint);

-- What the suite reported on each pull request: one row per check
-- (`code` or `review`), for its head commit.
CREATE TABLE pull_checks (
  repo_id TEXT NOT NULL,
  pull INTEGER NOT NULL,
  kind TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- success | failure | error
  state TEXT NOT NULL,
  description TEXT NOT NULL,
  -- JSON: the review, or the code scanning results.
  detail TEXT NOT NULL DEFAULT '{}',
  -- Fingerprints already commented on, JSON array, so a result is
  -- commented on once per pull request.
  commented TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, pull, kind)
);

-- The dependency graph: every package the lockfiles on the default branch
-- resolve, replaced on each read.
CREATE TABLE dependencies (
  repo_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  -- direct | transitive | unknown
  relationship TEXT NOT NULL,
  development INTEGER NOT NULL DEFAULT 0,
  license TEXT,
  PRIMARY KEY (repo_id, manifest, ecosystem, name, version)
);

-- Fixes g1t was put on for secrets and vulnerable dependencies (a code
-- scanning alert keeps its own issue).
CREATE TABLE alert_fixes (
  alert_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Open alerts by type and severity, once a day per repository: the
-- overview's trends.
CREATE TABLE snapshots (
  repo_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  day TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  high INTEGER NOT NULL DEFAULT 0,
  medium INTEGER NOT NULL DEFAULT 0,
  low INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, day, alert_type)
);
CREATE INDEX snapshots_namespace ON snapshots (namespace, day);
