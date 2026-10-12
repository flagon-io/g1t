-- Reporting checks to a mirror's remote (src/remotes.rs, on_status).
-- checks_error: why g1t could not report the last check to it, such as
--   the GitHub App lacking the Commit statuses permission; cleared once a
--   report goes through. Kept apart from last_error, which every sync
--   clears.
ALTER TABLE remotes ADD COLUMN checks_error TEXT;
