//! What pays for usage before the workspace does.
//!
//! Every charge is worked out the same way: its cost plus the margin, then
//! the account's terms. What is left is drawn down, in this order, from:
//!
//! 1. **The Team plan's credit** (`TEAM_INCLUDED_MICROS` a month), when
//!    the workspace has Team. Any usage draws on it. Unused credit does not
//!    roll over.
//! 2. **The trial credit**: one grant per workspace
//!    (`TRIAL_WORKSPACE_MICROS`), made the first time it uses something,
//!    out of a pool for everyone that resets each calendar month
//!    (`TRIAL_MONTHLY_POOL_MICROS`). Never for deployments, which are never
//!    free.
//! 3. **g1t's open-source pool** (`OSS_POOL_MICROS` a month, at most
//!    `OSS_REPO_MICROS` for any one repository): only sandbox time and
//!    model cost for work on a public repository.
//!
//! Whatever is left is charged. Each source is a fixed, capped budget that
//! something pays for: the plan, or g1t. Nothing here is an open-ended
//! allowance per workspace.
//!
//! Months are calendar months in UTC, the same as the limits'. Every draw
//! is one D1 batch, which runs as a transaction, so two charges at once
//! never take more than a budget holds.

use g1t_contracts::billing::{Feature, MICROS_PER_DOLLAR, Pools, TermsKind, Trial, TrialArgs};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::{Env, Result};

use crate::Billing;
use crate::features::dollars;

/// Every number of the plans and pools, from the billing service's
/// variables, each with its default.
#[derive(Clone, Debug)]
pub(crate) struct Config {
    /// `TEAM_MONTHLY_CENTS`: the Team plan's price, per workspace.
    pub team_monthly_cents: u32,
    /// `TEAM_INCLUDED_MICROS`: its usage credit each month.
    pub team_included_micros: i64,
    /// `OSS_POOL_MICROS`: g1t's open-source pool each month, in all.
    pub oss_pool_micros: i64,
    /// `OSS_REPO_MICROS`: any one public repository's share of it.
    pub oss_repo_micros: i64,
    /// `TRIAL_WORKSPACE_MICROS`: each new workspace's trial credit.
    pub trial_workspace_micros: i64,
    /// `TRIAL_MONTHLY_POOL_MICROS`: trial grants each month, in all.
    pub trial_monthly_pool_micros: i64,
    /// `MIN_CHARGE_MICROS`: no card is charged less; smaller amounts carry
    /// over to the next invoice.
    pub min_charge_micros: i64,
    /// `DEPLOYMENTS_BUILD_SECONDS`: build time the Deployments plan
    /// includes each month.
    pub build_seconds: u32,
    /// `FREE_PRIVATE_STORAGE_BYTES` and `TEAM_PRIVATE_STORAGE_BYTES`:
    /// private repository storage before it is charged.
    pub free_storage_bytes: i64,
    pub team_storage_bytes: i64,
    /// `AUDIT_RETENTION_DAYS` and `TEAM_AUDIT_RETENTION_DAYS`.
    pub audit_days: u32,
    pub team_audit_days: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            team_monthly_cents: 2_000,
            team_included_micros: 5_000_000,
            oss_pool_micros: 10_000_000,
            oss_repo_micros: 1_000_000,
            trial_workspace_micros: 1_000_000,
            trial_monthly_pool_micros: 40_000_000,
            min_charge_micros: 5_000_000,
            build_seconds: g1t_contracts::billing::deployments_allowance::BUILD_SECONDS,
            free_storage_bytes: 1_000_000_000,
            team_storage_bytes: 50_000_000_000,
            audit_days: 30,
            team_audit_days: 365,
        }
    }
}

