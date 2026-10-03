-- Access tokens can belong to a workspace instead of a person, so automation
-- needs no service account. A token has exactly one owner. A workspace's
-- token records who made it, and outlives that person's membership and
-- account.
CREATE TABLE access_tokens_new (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Null means the token does not expire.
  expires_at TEXT,
  -- Kept to within a few minutes, so that using a token is not a write.
  last_used_at TEXT,
  CHECK ((user_id IS NULL) <> (workspace_id IS NULL))
);
INSERT INTO access_tokens_new (id, user_id, created_by, name, token_hash, created_at, expires_at)
SELECT id, user_id, user_id, name, token_hash, created_at, expires_at FROM access_tokens;

DROP TABLE access_tokens;
ALTER TABLE access_tokens_new RENAME TO access_tokens;
CREATE INDEX access_tokens_user ON access_tokens (user_id);
CREATE INDEX access_tokens_workspace ON access_tokens (workspace_id);

ALTER TABLE workspaces ADD COLUMN description TEXT;
