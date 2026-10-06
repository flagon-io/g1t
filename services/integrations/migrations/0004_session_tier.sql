-- The tier a run on g1t's hosted models was routed to, small or large.
-- The model proxy tags each of the run's requests with it at the gateway.
-- Null for a workspace's own provider.
ALTER TABLE model_sessions ADD COLUMN tier TEXT;
