-- What g1t was asked in issues and pull requests (src/summon.rs): one row
-- per ask acted on, by the event that asked (assigned, or mentioned in a
-- comment), so a delivery seen twice starts one session. `thread` is
-- `namespace/name#number`, for answering a thread a few times an hour at
-- most. Rows older than a week are cleared by the cron.
CREATE TABLE summons (
  event_id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX summons_by_thread ON summons (thread, at);
