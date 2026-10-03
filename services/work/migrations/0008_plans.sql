-- Planning: an outcome someone wrote, turned by an agent into issues with
-- the order they have to land in, which a person reads before any of it
-- is opened.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- The outcome wanted, as written.
  brief TEXT NOT NULL,
  -- planning, ready, failed or applied.
  status TEXT NOT NULL DEFAULT 'planning',
  -- The agent's account of how it split the work.
  summary TEXT,
  -- JSON array of proposed issues; once applied, each carries its number.
  issues TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  -- SHA-256 of the token the sandbox reports with.
  token_hash TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX plans_by_repo ON plans (repo_id, id);

-- The issues that have to be merged before this one is worked on: a JSON
-- array of issue numbers.
ALTER TABLE issues ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]';
-- Set when someone asked for a g1t agent to take the issue as soon as it
-- can: JSON of who asked, on whose say-so the agent then works. Cleared
-- when a pull request is opened for it.
ALTER TABLE issues ADD COLUMN queued_by TEXT;
