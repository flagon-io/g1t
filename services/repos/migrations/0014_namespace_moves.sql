-- Moving a repository from one git store namespace to another
-- (src/moves.rs; docs/ARTIFACTS.md, R7). Additive; nothing is backfilled,
-- and nothing moves until an operator asks.
--
-- writes_paused_until: milliseconds since the epoch. Until then nothing
--   writes to the repository: pushes wait up to 20 seconds for it to pass,
--   then are told to try again; merges, commits from the web and handed-out
--   push credentials the same. Set while a move copies the repository and
--   its pull requests' working copies, cleared when it ends either way, and
--   it passes on its own should a move die half way.
-- writes_paused_for: why, in words (`moving to g1t-us-1`).
ALTER TABLE repos ADD COLUMN writes_paused_until INTEGER;
ALTER TABLE repos ADD COLUMN writes_paused_for TEXT;

-- One row per move asked for. The hourly sweep (`23 * * * *`) runs the
-- queued ones, oldest first, one at a time.
--
-- status: queued | moving | moved | failed | cleaned | diverged.
--   moved: the repository reads and writes in its new namespace; the copy
--   in the old one is kept MOVE_KEEP_DAYS (7) in case of a rollback, then
--   deleted (cleaned). diverged: the old copy's refs changed after the
--   move (a push that slipped past the pause), so it is kept and an
--   operator reconciles it.
-- to_namespace: where it goes.
-- requested_by: who asked, in words.
-- note: the last thing that happened (why it waits, why it failed).
CREATE TABLE repo_moves (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  to_namespace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by TEXT,
  queued_ms INTEGER NOT NULL,
  started_ms INTEGER,
  finished_ms INTEGER,
  cleaned_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX repo_moves_queue ON repo_moves (status, queued_ms);
-- At most one move in hand per repository.
CREATE UNIQUE INDEX repo_moves_active ON repo_moves (repo_id) WHERE status IN ('queued', 'moving');

-- What each move copied: the repository and each of its pull requests'
-- working copies, from one key to another, with every ref as copied.
--
-- name: the key's name without its namespace. A name with a copy not yet
--   cleaned stays taken (registry.rs `claim_store_key`), so a new
--   repository never adopts an old copy left behind.
-- refs: JSON object, ref name to object, as copied; the old copy is
--   deleted only while it still says the same.
CREATE TABLE repo_move_copies (
  move_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  name TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '{}',
  cleaned_ms INTEGER,
  PRIMARY KEY (move_id, repo_id)
);
CREATE INDEX repo_move_copies_name ON repo_move_copies (name) WHERE cleaned_ms IS NULL;
