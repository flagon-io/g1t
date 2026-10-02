-- OAuth 2.1 sign-in for applications, such as MCP clients.
-- Clients are not stored: a client id carries its own name and redirect
-- addresses, so registering one writes nothing.

CREATE TABLE oauth_codes (
  -- SHA-256 of the authorization code.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  -- PKCE, method S256.
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- One per application a person has signed in to.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  -- SHA-256 of the current refresh token; replaced on every use.
  refresh_hash TEXT UNIQUE,
  -- The access token issued with it, revoked when the grant is refreshed.
  access_token_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX oauth_grants_by_user ON oauth_grants (user_id);
