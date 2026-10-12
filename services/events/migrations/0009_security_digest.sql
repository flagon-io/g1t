-- Security alerts the way people can live with (src/inbox.rs, src/security_digest.rs):
-- what each person chose about them, and what waits for their next digest.

-- Whether critical and high alerts on repositories they watch for security
-- reach them at once (1, the default when null), and when the rest do:
-- daily (the default when null), weekly, at_once or off.
ALTER TABLE inbox_settings ADD COLUMN security_alerts INTEGER;
ALTER TABLE inbox_settings ADD COLUMN security_digest TEXT;

-- One row per person per scan summary that waits for their digest: what
-- the scan opened, by severity (JSON SeverityCounts), its headline and
-- where the alerts are. The digest reads a person's rows, writes one inbox
-- item per workspace, emails it, and deletes them.
CREATE TABLE inbox_security_digest (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  workspace TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  -- secret_scanning | code_scanning | vulnerability
  alert_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  opened INTEGER NOT NULL,
  counts TEXT NOT NULL,
  worst TEXT,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, username)
);
CREATE INDEX inbox_security_digest_user ON inbox_security_digest (username, created_at);
