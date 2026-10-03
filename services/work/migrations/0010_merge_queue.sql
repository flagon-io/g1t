-- Merging through a queue: each pull request is tested together with the
-- ones ahead of it, and only a combination that passed lands.
ALTER TABLE repo_settings ADD COLUMN merge_queue INTEGER NOT NULL DEFAULT 0;

CREATE TABLE queue_entries (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- waiting, testing, passed, failed, landed or removed.
  state TEXT NOT NULL,
  -- Who merged it into the queue, as JSON: a member, or g1t by policy.
  enqueued_by TEXT NOT NULL,
  keep_issue_open INTEGER NOT NULL DEFAULT 0,
  -- The pull request's head when its combined state was built.
  head_commit TEXT,
  -- The default branch's commit the combined state was built on.
  base_commit TEXT,
  -- The numbers of the pull requests merged ahead of it, as JSON.
  ahead TEXT,
  -- The tested state, pushed to the branch g1t-queue/<id>.
  combined_commit TEXT,
  results TEXT,
  error TEXT,
  -- Lets the sandbox testing it, and nothing else, report the result.
  token_hash TEXT,
  tested_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX queue_by_repo ON queue_entries (repo_id, state, created_at);
CREATE INDEX queue_by_pull ON queue_entries (pull_id, state);
