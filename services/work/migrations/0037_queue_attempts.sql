-- A retry must never share a writable Git ref with an older sandbox.
-- Keep this after token consumption so callbacks and cleanup use the same ref.
ALTER TABLE queue_entries ADD COLUMN attempt_id TEXT;
-- Durable publication intent. Removal/retesting cannot revoke a Git push
-- after it has begun. A retry resumes this same immutable commit.
ALTER TABLE queue_entries ADD COLUMN landing_commit TEXT;
-- Workflow callbacks must wait until every workflow in the group is registered.
ALTER TABLE queue_entries ADD COLUMN dispatching INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue_probes ADD COLUMN dispatching INTEGER NOT NULL DEFAULT 0;
