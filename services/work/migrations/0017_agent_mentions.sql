-- Comments that mention @g1t-agent, each handled once: the runner takes a
-- pending one when it hears the comment was made, and says what it did.
CREATE TABLE agent_mentions (
  comment_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- Set when the comment is on a pull request.
  pull_id TEXT,
  -- Who wrote it, as JSON, with the memberships they had when they did.
  actor TEXT NOT NULL,
  body TEXT NOT NULL,
  -- What they asked for: work, question or review.
  intent TEXT NOT NULL,
  -- Whether they belong to the repository's workspace.
  member INTEGER NOT NULL,
  -- pending, taken, then replied once g1t-agent has answered in the thread.
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  created_at TEXT NOT NULL,
  taken_at TEXT
);
CREATE INDEX agent_mentions_by_subject ON agent_mentions (repo_id, number);

-- Rules that put g1t-agent to work without anyone assigning it. One row per
-- repository that has set one.
CREATE TABLE agent_rules (
  repo_id TEXT PRIMARY KEY,
  -- When an issue is given this label, g1t-agent takes it.
  label TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
