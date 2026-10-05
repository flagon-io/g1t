-- Usage this month that is not on the ledger yet, such as app traffic
-- past the Deployments plan, which is charged when the month closes. It
-- counts toward the workspace's limit as it happens. Replaced on each
-- report; see `note_pending` in src/limits.rs.
CREATE TABLE pending_usage (
  workspace TEXT NOT NULL,
  -- deployments.
  source TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  -- What it will be charged, in millionths of a dollar.
  charge_micros INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, source, month)
);
