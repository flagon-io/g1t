-- Each agent's face as its owner chose it (docs.g1t.sh/guides/agents/, "Its
-- face"): a JSON object of seven parts (@g1t/contracts agent-look.ts
-- `AgentLook`), read and written whole. NULL means the agent wears the face
-- drawn from its avatar_seed, as every agent did before this.
ALTER TABLE agents ADD COLUMN look TEXT;
