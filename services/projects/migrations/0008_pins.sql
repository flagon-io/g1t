-- What each person keeps at hand in a workspace: the projects they pinned,
-- in the order they put them, and the ones they opened last. Keyed by the
-- project's id, so a rename or a transfer keeps them; the workspace is
-- the project's own, read through `projects`.

CREATE TABLE pins (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- 0 first, within the person's pins in the project's workspace.
  position INTEGER NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX pins_by_project ON pins (project_id);

-- The last time each person opened each project: kept for their latest
-- few, written after the page is sent.
CREATE TABLE visits (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  visited_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX visits_by_user ON visits (user_id, visited_at DESC);
CREATE INDEX visits_by_project ON visits (project_id);
