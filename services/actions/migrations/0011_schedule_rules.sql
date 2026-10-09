-- Schedules pause in a repository with no push for 60 days, and wait an
-- hour after billing refused to start one of the workflow's scheduled jobs.

-- When the repository last had a push, at a day's resolution; written on
-- pushes to repositories with a scheduled workflow. Workflows already here
-- start counting now.
ALTER TABLE workflows ADD COLUMN pushed_at TEXT;
UPDATE workflows SET pushed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE crons != '[]';

-- Until when its schedule waits: set when billing refused a job of one of
-- its scheduled runs.
ALTER TABLE workflows ADD COLUMN schedule_refused_until TEXT;
