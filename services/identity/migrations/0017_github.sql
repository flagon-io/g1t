-- Signing in with GitHub, through g1t's GitHub App. Every timestamp is
-- RFC 3339 UTC. See src/github.rs.

-- A person's linked GitHub account, one each way. A GitHub account is
-- known by its numeric id: its login can change, and is kept for showing.
CREATE TABLE github_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  -- The app's user access and refresh tokens, as JSON sealed with
  -- AES-256-GCM under IDENTITY_KEY and bound to the account. Null when g1t
  -- holds none: never stored, refresh failed, or the person revoked it.
  -- Opaque text of any length.
  tokens TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A trip to GitHub under way: usable once, for ten minutes.
CREATE TABLE github_states (
  -- SHA-256 of the state, which the browser also holds in a cookie.
  id TEXT PRIMARY KEY,
  -- The PKCE code verifier; GitHub was sent its S256 challenge.
  verifier TEXT NOT NULL,
  -- sign_in or link.
  purpose TEXT NOT NULL,
  -- The account that asked to link.
  user_id TEXT,
  -- Exactly the redirect_uri GitHub was sent, sent again with the code.
  redirect_uri TEXT NOT NULL,
  next TEXT NOT NULL,
  -- An invite code for a new account, while g1t is invite-only.
  invite_code TEXT,
  expires_at TEXT NOT NULL
);

-- A GitHub sign-in waiting on the person: to pick a username (kind
-- username), or to sign in to the account that has its email (kind link).
-- For thirty minutes.
CREATE TABLE github_pending (
  -- SHA-256 of the token the browser holds in a cookie.
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  -- Its verified primary email.
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  suggestion TEXT,
  -- Sealed as in github_accounts, bound to this row's id.
  tokens TEXT,
  next TEXT NOT NULL,
  invite_code TEXT,
  expires_at TEXT NOT NULL
);
