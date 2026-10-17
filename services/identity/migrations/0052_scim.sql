-- SCIM: a workspace's identity provider says who is assigned to it, so
-- only they sign in through its single sign-on, and someone unassigned
-- leaves the workspace at once. Every timestamp is RFC 3339 UTC. See
-- src/sso.rs and src/sso/scim.rs.

-- The workspace's SCIM token, which its provider sends as a bearer token:
-- one at a time, kept as its SHA-256. With none, SCIM is off.
CREATE TABLE scim_tokens (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  -- Its last four characters, for telling tokens apart.
  hint TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- The people the provider has assigned to the workspace, as it describes
-- them. Not g1t accounts: linked to one (user_id) when that person signs
-- in through single sign-on as them.
CREATE TABLE scim_users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- userName as sent, and lowercased to find it by.
  user_name TEXT NOT NULL,
  user_name_key TEXT NOT NULL,
  external_id TEXT,
  -- The rest of the user, as JSON (src/sso/scim.rs ScimUser).
  resource TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_name_key)
);

CREATE INDEX scim_users_by_person ON scim_users (workspace_id, user_id);
