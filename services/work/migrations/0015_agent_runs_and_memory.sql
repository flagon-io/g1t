-- Every sandbox g1t starts for an agent (and for checks and the merge
-- queue): what it works on, step by step, what it cost and how it ended.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  -- The workspace's slug, for the fleet across its projects.
  workspace TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- "<owner>/<name>" when it started, for showing it.
  repo TEXT NOT NULL,
  number INTEGER,
  pull_id TEXT,
  title TEXT,
  -- implement, revise, review, answer, update, plan, checks, queue, mergecheck
  kind TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  -- queued, running, succeeded, failed, stopped
  status TEXT NOT NULL,
  step TEXT,
  -- JSON array of { at, text }, the latest 200.
  steps TEXT NOT NULL DEFAULT '[]',
  step_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  turns INTEGER,
  -- The sandbox's name, which stopping it needs.
  sandbox TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  started_by TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_runs_by_repo ON agent_runs (repo_id, created_at);
CREATE INDEX agent_runs_by_workspace ON agent_runs (workspace, created_at);
CREATE INDEX agent_runs_by_pull ON agent_runs (pull_id, created_at);
CREATE INDEX agent_runs_active ON agent_runs (status, created_at);

-- What agents and people learned that the next agent should know: about a
-- project (scope_key is its repository's id) or about the whole workspace
-- (scope_key is the workspace's slug).
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  -- For a project's memory: "<owner>/<name>", for showing it.
  repo TEXT,
  text TEXT NOT NULL,
  -- fact, convention, decision, gotcha
  kind TEXT NOT NULL,
  -- person, agent or run
  source_kind TEXT NOT NULL,
  source_run TEXT,
  source_repo TEXT,
  source_number INTEGER,
  created_by TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX memories_by_scope ON memories (scope, scope_key, pinned, last_used_at);
CREATE INDEX memories_by_workspace ON memories (workspace);