impl Config {
    pub(crate) fn from_env(env: &Env) -> Self {
        let d = Config::default();
        let number = |name: &str, default: i64| -> i64 {
            env.var(name).ok().and_then(|v| v.to_string().trim().parse::<i64>().ok()).filter(|n| *n >= 0).unwrap_or(default)
        };
        Config {
            team_monthly_cents: number("TEAM_MONTHLY_CENTS", d.team_monthly_cents.into()) as u32,
            team_included_micros: number("TEAM_INCLUDED_MICROS", d.team_included_micros),
            oss_pool_micros: number("OSS_POOL_MICROS", d.oss_pool_micros),
            oss_repo_micros: number("OSS_REPO_MICROS", d.oss_repo_micros),
            trial_workspace_micros: number("TRIAL_WORKSPACE_MICROS", d.trial_workspace_micros),
            trial_monthly_pool_micros: number("TRIAL_MONTHLY_POOL_MICROS", d.trial_monthly_pool_micros),
            min_charge_micros: number("MIN_CHARGE_MICROS", d.min_charge_micros),
            build_seconds: number("DEPLOYMENTS_BUILD_SECONDS", d.build_seconds.into()) as u32,
            free_storage_bytes: number("FREE_PRIVATE_STORAGE_BYTES", d.free_storage_bytes),
            team_storage_bytes: number("TEAM_PRIVATE_STORAGE_BYTES", d.team_storage_bytes),
            audit_days: number("AUDIT_RETENTION_DAYS", d.audit_days.into()) as u32,
            team_audit_days: number("TEAM_AUDIT_RETENTION_DAYS", d.team_audit_days.into()) as u32,
        }
    }
}

/// What may pay for a charge besides the Team credit, which any usage may
/// draw on.
#[derive(Clone, Debug, Default)]
pub(crate) struct Eligible {
    /// The trial credit: everything but deployments.
    pub trial: bool,
    /// The open-source pool: sandbox time and model cost for work on this
    /// repository (`owner/name`), if it is public.
    pub repo: Option<String>,
}

/// What paid for a charge before the workspace did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Drawn {
    pub credit: i64,
    pub trial: i64,
    pub oss: i64,
}

impl Drawn {
    pub fn total(&self) -> i64 {
        self.credit + self.trial + self.oss
    }

    /// For the statement: what paid for the entry, e.g. ` ($0.12 paid by
    /// g1t's open-source pool)`. Empty when nothing did.
    pub fn note(&self) -> String {
        let parts: Vec<String> = [
            (self.credit, "your Team plan's credit"),
            (self.trial, "your trial credit"),
            (self.oss, "g1t's open-source pool"),
        ]
        .iter()
        .filter(|(micros, _)| *micros > 0)
        .map(|(micros, by)| format!("{} paid by {by}", dollars(*micros)))
        .collect();
        if parts.is_empty() { String::new() } else { format!(" ({})", parts.join(", ")) }
    }
}

/// How `gross` is paid for from sources with `available` left each, in
/// order: each takes what it can of what is still unpaid. The rest is
/// charged.
pub(crate) fn split(gross: i64, available: &[i64]) -> Vec<i64> {
    let mut left = gross.max(0);
    available
        .iter()
        .map(|available| {
            let take = left.min((*available).max(0));
            left -= take;
            take
        })
        .collect()
}

/// What a budget with `cap` and `used` so far has left.
pub(crate) fn left(cap: i64, used: i64) -> i64 {
    (cap - used).max(0)
}

/// `YYYY-MM` of an RFC 3339 time.
pub(crate) fn month_of(timestamp: &str) -> String {
    timestamp[..7].to_owned()
}

/// The first instant of the month after `month`: when this month's pools
/// reset.
pub(crate) fn next_month_start(month: &str) -> String {
    let year: i32 = month[..4].parse().unwrap_or(1970);
    let number: u32 = month[5..7].parse().unwrap_or(1);
    if number == 12 {
        format!("{}-01-01T00:00:00Z", year + 1)
    } else {
        format!("{year}-{:02}-01T00:00:00Z", number + 1)
    }
}

