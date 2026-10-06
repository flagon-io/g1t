-- What Cloudflare charges g1t, reconciled against what g1t counted and
-- charged, and prices kept as versions. See src/costs.rs, src/margin.rs,
-- src/pricing.rs and docs/BILLING_OPERATIONS.md.
--
-- Safe to run again: every table and index is IF NOT EXISTS and every
-- seed INSERT OR IGNORE. The one ALTER is applied once, by D1's
-- migration tracking, like those before it.

-- Cloudflare's bill, a line per day, source, product and meter. Reading a
-- day again replaces its lines.
CREATE TABLE IF NOT EXISTS cost_lines (
  day TEXT NOT NULL,
  -- billable_usage (the FOCUS billable-usage API) or artifacts_events
  -- (GraphQL artifactsEventsAdaptiveGroups).
  source TEXT NOT NULL,
  -- Cloudflare's product and the service within it, slugged:
  -- containers / container_memory_per_gib_second, artifacts / events_push.
  product TEXT NOT NULL,
  meter TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL NOT NULL,
  -- What g1t pays, in dollars.
  cost_usd REAL NOT NULL,
  raw_name TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (day, source, product, meter)
);
CREATE INDEX IF NOT EXISTS cost_lines_by_product ON cost_lines (product, meter, day);

-- Which of g1t's products each Cloudflare line is a cost of. Data, so a
-- new or renamed Cloudflare meter is mapped without a deploy. A line no
-- row claims is "unmapped": a leak until someone maps it.
CREATE TABLE IF NOT EXISTS cost_map (
  product TEXT NOT NULL,
  -- A meter prefix, or * for every meter of the product.
  meter TEXT NOT NULL,
  -- g1t's product: sandboxes, deployments, git, repo_storage,
  -- actions_cache, embeddings, security, domains, models, platform.
  bucket TEXT NOT NULL,
  -- The price book meter whose cost the line measures, if any.
  price_meter TEXT,
  -- g1t's own count of the same units (own_counts.meter), to compare.
  own_meter TEXT,
  -- When 1, a unit of the price meter costs Cloudflare's rate times how
  -- many of Cloudflare's units each of g1t's took (git operations).
  scale_to_own INTEGER NOT NULL DEFAULT 0,
  drift_percent REAL NOT NULL DEFAULT 10,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (product, meter)
);

INSERT OR IGNORE INTO cost_map (product, meter, bucket, price_meter, own_meter, scale_to_own, note, updated_at, updated_by) VALUES
  ('containers', '*', 'sandboxes', 'sandbox_second', NULL, 0, 'Sandboxes, workflow jobs and deploy builds', '2026-10-06T00:00:00Z', 'migration'),
  ('durable_objects', 'durable_objects_compute_duration', 'sandboxes', 'sandbox_base_second', NULL, 0, 'The Durable Object behind each container', '2026-10-06T00:00:00Z', 'migration'),
  ('durable_objects', '*', 'platform', NULL, NULL, 0, 'Durable Objects g1t runs itself', '2026-10-06T00:00:00Z', 'migration'),
  ('workers', 'workers_for_platforms', 'deployments', 'app_requests', NULL, 0, 'Apps people deploy', '2026-10-06T00:00:00Z', 'migration'),
  ('workers', '*', 'platform', NULL, NULL, 0, 'g1t''s own Workers', '2026-10-06T00:00:00Z', 'migration'),
  ('workers_for_platforms', '*', 'deployments', 'app_requests', NULL, 0, 'Apps people deploy', '2026-10-06T00:00:00Z', 'migration'),
  ('artifacts', 'events_', 'git', NULL, 'git_operations', 0, 'What Artifacts counted, by event type (no cost)', '2026-10-06T00:00:00Z', 'migration'),
  ('artifacts', 'artifacts_storage', 'repo_storage', 'private_storage', NULL, 0, 'Repositories, public and private', '2026-10-06T00:00:00Z', 'migration'),
  ('artifacts', 'storage', 'repo_storage', 'private_storage', NULL, 0, 'Repositories, public and private', '2026-10-06T00:00:00Z', 'migration'),
  ('artifacts', '*', 'git', 'git_operations', 'git_operations', 1, 'Operations: what counts is not documented yet', '2026-10-06T00:00:00Z', 'migration'),
  ('r2', '*', 'actions_cache', 'actions_cache', NULL, 0, 'The actions cache and logs', '2026-10-06T00:00:00Z', 'migration'),
  ('workers_ai', '*', 'embeddings', 'embedding_tokens', NULL, 0, 'Search embeddings', '2026-10-06T00:00:00Z', 'migration'),
  ('vectorize', '*', 'embeddings', NULL, NULL, 0, 'The search index', '2026-10-06T00:00:00Z', 'migration'),
  ('cloudflare_for_saas', '*', 'domains', 'custom_domain_month', NULL, 0, 'Custom hostnames', '2026-10-06T00:00:00Z', 'migration'),
  ('ssl_for_saas', '*', 'domains', 'custom_domain_month', NULL, 0, 'Custom hostnames', '2026-10-06T00:00:00Z', 'migration'),
  ('d1', '*', 'platform', NULL, NULL, 0, 'g1t''s databases', '2026-10-06T00:00:00Z', 'migration'),
  ('workers_kv', '*', 'platform', NULL, NULL, 0, '', '2026-10-06T00:00:00Z', 'migration'),
  ('queues', '*', 'platform', NULL, NULL, 0, 'The event bus', '2026-10-06T00:00:00Z', 'migration'),
  ('email', '*', 'platform', NULL, NULL, 0, 'Transactional email', '2026-10-06T00:00:00Z', 'migration'),
  ('browser_rendering', '*', 'platform', NULL, NULL, 0, 'Link previews and screenshots', '2026-10-06T00:00:00Z', 'migration'),
  ('workers_paid', '*', 'platform', NULL, NULL, 0, 'The Workers Paid subscription', '2026-10-06T00:00:00Z', 'migration');

