-- Per-workspace limits on usage not yet paid for. A row only exists when
-- g1t set a ceiling by hand or an owner set a spend limit; everything
-- else is worked out from the ledger. See src/limits.rs.
CREATE TABLE limits (
  workspace TEXT PRIMARY KEY,
  -- Set by g1t after a review; replaces the ceiling trust would give.
  ceiling_micros INTEGER,
  -- The owner's own monthly limit, under g1t's.
  spend_limit_micros INTEGER,
  updated_at TEXT NOT NULL
);
