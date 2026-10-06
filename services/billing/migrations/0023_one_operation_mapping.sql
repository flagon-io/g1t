-- One mapping from Artifacts' raw meters to operations: the repos service's
-- operation_mapping (set_operation_mapping), which says for each raw meter
-- how many operations it is to Cloudflare and to the customer. Billing
-- reads it with the raw counts (artifacts_usage) and keeps none of its own,
-- so the table 0022 made for that, never written, goes.
DROP TABLE IF EXISTS billable_units;
