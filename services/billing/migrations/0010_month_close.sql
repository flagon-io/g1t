-- Closing each month: what a workspace with a card on file owed when the
-- month ended, charged to that card. Once per workspace per month. See
-- `close_months` in src/limits.rs.
CREATE TABLE month_closes (
  workspace TEXT NOT NULL,
  -- YYYY-MM, the month that closed.
  month TEXT NOT NULL,
  -- paid, failed, nothing (owed nothing) or skipped (comped, or on an
  -- enterprise, which is invoiced).
  status TEXT NOT NULL,
  amount_micros INTEGER NOT NULL DEFAULT 0,
  payment_id TEXT,
  error TEXT,
  closed_at TEXT NOT NULL,
  PRIMARY KEY (workspace, month)
);
