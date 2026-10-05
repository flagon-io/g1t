-- What a repository holds, as far as g1t can measure it: the bytes of every
-- pack pushed through g1t's git endpoints to it or to its pull requests'
-- working copies. The git store does not report sizes, and pushes from
-- agents' sandboxes go to it directly, so this is a lower bound. Billing
-- reads it daily (`storage`) for its private storage meter.
ALTER TABLE repos ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
