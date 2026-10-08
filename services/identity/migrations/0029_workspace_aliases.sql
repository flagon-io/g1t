-- Workspace aliases: a name g1t's staff point at a workspace, so its
-- addresses lead there under the workspace's own name. Staff-managed only,
-- from sudo; not a feature workspaces can use. An alias is a reserved or
-- unclaimed name, never a person's or a workspace's, and points at the
-- workspace's id, so it follows the workspace through renames. See
-- src/aliases.rs.
CREATE TABLE workspace_aliases (
  alias TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX workspace_aliases_by_workspace ON workspace_aliases (workspace_id);

-- g1t is the product Flagon, Inc. builds; flagon-io is the organization.
-- Nothing is added where flagon-io does not exist (a fresh self-hosted
-- install, a local database).
INSERT OR IGNORE INTO workspace_aliases (alias, workspace_id, created_by, created_at, note)
SELECT 'g1t', id, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'The product''s name, for Flagon, Inc.'
FROM workspaces WHERE slug = 'flagon-io' AND deleted_at IS NULL;
