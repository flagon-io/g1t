//! Usage other services meter through the month, charged once it is over:
//! security scans, search embeddings, and private repository storage,
//! which billing measures itself each day.
//!
//! Each reports what it cost g1t so far this month (`note_pending`), so the
//! workspace's limit counts it as it happens. When the month is over,
//! billing charges it once: at cost plus the margin, on the account's
//! terms, after the Team credit and the trial credit (see `credits`), dated
//! the month's last second so it falls in that month's statement and
//! invoice.
//!
//! **Storage.** The git store does not report a repository's size, so the
//! repos service counts the packs pushed through g1t's git endpoints (see
//! `g1t_contracts::repos::StorageArgs`): a lower bound. Each day billing
//! records what each workspace's private repositories hold and what is
//! free that day (`FREE_PRIVATE_STORAGE_BYTES`, or
//! `TEAM_PRIVATE_STORAGE_BYTES` on Team). Like Cloudflare's own storage
//! billing, a month's GB-months are the days' amounts past the free one,
//! added up and divided by 30. Public repositories are never charged.

use g1t_contracts::billing::{Entitlements, EntitlementsArgs};
use g1t_contracts::new_id;
use g1t_contracts::repos::{StorageArgs, WorkspaceStorage};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::credits::{self, Drawn, Eligible};
use crate::{Billing, optional};

/// Sources billing charges itself when the month is over.
pub(crate) const CHARGED_HERE: [&str; 3] = ["security", "context", "storage"];

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
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, repo, task, cost_micros, reference,
                            created_at, billed_to, credit_micros, trial_micros, oss_micros)
                         VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?, 'g1t', ?, ?, ?)",
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

    /// Writes down what a source cost g1t so far in `month`, and what it
    /// will be charged, replacing the last figure.
    pub(crate) async fn set_pending(&self, workspace: &str, source: &str, month: &str, cost_micros: i64) -> Result<()> {
        let charge = credits::with_margin(cost_micros, self.margin_percent);
        self.db
            .prepare(
                "INSERT INTO pending_usage (workspace, source, month, charge_micros, cost_micros, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (workspace, source, month) DO UPDATE SET charge_micros = ?4, cost_micros = ?5, updated_at = ?6",
            )
            .bind(&[
                workspace.to_lowercase().into(),
                source.into(),
                month.into(),
                (charge as f64).into(),
                (cost_micros.max(0) as f64).into(),
                rfc3339(now_ms()).into(),
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
            let drawn = self.draw(&row.workspace, charge, &row.month, &Eligible { trial: true, repo: None }).await?;
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
        let price = self.price("private_storage").await?.map_or(500_000.0, |(cost, _)| cost);
        for workspace in list {
            let slug = workspace.namespace.to_lowercase();
            let free = if self.team_on(&slug).await? { self.plans.team_storage_bytes } else { self.plans.free_storage_bytes };
            self.db
                .prepare(
                    "INSERT INTO storage_days (workspace, day, private_bytes, free_bytes) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (workspace, day) DO UPDATE SET private_bytes = ?3, free_bytes = ?4",
                )
                .bind(&[slug.as_str().into(), day.into(), (workspace.private_bytes as f64).into(), (free as f64).into()])?
                .run()
                .await?;
            let gb_months = self.gb_months(&slug, &month).await?;
            if gb_months > 0.0 {
                self.set_pending(&slug, "storage", &month, storage_cost(gb_months, price)).await?;
            }
        }
        Ok(())
    }

    /// `entitlements`: what the workspace's plans give it now.
    pub(crate) async fn entitlements(&self, a: EntitlementsArgs) -> Result<Entitlements> {
        let workspace = a.workspace.to_lowercase();
        let team = self.team_on(&workspace).await?;
        let now = rfc3339(now_ms());
        let month = credits::month_of(&now);
        #[derive(Deserialize)]
        struct Stored {
            private_bytes: Option<i64>,
        }
        let stored = self
            .db
            .prepare("SELECT private_bytes FROM storage_days WHERE workspace = ? ORDER BY day DESC LIMIT 1")
            .bind(&[workspace.as_str().into()])?
            .first::<Stored>(None)
            .await?
            .and_then(|s| s.private_bytes)
            .unwrap_or(0);
        #[derive(Deserialize)]
        struct Sum {
            micros: Option<i64>,
        }
        let oss = self
            .db
            .prepare("SELECT SUM(oss_micros) AS micros FROM ledger WHERE workspace = ? AND created_at >= ?")
            .bind(&[workspace.as_str().into(), format!("{month}-01").into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0);
        Ok(Entitlements {
            team,
            audit_retention_days: if team { self.plans.team_audit_days } else { self.plans.audit_days },
            free_private_storage_bytes: if team { self.plans.team_storage_bytes } else { self.plans.free_storage_bytes },
            private_storage_bytes: stored,
            team_credit_micros: if team { self.plans.team_included_micros } else { 0 },
            team_credit_used_micros: if team { self.allowance_used("team_credit", &workspace, &month).await? } else { 0 },
            oss_paid_micros: oss,
            build_seconds_included: self.plans.build_seconds,
            build_seconds_used: self.allowance_used("build_seconds", &workspace, &month).await?.max(0) as u32,
            min_charge_micros: self.plans.min_charge_micros,
            workspace,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_past_the_free_amount_is_counted_by_the_day() {
        // 3 GB private with 1 GB free, every day of a 30-day month: 2 GB-months.
        let month = vec![(3_000_000_000, 1_000_000_000); 30];
        assert!((storage_gb_months(&month) - 2.0).abs() < 1e-9);
        // Under the free amount: nothing.
        assert_eq!(storage_gb_months(&[(500_000_000, 1_000_000_000); 30]), 0.0);
        // Team: 50 GB free.
        assert_eq!(storage_gb_months(&[(30_000_000_000, 50_000_000_000); 30]), 0.0);
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
    }
}
