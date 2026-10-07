-- Nightly backups of every repository, outside the git store
-- (src/backups.rs; docs/ARTIFACTS.md, R11). One row per repository that
-- has been queued at least once: its last backup, and the job in hand.
--
-- status: idle | queued | running. The nightly cron queues the
--   repositories whose refs moved since their last backup; the runner's
--   sweep claims queued ones (`claim_backups`) and starts a sandbox for
--   each; the sandbox's `backup_complete` or `backup_fail` makes it idle
--   again, or queued for another try.
-- queued_ms, claimed_ms: milliseconds since the epoch. A job running past
--   its lease (3 hours) goes back in the queue.
-- attempts: tries tonight; past 3 it waits for the next night.
-- last_error: why the last try failed.
--
-- The job in hand, while running:
-- job_id, token_hash: the job, and the SHA-256 of the token its sandbox
--   holds (the only credential it has for g1t).
-- target_version: the repository's refs_version when the clone began,
--   which the backup is recorded at once done.
-- backed_from_ms: when that was.
-- store_key: the repository's name in the git store, for its meters.
-- upload_key, upload_id: the bundle's key in storage, and its multipart
--   upload. upload_kind: full | incr. upload_entry: the entry's id in the
--   manifest (`20261006T025300Z`).
-- prerequisites: JSON array, the commits the bundle leaves out.
--
-- The last backup:
-- refs_version: the refs_version it was cut at. The repository is due
--   again once its own goes past this, or once a credential that can push
--   is handed out after backed_up_ms (repos.refs_open_until).
-- backed_up_ms: when its clone began.
-- tips: JSON object, every ref it held by name: the next bundle's
--   prerequisites. The manifest in storage says the same, and is what a
--   restore reads.
-- last_entry: its id in the manifest. When the manifest's last entry is
--   another, the next backup is full.
CREATE TABLE repo_backups (
  repo_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',
  queued_ms INTEGER,
  claimed_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  job_id TEXT,
  token_hash TEXT,
  target_version INTEGER,
  backed_from_ms INTEGER,
  store_key TEXT,
  upload_key TEXT,
  upload_id TEXT,
  upload_kind TEXT,
  upload_entry TEXT,
  prerequisites TEXT,
  refs_version INTEGER,
  backed_up_ms INTEGER,
  tips TEXT,
  last_entry TEXT
);
CREATE INDEX repo_backups_queue ON repo_backups (status, queued_ms);
CREATE UNIQUE INDEX repo_backups_job ON repo_backups (job_id) WHERE job_id IS NOT NULL;

-- A backup's clone is metered as `internal.git.backup_fetch`: an operation
-- on g1t's own bill, never on a workspace's.
INSERT INTO operation_mapping (meter, cost_operations, billable_operations, note, updated_at) VALUES
  ('internal.git.backup_fetch', 1, 0, 'Nightly backup clone (R11): g1t''s cost, not the workspace''s', '2026-10-06T00:00:00Z');
