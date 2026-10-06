-- g1t's GitHub App: installations recorded against workspaces, the
-- repositories brought across through them, and what the app's webhook
-- has delivered. Every timestamp is RFC 3339 UTC. See src/github.rs.

-- An installation of the app on a GitHub user or organization, recorded
-- against a workspace by one of its owners. One installation may serve
-- several workspaces.
CREATE TABLE github_installations (
  -- GitHub's installation id.
  id INTEGER NOT NULL,
  -- The workspace's slug.
  workspace TEXT NOT NULL,
  -- The GitHub account's login, and User or Organization.
  account TEXT NOT NULL,
  account_type TEXT NOT NULL,
  -- all or selected.
  repository_selection TEXT NOT NULL,
  -- Where its repositories are chosen on GitHub.
  settings_url TEXT NOT NULL,
  suspended_at TEXT,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, workspace)
);
CREATE INDEX github_installations_by_workspace ON github_installations (workspace);

-- A g1t repository's tie to the GitHub repository it came from.
CREATE TABLE github_repos (
  repo_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- workspace/name on g1t.
  repo TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  -- GitHub's numeric id, which survives renames and transfers.
  github_repo_id INTEGER NOT NULL,
  -- owner/name on GitHub, kept current by the repository webhook.
  full_name TEXT NOT NULL,
  -- import (copied once), mirror (g1t follows GitHub) or push (GitHub
  -- follows g1t).
  mode TEXT NOT NULL,
  synced_at TEXT,
  last_error TEXT,
  issues_imported INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX github_repos_by_github ON github_repos (github_repo_id);
CREATE INDEX github_repos_by_workspace ON github_repos (workspace);

-- Webhook deliveries seen, by X-GitHub-Delivery, so a retry is acted on
-- once. Kept a week.
CREATE TABLE github_deliveries (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  received_ms INTEGER NOT NULL
);

-- Installation access tokens, sealed under INTEGRATIONS_KEY, used until
-- five minutes before they expire. Opaque text of any length.
CREATE TABLE github_tokens (
  installation_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
