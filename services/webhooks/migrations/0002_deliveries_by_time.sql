-- Deliveries older than a fortnight are forgotten each hour, oldest first:
-- by time, a range rather than a scan of every delivery.
CREATE INDEX IF NOT EXISTS deliveries_by_time ON deliveries (created_at);
