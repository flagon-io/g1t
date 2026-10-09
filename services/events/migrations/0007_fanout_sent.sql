-- Which subscriber queues an event already reached, written only when
-- passing a batch on failed part way: its retry skips the queues that
-- have it. Rows older than a day are removed by the daily sweep.
CREATE TABLE fanout_sent (
  event_id TEXT PRIMARY KEY,
  -- JSON array of SUBSCRIBER_* binding names.
  bindings TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX fanout_sent_by_age ON fanout_sent (created_at);
