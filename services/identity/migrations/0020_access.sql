-- Repository roles: each workspace's base permission, roles given on one
-- repository, and invitations to collaborate on one. Every timestamp is
-- RFC 3339 UTC. See src/access.rs and crates/contracts/src/access.rs.
-- Wrangler applies it once; the tables and indexes also say IF NOT EXISTS,
-- so running them again changes nothing (the ALTER, like 0019's, is the
-- one statement that must run once).

-- What every member gets on each of the workspace's repositories: none,
-- read, write or admin. Owners have admin whatever it says. Write is what
-- members could do before roles.
ALTER TABLE workspaces ADD COLUMN base_permission TEXT NOT NULL DEFAULT 'write';

-- A role on one repository, given to a principal directly. Today the
-- principal is always a person (principal_kind 'user'); a team will be
-- another kind, resolved into its people's roles when they sign in.
CREATE TABLE IF NOT EXISTS repo_grants (
  -- The repository, by the repos service's id: renames and transfers
  -- never change it.
  repo_id TEXT NOT NULL,
  -- 'user' (later: 'team').
  principal_kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- The workspace the repository is in now, and its name there, kept in
  -- step by transfer_repo_scopes, so lists need no call to repos.
  workspace_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  -- read, triage, write, maintain or admin.
  role TEXT NOT NULL,
  -- Who gave it, by user id. Null when it came from an invite code.
  granted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, principal_kind, principal_id)
);
CREATE INDEX IF NOT EXISTS repo_grants_principal ON repo_grants (principal_kind, principal_id);
CREATE INDEX IF NOT EXISTS repo_grants_workspace ON repo_grants (workspace_id, repo_name);

-- An invitation to collaborate on one repository: to a person with an
-- account, who accepts or declines it, or to an address without one, by
-- an invite code (invites.invite_id) that makes the account and accepts.
CREATE TABLE IF NOT EXISTS repo_invitations (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  -- The person invited, when they have an account.
  invitee_id TEXT,
  -- The address invited, lowercase, when they had none.
  email TEXT,
  -- The invite code sent to that address (invites.id).
  invite_id TEXT,
  role TEXT NOT NULL,
  inviter_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  declined_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS repo_invitations_repo ON repo_invitations (repo_id, created_at);
CREATE INDEX IF NOT EXISTS repo_invitations_invitee ON repo_invitations (invitee_id, created_at);
CREATE INDEX IF NOT EXISTS repo_invitations_invite ON repo_invitations (invite_id);
CREATE INDEX IF NOT EXISTS repo_invitations_email ON repo_invitations (email);
