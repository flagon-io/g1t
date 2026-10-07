-- Cloudflare's subscriptions (Workers Paid, add-ons), as last read from
-- Cloudflare: what g1t pays each month whatever it uses. One row; detail
-- is each subscription's name and monthly micros, as JSON.
CREATE TABLE IF NOT EXISTS cf_subscriptions (
  id TEXT PRIMARY KEY,
  monthly_micros INTEGER NOT NULL,
  detail TEXT NOT NULL,
  read_at TEXT NOT NULL
);
