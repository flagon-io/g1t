-- Append-only log of every event published on the bus. Ids are
-- time-sortable, so ordering by id is ordering by time.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  -- RFC 3339 UTC.
  time TEXT NOT NULL,
  repo_id TEXT,
  actor TEXT,
  -- JSON.
  data TEXT NOT NULL
);
CREATE INDEX events_repo ON events (repo_id, id);
