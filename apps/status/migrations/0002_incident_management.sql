-- Incident management: severity, a lifecycle with timestamps, each part's
-- impact, roles, an internal timeline beside the public updates,
-- follow-ups, postmortems, scheduled maintenance, email subscribers,
-- detection streaks, and an audit log of every staff change.
--
-- Idempotent: every table and index is made only if missing, and the
-- incidents posted before this (the `incidents` and `incident_updates`
-- tables of 0001) are copied in with INSERT OR IGNORE, so running it
-- again changes nothing. The 0001 tables are left in place, unused, and
-- can be dropped by a later migration.

CREATE TABLE IF NOT EXISTS incident (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  status TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  -- draft: not on the status page yet (detected, or saved); dismissed: a
  -- draft closed as a false alarm, never shown.
  visibility TEXT NOT NULL CHECK (visibility IN ('draft', 'public', 'dismissed')),
  source TEXT NOT NULL CHECK (source IN ('declared', 'detected')),
  -- When the impact began; declared_at is when staff (or the checks) said so.
  started_at TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  acknowledged_at TEXT,
  mitigated_at TEXT,
  resolved_at TEXT,
  published_at TEXT,
  commander TEXT,
  communications TEXT,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_started ON incident (started_at);
CREATE INDEX IF NOT EXISTS incident_open ON incident (resolved_at, visibility);

-- What an incident does to each part, while it is open.
CREATE TABLE IF NOT EXISTS incident_component (
  incident_id TEXT NOT NULL,
  component TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('operational', 'degraded', 'partial_outage', 'major_outage')),
  PRIMARY KEY (incident_id, component)
);

-- Everything that happened, in order: public updates (public = 1, what
-- the status page shows) and, for staff only, notes and every change.
CREATE TABLE IF NOT EXISTS incident_timeline (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  kind TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  text TEXT NOT NULL,
  -- Subscribers emailed about it; null when none were.
  notified INTEGER
);
CREATE INDEX IF NOT EXISTS incident_timeline_incident ON incident_timeline (incident_id, at);
CREATE INDEX IF NOT EXISTS incident_timeline_public ON incident_timeline (public, at);

CREATE TABLE IF NOT EXISTS incident_followup (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner TEXT,
  done_at TEXT,
  done_by TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_followup_incident ON incident_followup (incident_id, created_at);

CREATE TABLE IF NOT EXISTS postmortem (
  incident_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '',
  root_cause TEXT NOT NULL DEFAULT '',
  went_well TEXT NOT NULL DEFAULT '',
  went_badly TEXT NOT NULL DEFAULT '',
  action_items TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  published_at TEXT,
  published_by TEXT
);

CREATE TABLE IF NOT EXISTS maintenance (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  -- A JSON array of component keys.
  components TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  -- Whether subscribers hear about it when it starts and ends.
  notify INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS maintenance_window ON maintenance (state, starts_at);

CREATE TABLE IF NOT EXISTS maintenance_update (
  id TEXT PRIMARY KEY,
  maintenance_id TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  text TEXT NOT NULL,
  notified INTEGER
);
CREATE INDEX IF NOT EXISTS maintenance_update_maintenance ON maintenance_update (maintenance_id, at);

-- Email subscribers. Only hashes of tokens are kept: confirm_hash is the
-- SHA-256 of the confirmation link's token; unsubscribe links are signed
-- with STATUS_SECRET and not stored. `components` is a JSON array of keys,
-- or null for everything; `pending_components` is what the unconfirmed
-- request asked for, applied on confirming.
CREATE TABLE IF NOT EXISTS subscriber (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  components TEXT,
  pending_components TEXT,
  confirm_hash TEXT,
  confirm_expires_at TEXT,
  confirm_sent_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriber_confirm ON subscriber (confirm_hash);

-- A part's current run of failed or slow checks, for detection.
CREATE TABLE IF NOT EXISTS streak (
  component TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  count INTEGER NOT NULL,
  since TEXT NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0
);

-- Every staff change, with who made it; sudo's audit log reads it.
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);

-- The incidents posted before this migration.
INSERT OR IGNORE INTO incident
  (id, title, severity, status, visibility, source, started_at, declared_at, acknowledged_at, mitigated_at, resolved_at, published_at, created_by)
SELECT id, title, CASE impact WHEN 'down' THEN 'sev2' ELSE 'sev3' END, status, 'public', 'declared',
  started_at, started_at, started_at, resolved_at, resolved_at, started_at, created_by
FROM incidents;

INSERT OR IGNORE INTO incident_component (incident_id, component, impact)
SELECT i.id, j.value, CASE i.impact WHEN 'down' THEN 'major_outage' ELSE 'partial_outage' END
FROM incidents i, json_each(i.components) j;

INSERT OR IGNORE INTO incident_timeline (id, incident_id, at, by, kind, public, status, text)
SELECT id, incident_id, at, by, 'update', 1, status, message FROM incident_updates;
