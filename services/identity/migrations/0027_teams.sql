-- Teams: groups of a workspace's members, given roles on repositories
-- together, mentioned and asked to review together. See src/teams.rs and
-- crates/contracts/src/teams.rs. Every timestamp is RFC 3339 UTC. The
-- statements say IF NOT EXISTS, so running them again changes nothing.

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- Its name in URLs and mentions, unique in the workspace.
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- 'visible' (every member sees it) or 'secret' (its people and owners).
  visibility TEXT NOT NULL DEFAULT 'visible',
  -- Its parent team, whose roles on repositories it inherits.
  parent_id TEXT,
  -- Whether its people are notified when it is mentioned.
  notify INTEGER NOT NULL DEFAULT 1,
  -- How review requests for it are assigned (JSON, ReviewAssignment).
  review_assignment TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug ON teams (workspace_id, slug);
CREATE INDEX IF NOT EXISTS teams_parent ON teams (parent_id);

-- Who is in a team: 'maintainer' or 'member'. Only members of the
-- workspace; removing someone from it removes these rows too.
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user ON team_members (user_id);

-- A team's role on a repository is a row of repo_grants (0020) with
-- principal_kind 'team' and principal_id the team's id.
