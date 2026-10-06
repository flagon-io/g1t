-- Git operations through g1t's git endpoints (clones, fetches, pushes),
-- counted per workspace by the hour. Cloudflare Artifacts charges g1t per
-- operation from 2026-10-14; billing reads the month's count each day
-- (`git_operations`). See src/git_ops.rs.
CREATE TABLE git_operations (
  namespace TEXT NOT NULL,
  -- YYYY-MM-DDTHH, UTC.
  hour TEXT NOT NULL,
  operations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, hour)
);
