-- Statuses on commits: what a workflow run (or another tool) says about a
-- commit. A pull request whose head has a status that is pending or failed
-- waits, or is sent back, as for its acceptance checks.
CREATE TABLE commit_statuses (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  -- What reported it, such as "CI / push".
  context TEXT NOT NULL,
  -- pending, success, failure or error.
  state TEXT NOT NULL,
  description TEXT,
  target_url TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha, context)
);
