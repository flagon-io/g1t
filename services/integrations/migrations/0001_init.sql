-- A workspace's connections to systems outside g1t, and what has crossed
-- between them. Every timestamp is RFC 3339 UTC.

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  -- The workspace's slug.
  workspace TEXT NOT NULL,
  -- anthropic, anthropic_endpoint, sentry, datadog, webhook, jira or linear.
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Everything but its secrets, as JSON.
  config TEXT NOT NULL,
  -- Its key and signing secret, as JSON sealed with AES-256-GCM under the
  -- service's key and bound to the connection's id. Never returned.
  secrets TEXT,
  -- The last four characters of the key, to tell keys apart.
  secret_hint TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  last_error TEXT
);
CREATE INDEX connections_by_workspace ON connections (workspace, id);

-- An issue's tie to something outside g1t: the Sentry issue that opened
-- it, the ticket it was imported from. One per outside thing per
-- connection, so an alert that fires 500 times is one issue.
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- The outside system's own id for it, as its API takes it.
  external_id TEXT NOT NULL,
  -- What people call it: TECH-1234, or a Sentry short id.
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- owner/name.
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- How many times an alert has fired for it, and the count last
  -- mentioned on the issue.
  count INTEGER NOT NULL DEFAULT 1,
  announced INTEGER NOT NULL DEFAULT 1,
  -- Whether the outside system has been told work started on it.
  told_started INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (connection_id, external_id)
);
CREATE INDEX links_by_issue ON links (repo_id, number);

-- Requests outside systems sent, kept so people can see what arrived and
-- what g1t did with it.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  event TEXT NOT NULL,
  -- opened, updated, reopened, ignored or refused.
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL,
  -- owner/name#number, when it opened or updated an issue.
  issue TEXT
);
CREATE INDEX deliveries_by_connection ON deliveries (connection_id, id);

-- One run's model traffic: what the token a sandbox holds stands for.
CREATE TABLE model_sessions (
  -- SHA-256 of the token.
  token_hash TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  -- The workspace's own model connection, or null for g1t's.
  connection_id TEXT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  task TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX model_sessions_by_expiry ON model_sessions (expires_at);
