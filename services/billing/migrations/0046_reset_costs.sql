-- What a testing reset wiped that g1t really paid for (src/reset.rs). The
-- model calls and Cloudflare usage behind a reset workspace's ledger still
-- happened: AI Gateway and Cloudflare's bill still show them. The reset
-- keeps their cost here, per day and product, before it deletes the
-- ledger, and the costs run counts it as given away on purpose (why
-- "testing resets"), so drift and the statement keep adding up.
--
-- One row per day and bucket the workspace had cost on, and one row for
-- the reset itself (bucket '', nothing in it) so every reset is on record
-- even when it wiped nothing g1t paid for. reset_at is the same instant as
-- the reset's admin_actions entry. Never wiped by a reset; moved by a
-- rename.
CREATE TABLE IF NOT EXISTS reset_costs (
  workspace TEXT NOT NULL,
  -- The UTC day the wiped usage was charged on.
  day TEXT NOT NULL,
  -- g1t's product (revenue_map's bucket; models for agent runs), or ''
  -- for the reset's own row.
  bucket TEXT NOT NULL,
  -- What g1t paid for it: the ledger's cost (a workspace's own model
  -- provider is none), and month-end meters' cost.
  cost_micros INTEGER NOT NULL,
  -- What it was valued at, at price, as the reconciliation valued it.
  value_micros INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  reset_by TEXT NOT NULL,
  PRIMARY KEY (workspace, day, bucket, reset_at)
);
CREATE INDEX IF NOT EXISTS reset_costs_by_day ON reset_costs (day);

-- Given away, the new why: usage a testing reset wiped.
ALTER TABLE margin_days ADD COLUMN given_reset_micros INTEGER NOT NULL DEFAULT 0;
