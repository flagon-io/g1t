-- Purge work is committed with the destructive transaction, never after it.
-- A successful publish means delivery to the event bus, not consumer completion.
CREATE TABLE purge_jobs (
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'workspace')),
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (subject_id, target)
);
CREATE INDEX purge_jobs_pending ON purge_jobs(completed_at, retry_at);

-- No FK: the case and minimal deletion ledger must survive account erasure.
CREATE TABLE erasure_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','completed','refused')),
  scope TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  closed_at TEXT
);
CREATE UNIQUE INDEX erasure_requests_open ON erasure_requests(user_id) WHERE closed_at IS NULL;

CREATE TABLE erasure_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  at TEXT NOT NULL,
  staff TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT NOT NULL
);
