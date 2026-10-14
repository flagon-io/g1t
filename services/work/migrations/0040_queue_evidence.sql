-- What each attempt actually built: the changes merged in, in order, at the
-- exact commits used. Diagnosis rebuilds from this, never from newer heads.
ALTER TABLE queue_entries ADD COLUMN tested_stack TEXT;
-- How many merge_group runs the attempt's dispatch registered. Its result
-- waits until that many of its own runs are found and finished.
ALTER TABLE queue_entries ADD COLUMN workflow_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_probes ADD COLUMN workflow_runs INTEGER NOT NULL DEFAULT 0;
