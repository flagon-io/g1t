-- When the project's workspace was deleted (restorable by g1t's staff for a
-- while). Set only on projects the deletion hid itself, which it hides the
-- way a deleted repository does, through repo_deleted_at; a restore of the
-- workspace shows exactly these again. A project hidden before, because
-- its repository was deleted on its own, stays hidden.
ALTER TABLE projects ADD COLUMN workspace_deleted_at TEXT;
