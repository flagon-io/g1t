-- Tool calls of a Managed Agents session that wait for someone to allow or
-- deny them (src/agent_sessions.rs). g1t used to decline each at once; now
-- it keeps it here, shows it on the session's page and in Needs attention,
-- and declines it only when nobody answered in time (APPROVAL_WAIT_MS).
-- A new table only: the code already running never reads it.
--
-- `session_id` is g1t's session at the top of the tree (ses_…);
-- `tool_use_id` the call's event id with Anthropic (sevt_…), which an
-- answer names. `started_by` is the id of whoever started the session.
-- `summary` is the call in one line as the transcript shows it, secrets
-- hidden, never its whole input. `answered_by` is a username.
CREATE TABLE agent_approvals (
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  repo TEXT NOT NULL,
  item INTEGER,
  started_by TEXT NOT NULL,
  started_by_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- waiting, allowed, denied, expired or ended.
  status TEXT NOT NULL DEFAULT 'waiting',
  answered_by TEXT,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE INDEX agent_approvals_waiting ON agent_approvals (workspace, status, asked_at);
