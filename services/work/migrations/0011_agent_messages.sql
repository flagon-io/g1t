-- Messages people send an agent while it works on a pull request. The
-- sandbox takes the undelivered ones at each step of the agent's run.
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  pull_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX agent_messages_by_pull ON agent_messages (pull_id, created_at);
