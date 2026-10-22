-- Coding agents' own telemetry (OpenTelemetry sent to the API's /v1/logs
-- and /v1/metrics; coordination/telemetry.rs): what each harness session
-- used, by signal, model and tier, added up export by export (or, for
-- running totals, the largest seen). A row waits here until g1t finds the
-- session it belongs to, and is kept 30 days after its last export.
-- Counts and costs only: no prompt, response or tool output reaches it.
CREATE TABLE agent_telemetry (
  actor_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  harness_session_id TEXT NOT NULL,
  -- logs or metrics.
  signal TEXT NOT NULL,
  model TEXT NOT NULL,
  -- '' for none: part of the key.
  tier TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  -- What the harness said it cost, in US dollars; NULL when it never said.
  cost_usd REAL,
  -- The repository the telemetry named (owner/name), if any.
  repo TEXT,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, harness, harness_session_id, signal, model, tier)
);
CREATE INDEX agent_telemetry_by_last ON agent_telemetry (last_at);

-- Where a session's usage came from: NULL for its plugin's or hook's own
-- report (every row before this), 'otel' for telemetry. A plugin's report
-- replaces telemetry's and is never replaced by it.
ALTER TABLE sessions ADD COLUMN usage_source TEXT;

-- A person's session by its harness's id, in any repository: what
-- telemetry, which names no repository, is matched by.
CREATE INDEX sessions_by_harness_session ON sessions (harness_session_id, actor_id)
  WHERE harness_session_id IS NOT NULL;
