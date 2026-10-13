-- Sessions g1t starts on a workspace's own Anthropic account, as Claude
-- Managed Agents sessions (src/agent_sessions.rs). g1t runs no model: the
-- workspace's key does, and g1t records what the session does.

-- The agent and environment g1t keeps on an Anthropic connection's
-- account, made once and updated (a new version) when what g1t asks of
-- them changes (`config_hash`). `skills` is JSON: g1t's own skills uploaded
-- there, by name, as {name: skill id}.
CREATE TABLE managed_agents (
  connection_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  environment_id TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '{}',
  config_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One session started, followed every minute until it ends. `session_id`
-- is g1t's (ses_…); `provider_session_id` Anthropic's (sesn_…). `actor` is
-- JSON: who started it, as whom it records. The vault and token are what
-- the session holds g1t's credential in, removed when it ends. `threads`
-- is JSON: each subagent thread's g1t session and the last event read of
-- it. `last_event_id` is the last event read of the session itself.
CREATE TABLE agent_runs (
  session_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  vault_id TEXT,
  token_id TEXT,
  -- running or ended.
  status TEXT NOT NULL DEFAULT 'running',
  last_event_id TEXT,
  threads TEXT NOT NULL DEFAULT '{}',
  -- Its last message: what it reports when it ends.
  result TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX agent_runs_running ON agent_runs (status, synced_at);
CREATE INDEX agent_runs_by_provider ON agent_runs (provider_session_id);
