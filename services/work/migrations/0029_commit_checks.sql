-- Checks on commits: check runs and the check suites that group them,
-- reported through the API by integrations, CI and tokens (GitHub's
-- Checks API). g1t Actions' jobs are read as check runs from the actions
-- service and are not kept here. The legacy `check_runs` table holds
-- issues' acceptance checks and is unrelated.

-- One reporter's check runs on one commit.
CREATE TABLE commit_check_suites (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  head_branch TEXT,
  -- Who reported it: a slug and a name for people.
  app_slug TEXT NOT NULL,
  app_name TEXT NOT NULL,
  -- queued, in_progress or completed, from its latest check runs.
  status TEXT NOT NULL,
  conclusion TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, head_sha, app_slug)
);

CREATE TABLE commit_check_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  -- queued, in_progress or completed.
  status TEXT NOT NULL,
  -- Once completed: success, failure, neutral, cancelled, skipped,
  -- timed_out or action_required.
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  details_url TEXT,
  external_id TEXT,
  -- Its report: Markdown summary and text under a title.
  title TEXT,
  summary TEXT,
  text TEXT,
  annotations_count INTEGER NOT NULL DEFAULT 0,
  -- The buttons it offers, as a JSON array of { label, description, identifier }.
  actions TEXT NOT NULL DEFAULT '[]',
  app_slug TEXT NOT NULL,
  app_name TEXT NOT NULL,
  -- The id of whoever reported it.
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX commit_check_runs_by_commit ON commit_check_runs (repo_id, head_sha);
CREATE INDEX commit_check_runs_by_suite ON commit_check_runs (suite_id);

-- What a check run says about lines of files, in the order it said it.
CREATE TABLE commit_check_annotations (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER,
  end_column INTEGER,
  -- notice, warning or failure.
  annotation_level TEXT NOT NULL,
  message TEXT NOT NULL,
  title TEXT,
  raw_details TEXT,
  PRIMARY KEY (run_id, seq)
);

-- A check run also stands as a status of its name, so required checks
-- and rulesets' required status checks are met by either alike. Such a
-- status names its check run here, and is listed as that check run only.
ALTER TABLE commit_statuses ADD COLUMN check_run_id TEXT;
