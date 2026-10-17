-- Single sign-on: a workspace's own identity provider, over OpenID
-- Connect, OAuth 2.0 or SAML 2.0, on any paid plan. People sign in to g1t
-- as themselves, then prove themselves to the workspace's provider to use
-- the workspace; it never signs anyone in to g1t. Every timestamp is RFC
-- 3339 UTC. See src/sso.rs.

-- A workspace's connection to its identity provider: one each.
CREATE TABLE sso_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces (id) ON DELETE CASCADE,
  -- oidc, oauth2 or saml.
  protocol TEXT NOT NULL,
  -- What the protocol needs, as JSON: issuer and client id (oidc); the
  -- authorize, token and userinfo endpoints and claim names (oauth2); the
  -- provider's entity id, sign-in URL and signing certificates (saml).
  config TEXT NOT NULL,
  -- The client secret (oidc, oauth2), sealed with AES-256-GCM under
  -- IDENTITY_KEY and bound to the connection's id. Never read back out.
  client_secret TEXT,
  -- Whether anyone the provider signs in may join as a member.
  allow_join INTEGER NOT NULL DEFAULT 1,
  -- When someone first signed in through it, and who: required before it
  -- can be required of members.
  tested_at TEXT,
  tested_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Members of a workspace that requires single sign-on use it only from a
-- session that signed in through its provider (owners always can, so a
-- broken provider never locks a workspace out). Read with the memberships.
ALTER TABLE workspaces ADD COLUMN require_sso INTEGER NOT NULL DEFAULT 0;

-- Who a person is at a workspace's provider: its subject, linked to their
-- g1t account the first time they sign in through it. One each way.
CREATE TABLE sso_identities (
  connection_id TEXT NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The provider's stable id for the person (`sub`, or SAML's NameID).
  subject TEXT NOT NULL,
  -- The address the provider gave, for showing; never used to sign in.
  email TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, user_id),
  UNIQUE (connection_id, subject)
);

-- A g1t session that signed in through a workspace's provider, until it
-- has to again.
CREATE TABLE sso_sessions (
  -- SHA-256 of the session token, as sessions.id.
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (session_id, workspace_id)
);

-- A trip to the provider under way: usable once, for ten minutes. Bound to
-- the session that started it, so what comes back counts for it alone.
CREATE TABLE sso_states (
  -- SHA-256 of the OAuth state, or SAML's request id.
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- The PKCE verifier and OpenID nonce (oidc, oauth2).
  verifier TEXT,
  nonce TEXT,
  -- Exactly the callback (or SAML's assertion consumer service) sent.
  redirect_uri TEXT NOT NULL,
  -- SAML: the entity id g1t named itself, which the assertion's audience
  -- must be.
  audience TEXT,
  next TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
