-- Stripe telling billing what happened, as it happens. See src/webhooks.rs.

-- The endpoint billing registered at Stripe, one per mode (test or live),
-- and the secret Stripe signs its events with. Made from sudo; the secret
-- is never shown anywhere.
CREATE TABLE stripe_webhooks (
  mode TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  url TEXT NOT NULL,
  -- Comma-separated event types.
  events TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every event handled, once: Stripe may send one more than once.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  -- handled, ignored, or what went wrong.
  outcome TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX stripe_events_by_time ON stripe_events (received_at);

-- Where an enterprise's invoices go.
ALTER TABLE billing_accounts ADD COLUMN billing_email TEXT;

-- One invoice per enterprise per month (or sooner, from sudo), itemised
-- by workspace. Paid on Stripe's hosted invoice page.
CREATE TABLE enterprise_invoices (
  invoice_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- YYYY-MM it closes, or 'now' for one sent from sudo.
  period TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  -- open, paid, overdue or void.
  status TEXT NOT NULL,
  hosted_url TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX enterprise_invoices_by_account ON enterprise_invoices (account_id, created_at);

CREATE TABLE enterprise_invoice_lines (
  invoice_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  PRIMARY KEY (invoice_id, workspace)
);
