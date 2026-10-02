ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

-- Accounts that existed before verification was required.
UPDATE users SET email_verified_at = unixepoch();

-- One-time links sent by email. id is the SHA-256 of the token in the link.
CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'verify' or 'reset'
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, kind);
