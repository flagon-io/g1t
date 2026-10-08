//! Scanning a repository's history for secrets once, in the background, a
//! page of commits at a time, metered to its workspace; and the new commits
//! of a push too large to scan before it was stored, after it landed.

use g1t_contracts::billing::{CheckLimitArgs, Limit, LimitState, NotePendingArgs};
use g1t_contracts::identity::NotifyOwnersArgs;
use g1t_contracts::security::{HistoryPage, ScanHistoryArgs, SecretStatus};
use g1t_contracts::Outcome;
use worker::Result;

use crate::Security;
use crate::store::RepoRow;

/// Commits read per call to the repos service.
const PAGE: u32 = 25;
/// Pages of a large push scanned as soon as it is heard of; the sweep
/// continues the rest.
pub const PUSH_PAGES_AT_ONCE: u32 = 4;
/// A push's scan stops after this many pages (25 000 commits): beyond it,
/// a rescan of the whole history is the way to look.
const MAX_PUSH_PAGES: i64 = 1_000;
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

/// What the email about secrets in a push that landed unscanned says.
pub fn landed_secrets_intro(namespace: &str, name: &str, branch: &str, count: usize) -> String {
    let what = if count == 1 { "a secret that looks real".to_owned() } else { format!("{count} secrets that look real") };
    format!(
        "A push to {branch} in {namespace}/{name} was too large to check before it was stored, so g1t scanned it after it landed and found {what}. \
         Rotate each one with whoever issued it, then mark the alert revoked, or dismiss it if it is not a real secret."
    )
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

    /// Scans up to `pages` pages of the new commits of a push that reached
    /// the store unscanned, from where its scan stopped. What it finds is
    /// recorded open (it has landed), never blocking anything; a secret that
    /// looks real is emailed to the workspace's owners once per push.
    /// The custom patterns a scan of `repo` looks for too.
    async fn scan_patterns(&self, repo: &RepoRow) -> Vec<g1t_contracts::security_suite::PatternSpec> {
        let args = g1t_contracts::security_suite::PatternsForArgs { repo_id: repo.repo_id.clone(), namespace: repo.namespace.clone(), private: None };
        self.patterns_for(args).await.unwrap_or_else(|error| {
            worker::console_error!("security: patterns for {}: {error}", repo.repo_id);
            Vec::new()
        })
    }

    pub async fn advance_push_scan(&self, id: &str, pages: u32) -> Result<()> {
        let Some(scan) = self.store.push_scan(id).await? else {
            return Ok(());
        };
        let Some(repo) = self.store.repo(&scan.repo_id).await? else {
            return self.store.advance_push_scan(id, None, 0, 0).await;
        };
        if self.over_limit(&repo.namespace).await {
            // Picked up again by the sweep once the workspace is under it.
            return Ok(());
        }
        let mut cursor = scan.cursor.clone();
        let mut real = 0usize;
        let patterns = self.scan_patterns(&repo).await;
        for pages_done in (scan.pages + 1)..=(scan.pages + i64::from(pages)) {
            let page: HistoryPage = g1t_kit::call(
                &self.repos,
                "scan_history",
                &ScanHistoryArgs {
                    repo_id: repo.repo_id.clone(),
                    after: cursor.clone(),
                    limit: PAGE,
                    from: Some(scan.head.clone()),
                    until: scan.base.clone(),
                    patterns: patterns.clone(),
                },
            )
            .await?;
            let fingerprints: Vec<String> = page.secrets.iter().map(|secret| secret.fingerprint.clone()).collect();
            let fresh: Vec<String> = {
                let known = self.store.known(&repo.repo_id, &fingerprints).await?;
                page.secrets
                    .iter()
                    .filter(|secret| secret.test_value.is_none())
                    .filter(|secret| !known.iter().any(|(fingerprint, _, _)| *fingerprint == secret.fingerprint))
                    .map(|secret| secret.fingerprint.clone())
                    .collect()
            };
            real += fresh.len();
            self.store.landed(&repo.repo_id, &fingerprints).await?;
            self.store
                .add_secrets(&repo.repo_id, &page.secrets, SecretStatus::Open, "history", scan.pusher.as_deref())
                .await?;
            self.secrets_found(&repo, &page.secrets, "history", &fresh, None).await?;
            let cost = history_page_cost(page.reads, page.secrets.len());
            self.meter(&repo.namespace, page.reads, page.commits, 0, cost).await?;
            let next = page.next.filter(|_| pages_done < MAX_PUSH_PAGES);
            self.store
                .advance_push_scan(id, next.as_deref(), page.commits, page.secrets.len() as u32)
                .await?;
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        if real > 0 {
            self.tell_owners_of_landed_secrets(&repo, &scan.git_ref, real).await;
        }
        Ok(())
    }

    /// Emails a workspace's owners, who are Admins of every repository in
    /// it, that a push which landed unscanned holds secrets that look real.
    async fn tell_owners_of_landed_secrets(&self, repo: &RepoRow, git_ref: &str, count: usize) {
        let branch = git_ref.strip_prefix("refs/heads/").unwrap_or(git_ref);
        let args = NotifyOwnersArgs {
            workspace: repo.namespace.clone(),
            subject: format!("Secrets found in a push to {}/{}", repo.namespace, repo.name),
            intro: landed_secrets_intro(&repo.namespace, &repo.name, branch, count),
            action: "Review the alerts".to_owned(),
            link: format!("https://g1t.sh/{}/{}/security/secret-scanning", repo.namespace, repo.name),
            footer: "You get this because you own this workspace on g1t. Very large pushes are scanned for secrets after they land: https://docs.g1t.sh/guides/security/".to_owned(),
        };
        if let Err(error) = g1t_kit::call::<_, u32>(&self.identity, "notify_owners", &args).await {
            worker::console_error!("security: owners of {} not told of landed secrets: {error}", repo.namespace);
        }
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
        let patterns = self.scan_patterns(repo).await;
        for _ in 0..pages {
            let page: HistoryPage = g1t_kit::call(
                &self.repos,
                "scan_history",
                &ScanHistoryArgs {
                    repo_id: repo.repo_id.clone(),
                    after: cursor.clone(),
                    limit: PAGE,
                    from: None,
                    until: None,
                    patterns: patterns.clone(),
                },
            )
            .await?;
            let fingerprints: Vec<String> = page.secrets.iter().map(|secret| secret.fingerprint.clone()).collect();
            let known: Vec<String> = self.store.known(&repo.repo_id, &fingerprints).await?.into_iter().map(|(fingerprint, _, _)| fingerprint).collect();
            let fresh: Vec<String> = page
                .secrets
                .iter()
                .filter(|secret| secret.test_value.is_none() && !known.contains(&secret.fingerprint))
                .map(|secret| secret.fingerprint.clone())
                .collect();
            self.store.landed(&repo.repo_id, &fingerprints).await?;
            self.store.add_secrets(&repo.repo_id, &page.secrets, SecretStatus::Open, "history", None).await?;
            self.secrets_found(repo, &page.secrets, "history", &fresh, None).await?;
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
