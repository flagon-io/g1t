-- Where catching up on `work.migrated` got to (g1t_kit::work_migrated): the
-- cron pages through the work service's `legacy_item_map` and applies each
-- page as the event would have, until the last.
CREATE TABLE work_catch_up (
  name TEXT PRIMARY KEY,
  cursor TEXT,
  page INTEGER NOT NULL DEFAULT 0,
  done_at TEXT
);
INSERT INTO work_catch_up (name) VALUES ('work.migrated');
