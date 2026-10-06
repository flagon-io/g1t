-- Days of audit log an account's workspaces keep, set by g1t staff in
-- sudo in place of the plan's (7 free, 90 on the plan). NULL: the plan's.
ALTER TABLE billing_accounts ADD COLUMN audit_retention_days INTEGER;
