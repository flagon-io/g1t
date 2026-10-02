-- Sign-in for agents and command-line tools (RFC 8628). The tool shows a
-- person a short code; the person approves it in a browser; the tool then
-- collects an access token.
--
-- Timestamps are RFC 3339 UTC text, which sorts and compares as text.
CREATE TABLE device_codes (
  -- SHA-256 of the device code the tool holds.
  id TEXT PRIMARY KEY,
  -- What the person types or sees, e.g. WDJB-MJHT.
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  -- 'pending', 'approved' or 'denied'
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
