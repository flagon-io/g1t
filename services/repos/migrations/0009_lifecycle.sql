-- A repository's lifecycle beyond create and transfer: its home page,
-- archiving, and deleting with a window to restore. See src/lifecycle.rs.
--
-- website: an http(s) address shown beside its description.
-- archived_at: set while it is read-only (pushes, merges, agents and
--   workflows refused; issues and pull requests locked).
-- deleted_at / deleted_by / purge_after: set while it is deleted. A deleted
--   repository is hidden from every read, git refuses it, and its name stays
--   taken; restoring clears the three. The hourly sweep purges it once
--   purge_after has passed: its git data, its row and its redirects go, and
--   every service drops what it keeps for it on `repo.purged`.
ALTER TABLE repos ADD COLUMN website TEXT;
ALTER TABLE repos ADD COLUMN archived_at TEXT;
ALTER TABLE repos ADD COLUMN deleted_at TEXT;
ALTER TABLE repos ADD COLUMN deleted_by TEXT;
ALTER TABLE repos ADD COLUMN purge_after TEXT;
CREATE INDEX IF NOT EXISTS repos_purge ON repos (purge_after) WHERE deleted_at IS NOT NULL;

-- A branch renamed keeps its old name here, pointing at the new one, so web
-- addresses that name it (tree/<branch>/..., commits?ref=) redirect. A
-- redirect stops when a branch of the old name is made again (checked when
-- it is read) or the repository is purged.
CREATE TABLE IF NOT EXISTS branch_redirects (
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  now TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch)
);
