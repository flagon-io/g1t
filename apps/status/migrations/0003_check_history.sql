-- Every check, kept for 7 days, and detection by N of M.
--
-- check_history: one row per part per round of checks: how long it took,
-- what it meant, and the Cloudflare data centre it ran from (the answer's
-- cf-ray). sudo's incident page draws an incident's parts from it. Rows
-- older than 7 days are deleted as checks run (store.ts `record`).
--
-- streak gains `checks` (every check in the run, good ones between
-- included) and `recent` (its last five, "." good, "s" slow, "x" not
-- answering): a draft is made at four bad of the last five, and a run ends
-- after three good checks in a row. Runs kept before this have neither;
-- the worker fills them in as all bad, in a row (detect.ts `upgradeStreak`).

CREATE TABLE IF NOT EXISTS check_history (
  component TEXT NOT NULL,
  at TEXT NOT NULL,
  ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('up', 'degraded', 'down')),
  colo TEXT,
  -- A slow answer asked again at once: the first try's time.
  first_ms INTEGER,
  PRIMARY KEY (component, at)
);
CREATE INDEX IF NOT EXISTS check_history_at ON check_history (at);

ALTER TABLE streak ADD COLUMN checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE streak ADD COLUMN recent TEXT NOT NULL DEFAULT '';
