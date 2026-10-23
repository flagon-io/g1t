-- Opening a pull request writes it, then makes its refs and publishes
-- `pull.opened`, which starts its checks. A request cut off in between
-- leaves a pull request nothing has heard of (#454). When its event went
-- out: the cron sends it for one still without (opened.rs). Opening one
-- writes NULL here until it is sent; '' is one told before this was kept,
-- every row now and any the code before this opens while it deploys.
ALTER TABLE pulls ADD COLUMN opened_event_at TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS pulls_opened_unsent ON pulls (created_at) WHERE opened_event_at IS NULL;

-- The workflow run whose job's token opened it, so its event sent late is
-- marked as that job's doing and starts no workflows, as on time.
ALTER TABLE pulls ADD COLUMN opened_job_run TEXT;
