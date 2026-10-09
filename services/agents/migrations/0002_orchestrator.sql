-- Every workspace's built-in orchestrator, @g1t (docs/WORKSPACE.md, "g1t,
-- the orchestrator"): an ordinary agent row marked builtin, made the first
-- time the workspace's agents are asked for. One per workspace.
ALTER TABLE agents ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX agents_builtin ON agents (workspace_id) WHERE builtin = 1;

-- Each agent's face: the seed its generated pixel avatar is drawn from,
-- set from the handle when it is made. Empty on older rows: the handle.
ALTER TABLE agents ADD COLUMN avatar_seed TEXT NOT NULL DEFAULT '';

-- Agents are hired into roles, not tasks (docs/WORKSPACE.md, "Roles, not
-- tasks"): a title, a team (by slug) or a department label, a list of
-- responsibilities and the subagents they keep (JSON lists), and whether
-- they face the workspace's own people or customers (only `internal` yet).
ALTER TABLE agents ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN team TEXT;
ALTER TABLE agents ADD COLUMN department TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN responsibilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN subagents TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN faces TEXT NOT NULL DEFAULT 'internal';

-- Every read tool call a reply made (docs/WORKSPACE.md, "What an agent can
-- and can't know", rule 7): the agent, who asked, a fingerprint of the
-- audience, the tool and its arguments (long text cut), and whether it was
-- read or withheld, with how much came back.
CREATE TABLE agent_tool_calls (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  asked_by TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  audience_hash TEXT NOT NULL,
  -- allowed, withheld, refused (a rail: the call budget, the hop limit, no ping-pong) or error.
  outcome TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX agent_tool_calls_reply ON agent_tool_calls (reply_id);
CREATE INDEX agent_tool_calls_agent ON agent_tool_calls (agent_id, created_at);
