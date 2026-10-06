-- How sure g1t is of a change an agent made, worked out from what it can
-- observe (confidence.rs), and what the agent said of it itself. New tables
-- rather than new columns, so that running this again changes nothing.

-- The latest for each pull request g1t sees through.
CREATE TABLE IF NOT EXISTS pull_confidence (
  pull_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- low, medium or high.
  level TEXT NOT NULL,
  -- JSON: g1t_contracts::work::Confidence.
  detail TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pull_confidence_by_repo ON pull_confidence (repo_id, level);

-- For each agent run that made or revised a change: what its agent said of
-- its own work (self_level, uncertain_about) and, once worked out, how sure
-- g1t was of the change as the run left it (detail).
CREATE TABLE IF NOT EXISTS run_confidence (
  run_id TEXT PRIMARY KEY,
  pull_id TEXT,
  repo_id TEXT NOT NULL,
  self_level TEXT,
  -- JSON array of short phrases.
  uncertain_about TEXT NOT NULL DEFAULT '[]',
  -- JSON: g1t_contracts::work::Confidence.
  detail TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_confidence_by_pull ON run_confidence (pull_id);

-- A repository's choice about low-confidence changes. A missing row is the
-- default: ask a person before merging one.
CREATE TABLE IF NOT EXISTS confidence_rules (
  repo_id TEXT PRIMARY KEY,
  hold_low INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
