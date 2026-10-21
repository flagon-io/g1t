-- A staff release's line in sudo's audit log (billing's `admin_log`), kept
-- as an outbox (#315). The release batch writes one row per
-- `storage_recoveries` row, in the same transaction, so a release always
-- has its line to send; the repos service sends it right after, and the
-- hourly sweep sends any it could not, keyed by the recovery's id so
-- billing writes it once however often it is sent (storage_holds.rs).
--
-- Additive: a new table that only code written with it reads or writes.
-- Releases made before it have no row here: sudo wrote their lines itself.
CREATE TABLE storage_recovery_audits (
  recovery_id TEXT PRIMARY KEY,
  -- Where billing files it: the charged repository's workspace, or the
  -- allowlisted account (`storage`) when its row is gone.
  workspace TEXT,
  account TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- When billing confirmed it, and until then how often it was tried and
  -- what the last try answered.
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  tried_at TEXT,
  error TEXT
);
CREATE INDEX storage_recovery_audits_unsent ON storage_recovery_audits (created_at) WHERE sent_at IS NULL;
