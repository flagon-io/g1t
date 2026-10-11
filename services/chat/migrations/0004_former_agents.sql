-- Agents deleted for good (docs.g1t.sh/guides/chat/, "Archived and deleted
-- agents"): the agents service forgets everything about one, but its
-- messages stay in chat, so chat keeps the name and face it had to show
-- them under. Written when the agents service says an agent is gone
-- (`agent_destroyed`), read when a message's author is an agent the
-- agents service no longer knows.
CREATE TABLE former_agents (
  agent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_seed TEXT,
  -- Its chosen face (JSON, @g1t/contracts agent-look.ts), or NULL for the seed's.
  look TEXT,
  deleted_at TEXT NOT NULL
);
