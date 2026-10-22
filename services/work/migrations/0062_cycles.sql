-- Cycles (items/cycles.rs, g1t_contracts::work::cycles): a workspace's
-- time boxes. While a workspace has them on, Now is its current cycle: the
-- one cycle not closed. The cron closes a cycle once its last day is over,
-- opens the next, and carries what is still open in it into that one.

-- What a workspace's cycles are set to. No row, or enabled 0, is off: Work
-- behaves as it did before cycles. length_days is 7 or 14; starts_weekday
-- is the ISO day a cycle starts on (1 Monday to 7 Sunday); cooldown_days
-- the days between one cycle's end and the next one's start.
CREATE TABLE cycle_settings (
  workspace TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  length_days INTEGER NOT NULL DEFAULT 14,
  starts_weekday INTEGER NOT NULL DEFAULT 1,
  cooldown_days INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- A workspace's cycles, numbered from 1. starts_on and ends_on are days
-- (YYYY-MM-DD, UTC), both in the cycle. closed_at is set when it ends; at
-- most one cycle of a workspace is open at a time.
CREATE TABLE cycles (
  workspace TEXT NOT NULL,
  number INTEGER NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (workspace, number)
);
CREATE UNIQUE INDEX cycles_open ON cycles (workspace) WHERE closed_at IS NULL;

-- Each work item a cycle ended with still open, carried into the next:
-- cycle_number is the cycle it was carried out of. One row per item and
-- cycle, so closing a cycle twice never carries anything twice.
CREATE TABLE cycle_carries (
  workspace TEXT NOT NULL,
  cycle_number INTEGER NOT NULL,
  item_number INTEGER NOT NULL,
  carried_at TEXT NOT NULL,
  PRIMARY KEY (workspace, cycle_number, item_number)
);

-- The cycle a work item is in: in Now, the current cycle; in Next, the
-- coming one it is planned into. cycle_added_at is when it joined, for
-- what a cycle took on after it started. Code from before this neither
-- reads nor writes them.
ALTER TABLE work_items ADD COLUMN cycle_number INTEGER;
ALTER TABLE work_items ADD COLUMN cycle_added_at TEXT;
CREATE INDEX work_items_by_cycle ON work_items (workspace, cycle_number) WHERE cycle_number IS NOT NULL;
