-- Audit entries are kept by plan (src/audit.rs): 7 days for a free
-- workspace, 90 on the plan, or what g1t staff set for its account, and
-- never past AUDIT_MAX_DAYS. The daily purge deletes everything older than
-- the ceiling by time, finds the workspaces with entries older than the
-- shortest retention, and deletes each one's older than its own days; these
-- indexes keep each of those a seek rather than a scan.
CREATE INDEX IF NOT EXISTS audit_workspace_time ON audit_entries (workspace, time);
CREATE INDEX IF NOT EXISTS audit_time ON audit_entries (time);

-- Where the last daily run stopped, so the next carries on from there: one
-- run looks at a bounded number of workspaces. Empty: from the start.
CREATE TABLE IF NOT EXISTS audit_purge_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after TEXT NOT NULL DEFAULT ''
);
