-- Runs people asked for while every agent slot of their workspace was
-- busy (its plan's agents-at-once cap). The runner starts them, oldest
-- first, as slots free up; `payload` is what it needs to, kept as given.
CREATE TABLE agent_waits (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- review, update, plan, reply, revise
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_waits_by_workspace ON agent_waits (workspace, created_at);
