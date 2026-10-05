-- Run credentials: each sandbox run's tokens are bound to the agent run
-- they work for, so they can be found, and revoked, when it stops. The
-- rest of the binding (kind, use, git grants) is in agent_scope's `run`.
ALTER TABLE access_tokens ADD COLUMN run_id TEXT;
CREATE INDEX access_tokens_run ON access_tokens (run_id) WHERE run_id IS NOT NULL;
