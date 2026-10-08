-- Shared invite links: one link staff hand to a group (a conference's
-- judges, a post, a community) that makes up to max_uses new accounts,
-- until it expires or is revoked. Each use makes a new account, which makes
-- its own workspace; a shared link never joins an existing one and uses
-- nobody's allowance. Every timestamp is RFC 3339 UTC. See
-- src/shared_invites.rs. Safe to apply twice.

CREATE TABLE IF NOT EXISTS shared_invites (
  id TEXT PRIMARY KEY,
  -- Whom it is for, such as `Cloudflare judges`. Not secret: the sign-up
  -- page shows it.
  label TEXT NOT NULL,
  -- As invites.code_hash: SHA-256 of the code's 32 characters. The code
  -- itself is never stored.
  code_hash TEXT NOT NULL UNIQUE,
  -- The code's first group, such as `g1t-k7m2`.
  hint TEXT NOT NULL,
  -- AES-256-GCM under IDENTITY_KEY, bound to the id, so staff can copy
  -- the link again. Null when no key is set, and once it is revoked or
  -- every use is taken.
  sealed_code TEXT,
  max_uses INTEGER NOT NULL,
  -- Email domains it is limited to, lowercase, comma separated. Null for
  -- any address.
  domains TEXT,
  -- The staff member who made it, by email.
  staff TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS shared_invites_created ON shared_invites (created_at);

-- One row per account a shared link made: how many uses are taken (its
-- count, checked in the same statement that adds one), and where the
-- account came from. Kept when the account is purged, so a purge never
-- gives a use back.
CREATE TABLE IF NOT EXISTS shared_invite_uses (
  user_id TEXT PRIMARY KEY,
  shared_invite_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_invite_uses_invite ON shared_invite_uses (shared_invite_id, created_at);
