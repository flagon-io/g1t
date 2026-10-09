-- Cloudflare's usage bill priced over its billing cycle, and money in only
-- when it is real. See src/cycle.rs, src/costs.rs and
-- docs/BILLING_OPERATIONS.md ("The billing cycle").

-- What Cloudflare's line itself said it cost (never its list cost, which
-- is before the included amounts), what of the quantity is past the
-- cycle's included amount, and where cost_usd came from: 'cloudflare',
-- 'list' (the list price past the included amount) or 'none' (no list
-- price known). Empty for lines that are not billable usage.
ALTER TABLE cost_lines ADD COLUMN billed_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE cost_lines ADD COLUMN billable_quantity REAL NOT NULL DEFAULT 0;
ALTER TABLE cost_lines ADD COLUMN basis TEXT NOT NULL DEFAULT '';

-- When the current billing cycle started, from the subscriptions' read
-- (current_period_start): the day of the month every cycle starts on.
ALTER TABLE cf_subscriptions ADD COLUMN cycle_start TEXT;

-- The last read of each source: what came back, to tell from sudo whether
-- it was all of it and in which units.
CREATE TABLE IF NOT EXISTS cost_reads (
  source TEXT PRIMARY KEY,
  read_at TEXT NOT NULL,
  since TEXT NOT NULL,
  until TEXT NOT NULL,
  rows INTEGER NOT NULL,
  pages INTEGER NOT NULL,
  consumed_rows INTEGER NOT NULL,
  pricing_only_rows INTEGER NOT NULL,
  costed_rows INTEGER NOT NULL
);

-- What workspaces were charged while payments were not live (Stripe's
-- test mode): given away, never money in.
ALTER TABLE margin_days ADD COLUMN given_unpaid_micros INTEGER NOT NULL DEFAULT 0;

-- The day payments went live: charges before it were not real money.
-- Empty until the daily run first sees live payments.
INSERT OR IGNORE INTO cost_settings (key, value, updated_at, updated_by) VALUES
  ('payments_live_since', '', '2026-10-09T00:00:00Z', 'migration');
