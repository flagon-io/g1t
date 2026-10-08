-- A new account confirms its address before it can do anything on g1t,
-- by typing the code from its confirmation email or following the link in
-- the same email (src/emails.rs).

-- The code sent with a confirmation link: an HMAC of it, never the code.
-- One row holds both, so using either deletes the row and ends both.
ALTER TABLE email_tokens ADD COLUMN code_hash TEXT;

-- When what an invite gives was applied: the workspace it joins, and the
-- repository invitations sent with it. An invite used to sign up is spent
-- (redeemed_at) at once, but applied only when the new account confirms
-- its address, in the same transaction. Null on a redeemed invite means
-- it is waiting for that.
ALTER TABLE invites ADD COLUMN applied_at TEXT;

-- Every invite used before now was applied when it was used.
UPDATE invites SET applied_at = redeemed_at WHERE redeemed_at IS NOT NULL;

CREATE INDEX invites_awaiting ON invites (redeemed_by) WHERE redeemed_at IS NOT NULL AND applied_at IS NULL;
