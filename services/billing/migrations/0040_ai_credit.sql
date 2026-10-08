-- Prepaid AI credit, the agent's own rate, budgets and quantities.
--
-- AI is prepaid: a workspace buys AI credit (Stripe Checkout, one-time),
-- optionally reloads it from its saved card, and model usage draws on it
-- first (credit_grants with kind purchased, scope models, source purchase:
-- see grants.rs and ai.rs). g1t never fronts a model's cost for a
-- workspace on the plan: at $0 of AI credit, new runs on g1t's models stop
-- until credit is bought or auto-reload is on.
--
-- Pricing changes, as dated price versions with a public record:
--
-- - Agent models (`agent_models`): what the model provider charged, with no
--   markup from 2026-10-08 (was cost plus 20%). A fall: it applies at once.
-- - The g1t agent rate (`agent_tokens`): a flat price per million tokens an
--   agent's run used (input, output and cached), for what g1t adds around
--   the model: context, memory, routing and orchestration. $0.25 a million.
--   New, so a rise from nothing: it takes effect after the 14 days' notice
--   (2026-10-22), and owners on the plan are emailed once.
-- - AI Gateway (`gateway_models`): the provider's price with no markup
--   while it is in beta. A price-book value, so it can change without a
--   deploy, with notice like any other rise.
-- - Card processing fee on AI credit bought by card: Stripe's fee, passed
--   on as its own line (`card_fee_percent` per dollar charged and
--   `card_fee_fixed` per payment). Never on invoiced billing. Switched by
--   the `card_fee` cost setting (`on` or `off`).

INSERT OR IGNORE INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('agent_models', 'Agent models', 'provider dollar', 1000000, 20, 'list', '2026-10-08T00:00:00Z'),
  ('agent_tokens', 'g1t agent rate', 'million tokens', 0, 0, 'list', '2026-10-08T00:00:00Z'),
  ('gateway_models', 'AI Gateway models', 'provider dollar', 1000000, 0, 'list', '2026-10-08T00:00:00Z'),
  ('card_fee_percent', 'Card processing fee', 'dollar charged', 29000, 0, 'list', '2026-10-08T00:00:00Z'),
  ('card_fee_fixed', 'Card processing fee', 'payment', 300000, 0, 'list', '2026-10-08T00:00:00Z');

-- Version 1 is what was charged until now; the next versions wait for
-- their date and are applied by the daily run (pricing.rs), which writes
-- the public record in price_changes.
INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at) VALUES
  ('pv_agent_models_1', 'agent_models', 1, 1000000, 20, '2026-10-01T00:00:00Z',
   'Models at what the provider charged plus 20%', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_agent_models_2', 'agent_models', 2, 1000000, 0, '2026-10-08T00:00:00Z',
   'Models at what the provider charged, with no markup: g1t''s own work around them is the agent rate now', 'migration', '2026-10-08T00:00:00Z', NULL),
  ('pv_agent_tokens_1', 'agent_tokens', 1, 0, 0, '2026-10-08T00:00:00Z',
   'The g1t agent rate, not charged yet', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_agent_tokens_2', 'agent_tokens', 2, 250000, 0, '2026-10-22T00:00:00Z',
   'New: $0.25 per million tokens an agent''s run uses (input, output and cached), for context, memory, routing and orchestration; models themselves are no longer marked up', 'migration', '2026-10-08T00:00:00Z', NULL),
  ('pv_gateway_models_1', 'gateway_models', 1, 1000000, 0, '2026-10-08T00:00:00Z',
   'AI Gateway at the provider''s price, free of any markup while it is in beta', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_card_fee_percent_1', 'card_fee_percent', 1, 29000, 0, '2026-10-08T00:00:00Z',
   'Stripe''s card fee on AI credit bought by card, passed on as its own line', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_card_fee_fixed_1', 'card_fee_fixed', 1, 300000, 0, '2026-10-08T00:00:00Z',
   'Stripe''s card fee on AI credit bought by card, passed on as its own line', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z');

INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_gateway_models', 'gateway_models', 1000000, 1000000, 0, 'New: AI Gateway at the provider''s price, free of any markup while it is in beta', '2026-10-08T00:00:00Z'),
  ('prc_card_fee', 'card_fee_percent', 29000, 29000, 0, 'New: Stripe''s card fee (2.9% + $0.30) on AI credit bought by card, as its own line; none on invoiced billing', '2026-10-08T00:00:00Z');

INSERT OR IGNORE INTO cost_settings (key, value, updated_at, updated_by) VALUES
  ('card_fee', 'on', '2026-10-08T00:00:00Z', 'migration');

-- A payment page for AI credit is a checkout with feature `ai_credit`:
-- `amount_cents` is the credit, and this the card fee on top.
ALTER TABLE checkouts ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0;

-- How much of something a usage line was: sandbox seconds, tokens. Null on
-- lines from before, which are counted as entries.
ALTER TABLE ledger ADD COLUMN quantity REAL;
-- What a sandbox line was for: agent, check, workflow, queue or deploy, so
-- the Usage page shows an agent's sandbox time under Agent.
ALTER TABLE ledger ADD COLUMN compute TEXT;

-- The tokens a run's agent rate was charged for, so a later count charges
-- only what is new.
ALTER TABLE runs ADD COLUMN agent_tokens INTEGER NOT NULL DEFAULT 0;

-- Auto-reload: when AI credit falls below the threshold, the saved card is
-- charged (off-session, an idempotency key per attempt) to bring it back
-- to the target, at most `monthly_max_micros` a calendar month. Off by
-- default; a failed charge turns it off and tells the owners.
CREATE TABLE IF NOT EXISTS ai_reload (
  workspace TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  threshold_micros INTEGER NOT NULL,
  target_micros INTEGER NOT NULL,
  monthly_max_micros INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failed_at TEXT,
  error TEXT
);

-- Each reload: its key is the idempotency key Stripe saw, so a retry of
-- the same attempt is the same payment.
CREATE TABLE IF NOT EXISTS ai_reloads (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- YYYY-MM, for the monthly maximum.
  month TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  fee_micros INTEGER NOT NULL DEFAULT 0,
  payment_intent TEXT,
  -- pending, paid or failed.
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_reloads_by_month ON ai_reloads (workspace, month);

-- Budgets: the owners' monthly spend limit, with which alerts to send
-- (comma-separated percents), whether usage pauses at 100%, and an
-- optional webhook told at each alert.
ALTER TABLE limits ADD COLUMN alert_levels TEXT;
ALTER TABLE limits ADD COLUMN pause_at_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE limits ADD COLUMN budget_webhook TEXT;
