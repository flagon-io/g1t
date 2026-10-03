-- Agents asking each other: a question or a handoff from the agent on one
-- pull request to the agent on another, and the answer, which goes back.
ALTER TABLE agent_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE agent_messages ADD COLUMN repo_id TEXT;
ALTER TABLE agent_messages ADD COLUMN from_number INTEGER;
ALTER TABLE agent_messages ADD COLUMN to_number INTEGER;
ALTER TABLE agent_messages ADD COLUMN answer TEXT;
ALTER TABLE agent_messages ADD COLUMN answered_at TEXT;
ALTER TABLE agent_messages ADD COLUMN declined INTEGER NOT NULL DEFAULT 0;
CREATE INDEX agent_messages_by_repo ON agent_messages (repo_id, created_at);
