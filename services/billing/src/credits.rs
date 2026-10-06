//! What pays for usage before the workspace does.
//!
//! Every charge is worked out the same way: its cost plus the margin, then
//! the account's terms. What is left is drawn down, in this order, from:
//!
//! 1. **The plan's included usage** (`PLAN_INCLUDED_MICROS` a month, $10),
//!    when the workspace has the g1t plan. Any usage draws on it. Unused
//!    included usage does not roll over.
//! 2. **The trial credit**: one grant per workspace
//!    (`TRIAL_WORKSPACE_MICROS`, $5), made once its card is checked (see
//!    `cards`), out of a pool for everyone that resets each calendar month
//!    (`TRIAL_MONTHLY_POOL_MICROS`, $100). Never for deployments.
//! 3. **g1t's open-source pool** (`OSS_POOL_MICROS` a month, $25, at most
//!    `OSS_REPO_MICROS`, $2, for any one repository): checks, workflows and
//!    the merge queue on a public repository.
//!
//! Whatever is left is charged: from what was paid in advance first, since
//! a charge comes off the balance, and then owed. For a free workspace's
//! compute, what is left past its trial is covered by g1t (`given`): a free
//! workspace is never charged for compute, and `reserve` keeps that to the
//! runs already in flight when the trial ran out.
//!
//! Each source is a fixed, capped budget that something pays for: the
//! plan, or g1t. Nothing here is an open-ended allowance per workspace.
//!
//! Months are calendar months in UTC, the same as the limits'. Every draw
//! is one D1 batch, which runs as a transaction, so two charges at once
//! never take more than a budget holds.

use g1t_contracts::billing::{ComputeKind, Feature, PlanKind, Pools, TermsKind, Trial, TrialArgs};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::{Env, Result};

use crate::Billing;
use crate::features::dollars;

