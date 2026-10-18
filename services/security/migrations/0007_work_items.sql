-- Issues became work items of the workspace (g1t #57). What g1t opened
-- for an upgrade, and what it was put on to fix an alert, is now a work
-- item, by its number in the repository's workspace.
--
-- Until the work service has numbered the moved issues, these columns
-- still hold the old issue numbers of each row's repository: `work.migrated`
-- rewrites them (lib.rs `work_migrated`). Every new number in a workspace
-- is above every old number of its repositories, so a rewritten value is
-- never taken for an old one.
ALTER TABLE updates RENAME COLUMN issue TO item;
ALTER TABLE update_pulls RENAME COLUMN issue TO item;
ALTER TABLE code_alerts RENAME COLUMN issue TO item;
ALTER TABLE alert_fixes RENAME COLUMN issue TO item;
ALTER TABLE upgrades RENAME COLUMN number TO item;
