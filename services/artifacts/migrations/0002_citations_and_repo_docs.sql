-- Pages know what they describe, and projects' docs folders in Docs
-- (docs/WORKSPACE.md, "Docs"; services/docs src/staleness.ts and
-- src/repo-spaces.ts).

-- Code a page cites: from its text (the editor's citation chips and links
-- to files in a repository), rebuilt on each save; and from its header's
-- "Describes" list. `repo` is `owner/name`, lowercased; `path` a file, a
-- folder or a glob.
CREATE TABLE citations (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('path', 'symbol', 'endpoint', 'env')),
  label TEXT NOT NULL DEFAULT '',
  ref TEXT,
  source TEXT NOT NULL CHECK (source IN ('body', 'header')),
  PRIMARY KEY (page_id, source, repo, path, kind, label)
);
CREATE INDEX citations_repo ON citations (repo);

-- Changes that touched code a page cites: one row per page and commit (a
-- merge is told twice, as `git.push` and as `pull.merged`; both land on
-- the same row, and the pull request names it). Open until someone marks
-- the page current (`cleared_at`).
CREATE TABLE page_changes (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  pull_number INTEGER,
  pull_title TEXT,
  -- The cited paths it changed, as JSON.
  paths TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL,
  cleared_at TEXT,
  cleared_by TEXT,
  PRIMARY KEY (page_id, repo, commit_sha)
);
CREATE INDEX page_changes_open ON page_changes (page_id) WHERE cleared_at IS NULL;
CREATE INDEX page_changes_recent ON page_changes (detected_at) WHERE cleared_at IS NULL;

-- An agent's suggestion that, once accepted, marks the page current.
ALTER TABLE suggestions ADD COLUMN marks_current INTEGER NOT NULL DEFAULT 0;

-- A repository's docs folder shown in a workspace's Docs.
CREATE TABLE repo_spaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- `owner/name`, lowercased, as it is named now.
  repo TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  -- The commit it was last read at.
  commit_sha TEXT,
  indexed_at TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (workspace_id, repo_id)
);
CREATE INDEX repo_spaces_repo ON repo_spaces (repo_id);

-- Its Markdown files as last read. `hash` is the blob's, so a push reads
-- only what changed.
CREATE TABLE repo_files (
  space_id TEXT NOT NULL REFERENCES repo_spaces (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  PRIMARY KEY (space_id, path)
);

-- Full text over them, beside pages_fts.
CREATE VIRTUAL TABLE repo_files_fts USING fts5 (space_id UNINDEXED, path UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