/// The last second of `month`, for a charge that belongs to a month that
/// is over.
pub(crate) fn month_end(month: &str) -> String {
    let year: i32 = month[..4].parse().unwrap_or(1970);
    let number: u32 = month[5..7].parse().unwrap_or(1);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match number {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    format!("{month}-{days:02}T23:59:59Z")
}

/// What a trial grant would be: the account's own amount from sudo, or the
/// default.
pub(crate) fn grant_size(config: &Config, staff: Option<i64>) -> i64 {
    staff.unwrap_or(config.trial_workspace_micros).max(0)
}

/// Whether this month's pool can still make a grant of `amount`.
pub(crate) fn pool_has_room(pool: i64, granted_this_month: i64, amount: i64) -> bool {
    amount > 0 && granted_this_month + amount <= pool
}

#[derive(Deserialize)]
struct Used {
    used: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct Grant {
    pub granted_micros: i64,
    pub used_micros: i64,
}

impl Billing {
    /// Whether the workspace has the Team plan now: paid for, comped, or
    /// given by g1t in sudo.
    pub(crate) async fn team_on(&self, workspace: &str) -> Result<bool> {
        let account = self.account_of(workspace).await?;
        if account.terms.kind == TermsKind::Comped || account.allowances.team {
            return Ok(true);
        }
        if self.stripe.is_none() {
            return Ok(false);
        }
        self.plan_on(workspace, Feature::Team).await
    }

    /// What one monthly allowance has used.
    pub(crate) async fn allowance_used(&self, kind: &str, scope: &str, month: &str) -> Result<i64> {
        Ok(self
            .db
            .prepare("SELECT used FROM allowance_use WHERE kind = ? AND scope = ? AND month = ?")
            .bind(&[kind.into(), scope.into(), month.into()])?
            .first::<Used>(None)
            .await?
            .and_then(|u| u.used)
            .unwrap_or(0))
    }

    /// Takes up to `want` from a monthly allowance with `cap`, as one
    /// transaction. Returns what it took.
    pub(crate) async fn draw_allowance(&self, kind: &str, scope: &str, month: &str, want: i64, cap: i64) -> Result<i64> {
        if want <= 0 || cap <= 0 {
            return Ok(0);
        }
        let key = [kind.into(), scope.into(), month.into()];
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare("INSERT OR IGNORE INTO allowance_use (kind, scope, month, used) VALUES (?1, ?2, ?3, 0)")
                    .bind(&key)?,
                self.db
                    .prepare("SELECT used FROM allowance_use WHERE kind = ?1 AND scope = ?2 AND month = ?3")
                    .bind(&key)?,
                self.db
                    .prepare(
                        "UPDATE allowance_use SET used = MIN(?4, used + ?5)
                         WHERE kind = ?1 AND scope = ?2 AND month = ?3 AND used < ?4",
                    )
                    .bind(&[kind.into(), scope.into(), month.into(), (cap as f64).into(), (want as f64).into()])?,
                self.db
                    .prepare("SELECT used FROM allowance_use WHERE kind = ?1 AND scope = ?2 AND month = ?3")
                    .bind(&key)?,
            ])
            .await?;
        let read = |i: usize| -> Result<i64> {
            Ok(results[i].results::<Used>()?.first().and_then(|u| u.used).unwrap_or(0))
        };
        Ok((read(3)? - read(1)?).max(0))
    }

    /// Gives back what was drawn and not used.
    async fn return_allowance(&self, kind: &str, scope: &str, month: &str, amount: i64) -> Result<()> {
        if amount > 0 {
            self.db
                .prepare("UPDATE allowance_use SET used = MAX(0, used - ?4) WHERE kind = ?1 AND scope = ?2 AND month = ?3")
                .bind(&[kind.into(), scope.into(), month.into(), (amount as f64).into()])?
                .run()
                .await?;
        }
        Ok(())
    }

    // --- Trials -----------------------------------------------------------

    pub(crate) async fn grant_of(&self, workspace: &str) -> Result<Option<Grant>> {
        self.db
            .prepare("SELECT granted_micros, used_micros FROM trial_grants WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Grant>(None)
            .await
    }

    /// Trial grants made this month, in all.
    pub(crate) async fn trial_granted(&self, month: &str) -> Result<(i64, u32)> {
        #[derive(Deserialize)]
        struct Row {
            micros: Option<i64>,
            n: Option<u32>,
        }
        let row = self
            .db
            .prepare("SELECT SUM(granted_micros) AS micros, COUNT(*) AS n FROM trial_grants WHERE month = ?")
            .bind(&[month.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.map_or((0, 0), |r| (r.micros.unwrap_or(0), r.n.unwrap_or(0))))
    }

    /// The workspace's grant, made now out of this month's pool if it has
    /// none and the pool has room. A grant g1t staff set comes from no pool.
    async fn ensure_grant(&self, workspace: &str) -> Result<Option<Grant>> {
        if let Some(grant) = self.grant_of(workspace).await? {
            return Ok(Some(grant));
        }
        if !self.trials_on {
            return Ok(None);
        }
        let staff = self.account_of(workspace).await?.allowances.trial_micros;
        let amount = grant_size(&self.plans, staff);
        if amount <= 0 {
            return Ok(None);
        }
        let now = rfc3339(now_ms());
        let month = if staff.is_some() { "staff".to_owned() } else { month_of(&now) };
        // One statement: the pool is checked and the grant made together.
        self.db
            .prepare(
                "INSERT INTO trial_grants (workspace, month, granted_micros, used_micros, created_at)
                 SELECT ?1, ?2, ?3, 0, ?4
                 WHERE ?2 = 'staff'
                    OR (SELECT COALESCE(SUM(granted_micros), 0) FROM trial_grants WHERE month = ?2) + ?3 <= ?5
                 ON CONFLICT (workspace) DO NOTHING",
            )
            .bind(&[
                workspace.into(),
                month.as_str().into(),
                (amount as f64).into(),
                now.as_str().into(),
                (self.plans.trial_monthly_pool_micros as f64).into(),
            ])?
            .run()
            .await?;
        self.grant_of(workspace).await
    }

    /// Takes up to `want` from the workspace's trial credit.
    async fn draw_trial(&self, workspace: &str, want: i64) -> Result<i64> {
        if want <= 0 || self.ensure_grant(workspace).await?.is_none() {
            return Ok(0);
        }
        #[derive(Deserialize)]
        struct Row {
            used_micros: i64,
        }
        let results = self
            .db
            .batch(vec![
                self.db.prepare("SELECT used_micros FROM trial_grants WHERE workspace = ?1").bind(&[workspace.into()])?,
                self.db
                    .prepare(
                        "UPDATE trial_grants SET used_micros = MIN(granted_micros, used_micros + ?2)
                         WHERE workspace = ?1 AND used_micros < granted_micros",
                    )
                    .bind(&[workspace.into(), (want as f64).into()])?,
                self.db.prepare("SELECT used_micros FROM trial_grants WHERE workspace = ?1").bind(&[workspace.into()])?,
            ])
            .await?;
        let read = |i: usize| -> Result<i64> { Ok(results[i].results::<Row>()?.first().map_or(0, |r| r.used_micros)) };
        Ok((read(2)? - read(0)?).max(0))
    }

    /// `trial`: where the workspace's trial credit stands.
    pub(crate) async fn trial(&self, a: TrialArgs) -> Result<Trial> {
        let workspace = a.workspace.to_lowercase();
        let closed = |reason: &str| Trial {
            open: false,
            used_micros: 0,
            limit_micros: 0,
            ends_at: None,
            reason: Some(reason.to_owned()),
            granted: false,
            waits_until: None,
        };
        if let Some(grant) = self.grant_of(&workspace).await? {
            let open = grant.used_micros < grant.granted_micros;
            return Ok(Trial {
                open,
                used_micros: grant.used_micros,
                limit_micros: grant.granted_micros,
                ends_at: None,
                reason: (!open).then(|| "used".to_owned()),
                granted: true,
                waits_until: None,
            });
        }
        if !self.trials_on {
            return Ok(closed("off"));
        }
        let staff = self.account_of(&workspace).await?.allowances.trial_micros;
        let amount = grant_size(&self.plans, staff);
        if amount <= 0 {
            return Ok(closed("off"));
        }
        let month = month_of(&rfc3339(now_ms()));
        let (granted, _) = self.trial_granted(&month).await?;
        let room = staff.is_some() || pool_has_room(self.plans.trial_monthly_pool_micros, granted, amount);
        Ok(Trial {
            open: room,
            used_micros: 0,
            limit_micros: amount,
            ends_at: None,
            reason: (!room).then(|| "pool".to_owned()),
            granted: false,
            waits_until: (!room).then(|| next_month_start(&month)),
        })
    }

    // --- The open-source pool ---------------------------------------------

    /// Whether `repo` (`owner/name`) is public, asked of the repos service.
    /// Unknown counts as private: the pool pays only for what is known to
    /// be open.
    async fn is_public(&self, repo: &str) -> bool {
        let Some(repos) = &self.repos else { return false };
        let found: Result<Vec<g1t_contracts::repos::RepoVisibility>> = g1t_kit::call(
            repos,
            "visibility",
            &g1t_contracts::repos::VisibilityArgs { paths: vec![repo.to_owned()] },
        )
        .await;
        match found {
            Ok(list) => list.iter().any(|v| v.path.eq_ignore_ascii_case(repo) && !v.is_private),
            Err(error) => {
                worker::console_error!("could not ask whether {repo} is public: {error}");
                false
            }
        }
    }

    /// A public repository's monthly cap on the pool: its account's own
    /// from sudo, or `OSS_REPO_MICROS`.
    async fn oss_repo_cap(&self, workspace: &str) -> Result<i64> {
        Ok(self.account_of(workspace).await?.allowances.oss_repo_micros.unwrap_or(self.plans.oss_repo_micros))
    }

    /// Takes up to `want` from the open-source pool for `repo`, within the
    /// pool's cap and the repository's.
    async fn draw_oss(&self, workspace: &str, repo: &str, month: &str, want: i64) -> Result<i64> {
        let repo = repo.to_lowercase();
        let cap = self.oss_repo_cap(workspace).await?;
        let room = left(cap, self.allowance_used("oss_repo", &repo, month).await?);
        let from_pool = self.draw_allowance("oss_pool", "", month, want.min(room), self.plans.oss_pool_micros).await?;
        let for_repo = self.draw_allowance("oss_repo", &repo, month, from_pool, cap).await?;
        // The repository's cap filled up meanwhile: give the pool back the rest.
        self.return_allowance("oss_pool", "", month, from_pool - for_repo).await?;
        Ok(for_repo)
    }

    // --- Drawing down -----------------------------------------------------

    /// Pays for a `gross` charge from the Team credit, the trial credit and
    /// the open-source pool, in that order, for usage in `month`. Returns
    /// what each paid; the rest is the workspace's to pay.
    pub(crate) async fn draw(&self, workspace: &str, gross: i64, month: &str, eligible: &Eligible) -> Result<Drawn> {
        if gross <= 0 {
            return Ok(Drawn::default());
        }
        let team = self.team_on(workspace).await?;
        let credit_left = if team {
            left(self.plans.team_included_micros, self.allowance_used("team_credit", workspace, month).await?)
        } else {
            0
        };
        let trial_left = if eligible.trial {
            match self.grant_of(workspace).await? {
                Some(grant) => left(grant.granted_micros, grant.used_micros),
                // Granted on first use, if the pool has room.
                None => match self.trial(TrialArgs { workspace: workspace.to_owned(), exempt: vec![] }).await? {
                    trial if trial.open => trial.limit_micros,
                    _ => 0,
                },
            }
        } else {
            0
        };
        // Asked only when the rest has not paid for it all.
        let public_repo = match &eligible.repo {
            Some(repo) if gross > credit_left + trial_left && self.is_public(repo).await => Some(repo.clone()),
            _ => None,
        };
        let oss_left = match &public_repo {
            Some(repo) => left(self.plans.oss_pool_micros, self.allowance_used("oss_pool", "", month).await?)
                .min(left(self.oss_repo_cap(workspace).await?, self.allowance_used("oss_repo", &repo.to_lowercase(), month).await?)),
            None => 0,
        };
        let planned = split(gross, &[credit_left, trial_left, oss_left]);
        let mut drawn = Drawn::default();
        drawn.credit = self.draw_allowance("team_credit", workspace, month, planned[0], self.plans.team_included_micros).await?;
        drawn.trial = self.draw_trial(workspace, planned[1]).await?;
        if let Some(repo) = &public_repo {
            drawn.oss = self.draw_oss(workspace, repo, month, planned[2]).await?;
        }
        Ok(drawn)
    }

    /// Writes down on a usage entry what paid for it.
    pub(crate) async fn record_drawn(&self, reference: &str, drawn: &Drawn) -> Result<()> {
        if drawn.total() == 0 {
            return Ok(());
        }
        self.db
            .prepare("UPDATE ledger SET credit_micros = ?, trial_micros = ?, oss_micros = ? WHERE reference = ?")
            .bind(&[
                (drawn.credit as f64).into(),
                (drawn.trial as f64).into(),
                (drawn.oss as f64).into(),
                reference.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// g1t's pools this month, for sudo.
    pub(crate) async fn pools(&self) -> Result<Pools> {
        let month = month_of(&rfc3339(now_ms()));
        let (granted, grants) = self.trial_granted(&month).await?;
        Ok(Pools {
            oss_used_micros: self.allowance_used("oss_pool", "", &month).await?,
            oss_pool_micros: self.plans.oss_pool_micros,
            oss_repo_micros: self.plans.oss_repo_micros,
            trial_granted_micros: granted,
            trial_pool_micros: self.plans.trial_monthly_pool_micros,
            trial_grants: grants,
            month,
        })
    }
}

/// A charge in millionths of a dollar for `micros` of cost plus `margin`.
pub(crate) fn with_margin(cost_micros: i64, margin_percent: u32) -> i64 {
    crate::charge_micros(cost_micros.max(0) as f64 / MICROS_PER_DOLLAR as f64, margin_percent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_credit_pays_first_then_the_trial_then_the_pool_then_the_workspace() {
        // $0.50 of usage; $0.20 of Team credit, $1 of trial, $1 of pool.
        assert_eq!(split(500_000, &[200_000, 1_000_000, 1_000_000]), [200_000, 300_000, 0]);
        // No Team: the trial pays all of it.
        assert_eq!(split(500_000, &[0, 1_000_000, 1_000_000]), [0, 500_000, 0]);
        // Trial spent: the pool pays, where it applies.
        assert_eq!(split(500_000, &[0, 0, 1_000_000]), [0, 0, 500_000]);
        // Everything spent: the workspace pays all of it.
        let planned = split(500_000, &[0, 0, 0]);
        assert_eq!(planned, [0, 0, 0]);
        assert_eq!(500_000 - planned.iter().sum::<i64>(), 500_000);
        // Each pays what it can, and the rest is charged.
        let planned = split(500_000, &[100_000, 150_000, 50_000]);
        assert_eq!(planned, [100_000, 150_000, 50_000]);
        assert_eq!(500_000 - planned.iter().sum::<i64>(), 200_000);
        // Nothing is drawn for nothing, nor from a negative balance.
        assert_eq!(split(0, &[1, 1, 1]), [0, 0, 0]);
        assert_eq!(split(100, &[-5, 50, 100]), [0, 50, 50]);
    }

    #[test]
    fn a_budget_never_gives_more_than_its_cap() {
        assert_eq!(left(1_000_000, 400_000), 600_000);
        assert_eq!(left(1_000_000, 1_000_000), 0);
        assert_eq!(left(1_000_000, 1_200_000), 0);
        // The open-source pool: the repository's share and the pool's both bound it.
        let pool = left(10_000_000, 9_900_000);
        let repo = left(1_000_000, 300_000);
        assert_eq!(split(800_000, &[pool.min(repo)]), [100_000]);
    }

    #[test]
    fn pools_reset_each_calendar_month() {
        assert_eq!(month_of("2026-10-31T23:59:59Z"), "2026-10");
        assert_eq!(month_of("2026-11-01T00:00:00Z"), "2026-11");
        assert_eq!(next_month_start("2026-10"), "2026-11-01T00:00:00Z");
        assert_eq!(next_month_start("2026-12"), "2027-01-01T00:00:00Z");
        // A pool given out this month has room again next month, since
        // grants count only against the month they were made in.
        assert!(!pool_has_room(40_000_000, 40_000_000, 1_000_000));
        assert!(!pool_has_room(40_000_000, 39_500_000, 1_000_000));
        assert!(pool_has_room(40_000_000, 0, 1_000_000));
        assert!(pool_has_room(40_000_000, 39_000_000, 1_000_000));
        assert!(!pool_has_room(40_000_000, 0, 0));
    }

    #[test]
    fn a_trial_grant_is_the_default_unless_staff_set_one() {
        let config = Config::default();
        assert_eq!(grant_size(&config, None), 1_000_000);
        assert_eq!(grant_size(&config, Some(5_000_000)), 5_000_000);
        assert_eq!(grant_size(&config, Some(-1)), 0);
    }

    #[test]
    fn a_month_ends_on_its_last_day() {
        assert_eq!(month_end("2026-10"), "2026-10-31T23:59:59Z");
        assert_eq!(month_end("2026-09"), "2026-09-30T23:59:59Z");
        assert_eq!(month_end("2028-02"), "2028-02-29T23:59:59Z");
        assert_eq!(month_end("2027-02"), "2027-02-28T23:59:59Z");
    }

    #[test]
    fn what_paid_is_said_on_the_statement() {
        assert_eq!(Drawn::default().note(), "");
        let drawn = Drawn { credit: 0, trial: 0, oss: 120_000 };
        assert_eq!(drawn.note(), " ($0.12 paid by g1t's open-source pool)");
        let drawn = Drawn { credit: 50_000, trial: 20_000, oss: 0 };
        assert_eq!(drawn.note(), " ($0.05 paid by your Team plan's credit, $0.02 paid by your trial credit)");
        assert_eq!(drawn.total(), 70_000);
    }

    #[test]
    fn the_defaults_are_the_published_ones() {
        let c = Config::default();
        assert_eq!(c.team_monthly_cents, 2_000);
        assert_eq!(c.team_included_micros, 5_000_000);
        assert_eq!(c.oss_pool_micros, 10_000_000);
        assert_eq!(c.oss_repo_micros, 1_000_000);
        assert_eq!(c.trial_monthly_pool_micros, 40_000_000);
        assert_eq!(c.min_charge_micros, 5_000_000);
        assert_eq!(c.build_seconds, 12_000);
        assert_eq!(c.free_storage_bytes, 1_000_000_000);
        assert_eq!(c.team_storage_bytes, 50_000_000_000);
    }
}
