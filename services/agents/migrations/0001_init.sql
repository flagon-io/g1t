-- A workspace's own agents (docs/WORKSPACE.md, "Agents"): their
-- definitions, every version of them, each reply they gave and what it
-- cost, and spend rolled up by month and day for their budgets.

-- One row per agent. Routing, budget and autonomy are small JSON objects
-- (@g1t/contracts workspace-agents.ts), read and written whole.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  -- By id, not slug: a renamed workspace keeps its agents.
  workspace_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar TEXT,
  role TEXT NOT NULL,
  instructions TEXT NOT NULL,
  personality_preset TEXT NOT NULL DEFAULT 'crisp',
  personality TEXT NOT NULL DEFAULT '',
  routing TEXT NOT NULL,
  budget TEXT NOT NULL,
  autonomy TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 3,
  template TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  -- The desk's presence: a reply is in flight until this time. A time, not
  -- a flag, so a desk that died mid-reply never leaves it "working".
  busy_until TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

-- A handle is unique among a workspace's agents that are not archived:
-- archiving one frees its handle, and its old messages still resolve by id.
CREATE UNIQUE INDEX agents_handle ON agents (workspace_id, handle) WHERE archived_at IS NULL;
CREATE INDEX agents_workspace ON agents (workspace_id, archived_at);

-- Every version of every definition, as it was saved, for the profile's
-- history and for runs to say which version they ran.
CREATE TABLE agent_versions (
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, version)
);

-- Each message an agent was handed, and what came of it: spend and audit.
-- status: working, replied, failed, blocked (budget or access; a short
-- notice was posted, or kept back as a repeat), skipped (hop limit).
CREATE TABLE agent_replies (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  -- The message that woke it; one reply per message, however often it is handed over.
  message_id TEXT NOT NULL,
  -- The message the agent posted, when it posted one.
  reply_id TEXT,
  asked_by TEXT,
  agent_version INTEGER,
  model TEXT,
  tier TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- What the model cost at the provider's price, in millionths of a dollar.
  cost_micros INTEGER NOT NULL DEFAULT 0,
  -- What it counts against the agent's budget: the model at price plus
  -- the agent rate. Billing's ledger, with comped terms and discounts, is
  -- what the workspace is actually charged.
  charged_micros INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE UNIQUE INDEX agent_replies_message ON agent_replies (agent_id, message_id);
CREATE INDEX agent_replies_recent ON agent_replies (agent_id, created_at);
CREATE INDEX agent_replies_channel ON agent_replies (agent_id, channel_id, status, created_at);

-- Spend by agent and period: `YYYY-MM` for the month, `YYYY-MM-DD` for the
-- day, both UTC. Budgets and `spent_month_micros` read these, never a sum
-- over every reply.
CREATE TABLE agent_spend (
  agent_id TEXT NOT NULL,
  period TEXT NOT NULL,
  micros INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, period)
);
