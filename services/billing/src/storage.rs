//! Usage other services meter through the month, charged once it is over:
//! security scans, search embeddings, and two billing measures itself each
//! day: private repository storage and git operations.
//!
//! Each reports what it cost g1t so far this month (`note_pending`), so the
//! workspace's limit counts it as it happens. When the month is over,
//! billing charges it once: at cost plus the margin, on the account's
//! terms, after the plan's included usage and the trial credit (see
//! `credits`), dated the month's last second so it falls in that month's
//! statement and invoice.
//!
//! The forge is free for every workspace up to the same amounts, on the
//! plan or not; past them, a workspace on the plan pays at cost plus the
//! margin and is never refused or slowed, and a free workspace is never
//! charged but is held to them.
//!
//! **Git operations.** Cloudflare Artifacts charges g1t $0.15 per 1,000
//! operations (clones, fetches, pushes) from 2026-10-14. The repos service
//! counts those through g1t's git endpoints. Every workspace has
//! `GIT_OPERATIONS_INCLUDED` (50,000) a month free; past it, the plan pays
//! at cost plus the margin, and a free workspace is slowed down instead
//! (the repos service's `GIT_OPERATIONS_FREE_CAP`, the same number).
//!
//! **Actions cache.** The actions service reports what each workspace's
//! `actions/cache` entries held each day (source `cache`), at what R2
//! charges g1t to store them ($0.015 a GB-month). Only the plan is charged
//! for it, from the first byte; a free workspace is never charged, and its
//! repositories are held to the cache's quota like everyone's.
//!
//! **Storage.** The git store does not report a repository's size, so the
//! repos service counts the packs pushed through g1t's git endpoints (see
//! `g1t_contracts::repos::StorageArgs`): a lower bound. Each day billing
//! records what each workspace's private repositories hold and what is
//! free that day (`FREE_PRIVATE_STORAGE_BYTES`, 1 GB, for everyone). Like
//! Cloudflare's own storage billing, a month's GB-months are the days'
//! amounts past the free one, added up and divided by 30, and only the
//! plan is charged for them. A free workspace is never charged for
//! storage: pushes to its private repositories stop once they hold its
//! free amount. Public repositories are never charged.

use g1t_contracts::billing::PlanKind;
use g1t_contracts::new_id;
use g1t_contracts::repos::{GitOperationsArgs, StorageArgs, WorkspaceGitOperations, WorkspaceStorage};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::credits::{self, Drawn, Eligible};
use crate::{Billing, optional};

/// Sources billing charges itself when the month is over.
pub(crate) const CHARGED_HERE: [&str; 5] = ["security", "context", "storage", "git", "cache"];

/// Sources only the plan is charged for: a free workspace's are not kept.
pub(crate) const PLAN_ONLY: [&str; 1] = ["cache"];

/// Sources g1t pays for itself on a free workspace: security scans and
/// search embeddings. No security feature is held back for the plan, and
/// a free workspace never runs up a bill, so on a workspace without the
/// plan they are recorded at cost, covered by g1t, and charged nothing
/// (not even from the trial). On the plan they are charged like any usage.
pub(crate) const COVERED_FOR_FREE: [&str; 2] = ["security", "context"];

/// What pays for a month-end source's charge: the plan's included usage
/// and the trial, and for a covered source on a free workspace, g1t.
pub(crate) fn month_end_eligible(source: &str, plan: bool) -> Eligible {
    let covered = !plan && COVERED_FOR_FREE.contains(&source);
    Eligible { trial: !covered, repo: None, cover_rest: covered }
}

/// What Artifacts charges g1t, when the price book cannot be read: $0.50
/// a GB-month of storage, and $0.15 per 1,000 git operations.
pub(crate) const STORAGE_MICROS_PER_GB_MONTH: i64 = 500_000;
pub(crate) const GIT_MICROS_PER_THOUSAND: i64 = 150_000;

/// When Cloudflare starts charging for Artifacts operations: none before
/// count.
pub(crate) const GIT_BILLING_STARTS: &str = "2026-10-14T00";

