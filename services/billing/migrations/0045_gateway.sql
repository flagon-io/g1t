-- The AI Gateway: a workspace's own model requests, sent with one of its
-- access tokens to the model proxy (models.g1t.sh/anthropic). See
-- src/gateway.rs.
--
-- What each model costs on g1t's key, per million tokens of each kind, in
-- millionths of a dollar: the provider's list price. A request is charged
-- its tokens at these prices plus the price book's `gateway_models` markup
-- (0 while the gateway is in beta), drawn from AI credit. A model that is
-- not here is not offered: the proxy refuses it before it reaches the
-- provider. Cache writes are the five-minute kind, 1.25 times input.
CREATE TABLE IF NOT EXISTS gateway_models (
  model TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_micros INTEGER NOT NULL,
  output_micros INTEGER NOT NULL,
  cache_read_micros INTEGER NOT NULL,
  cache_write_micros INTEGER NOT NULL,
  -- The order the docs and the page list them in.
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO gateway_models (model, name, provider, input_micros, output_micros, cache_read_micros, cache_write_micros, position, updated_at) VALUES
  ('claude-opus-5-5', 'Claude Opus 5.5', 'anthropic', 4000000, 20000000, 200000, 5000000, 1, '2026-10-08T00:00:00Z'),
  ('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'anthropic', 2000000, 10000000, 200000, 2500000, 2, '2026-10-08T00:00:00Z'),
  ('claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic', 1000000, 5000000, 100000, 1250000, 3, '2026-10-08T00:00:00Z'),
  -- The same model by its dated id, which some tools send.
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'anthropic', 1000000, 5000000, 100000, 1250000, 4, '2026-10-08T00:00:00Z');

-- Every request, for the workspace's AI Gateway page and API: kept 30 days
-- (retention.rs). Prompts and answers are never stored. What a request was
-- charged is also a ledger line (task `gateway`, reference its id), which
-- is what Usage, the statement and invoices read.
CREATE TABLE IF NOT EXISTS gateway_requests (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  token_id TEXT NOT NULL,
  token_name TEXT,
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  charged_micros INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  own_key INTEGER NOT NULL DEFAULT 0,
  streamed INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS gateway_requests_by_workspace ON gateway_requests (workspace, created_at);
CREATE INDEX IF NOT EXISTS gateway_requests_by_time ON gateway_requests (created_at);
