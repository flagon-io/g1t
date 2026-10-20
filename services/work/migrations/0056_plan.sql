-- The plan (items/plan.rs, g1t_contracts::work::plan): where each open work
-- item stands (horizon: triage, now, next, later or set_aside; NULL is read
-- as triage, so code from before this reads and writes rows as it did), its
-- place there (rank, a fractional key compared as text), how much the work
-- is worth (appetite: small, medium or large; budget_usd), whether it is a
-- fire (urgent, first in Now until it closes), and when it was last moved
-- (planned_at).
ALTER TABLE work_items ADD COLUMN horizon TEXT;
ALTER TABLE work_items ADD COLUMN rank TEXT;
ALTER TABLE work_items ADD COLUMN appetite TEXT;
ALTER TABLE work_items ADD COLUMN budget_usd REAL;
ALTER TABLE work_items ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN planned_at TEXT;

CREATE INDEX work_items_plan ON work_items (workspace, state, horizon, rank);

-- What a workspace's plan is set to: how many work items Now holds before
-- the plan says it is over (g1t_contracts::work::DEFAULT_NOW_CAP when it
-- has no row).
CREATE TABLE plan_settings (
  workspace TEXT PRIMARY KEY,
  now_cap INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