/// What git operations past the free amount cost g1t, at
/// `micros_per_thousand`: nothing up to it.
pub(crate) fn git_cost(operations: u64, included: u64, micros_per_thousand: f64) -> i64 {
    let past = operations.saturating_sub(included);
    (past as f64 * micros_per_thousand / 1000.0).ceil() as i64
}

/// The first hour of `month` to count git operations from.
pub(crate) fn git_since(month: &str) -> String {
    let start = format!("{month}-01T00");
    if start.as_str() < GIT_BILLING_STARTS { GIT_BILLING_STARTS.to_owned() } else { start }
}

/// A gigabyte, as Cloudflare bills storage.
pub(crate) const GB: f64 = 1_000_000_000.0;

/// GB-months from a month's daily measures, each `(private, free)` bytes:
/// what was past the free amount each day, over 30 days.
pub(crate) fn storage_gb_months(days: &[(i64, i64)]) -> f64 {
    days.iter().map(|(private, free)| (private - free).max(0) as f64).sum::<f64>() / GB / 30.0
}

/// What `gb_months` cost g1t at `micros_per_gb_month`, rounded up.
pub(crate) fn storage_cost(gb_months: f64, micros_per_gb_month: f64) -> i64 {
    (gb_months * micros_per_gb_month).ceil() as i64
}

/// What a source is called on the statement.
pub(crate) fn title(source: &str) -> &'static str {
    match source {
        "security" => "Security scans",
        "context" => "Search embeddings",
        "storage" => "Private repository storage past the free amount",
        "git" => "Git operations past the free amount",
        "cache" => "Actions cache storage",
        "domains" => "Custom domains",
        _ => "Metered usage",
    }
}

/// A usage entry to put on the ledger.
pub(crate) struct UsageLine<'a> {
    pub workspace: &'a str,
    /// What the workspace is charged, after terms and what paid for it.
    pub charged: i64,
    pub description: &'a str,
    pub repo: Option<&'a str>,
    pub task: &'a str,
    pub cost: i64,
    pub reference: &'a str,
    pub created_at: &'a str,
    pub drawn: Drawn,
}

