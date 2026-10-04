-- Deployments: previews per pull request and production, on g1t.page.
-- Every timestamp is RFC 3339 UTC.

-- Each repository's choices. A repository not listed does not deploy.
CREATE TABLE settings (
  repo_id TEXT PRIMARY KEY,
  -- The workspace's slug and the repository's name.
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  previews INTEGER NOT NULL DEFAULT 1,
  production INTEGER NOT NULL DEFAULT 1,
  build_command TEXT,
  output_dir TEXT,
  idle_days INTEGER NOT NULL DEFAULT 7,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- Apps that are up, one per script in the dispatch namespace. The script's
-- name is the hostname's first label on g1t.page.
CREATE TABLE apps (
  script TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  -- preview or production.
  kind TEXT NOT NULL,
  -- For a preview: the pull request.
  number INTEGER,
  commit_sha TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- When it last answered a request, as of the last count.
  last_request_at TEXT
);
CREATE INDEX apps_by_repo ON apps (repo_id, kind, number);
CREATE INDEX apps_by_workspace ON apps (namespace);

-- Every build, and where it went.
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  number INTEGER,
  commit_sha TEXT NOT NULL,
  script TEXT NOT NULL,
  -- queued, building, ready, failed or skipped.
  status TEXT NOT NULL,
  error TEXT,
  -- A JSON array.
  warnings TEXT NOT NULL DEFAULT '[]',
  log TEXT,
  -- SHA-256 of the token the sandbox reports with.
  token_hash TEXT,
  -- Whether it was built for someone trusted: a member, an agent, or a
  -- push. Protected secrets and variables, and every secret, reach only
  -- trusted builds and their apps.
  trusted INTEGER NOT NULL DEFAULT 0,
  build_seconds INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX deployments_by_repo ON deployments (repo_id, id);
CREATE INDEX deployments_by_status ON deployments (status, created_at);

-- What each workspace's apps used, per month: counted from Cloudflare's
-- analytics, and charged past the plan's allowance once the month is over.
CREATE TABLE meters (
  namespace TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  cpu_ms INTEGER NOT NULL DEFAULT 0,
  peak_apps INTEGER NOT NULL DEFAULT 0,
  build_seconds INTEGER NOT NULL DEFAULT 0,
  build_micros INTEGER NOT NULL DEFAULT 0,
  counted_at TEXT,
  -- When the month's usage past the allowance was charged.
  charged_at TEXT,
  PRIMARY KEY (namespace, month)
);
