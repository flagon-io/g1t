-- Coordinating work (src/coordination/): sessions of people's own harnesses,
-- advisory claims on issues, and which pairs of pull requests have been
-- announced as overlapping.

-- One run of someone's own harness (a Claude Code session, a Codex run) on
-- a repository, by a person's token. `state` is stored as active or ended;
-- idle (15 minutes without a heartbeat) is worked out when read, and two
-- hours without one ends it as `timed_out`.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- The issue and pull request it works on, by number, if it said.
  issue INTEGER,
  pull INTEGER,
  branch TEXT,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  -- claude_code, codex, cursor, copilot or other.
  harness TEXT NOT NULL,
  -- The harness's own id for it: starting it again returns this row.
  harness_session_id TEXT,
  title TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  head_commit TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE UNIQUE INDEX sessions_by_harness_id ON sessions (repo_id, actor_id, harness, harness_session_id)
  WHERE harness_session_id IS NOT NULL;
CREATE INDEX sessions_by_repo ON sessions (repo_id, state, last_seen_at);
CREATE INDEX sessions_by_issue ON sessions (repo_id, issue) WHERE issue IS NOT NULL;
CREATE INDEX sessions_by_pull ON sessions (repo_id, pull) WHERE pull IS NOT NULL;

-- A session's entries live beside the ones recorded on a pull request, so
-- `pull_id` may now be empty: an entry belongs to a pull request, a
-- session, or both. SQLite cannot loosen NOT NULL in place, so the table
-- is rebuilt with the same columns plus:
--
--   session_id    the session it was recorded in.
--   session_seq   its place in that session.
--   key           the harness's idempotency key: recording an entry with
--                 a key already recorded in the session does nothing.
--
-- An entry of a session that is on a pull request also takes the next
-- `seq` of that pull request, so it shows in the pull request's session as
-- the entries recorded on it do. One recorded before the session named
-- its pull request has `pull_id` NULL and `seq` = `session_seq` until then.
CREATE TABLE session_entries_next (
  pull_id TEXT REFERENCES pulls (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool TEXT,
  "commit" TEXT,
  at TEXT NOT NULL,
  session_id TEXT,
  session_seq INTEGER,
  key TEXT,
  CHECK (pull_id IS NOT NULL OR session_id IS NOT NULL)
);
INSERT INTO session_entries_next (pull_id, seq, kind, text, tool, "commit", at)
  SELECT pull_id, seq, kind, text, tool, "commit", at FROM session_entries;
DROP TABLE session_entries;
ALTER TABLE session_entries_next RENAME TO session_entries;
CREATE UNIQUE INDEX session_entries_by_pull ON session_entries (pull_id, seq) WHERE pull_id IS NOT NULL;
CREATE UNIQUE INDEX session_entries_by_session ON session_entries (session_id, session_seq)
  WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX session_entries_by_key ON session_entries (session_id, key)
  WHERE session_id IS NOT NULL AND key IS NOT NULL;

-- An advisory, expiring "I'm working on #N": never a lock. Active until
-- released, handed off, or past `expires_at` (noticed when next read, and
-- then announced as expired). Claiming again, or a heartbeat of the
-- session it was made from, renews it by `ttl_minutes`.
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue INTEGER NOT NULL,
  session_id TEXT,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  harness TEXT,
  note TEXT,
  -- active, released, expired or handed_off.
  state TEXT NOT NULL DEFAULT 'active',
  ttl_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  -- For a hand-off: the username it is for; NULL for anyone.
  handoff_to TEXT
);
CREATE INDEX claims_by_issue ON claims (repo_id, issue, state);
CREATE INDEX claims_by_state ON claims (repo_id, state, expires_at);
CREATE INDEX claims_by_session ON claims (session_id, state) WHERE session_id IS NOT NULL;

-- Pairs of pull requests announced as changing the same files
-- (`overlap.detected`), lower number first: announced once, and again only
-- after the pair stopped overlapping and this row went.
CREATE TABLE overlap_pairs (
  repo_id TEXT NOT NULL,
  low INTEGER NOT NULL,
  high INTEGER NOT NULL,
  -- JSON array of the paths both changed when it was announced.
  files TEXT NOT NULL,
  noticed_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, low, high)
);
