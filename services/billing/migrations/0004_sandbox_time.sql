-- Sandbox time each workspace used, by calendar month (UTC), so that the
-- free minutes are counted before any second is charged.
CREATE TABLE sandbox_months (
  workspace TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, month)
);

CREATE INDEX IF NOT EXISTS ledger_by_reference ON ledger (reference);
