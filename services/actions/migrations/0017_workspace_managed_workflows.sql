-- A workspace's managed workflows (src/managed.rs): workflows its owners
-- add to its repositories, each run in every repository it targets as that
-- repository's own, under the path `managed/<name>.yml`. `source` is a copy
-- of the workflow file it was added from, taken when it was saved, so only
-- an owner changes what runs. `mode` is `required` (a repository's workflow
-- of the same `name:` is set aside, and no repository turns it off) or
-- `default` (a repository's workflow of the same name runs in its place,
-- and its admins can turn it off).
CREATE TABLE IF NOT EXISTS workspace_managed_workflows (
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  -- `owner/repo/path@ref`, as given.
  source_ref TEXT NOT NULL,
  source_repo_id TEXT NOT NULL,
  source_sha TEXT,
  source_private INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  -- Its `name:`, as repositories list it.
  workflow_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  -- JSON: names and patterns; empty is every repository.
  repositories TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (namespace, name)
);
