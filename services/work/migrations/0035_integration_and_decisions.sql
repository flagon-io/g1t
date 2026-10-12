-- Decision records: a structured reason for the work being the way it is,
-- with how sure it is: claimed (someone said so), tested (a check or a
-- combination of pull requests proved it) or approved (a person approved).
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue INTEGER,
  pull INTEGER,
  session_id TEXT,
  -- Who recorded it, by account id and username; NULL for g1t itself.
  actor TEXT,
  actor_name TEXT,
  -- proposal, claim, integration_failure, integration_passed, fix,
  -- approval, merge or note.
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- JSON object: commit, check, combination, other_pulls, suspects.
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX decisions_by_issue ON decisions (repo_id, issue, created_at);
CREATE INDEX decisions_by_pull ON decisions (repo_id, pull, created_at);

-- A combined state that failed while entries ahead of it were still being
-- tested waits for them before it is blamed: what failed, as JSON.
ALTER TABLE queue_entries ADD COLUMN held TEXT;
-- What the queue worked out about a failure: the suspects, and the
-- smaller combinations being built to narrow them down, as JSON.
ALTER TABLE queue_entries ADD COLUMN diagnosis TEXT;
-- 1 for an entry the queue took out: it rejoins once a new commit's
-- checks pass.
ALTER TABLE queue_entries ADD COLUMN requeue INTEGER NOT NULL DEFAULT 0;

-- Smaller combinations built to find which entries ahead a failed entry
-- breaks with: the default branch, `subset` (the entries ahead, as JSON)
-- and the entry. Built and checked as the queue's own states are, on
-- g1t-queue/<id>, and never landed.
CREATE TABLE queue_probes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  subset TEXT NOT NULL,
  -- waiting, testing, passed, failed or stopped.
  state TEXT NOT NULL,
  token_hash TEXT,
  combined_commit TEXT,
  error TEXT,
  tested_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX queue_probes_by_repo ON queue_probes (repo_id, state);
CREATE INDEX queue_probes_by_commit ON queue_probes (repo_id, combined_commit);
