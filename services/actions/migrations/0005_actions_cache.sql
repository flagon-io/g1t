-- The actions/cache entries of each repository, kept in R2 (the API's
-- ACTIONS_CACHE bucket): which keys there are, how big, and when each was
-- last restored, for restore keys, the repository's quota and eviction.
-- See services/actions/src/cache.rs.
--
-- Every statement can run twice: a table or index that exists is left as
-- it is.

CREATE TABLE IF NOT EXISTS cache_entries (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- The workspace's slug, whose storage it counts toward.
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  -- Its object in R2.
  object TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  -- pending (being uploaded), ready, or expired (its object is to be
  -- deleted, then the row).
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  UNIQUE (repo_id, key)
);
CREATE INDEX IF NOT EXISTS cache_entries_by_use ON cache_entries (repo_id, status, last_used_at);
CREATE INDEX IF NOT EXISTS cache_entries_by_status ON cache_entries (status, last_used_at);
CREATE INDEX IF NOT EXISTS cache_entries_by_namespace ON cache_entries (namespace, status);

-- What each workspace's cache held each day, for its storage charge.
CREATE TABLE IF NOT EXISTS cache_days (
  namespace TEXT NOT NULL,
  day TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (namespace, day)
);
