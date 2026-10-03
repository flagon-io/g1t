-- What g1t needs to see a pull request made by its own agent through to
-- ready-to-merge without anyone pressing a button: checks, review,
-- revision, catching up.

-- What the reviewing agent decided: approve or request_changes. NULL when
-- the review could not be written.
ALTER TABLE review_runs ADD COLUMN verdict TEXT;

-- Set on a pull request a g1t agent opens from now on. Ones made before
-- this existed are left alone, so nothing starts on them unasked.
ALTER TABLE pulls ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
-- How many times the agent has been sent back to revise, and when last.
-- A review from before the last revision no longer counts.
ALTER TABLE pulls ADD COLUMN revisions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pulls ADD COLUMN revised_at TEXT;
-- The step under way (review, revision or catch_up) and when to stop
-- waiting for it. Claiming a step sets these in one statement, so a step
-- is taken once. A push to the pull request clears them.
ALTER TABLE pulls ADD COLUMN working_on TEXT;
ALTER TABLE pulls ADD COLUMN working_until TEXT;
-- Why g1t stopped and is asking a person, if it has.
ALTER TABLE pulls ADD COLUMN stalled TEXT;
