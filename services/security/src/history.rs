//! Scanning a repository's history for secrets once, in the background, a
//! page of commits at a time, metered to its workspace.

use g1t_contracts::billing::{CheckLimitArgs, Limit, LimitState, NotePendingArgs};
use g1t_contracts::security::{HistoryPage, ScanHistoryArgs, SecretStatus};
use g1t_contracts::Outcome;
use worker::Result;

use crate::Security;
use crate::store::RepoRow;

/// Commits read per call to the repos service.
const PAGE: u32 = 25;
/// What one read of a git object is taken to cost g1t, in millionths of a
/// dollar: a store call and the Worker time around it, rounded up.
pub const MICROS_PER_READ: i64 = 1;

impl Security {
    /// Whether the workspace's usage has reached its limit, which stops
    /// background work. Unknown counts as not.
    async fn over_limit(&self, workspace: &str) -> bool {
        let limit: Result<Outcome<Limit>> =
            g1t_kit::call(&self.billing, "check_limit", &CheckLimitArgs { workspace: workspace.to_owned() }).await;
        matches!(limit, Ok(Outcome::Ok(limit)) if limit.state == LimitState::Stopped)
    }

    /// Records what scanning cost, and tells billing the month's total so
    /// the workspace's limit counts it.
    pub async fn meter(&self, workspace: &str, reads: u32, commits: u32, osv_calls: u32, cost_micros: i64) -> Result<()> {
        let total = self.store.meter(workspace, reads, commits, osv_calls, cost_micros).await?;
        let noted: Result<bool> = g1t_kit::call(
            &self.billing,
            "note_pending",
            &NotePendingArgs { workspace: workspace.to_owned(), source: "security".to_owned(), cost_micros: total },
        )
        .await;
        if let Err(error) = noted {
            worker::console_error!("security: usage for {workspace} not noted: {error}");
        }
        Ok(())
    }

    /// Scans up to `pages` pages of a repository's history from where the
    /// last scan stopped.
    pub async fn advance_history(&self, repo: &RepoRow, pages: u32) -> Result<()> {
        if repo.history == "done" {
            return Ok(());
        }
        if self.over_limit(&repo.namespace).await {
            return self.store.set_history(&repo.repo_id, "stopped", repo.history_cursor.as_deref(), 0).await;
        }
        let mut cursor = repo.history_cursor.clone();
        for _ in 0..pages {
            let page: HistoryPage = g1t_kit::call(
                &self.repos,
                "scan_history",
                &ScanHistoryArgs { repo_id: repo.repo_id.clone(), after: cursor.clone(), limit: PAGE },
            )
            .await?;
            let fingerprints: Vec<String> = page.secrets.iter().map(|secret| secret.fingerprint.clone()).collect();
            self.store.landed(&repo.repo_id, &fingerprints).await?;
            self.store.add_secrets(&repo.repo_id, &page.secrets, SecretStatus::Open, "history", None).await?;
            self.meter(&repo.namespace, page.reads, page.commits, 0, i64::from(page.reads) * MICROS_PER_READ).await?;
            match page.next {
                Some(next) => {
                    self.store.set_history(&repo.repo_id, "running", Some(&next), page.commits).await?;
                    cursor = Some(next);
                }
                None => return self.store.set_history(&repo.repo_id, "done", None, page.commits).await,
            }
        }
        Ok(())
    }
}
