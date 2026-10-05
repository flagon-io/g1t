-- The security service: secrets found in pushes and history, vulnerable
-- dependencies, and the upgrade issues opened for them.

-- Each repository the service has seen, and where its scans stand.
CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Whether g1t opens upgrade issues and puts its agent on them.
  upkeep INTEGER NOT NULL DEFAULT 1,
  upkeep_by TEXT,
  upkeep_at TEXT,
  -- pending | running | done | stopped
  history TEXT NOT NULL DEFAULT 'pending',
  -- The commit the next page of history starts from.
  history_cursor TEXT,
  history_commits INTEGER NOT NULL DEFAULT 0,
  history_finished_at TEXT,
  deps_scanned_at TEXT,
  deps_commit TEXT,
  deps_error TEXT,
  -- JSON array of lockfile paths last read.
  lockfiles TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX repos_namespace ON repos (namespace);
CREATE INDEX repos_history ON repos (history);

-- A secret is kept as a fingerprint and a preview, never itself.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  preview TEXT NOT NULL,
  -- open | blocked | allowed | resolved
  status TEXT NOT NULL,
  -- push | history
  source TEXT NOT NULL,
  found_by TEXT,
  found_at TEXT NOT NULL,
  decided_by TEXT,
  reason TEXT,
  decided_at TEXT,
  UNIQUE (repo_id, fingerprint)
);

CREATE TABLE vulnerabilities (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  osv_id TEXT NOT NULL,
  advisory TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL,
  fixed_version TEXT,
  -- open | fixed
  status TEXT NOT NULL,
  found_at TEXT NOT NULL,
  fixed_at TEXT,
  UNIQUE (repo_id, ecosystem, package, version, manifest, osv_id)
);
CREATE INDEX vulnerabilities_repo ON vulnerabilities (repo_id, status);

-- The issue opened to upgrade one package, so it is opened once.
CREATE TABLE upgrades (
  repo_id TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  number INTEGER NOT NULL,
  target TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  -- Whether a g1t agent was put on it, or why not.
  assigned INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (repo_id, ecosystem, package)
);

-- OSV's records, kept for a week so a rescan does not fetch them again.
CREATE TABLE advisories (
  osv_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- What scanning cost each workspace, a month at a time.
CREATE TABLE usage (
  workspace TEXT NOT NULL,
  month TEXT NOT NULL,
  reads INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  osv_queries INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, month)
);
