-- The job that reserved a cache entry. When a job ends, the uploads it
-- reserved and never finished let go of their keys (cache.rs `RELEASE`),
-- and a reservation whose job is no longer running gives way to the next
-- job that saves the same key (`RESERVE`), rather than holding it for six
-- hours. Entries reserved before this have no job, and wait out the six
-- hours as before.
ALTER TABLE cache_entries ADD COLUMN job_id TEXT;
CREATE INDEX IF NOT EXISTS cache_entries_pending_by_job ON cache_entries (job_id) WHERE status = 'pending';
