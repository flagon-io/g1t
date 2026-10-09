-- Workspace invitations are answered: nobody joins a workspace without
-- saying yes. An invite that names a workspace (invites.workspace_id) is a
-- workspace invitation for one account, which accepts or declines it
-- (src/invites.rs, `accept_invitation` and `decline_invitation`). An
-- account invite that names one makes the account first; the invitation
-- waits for its answer once the account confirms its address.

-- The account it is for: the one invited by username or address, or the
-- one the invite made. Null until there is one.
ALTER TABLE invites ADD COLUMN invitee_id TEXT;
-- The role accepting joins with: member or owner. Null is member.
ALTER TABLE invites ADD COLUMN role TEXT;
-- The answer, RFC 3339 UTC. At most one is set.
ALTER TABLE invites ADD COLUMN accepted_at TEXT;
ALTER TABLE invites ADD COLUMN declined_at TEXT;

-- Every invite used before now is for the account that used it, and one
-- that named a workspace and was applied joined it then: accepted.
UPDATE invites SET invitee_id = redeemed_by WHERE invitee_id IS NULL AND redeemed_by IS NOT NULL;
UPDATE invites SET accepted_at = applied_at
  WHERE accepted_at IS NULL AND workspace_id IS NOT NULL AND applied_at IS NOT NULL;
-- A pending invitation already sent to an existing account's confirmed
-- address is for that account, so it shows among its invitations.
UPDATE invites SET invitee_id = (
    SELECT e.user_id FROM user_emails e WHERE e.email = invites.email AND e.verified_at IS NOT NULL LIMIT 1)
  WHERE invitee_id IS NULL AND kind = 'workspace' AND email IS NOT NULL AND redeemed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invites_invitee ON invites (invitee_id)
  WHERE workspace_id IS NOT NULL AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;
