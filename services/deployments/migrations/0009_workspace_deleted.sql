-- When the project's workspace was deleted (restorable by g1t's staff for a
-- while). Its apps are paused, not taken down, and it builds nothing; the
-- sweep leaves its apps as they are, though the deletion ended its plan.
-- A restore clears it and resumes the apps as the workspace's limit allows;
-- a purge takes everything down. Null otherwise. See src/index.ts
-- `workspaceDeleting`.
ALTER TABLE settings ADD COLUMN workspace_deleted_at TEXT;
