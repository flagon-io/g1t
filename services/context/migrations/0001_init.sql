-- The context hub: a catalog of what each workspace builds and runs, built
-- by itself from its repositories, projects, deployments and integrations,
-- and the text search reads besides memory. Every timestamp is RFC 3339 UTC.

-- One thing in the catalog: a project, an app, an API, a package, a
-- language, an owner, an environment, an integration or a doc. Its id is a
-- hash of (workspace, kind, key), so rebuilding it is an upsert.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT,
  -- The project it belongs to; null for what the workspace shares.
  project_id TEXT,
  project TEXT,
  repo_id TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  -- JSON, by kind.
  data TEXT NOT NULL DEFAULT '{}',
  -- scan, projects, deployments or integrations.
  source TEXT NOT NULL,
  ref TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace, kind, key)
);
CREATE INDEX entities_by_project ON entities (workspace, project_id);
CREATE INDEX entities_by_kind ON entities (workspace, kind, name);

-- How two entities relate. `project_id` is the project whose rebuild wrote
-- it, so a rebuild replaces exactly its own.
CREATE TABLE relations (
  workspace TEXT NOT NULL,
  from_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  project_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (from_id, kind, to_id)
);
CREATE INDEX relations_to ON relations (to_id);
CREATE INDEX relations_by_project ON relations (project_id);
CREATE INDEX relations_by_workspace ON relations (workspace);

-- Text search reads besides the catalog: pieces of docs, issues and pull
-- requests. Its id is the one in the search index.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- doc, issue or pull.
  kind TEXT NOT NULL,
  entity_id TEXT,
  project_id TEXT,
  project TEXT,
  repo_id TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX items_by_workspace ON items (workspace, kind, updated_at);
CREATE INDEX items_by_entity ON items (entity_id);

-- Each file of a project read when its catalog was built: its blob, so an
-- unchanged file is never read again, and what it said.
CREATE TABLE files (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  -- JSON: the file's facts (src/extract.ts).
  facts TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);

-- When each project's catalog was last built, and from which commit.
CREATE TABLE scans (
  project_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  "commit" TEXT,
  tests INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL
);
CREATE INDEX scans_by_workspace ON scans (workspace);

-- A workspace's backfill: the catalog for every project and memory seeded
-- from docs and merged pull requests. One row per workspace, the latest.
CREATE TABLE backfills (
  workspace TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  by TEXT NOT NULL,
  projects INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  entities INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- What putting text in the search index used, per workspace and month.
CREATE TABLE usage (
  workspace TEXT NOT NULL,
  month TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, month)
);