impl Billing {
    /// Puts a usage entry on the ledger and takes it off the balance, as
    /// one write.
    pub(crate) async fn post_usage(&self, line: UsageLine<'_>) -> Result<()> {
        // The price versions it was charged at (pricing.rs).
        let mut versions = Vec::new();
        for meter in crate::pricing::meters_of(line.task) {
            versions.extend(self.version_now(meter).await?);
        }
        let price_version = versions.join(",");
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, repo, task, cost_micros, reference,
                            created_at, billed_to, credit_micros, trial_micros, oss_micros, price_version)
                         VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?, 'g1t', ?, ?, ?, ?)",
                    )
                    .bind(&[
                        new_id("led", now_ms()).into(),
                        line.workspace.into(),
                        (-(line.charged as f64)).into(),
                        line.description.into(),
                        optional(line.repo),
                        line.task.into(),
                        (line.cost as f64).into(),
                        line.reference.into(),
                        line.created_at.into(),
                        (line.drawn.credit as f64).into(),
                        (line.drawn.trial as f64).into(),
                        (line.drawn.oss as f64).into(),
                        optional(Some(price_version.as_str()).filter(|v| !v.is_empty())),
                    ])?,
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, created_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET balance_micros = balance_micros + ?2",
                    )
                    .bind(&[line.workspace.into(), (-(line.charged as f64)).into(), rfc3339(now_ms()).into()])?,
            ])
            .await?;
        Ok(())
    }

    /// Writes down what a source cost g1t so far in `month`, what it will
    /// be charged, and how much of it there was (`detail`, for the Billing
    /// page), replacing the last figure.
    pub(crate) async fn set_pending(
        &self,
        workspace: &str,
        source: &str,
        month: &str,
        cost_micros: i64,
        detail: Option<&str>,
    ) -> Result<()> {
        // A covered source on a free workspace is never charged, so it does
        // not count toward the workspace's limit either.
        let covered = COVERED_FOR_FREE.contains(&source) && !self.has_plan(&workspace.to_lowercase()).await?;
        let charge = if covered { 0 } else { credits::with_margin(cost_micros, self.margin_percent) };
        self.db
            .prepare(
                "INSERT INTO pending_usage (workspace, source, month, charge_micros, cost_micros, updated_at, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (workspace, source, month) DO UPDATE SET
                   charge_micros = ?4, cost_micros = ?5, updated_at = ?6, detail = COALESCE(?7, detail)",
            )
            .bind(&[
                workspace.to_lowercase().into(),
                source.into(),
                month.into(),
                (charge as f64).into(),
                (cost_micros.max(0) as f64).into(),
                rfc3339(now_ms()).into(),
                optional(detail),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Charges every month that is over for the usage billing charges
    /// itself, once each.
    pub(crate) async fn charge_pending(&self) -> Result<()> {
        if self.stripe.is_none() {
            return Ok(());
        }
        let now = rfc3339(now_ms());
        let current = credits::month_of(&now);
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
            source: String,
            month: String,
            cost_micros: Option<i64>,
        }
        let marks = CHARGED_HERE.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ");
        let due = self
            .db
            .prepare(format!(
                "SELECT workspace, source, month, cost_micros FROM pending_usage
                 WHERE month < ? AND charged_at IS NULL AND source IN ({marks}) ORDER BY month LIMIT 50"
            ))
            .bind(&[current.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        for row in due {
            // Claimed first, so two crons never charge it twice.
            let claimed = self
                .db
                .prepare(
                    "UPDATE pending_usage SET charged_at = ?1
                     WHERE workspace = ?2 AND source = ?3 AND month = ?4 AND charged_at IS NULL RETURNING workspace",
                )
                .bind(&[now.as_str().into(), row.workspace.as_str().into(), row.source.as_str().into(), row.month.as_str().into()])?
                .first::<serde_json::Value>(None)
                .await?;
            let cost = row.cost_micros.unwrap_or(0);
            if claimed.is_none() || cost <= 0 {
                continue;
            }
            let base = credits::with_margin(cost, self.margin_percent);
            let (charge, terms_note) = self.charged(&row.workspace, base).await?;
            let plan = self.has_plan(&row.workspace).await?;
            let drawn = self.draw(&row.workspace, charge, &row.month, &month_end_eligible(&row.source, plan)).await?;
            let detail = if row.source == "storage" {
                let gb_months = self.gb_months(&row.workspace, &row.month).await?;
                format!(": {gb_months:.2} GB-months")
            } else {
                String::new()
            };
            let description = format!("{} in {}{detail}{terms_note}{}", title(&row.source), row.month, drawn.note());
            let reference = format!("{}/{}/{}", row.source, row.workspace, row.month);
            let created_at = credits::month_end(&row.month);
            self.post_usage(UsageLine {
                workspace: &row.workspace,
                charged: charge - drawn.total(),
                description: &description,
                repo: None,
                task: &row.source,
                cost,
                reference: &reference,
                created_at: &created_at,
                drawn,
            })
            .await?;
        }
        Ok(())
    }

    /// A workspace's private storage past the free amount in `month`.
    async fn gb_months(&self, workspace: &str, month: &str) -> Result<f64> {
        #[derive(Deserialize)]
        struct Day {
            private_bytes: i64,
            free_bytes: i64,
        }
        let days = self
            .db
            .prepare("SELECT private_bytes, free_bytes FROM storage_days WHERE workspace = ? AND substr(day, 1, 7) = ?")
            .bind(&[workspace.into(), month.into()])?
            .all()
            .await?
            .results::<Day>()?;
        Ok(storage_gb_months(&days.iter().map(|d| (d.private_bytes, d.free_bytes)).collect::<Vec<_>>()))
    }

    /// Once a day: what each workspace's private repositories hold, and
    /// what this month's storage past the free amount comes to so far.
    pub(crate) async fn measure_storage(&self) -> Result<()> {
        let Some(repos) = &self.repos else { return Ok(()) };
        let list: Vec<WorkspaceStorage> = g1t_kit::call(repos, "storage", &StorageArgs {}).await?;
        let now = rfc3339(now_ms());
        let (day, month) = (&now[..10], credits::month_of(&now));
        let price = self.price("private_storage").await?.map_or(STORAGE_MICROS_PER_GB_MONTH as f64, |(cost, _)| cost);
        for workspace in list {
            let slug = workspace.namespace.to_lowercase();
            let plan = self.has_plan(&slug).await?;
            // The same free amount for everyone: the plan pays past it.
            let free = self.plans.free_storage_bytes;
            self.db
                .prepare(
                    "INSERT INTO storage_days (workspace, day, private_bytes, free_bytes) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (workspace, day) DO UPDATE SET private_bytes = ?3, free_bytes = ?4",
                )
                .bind(&[slug.as_str().into(), day.into(), (workspace.private_bytes as f64).into(), (free as f64).into()])?
                .run()
                .await?;
            // Only the plan pays for storage past its amount. A free
            // workspace is never charged: the repos service stops its pushes
            // to private repositories once it is full (see git_ops.rs there).
            let gb_months = if plan { self.gb_months(&slug, &month).await? } else { 0.0 };
            if gb_months > 0.0 {
                let detail = format!("{gb_months:.2} GB-months past the free {}", crate::features::bytes(free));
                self.set_pending(&slug, "storage", &month, storage_cost(gb_months, price), Some(&detail)).await?;
            }
        }
        Ok(())
    }

    /// Git operations this month for each workspace, from the repos
    /// service: what is past the free amount goes to the month's pending
    /// usage for workspaces on the plan, which are never slowed or refused
    /// for them. Free workspaces are never charged for them.
    pub(crate) async fn measure_git(&self) -> Result<()> {
        let Some(repos) = &self.repos else { return Ok(()) };
        let month = credits::month_of(&rfc3339(now_ms()));
        let list: Vec<WorkspaceGitOperations> =
            g1t_kit::call(repos, "git_operations", &GitOperationsArgs { since: Some(git_since(&month)), month: month.clone(), namespace: None }).await?;
        let price = self.price("git_operations").await?.map_or(GIT_MICROS_PER_THOUSAND as f64, |(cost, _)| cost);
        for workspace in list {
            let slug = workspace.namespace.to_lowercase();
            if self.plan_kind(&slug).await? == PlanKind::Free {
                continue;
            }
            let cost = git_cost(workspace.operations, self.plans.git_included, price);
            if cost > 0 {
                let detail = format!(
                    "{} operations, {} of them free",
                    crate::features::thousands(workspace.operations),
                    crate::features::thousands(self.plans.git_included)
                );
                self.set_pending(&slug, "git", &month, cost, Some(&detail)).await?;
            }
        }
        Ok(())
    }

    /// The workspace's git operations this month, as last measured.
    pub(crate) async fn git_operations_this_month(&self, workspace: &str) -> Result<u64> {
        let Some(repos) = &self.repos else { return Ok(0) };
        let month = credits::month_of(&rfc3339(now_ms()));
        let list: Result<Vec<WorkspaceGitOperations>> =
            g1t_kit::call(repos, "git_operations", &GitOperationsArgs { since: Some(format!("{month}-01T00")), month, namespace: Some(workspace.to_lowercase()) }).await;
        Ok(list
            .ok()
            .and_then(|list| list.into_iter().find(|w| w.namespace.eq_ignore_ascii_case(workspace)))
            .map_or(0, |w| w.operations))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_and_embeddings_on_a_free_workspace_are_covered_by_g1t() {
        // No plan: g1t pays, and the trial is left alone.
        let free = month_end_eligible("security", false);
        assert!(free.cover_rest && !free.trial);
        assert!(month_end_eligible("context", false).cover_rest);
        // On the plan: charged like any usage, from its included usage first.
        let plan = month_end_eligible("security", true);
        assert!(!plan.cover_rest && plan.trial);
        // Storage, git and the cache are never kept for a free workspace;
        // were one at the close, it would not be covered either.
        assert!(!month_end_eligible("storage", false).cover_rest);
        assert!(!month_end_eligible("git", false).cover_rest);
        // A covered source is still a source billing charges at the close.
        assert!(COVERED_FOR_FREE.iter().all(|s| CHARGED_HERE.contains(s)));
    }

    #[test]
    fn storage_past_the_free_amount_is_counted_by_the_day() {
        // 3 GB private with 1 GB free, every day of a 30-day month: 2 GB-months.
        let month = vec![(3_000_000_000, 1_000_000_000); 30];
        assert!((storage_gb_months(&month) - 2.0).abs() < 1e-9);
        // Under the free amount: nothing.
        assert_eq!(storage_gb_months(&[(500_000_000, 1_000_000_000); 30]), 0.0);
        // The plan has the same 1 GB free: 11 GB on it all month is 10
        // GB-months, $5.00 to g1t, $6.00 charged, from its included usage.
        let days = vec![(11_000_000_000, 1_000_000_000); 30];
        assert!((storage_gb_months(&days) - 10.0).abs() < 1e-9);
        assert_eq!(credits::with_margin(storage_cost(storage_gb_months(&days), STORAGE_MICROS_PER_GB_MONTH as f64), 20), 6_000_000);
        // Ten days of 4 GB past it: a third of 4 GB-months.
        let days = vec![(5_000_000_000, 1_000_000_000); 10];
        assert!((storage_gb_months(&days) - 4.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn storage_is_priced_at_cloudflares_rate_plus_the_margin() {
        // $0.50 a GB-month to g1t: 2 GB-months cost $1.00, charged $1.20.
        let cost = storage_cost(2.0, 500_000.0);
        assert_eq!(cost, 1_000_000);
        assert_eq!(credits::with_margin(cost, 20), 1_200_000);
        // A fraction of a millionth rounds up.
        assert_eq!(storage_cost(0.000_000_001, 500_000.0), 1);
    }

    #[test]
    fn embeddings_and_scans_are_charged_at_cost_plus_the_margin() {
        // 10 million tokens at $0.067 a million: $0.67, charged $0.804.
        assert_eq!(credits::with_margin(670_000, 20), 804_000);
        assert_eq!(title("context"), "Search embeddings");
        assert_eq!(title("security"), "Security scans");
        assert!(CHARGED_HERE.contains(&"storage") && !CHARGED_HERE.contains(&"deployments"));
        assert!(CHARGED_HERE.contains(&"git"));
    }

    #[test]
    fn git_operations_are_charged_past_the_free_amount_at_cloudflares_price() {
        // $0.15 per 1,000 to g1t; 50,000 a month free for everyone.
        let per_thousand = GIT_MICROS_PER_THOUSAND as f64;
        let free = crate::credits::Config::default().git_included;
        assert_eq!(free, 50_000);
        assert_eq!(git_cost(49_000, free, per_thousand), 0);
        assert_eq!(git_cost(50_000, free, per_thousand), 0);
        // A workspace on the plan pushes on past it, and pays: 70,000
        // operations are 20,000 past it, $3.00 to g1t, $3.60 charged.
        assert_eq!(git_cost(70_000, free, per_thousand), 3_000_000);
        assert_eq!(credits::with_margin(git_cost(70_000, free, per_thousand), 20), 3_600_000);
        // A million in a month: no cap, $142.50 to g1t.
        assert_eq!(git_cost(1_000_000, free, per_thousand), 142_500_000);
        // One past it: a fraction of a cent, rounded up to a millionth.
        assert_eq!(git_cost(50_001, free, per_thousand), 150);
        assert_eq!(title("git"), "Git operations past the free amount");
    }

    #[test]
    fn git_operations_count_from_when_cloudflare_starts_charging() {
        assert_eq!(git_since("2026-10"), "2026-10-14T00");
        assert_eq!(git_since("2026-11"), "2026-11-01T00");
        assert_eq!(git_since("2026-09"), "2026-10-14T00");
    }
}
