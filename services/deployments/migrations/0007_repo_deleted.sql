-- When the project's repository was deleted. Its apps are taken down and
-- it builds nothing, but its settings (and domains) are kept, so that a
-- restore puts production back as it was; a purge removes them. Null for
-- a repository that is there.
ALTER TABLE settings ADD COLUMN repo_deleted_at TEXT;
