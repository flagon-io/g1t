-- Whether a pull request merges cleanly into the branch it targets, worked
-- out ahead of time whenever its head or that branch moves, as GitHub's
-- mergeability: first by comparing the files each side changed, and where
-- they share some, by a short probe in a sandbox.
--
-- mergeable: clean, conflicting, checking, or NULL for not known.
ALTER TABLE pulls ADD COLUMN mergeable TEXT;
-- JSON array of the paths that conflict, when conflicting.
ALTER TABLE pulls ADD COLUMN conflicts TEXT;
-- "<head>..<base>": the pair of commits the answer is for, so each pair is
-- worked out once.
ALTER TABLE pulls ADD COLUMN mergeable_key TEXT;
-- The probe under way: its token's hash, and when it is given up on.
ALTER TABLE pulls ADD COLUMN mergeable_token_hash TEXT;
ALTER TABLE pulls ADD COLUMN mergeable_until TEXT;
