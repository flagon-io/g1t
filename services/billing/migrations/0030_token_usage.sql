-- Model tokens, added up per day and run, for usage views: the model proxy
-- reports what each answer used. Billing still prices runs from AI
-- Gateway, never from these.
CREATE TABLE token_usage (
  -- YYYY-MM-DD, UTC.
  day TEXT NOT NULL,
  workspace TEXT NOT NULL,
  -- The person the run was for, by username; empty when nobody asked.
  person TEXT NOT NULL DEFAULT '',
  -- The model session's id, one per run (runs.session_id).
  session TEXT NOT NULL,
  model TEXT NOT NULL,
  -- On g1t's hosted models: small or large.
  tier TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, workspace, person, session, model)
);
CREATE INDEX token_usage_by_workspace_day ON token_usage (workspace, day);
CREATE INDEX token_usage_by_person_day ON token_usage (workspace, person, day);
