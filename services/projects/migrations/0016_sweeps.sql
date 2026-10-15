-- One-off jobs the service runs once for all of g1t, each claimed by its
-- row. 'descriptions': search is told every repository's own project's
-- description (#45), since it had kept repositories' own.
CREATE TABLE sweeps (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
