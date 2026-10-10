-- Effort and recommendations (docs.g1t.sh/guides/spend/).
--
-- An agent's effort setting lives in its routing JSON (`effort`: auto,
-- low, medium, high or max), so it is versioned with the rest of the
-- definition and needs no column. What is recorded here is the level each
-- piece of work actually ran at, so what a level costs and how often its
-- work is accepted can be measured from real history.

-- The level a session ran at: low, medium, high or max. When Auto raises
-- it partway (someone steered it), the highest. Null before this.
ALTER TABLE agent_sessions ADD COLUMN effort TEXT;
-- The tier its last step ran on, for the record.
ALTER TABLE agent_sessions ADD COLUMN tier TEXT;
-- The level a chat reply ran at.
ALTER TABLE agent_replies ADD COLUMN effort TEXT;

CREATE INDEX IF NOT EXISTS agent_sessions_finished ON agent_sessions (workspace_id, agent_id, finished_at);

-- Ways to spend less, from the weekly check (src/recommend.ts). One row per
-- agent and suggestion; a check refreshes an open or thin one in place, and
-- never reopens one that was applied or dismissed until the agent's
-- setting changes. status: open, thin (too little history to say),
-- applied, dismissed, stale (the setting changed under it).
CREATE TABLE agent_recommendations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  from_effort TEXT NOT NULL,
  to_effort TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- JSON: the window and both sides' counts, acceptance and costs.
  evidence TEXT NOT NULL,
  saving_month_micros INTEGER,
  checked_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_recommendations_one ON agent_recommendations (agent_id, kind, from_effort, to_effort);
CREATE INDEX agent_recommendations_workspace ON agent_recommendations (workspace_id, status);

-- When the check last ran for each workspace, so the page can say so and
-- the daily run checks each workspace once a week.
CREATE TABLE agent_recommendation_checks (
  workspace_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL
);
