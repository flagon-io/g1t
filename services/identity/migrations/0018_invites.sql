-- Invite-only registration: invite codes, the extra invites staff grant,
-- the waitlist, and the counters that rate-limit them. Every timestamp is
-- RFC 3339 UTC. See src/invites.rs. Safe to apply twice.

-- One invite code. The code itself is never stored: only its SHA-256, to
-- find it, and a copy sealed under IDENTITY_KEY that the person who made it
-- can see again while it is pending.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  -- SHA-256 of the code's 32 characters, lowercase, without `g1t-` or
  -- hyphens.
  code_hash TEXT NOT NULL UNIQUE,
  -- The code's first group, such as `g1t-k7m2`: enough to recognise it,
  -- far too little to use it.
  hint TEXT NOT NULL,
  -- AES-256-GCM under IDENTITY_KEY, bound to the id. Null when no key is
  -- set, and once the invite is used, revoked or expired.
  sealed_code TEXT,
  -- When set, only an account with this address (lowercase) can use it.
  email TEXT,
  -- account: makes a new account (and joins workspace_id, if set).
  -- workspace: an existing account joins workspace_id; it never makes one.
  kind TEXT NOT NULL,
  -- The workspace using it joins, if any.
  workspace_id TEXT,
  -- The person who made it. Null when staff minted it in sudo.
  inviter_id TEXT,
  -- The staff member who minted or approved it, by email.
  staff TEXT,
  -- Whose allowance it uses: user (inviter_id's), workspace
  -- (charged_workspace_id's, granted by staff), or none.
  charged_to TEXT NOT NULL,
  charged_workspace_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  -- The account that used it: for new accounts, the "invited by" tree.
  redeemed_by TEXT,
  redeemed_at TEXT
);
CREATE INDEX IF NOT EXISTS invites_inviter ON invites (inviter_id, created_at);
CREATE INDEX IF NOT EXISTS invites_workspace ON invites (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS invites_charged_workspace ON invites (charged_workspace_id);
CREATE INDEX IF NOT EXISTS invites_redeemed_by ON invites (redeemed_by);
CREATE INDEX IF NOT EXISTS invites_email ON invites (email);
CREATE INDEX IF NOT EXISTS invites_hint ON invites (hint);

-- Invites staff granted beyond the default allowance (INVITES_PER_USER):
-- to a person, or to a workspace, whose owners share them. A negative
-- amount takes some back.
CREATE TABLE IF NOT EXISTS invite_grants (
  id TEXT PRIMARY KEY,
  -- user or workspace.
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT,
  -- The staff member, by email.
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_grants_target ON invite_grants (target_kind, target_id);

-- People asking for access while registration is invite-only. One row per
-- address; asking again updates it.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  -- What they said they will build, if anything.
  about TEXT,
  -- waiting, invited or dismissed.
  status TEXT NOT NULL,
  -- The invite staff sent when approving.
  invite_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_status ON waitlist (status, created_at);

-- Fixed-window counters: `key` such as `invite.create:usr_…`, `bucket` the
-- window's number since the epoch.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  bucket INTEGER NOT NULL,
  hits INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_bucket ON rate_limits (bucket);
