-- Attachments on work items (attachments.rs): a work item filed without a
-- repository takes files too, kept by the work item (`item_id`, with its
-- `workspace`, so a deleted workspace's go with it) instead of a
-- repository. Each row names one or the other.
CREATE TABLE attachments_new (
  id TEXT PRIMARY KEY,
  repo_id TEXT,
  item_id TEXT,
  workspace TEXT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (repo_id IS NOT NULL OR item_id IS NOT NULL)
);

INSERT INTO attachments_new (id, repo_id, user_id, name, content_type, size, created_at)
SELECT id, repo_id, user_id, name, content_type, size, created_at FROM attachments;

DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;

CREATE INDEX attachments_by_repo ON attachments (repo_id);
CREATE INDEX attachments_by_workspace ON attachments (workspace) WHERE workspace IS NOT NULL;
