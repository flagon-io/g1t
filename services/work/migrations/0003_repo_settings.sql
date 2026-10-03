-- How a repository wants its pull requests handled. One row per repository
-- that has changed a setting; a missing row means the defaults.
CREATE TABLE repo_settings (
  repo_id TEXT PRIMARY KEY,
  -- Land a g1t agent's pull request without a person once it is ready:
  -- checks passed, approved by the reviewing agent, up to date.
  auto_merge INTEGER NOT NULL DEFAULT 0,
  -- Username of the member who last changed the settings.
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
