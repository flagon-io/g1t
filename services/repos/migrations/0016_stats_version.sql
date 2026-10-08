-- How a repository's About was worked out (src/stats.rs, STATS_VERSION).
-- A row worked out by an older version is worked out again on the next
-- view, as if its head had moved: version 1 counts the addresses g1t's
-- agents and merge queue committed as before 2026-10-06 as g1t.
-- Additive; existing rows are version 0.
ALTER TABLE repo_stats ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
