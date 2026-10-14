-- Each person's own state of a workspace's setup guide (Getting started),
-- per workspace: when they dismissed it, so it stops opening by itself on
-- the workspace's Home, and the steps they chose to skip (`skipped`, a JSON
-- array of step keys such as ["people","runner"]). Whether a step is done
-- is read from the workspace itself, never kept here. A person with no row
-- for a workspace has never dismissed it, so it opens for every owner of a
-- workspace made before this table, too. Keyed by the workspace's id so a
-- rename keeps it. See src/onboarding.rs.
CREATE TABLE onboarding (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  dismissed_at TEXT,
  skipped TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, workspace_id)
);
