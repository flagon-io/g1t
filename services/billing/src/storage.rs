//! Usage other services meter through the month, charged once it is over:
//! security scans, the actions cache, and two billing measures itself each
//! day: private repository storage and git operations. `context` (search
//! embeddings) is no longer reported, since the context service was
//! retired; it stays a source so usage noted before is still charged and
//! closed.
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
//! amounts past the free one, added up and divided by the month's days
//! (28 to 31), and only the
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

/// Sources billing charges itself when the month is over: those billing
/// measures (storage, git operations, package storage) and those other
/// services note through the month (`note_pending`: security scans, search
/// embeddings, the actions cache, observability data).
pub(crate) const CHARGED_HERE: [&str; 7] = ["security", "context", "storage", "git", "cache", "package_storage", "telemetry"];

/// A `pending_usage` column less what the workspace had of it when its
/// test-mode data was detached (`pending_baselines`, migration 0060),
/// never below nothing. Reads `pending_usage` unaliased.
macro_rules! net_of_baseline {
    ($column:literal) => {
        concat!(
            "MAX(0, COALESCE(pending_usage.", $column, ", 0) - COALESCE((SELECT b.", $column,
            " FROM pending_baselines b WHERE b.workspace = pending_usage.workspace AND b.source = pending_usage.source",
            " AND b.month = pending_usage.month), 0))"
        )
    };
}

/// What a pending row cost g1t since the detach (all of it without one):
/// what everything that values or charges pending usage reads.
pub(crate) const NET_COST: &str = net_of_baseline!("cost_micros");
/// What a pending row will be charged since the detach, before terms.
pub(crate) const NET_CHARGE: &str = net_of_baseline!("charge_micros");

/// A month's figure for a source, as `note_pending` writes it. Never into
/// a month closed for the workspace, and the update leaves a row already
/// charged as it was: a late report of a month that is over never
/// rewrites what was charged.
pub(crate) const SET_PENDING: &str = "INSERT INTO pending_usage (workspace, source, month, charge_micros, cost_micros, updated_at, detail)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (SELECT 1 FROM month_closes WHERE month_closes.workspace = ?1 AND month_closes.month = ?3)
     ON CONFLICT (workspace, source, month) DO UPDATE SET
       charge_micros = ?4, cost_micros = ?5, updated_at = ?6, detail = COALESCE(?7, detail)
     WHERE pending_usage.charged_at IS NULL";

/// Whether a workspace had the plan in a month by what it paid or drew:
/// a plan payment in the month that a test-mode detach has not reversed
/// (its `_test_detach` row nets it to nothing), or the plan's included
/// usage drawn in it. `?1` workspace, `?2` the month's first day, `?3` the
/// next month's, `?4` the month.
pub(crate) const PLAN_EVIDENCE: &str = "SELECT (EXISTS (SELECT 1 FROM plan_payments p WHERE p.workspace = ?1 AND p.paid_at >= ?2 AND p.paid_at < ?3
                        AND p.amount_micros > 0 AND substr(p.invoice_id, -12) <> '_test_detach'
                        AND p.amount_micros + COALESCE((SELECT SUM(q.amount_micros) FROM plan_payments q
                                                        WHERE q.invoice_id = p.invoice_id || '_test_detach'), 0) > 0)
          OR EXISTS (SELECT 1 FROM allowance_use WHERE kind = 'plan_credit' AND scope = ?1 AND month = ?4 AND used > 0)) AS had";

/// Sources only the plan is charged for: a free workspace's are not kept.
pub(crate) const PLAN_ONLY: [&str; 1] = ["cache"];

/// Sources g1t pays for itself on a free workspace: security scans and
/// (from before the context service was retired) search embeddings. No security feature is held back for the plan, and
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
/// what was past the free amount each day, over the month's `month_days`.
pub(crate) fn storage_gb_months(days: &[(i64, i64)], month_days: u32) -> f64 {
    days.iter().map(|(private, free)| (private - free).max(0) as f64).sum::<f64>() / GB / f64::from(month_days.max(1))
}

/// GB-months of package storage past the free amounts from a month's
/// daily measures, each `(public, private, public_free, private_free)`:
/// public and private past their own amounts, over the month's
/// `month_days`.
pub(crate) fn package_gb_months(days: &[(i64, i64, i64, i64)], month_days: u32) -> f64 {
    days.iter()
        .map(|(public, private, public_free, private_free)| ((public - public_free).max(0) + (private - private_free).max(0)) as f64)
        .sum::<f64>()
        / GB
        / f64::from(month_days.max(1))
}

