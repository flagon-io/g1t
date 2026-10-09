-- This month's users, read every fifteen minutes for autopay and the limit
-- warnings: usage entries from a date on, by kind and time, and the
-- workspace in the index so the read never touches the ledger itself.
CREATE INDEX IF NOT EXISTS ledger_usage_by_time ON ledger (kind, created_at, workspace);