-- What pays for each of g1t's products: ledger tasks (and month-end
-- sources) by the key the statement groups them under. Anything not
-- listed is an agent's run on a model, bucket "models".
CREATE TABLE IF NOT EXISTS revenue_map (
  key TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

INSERT OR IGNORE INTO revenue_map (key, bucket, updated_at, updated_by) VALUES
  ('sandbox', 'sandboxes', '2026-10-06T00:00:00Z', 'migration'),
  ('self_hosted', 'sandboxes', '2026-10-06T00:00:00Z', 'migration'),
  ('builds', 'sandboxes', '2026-10-06T00:00:00Z', 'migration'),
  ('deployments', 'deployments', '2026-10-06T00:00:00Z', 'migration'),
  ('domains', 'domains', '2026-10-06T00:00:00Z', 'migration'),
  ('git', 'git', '2026-10-06T00:00:00Z', 'migration'),
  ('storage', 'repo_storage', '2026-10-06T00:00:00Z', 'migration'),
  ('cache', 'actions_cache', '2026-10-06T00:00:00Z', 'migration'),
  ('context', 'embeddings', '2026-10-06T00:00:00Z', 'migration'),
  ('security', 'security', '2026-10-06T00:00:00Z', 'migration'),
  ('plan', 'platform', '2026-10-06T00:00:00Z', 'migration');

-- How many of a price meter's units each raw meter is, for meters whose
-- definition is not settled: git_operations from Artifacts' raw counts
-- (the repos service's artifacts_usage). Changing a weight changes what
-- is counted from then on, never what was.
CREATE TABLE IF NOT EXISTS billable_units (
  price_meter TEXT NOT NULL,
  raw_meter TEXT NOT NULL,
  weight REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (price_meter, raw_meter)
);

-- g1t's own counts, a day per meter per workspace, for the comparison.
CREATE TABLE IF NOT EXISTS own_counts (
  day TEXT NOT NULL,
  meter TEXT NOT NULL,
  workspace TEXT NOT NULL,
  quantity REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (day, meter, workspace)
);

-- What a month-end source (git, storage, scans, …) had come to by the
-- end of each day, so its revenue can be told by the day.
CREATE TABLE IF NOT EXISTS pending_days (
  day TEXT NOT NULL,
  workspace TEXT NOT NULL,
  source TEXT NOT NULL,
  cost_micros INTEGER NOT NULL,
  charge_micros INTEGER NOT NULL,
  PRIMARY KEY (day, workspace, source)
);

-- The reconciliation, a row per day and product. Recomputed for the
-- days read again, so it follows Cloudflare's restatements.
CREATE TABLE IF NOT EXISTS margin_days (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  cf_cost_micros INTEGER NOT NULL,
  own_cost_micros INTEGER NOT NULL,
  value_micros INTEGER NOT NULL,
  cash_micros INTEGER NOT NULL,
  cf_quantity REAL NOT NULL,
  own_quantity REAL NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (day, bucket)
);

-- What each workspace cost g1t, Cloudflare's costs shared out by g1t's
-- own meters, against what it paid.
CREATE TABLE IF NOT EXISTS workspace_costs (
  day TEXT NOT NULL,
  workspace TEXT NOT NULL,
  bucket TEXT NOT NULL,
  cost_micros INTEGER NOT NULL,
  revenue_micros INTEGER NOT NULL,
  PRIMARY KEY (day, workspace, bucket)
);
CREATE INDEX IF NOT EXISTS workspace_costs_by_workspace ON workspace_costs (workspace, day);

-- Drift found on the last run: counts, costs and leaks.
CREATE TABLE IF NOT EXISTS cost_drift (
  bucket TEXT NOT NULL,
  kind TEXT NOT NULL,
  ours REAL NOT NULL,
  cloudflare REAL NOT NULL,
  delta_percent REAL,
  detail TEXT NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (bucket, kind)
);

-- Margin alerts: open while the condition lasts. Emailed when opened and
-- a week later if still open.
CREATE TABLE IF NOT EXISTS margin_alerts (
  id TEXT PRIMARY KEY,
  -- margin (a product's margin under the floor), overall (all of g1t),
  -- leak, drift, workspace (a workspace costing more than it pays).
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  since TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  emailed_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS margin_alerts_open ON margin_alerts (resolved_at, kind, subject);

-- The actions cache is charged (on the plan only) at what R2 charges g1t
-- to store it, $0.015 a GB-month (services/actions, CACHE_MICROS_PER_GB_MONTH):
-- in the price book like everything else, so the pricing page reads it.
INSERT OR IGNORE INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at)
VALUES ('actions_cache', 'Actions cache storage', 'GB-month', 15000, 20, 'list', '2026-10-06T00:00:00Z');
INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at)
VALUES ('prc_actions_cache', 'actions_cache', 15000, 15000, 20,
        'Now in the price book: what the actions cache stores, at R2''s price, on the plan only', '2026-10-06T00:00:00Z');

-- Every price as versions. `prices` is the version in force; a version
-- is never changed once written. A rise takes effect after notice.
CREATE TABLE IF NOT EXISTS price_versions (
  id TEXT PRIMARY KEY,
  meter TEXT NOT NULL,
  version INTEGER NOT NULL,
  cost_micros REAL NOT NULL,
  markup_percent INTEGER NOT NULL,
  effective_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- keeper, reconciler, staff email, or migration.
  created_by TEXT NOT NULL,
  proposal_id TEXT,
  created_at TEXT NOT NULL,
  -- When `prices` took it on; NULL while it waits for its date.
  applied_at TEXT,
  UNIQUE (meter, version)
);
CREATE INDEX IF NOT EXISTS price_versions_due ON price_versions (applied_at, effective_at);

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at)
SELECT 'pv_' || meter || '_1', meter, 1, cost_micros, markup_percent, updated_at,
       'The price book when prices became versions', 'migration', updated_at, updated_at
FROM prices;

-- Changes the reconciler measured, waiting for staff or applied.
CREATE TABLE IF NOT EXISTS price_proposals (
  id TEXT PRIMARY KEY,
  meter TEXT NOT NULL,
  current_cost_micros REAL NOT NULL,
  proposed_cost_micros REAL NOT NULL,
  reason TEXT NOT NULL,
  -- keeper or reconciler.
  source TEXT NOT NULL,
  -- 1 when the measurement is far off the current cost.
  suspect INTEGER NOT NULL DEFAULT 0,
  -- open, applied (automatically), approved, rejected, superseded.
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT,
  version_id TEXT
);
CREATE INDEX IF NOT EXISTS price_proposals_by_status ON price_proposals (status, meter);

-- Owners told of a coming rise, once per version per workspace.
CREATE TABLE IF NOT EXISTS price_notices (
  version_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (version_id, workspace)
);

-- The guardrails, set in sudo.
CREATE TABLE IF NOT EXISTS cost_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

INSERT OR IGNORE INTO cost_settings (key, value, updated_at, updated_by) VALUES
  ('auto_apply', 'true', '2026-10-06T00:00:00Z', 'migration'),
  ('auto_apply_percent', '25', '2026-10-06T00:00:00Z', 'migration'),
  ('notice_days', '14', '2026-10-06T00:00:00Z', 'migration'),
  ('margin_floor_percent', '10', '2026-10-06T00:00:00Z', 'migration'),
  ('alert_days', '3', '2026-10-06T00:00:00Z', 'migration'),
  ('min_daily_cost_micros', '100000', '2026-10-06T00:00:00Z', 'migration'),
  ('anomaly_factor', '1', '2026-10-06T00:00:00Z', 'migration'),
  ('anomaly_floor_micros', '1000000', '2026-10-06T00:00:00Z', 'migration');

-- The price version each charge was made at, where one applies.
ALTER TABLE ledger ADD COLUMN price_version TEXT;
