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
// What scanning costs g1t, from Cloudflare's published prices on the
// Workers Paid plan (October 2026), the same as billing's `scan_cpu` and
// `scan_rows` meters:
//
// - Worker CPU time: $0.02 per million CPU milliseconds, so 0.02 millionths
//   of a dollar per millisecond.
// - D1 rows written: $1.00 per million, so 1 millionth of a dollar a row.
//   Rows read ($0.001 per million) come to nothing measurable.
// - Requests: the scan's calls between g1t's services go over service
//   bindings, which Cloudflare does not charge as requests.
// - Artifacts: its operations are priced for create, push, pull and clone;
//   reading a git object through the binding is none of those.
// - OSV, which dependency checks query, is free.
//
// So a scan costs the CPU it takes and the rows it writes. The CPU per
// object read is an estimate: decoding the object and running every
// secret pattern over it, generously rounded up. Billing charges the
// total at cost plus its margin once the month is over.

/// Worker CPU, in millionths of a dollar per millisecond.
pub const MICROS_PER_CPU_MS: f64 = 0.02;
/// One D1 row written, in millionths of a dollar.
pub const MICROS_PER_ROW_WRITTEN: f64 = 1.0;
/// CPU one git object read takes in a history scan, in milliseconds.
pub const CPU_MS_PER_READ: f64 = 5.0;

/// What a page of history scanning cost g1t, in millionths of a dollar,
/// rounded up: the CPU of its reads, and the rows it writes (where the
/// scan stands, the month's usage, and each secret found).
pub fn history_page_cost(reads: u32, secrets: usize) -> i64 {
    let cpu = f64::from(reads) * CPU_MS_PER_READ * MICROS_PER_CPU_MS;
    let rows = (2 + secrets) as f64 * MICROS_PER_ROW_WRITTEN;
    (cpu + rows).ceil() as i64
}

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
            &NotePendingArgs { workspace: workspace.to_owned(), source: "security".to_owned(), cost_micros: total, detail: None },
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
            let cost = history_page_cost(page.reads, page.secrets.len());
            self.meter(&repo.namespace, page.reads, page.commits, 0, cost).await?;
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
