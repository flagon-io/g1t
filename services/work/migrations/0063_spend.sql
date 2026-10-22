-- Who sees each person's spend in a workspace, besides that person
-- (spend.rs): owners (owners and billing managers, the default when a
-- workspace has no row), members, or nobody.
CREATE TABLE spend_settings (
  workspace TEXT PRIMARY KEY,
  visibility TEXT NOT NULL DEFAULT 'owners',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- A person's sessions over a span of days, for their spend.
CREATE INDEX sessions_by_actor_start ON sessions (actor_id, started_at);
