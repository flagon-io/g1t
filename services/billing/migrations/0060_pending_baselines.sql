-- What a workspace had metered this month when its test-mode Stripe data
-- was detached (`admin_detach_test_stripe`, src/detach.rs). Reporters
-- replace a month's pending_usage row with the month's whole figure, so
-- the usage from before the detach cannot be marked charged on its own:
-- everything that values or charges pending usage takes this off the
-- row's figure, never below nothing (`storage::NET_COST`, `NET_CHARGE`).
-- Months before the detach have their rows marked charged instead.
CREATE TABLE IF NOT EXISTS pending_baselines (
  workspace TEXT NOT NULL,
  source TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  -- The row's cost_micros and charge_micros when it was detached.
  cost_micros INTEGER NOT NULL DEFAULT 0,
  charge_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, source, month)
);