/// Every number of the plan and the pools, from the billing service's
/// variables, each with its default.
#[derive(Clone, Debug)]
pub(crate) struct Config {
    /// `PLAN_MONTHLY_CENTS`: the plan's price, per workspace: $20.
    pub plan_monthly_cents: u32,
    /// `PLAN_INCLUDED_MICROS`: its included usage each month: $10.
    pub plan_included_micros: i64,
    /// `OSS_POOL_MICROS`: g1t's open-source pool each month, in all.
    pub oss_pool_micros: i64,
    /// `OSS_REPO_MICROS`: any one public repository's share of it.
    pub oss_repo_micros: i64,
    /// `TRIAL_WORKSPACE_MICROS`: each new workspace's trial credit.
    pub trial_workspace_micros: i64,
    /// `TRIAL_MONTHLY_POOL_MICROS`: trial grants each month, in all.
    pub trial_monthly_pool_micros: i64,
    /// `MIN_CHARGE_MICROS`: a month's close charges no less; smaller
    /// amounts carry over. Charges at a limit always go through.
    pub min_charge_micros: i64,
    /// `FREE_PRIVATE_STORAGE_BYTES`: private repository storage that is
    /// free for every workspace. Past it, the plan pays at cost plus the
    /// margin; a free workspace's pushes to private repositories stop.
    pub free_storage_bytes: i64,
    /// `AUDIT_RETENTION_DAYS`: the same on every plan.
    pub audit_days: u32,
    /// `RUN_CAP_MICROS` and `ISSUE_CAP_MICROS`: one run's spend cap, and
    /// agents' spend on one issue in all.
    pub run_cap_micros: i64,
    pub issue_cap_micros: i64,
    /// `LIMIT_PAID_START_MICROS`: a new paid workspace's ceiling in its
    /// first month.
    pub paid_start_micros: i64,
    /// `SPIKE_FACTOR` and `SPIKE_FLOOR_MICROS`: an hour above this many
    /// times the usual hour, and at least this much, is a spike.
    pub spike_factor: i64,
    pub spike_floor_micros: i64,
    /// `OVERAGE_FORGIVE_COST_MICROS`: the most of an overage's real cost a
    /// one-click goodwill credit covers.
    pub forgive_cost_micros: i64,
    /// `GIT_OPERATIONS_INCLUDED`: git operations a month that are free for
    /// every workspace. Past it, the plan pays at cost plus the margin and
    /// is never slowed; a free workspace is slowed down (the repos
    /// service's `GIT_OPERATIONS_FREE_CAP`, the same number), never charged.
    pub git_included: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            plan_monthly_cents: 2_000,
            plan_included_micros: 10_000_000,
            oss_pool_micros: 25_000_000,
            oss_repo_micros: 2_000_000,
            trial_workspace_micros: 5_000_000,
            trial_monthly_pool_micros: 100_000_000,
            min_charge_micros: 5_000_000,
            free_storage_bytes: 1_000_000_000,
            audit_days: 90,
            run_cap_micros: g1t_contracts::guardrails::DEFAULT_RUN_CAP_MICROS,
            issue_cap_micros: 10_000_000,
            paid_start_micros: 100_000_000,
            spike_factor: 5,
            spike_floor_micros: 5_000_000,
            forgive_cost_micros: 50_000_000,
            git_included: 50_000,
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
            plan_monthly_cents: number("PLAN_MONTHLY_CENTS", d.plan_monthly_cents.into()) as u32,
            plan_included_micros: number("PLAN_INCLUDED_MICROS", d.plan_included_micros),
            oss_pool_micros: number("OSS_POOL_MICROS", d.oss_pool_micros),
            oss_repo_micros: number("OSS_REPO_MICROS", d.oss_repo_micros),
            trial_workspace_micros: number("TRIAL_WORKSPACE_MICROS", d.trial_workspace_micros),
            trial_monthly_pool_micros: number("TRIAL_MONTHLY_POOL_MICROS", d.trial_monthly_pool_micros),
            min_charge_micros: number("MIN_CHARGE_MICROS", d.min_charge_micros),
            free_storage_bytes: number("FREE_PRIVATE_STORAGE_BYTES", d.free_storage_bytes),
            audit_days: number("AUDIT_RETENTION_DAYS", d.audit_days.into()) as u32,
            run_cap_micros: number("RUN_CAP_MICROS", d.run_cap_micros),
            issue_cap_micros: number("ISSUE_CAP_MICROS", d.issue_cap_micros),
            paid_start_micros: number("LIMIT_PAID_START_MICROS", d.paid_start_micros),
            spike_factor: number("SPIKE_FACTOR", d.spike_factor).max(1),
            spike_floor_micros: number("SPIKE_FLOOR_MICROS", d.spike_floor_micros),
            forgive_cost_micros: number("OVERAGE_FORGIVE_COST_MICROS", d.forgive_cost_micros),
            git_included: number("GIT_OPERATIONS_INCLUDED", d.git_included as i64) as u64,
        }
    }
}

/// What may pay for a charge besides the plan's included usage, which any
/// usage may draw on.
#[derive(Clone, Debug, Default)]
pub(crate) struct Eligible {
    /// The trial credit: everything but deployments.
    pub trial: bool,
    /// The open-source pool: this repository (`owner/name`), if it is
    /// public. Only checks, workflows and the merge queue name one.
    pub repo: Option<String>,
    /// g1t covers what is left, rather than charging it, when the workspace
    /// has no plan: a free workspace's compute.
    pub cover_rest: bool,
}

/// What paid for a charge before the workspace did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Drawn {
    pub credit: i64,
    pub trial: i64,
    pub oss: i64,
    /// What g1t covered itself.
    pub given: i64,
}

impl Drawn {
    pub fn total(&self) -> i64 {
        self.credit + self.trial + self.oss + self.given
    }

