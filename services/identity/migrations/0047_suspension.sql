-- Staff suspend an account or a workspace, and block email domains from
-- signing up (src/suspension.rs). Lifting a suspension clears its columns;
-- every change is in the staff audit log.
ALTER TABLE users ADD COLUMN suspended_at TEXT;
ALTER TABLE users ADD COLUMN suspended_reason TEXT;
ALTER TABLE users ADD COLUMN suspended_by TEXT;
ALTER TABLE workspaces ADD COLUMN suspended_at TEXT;
ALTER TABLE workspaces ADD COLUMN suspended_reason TEXT;
ALTER TABLE workspaces ADD COLUMN suspended_by TEXT;

CREATE TABLE IF NOT EXISTS blocked_domains (
  domain TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  blocked_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
