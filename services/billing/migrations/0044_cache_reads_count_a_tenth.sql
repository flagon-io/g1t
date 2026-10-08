-- Cache reads count a tenth toward the g1t agent rate, as providers price
-- them: a cached agent run reads most of its context from cache, and at a
-- full weight the rate would add about 44% to a typical Sonnet run for
-- tokens that cost the provider a tenth. A lower weight is a price fall, so
-- it applies at once; the agent rate itself starts on 2026-10-22.

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at) VALUES
  ('pv_agent_token_weight_cache_read_2', 'agent_token_weight_cache_read', 2, 100000, 0, '2026-10-08T00:00:00Z',
   'Cache reads count a tenth toward the agent rate, as model providers price them', 'migration', '2026-10-08T04:30:00Z', '2026-10-08T04:30:00Z');

UPDATE prices SET cost_micros = 100000, updated_at = '2026-10-08T04:30:00Z'
 WHERE meter = 'agent_token_weight_cache_read' AND cost_micros = 1000000;

INSERT OR IGNORE INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_agent_token_weight_cache_read_2', 'agent_token_weight_cache_read', 1000000, 100000, 0,
   'Lower: cache reads count a tenth toward the agent rate (input, output and cache writes still count once)', '2026-10-08T04:30:00Z');
