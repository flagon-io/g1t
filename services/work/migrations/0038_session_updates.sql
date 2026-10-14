-- Pending coordination updates are independent of transcript pagination.
CREATE TABLE session_updates (
 id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 data TEXT NOT NULL,
 at TEXT NOT NULL,
 acknowledged_at TEXT,
 PRIMARY KEY (session_id, id)
);
CREATE INDEX session_updates_pending ON session_updates(session_id, acknowledged_at, at, id);
