-- Abilities (docs.g1t.sh/guides/agent-abilities/): what each agent may do
-- through g1t, the workspace's integrations and MCP servers an owner adds,
-- and whether it does each alone, only when asked for it, after asking
-- first, or never.

-- The agent's choices (@g1t/contracts abilities.ts `AgentAbilities`, JSON):
-- levels and credentials per ability, and its MCP servers with the tools
-- each listed. Saved as a version like every other change.
ALTER TABLE agents ADD COLUMN abilities TEXT NOT NULL DEFAULT '{}';

-- An ability set to "Ask first", asked: the call an agent wanted to make,
-- waiting on the person it acts for (or an owner) to allow it from the
-- card in chat. Allowed, the call runs as that person and the result goes
-- back to the agent (a session reads it at its next step).
-- status: pending, allowed, denied, failed.
CREATE TABLE agent_ability_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  session_id TEXT,
  -- The ability's id (integration:linear:comment) and the tool call it was for.
  ability TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  -- What it would do, in a line, as the card says it.
  summary TEXT NOT NULL,
  asked_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  -- What came of it, as the agent was told.
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_ability_requests_session ON agent_ability_requests (session_id, status);
CREATE INDEX agent_ability_requests_agent ON agent_ability_requests (agent_id, created_at);
