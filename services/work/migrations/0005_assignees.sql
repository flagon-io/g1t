-- The people an issue is assigned to: a JSON array of usernames. The agent
-- working on an issue is not stored here; it is whichever agent has a pull
-- request in progress for it.
ALTER TABLE issues ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]';
