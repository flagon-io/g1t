-- Identity now owns only accounts and credentials, with prefixed text ids.
-- Repositories moved to the repos service.
DROP TABLE repos;
DROP TABLE sessions;
DROP TABLE access_tokens;
DROP TABLE ssh_keys;

ALTER TABLE users RENAME TO users_old;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO users (id, username, email, password_hash, created_at)
SELECT 'usr_' || lower(hex(randomblob(13))), username, email, password_hash, created_at
FROM users_old;

DROP TABLE users_old;

-- id is the SHA-256 of the session token.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX access_tokens_user ON access_tokens (user_id);

CREATE TABLE ssh_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ssh_keys_user ON ssh_keys (user_id);
