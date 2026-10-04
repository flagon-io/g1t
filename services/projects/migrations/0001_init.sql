-- Projects: the thing a workspace builds and runs, each with one source.
-- Every timestamp is RFC 3339 UTC.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  -- The workspace's slug.
  workspace TEXT NOT NULL,
  -- Unique in the workspace: g1t.sh/<workspace>/<slug>.
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- hosted (a repository on g1t); mirror sources come later.
  source_kind TEXT NOT NULL DEFAULT 'hosted',
  repo_id TEXT NOT NULL,
  repo_namespace TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- Where in the repository it lives; '' for all of it.
  root_dir TEXT NOT NULL DEFAULT '',
  -- The project its repository's workflows read secrets from.
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace, slug)
);
CREATE INDEX projects_by_repo ON projects (repo_id, is_primary DESC);

-- Workspaces whose existing repositories have all been given projects.
CREATE TABLE backfilled (
  workspace TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
