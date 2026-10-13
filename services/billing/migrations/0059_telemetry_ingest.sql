-- Observability ingest (services/telemetry): every workspace sends 1 GiB a
-- month free across all its projects; past it, a workspace on the plan is
-- charged by the GB of everything its projects send, at cost plus 20%
-- like everything else. The telemetry service reports the month so far
-- (note_pending, source `telemetry`) with what it cost at this meter.
--
-- What a GB costs g1t, from how the telemetry service keeps it and
-- Cloudflare's published Workers Paid prices:
--
-- * Rows written ($1.00 a million, SQLite-backed Durable Objects). Every
--   item sent (log line, span, request, metric point) is one row in the
--   project's store, plus its indexes (each counts as a written row): a log
--   is its row, three indexes and its full-text entry (~5); a span its row
--   and one index (~2); a request two halves merged and then rolled up
--   (~8); a metric point its row, two indexes and its name (~4). The same
--   rows are written again when retention deletes them. About 8 rows
--   written an item, at an assumed 1 KB an item as received (OTLP JSON
--   spans and logs with their attributes; tail rows as kept): 1 million
--   items, 8 million rows, $8.00 a GB.
-- * Storage ($0.20 a GB-month). Kept with indexes and full text at about
--   twice what arrived, for at most 30 days of retention: up to 2
--   GB-months, $0.40 a GB.
-- * Requests and CPU of the Worker and the store (OTLP in batches of
--   about 1 MB): under $0.10 a GB.
--
-- About $8.50 a GB, sold at $10.20. The assumption that moves it is the
-- size of an item: at 500 bytes it would cost about $17, at 2 KB about
-- $4.25. The price keeper and the margin report correct it from what
-- Cloudflare bills, like every other meter.
INSERT INTO prices (meter, title, unit, cost_micros, markup_percent, source, updated_at) VALUES
  ('telemetry_gb', 'Observability: data sent past the free 1 GiB a month', 'GB', 8500000, 20, 'list', '2026-10-13T00:00:00Z')
ON CONFLICT (meter) DO NOTHING;

INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at) VALUES
  ('prc_new_telemetry_gb', 'telemetry_gb', 8500000, 8500000, 20, 'Now metered: observability data a workspace on the plan sends past the free 1 GiB a month, at what keeping it in Durable Objects costs', '2026-10-13T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT OR IGNORE INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, created_at, applied_at) VALUES
  ('pv_telemetry_gb_1', 'telemetry_gb', 1, 8500000, 20, '2026-10-13T00:00:00Z', 'Observability ingest', 'migration', '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z');

-- Its revenue in sudo's margin, under its own product. Package storage,
-- charged at month end alongside it, gets its own too: unmapped, either
-- would count as models.
INSERT OR IGNORE INTO revenue_map (key, bucket, updated_at, updated_by) VALUES
  ('telemetry', 'observability', '2026-10-13T00:00:00Z', 'migration'),
  ('package_storage', 'packages', '2026-10-13T00:00:00Z', 'migration');
