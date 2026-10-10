-- People and teams (src/people.rs, src/teams.rs; crates/contracts/src/people.rs):
-- a member's place in the workspace (a title, who they report to, what
-- they own), and what a team has besides its people: agents, a lead, a
-- channel and a monthly budget for its agents.
--
-- Wrangler applies it once; each ALTER must run once, like 0031's.

-- A member's job title here ("Staff Engineer"), shown in the directory.
ALTER TABLE workspace_members ADD COLUMN title TEXT;
-- Who they report to: another member's user id. Cleared when either
-- leaves the workspace. Never a cycle (people.rs checks).
ALTER TABLE workspace_members ADD COLUMN manager_id TEXT;
-- What they own, as a JSON array of a few short phrases
-- (["storefront", "the release process"]). Agents on their teams are
-- told it, to know who to ask.
ALTER TABLE workspace_members ADD COLUMN owns TEXT;
CREATE INDEX IF NOT EXISTS workspace_members_manager ON workspace_members (workspace_id, manager_id);

-- Who leads a team: 'user' (a user id) or 'agent' (an agent id from the
-- agents service), always one on the team. NULL for no lead.
ALTER TABLE teams ADD COLUMN lead_kind TEXT;
ALTER TABLE teams ADD COLUMN lead_id TEXT;
-- The team's chat channel: its id in the chat service, and its name when
-- it was chosen, for a link while chat is not asked.
ALTER TABLE teams ADD COLUMN channel_id TEXT;
ALTER TABLE teams ADD COLUMN channel_name TEXT;
-- What the team's agents may spend together in a calendar month, in
-- millionths of a dollar. NULL for no team budget; each agent keeps its own.
ALTER TABLE teams ADD COLUMN budget_micros INTEGER;

-- The agents on a team, by their id in the agents service. An agent is
-- also on the team its own profile names (its home team), without a row.
CREATE TABLE IF NOT EXISTS team_agents (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- The person who added it, by user id.
  added_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);
CREATE INDEX IF NOT EXISTS team_agents_agent ON team_agents (agent_id);
