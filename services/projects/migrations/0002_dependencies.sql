-- One project using another: calling its API, consuming its package. A
-- dependency is declared in the UI or in the project's .g1t/project.yml,
-- which replaces the file's rows on every push to the default branch.

CREATE TABLE dependencies (
  project_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  -- The variable its builds and apps get with the other's address for the
  -- same environment, such as API_URL; null for none.
  alias TEXT,
  -- ui or file.
  source TEXT NOT NULL DEFAULT 'ui',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, depends_on_id)
);
CREATE INDEX dependencies_by_target ON dependencies (depends_on_id);
