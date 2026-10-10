-- The apps each person pins to their dock, per workspace, so the dock is
-- the same on every device they sign in on. `apps` is a JSON array of app
-- keys (such as ["projects","usage"]) in the order the person set; the
-- web app checks the keys against its list of apps. A workspace with no
-- row has never had its pins saved. See src/dock.rs.
CREATE TABLE dock_pins (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  apps TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, workspace_id)
);
