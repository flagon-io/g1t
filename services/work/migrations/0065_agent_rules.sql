-- Cloud agents' work, told by the conventions they write on their commits
-- (g1t_contracts::coding_agents::agent_mark, cloud_agents.rs): an
-- Agent-Logs-Url trailer, a coding agent's address as author or co-author,
-- a Claude-Session trailer or Cursor's "Made with Cursor".

-- A pull request one of whose commits a coding agent made: the rule that
-- matched first, the agent, and the person it counts for (the member who
-- verified the address of whoever started it), when g1t knows them.
ALTER TABLE pulls ADD COLUMN agent_rule TEXT;
ALTER TABLE pulls ADD COLUMN agent_name TEXT;
ALTER TABLE pulls ADD COLUMN agent_by_id TEXT;
ALTER TABLE pulls ADD COLUMN agent_by_name TEXT;

-- A coding agent's commit pushed straight to a default branch, outside any
-- pull request, each once: by the same rules, with the person it counts
-- for, and when the push brought it.
CREATE TABLE agent_commits (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  agent TEXT NOT NULL,
  rule TEXT NOT NULL,
  person_id TEXT,
  person_name TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha)
);

CREATE INDEX agent_commits_by_time ON agent_commits (repo_id, at);
