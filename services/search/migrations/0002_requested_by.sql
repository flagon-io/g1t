-- g1t is the author of the pull requests it makes and the issues its
-- agent files; the person who asked for the work is kept beside it, as
-- the work service now stores it (its 0025_requested_by).
ALTER TABLE items ADD COLUMN requested_by TEXT;

-- Items indexed before name the person who asked as their author. Running
-- the backfill again reindexes every repository's issues and pull
-- requests as they are stored now; its code is compared with the index
-- and only what differs is read.
DELETE FROM meta WHERE key = 'backfill';
