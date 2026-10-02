-- created_at becomes RFC 3339 UTC text instead of Unix seconds.
PRAGMA defer_foreign_keys = on;

-- Stored in Artifacts as "<namespace>--<name>".
CREATE TABLE repos_new (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- Set on an attempt's working copy; those are hidden from listings.
  -- Refers to this table; the rename below carries the reference along.
  fork_of TEXT REFERENCES repos_new (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (namespace, name)
);
INSERT INTO repos_new
  (id, namespace, name, description, is_private, owner_id, default_branch, fork_of, created_at)
SELECT id, namespace, name, description, is_private, owner_id, default_branch, fork_of,
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch')
FROM repos;

DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;
CREATE INDEX repos_owner ON repos (owner_id);
