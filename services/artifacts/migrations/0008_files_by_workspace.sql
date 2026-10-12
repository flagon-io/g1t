-- What a workspace's files hold, added up before each upload (src/quota.ts).
CREATE INDEX IF NOT EXISTS files_by_workspace ON files (workspace_id);
CREATE INDEX IF NOT EXISTS folio_files_by_workspace ON folio_files (workspace_id);
