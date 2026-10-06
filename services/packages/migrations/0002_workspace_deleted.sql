-- Set when the package's workspace is deleted (workspace.deleting) and
-- cleared when it is restored: hidden from the registries, the site and
-- billing meanwhile. The purge (workspace.deleted) removes the rows.
ALTER TABLE packages ADD COLUMN workspace_deleted_at TEXT;
CREATE INDEX packages_workspace_deleted ON packages (workspace) WHERE workspace_deleted_at IS NOT NULL;
