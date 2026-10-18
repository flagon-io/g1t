-- Sessions by when they started, for workspace_signals: what the sessions
-- started in each week cost (signals/weeks.sql) and how many started each
-- day (signals/days.sql), without reading every session of a repository.
CREATE INDEX IF NOT EXISTS sessions_by_start ON sessions (repo_id, started_at);
