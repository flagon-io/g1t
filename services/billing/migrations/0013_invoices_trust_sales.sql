-- Real invoices, trust that is hard to game, and sales records.

-- Payments: which kind of card paid (prepaid cards never raise the
-- limit), and whether the payment was disputed (never counts again).
ALTER TABLE ledger ADD COLUMN funding TEXT;
ALTER TABLE ledger ADD COLUMN disputed INTEGER NOT NULL DEFAULT 0;

-- The owners chose to use everything available, with no limit of their
-- own. Without it and without spend_limit_micros, the default applies.
ALTER TABLE limits ADD COLUMN spend_limit_full INTEGER NOT NULL DEFAULT 0;

-- A workspace's invoices from g1t: one when each month closes, and one
-- each time it is charged near its limit. Itemised at Stripe, charged to
-- the card on file, and kept in Stripe's billing page with a PDF.
CREATE TABLE workspace_invoices (
  invoice_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- month or threshold.
  reason TEXT NOT NULL,
  -- YYYY-MM for a month, the date for a threshold.
  period TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  -- paid, open, failed or void.
  status TEXT NOT NULL,
  hosted_url TEXT,
  pdf_url TEXT,
  -- Usage up to here is on this invoice.
  through_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX workspace_invoices_by_workspace ON workspace_invoices (workspace, created_at);

CREATE TABLE workspace_invoice_lines (
  invoice_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  PRIMARY KEY (invoice_id, position)
);

-- What staff are doing about a workspace.
CREATE TABLE sales_records (
  workspace TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'none',
  owner TEXT,
  next_step TEXT,
  next_at TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sales_notes (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  text TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sales_notes_by_workspace ON sales_notes (workspace, created_at);
