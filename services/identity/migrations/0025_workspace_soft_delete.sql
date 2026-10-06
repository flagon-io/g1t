-- Deleting a workspace is soft. Its row stays, with when, by whom and
-- until when it can be restored, and every read that resolves a workspace
-- leaves it out: nobody's memberships list it, its tokens are refused and
-- its pages are not found. Its members and tokens are kept as they were, so
-- a restore by g1t's staff brings it back whole. The row holding its slug
-- keeps the slug from anyone else meanwhile. Once purge_after passes, the
-- scheduled purge removes it as deleting always did (src/deletion.rs).
--
-- `deleted_went` is what went with it, counted when it was deleted (JSON:
-- repositories, projects, members), for staff deciding on a restore.
--
-- `protected`: a workspace that can never be deleted, by anyone. It is
-- kept on the row as well as in PROTECTED_WORKSPACES, so a rename does not
-- take the protection away.
ALTER TABLE workspaces ADD COLUMN deleted_at TEXT;
ALTER TABLE workspaces ADD COLUMN deleted_by TEXT;
ALTER TABLE workspaces ADD COLUMN purge_after TEXT;
ALTER TABLE workspaces ADD COLUMN deleted_went TEXT;
ALTER TABLE workspaces ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS workspaces_purge_after ON workspaces (purge_after) WHERE deleted_at IS NOT NULL;

-- Flagon's workspace runs g1t.
UPDATE workspaces SET protected = 1 WHERE slug = 'flagon-io';
