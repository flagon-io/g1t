-- The g1t agent rate on runs that use a workspace's own model key.
--
-- Runs on a workspace's own provider pay the provider for the model, and
-- were charged nothing by g1t but their sandbox time: billing never saw
-- their tokens. The model proxy counts them now (under the run's model
-- session, kept on `runs.session_id` for these runs too), and the sandbox
-- reports what its harness counted. The agent rate is charged on them, on
-- a meter of its own so it is priced and shown apart:
--
-- - `agent_tokens_own`: $0.25 per million tokens (input, output and
--   cached), the same as on g1t's models. The model itself is never
--   charged: the workspace pays its provider. New, so a rise from nothing:
--   it takes effect after the 14 days' notice (2026-10-22), and owners on
--   the plan are emailed once (`tell_owners_of_rises`).
--
-- Its ledger lines are `<run>/agent-own` (later `<run>/agent-own/<tokens>`),
-- named "Agent rate, your own model key" on Usage and the statement.

INSERT OR IGNORE INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('agent_tokens_own', 'g1t agent rate, your own model key', 'million tokens', 0, 0, 'list', '2026-10-08T00:00:00Z');

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at) VALUES
  ('pv_agent_tokens_own_1', 'agent_tokens_own', 1, 0, 0, '2026-10-08T00:00:00Z',
   'The g1t agent rate on your own model key, not charged yet', 'migration', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'),
  ('pv_agent_tokens_own_2', 'agent_tokens_own', 2, 250000, 0, '2026-10-22T00:00:00Z',
   'New: $0.25 per million tokens an agent''s run uses on your own model key (input, output and cached), for context, memory, routing and orchestration; the model itself stays between you and your provider', 'migration', '2026-10-08T00:00:00Z', NULL);
