-- The runner's own number for each batch of a job's log (1 for its first),
-- which a batch keeps when the runner sends it again after an answer it did
-- not hear: a batch g1t already has is not kept twice. Null for runners that
-- do not number their batches; nulls never collide in a unique index.
ALTER TABLE logs ADD COLUMN chunk INTEGER;
CREATE UNIQUE INDEX logs_by_chunk ON logs (job_id, chunk);
