-- Renaming a workspace, as GitHub renames an organization. Each slug a
-- workspace was renamed from points at the workspace's id, so old
-- addresses resolve to whatever its slug is now, however many times it has
-- been renamed. An old slug stays reserved for the workspace for 90 days
-- after the rename (SLUG_HOLD_DAYS), and the latest created_at of a
-- workspace's rows limits how often it can be renamed. See src/rename.rs.
CREATE TABLE workspace_redirects (
  old_slug TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX workspace_redirects_by_workspace ON workspace_redirects (workspace_id, created_at);
