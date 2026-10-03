-- Whether a pull request must contain the default branch's latest commits
-- before it may merge. Off unless a repository turns it on, as on GitHub.
ALTER TABLE repo_settings ADD COLUMN require_up_to_date INTEGER NOT NULL DEFAULT 0;

-- A merge that was asked for while the pull request was behind. g1t brings
-- it up to date and then lands it. JSON: who asked, and whether the issue
-- stays open. The time bounds how long the request stands.
ALTER TABLE pulls ADD COLUMN land_requested TEXT;
ALTER TABLE pulls ADD COLUMN land_requested_at TEXT;
