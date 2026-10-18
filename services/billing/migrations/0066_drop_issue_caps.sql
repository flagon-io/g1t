-- The caps on what the agents on one issue may spend in all (0018) went
-- with g1t's own agents and nothing reads them; issues are work items now.
ALTER TABLE limits DROP COLUMN issue_cap_micros;
ALTER TABLE billing_accounts DROP COLUMN issue_cap_micros;
