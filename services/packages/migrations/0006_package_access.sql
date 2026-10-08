-- A package's own settings beside its repository's: who has a role on it,
-- whether a linked one takes its repository's roles, which repositories'
-- workflows may use it, and packages and versions deleted but restorable
-- for 30 days (docs: guides/packages).

-- 1: a linked package takes its repository's roles, and its own grants add
-- to them. 0: only its own grants and the workspace's owners.
ALTER TABLE packages ADD COLUMN inherit_access INTEGER NOT NULL DEFAULT 1;

-- Set when a package is deleted: gone from the registries and listings,
-- its name kept so nobody else takes it, until it is restored or the purge
-- removes it 30 days on. `deleted_by` is the username that deleted it.
ALTER TABLE packages ADD COLUMN deleted_at TEXT;
ALTER TABLE packages ADD COLUMN deleted_by TEXT;
CREATE INDEX packages_deleted ON packages (deleted_at) WHERE deleted_at IS NOT NULL;

-- The same for one version. Its files and tags stay until the purge, so a
-- restore brings it back whole; its version string cannot be published
-- again meanwhile.
ALTER TABLE versions ADD COLUMN deleted_at TEXT;
ALTER TABLE versions ADD COLUMN deleted_by TEXT;
CREATE INDEX versions_deleted ON versions (deleted_at) WHERE deleted_at IS NOT NULL;

-- People and teams with a role on a package: read pulls, write publishes,
-- admin deletes, restores and changes its settings.
CREATE TABLE package_access (
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  -- user or team.
  grantee_kind TEXT NOT NULL,
  -- usr_… or the team's id.
  grantee_id TEXT NOT NULL,
  -- The username, or the team's slug, as it was last seen.
  grantee_name TEXT NOT NULL,
  -- read, write or admin.
  role TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, grantee_kind, grantee_id)
);
CREATE INDEX package_access_grantee ON package_access (grantee_kind, grantee_id);

-- Repositories of the package's workspace whose workflow jobs' tokens may
-- use it, besides the repository it is linked to (which always may write).
CREATE TABLE package_actions_access (
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  -- Its name in the workspace, kept by repo.renamed.
  repo_name TEXT NOT NULL,
  -- read or write.
  role TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, repo_id)
);
CREATE INDEX package_actions_access_repo ON package_actions_access (repo_id);
