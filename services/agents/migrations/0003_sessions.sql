-- Sessions, memory, routines and the workspace's agent policy
-- (docs/WORKSPACE.md, "Sessions", "Memory", "Routines", "Budgets").

-- One row per session: a bounded piece of work an agent took on. Talking
-- to an agent is a reply (agent_replies); real work is a session, with its
-- own context, transcript, cap and live card. Sessions form trees: a
-- session starts others for its subagents or for colleagues it brings in,
-- and the whole tree is paid by the agent at its root (payer_agent_id).
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- The subagent running it, by name, for kind `subagent`.
  subagent TEXT,
  -- chat, routine, helper or subagent.
  kind TEXT NOT NULL,
  parent_id TEXT,
  root_id TEXT NOT NULL,
  payer_agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  -- queued, working, waiting, needs_approval, done, failed or stopped.
  status TEXT NOT NULL,
  status_note TEXT,
  summary TEXT,
  -- Where it was asked and where it reports, and who asked with what access
  -- (the asker's access caps everything it reads and does).
  workspace TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_kind TEXT NOT NULL,
  channel_name TEXT,
  -- The conversation's thread the request was in (null: top level).
  thread_root TEXT,
  message_id TEXT,
  card_message_id TEXT,
  asked_by TEXT,
  asked_by_username TEXT,
  asker TEXT,
  routine_id TEXT,
  -- The agents that handed this work along, oldest first (hop limit, no ping-pong).
  chain TEXT NOT NULL DEFAULT '[]',
  hops INTEGER NOT NULL DEFAULT 0,
  -- The model's working context: a bounded list of turns, compacted as it
  -- grows. The full record is agent_session_events.
  context TEXT NOT NULL DEFAULT '[]',
  -- What arrived while it worked (steering, helpers' results), read at its next step.
  inbox TEXT NOT NULL DEFAULT '[]',
  steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  charged_micros INTEGER NOT NULL DEFAULT 0,
  cap_micros INTEGER,
  model TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  -- When its current step started: a step that never finished is picked up again.
  step_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX agent_sessions_agent ON agent_sessions (agent_id, created_at);
CREATE INDEX agent_sessions_workspace ON agent_sessions (workspace_id, status, created_at);
CREATE INDEX agent_sessions_root ON agent_sessions (root_id);
CREATE INDEX agent_sessions_parent ON agent_sessions (parent_id);
CREATE INDEX agent_sessions_card ON agent_sessions (card_message_id);
CREATE INDEX agent_sessions_payer ON agent_sessions (payer_agent_id, created_at);

-- A session's transcript, as its page shows it: what it was asked, what
-- it said, every tool it used (arguments cut, never results), steering,
-- updates it posted, sessions it started, and its report.
CREATE TABLE agent_session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  by_name TEXT,
  body TEXT NOT NULL,
  tool TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- What an agent remembers, each fact with its source and a scope that
-- decides where it may be recalled: workspace, a channel, or one person's
-- direct messages (scope_ref: the channel or user id).
CREATE TABLE agent_memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_ref TEXT NOT NULL DEFAULT '',
  scope_label TEXT,
  body TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  source_label TEXT,
  source_channel_id TEXT,
  created_by TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX agent_memories_agent ON agent_memories (agent_id, scope, scope_ref);

-- Work an agent does on a schedule: each run is a session in the routine's
-- channel, with the access of the person who set it up (sponsor).
CREATE TABLE agent_routines (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- The workspace's slug when it was saved, for posting and billing.
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  -- JSON: every (hour, day, weekday, week), minute, hour, weekday. UTC.
  schedule TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  sponsor TEXT NOT NULL,
  sponsor_username TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  paused_note TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  last_session_id TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX agent_routines_agent ON agent_routines (agent_id);
CREATE INDEX agent_routines_due ON agent_routines (enabled, next_run_at);

-- The workspace's say over all its agents together.
CREATE TABLE agent_policies (
  workspace_id TEXT PRIMARY KEY,
  monthly_micros INTEGER,
  default_agent_monthly_micros INTEGER,
  default_session_micros INTEGER NOT NULL DEFAULT 2000000,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- Every agent's spend together, by workspace and period (YYYY-MM, YYYY-MM-DD),
-- for the workspace's agent budget; and which alerts went out this month.
CREATE TABLE workspace_agent_spend (
  workspace_id TEXT NOT NULL,
  period TEXT NOT NULL,
  micros INTEGER NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period)
);

-- Replies say who they were for, where, and how many tools they used, for
-- the spend breakdown and the Activity tab.
ALTER TABLE agent_replies ADD COLUMN asked_by_username TEXT;
ALTER TABLE agent_replies ADD COLUMN channel_name TEXT;
ALTER TABLE agent_replies ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0;
-- Session steps counted with the agent's spend, beside replies.
ALTER TABLE agent_spend ADD COLUMN sessions INTEGER NOT NULL DEFAULT 0;
