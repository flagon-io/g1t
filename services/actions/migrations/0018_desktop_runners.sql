-- What the desktop app last said of the runner it keeps on a person's
-- computer: its diagnosis (state, why, the fix) and what to show once g1t
-- is closed there, as JSON in the app's own words. One row per computer
-- in a workspace, replaced at each report.
CREATE TABLE desktop_runners (
  workspace TEXT NOT NULL,
  machine TEXT NOT NULL,
  person TEXT NOT NULL,
  backend TEXT NOT NULL,
  version TEXT,
  diagnosis TEXT NOT NULL,
  closed TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (workspace, machine)
);
