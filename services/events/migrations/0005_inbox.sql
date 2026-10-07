-- The inbox (src/inbox.rs): one row per person told of an event. Written
-- as events arrive; a redelivered event finds its rows there already.
-- Ids are time-sortable, so ordering by id is ordering by time.
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  -- Whose: a username, lowercased. Usernames never change.
  username TEXT NOT NULL,
  -- The event it came from.
  event_id TEXT NOT NULL,
  -- Why they were told, such as checks_failed or mentioned.
  reason TEXT NOT NULL,
  -- error | warning | success | info
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- The workspace's slug, and owner/name. Both follow renames and transfers.
  workspace TEXT,
  repo_id TEXT,
  repo TEXT,
  -- issue | pull | run, and its number (an issue or pull request) or id (a run).
  subject TEXT,
  number INTEGER,
  run_id TEXT,
  -- Who did it: a username, or g1t.
  actor TEXT,
  -- RFC 3339 UTC.
  created_at TEXT NOT NULL,
  read_at TEXT,
  done_at TEXT,
  saved INTEGER NOT NULL DEFAULT 0,
  snoozed_until TEXT,
  UNIQUE (event_id, username)
);
-- A person's inbox, newest first; what is unread in it, for every page's
-- count; and what they saved.
CREATE INDEX inbox_recent ON inbox_items (username, id) WHERE done_at IS NULL;
CREATE INDEX inbox_unread ON inbox_items (username, severity) WHERE read_at IS NULL AND done_at IS NULL;
CREATE INDEX inbox_saved ON inbox_items (username, id) WHERE saved = 1;
CREATE INDEX inbox_done ON inbox_items (username, done_at) WHERE done_at IS NOT NULL;
-- Renames, transfers and purges find a repository's rows by id.
CREATE INDEX inbox_repo ON inbox_items (repo_id) WHERE repo_id IS NOT NULL;
CREATE INDEX inbox_time ON inbox_items (created_at);
