-- Subagents, what sessions touched, and the issues and pull requests they
-- worked on (src/coordination/sessions.rs, links.rs).

-- A subagent is a session of its own whose parent_id names the session
-- that started it (a Claude Code subagent, a Managed Agents thread). It
-- carries its kind, the task and prompt its parent gave it (cut short),
-- and its result: its final message, which is its parent's evidence.
ALTER TABLE sessions ADD COLUMN parent_id TEXT;
ALTER TABLE sessions ADD COLUMN agent_type TEXT;
ALTER TABLE sessions ADD COLUMN task TEXT;
ALTER TABLE sessions ADD COLUMN prompt TEXT;
ALTER TABLE sessions ADD COLUMN result TEXT;
ALTER TABLE sessions ADD COLUMN model TEXT;
-- When its recording was last announced as session.progressed, so that it
-- is announced at most every few seconds.
ALTER TABLE sessions ADD COLUMN progressed_at TEXT;
CREATE INDEX sessions_by_parent ON sessions (parent_id) WHERE parent_id IS NOT NULL;

-- What a session says it touched: files it wrote, commits it made, branches
-- it pushed, pull requests it opened, issues it named. Once per session,
-- kind and value; the first time it said so.
CREATE TABLE session_touches (
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- file, commit, branch, pull or issue.
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, value)
);
CREATE INDEX session_touches_by_value ON session_touches (repo_id, kind, value);

-- How a session is tied to an issue or pull request, one row per way:
-- attached, claim, branch, commit, trailer, opened or ref. The issue and
-- pull request pages list the sessions tied to them from here.
CREATE TABLE session_links (
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- issue or pull.
  kind TEXT NOT NULL,
  number INTEGER NOT NULL,
  via TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, kind, number, via)
);
CREATE INDEX session_links_by_number ON session_links (repo_id, kind, number);

-- Pairs of sessions announced as changing the same files
-- (overlap.detected), lower id first: announced once.
CREATE TABLE session_overlaps (
  repo_id TEXT NOT NULL,
  low TEXT NOT NULL,
  high TEXT NOT NULL,
  -- JSON array of the paths both touched when it was announced.
  files TEXT NOT NULL,
  noticed_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, low, high)
);
