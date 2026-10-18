-- When a repository was deleted, while it can still be restored: its work
-- items' links say so, and the board reads nothing from it. Set on
-- repo.deleted, cleared on repo.restored, and the row goes on repo.purged.
ALTER TABLE repo_workspaces ADD COLUMN deleted_at TEXT;

-- The job that marks the repositories deleted before this column was
-- there (items/migration.rs `mark_deleted_repos`). It runs once the jobs
-- before it are done, and again changes nothing.
INSERT INTO work_jobs (name) VALUES ('deleted_marks');
