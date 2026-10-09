-- A repository's events of some types, newest first: the home page's pushes,
-- the overview's feed and the Activity tab. By repository, type and id
-- those are ranges, rather than a walk back through every event the
-- repository ever had.
CREATE INDEX IF NOT EXISTS events_repo_type ON events (repo_id, type, id);
