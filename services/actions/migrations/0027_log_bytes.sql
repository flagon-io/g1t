-- How many bytes of log a job has kept so far, added to as each batch is
-- kept (src/plan.rs `LOG_COUNTED`), so a report checks the 4 MB limit
-- against this rather than adding up the whole log again each time. A job
-- run again starts from 0 (its log moves aside).
--
-- Only jobs still to finish are counted here: a finished job is sent no
-- more log, and counting every finished job's would read every log kept.
ALTER TABLE jobs ADD COLUMN log_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE jobs SET log_bytes = (SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM logs WHERE logs.job_id = jobs.id)
  WHERE finished_at IS NULL;
