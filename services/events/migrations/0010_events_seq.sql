-- The order the log wrote events in. Ids are made when an event is
-- published, on whichever Worker published it, and events reach the log
-- through a queue, so an event can be written after one with a later id.
-- Following the log with an `after` cursor reads by this instead: what is
-- written later always has a higher number, so a follower never skips one.
-- Each insert takes the highest so far plus one; the log has one writer
-- at a time. Events written before this have none and are not followed.
ALTER TABLE events ADD COLUMN seq INTEGER;
CREATE INDEX IF NOT EXISTS events_seq ON events (seq);
CREATE INDEX IF NOT EXISTS events_repo_seq ON events (repo_id, seq);
