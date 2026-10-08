-- Work identity does once, a page at a time, from its scheduled handler,
-- and where each got to. The first is `creator_grants`: giving the person
-- who created each existing repository the Admin role on it
-- (src/members.rs), as a new repository's creator now gets at creation.
CREATE TABLE IF NOT EXISTS identity_jobs (
  name TEXT PRIMARY KEY,
  -- The last repository id done; NULL before the first page.
  cursor TEXT,
  done_at TEXT
);
INSERT OR IGNORE INTO identity_jobs (name) VALUES ('creator_grants');
