-- Settings staff change in sudo, without a deploy. One row per key; a key
-- with no row falls back to the service's vars. Today only
-- `registration_mode` (`open` or `invite`): see src/invites/waitlist.rs.
CREATE TABLE IF NOT EXISTS identity_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  -- The staff member's email.
  set_by TEXT NOT NULL,
  -- RFC 3339 UTC.
  set_at TEXT NOT NULL
);
