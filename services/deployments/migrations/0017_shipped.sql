-- What went live, and when (src/shipped.ts): when a production deployment
-- succeeds (`deployment_status.created` with `success`, for a g1t.page
-- build or one reported by a workflow or the API), the commits it shipped
-- are written down: those in
-- its commit's history not shipped before. A commit's first production
-- deployment is the one that took it live, so Home can say "Live 9 min
-- after merge" without working anything out on page load.

-- Each production deployment walked, once, however often its event comes.
-- The first a repository has is when recording began: a change that landed
-- before it is matched to the first production deployment after it instead.
CREATE TABLE shipped_walks (
  deployment_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  environment TEXT NOT NULL,
  -- RFC 3339: when it went live.
  deployed_at TEXT NOT NULL,
  -- How many commits it shipped that no deployment had before.
  commits INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX shipped_walks_by_repo ON shipped_walks (repo_id, deployed_at);

-- Each commit's first production deployment.
CREATE TABLE shipped_commits (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  -- Where the deployment is on the site: its page, or its workflow run.
  url TEXT,
  PRIMARY KEY (repo_id, sha)
);
