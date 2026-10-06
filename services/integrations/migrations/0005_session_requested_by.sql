-- The person a run is for, by username: who asked g1t for the work. The
-- model proxy reports each run's tokens under them, for usage views. Null
-- when nobody asked, and never g1t's own agent.
ALTER TABLE model_sessions ADD COLUMN requested_by TEXT;
