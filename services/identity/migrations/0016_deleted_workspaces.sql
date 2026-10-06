-- Deleting a workspace. Its row, members, tokens and old-slug redirects go;
-- its slug is kept here so it is never given to another workspace or
-- account: links and git remotes under it (a transferred repository's old
-- path, say) keep meaning what they meant, and nobody can squat the name.
-- The person whose username the slug is may make a workspace of that name
-- again; see src/deletion.rs.
CREATE TABLE IF NOT EXISTS deleted_workspaces (
  slug TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
