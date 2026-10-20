-- A job the runner had no machine for (Cloudflare gave its sandbox no
-- container: every instance taken, or a rollout replacing them) goes back
-- in the queue, and is tried again each minute. This says since when, so a
-- job that never gets one fails after WAIT_FOR_MACHINE_MS (src/lib.rs)
-- rather than waiting for ever.
ALTER TABLE jobs ADD COLUMN waiting_since TEXT;
