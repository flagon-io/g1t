-- A month's final count of a source billing measures as a running total
-- (git operations, src/storage.rs `measure_last_month_git`), taken once
-- the month is over. Until it is here, last month's metered usage is not
-- charged and the month is not closed (`last_month_final`): the daily
-- measure ran hours before the month ended, so charging on it left out
-- the operations of the month's last hours. After three days without it
-- the close goes ahead regardless, logged, so an outage of the repos
-- service never holds every invoice.
CREATE TABLE IF NOT EXISTS measured_months (
  source TEXT NOT NULL,
  -- YYYY-MM.
  month TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (source, month)
);
