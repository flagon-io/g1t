CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  -- JSON array of commands.
  checks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents (id),
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  agent TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working',
  summary TEXT,
  fork_repo_id TEXT NOT NULL UNIQUE,
  fork_namespace TEXT NOT NULL,
  fork_name TEXT NOT NULL,
  head_commit TEXT,
  started_by_id TEXT NOT NULL,
  started_by_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (intent_id, number)
);
CREATE INDEX attempts_starter ON attempts (started_by_id, status);

CREATE TABLE session_entries (
  attempt_id TEXT NOT NULL REFERENCES attempts (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool TEXT,
  -- The fork's head when the entry was recorded: links reasoning to code.
  "commit" TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, seq)
);
