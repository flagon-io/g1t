-- Two-factor authentication for accounts (src/two_factor.rs): an
-- authenticator app's TOTP secret (RFC 6238), recovery codes, and the
-- sign-ins waiting for a code. Every timestamp is RFC 3339 UTC.

-- One per account. `secret` is sealed with IDENTITY_KEY, bound to the
-- account's id (g1t_secrets::Sealer). Until `enabled_at` is set it is an
-- enrolment in progress, which a code from the app confirms.
CREATE TABLE IF NOT EXISTS two_factor (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enabled_at TEXT,
  created_at TEXT NOT NULL,
  -- The last 30-second step a code was accepted for: a code is never
  -- accepted twice, nor one older than the last used.
  last_step INTEGER NOT NULL DEFAULT 0
);

-- Ten single-use codes for when the app is lost, each kept as its
-- SHA-256. Made again, all ten are replaced.
CREATE TABLE IF NOT EXISTS two_factor_recovery (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

-- A sign-in that gave the right password and waits for a code. Its id is
-- the SHA-256 of the token the site holds for it; it lasts ten minutes
-- and a few wrong codes.
CREATE TABLE IF NOT EXISTS two_factor_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS two_factor_challenges_user ON two_factor_challenges (user_id);
