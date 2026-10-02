-- Workspaces own repositories and are the first segment of their URLs.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'owner' or 'member'
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

-- Repositories created before workspaces existed live under their owner's
-- username, so each existing account gets a workspace of that name.
INSERT INTO workspaces (id, slug, name, created_by)
SELECT 'wsp_' || lower(hex(randomblob(13))), username, username, id FROM users;

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, created_by, 'owner' FROM workspaces;
