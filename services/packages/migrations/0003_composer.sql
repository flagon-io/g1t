-- Composer packages are found in the workspace's repositories, not
-- uploaded: the backfill walks every repository once, a page an hour, so
-- repositories that had a composer.json before the registry existed are
-- found without waiting for their next push.
CREATE TABLE composer_backfill (
  key TEXT PRIMARY KEY,
  -- The last repository id done.
  after TEXT,
  finished_at TEXT
);
CREATE INDEX versions_commit ON versions (package_id, digest);
