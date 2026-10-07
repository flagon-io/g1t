-- Where a workspace keeps its repositories' git data (docs/ARTIFACTS.md,
-- R7): NULL for anywhere g1t stores it, 'eu' for the EU only. Set by an
-- owner in the workspace's settings (`set_workspace_residency`), offered
-- only once the repos service has an EU namespace (`storage_options`). The
-- repos service reads it as it places a new repository; repositories made
-- before a change stay where they are. Additive; every workspace starts
-- as anywhere, as today.
ALTER TABLE workspaces ADD COLUMN data_residency TEXT;
