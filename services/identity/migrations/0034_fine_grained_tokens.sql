-- Fine-grained personal access tokens, and each workspace's rules for the
-- tokens that reach it. This reverses 0023, which retired a token's reach
-- to some workspaces or repositories: the owner chose GitHub's model, with
-- classic tokens (reaching whatever their owner can, narrowed by scopes)
-- and fine-grained ones (one resource owner, some of its repositories, a
-- level for each permission) side by side. See src/token_reach.rs.
--
-- Nothing existing changes: every column is null on today's tokens, which
-- read as classic (personal) or as a workspace's token with Write.

-- `fine_grained` for a fine-grained token; null for a classic one, a
-- workspace's own token, a job's token and an agent's.
ALTER TABLE access_tokens ADD COLUMN kind TEXT;
-- A fine-grained token's resource owner: a workspace's id, or null for the
-- person's own account.
ALTER TABLE access_tokens ADD COLUMN owner_workspace_id TEXT;
-- all | selected | public, for a fine-grained token.
ALTER TABLE access_tokens ADD COLUMN repository_selection TEXT;
-- A fine-grained token's permissions as JSON, `{"contents": "write"}`.
-- Its `scopes` are what they map to, and are what every check reads.
ALTER TABLE access_tokens ADD COLUMN permissions TEXT;
-- What it is for, as its owner wrote it.
ALTER TABLE access_tokens ADD COLUMN description TEXT;
-- A fine-grained token aimed at a workspace that asks for approval:
-- pending until an owner approves it, then active; denied or revoked by an
-- owner. Null is active. Only an active one reaches the workspace.
ALTER TABLE access_tokens ADD COLUMN status TEXT;
-- Who reviewed or revoked it, when, and why.
ALTER TABLE access_tokens ADD COLUMN reviewed_by TEXT;
ALTER TABLE access_tokens ADD COLUMN reviewed_at TEXT;
ALTER TABLE access_tokens ADD COLUMN review_reason TEXT;
-- 1 on a workspace's own token an owner gave Admin when making it. Every
-- other workspace token has Write on the workspace's repositories.
ALTER TABLE access_tokens ADD COLUMN admin INTEGER;
CREATE INDEX access_tokens_owner_workspace ON access_tokens (owner_workspace_id) WHERE owner_workspace_id IS NOT NULL;

-- The repositories a fine-grained token with `selected` reaches, by id, so
-- renames and transfers within the workspace keep them.
CREATE TABLE token_repositories (
  token_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  PRIMARY KEY (token_id, repo_id)
);

-- A workspace's rules for personal access tokens. No row: the defaults
-- (both kinds allowed, fine-grained tokens need an owner's approval, no
-- lifetime limit beyond a fine-grained token's 366 days).
CREATE TABLE token_policies (
  workspace_id TEXT PRIMARY KEY,
  -- Whether classic tokens reach the workspace: 1 or 0.
  allow_classic INTEGER NOT NULL DEFAULT 1,
  -- Whether fine-grained tokens may name it as their resource owner.
  allow_fine_grained INTEGER NOT NULL DEFAULT 1,
  -- Whether a fine-grained token naming it waits for an owner's approval.
  require_approval INTEGER NOT NULL DEFAULT 1,
  -- The longest a token reaching it may last, in days; null: no limit.
  max_lifetime_days INTEGER,
  -- 1: a token that never expires does not reach it.
  forbid_no_expiry INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT
);

-- A classic token an owner took out of their workspace: it keeps working
-- elsewhere, and never reaches this workspace again.
CREATE TABLE token_workspace_revocations (
  token_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (token_id, workspace_id)
);
