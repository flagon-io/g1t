-- Stored in Artifacts as "<namespace>--<name>".
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- Set on an attempt's working copy; those are hidden from listings.
  fork_of TEXT REFERENCES repos (id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (namespace, name)
);
CREATE INDEX repos_owner ON repos (owner_id);
