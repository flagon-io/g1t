-- Issues, pull requests, comments and sessions.
-- Every timestamp is RFC 3339 UTC text.

-- Issues and pull requests share one sequence of numbers per repository.
CREATE TABLE counters (
  repo_id TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- JSON array of label names.
  labels TEXT NOT NULL DEFAULT '[]',
  -- JSON array of commands.
  checks TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open',
  -- Why it was closed: completed or not_planned.
  reason TEXT,
  -- The number of the pull request whose merge closed it.
  resolved_by INTEGER,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (repo_id, number)
);
CREATE INDEX issues_by_state ON issues (repo_id, state, number);

CREATE TABLE pulls (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- The issue it is for, if any, and that issue's number.
  issue_id TEXT REFERENCES issues (id),
  issue_number INTEGER,
  title TEXT NOT NULL,
  body TEXT,
  agent TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  fork_repo_id TEXT NOT NULL UNIQUE,
  fork_namespace TEXT NOT NULL,
  fork_name TEXT NOT NULL,
  head_commit TEXT,
  -- What the branch pointed to before a merged pull request landed.
  merge_base TEXT,
  merged_by TEXT,
  merged_at TEXT,
  -- The pull request merged instead of this one.
  superseded_by INTEGER,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE INDEX pulls_by_status ON pulls (repo_id, status, number);
CREATE INDEX pulls_by_issue ON pulls (issue_id);
CREATE INDEX pulls_by_author ON pulls (author_id, status);

-- On an issue or a pull request: the two share numbers.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_by_subject ON comments (repo_id, number, id);

CREATE TABLE session_entries (
  pull_id TEXT NOT NULL REFERENCES pulls (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool TEXT,
  -- The fork's head when the entry was recorded: links reasoning to code.
  "commit" TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (pull_id, seq)
);
