-- Workspaces whose billing was closed because the workspace was deleted
-- (src/closing.rs): who closed it, when, and the balance it had then. The
-- ledger, invoices and statements stay under the slug for accounting.
CREATE TABLE IF NOT EXISTS closed_workspaces (
  workspace TEXT PRIMARY KEY,
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  balance_micros INTEGER NOT NULL DEFAULT 0
);
