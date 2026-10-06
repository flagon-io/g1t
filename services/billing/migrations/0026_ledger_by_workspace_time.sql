-- The month's usage, the limit and the open-source pool read a workspace's
-- ledger from a date on; by workspace and time those are ranges, not scans.
CREATE INDEX IF NOT EXISTS ledger_by_workspace_time ON ledger (workspace, created_at);
