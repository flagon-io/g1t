-- Deployments belong to projects, and previews to branches. The tables
-- from before held only the first test deployments; they are replaced, and
-- the sweep takes their apps out of the namespace.

DROP TABLE settings;
DROP TABLE apps;
DROP TABLE deployments;

-- Each project's choices. A project not listed does not deploy.
CREATE TABLE settings (
  project_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  previews INTEGER NOT NULL DEFAULT 1,
  production INTEGER NOT NULL DEFAULT 1,
  build_command TEXT,
  output_dir TEXT,
  idle_days INTEGER NOT NULL DEFAULT 7,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX settings_by_repo ON settings (repo_id);

-- Apps that are up, one per script in the dispatch namespace. The script's
-- name is the hostname's first label on g1t.page.
CREATE TABLE apps (
  script TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- preview or production.
  kind TEXT NOT NULL,
  -- For a preview: the branch (or pr-<n> for a fork) and its pull request.
  branch TEXT,
  number INTEGER,
  commit_sha TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_request_at TEXT
);
CREATE INDEX apps_by_project ON apps (project_id, kind, branch);
CREATE INDEX apps_by_workspace ON apps (workspace);

-- Every build, and where it went.
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  slug TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- The repository, as namespace/name, for links and charges.
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  branch TEXT,
  number INTEGER,
  commit_sha TEXT NOT NULL,
  script TEXT NOT NULL,
  -- queued, building, ready, failed or skipped.
  status TEXT NOT NULL,
  error TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  log TEXT,
  token_hash TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  build_seconds INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX deployments_by_project ON deployments (project_id, id);
CREATE INDEX deployments_by_status ON deployments (status, created_at);
