-- Platform spend guardrails (src/platform.rs, docs/SPEND-GUARDRAILS.md).
--
-- platform_pause: g1t-wide pauses, one row per level (compute, schedules,
-- indexing, renders), set by staff in sudo or by the hourly usage watcher
-- on a severe breach. No row, or paused = 0: running.
CREATE TABLE IF NOT EXISTS platform_pause (
  level TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  set_by TEXT,
  set_at TEXT,
  -- 1 when the usage watcher set it, not a person.
  auto INTEGER NOT NULL DEFAULT 0
);

-- platform_usage: what Cloudflare counted each hour (UTC) for each metric
-- (workers_requests, d1_rows_read, kv_lists, …), with the script, queue,
-- database or namespace that counted most. The spike rule reads the last
-- week of it.
CREATE TABLE IF NOT EXISTS platform_usage (
  hour TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  top_name TEXT,
  top_value REAL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (hour, metric)
);
CREATE INDEX IF NOT EXISTS platform_usage_by_metric ON platform_usage (metric, hour);

-- platform_usage_month: the month so far for each metric, as last read.
CREATE TABLE IF NOT EXISTS platform_usage_month (
  month TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  top_name TEXT,
  top_value REAL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (month, metric)
);

-- platform_alerts: each breach the watcher found: over its hourly
-- threshold, or a spike over the week's usual hour. Emailed at most once
-- per metric every 6 hours.
CREATE TABLE IF NOT EXISTS platform_alerts (
  id TEXT PRIMARY KEY,
  metric TEXT NOT NULL,
  hour TEXT NOT NULL,
  rule TEXT NOT NULL,
  value REAL NOT NULL,
  threshold REAL NOT NULL,
  severe INTEGER NOT NULL DEFAULT 0,
  top_name TEXT,
  top_value REAL,
  detail TEXT NOT NULL,
  -- The levels it paused, comma-separated; NULL when none.
  paused TEXT,
  opened_at TEXT NOT NULL,
  emailed_at TEXT
);
CREATE INDEX IF NOT EXISTS platform_alerts_by_metric ON platform_alerts (metric, opened_at);

-- platform_watch_runs: what each hourly run could not see. failed is a
-- JSON object of query key to its error ({} when every query answered);
-- empty is 1 when every dataset that answered had no rows, the month so
-- far included (the wrong account, or a token that cannot see it). Sudo
-- shows the latest; three runs in a row email staff. Kept 14 days.
CREATE TABLE IF NOT EXISTS platform_watch_runs (
  hour TEXT PRIMARY KEY,
  read_at TEXT NOT NULL,
  failed TEXT NOT NULL DEFAULT '{}',
  empty INTEGER NOT NULL DEFAULT 0
);

-- platform_watch_alerts: when staff were last emailed that a query (or
-- all_empty) stayed blind; at most once a day per key.
CREATE TABLE IF NOT EXISTS platform_watch_alerts (
  key TEXT PRIMARY KEY,
  emailed_at TEXT NOT NULL
);
