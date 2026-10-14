-- Comments on commits: on the whole commit, or on one line of a file it
-- changed (path and line, a line of the file as the commit left it).
-- Authors are stored as comments' are (author_id, author_name), so an
-- account purged shows as ghost here too. Deleting one removes its row.
CREATE TABLE commit_comments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- The commit's full hash, lowercase.
  commit_hash TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  -- Markdown, as written.
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
-- A commit's comments, oldest first.
CREATE INDEX commit_comments_by_commit ON commit_comments (repo_id, commit_hash, created_at);
-- A repository's, newest first.
CREATE INDEX commit_comments_by_repo ON commit_comments (repo_id, created_at);
