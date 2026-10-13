-- Payments made safe for live money.

-- Each dispute of a workspace's payment, as Stripe last said it stands:
-- open (the bank has not decided), won, or lost. Kept so an event that
-- arrives late or twice acts on where the dispute is now, and a lost one
-- takes its credit back once (the ledger's `dispute/<id>` entry).
CREATE TABLE IF NOT EXISTS disputes (
  dispute_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  -- open, won or lost.
  status TEXT NOT NULL,
  -- What a lost dispute took back off the balance (positive).
  reversed_micros INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS disputes_by_workspace ON disputes (workspace, status);

-- What lost disputes took back that the workspace has not paid again yet.
-- Its stop for a dispute lifts only once this is paid and no dispute is
-- open: a smaller, unrelated payment does not lift it.
ALTER TABLE limits ADD COLUMN dispute_owed_micros INTEGER NOT NULL DEFAULT 0;

-- month_closes.status gains 'retrying': the card processor did not answer,
-- or failed, while the month was closed. The next run tries again, those
-- tried longest ago first, rather than recording that nothing was owed.
