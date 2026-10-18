-- What security keeps by a work item's number also keeps the item's id and
-- workspace, from `work.migrated` (g1t #57): a repository transferred to
-- another workspace still finds the item it had, never the new
-- workspace's item of the same number.
ALTER TABLE updates ADD COLUMN item_id TEXT;
ALTER TABLE updates ADD COLUMN item_workspace TEXT;
ALTER TABLE update_pulls ADD COLUMN item_id TEXT;
ALTER TABLE update_pulls ADD COLUMN item_workspace TEXT;
ALTER TABLE upgrades ADD COLUMN item_id TEXT;
ALTER TABLE upgrades ADD COLUMN item_workspace TEXT;
ALTER TABLE code_alerts ADD COLUMN item_id TEXT;
ALTER TABLE code_alerts ADD COLUMN item_workspace TEXT;
ALTER TABLE alert_fixes ADD COLUMN item_id TEXT;
ALTER TABLE alert_fixes ADD COLUMN item_workspace TEXT;
-- Pages already applied rewrote the numbers without the ids: the cron's
-- catch-up reads the whole map again, and each page fills in the ids of
-- rows already on their new numbers (store.rs `WORK_MIGRATED`).
UPDATE work_catch_up SET cursor = NULL, page = 0, done_at = NULL WHERE name = 'work.migrated';
