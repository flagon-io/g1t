-- The status page's own record: each part's last check, a day-by-day
-- tally for the 90-day bars, and incidents posted from sudo.

-- Each part at its last check.
CREATE TABLE current (
  component TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  detail TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at TEXT NOT NULL
);

-- One row per part per UTC day: how many checks, and how they went.
-- Rows older than 90 days are deleted as checks run.
CREATE TABLE daily (
  component TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  latency_total INTEGER NOT NULL DEFAULT 0,
  latency_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (component, day)
);
CREATE INDEX daily_day ON daily (day);

-- When the parts were last checked, as a whole.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('degraded', 'down')),
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  -- A JSON array of component keys.
  components TEXT NOT NULL,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  created_by TEXT NOT NULL
);
CREATE INDEX incidents_started ON incidents (started_at);

CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents (id),
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE INDEX incident_updates_incident ON incident_updates (incident_id, at);
