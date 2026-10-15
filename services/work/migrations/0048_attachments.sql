-- Files put in an issue's, a pull request's or a comment's Markdown
-- (attachments.rs). Their bytes are in the usercontent namespace
-- (AVATARS) under `attachments/<id>`, served by the usercontent origin at
-- /attachments/<id>; these rows say whose repository each belongs to, so
-- a purged repository's go with it.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_by_repo ON attachments (repo_id);
