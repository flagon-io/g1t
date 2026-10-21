-- Projects (items/projects.rs, g1t_contracts::work::projects): a home for
-- a body of work in a workspace, with a brief, a lead, people, repositories,
-- dates and health. Its slug is unique in the workspace. state is shaping,
-- active, paused, done or dropped; appetite small, medium or large; health
-- on_track, at_risk, off_track or NULL for not said. channel_id (its Chat
-- channel) and space_id (its Library space) are kept for when projects get
-- them, and read by nothing yet. An archived project (archived_at) is left
-- out of lists, and its items keep it.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  lead_id TEXT,
  lead_name TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  appetite TEXT,
  start_on TEXT,
  target_on TEXT,
  health TEXT,
  channel_id TEXT,
  space_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  created_by_name TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  updated_by_name TEXT,
  archived_at TEXT
);
CREATE UNIQUE INDEX projects_by_slug ON projects (workspace, slug);

-- Who is in a project: its lead (role lead, the one projects.lead_id names)
-- and its members, by account id, with the username they had when added.
CREATE TABLE project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  added_at TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_by_user ON project_members (user_id);

-- The repositories a project's work lands in: repositories of its
-- workspace. A default target is linked as a target to each work item
-- filed into the project without targets of its own.
CREATE TABLE project_repos (
  project_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  default_target INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (project_id, repo_id)
);
CREATE INDEX project_repos_by_repo ON project_repos (repo_id);

-- The project a work item is in, by id: one project or none (NULL). Code
-- from before this neither reads nor writes it.
ALTER TABLE work_items ADD COLUMN project_id TEXT;
CREATE INDEX work_items_by_project ON work_items (project_id, state) WHERE project_id IS NOT NULL;
