-- Telling owners before work stops: the highest warning sent this month
-- (50, 80 or 100 percent of the limit), and when a declined card was last
-- reported. See `warn_limits` in src/limits.rs.
ALTER TABLE limits ADD COLUMN warned_month TEXT;
ALTER TABLE limits ADD COLUMN warned_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE limits ADD COLUMN declined_told_at TEXT;
