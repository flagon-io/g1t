-- What a harness session cost: its token usage as its harness last
-- reported it (JSON, cumulative, one entry per model: coordination/sessions.rs),
-- and the cost estimated from it at Anthropic's list price in US dollars
-- (g1t_contracts::model_prices). cost_usd is NULL until the session reports
-- usage for a model with a known price.
ALTER TABLE sessions ADD COLUMN usage TEXT;
ALTER TABLE sessions ADD COLUMN cost_usd REAL;
