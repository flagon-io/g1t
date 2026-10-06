-- When the project's repository was archived (made read-only). Null for a
-- repository that is not. Kept from repo.archived and repo.unarchived.
ALTER TABLE projects ADD COLUMN repo_archived_at TEXT;

-- Every workspace's projects are read from repos once more, on their next
-- listing, so repositories archived before this column existed show it.
DELETE FROM backfilled;
