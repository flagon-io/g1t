-- An agent is on teams the way a person is: through team membership in
-- identity (team_agents), added and removed on the team page or the
-- agent's profile (docs.g1t.sh/guides/people-and-teams/). The agent itself
-- carries no team and no department.
--
-- agents.team and agents.department stay as they are, unused: migrations
-- run before the code, so the code still serving during a deploy reads
-- and writes them for a minute or more. A later migration drops them once
-- no deployed code names them.
--
-- Each agent's old `team` moves to a membership once (src/team-move.ts,
-- run by the cron): a team of that slug in its workspace gets it as a
-- member, and a value that names no team is dropped and logged.
-- `team_moved_at` marks the agents it has seen, so it never runs twice for
-- one, and taking an agent off that team later stays taken off.
ALTER TABLE agents ADD COLUMN team_moved_at TEXT;
CREATE INDEX IF NOT EXISTS agents_team_to_move ON agents (id) WHERE team IS NOT NULL AND team <> '' AND team_moved_at IS NULL;
