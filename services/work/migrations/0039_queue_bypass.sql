-- Whether the person who queued a pull request asked to bypass the rules
-- they may bypass. Landing re-evaluates the current rules (and who may
-- bypass them now) against the tested commit, honouring the same request.
ALTER TABLE queue_entries ADD COLUMN bypass_rules INTEGER NOT NULL DEFAULT 0;
