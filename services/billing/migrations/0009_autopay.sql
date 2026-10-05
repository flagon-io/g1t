-- Paying automatically at the limit: when a workspace with a card on file
-- nears its ceiling, g1t charges the card for what is owed instead of
-- stopping its work. A declined card stops work until it is paid. See
-- `autopay` in src/limits.rs.
ALTER TABLE limits ADD COLUMN autopay_failed_at TEXT;
ALTER TABLE limits ADD COLUMN autopay_error TEXT;
