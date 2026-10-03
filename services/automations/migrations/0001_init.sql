-- Automations, read from repositories' .g1t/automations, and their runs.
-- Every timestamp is RFC 3339 UTC.

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  -- owner/name.
  repo TEXT NOT NULL,
  -- The file it comes from.
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The file as it is on the default branch.
  source TEXT NOT NULL,
  -- events, schedule, manual, or invalid.
  trigger_kind TEXT NOT NULL,
  -- For events: the types that start it, as a JSON array.
  events TEXT NOT NULL,
  -- Why the file cannot be used, if it cannot.
  error TEXT,
  -- Kept across reloads of the file: a member can turn one off.
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, path)
);
CREATE INDEX automations_by_trigger ON automations (repo_id, enabled, trigger_kind);
CREATE INDEX automations_scheduled ON automations (trigger_kind, enabled);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  -- What started it, unique per automation: an event's id, the minute of a
  -- schedule, or a manual run's own key. An event runs an automation once.
  event_key TEXT NOT NULL,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  number INTEGER,
  -- running, succeeded, failed or skipped.
  status TEXT NOT NULL,
  reason TEXT,
  -- Each step's result, as JSON.
  steps TEXT NOT NULL,
  actor TEXT,
  started_at TEXT NOT NULL,
  UNIQUE (automation_id, event_key)
);
CREATE INDEX runs_by_repo ON runs (repo_id, id);
CREATE INDEX runs_by_automation ON runs (automation_id, id);

-- What an automation just touched, so it does not answer its own doing.
CREATE TABLE effects (
  automation_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX effects_recent ON effects (automation_id, repo_id, number, at);

-- Repositories whose files have been read at least once.
CREATE TABLE synced (
  repo_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
