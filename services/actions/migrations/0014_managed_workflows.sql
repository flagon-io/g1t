-- Managed workflows (src/managed.rs): workflows installed into a repository
-- without being committed to it, such as the one deployments install for a
-- project. Each runs under the path `managed/<name>.yml`; a workflow of the
-- same `name:` in the repository's own folder runs in its place.
CREATE TABLE IF NOT EXISTS managed_workflows (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  -- What installed it and keeps it: `deployments`, or a workspace's id.
  origin TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
);
