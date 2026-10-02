-- Every timestamp becomes RFC 3339 UTC text instead of Unix milliseconds.
-- SQLite cannot change a column's type, so each table is rebuilt.
--
-- The new tables reference each other's new names; the renames at the end
-- carry those references along.
PRAGMA defer_foreign_keys = on;

CREATE TABLE intents_new (
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
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, number)
);
INSERT INTO intents_new
SELECT id, repo_id, number, title, brief, checks, status, author_id, author_name,
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch')
FROM intents;

CREATE TABLE attempts_new (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents_new (id),
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
  -- What the branch pointed to before a shipped attempt landed.
  landed_base TEXT,
  started_by_id TEXT NOT NULL,
  started_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (intent_id, number)
);
INSERT INTO attempts_new
SELECT id, intent_id, repo_id, number, agent, runtime, status, summary,
  fork_repo_id, fork_namespace, fork_name, head_commit, landed_base,
  started_by_id, started_by_name,
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch'),
  strftime('%Y-%m-%dT%H:%M:%fZ', updated_at / 1000.0, 'unixepoch')
FROM attempts;

CREATE TABLE session_entries_new (
  attempt_id TEXT NOT NULL REFERENCES attempts_new (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool TEXT,
  -- The fork's head when the entry was recorded: links reasoning to code.
  "commit" TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, seq)
);
INSERT INTO session_entries_new
SELECT attempt_id, seq, kind, text, tool, "commit",
  strftime('%Y-%m-%dT%H:%M:%fZ', at / 1000.0, 'unixepoch')
FROM session_entries;

DROP TABLE session_entries;
DROP TABLE attempts;
DROP TABLE intents;

ALTER TABLE intents_new RENAME TO intents;
ALTER TABLE attempts_new RENAME TO attempts;
ALTER TABLE session_entries_new RENAME TO session_entries;

CREATE INDEX attempts_starter ON attempts (started_by_id, status);
