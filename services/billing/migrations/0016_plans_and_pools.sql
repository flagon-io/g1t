-- The Team plan, g1t's capped pools (trials and open source), the minimum
-- charge, and meters for what was free by accident: private storage,
-- search embeddings and security scans. See src/credits.rs.

-- What paid for a usage entry before it was charged: the Team plan's
-- monthly credit, the workspace's trial credit, or g1t's open-source
-- pool. `amount_micros` stays what the workspace is charged.
ALTER TABLE ledger ADD COLUMN credit_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN trial_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledger ADD COLUMN oss_micros INTEGER NOT NULL DEFAULT 0;

-- Monthly allowances, drawn down as usage comes in, and new each calendar
-- month (UTC):
--   team_credit    scope = workspace   Team credit used, in micros
--   build_seconds  scope = workspace   Deployments build seconds included
--   oss_pool       scope = ''          g1t's open-source pool, in micros
--   oss_repo       scope = owner/name  one public repository's share of it
CREATE TABLE allowance_use (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, scope, month)
);

-- Each workspace's one trial grant, made when it first uses something, out
-- of the month's pool (`TRIAL_MONTHLY_POOL_MICROS`).
CREATE TABLE trial_grants (
  workspace TEXT PRIMARY KEY,
  -- YYYY-MM of the pool it came from; 'legacy' for grants from before
  -- pools reset monthly, 'staff' for ones set in sudo. Only YYYY-MM
  -- grants count against a month's pool.
  month TEXT NOT NULL,
  granted_micros INTEGER NOT NULL,
  used_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX trial_grants_by_month ON trial_grants (month);

-- The free allowance that ended on a date becomes these grants, intact:
-- each workspace that used it keeps what it had left of its $1.
INSERT INTO trial_grants (workspace, month, granted_micros, used_micros, created_at)
SELECT workspace, 'legacy', 1000000, MIN(1000000, SUM(COALESCE(cost_micros, 0))), MIN(created_at)
FROM ledger
WHERE kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' AND COALESCE(task, '') NOT IN ('sandbox', 'deployments')
GROUP BY workspace
HAVING SUM(COALESCE(cost_micros, 0)) > 0;

-- Set per account in sudo: the Team plan without charge, and its share of
-- the pools (null: the default).
ALTER TABLE billing_accounts ADD COLUMN team_granted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN oss_repo_micros INTEGER;
ALTER TABLE billing_accounts ADD COLUMN trial_micros INTEGER;

-- Usage other services meter through the month (security scans, search
-- embeddings) and storage measured daily: what it cost g1t, and when
-- billing charged it once the month was over.
ALTER TABLE pending_usage ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_usage ADD COLUMN charged_at TEXT;
-- Months before this one were never charged, and are not now: charging
-- starts with this month.
UPDATE pending_usage SET charged_at = 'never: before metering'
WHERE source <> 'deployments' AND month < '2026-10';

-- What each workspace's private repositories held each day, and what was
-- free that day (more on Team).
CREATE TABLE storage_days (
  workspace TEXT NOT NULL,
  -- YYYY-MM-DD.
  day TEXT NOT NULL,
  private_bytes INTEGER NOT NULL,
  free_bytes INTEGER NOT NULL,
  PRIMARY KEY (workspace, day)
);

-- month_closes.status gains 'carried': owed less than the minimum charge,
-- so it waits for the next invoice.

-- The new meters, at Cloudflare's published prices.
INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('private_storage', 'Private repository storage past the free amount', 'GB-month', 500000, 20, 'list', '2026-10-05T00:00:00Z'),
  ('embedding_tokens', 'Search embeddings', 'million tokens', 67000, 20, 'list', '2026-10-05T00:00:00Z'),
  ('scan_cpu', 'Security scans: CPU time', 'million CPU ms', 20000, 20, 'list', '2026-10-05T00:00:00Z'),
  ('scan_rows', 'Security scans: rows written', 'million rows', 1000000, 20, 'list', '2026-10-05T00:00:00Z')
ON CONFLICT (meter) DO NOTHING;

INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_new_private_storage', 'private_storage', 500000, 500000, 20, 'Now metered: private repository storage past the free amount, at Cloudflare Artifacts'' storage price', '2026-10-05T00:00:00Z'),
  ('prc_new_embedding_tokens', 'embedding_tokens', 67000, 67000, 20, 'Now metered: search embeddings, at Workers AI''s price for the embedding model', '2026-10-05T00:00:00Z'),
  ('prc_new_scan_cpu', 'scan_cpu', 20000, 20000, 20, 'Now metered at Cloudflare''s prices: security scans, which were placeholder costs', '2026-10-05T00:00:00Z'),
  ('prc_new_scan_rows', 'scan_rows', 1000000, 1000000, 20, 'Now metered at Cloudflare''s prices: security scans, which were placeholder costs', '2026-10-05T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
