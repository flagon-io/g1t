-- How much each kind of token counts toward the g1t agent rate, as
-- price-book meters, on g1t's models and a workspace's own model key alike.
--
-- A weight is `cost_micros` in millionths: 1,000,000 counts a token once,
-- 100,000 counts it a tenth. Every weight starts at 1, which is what the
-- agent rate counted until now (input, output, cache reads and cache
-- writes, each once), so nothing changes until a new version is decided.
-- A cached agent run reads most of its context from cache, so cache reads
-- dominate its tokens; counting them at 0.1 is the lever
-- (docs/BILLING_OPERATIONS.md, "The agent rate's token weights").
--
-- Weights change as any price does: a new version in price_versions with
-- its effective date. A lower weight is a fall and applies at once; a
-- higher one is a rise and waits out the notice.

INSERT OR IGNORE INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('agent_token_weight_input', 'Agent rate weight: input tokens', 'weight', 1000000, 0, 'list', '2026-10-08T00:00:00Z'),
  ('agent_token_weight_output', 'Agent rate weight: output tokens', 'weight', 1000000, 0, 'list', '2026-10-08T00:00:00Z'),
  ('agent_token_weight_cache_read', 'Agent rate weight: cache reads', 'weight', 1000000, 0, 'list', '2026-10-08T00:00:00Z'),
  ('agent_token_weight_cache_write', 'Agent rate weight: cache writes', 'weight', 1000000, 0, 'list', '2026-10-08T00:00:00Z');

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at) VALUES
  ('pv_agent_token_weight_input_1', 'agent_token_weight_input', 1, 1000000, 0, '2026-10-08T00:00:00Z',
   'Every input token counts once toward the agent rate', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_agent_token_weight_output_1', 'agent_token_weight_output', 1, 1000000, 0, '2026-10-08T00:00:00Z',
   'Every output token counts once toward the agent rate', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_agent_token_weight_cache_read_1', 'agent_token_weight_cache_read', 1, 1000000, 0, '2026-10-08T00:00:00Z',
   'Every cache-read token counts once toward the agent rate', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_agent_token_weight_cache_write_1', 'agent_token_weight_cache_write', 1, 1000000, 0, '2026-10-08T00:00:00Z',
   'Every cache-write token counts once toward the agent rate', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z');
