-- Runs on a workspace's own model provider: the model is paid for there,
-- and g1t charges a flat fee for the sandbox and the orchestration.
-- 'g1t' or 'workspace'.
ALTER TABLE runs ADD COLUMN billed_to TEXT NOT NULL DEFAULT 'g1t';
ALTER TABLE ledger ADD COLUMN billed_to TEXT NOT NULL DEFAULT 'g1t';
