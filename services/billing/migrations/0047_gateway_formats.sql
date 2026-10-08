-- The AI Gateway in both formats, open models on g1t's account, and the
-- workspace's own providers. See src/gateway.rs.
--
-- Prices per million tokens in millionths of a dollar, each provider's list
-- price on 2026-10-07: Anthropic's pricing page and Cloudflare's Workers AI
-- pricing page. Charged at these plus the price book's `gateway_models`
-- markup (0 in beta).

-- Cache writes that live an hour cost twice the input price; five-minute
-- ones (cache_write_micros) 1.25 times.
ALTER TABLE gateway_models ADD COLUMN cache_write_1h_micros INTEGER NOT NULL DEFAULT 0;
-- `chat`, or `embeddings` for a model that only embeds text.
ALTER TABLE gateway_models ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
-- A model priced by the prompt's length: a request whose prompt (input,
-- cache read and cache write tokens) is longer than `threshold` tokens is
-- charged entirely at the over_ prices. 0: one price.
ALTER TABLE gateway_models ADD COLUMN threshold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_models ADD COLUMN over_input_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_models ADD COLUMN over_output_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_models ADD COLUMN over_cache_read_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_models ADD COLUMN over_cache_write_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gateway_models ADD COLUMN over_cache_write_1h_micros INTEGER NOT NULL DEFAULT 0;

-- Cache reads on Sonnet 5.5 are 0.05 times input ($0.10), not 0.1 times
-- as 0045 had them. Opus 5.5 ($0.20) and Haiku 4.5 ($0.10) were right.
UPDATE gateway_models SET cache_read_micros = 100000, updated_at = '2026-10-07T00:00:00Z' WHERE model = 'claude-sonnet-5-5';
UPDATE gateway_models SET cache_write_1h_micros = 8000000 WHERE model = 'claude-opus-5-5';
UPDATE gateway_models SET cache_write_1h_micros = 4000000 WHERE model = 'claude-sonnet-5-5';
UPDATE gateway_models SET cache_write_1h_micros = 2000000 WHERE model IN ('claude-haiku-4-5', 'claude-haiku-4-5-20251001');

-- Claude Haiku 5.5, priced by prompt length: up to 100,000 prompt tokens
-- $0.10 in, $0.50 out, cache reads $0.01, writes $0.125 (5 min) and $0.20
-- (1 h); over that, $0.50, $2.50, $0.05, $0.625 and $1. Listed first: the
-- cheapest Claude, and the one to start with.
INSERT OR IGNORE INTO gateway_models
  (model, name, provider, kind, input_micros, output_micros, cache_read_micros, cache_write_micros, cache_write_1h_micros,
   threshold, over_input_micros, over_output_micros, over_cache_read_micros, over_cache_write_micros, over_cache_write_1h_micros,
   position, updated_at) VALUES
  ('claude-haiku-5-5', 'Claude Haiku 5.5', 'anthropic', 'chat', 100000, 500000, 10000, 125000, 200000,
   100000, 500000, 2500000, 50000, 625000, 1000000, 0, '2026-10-07T00:00:00Z');

-- Open models on Workers AI, through g1t's Cloudflare account. Workers AI
-- has no prompt-cache price: cached tokens, where a model reports them,
-- cost what input does.
INSERT OR IGNORE INTO gateway_models
  (model, name, provider, kind, input_micros, output_micros, cache_read_micros, cache_write_micros, cache_write_1h_micros, position, updated_at) VALUES
  ('@cf/zai-org/glm-5.3-flash', 'GLM-5.3 Flash', 'workers-ai', 'chat', 150000, 500000, 150000, 150000, 150000, 10, '2026-10-07T00:00:00Z'),
  ('@cf/openai/gpt-oss-20b', 'gpt-oss-20b', 'workers-ai', 'chat', 200000, 300000, 200000, 200000, 200000, 11, '2026-10-07T00:00:00Z'),
  ('@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 'workers-ai', 'chat', 270000, 850000, 270000, 270000, 270000, 12, '2026-10-07T00:00:00Z'),
  ('@cf/openai/gpt-oss-120b', 'gpt-oss-120b', 'workers-ai', 'chat', 350000, 750000, 350000, 350000, 350000, 13, '2026-10-07T00:00:00Z'),
  ('@cf/mistralai/mistral-small-3.1-24b-instruct', 'Mistral Small 3.1', 'workers-ai', 'chat', 351000, 555000, 351000, 351000, 351000, 14, '2026-10-07T00:00:00Z'),
  ('@cf/deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash', 'workers-ai', 'chat', 440000, 1320000, 440000, 440000, 440000, 15, '2026-10-07T00:00:00Z'),
  ('@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 120B', 'workers-ai', 'chat', 500000, 1500000, 500000, 500000, 500000, 16, '2026-10-07T00:00:00Z'),
  ('@cf/moonshotai/kimi-k2.6', 'Kimi K2.6', 'workers-ai', 'chat', 950000, 4000000, 950000, 950000, 950000, 17, '2026-10-07T00:00:00Z'),
  ('@cf/deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro', 'workers-ai', 'chat', 1320000, 3960000, 1320000, 1320000, 1320000, 18, '2026-10-07T00:00:00Z'),
  ('@cf/zai-org/glm-5.3', 'GLM-5.3', 'workers-ai', 'chat', 1400000, 4400000, 1400000, 1400000, 1400000, 19, '2026-10-07T00:00:00Z'),
  -- Embeddings: input tokens only.
  ('@cf/baai/bge-m3', 'BGE M3', 'workers-ai', 'embeddings', 12000, 0, 12000, 12000, 12000, 30, '2026-10-07T00:00:00Z'),
  ('@cf/baai/bge-base-en-v1.5', 'BGE Base (English)', 'workers-ai', 'embeddings', 67000, 0, 67000, 67000, 67000, 31, '2026-10-07T00:00:00Z');

-- What each request was sent as and who served it, for the log.
-- `anthropic` (Messages) or `openai` (Chat Completions, Embeddings).
ALTER TABLE gateway_requests ADD COLUMN format TEXT NOT NULL DEFAULT 'anthropic';
-- `anthropic` or `workers-ai` on g1t's key; on the workspace's own, its
-- connection's provider (`openai`, `openai_endpoint`…). Every request
-- before this went to Anthropic's API or an endpoint speaking it.
ALTER TABLE gateway_requests ADD COLUMN provider TEXT NOT NULL DEFAULT '';
-- On the workspace's own provider: the connection's name.
ALTER TABLE gateway_requests ADD COLUMN connection TEXT;
-- Of cache_write, the tokens written to the hour-long cache.
ALTER TABLE gateway_requests ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
UPDATE gateway_requests SET provider = 'anthropic' WHERE provider = '' AND status < 400;
