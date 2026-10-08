-- Artifacts of workflow runs, kept in R2 (the ACTIONS_CACHE bucket, under
-- `a/`) rather than in KV: which there are, how big, until when, and the
-- toolkit's protocols for them and for the cache. See
-- services/actions/src/artifacts.rs and services/actions/src/toolkit.rs.
--
-- Creating a table or index that exists leaves it as it is. The ALTER at
-- the end runs once, as D1 runs each migration once.

-- One row per artifact. `id` is a number, as GitHub's artifact ids are,
-- so actions and scripts that read them as numbers keep working.
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  -- The workspace's slug, whose storage it counts toward.
  namespace TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- The job that uploaded it.
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Its object in R2.
  object TEXT NOT NULL,
  -- zip, or tgz for one an older runner sent whole.
  format TEXT NOT NULL DEFAULT 'zip',
  size INTEGER NOT NULL DEFAULT 0,
  -- sha256:<hex> of its bytes, when the uploader said.
  digest TEXT,
  -- pending (being uploaded), ready, or expired (its object is to be
  -- deleted, then the row).
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- A name is one artifact in a run, until it expires or is deleted.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_by_name ON artifacts (run_id, name) WHERE status <> 'expired';
CREATE INDEX IF NOT EXISTS artifacts_by_repo ON artifacts (repo_id, status, id);
CREATE INDEX IF NOT EXISTS artifacts_by_expiry ON artifacts (status, expires_at);
CREATE INDEX IF NOT EXISTS artifacts_by_namespace ON artifacts (namespace, status);

-- The parts of an upload sent through the toolkit's blob protocol, which
-- names its blocks rather than keeping their etags: R2 needs every part's
-- etag to finish the upload. Deleted when it finishes, or by the sweep.
CREATE TABLE IF NOT EXISTS blob_parts (
  upload TEXT NOT NULL,
  part INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (upload, part)
);
CREATE INDEX IF NOT EXISTS blob_parts_by_age ON blob_parts (created_at);

-- A repository's own Actions settings: how long its artifacts are kept by
-- default, and at most.
CREATE TABLE IF NOT EXISTS repo_settings (
  repo_id TEXT PRIMARY KEY,
  artifact_retention_days INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- The toolkit's cache client names the version of an entry (a hash of its
-- paths and compression): it restores only entries of the same version.
-- Entries saved by g1t's own `actions/cache` have none.
ALTER TABLE cache_entries ADD COLUMN version TEXT NOT NULL DEFAULT '';
-- The R2 upload of an entry still being sent, for the toolkit's older
-- protocol, whose requests name only the entry.
ALTER TABLE cache_entries ADD COLUMN upload TEXT;
