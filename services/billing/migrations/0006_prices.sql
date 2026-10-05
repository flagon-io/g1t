-- Prices that keep themselves current. See src/keeper.rs.

-- Which AI Gateway session a run's model requests went through, and what
-- the gateway priced them at once settled. A run is first charged what
-- the sandbox reported; settling corrects it to the gateway's figure.
ALTER TABLE runs ADD COLUMN session_id TEXT;
ALTER TABLE runs ADD COLUMN settled_at TEXT;
ALTER TABLE runs ADD COLUMN gateway_cost_micros INTEGER;

-- What each metered unit costs g1t, and the markup it is sold at. Price
-- is always cost × (100 + markup) / 100, so when a cost moves, the price
-- moves with it.
CREATE TABLE prices (
  meter TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  -- second, million requests, million CPU ms, app-month.
  unit TEXT NOT NULL,
  -- Millionths of a dollar per unit; fractions allowed.
  cost_micros REAL NOT NULL,
  markup_percent INTEGER NOT NULL,
  -- list (Cloudflare's published price) or cloudflare (what Cloudflare
  -- actually billed g1t, measured).
  source TEXT NOT NULL,
  checked_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('sandbox_second', 'Sandbox time', 'second', 21, 138, 'list', '2026-10-04T00:00:00Z'),
  ('build_second', 'Deploy builds', 'second', 21, 20, 'list', '2026-10-04T00:00:00Z'),
  ('app_requests', 'App requests', 'million requests', 300000, 20, 'list', '2026-10-04T00:00:00Z'),
  ('app_cpu', 'App CPU time', 'million CPU ms', 20000, 20, 'list', '2026-10-04T00:00:00Z'),
  ('app_month', 'Apps up past the plan', 'app-month', 20000, 20, 'list', '2026-10-04T00:00:00Z');

-- Every time a cost moved, and why: the public record of price changes.
CREATE TABLE price_changes (
  id TEXT PRIMARY KEY,
  meter TEXT NOT NULL,
  old_cost_micros REAL NOT NULL,
  new_cost_micros REAL NOT NULL,
  markup_percent INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX price_changes_by_time ON price_changes (created_at);

-- What Cloudflare billed g1t's account, as its usage API reports it, kept
-- as given so the measured costs can be checked.
CREATE TABLE cloudflare_usage (
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  service TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL NOT NULL,
  cost_usd REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (period_start, service, unit)
);
