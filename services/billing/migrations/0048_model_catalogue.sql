-- One model catalogue: `gateway_models` becomes every model g1t can use,
-- the agents' tiers, the AI Gateway's and the embeddings model, with what
-- g1t knows about each and where it stands. See src/catalogue.rs.
--
-- New models are found by the models service listing each provider daily
-- (`record_discovery`) and wait as `new` until staff approve them in sudo,
-- Agents & models. Only `available` models are routed to; the AI Gateway
-- offers `available` and `deprecated` ones that are priced.

-- Other ids the provider lists it by, comma separated (a dated id).
ALTER TABLE gateway_models ADD COLUMN aliases TEXT NOT NULL DEFAULT '';
-- `haiku`, `sonnet`, `opus`, `fable`, or a Workers AI author.
ALTER TABLE gateway_models ADD COLUMN family TEXT NOT NULL DEFAULT '';
-- The agent tier it suits: `small`, `large`, `frontier`, or empty.
ALTER TABLE gateway_models ADD COLUMN tier_hint TEXT NOT NULL DEFAULT '';
ALTER TABLE gateway_models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_models ADD COLUMN max_output INTEGER NOT NULL DEFAULT 0;
-- Comma separated: effort, thinking, tools, vision, embeddings.
ALTER TABLE gateway_models ADD COLUMN capabilities TEXT NOT NULL DEFAULT '';
-- An embeddings model's vector length.
ALTER TABLE gateway_models ADD COLUMN dimensions INTEGER NOT NULL DEFAULT 0;
-- `available`, `new` (found, not approved), `deprecated` (the provider
-- stopped listing it) or `retired` (staff took it out).
ALTER TABLE gateway_models ADD COLUMN status TEXT NOT NULL DEFAULT 'available';
-- 1 when its prices are known. An unpriced model is never routed to,
-- offered or charged for.
ALTER TABLE gateway_models ADD COLUMN priced INTEGER NOT NULL DEFAULT 1;
-- `discovered` or `staff`.
ALTER TABLE gateway_models ADD COLUMN source TEXT NOT NULL DEFAULT 'staff';
ALTER TABLE gateway_models ADD COLUMN first_seen_at TEXT;
ALTER TABLE gateway_models ADD COLUMN last_seen_at TEXT;
ALTER TABLE gateway_models ADD COLUMN missing_since TEXT;
ALTER TABLE gateway_models ADD COLUMN approved_by TEXT;
ALTER TABLE gateway_models ADD COLUMN approved_at TEXT;
ALTER TABLE gateway_models ADD COLUMN note TEXT NOT NULL DEFAULT '';

UPDATE gateway_models SET first_seen_at = updated_at, approved_at = updated_at, approved_by = 'migration';

-- What g1t knows about the models it had.
UPDATE gateway_models SET family = 'opus', tier_hint = 'frontier', context_window = 1000000, max_output = 128000,
  capabilities = 'effort,thinking,tools,vision' WHERE model = 'claude-opus-5-5';
UPDATE gateway_models SET family = 'sonnet', tier_hint = 'large', context_window = 1000000, max_output = 128000,
  capabilities = 'effort,thinking,tools,vision' WHERE model = 'claude-sonnet-5-5';
UPDATE gateway_models SET family = 'haiku', tier_hint = 'small',
  capabilities = 'effort,thinking,tools,vision' WHERE model = 'claude-haiku-5-5';
-- Haiku 4.5 takes no effort level.
UPDATE gateway_models SET family = 'haiku', tier_hint = 'small', context_window = 200000, max_output = 64000,
  capabilities = 'thinking,tools,vision' WHERE model IN ('claude-haiku-4-5', 'claude-haiku-4-5-20251001');
UPDATE gateway_models SET aliases = 'claude-haiku-4-5-20251001' WHERE model = 'claude-haiku-4-5';
UPDATE gateway_models SET family = substr(model, 5, instr(substr(model, 5), '/') - 1) WHERE provider = 'workers-ai';
UPDATE gateway_models SET capabilities = 'embeddings', dimensions = 768 WHERE model = '@cf/baai/bge-base-en-v1.5';
UPDATE gateway_models SET capabilities = 'embeddings', dimensions = 1024 WHERE model = '@cf/baai/bge-m3';

-- Which model each purpose uses by default, chosen by staff in sudo
-- (`admin_set_model_default`; every change in the audit log with the old
-- and new value and why). A model purpose names a model; a job
-- (`job_<kind>`) its starting tier (`small`, `large`, `frontier`, or
-- `change` to size the change it reads) and effort. Read by the runner and
-- the AI Gateway; the runner's AGENT_ROUTING is only the fallback when
-- billing cannot be reached. Seeded with what AGENT_ROUTING said.
CREATE TABLE IF NOT EXISTS model_defaults (
  purpose TEXT PRIMARY KEY,
  model TEXT,
  tier TEXT,
  effort TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO model_defaults (purpose, model, tier, effort, updated_at, updated_by, reason) VALUES
  ('tier_small', 'claude-haiku-5-5', NULL, NULL, '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('tier_large', 'claude-sonnet-5-5', NULL, NULL, '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('tier_frontier', 'claude-opus-5-5', NULL, NULL, '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('background', 'claude-haiku-5-5', NULL, NULL, '2026-10-08T00:00:00Z', 'migration', 'The fast tier''s model, as before'),
  ('gateway_first', 'claude-haiku-5-5', NULL, NULL, '2026-10-08T00:00:00Z', 'migration', 'The cheapest Claude, listed first since 0047'),
  ('job_implement', NULL, 'large', NULL, '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('job_revise', NULL, 'large', NULL, '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('job_answer', NULL, 'small', 'medium', '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('job_review', NULL, 'change', NULL, '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('job_update', NULL, 'small', 'low', '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it'),
  ('job_plan', NULL, 'small', 'high', '2026-10-08T00:00:00Z', 'migration', 'As AGENT_ROUTING had it');

-- Every check of a provider's list, daily or from sudo: what it listed,
-- added and found gone, or why it failed. Kept 90 days.
CREATE TABLE IF NOT EXISTS model_checks (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  by TEXT NOT NULL,
  listed INTEGER NOT NULL DEFAULT 0,
  added TEXT NOT NULL DEFAULT '',
  deprecated TEXT NOT NULL DEFAULT '',
  error TEXT
);
CREATE INDEX IF NOT EXISTS model_checks_by_time ON model_checks (checked_at);
