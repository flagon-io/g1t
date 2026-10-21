-- Public storage reservations, one row per write that holds one
-- (public_storage.rs). `repos.storage_reserved_bytes` (0021) stays the
-- figure admission adds up; each row says which operation holds how much
-- of it, since when, and until when it may run, so staff can tell an
-- interrupted write from one still in flight and release only what is
-- provably abandoned (`admin_storage_holds`, `admin_release_storage_hold`).
-- Only adds: code that predates it keeps adding to and taking from
-- `storage_reserved_bytes` without rows, which reads as "unledgered".
--
-- root_id: the repository charged (a working copy's charges its root's).
-- target_id: the repository written; a fork's own id for a fork.
-- operation: push, commit, merge, queue, update, land, sync, import, fork.
-- actor_id: who asked, when known.
-- bytes: reserved now; a streamed copy grows its row chunk by chunk.
-- grant_id: the latest grant, so admission and the sum move together.
-- state: `held` while the operation runs; `ended` once it stopped without
--   knowing whether the store took the write (a push the store answered
--   with an error), so nothing of it can still arrive.
-- created_ms, lease_until_ms: when it was made and the moment the
--   operation stops sending to the store, whatever happens (milliseconds).
-- ended_ms, outcome, refs: when and how an `ended` one ended, and the refs
--   it asked for as JSON `[[ref, new], ...]`, for inspection.
CREATE TABLE storage_reservations (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_id TEXT,
  bytes INTEGER NOT NULL,
  grant_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'held',
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  outcome TEXT,
  refs TEXT
);
CREATE INDEX storage_reservations_root ON storage_reservations (root_id);

-- When rows started being written: every byte of `storage_reserved_bytes`
-- without a row was reserved by code older than this.
CREATE TABLE storage_ledger_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL,
  started_ms INTEGER NOT NULL
);
INSERT INTO storage_ledger_epoch (id, started_at, started_ms)
  VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));

-- A native fork's copy lock says when it was taken and until when the
-- copy may run. Null on locks taken by older code.
ALTER TABLE storage_copy_locks ADD COLUMN created_ms INTEGER;
ALTER TABLE storage_copy_locks ADD COLUMN lease_until_ms INTEGER;

-- Every reservation or copy lock staff released, with the evidence it was
-- abandoned. Never updated or deleted.
--
-- kind: `reservation` (one row above), `unledgered` (bytes older code
--   reserved without a row) or `copy_lock`.
-- root_id: the repository whose reservation or lock it was (a copy lock's
--   source). target_id: the repository written (a copy's destination).
-- held_since: RFC 3339, when it was taken; null for unledgered bytes.
-- evidence: JSON, what the inspection found, upstream included.
CREATE TABLE storage_recoveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  root_id TEXT NOT NULL,
  target_id TEXT,
  reservation_id TEXT,
  operation TEXT,
  actor_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  held_since TEXT,
  evidence TEXT NOT NULL,
  staff TEXT NOT NULL,
  reason TEXT NOT NULL,
  released_at TEXT NOT NULL
);
CREATE INDEX storage_recoveries_root ON storage_recoveries (root_id);
CREATE INDEX storage_recoveries_reservation ON storage_recoveries (reservation_id) WHERE reservation_id IS NOT NULL;