/// What R2 charges g1t a GB-month, when the price book cannot be read.
pub(crate) const PACKAGE_MICROS_PER_GB_MONTH: i64 = 15_000;

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
        "package_storage" => "Package storage past the free amounts",
        "git" => "Git operations past the free amount",
        "cache" => "Actions cache storage",
        "domains" => "Custom domains",
        "telemetry" => "Observability data past the free amount",
        _ => "Metered usage",
    }
}

/// Whether a batch's first statement, an insert `RETURNING id`, wrote its
/// row: none comes back when `ON CONFLICT … DO NOTHING` skipped it.
pub(crate) fn posted(results: &[worker::D1Result]) -> Result<bool> {
    #[derive(Deserialize)]
    struct Row {
        #[allow(dead_code)]
        id: String,
    }
    match results.first() {
        Some(result) => Ok(!result.results::<Row>()?.is_empty()),
        None => Ok(false),
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
    /// one write. False when an entry with its reference is already there
    /// (another delivery of the same usage wrote it first): nothing is
    /// written, and the caller gives back what it drew (`undraw`).
    pub(crate) async fn post_usage(&self, line: UsageLine<'_>) -> Result<bool> {
        self.post_usage_with(line, vec![]).await
    }

    /// `post_usage`, with `also` written in the same batch, whether or not
    /// the entry was new.
    pub(crate) async fn post_usage_with(&self, line: UsageLine<'_>, also: Vec<worker::D1PreparedStatement>) -> Result<bool> {
        // The price versions it was charged at (pricing.rs).
        let mut versions = Vec::new();
        for meter in crate::pricing::meters_of(line.task) {
            versions.extend(self.version_now(meter).await?);
        }
        let price_version = versions.join(",");
        let id = new_id("led", now_ms());
        // The ledger's unique reference is the guard: the entry goes in
        // only if no other has it, and the balance moves only if it did.
        let mut statements = vec![
            self.db
                .prepare(
                    "INSERT INTO ledger
                       (id, workspace, kind, amount_micros, description, repo, task, cost_micros, reference,
                        created_at, billed_to, credit_micros, trial_micros, oss_micros, given_micros, price_version)
                     VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?, 'g1t', ?, ?, ?, ?, ?)
                     ON CONFLICT (reference) DO NOTHING RETURNING id",
                )
                .bind(&[
                    id.as_str().into(),
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
                    // What g1t covered itself (a free workspace's scans and
                    // embeddings): given, never margin lost.
                    (line.drawn.given as f64).into(),
                    optional(Some(price_version.as_str()).filter(|v| !v.is_empty())),
                ])?,
            self.balance_if_posted(line.workspace, line.charged, &id)?,
        ];
        statements.extend(also);
        let results = self.db.batch(statements).await?;
        posted(&results)
    }

    /// Takes `charged` off the workspace's balance, only if the ledger entry
    /// `id` was written in the same batch.
    pub(crate) fn balance_if_posted(&self, workspace: &str, charged: i64, id: &str) -> Result<worker::D1PreparedStatement> {
        self.db
            .prepare(
                "INSERT INTO accounts (workspace, balance_micros, created_at)
                 SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM ledger WHERE id = ?4)
                 ON CONFLICT (workspace) DO UPDATE SET balance_micros = balance_micros + ?2",
            )
            .bind(&[workspace.into(), (-(charged as f64)).into(), rfc3339(now_ms()).into(), id.into()])
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
            .prepare(SET_PENDING)
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
        if !self.charging {
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
            // Less what was metered before a test-mode detach: not charged.
            .prepare(format!(
                "SELECT workspace, source, month, {NET_COST} AS cost_micros FROM pending_usage
                 WHERE month < ? AND charged_at IS NULL AND source IN ({marks}) ORDER BY month LIMIT 50"
            ))
            .bind(&[current.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        for row in due {
            // Marked charged in the same batch as its ledger entry, never
            // before: a failure in between leaves it to the next tick, and
            // the ledger's unique reference keeps two crons from charging
            // it twice.
            let mark = || {
                self.db
                    .prepare(
                        "UPDATE pending_usage SET charged_at = ?1
                         WHERE workspace = ?2 AND source = ?3 AND month = ?4 AND charged_at IS NULL",
                    )
                    .bind(&[now.as_str().into(), row.workspace.as_str().into(), row.source.as_str().into(), row.month.as_str().into()])
            };
            let cost = row.cost_micros.unwrap_or(0);
            if cost <= 0 {
                mark()?.run().await?;
                continue;
            }
            let base = credits::with_margin(cost, self.margin_percent);
            let (charge, terms_note, discount) = self.charged(&row.workspace, base).await?;
            // The plan as it was in that month, not as it is now: a plan
            // started since does not pay for it, and one ended since still
            // does.
            let plan = self.had_plan_in(&row.workspace, &row.month).await?;
            let eligible = month_end_eligible(&row.source, plan);
            let drawn = self.draw_as(&row.workspace, charge, &row.month, &eligible, plan).await?;
            let detail = if row.source == "storage" {
                let gb_months = self.gb_months(&row.workspace, &row.month).await?;
                format!(": {gb_months:.2} GB-months")
            } else {
                String::new()
            };
            let description = format!("{} in {}{detail}{terms_note}{}", title(&row.source), row.month, drawn.note());
            let reference = format!("{}/{}/{}", row.source, row.workspace, row.month);
            let created_at = credits::month_end(&row.month);
            let line = UsageLine {
                workspace: &row.workspace,
                charged: charge - drawn.total(),
                description: &description,
                repo: None,
                task: &row.source,
                cost,
                reference: &reference,
                created_at: &created_at,
                drawn,
            };
            let posted = match self.post_usage_with(line, vec![mark()?]).await {
                Ok(posted) => posted,
                Err(error) => {
                    // Nothing was written: what was drawn goes back.
                    self.undraw(&row.workspace, &row.month, &drawn, None).await?;
                    return Err(error);
                }
            };
            if !posted {
                // Charged already (another tick won): give back the draw.
                self.undraw(&row.workspace, &row.month, &drawn, None).await?;
                continue;
            }
            self.record_discount(&reference, discount).await?;
        }
        Ok(())
    }

    /// Whether the workspace had the plan in `month`: g1t's own,
    /// enterprises and a plan staff gave by their terms; otherwise a plan
    /// invoice paid in the month and not reversed by a test-mode detach,
    /// the plan's included usage drawn in it, or a plan on now that
    /// started before the month ended (`PLAN_EVIDENCE`).
    pub(crate) async fn had_plan_in(&self, workspace: &str, month: &str) -> Result<bool> {
        let account = self.account_of(workspace).await?;
        let now = self.plan_kind_for(workspace, &account).await?;
        if matches!(now, PlanKind::Internal | PlanKind::Enterprise) || account.allowances.plan || !self.charging {
            return Ok(now != PlanKind::Free);
        }
        let next = credits::next_month_start(month);
        if now == PlanKind::Paid
            && let Some((started_at, _)) = self.plan_cycle(workspace).await?
            && started_at.as_str() < next.as_str()
        {
            return Ok(true);
        }
        #[derive(Deserialize)]
        struct Evidence {
            had: Option<i64>,
        }
        Ok(self
            .db
            .prepare(PLAN_EVIDENCE)
            .bind(&[workspace.into(), format!("{month}-01").into(), next.as_str().into(), month.into()])?
            .first::<Evidence>(None)
            .await?
            .and_then(|e| e.had)
            .unwrap_or(0)
            == 1)
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
        Ok(storage_gb_months(&days.iter().map(|d| (d.private_bytes, d.free_bytes)).collect::<Vec<_>>(), credits::days_in(month)))
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

    /// Once a day: what each workspace's packages hold, public and private,
    /// from the packages service, and for the plan what this month's
    /// storage past the free amounts comes to so far. A free workspace is
    /// never charged: the packages service refuses its pushes past them.
    pub(crate) async fn measure_packages(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Held {
            workspace: String,
            public_bytes: i64,
            private_bytes: i64,
        }
        #[derive(Deserialize)]
        struct Day {
            public_bytes: i64,
            private_bytes: i64,
            public_free_bytes: i64,
            private_free_bytes: i64,
        }
        let Some(packages) = &self.packages else { return Ok(()) };
        let list: Vec<Held> = g1t_kit::call(packages, "storage_all", &serde_json::json!({})).await?;
        let now = rfc3339(now_ms());
        let (day, month) = (&now[..10], credits::month_of(&now));
        let price = self.price("package_storage").await?.map_or(PACKAGE_MICROS_PER_GB_MONTH as f64, |(cost, _)| cost);
        let (public_free, private_free) = (self.plans.public_package_free_bytes, self.plans.private_package_free_bytes);
        for held in list {
            let slug = held.workspace.to_lowercase();
            self.db
                .prepare(
                    "INSERT INTO package_storage_days (workspace, day, public_bytes, private_bytes, public_free_bytes, private_free_bytes)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (workspace, day) DO UPDATE SET public_bytes = ?3, private_bytes = ?4, public_free_bytes = ?5, private_free_bytes = ?6",
                )
                .bind(&[
                    slug.as_str().into(),
                    day.into(),
                    (held.public_bytes as f64).into(),
                    (held.private_bytes as f64).into(),
                    (public_free as f64).into(),
                    (private_free as f64).into(),
                ])?
                .run()
                .await?;
            if !self.has_plan(&slug).await? {
                continue;
            }
            let days = self
                .db
                .prepare(
                    "SELECT public_bytes, private_bytes, public_free_bytes, private_free_bytes FROM package_storage_days
                     WHERE workspace = ? AND substr(day, 1, 7) = ?",
                )
                .bind(&[slug.as_str().into(), month.as_str().into()])?
                .all()
                .await?
                .results::<Day>()?;
            let gb_months = package_gb_months(
                &days.iter().map(|d| (d.public_bytes, d.private_bytes, d.public_free_bytes, d.private_free_bytes)).collect::<Vec<_>>(),
                credits::days_in(&month),
            );
            if gb_months > 0.0 {
                let detail = format!(
                    "{gb_months:.2} GB-months past the free {} public and {} private",
                    crate::features::bytes(public_free),
                    crate::features::bytes(private_free)
                );
                self.set_pending(&slug, "package_storage", &month, storage_cost(gb_months, price), Some(&detail)).await?;
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
        assert!((storage_gb_months(&month, 30) - 2.0).abs() < 1e-9);
        // Under the free amount: nothing.
        assert_eq!(storage_gb_months(&[(500_000_000, 1_000_000_000); 30], 30), 0.0);
        // The plan has the same 1 GB free: 11 GB on it all month is 10
        // GB-months, $5.00 to g1t, $6.00 charged, from its included usage.
        let days = vec![(11_000_000_000, 1_000_000_000); 30];
        assert!((storage_gb_months(&days, 30) - 10.0).abs() < 1e-9);
        assert_eq!(credits::with_margin(storage_cost(storage_gb_months(&days, 30), STORAGE_MICROS_PER_GB_MONTH as f64), 20), 6_000_000);
        // Ten days of 4 GB past it: a third of 4 GB-months.
        let days = vec![(5_000_000_000, 1_000_000_000); 10];
        assert!((storage_gb_months(&days, 30) - 4.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn a_month_of_storage_is_its_own_days_not_thirty() {
        // 2 GB past the free amount every day of a 31-day month is 2
        // GB-months, not 2.07; every day of February, 2 too, not 1.87.
        let october = vec![(3_000_000_000, 1_000_000_000); 31];
        assert!((storage_gb_months(&october, credits::days_in("2026-10")) - 2.0).abs() < 1e-9);
        let february = vec![(3_000_000_000, 1_000_000_000); 28];
        assert!((storage_gb_months(&february, credits::days_in("2026-02")) - 2.0).abs() < 1e-9);
        assert_eq!(credits::days_in("2028-02"), 29);
        let gb = GB as i64;
        let packages = vec![(11 * gb, 0, 10 * gb, 0); 31];
        assert!((package_gb_months(&packages, 31) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn package_storage_counts_public_and_private_past_their_own_free_amounts() {
        let gb = GB as i64;
        // 12 GB public with 10 free, 0.5 GB private with 0.5 free: 2 GB past, for 15 days.
        let days = vec![(12 * gb, gb / 2, 10 * gb, gb / 2); 15];
        assert!((package_gb_months(&days, 30) - 1.0).abs() < 1e-9);
        // Under both amounts: nothing.
        assert_eq!(package_gb_months(&[(gb, gb / 4, 10 * gb, gb / 2)], 30), 0.0);
        // At R2's rate, a GB-month is $0.015.
        assert_eq!(storage_cost(1.0, PACKAGE_MICROS_PER_GB_MONTH as f64), 15_000);
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
        // Package storage and observability data are charged when the month
        // closes, like storage, and each is named on the statement.
        for source in ["package_storage", "telemetry"] {
            assert!(CHARGED_HERE.contains(&source), "{source}");
            assert_ne!(title(source), "Metered usage", "{source}");
            assert!(!crate::pricing::meters_of(source).is_empty(), "{source}");
            assert!(crate::pricing::meters_of(source).iter().all(|m| crate::pricing::MONTHLY.contains(m)), "{source}");
            assert!(!COVERED_FOR_FREE.contains(&source) && !PLAN_ONLY.contains(&source), "{source}");
        }
        assert_eq!(title("telemetry"), "Observability data past the free amount");
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
