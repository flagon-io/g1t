-- What a queue gave up on: each message g1t-events-dlq received, which a
-- consumer of the bus or of a subscriber's queue failed to handle through
-- all its retries (src/dead_letters.rs). Counted for the status page, and
-- kept for a person to look at: the queue does not say which consumer it
-- came from, so it is not sent again by itself.
CREATE TABLE dead_letters (
  -- The queue's id for the message: a redelivery is recorded once.
  id TEXT PRIMARY KEY,
  -- The event's, when the message was one.
  event_id TEXT,
  type TEXT,
  repo_id TEXT,
  -- JSON, shortened past 16 KB.
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX dead_letters_by_age ON dead_letters (created_at);
