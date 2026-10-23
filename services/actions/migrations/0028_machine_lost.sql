-- How many times a job on g1t's machines lost its machine after it had
-- reported, and went back in the queue for another (src/lib.rs
-- `runs_again_when_lost`): once at most, so a second loss fails it. A job
-- run again starts from 0.
ALTER TABLE jobs ADD COLUMN machine_lost INTEGER NOT NULL DEFAULT 0;
