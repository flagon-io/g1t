-- What billing keeps of Stripe so reads never wait on it (stripe_sync.rs).

-- The workspace's saved card as Stripe last said, refreshed by card and
-- customer events and a weekly pass. card_synced_at NULL: never read, or
-- forgotten after g1t itself changed the card; the next read asks Stripe.
ALTER TABLE accounts ADD COLUMN card_brand TEXT;
ALTER TABLE accounts ADD COLUMN card_last4 TEXT;
ALTER TABLE accounts ADD COLUMN card_exp_month INTEGER;
ALTER TABLE accounts ADD COLUMN card_exp_year INTEGER;
ALTER TABLE accounts ADD COLUMN card_synced_at TEXT;

-- Card and customer events name the customer, not the workspace.
CREATE INDEX IF NOT EXISTS accounts_by_customer ON accounts (customer_id);

-- How far missed events have been replayed from Stripe's event list, per
-- key mode: every event created before `through` (Unix seconds) has been
-- seen, by its webhook or by the replay.
CREATE TABLE stripe_sync (
  mode TEXT PRIMARY KEY,
  through INTEGER NOT NULL,
  checked_at TEXT NOT NULL
);
