-- A repository's About (src/stats.rs, src/stars.rs, src/releases.rs).
-- Additive; nothing is backfilled: what is read from a repository's files
-- and history is worked out the first time its Files page is viewed.

-- What was worked out from the default branch at one commit: one row per
-- repository, replaced when its head moves.
--
-- commit_hash: the commit it describes; null before the first is done.
-- started_ms: milliseconds since the epoch; set while one is being worked
--   out, so only one runs at a time (a run older than two minutes is
--   taken to have died).
-- license: JSON `License`, or null. security_policy: its path, or null.
-- languages: JSON array of `LanguageShare`.
-- contributors_total, contributors_top: how many, and the most active
--   (JSON array of `Contributor` without weeks), for the Files page.
-- contributors: JSON `{ commits, contributors, weeks }`, the whole answer
--   for the Contributors page.
-- partial: 1 when the files or history were too large to read in full.
CREATE TABLE repo_stats (
  repo_id TEXT PRIMARY KEY,
  commit_hash TEXT,
  computed_at TEXT,
  started_ms INTEGER,
  partial INTEGER NOT NULL DEFAULT 0,
  license TEXT,
  security_policy TEXT,
  languages TEXT NOT NULL DEFAULT '[]',
  contributors_total INTEGER NOT NULL DEFAULT 0,
  contributors_top TEXT NOT NULL DEFAULT '[]',
  contributors TEXT
);

-- Who starred what. user_id: the account's id; names are looked up when
-- shown, so a renamed account keeps its stars.
CREATE TABLE repo_stars (
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX repo_stars_user ON repo_stars (user_id, created_at);
CREATE INDEX repo_stars_newest ON repo_stars (repo_id, created_at);

-- Releases: a tag with a title and notes. One per tag.
--
-- target: the commit the tag named when the release was made.
-- author_id, author: who made it, by id and by username then.
-- published_at: null while it is a draft.
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  target TEXT NOT NULL,
  name TEXT,
  body TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  author_id TEXT,
  author TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX releases_tag ON releases (repo_id, tag_name);
CREATE INDEX releases_newest ON releases (repo_id, created_at);
