-- A repository's deployments wherever they run: reported through the API
-- by any CI, or made by a g1t Actions job with an `environment:`. g1t.page
-- builds stay in `deployments` and are read into the same model, never
-- copied (src/repo-deployments.ts). Every timestamp is RFC 3339 UTC.

-- The environments deployments went to, each named once per repository
-- whatever its case: the first deployment's spelling is kept.
CREATE TABLE environments (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
);

-- Each reported deployment, with its latest status's state and addresses.
CREATE TABLE reported_deployments (
  -- dep_…
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  environment TEXT NOT NULL COLLATE NOCASE,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT 'deploy',
  description TEXT,
  -- A JSON object, as given.
  payload TEXT NOT NULL DEFAULT '{}',
  transient_environment INTEGER NOT NULL DEFAULT 0,
  production_environment INTEGER NOT NULL DEFAULT 0,
  -- queued, in_progress, success, failure, error or inactive.
  state TEXT NOT NULL,
  environment_url TEXT,
  log_url TEXT,
  -- A username, or g1t.
  creator TEXT NOT NULL,
  -- api or actions.
  source TEXT NOT NULL,
  -- For actions: the run and its attempt. One deployment per run, attempt
  -- and environment, however many of its jobs name the environment.
  run_id TEXT,
  run_attempt INTEGER,
  run_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX reported_by_repo ON reported_deployments (repo_id, created_at);
CREATE INDEX reported_by_environment ON reported_deployments (repo_id, environment, created_at);
CREATE UNIQUE INDEX reported_by_run ON reported_deployments (run_id, run_attempt, environment) WHERE run_id IS NOT NULL;

-- Every status a reported deployment was given, in order.
CREATE TABLE deployment_statuses (
  -- dst_…
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  state TEXT NOT NULL,
  description TEXT,
  environment_url TEXT,
  log_url TEXT,
  creator TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX statuses_by_deployment ON deployment_statuses (deployment_id, created_at);

-- g1t.page builds, read by repository alongside the reported ones.
CREATE INDEX deployments_by_repo ON deployments (repo_id, created_at);
