//! Deleting old job logs (`LOG_RETENTION_DAYS`, limits.rs): once an hour,
//! the logs of jobs, and of earlier attempts, that finished longer ago than
//! that. A job keeps its steps, conclusion, annotations and summary; only
//! its log lines go, and the job is marked (`logs_purged_at`) so it is not
//! looked at again. A few hundred jobs a sweep, so a backlog drains over
//! hours instead of in one heavy query.

use g1t_contracts::time::rfc3339;
use serde::Deserialize;
use worker::Result;

use crate::Actions;

/// Jobs (and earlier attempts) whose logs one sweep deletes, at most.
const PER_SWEEP: u32 = 200;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// The moment before which a finished job's log is deleted; None keeps
/// every log.
pub fn cutoff(now_ms: u64, days: u64) -> Option<String> {
    (days > 0).then(|| rfc3339(now_ms.saturating_sub(days.saturating_mul(DAY_MS))))
}

#[derive(Deserialize)]
struct Due {
    id: String,
    log_id: String,
}

impl Actions {
    pub(crate) async fn sweep_logs(&self, now_ms: u64) -> Result<()> {
        let Some(before) = cutoff(now_ms, self.limits.log_retention_days) else {
            return Ok(());
        };
        for (table, log_id) in [("jobs", "id"), ("job_attempts", "log_id")] {
            let due = self
                .db
                .prepare(format!(
                    "SELECT id, {log_id} AS log_id FROM {table}
                     WHERE logs_purged_at IS NULL AND finished_at IS NOT NULL AND finished_at < ?
                     LIMIT {PER_SWEEP}"
                ))
                .bind(&[before.as_str().into()])?
                .all()
                .await?
                .results::<Due>()?;
            if due.is_empty() {
                continue;
            }
            let at = rfc3339(now_ms);
            let mut statements = Vec::with_capacity(due.len() * 2);
            for job in &due {
                statements.push(self.db.prepare("DELETE FROM logs WHERE job_id = ?").bind(&[job.log_id.as_str().into()])?);
                statements.push(
                    self.db
                        .prepare(format!("UPDATE {table} SET logs_purged_at = ? WHERE id = ?"))
                        .bind(&[at.as_str().into(), job.id.as_str().into()])?,
                );
            }
            self.db.batch(statements).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_older_than_the_retention_go_and_zero_keeps_them() {
        let now = 100 * DAY_MS;
        assert_eq!(cutoff(now, 90), Some(rfc3339(10 * DAY_MS)));
        assert_eq!(cutoff(now, 0), None);
        // A retention longer than time itself deletes nothing it should keep.
        assert_eq!(cutoff(now, 1000), Some(rfc3339(0)));
    }
}
