-- Observability (services/telemetry): which build each app serves now, so
-- a request the dispatcher saw, which names only the script, is filed
-- under its project and deployment.
ALTER TABLE apps ADD COLUMN deployment_id TEXT;
