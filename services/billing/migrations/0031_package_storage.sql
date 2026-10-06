-- What each workspace's packages held each day (services/packages), public
-- and private, each file counted once, and what was free that day.
CREATE TABLE package_storage_days (
  workspace TEXT NOT NULL,
  -- YYYY-MM-DD.
  day TEXT NOT NULL,
  public_bytes INTEGER NOT NULL,
  private_bytes INTEGER NOT NULL,
  public_free_bytes INTEGER NOT NULL,
  private_free_bytes INTEGER NOT NULL,
  PRIMARY KEY (workspace, day)
);

-- Package storage past the free amounts, at R2's storage price ($0.015 a
-- GB-month); downloads cost nothing (R2 has no egress fees).
INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('package_storage', 'Package storage past the free amounts', 'GB-month', 15000, 20, 'list', '2026-10-06T00:00:00Z')
ON CONFLICT (meter) DO NOTHING;

INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_new_package_storage', 'package_storage', 15000, 15000, 20, 'Now metered: package storage past the free amounts, at R2''s storage price', '2026-10-06T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
