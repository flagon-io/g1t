-- Budgets per person (docs.g1t.sh/guides/agent-budgets/): what the agents
-- working for one person, the replies and sessions that person asked for,
-- may spend together in a month. Budgets nest: the workspace's spend limit
-- (billing), the workspace's agent budget, a person's, an agent's, a task's.

-- The budget every person has unless they have their own. Null: none.
ALTER TABLE agent_policies ADD COLUMN person_monthly_micros INTEGER;

-- A person's own budget, set by an owner. 0: no budget at all, whatever
-- the default. No row: the default.
CREATE TABLE person_budgets (
  workspace_id TEXT NOT NULL,
  username TEXT NOT NULL,
  monthly_micros INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, username)
);

-- What a person's agents spent is summed from the replies and sessions they
-- asked for, so it counts from the first one, before any budget was set.
CREATE INDEX agent_replies_asker ON agent_replies (workspace_id, asked_by_username, created_at);
CREATE INDEX agent_sessions_asker ON agent_sessions (workspace_id, asked_by_username, created_at);
