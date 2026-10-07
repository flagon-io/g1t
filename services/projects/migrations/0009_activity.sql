-- When a project's repository was last pushed to, and how active it is
-- lately, so a workspace's projects sort by either (src/activity.ts).
-- Null and 0 until something happens.
ALTER TABLE projects ADD COLUMN pushed_at TEXT;
ALTER TABLE projects ADD COLUMN active_at TEXT;
ALTER TABLE projects ADD COLUMN activity REAL NOT NULL DEFAULT 0;
