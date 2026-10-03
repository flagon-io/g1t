-- Webhooks, and every delivery made to them. Every timestamp is RFC 3339 UTC.

CREATE TABLE hooks (
  id TEXT PRIMARY KEY,
  -- repo or workspace.
  scope TEXT NOT NULL,
  -- The workspace's slug.
  workspace TEXT NOT NULL,
  -- For a repository's webhook: its id, and owner/name.
  repo_id TEXT,
  repo TEXT,
  url TEXT NOT NULL,
  -- The event types it is sent, as a JSON array; ["*"] for all.
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  -- The signing secret, sealed with AES-256-GCM under the service's key
  -- and bound to the hook's id.
  secret TEXT NOT NULL,
  secret_hint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_status TEXT,
  last_delivered_at TEXT
);
CREATE INDEX hooks_by_repo ON hooks (repo_id);
CREATE INDEX hooks_by_workspace ON hooks (workspace, scope);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  -- The event delivered, or empty for a ping or a redelivery.
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  -- The JSON sent.
  payload TEXT NOT NULL,
  -- pending, delivered or failed.
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  next_attempt_at TEXT
);
CREATE INDEX deliveries_by_hook ON deliveries (hook_id, id);
CREATE INDEX deliveries_due ON deliveries (status, next_attempt_at);
-- An event is delivered to a webhook once, however often the bus repeats it.
CREATE UNIQUE INDEX deliveries_once ON deliveries (hook_id, event_id) WHERE event_id <> '';

-- Which workspace a repository is in, so a workspace's webhooks find its
-- repositories' events. Filled from repo.created, and on demand.
CREATE TABLE repo_names (
  repo_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  name TEXT NOT NULL
);
