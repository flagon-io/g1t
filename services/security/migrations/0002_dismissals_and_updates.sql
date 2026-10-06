-- Dismissals with reasons, likely test values, each alert's activity, and
-- security updates: the pull requests g1t opens itself to upgrade a
-- vulnerable package.

-- Why a secret was dismissed (false_positive, used_in_tests, revoked,
-- wont_fix), and why its value looks made for tests, when it does.
ALTER TABLE secrets ADD COLUMN dismiss_reason TEXT;
ALTER TABLE secrets ADD COLUMN test_value TEXT;

-- A vulnerability someone dismissed: its status is 'dismissed', and these
-- stay while it is found again, until someone reopens it.
ALTER TABLE vulnerabilities ADD COLUMN dismiss_reason TEXT;
ALTER TABLE vulnerabilities ADD COLUMN dismiss_comment TEXT;
ALTER TABLE vulnerabilities ADD COLUMN dismissed_by TEXT;
ALTER TABLE vulnerabilities ADD COLUMN dismissed_at TEXT;

-- What `.g1t/dependencies.yml` said when the dependencies were last read:
-- JSON of the contracts' VersionUpdatesState.
ALTER TABLE repos ADD COLUMN version_updates TEXT;

-- What happened to each alert: dismissed, reopened, and its security
-- update's steps. Found and decided-before-this rows are read from the
-- alerts themselves.
CREATE TABLE alert_activity (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  comment TEXT,
  number INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX alert_activity_repo ON alert_activity (repo_id, at);

-- One security update per vulnerable package: the branch a sandbox pushes
-- the new version to, then the pull request g1t opens from it.
--   state: requested | open | merged | closed | superseded | needs_code | failed
CREATE TABLE updates (
  repo_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  branch TEXT,
  pull INTEGER,
  issue INTEGER,
  error TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, ecosystem, package)
);
CREATE INDEX updates_state ON updates (state, updated_at);
CREATE INDEX updates_branch ON updates (repo_id, branch);

-- Pushes too large to scan before they were stored (repos let them through
-- unscanned, so imports of real repositories work): their new commits,
-- `base`..`head` on `git_ref`, scanned after they land, a page at a time.
--   state: pending | done
CREATE TABLE push_scans (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  head TEXT NOT NULL,
  -- Where the branch was before the push; null for a new branch.
  base TEXT,
  -- Where the next page starts; null before the first.
  cursor TEXT,
  pusher TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  commits INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX push_scans_state ON push_scans (state, created_at);
