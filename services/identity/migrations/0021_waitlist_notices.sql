-- Telling people about the waitlist: the person who asked gets one
-- confirmation, staff get a summary of new requests at most every 15
-- minutes, and an approval can carry a note into the invite email. Every
-- timestamp is RFC 3339 UTC. See src/invites.rs.

-- When the confirmation went to the address. Null: not sent (requests from
-- before this migration, or sending failed).
ALTER TABLE waitlist ADD COLUMN acknowledged_at TEXT;
-- When staff were told about the request. Null: not yet; the next summary
-- includes it.
ALTER TABLE waitlist ADD COLUMN notified_at TEXT;
-- What staff wrote when approving, sent in the invite email.
ALTER TABLE waitlist ADD COLUMN note TEXT;

-- Requests from before this: staff already see them in sudo, so no summary
-- repeats them.
UPDATE waitlist SET notified_at = updated_at WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS waitlist_status_created ON waitlist (status, created_at);
CREATE INDEX IF NOT EXISTS waitlist_unnotified ON waitlist (notified_at) WHERE notified_at IS NULL;
