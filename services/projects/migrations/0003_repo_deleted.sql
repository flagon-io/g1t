-- When the project's repository was deleted (restorable for a while).
-- Until it is restored, the project is hidden: lists, lookups and
-- dependencies treat it as missing. A purge deletes it. Null for a
-- repository that is there.
ALTER TABLE projects ADD COLUMN repo_deleted_at TEXT;
