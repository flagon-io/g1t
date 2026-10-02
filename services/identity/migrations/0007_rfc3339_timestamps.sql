-- Every timestamp becomes RFC 3339 UTC text (2026-10-02T05:16:19.000Z)
-- instead of Unix seconds. SQLite cannot change a column's type, so each
-- table is rebuilt and its rows converted.
PRAGMA defer_foreign_keys = on;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO users_new (id, username, email, password_hash, email_verified_at, created_at)
SELECT id, username, email, password_hash,
  strftime('%Y-%m-%dT%H:%M:%fZ', email_verified_at, 'unixepoch'),
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch')
FROM users;

-- id is the SHA-256 of the session token.
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
INSERT INTO sessions_new (id, user_id, expires_at)
SELECT id, user_id, strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, 'unixepoch') FROM sessions;

CREATE TABLE access_tokens_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Null means the token does not expire.
  expires_at TEXT
);
INSERT INTO access_tokens_new (id, user_id, name, token_hash, created_at, expires_at)
SELECT id, user_id, name, token_hash,
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch'),
  strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, 'unixepoch')
FROM access_tokens;

CREATE TABLE ssh_keys_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO ssh_keys_new (id, user_id, title, public_key, fingerprint, created_at)
SELECT id, user_id, title, public_key, fingerprint,
  strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch')
FROM ssh_keys;

-- One-time links sent by email. id is the SHA-256 of the token in the link.
CREATE TABLE email_tokens_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'verify' or 'reset'
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO email_tokens_new (id, user_id, kind, expires_at)
SELECT id, user_id, kind, strftime('%Y-%m-%dT%H:%M:%fZ', expires_at, 'unixepoch')
FROM email_tokens;

DROP TABLE sessions;
DROP TABLE access_tokens;
DROP TABLE ssh_keys;
DROP TABLE email_tokens;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE access_tokens_new RENAME TO access_tokens;
ALTER TABLE ssh_keys_new RENAME TO ssh_keys;
ALTER TABLE email_tokens_new RENAME TO email_tokens;

CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;
CREATE INDEX access_tokens_user ON access_tokens (user_id);
CREATE INDEX ssh_keys_user ON ssh_keys (user_id);
CREATE INDEX email_tokens_user ON email_tokens (user_id, kind);
