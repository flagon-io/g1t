-- One paid plan, "g1t", and the limits, checks and protections around it.
-- See src/compute.rs (entitlements, reservations, spikes), src/cards.rs
-- (card checks), src/requests.rs (raising a limit), src/overages.rs
-- (goodwill) and src/limits.rs (ceilings).

-- What g1t covered itself on a usage entry, such as the part of a free
-- workspace's last trial run past its trial credit. Like credit_micros,
-- trial_micros and oss_micros, it is not in amount_micros.
ALTER TABLE ledger ADD COLUMN given_micros INTEGER NOT NULL DEFAULT 0;

-- Ceilings: the highest the workspace has ever had (owners may set their
-- spend limit up to it without asking), a ceiling g1t granted (an approved
-- request, or the owners' one-time raise), and when that raise was used.
ALTER TABLE limits ADD COLUMN max_ceiling_micros INTEGER;
ALTER TABLE limits ADD COLUMN granted_ceiling_micros INTEGER;
ALTER TABLE limits ADD COLUMN raised_at TEXT;
-- The owners' own caps on agents: one run's spend, and what the agents on
-- one issue may spend in all. Null: the defaults ($2 and $10).
ALTER TABLE limits ADD COLUMN run_cap_micros INTEGER;
ALTER TABLE limits ADD COLUMN issue_cap_micros INTEGER;

-- Overrides g1t staff set per account in sudo: agents at once, one run's
-- spend cap, and a hold on new compute (with why).
ALTER TABLE billing_accounts ADD COLUMN max_concurrent_agents INTEGER;
ALTER TABLE billing_accounts ADD COLUMN run_cap_micros INTEGER;
ALTER TABLE billing_accounts ADD COLUMN issue_cap_micros INTEGER;
ALTER TABLE billing_accounts ADD COLUMN hold TEXT;

-- Estimates held before compute starts, so starts at the same moment
-- cannot overshoot a ceiling together. Released by `settle`, or after
-- three hours if never settled.
CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  -- At cost to g1t, as asked.
  estimate_micros INTEGER NOT NULL,
  -- What is held, at price (cost plus the margin), which is what limits
  -- and pools are measured in.
  hold_micros INTEGER NOT NULL,
  -- credit, trial, oss or on_demand.
  paid_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  -- At cost, as settled.
  actual_micros INTEGER
);
CREATE INDEX reservations_open ON reservations (workspace, settled_at, expires_at);

-- Card checks: a card saved and verified with Stripe (a setup with 3-D
-- Secure where the card supports it; never charged). The trial and the
-- open-source pool need one. One trial per card, by its fingerprint.
CREATE TABLE card_checks (
  workspace TEXT PRIMARY KEY,
  setup_intent TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  fingerprint TEXT,
  brand TEXT,
  last4 TEXT,
  funding TEXT,
  country TEXT,
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX card_checks_by_fingerprint ON card_checks (fingerprint);

-- Spend spikes: an hour well above the workspace's usual. New compute
-- waits for an owner: keep going (for 24 hours, or until the hour's spend
-- doubles again) or stop.
CREATE TABLE spikes (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- open, continued or stopped.
  status TEXT NOT NULL,
  hour_micros INTEGER NOT NULL,
  average_micros INTEGER NOT NULL,
  detected_at TEXT NOT NULL,
  told_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  until TEXT
);
CREATE INDEX spikes_by_workspace ON spikes (workspace, detected_at);

-- Requests to g1t: raise my limit, or spent more than I meant to.
CREATE TABLE limit_requests (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- limit or overage.
  kind TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  reason TEXT NOT NULL,
  expected_monthly_micros INTEGER NOT NULL DEFAULT 0,
  -- open, approved or declined.
  status TEXT NOT NULL DEFAULT 'open',
  decided_micros INTEGER,
  decided_by TEXT,
  answer TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX limit_requests_by_workspace ON limit_requests (workspace, created_at);
CREATE INDEX limit_requests_by_status ON limit_requests (status, created_at);

-- Alerts sent: 50, 75, 90 and 100% of the plan's included usage
-- (`included`), the owners' spend limit (`spend_limit`) and g1t's ceiling
-- (`ceiling`), once each a month.
CREATE TABLE alerts_sent (
  workspace TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  meter TEXT NOT NULL,
  level INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (workspace, month, meter, level)
);

-- The plan's monthly price, as each invoice for it is paid: revenue that
-- never goes through the ledger.
CREATE TABLE plan_payments (
  invoice_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  paid_at TEXT NOT NULL
);
CREATE INDEX plan_payments_by_month ON plan_payments (paid_at);

-- New meters:
-- - Git operations through g1t (clones, fetches, pushes), at Cloudflare
--   Artifacts' price from 2026-10-14: $0.15 per 1,000.
-- - A sandbox second's parts, for runs that report their own CPU: memory,
--   disk and the Durable Object behind the container per second; vCPU per
--   vCPU-second.
INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('git_operations', 'Git operations past the included amount', '1,000 operations', 150000, 20, 'list', '2026-10-05T00:00:00Z'),
  ('sandbox_base_second', 'Sandbox time: memory, disk and its Durable Object', 'second', 12.1225, 20, 'list', '2026-10-05T00:00:00Z'),
  ('sandbox_cpu_second', 'Sandbox time: CPU in use', 'vCPU-second', 20, 20, 'list', '2026-10-05T00:00:00Z')
ON CONFLICT (meter) DO NOTHING;

-- The Durable Object behind each sandbox is billed for as long as the
-- container runs: 128 MB at $12.50 per million GB-seconds, 1.5625
-- millionths of a dollar a second, which the sandbox second left out.
INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at)
SELECT 'prc_do_' || meter, meter, cost_micros, cost_micros + 1.5625, markup_percent,
       'Now includes the Durable Object behind each sandbox, which Cloudflare bills for as long as the container runs',
       '2026-10-05T00:00:00Z'
FROM prices WHERE meter IN ('sandbox_second', 'build_second')
ON CONFLICT (id) DO NOTHING;
UPDATE prices SET cost_micros = cost_micros + 1.5625, updated_at = '2026-10-05T00:00:00Z'
WHERE meter IN ('sandbox_second', 'build_second');

INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_new_git_operations', 'git_operations', 150000, 150000, 20, 'Now metered: git operations past the included amount, at Cloudflare Artifacts'' price, from 14 October 2026', '2026-10-05T00:00:00Z'),
  ('prc_new_sandbox_parts', 'sandbox_cpu_second', 20, 20, 20, 'Runs that report their own CPU are priced on it: memory, disk and the Durable Object by the second, CPU by the vCPU-second', '2026-10-05T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