    /// For the statement: what paid for the entry, e.g. ` ($0.12 paid by
    /// g1t's open-source pool)`. Empty when nothing did.
    pub fn note(&self) -> String {
        let parts: Vec<String> = [
            (self.credit, "paid by your plan's included usage"),
            (self.trial, "paid by your trial credit"),
            (self.oss, "paid by g1t's open-source pool"),
            (self.given, "covered by g1t"),
        ]
        .iter()
        .filter(|(micros, _)| *micros > 0)
        .map(|(micros, by)| format!("{} {by}", dollars(*micros)))
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
    /// The workspace's plan: comped terms are internal, an enterprise's
    /// workspaces are invoiced, and otherwise the plan is paid for (or
    /// given by staff without its price) or not. A Deployments subscription
    /// from before the plan counts as the plan until its period ends.
    /// Without a card processor every workspace has the plan: a g1t that
    /// does not charge has nothing to gate.
    pub(crate) async fn plan_kind(&self, workspace: &str) -> Result<PlanKind> {
        let account = self.account_of(workspace).await?;
        if account.terms.kind == TermsKind::Comped {
            return Ok(PlanKind::Internal);
        }
        if account.kind == g1t_contracts::billing::AccountKind::Enterprise {
            return Ok(PlanKind::Enterprise);
        }
        if self.stripe.is_none() || account.allowances.plan {
            return Ok(PlanKind::Paid);
        }
        if self.plan_on(workspace, Feature::Plan).await? || self.plan_on(workspace, Feature::Deployments).await? {
            return Ok(PlanKind::Paid);
        }
        Ok(PlanKind::Free)
    }

    /// Whether the workspace has the g1t plan now, whoever pays for it.
    pub(crate) async fn has_plan(&self, workspace: &str) -> Result<bool> {
        Ok(self.plan_kind(workspace).await? != PlanKind::Free)
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

    /// Adds `amount` to a monthly count with no cap, such as the month's
    /// build seconds, which the Billing page shows beside what they cost.
    pub(crate) async fn tally(&self, kind: &str, scope: &str, month: &str, amount: i64) -> Result<()> {
        if amount <= 0 {
            return Ok(());
        }
        self.db
            .prepare(
                "INSERT INTO allowance_use (kind, scope, month, used) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (kind, scope, month) DO UPDATE SET used = used + ?4",
            )
            .bind(&[kind.into(), scope.into(), month.into(), (amount as f64).into()])?
            .run()
            .await?;
        Ok(())
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
    /// none and the pool has room. Called once its card is checked, never
    /// before: the trial needs a card check. A grant g1t staff set comes
    /// from no pool.
    pub(crate) async fn ensure_grant(&self, workspace: &str) -> Result<Option<Grant>> {
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

    /// Takes up to `want` from the workspace's trial credit, if it has a
    /// grant.
    async fn draw_trial(&self, workspace: &str, want: i64) -> Result<i64> {
        if want <= 0 || self.grant_of(workspace).await?.is_none() {
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

    /// `trial`: where the workspace's trial credit stands. Not granted yet,
    /// it waits for a card check (`verify`), or for next month's pool
    /// (`pool`).
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
            open: false,
            used_micros: 0,
            limit_micros: amount,
            ends_at: None,
            reason: Some(if room { "verify" } else { "pool" }.to_owned()),
            granted: false,
            waits_until: (!room).then(|| next_month_start(&month)),
        })
    }

    // --- The open-source pool ---------------------------------------------

    /// Whether `repo` (`owner/name`) is public, asked of the repos service.
    /// Unknown counts as private: the pool pays only for what is known to
    /// be open.
    pub(crate) async fn is_public(&self, repo: &str) -> bool {
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
    pub(crate) async fn oss_repo_cap(&self, workspace: &str) -> Result<i64> {
        Ok(self.account_of(workspace).await?.allowances.oss_repo_micros.unwrap_or(self.plans.oss_repo_micros))
    }

    /// What the open-source pool has left this month for `repo`: the
    /// pool's and the repository's share, whichever is less.
    pub(crate) async fn oss_left(&self, workspace: &str, repo: &str, month: &str) -> Result<i64> {
        let pool = left(self.plans.oss_pool_micros, self.allowance_used("oss_pool", "", month).await?);
        let share = left(self.oss_repo_cap(workspace).await?, self.allowance_used("oss_repo", &repo.to_lowercase(), month).await?);
        Ok(pool.min(share))
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

    /// Pays for a `gross` charge from the plan's included usage, the trial
    /// credit and the open-source pool, in that order, for usage in
    /// `month`; then, for a free workspace's compute, g1t covers the rest.
    /// Returns what each paid; the rest is the workspace's to pay.
    pub(crate) async fn draw(&self, workspace: &str, gross: i64, month: &str, eligible: &Eligible) -> Result<Drawn> {
        if gross <= 0 {
            return Ok(Drawn::default());
        }
        let plan = self.has_plan(workspace).await?;
        let credit_left = if plan {
            left(self.plans.plan_included_micros, self.allowance_used("plan_credit", workspace, month).await?)
        } else {
            0
        };
        let trial_left = if eligible.trial {
            self.grant_of(workspace).await?.map_or(0, |grant| left(grant.granted_micros, grant.used_micros))
        } else {
            0
        };
        // Asked only when the rest has not paid for it all.
        let public_repo = match &eligible.repo {
            Some(repo) if gross > credit_left + trial_left && self.is_public(repo).await => Some(repo.clone()),
            _ => None,
        };
        let oss_left = match &public_repo {
            Some(repo) => self.oss_left(workspace, repo, month).await?,
            None => 0,
        };
        let planned = split(gross, &[credit_left, trial_left, oss_left]);
        let mut drawn = Drawn {
            credit: self.draw_allowance("plan_credit", workspace, month, planned[0], self.plans.plan_included_micros).await?,
            trial: self.draw_trial(workspace, planned[1]).await?,
            ..Drawn::default()
        };
        if let Some(repo) = &public_repo {
            drawn.oss = self.draw_oss(workspace, repo, month, planned[2]).await?;
        }
        if eligible.cover_rest && !plan {
            drawn.given = (gross - drawn.credit - drawn.trial - drawn.oss).max(0);
        }
        Ok(drawn)
    }

    /// Writes down on a usage entry what paid for it.
    pub(crate) async fn record_drawn(&self, reference: &str, drawn: &Drawn) -> Result<()> {
        if drawn.total() == 0 {
            return Ok(());
        }
        self.db
            .prepare("UPDATE ledger SET credit_micros = ?, trial_micros = ?, oss_micros = ?, given_micros = ? WHERE reference = ?")
            .bind(&[
                (drawn.credit as f64).into(),
                (drawn.trial as f64).into(),
                (drawn.oss as f64).into(),
                (drawn.given as f64).into(),
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

/// What may pay for compute: the trial (never for deployments), the
/// open-source pool for checks, workflows and the merge queue on `repo`,
/// and g1t for a free workspace's overrun. Work whose kind is not known is
/// taken as an agent's: never the pool.
pub(crate) fn eligible_for(kind: Option<ComputeKind>, repo: Option<&str>) -> Eligible {
    let kind = kind.unwrap_or(ComputeKind::Agent);
    Eligible {
        trial: kind != ComputeKind::Deploy,
        repo: repo.filter(|_| kind.open_source_pool()).map(str::to_owned),
        cover_rest: kind != ComputeKind::Deploy,
    }
}

/// A charge in millionths of a dollar for `micros` of cost plus `margin`.
pub(crate) fn with_margin(cost_micros: i64, margin_percent: u32) -> i64 {
    crate::charge_micros(cost_micros.max(0) as f64 / g1t_contracts::billing::MICROS_PER_DOLLAR as f64, margin_percent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn included_usage_pays_first_then_the_trial_then_the_pool_then_the_workspace() {
        // $0.50 of usage; $0.20 included, $1 of trial, $1 of pool.
        assert_eq!(split(500_000, &[200_000, 1_000_000, 1_000_000]), [200_000, 300_000, 0]);
        // No plan: the trial pays all of it.
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
        let pool = left(25_000_000, 24_900_000);
        let repo = left(2_000_000, 300_000);
        assert_eq!(split(800_000, &[pool.min(repo)]), [100_000]);
        // A repository past its $2 share gets nothing, however full the pool.
        assert_eq!(split(800_000, &[left(25_000_000, 0).min(left(2_000_000, 2_000_000))]), [0]);
    }

    #[test]
    fn the_open_source_pool_pays_only_for_checks_workflows_and_the_queue() {
        assert_eq!(eligible_for(Some(ComputeKind::Check), Some("acme/web")).repo.as_deref(), Some("acme/web"));
        assert_eq!(eligible_for(Some(ComputeKind::Queue), Some("acme/web")).repo.as_deref(), Some("acme/web"));
        assert_eq!(eligible_for(Some(ComputeKind::Workflow), Some("acme/web")).repo.as_deref(), Some("acme/web"));
        // An agent on a public repository pays as any agent does.
        assert!(eligible_for(Some(ComputeKind::Agent), Some("acme/web")).repo.is_none());
        // Unknown work is never the pool's.
        assert!(eligible_for(None, Some("acme/web")).repo.is_none());
        // Deployments are never the trial's, and never covered.
        let deploy = eligible_for(Some(ComputeKind::Deploy), Some("acme/web"));
        assert!(!deploy.trial && !deploy.cover_rest && deploy.repo.is_none());
        assert!(eligible_for(Some(ComputeKind::Agent), None).trial);
    }

    #[test]
    fn pools_reset_each_calendar_month() {
        assert_eq!(month_of("2026-10-31T23:59:59Z"), "2026-10");
        assert_eq!(month_of("2026-11-01T00:00:00Z"), "2026-11");
        assert_eq!(next_month_start("2026-10"), "2026-11-01T00:00:00Z");
        assert_eq!(next_month_start("2026-12"), "2027-01-01T00:00:00Z");
        // $100 a month in $5 grants: twenty trials, then the next month.
        assert!(pool_has_room(100_000_000, 95_000_000, 5_000_000));
        assert!(!pool_has_room(100_000_000, 100_000_000, 5_000_000));
        assert!(!pool_has_room(100_000_000, 97_500_000, 5_000_000));
        assert!(pool_has_room(100_000_000, 0, 5_000_000));
        assert!(!pool_has_room(100_000_000, 0, 0));
    }

    #[test]
    fn a_trial_grant_is_the_default_unless_staff_set_one() {
        let config = Config::default();
        assert_eq!(grant_size(&config, None), 5_000_000);
        assert_eq!(grant_size(&config, Some(20_000_000)), 20_000_000);
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
        let drawn = Drawn { oss: 120_000, ..Drawn::default() };
        assert_eq!(drawn.note(), " ($0.12 paid by g1t's open-source pool)");
        let drawn = Drawn { credit: 50_000, trial: 20_000, ..Drawn::default() };
        assert_eq!(drawn.note(), " ($0.05 paid by your plan's included usage, $0.02 paid by your trial credit)");
        assert_eq!(drawn.total(), 70_000);
        let drawn = Drawn { trial: 300_000, given: 40_000, ..Drawn::default() };
        assert_eq!(drawn.note(), " ($0.30 paid by your trial credit, $0.04 covered by g1t)");
        assert_eq!(drawn.total(), 340_000);
    }

    #[test]
    fn the_defaults_are_the_published_ones() {
        let c = Config::default();
        assert_eq!(c.plan_monthly_cents, 2_000);
        assert_eq!(c.plan_included_micros, 10_000_000);
        assert_eq!(c.oss_pool_micros, 25_000_000);
        assert_eq!(c.oss_repo_micros, 2_000_000);
        assert_eq!(c.trial_workspace_micros, 5_000_000);
        assert_eq!(c.trial_monthly_pool_micros, 100_000_000);
        assert_eq!(c.min_charge_micros, 5_000_000);
        assert_eq!(c.free_storage_bytes, 1_000_000_000);
        assert_eq!(c.audit_days, 90);
        assert_eq!(c.run_cap_micros, g1t_contracts::guardrails::DEFAULT_RUN_CAP_MICROS);
        assert_eq!(c.issue_cap_micros, 10_000_000);
        assert_eq!(c.paid_start_micros, 100_000_000);
        assert_eq!(c.forgive_cost_micros, 50_000_000);
        assert_eq!(c.git_included, 50_000);
    }
}
