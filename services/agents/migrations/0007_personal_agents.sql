-- Personal agents (docs.g1t.sh/guides/agents/, "Personal agents"): any
-- member may create an agent of their own, which only they talk to, in
-- their direct message with it, and whose spend counts against their
-- budget. Owners keep the workspace's agents, and promote a personal one
-- to a workspace agent.

-- `workspace` or `personal`. Every agent so far is the workspace's.
ALTER TABLE agents ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace';
-- For a personal agent: the member it belongs to, by user id (what chat
-- names the asker by) and username (what lists show).
ALTER TABLE agents ADD COLUMN owner_id TEXT;
ALTER TABLE agents ADD COLUMN owner_username TEXT;

CREATE INDEX agents_personal ON agents (workspace_id, owner_id, archived_at) WHERE owner_id IS NOT NULL;

-- Whether members who aren't owners may create personal agents: on unless
-- an owner turns it off.
ALTER TABLE agent_policies ADD COLUMN members_create_agents INTEGER NOT NULL DEFAULT 1;
