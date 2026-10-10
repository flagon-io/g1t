//! What g1t pays for itself, and two caps on it.
//!
//! Every charge that settles (an agent run, sandbox time, a build) is
//! split by what paid for it, at cost: a customer's real money, or g1t's.
//! g1t's part goes to `g1t_spend` by day, bucket and billing account:
//!
//! - `comped`: work on a comped account (g1t's own, Flagon's), all of it.
//! - `trial`, `oss`: the trial credit and the open-source pool.
//! - `given`: a free workspace's overrun past its last bit of trial.
//! - `unpaid`: charged, but with no real money behind it: Stripe's test
//!   key, or `FREE_WHILE_BUILDING`.
//!
//! The plan's included usage and on-demand charges with live payments are
//! revenue, not g1t's. A workspace's own model provider costs g1t nothing.
//!
//! Two caps read it:
//!
//! 1. **A comped account's monthly budget**: `COMPED_MONTHLY_CEILING_MICROS`
//!    ($150), or the account's own limit in its terms (sudo, Accounts →
//!    Terms → Limit). Staff are emailed at 50, 75, 90 and 100%, once each a
//!    month; at 100% new work on it is refused until staff raise it or the
//!    month turns. Work already running finishes.
//! 2. **The daily breaker**: when g1t's part across every workspace today
//!    (UTC) reaches `PLATFORM_DAILY_SPEND_CAP_MICROS` ($75), new agent runs
//!    on g1t's hosted models that g1t would pay for are paused for the rest
//!    of the day: everyone's except workspaces paying with real money on
//!    the plan or an enterprise contract. Staff are emailed at once and sudo
//!    shows a red bar; staff can lift it for the day.
//!
//! Zero for either variable turns that cap off.

use g1t_contracts::billing::{
    AdminLiftBreakerArgs, BillingAccount, CompedBudget, ComputeKind, PlanKind, SpendBucket, SpendCaps,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::{Env, Result};

use crate::Billing;
use crate::credits::Drawn;
use crate::limits::alert_level;

/// The caps, from the billing service's variables.
#[derive(Clone, Debug)]
pub(crate) struct Caps {
    /// `COMPED_MONTHLY_CEILING_MICROS`: a comped account's monthly budget
    /// at cost, unless its terms set one. Zero: none.
    pub comped_monthly: i64,
    /// `PLATFORM_DAILY_SPEND_CAP_MICROS`: g1t's own spend a day before the
    /// breaker trips. Zero: no breaker.
    pub daily: i64,
    /// `CLOUDFLARE_FIXED_MONTHLY_MICROS`: Cloudflare's subscriptions, an
    /// estimate for sudo.
    pub fixed_monthly: i64,
    /// `COSTS_ALERT_EMAIL`. Empty: nothing is emailed.
    pub alert_to: String,
}

impl Caps {
    pub(crate) fn from_env(env: &Env) -> Self {
        let number = |name: &str, default: i64| {
            env.var(name).ok().and_then(|v| v.to_string().trim().parse::<i64>().ok()).unwrap_or(default).max(0)
        };
        Caps {
            comped_monthly: number("COMPED_MONTHLY_CEILING_MICROS", 150_000_000),
            daily: number("PLATFORM_DAILY_SPEND_CAP_MICROS", 75_000_000),
            fixed_monthly: number("CLOUDFLARE_FIXED_MONTHLY_MICROS", 30_000_000),
            alert_to: env.var("COSTS_ALERT_EMAIL").map(|v| v.to_string().trim().to_owned()).unwrap_or_default(),
        }
    }
}

/// g1t's part of one charge, at cost, by what paid for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Share {
    pub comped: i64,
    pub trial: i64,
    pub oss: i64,
    pub given: i64,
    pub unpaid: i64,
}

impl Share {
    pub fn total(&self) -> i64 {
        self.comped + self.trial + self.oss + self.given + self.unpaid
    }

    pub fn parts(&self) -> [(&'static str, i64); 5] {
        [("comped", self.comped), ("trial", self.trial), ("oss", self.oss), ("given", self.given), ("unpaid", self.unpaid)]
    }
}

/// What of a charge costing g1t `cost` g1t paid itself. `charged` is what
/// the workspace was charged after `drawn` paid its part (both at price);
/// `real_money` is whether payments are live. The plan's included usage
/// and what the workspace is charged are revenue only with real money.
pub(crate) fn share(cost: i64, charged: i64, drawn: &Drawn, comped: bool, real_money: bool) -> Share {
    if cost <= 0 {
        return Share::default();
    }
    if comped {
        return Share { comped: cost, ..Share::default() };
    }
    let gross = charged.max(0) + drawn.total();
    if gross <= 0 {
        // Charged nothing at all (free while g1t is being built out).
        return Share { unpaid: cost, ..Share::default() };
    }
    let part = |paid: i64| (i128::from(cost) * i128::from(paid.max(0)) / i128::from(gross)) as i64;
    let (trial, oss, given) = (part(drawn.trial), part(drawn.oss), part(drawn.given));
    let unpaid = if real_money { 0 } else { (cost - trial - oss - given).max(0) };
    Share { comped: 0, trial, oss, given, unpaid }
}

/// A comped account's monthly budget: its own (terms' limit) or the
/// default; and whether it is the default. Zero: none.
pub(crate) fn comped_ceiling(own: Option<i64>, default: i64) -> (i64, bool) {
    match own {
        Some(own) => (own.max(0), false),
        None => (default.max(0), true),
    }
}

/// Whether a budget is used up.
pub(crate) fn used_up(used: i64, ceiling: i64) -> bool {
    ceiling > 0 && used >= ceiling
}

/// Whether the breaker stops new runs: on, reached, and not lifted today.
pub(crate) fn breaker_open(today: i64, cap: i64, lifted: bool) -> bool {
    cap > 0 && today >= cap && !lifted
}

/// Whether the breaker is about this start: an agent run on g1t's hosted
/// models (an agent run that does not say is taken to be one).
pub(crate) fn breaker_applies(kind: ComputeKind, hosted_model: Option<bool>) -> bool {
    kind == ComputeKind::Agent && hosted_model.unwrap_or(true)
}

/// Whether a workspace's spend is covered by revenue, so the breaker
/// leaves it alone: live payments, not comped, and on the plan it pays for
/// (not given it by staff) or an enterprise contract.
pub(crate) fn covered_by_revenue(plan: PlanKind, comped: bool, plan_given: bool, live: bool) -> bool {
    live && !comped && match plan {
        PlanKind::Enterprise => true,
        PlanKind::Paid => !plan_given,
        _ => false,
    }
}

/// The alert to send now: the level reached, if higher than any sent this
/// month.
pub(crate) fn alert_to_send(level: u32, sent: u32) -> Option<u32> {
    (level > 0 && level > sent).then_some(level)
}

/// `$150.00`: whole cents.
pub(crate) fn cents(micros: i64) -> String {
    let cents = (micros as f64 / 10_000.0).round() as i64;
    format!("{}${}.{:02}", if cents < 0 { "-" } else { "" }, cents.abs() / 100, cents.abs() % 100)
}

/// What a start on a comped account past its budget is told. Staff-only:
/// only comped (g1t's own) accounts see it.
pub(crate) fn comped_refusal(name: &str, used: i64, ceiling: i64) -> String {
    format!(
        "{name}'s monthly budget for g1t's own agents is used up ({} of {} this month at cost), so new runs wait. Staff can raise it in sudo: Accounts, {name}, Terms, Limit.",
        cents(used),
        cents(ceiling)
    )
}

/// What a hosted-model start is told while the breaker is open.
pub(crate) fn breaker_refusal(today: i64, cap: i64) -> String {
    format!(
        "g1t's daily spend breaker is open: g1t has paid {} of its {} a day for work today, so new agent runs on g1t's hosted models wait until 00:00 UTC. Agents on the workspace's own model provider still run, and so does work on the paid plan.",
        cents(today),
        cents(cap)
    )
}

#[derive(Deserialize)]
struct Sum {
    micros: Option<i64>,
}

#[derive(Deserialize)]
struct BreakerRow {
    tripped_at: Option<String>,
    told_at: Option<String>,
    lifted_by: Option<String>,
    lifted_at: Option<String>,
    lift_note: Option<String>,
}

fn today() -> String {
    rfc3339(now_ms())[..10].to_owned()
}

impl Billing {
    fn live(&self) -> bool {
        self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live)
    }

    /// Counts g1t's part of a charge that just settled, and trips the
    /// breaker if today reached its cap. Never fails the charge: a problem
    /// here is logged.
    pub(crate) async fn count_spend(&self, workspace: &str, cost: i64, charged: i64, drawn: &Drawn) {
        if let Err(error) = self.try_count_spend(workspace, cost, charged, drawn).await {
            worker::console_error!("could not count g1t's spend for {workspace}: {error}");
        }
    }

    async fn try_count_spend(&self, workspace: &str, cost: i64, charged: i64, drawn: &Drawn) -> Result<()> {
        if cost <= 0 {
            return Ok(());
        }
        let account = self.account_of(workspace).await?;
        let paid = share(cost, charged, drawn, account.terms.full_discount(), self.live());
        if paid.total() == 0 {
            return Ok(());
        }
        let day = today();
        let mut writes = vec![];
        for (bucket, micros) in paid.parts() {
            if micros > 0 {
                writes.push(
                    self.db
                        .prepare(
                            "INSERT INTO g1t_spend (day, bucket, account, micros) VALUES (?1, ?2, ?3, ?4)
                             ON CONFLICT (day, bucket, account) DO UPDATE SET micros = micros + ?4",
                        )
                        .bind(&[day.as_str().into(), bucket.into(), account.id.as_str().into(), (micros as f64).into()])?,
                );
            }
        }
        self.db.batch(writes).await?;
        if self.caps.daily <= 0 {
            return Ok(());
        }
        let total = self.spent_on(&day).await?;
        if total < self.caps.daily {
            return Ok(());
        }
        // Tripped: recorded once a day, and staff told at once.
        let now = rfc3339(now_ms());
        let tripped = self
            .db
            .prepare(
                "INSERT INTO spend_breaker (day, tripped_at, tripped_micros) VALUES (?1, ?2, ?3)
                 ON CONFLICT (day) DO UPDATE SET tripped_at = ?2, tripped_micros = ?3 WHERE spend_breaker.tripped_at IS NULL
                 RETURNING day",
            )
            .bind(&[day.as_str().into(), now.as_str().into(), (total as f64).into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if tripped.is_some() {
            self.tell_breaker(&day, total).await?;
        }
        Ok(())
    }

    /// g1t's own spend on `day`, across every workspace.
    async fn spent_on(&self, day: &str) -> Result<i64> {
        Ok(self
            .db
            .prepare("SELECT SUM(micros) AS micros FROM g1t_spend WHERE day = ?")
            .bind(&[day.into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0))
    }

    async fn breaker_row(&self, day: &str) -> Result<Option<BreakerRow>> {
        self.db
            .prepare("SELECT tripped_at, told_at, lifted_by, lifted_at, lift_note FROM spend_breaker WHERE day = ?")
            .bind(&[day.into()])?
            .first::<BreakerRow>(None)
            .await
    }

    /// Emails staff that the breaker tripped, and notes it was told.
    async fn tell_breaker(&self, day: &str, total: i64) -> Result<()> {
        if self.caps.alert_to.is_empty() {
            return Ok(());
        }
        let lifted = self.breaker_row(day).await?.and_then(|row| row.lifted_by);
        let mut lines = vec![
            format!(
                "g1t paid {} for work today ({day}, UTC), its daily cap of {} (PLATFORM_DAILY_SPEND_CAP_MICROS). New agent runs on g1t's hosted models that g1t pays for are paused until 00:00 UTC; workspaces paying with real money, and agents on their own model provider, are not affected. Runs already going finish.",
                cents(total),
                cents(self.caps.daily)
            ),
            "To let them start again today: sudo, Costs & margin, Lift for today. To change the cap: PLATFORM_DAILY_SPEND_CAP_MICROS in services/billing/wrangler.jsonc.".to_owned(),
        ];
        if let Some(by) = lifted {
            lines.insert(1, format!("{by} had already lifted it for today, so nothing is paused."));
        }
        match crate::margin::email_staff(&self.env, &self.caps.alert_to, &format!("g1t: the daily spend breaker tripped at {}", cents(total)), &lines).await {
            Ok(()) => {
                self.db
                    .prepare("UPDATE spend_breaker SET told_at = ? WHERE day = ?")
                    .bind(&[rfc3339(now_ms()).into(), day.into()])?
                    .run()
                    .await?;
            }
            Err(error) => worker::console_error!("could not email the breaker: {error}"),
        }
        Ok(())
    }

    /// Why a start is refused by the breaker, if it is.
    pub(crate) async fn breaker_refuses(
        &self,
        plan: PlanKind,
        account: &BillingAccount,
        kind: ComputeKind,
        hosted_model: Option<bool>,
    ) -> Result<Option<String>> {
        if self.caps.daily <= 0 || !breaker_applies(kind, hosted_model) {
            return Ok(None);
        }
        let comped = account.terms.full_discount();
        if covered_by_revenue(plan, comped, account.allowances.plan, self.live()) {
            return Ok(None);
        }
        let day = today();
        let spent = self.spent_on(&day).await?;
        if spent < self.caps.daily {
            return Ok(None);
        }
        let lifted = self.breaker_row(&day).await?.is_some_and(|row| row.lifted_at.is_some());
        Ok(breaker_open(spent, self.caps.daily, lifted).then(|| breaker_refusal(spent, self.caps.daily)))
    }

    /// A comped account's budget this month.
    pub(crate) async fn comped_budget(&self, account: &BillingAccount) -> Result<CompedBudget> {
        let month = &rfc3339(now_ms())[..7];
        let used = self
            .db
            .prepare("SELECT SUM(micros) AS micros FROM g1t_spend WHERE account = ? AND bucket = 'comped' AND day >= ?")
            .bind(&[account.id.as_str().into(), format!("{month}-01").into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0);
        let (ceiling, default_ceiling) = comped_ceiling(account.terms.ceiling_micros, self.caps.comped_monthly);
        Ok(CompedBudget {
            account: account.id.clone(),
            name: account.name.clone(),
            used_micros: used,
            ceiling_micros: ceiling,
            default_ceiling,
            level: alert_level(used, ceiling),
        })
    }

    /// Why new work on a comped account is refused, if its budget is used
    /// up. None for every other account.
    pub(crate) async fn comped_stop(&self, account: &BillingAccount) -> Result<Option<String>> {
        if !account.terms.full_discount() {
            return Ok(None);
        }
        let budget = self.comped_budget(account).await?;
        Ok(used_up(budget.used_micros, budget.ceiling_micros).then(|| comped_refusal(&account.name, budget.used_micros, budget.ceiling_micros)))
    }

    /// Every 15 minutes: comped budgets' alerts, once each level a month,
    /// and a tripped breaker staff were not yet told about.
    pub(crate) async fn watch_spend(&self) -> Result<()> {
        if self.caps.alert_to.is_empty() {
            return Ok(());
        }
        let month = rfc3339(now_ms())[..7].to_owned();
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let comped = self
            .db
            .prepare(format!("SELECT id FROM billing_accounts WHERE {}", crate::sales::FULL_DISCOUNT_SQL))
            .all()
            .await?
            .results::<Id>()?;
        #[derive(Deserialize)]
        struct Sent {
            level: Option<i64>,
        }
        for Id { id } in comped {
            let Some(account) = self.find_account(&id).await? else { continue };
            let budget = self.comped_budget(&account).await?;
            let sent = self
                .db
                .prepare("SELECT MAX(level) AS level FROM budget_alerts WHERE account = ? AND month = ?")
                .bind(&[id.as_str().into(), month.as_str().into()])?
                .first::<Sent>(None)
                .await?
                .and_then(|s| s.level)
                .unwrap_or(0);
            let Some(level) = alert_to_send(budget.level, u32::try_from(sent).unwrap_or(0)) else { continue };
            let name = &account.name;
            let mut lines = vec![format!(
                "{name}'s work has cost g1t {} this month, {level}% of its {} monthly budget ({}).",
                cents(budget.used_micros),
                cents(budget.ceiling_micros),
                if budget.default_ceiling { "COMPED_MONTHLY_CEILING_MICROS" } else { "its own limit, in its terms" }
            )];
            lines.push(if level >= 100 {
                format!("New agent runs, checks and builds on {name} are refused until the budget is raised or the month turns. Runs already going finish. To raise it: sudo, Accounts, {name}, Terms, Limit.")
            } else {
                format!("At 100%, new work on {name} is refused until staff raise the budget. To raise it now: sudo, Accounts, {name}, Terms, Limit.")
            });
            let subject = format!("g1t: {name} has used {level}% of its monthly budget");
            match crate::margin::email_staff(&self.env, &self.caps.alert_to, &subject, &lines).await {
                Ok(()) => {
                    self.db
                        .prepare("INSERT OR IGNORE INTO budget_alerts (account, month, level, sent_at) VALUES (?, ?, ?, ?)")
                        .bind(&[id.as_str().into(), month.as_str().into(), level.into(), rfc3339(now_ms()).into()])?
                        .run()
                        .await?;
                }
                Err(error) => worker::console_error!("could not email {name}'s budget alert: {error}"),
            }
        }
        // A trip whose email did not go out when it happened.
        let day = today();
        if self.breaker_row(&day).await?.is_some_and(|row| row.tripped_at.is_some() && row.told_at.is_none()) {
            let total = self.spent_on(&day).await?;
            self.tell_breaker(&day, total).await?;
        }
        Ok(())
    }

    /// `admin_spend_caps`: g1t's own spend against its caps.
    pub(crate) async fn spend_caps(&self) -> Result<SpendCaps> {
        let day = today();
        let month = day[..7].to_owned();
        let month_start = format!("{month}-01");
        let today_micros = self.spent_on(&day).await?;
        let row = self.breaker_row(&day).await?;
        let lifted = row.as_ref().is_some_and(|r| r.lifted_at.is_some());
        #[derive(Deserialize)]
        struct Bucket {
            bucket: String,
            micros: Option<i64>,
        }
        let rows = self
            .db
            .prepare("SELECT bucket, SUM(micros) AS micros FROM g1t_spend WHERE day >= ? GROUP BY bucket")
            .bind(&[month_start.as_str().into()])?
            .all()
            .await?
            .results::<Bucket>()?;
        let month_buckets = ["comped", "trial", "oss", "given", "unpaid"]
            .iter()
            .map(|bucket| SpendBucket {
                bucket: (*bucket).to_owned(),
                title: bucket_title(bucket).to_owned(),
                micros: rows.iter().find(|r| r.bucket == *bucket).and_then(|r| r.micros).unwrap_or(0),
            })
            .collect();
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let ids = self
            .db
            .prepare(format!("SELECT id FROM billing_accounts WHERE {} ORDER BY id", crate::sales::FULL_DISCOUNT_SQL))
            .all()
            .await?
            .results::<Id>()?;
        let mut comped = vec![];
        for Id { id } in ids {
            if let Some(account) = self.find_account(&id).await? {
                comped.push(self.comped_budget(&account).await?);
            }
        }
        // Free workspaces' share of the reconciled costs that are not on
        // the ledger (models, sandboxes and builds are, above).
        let free_tier_micros = self
            .db
            .prepare(format!(
                "SELECT SUM(cost_micros) AS micros FROM workspace_costs
                 WHERE day >= ?1 AND bucket NOT IN ('models', 'sandboxes', 'deployments')
                   AND workspace NOT IN ({internal})
                   AND workspace NOT IN (SELECT workspace FROM workspace_costs WHERE day >= ?1 GROUP BY workspace HAVING SUM(revenue_micros) > 0)",
                internal = crate::sales::INTERNAL_SQL
            ))
            .bind(&[month_start.as_str().into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0);
        let revenue_micros = self
            .db
            .prepare("SELECT SUM(cash_micros) AS micros FROM margin_days WHERE day >= ?")
            .bind(&[month_start.as_str().into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0);
        // What a testing reset wiped from the ledger is still here.
        #[derive(Deserialize)]
        struct Reset {
            account: String,
            micros: Option<i64>,
        }
        let reset = self
            .db
            .prepare(RESET_SPEND_SQL)
            .bind(&[month_start.as_str().into()])?
            .all()
            .await?
            .results::<Reset>()?;
        let reset_micros = reset.iter().filter_map(|r| r.micros).sum();
        let reset_workspaces = reset.into_iter().map(|r| r.account.strip_prefix("ws_").unwrap_or(&r.account).to_owned()).collect();
        let fixed = self.fixed_monthly(self.caps.fixed_monthly).await?;
        // This month's days so far, each its billing cycle's share: the
        // same accrual as the statement's range (`cycle::accrued`).
        let fixed_month_micros = crate::cycle::accrued(fixed.monthly_micros, &month_start, &day, self.cycle_anchor().await?);
        Ok(SpendCaps {
            reset_micros,
            reset_workspaces,
            day,
            month,
            today_micros,
            daily_cap_micros: self.caps.daily,
            tripped: breaker_open(today_micros, self.caps.daily, lifted),
            tripped_at: row.as_ref().and_then(|r| r.tripped_at.clone()),
            lifted_by: row.as_ref().and_then(|r| r.lifted_by.clone()),
            lifted_at: row.as_ref().and_then(|r| r.lifted_at.clone()),
            lift_note: row.as_ref().and_then(|r| r.lift_note.clone()),
            month_buckets,
            comped,
            free_tier_micros,
            fixed_monthly_micros: fixed.monthly_micros,
            fixed_source: fixed.source.into(),
            fixed_read_at: fixed.read_at,
            fixed_items: fixed.items,
            fixed_month_micros,
            revenue_micros,
        })
    }

    /// `admin_lift_breaker`: hosted-model runs start again for the rest of
    /// today (UTC).
    pub(crate) async fn admin_lift_breaker(&self, a: AdminLiftBreakerArgs) -> Result<Outcome<SpendCaps>> {
        let (by, note) = (a.by.trim(), a.note.trim());
        if by.is_empty() || note.len() < 5 {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is lifting it, and why, in the note."));
        }
        let day = today();
        let now = rfc3339(now_ms());
        let note: String = note.chars().take(500).collect();
        self.db
            .prepare(
                "INSERT INTO spend_breaker (day, lifted_by, lifted_at, lift_note) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (day) DO UPDATE SET lifted_by = ?2, lifted_at = ?3, lift_note = ?4",
            )
            .bind(&[day.as_str().into(), by.into(), now.as_str().into(), note.as_str().into()])?
            .run()
            .await?;
        let spent = self.spent_on(&day).await?;
        self.audit("costs", "breaker_lifted", &format!("{day}: lifted at {} of {}: {note}", cents(spent), cents(self.caps.daily)), by)
            .await?;
        Ok(Outcome::Ok(self.spend_caps().await?))
    }
}

/// g1t's own spend since `?1` on accounts a testing reset wiped later than
/// the day it was spent (`admin_actions`, action `reset`), by account.
pub(crate) const RESET_SPEND_SQL: &str = "SELECT s.account, SUM(s.micros) AS micros FROM g1t_spend s
     WHERE s.day >= ?1 AND EXISTS (SELECT 1 FROM admin_actions a WHERE a.action = 'reset' AND a.account = s.account AND substr(a.created_at, 1, 10) >= s.day)
     GROUP BY s.account HAVING SUM(s.micros) > 0 ORDER BY s.account";

/// How sudo names a bucket of g1t's own spend.
pub(crate) fn bucket_title(bucket: &str) -> &'static str {
    match bucket {
        "comped" => "100% discount (g1t's own)",
        "trial" => "Trial pool",
        "oss" => "Open-source pool",
        "given" => "Free overruns g1t covered",
        "unpaid" => "Charged without real money",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drawn(credit: i64, trial: i64, oss: i64, given: i64) -> Drawn {
        Drawn { credit, trial, oss, given }
    }

    #[test]
    fn comped_work_is_all_g1ts_at_cost() {
        let s = share(1_000_000, 0, &Drawn::default(), true, true);
        assert_eq!(s, Share { comped: 1_000_000, ..Share::default() });
        // Nothing that cost nothing is counted.
        assert_eq!(share(0, 0, &Drawn::default(), true, true).total(), 0);
        assert_eq!(share(-5, 0, &Drawn::default(), false, false).total(), 0);
    }

    #[test]
    fn pools_pay_their_share_of_the_cost_not_the_price() {
        // $1 of cost charged at $1.20, all from the trial: $1 is g1t's.
        assert_eq!(share(1_000_000, 0, &drawn(0, 1_200_000, 0, 0), false, true), Share { trial: 1_000_000, ..Share::default() });
        // Half the open-source pool, half charged on a live card: half is g1t's.
        assert_eq!(share(1_000_000, 600_000, &drawn(0, 0, 600_000, 0), false, true), Share { oss: 500_000, ..Share::default() });
        // A free workspace's overrun past its trial.
        let s = share(1_000_000, 0, &drawn(0, 300_000, 0, 900_000), false, true);
        assert_eq!((s.trial, s.given), (250_000, 750_000));
    }

    #[test]
    fn revenue_is_only_revenue_with_real_money() {
        // Plan credit and an on-demand charge, live: none of it is g1t's.
        assert_eq!(share(1_000_000, 600_000, &drawn(600_000, 0, 0, 0), false, true).total(), 0);
        // The same in test mode: all of it.
        assert_eq!(share(1_000_000, 600_000, &drawn(600_000, 0, 0, 0), false, false), Share { unpaid: 1_000_000, ..Share::default() });
        // Free while building: charged nothing, all g1t's.
        assert_eq!(share(1_000_000, 0, &Drawn::default(), false, true), Share { unpaid: 1_000_000, ..Share::default() });
    }

    #[test]
    fn a_comped_account_gets_the_default_budget_unless_its_terms_set_one() {
        assert_eq!(comped_ceiling(None, 150_000_000), (150_000_000, true));
        assert_eq!(comped_ceiling(Some(400_000_000), 150_000_000), (400_000_000, false));
        // Zero: no budget.
        assert_eq!(comped_ceiling(None, 0), (0, true));
        assert!(!used_up(1_000_000_000, 0));
    }

    #[test]
    fn a_comped_budget_refuses_new_work_at_one_hundred_percent() {
        let ceiling = 150_000_000;
        assert!(!used_up(149_999_999, ceiling));
        assert!(used_up(150_000_000, ceiling));
        assert!(used_up(151_000_000, ceiling));
        let message = comped_refusal("flagon-io", 150_000_000, ceiling);
        assert!(message.contains("used up") && message.contains("$150.00 of $150.00") && message.contains("sudo"), "{message}");
    }

    #[test]
    fn budget_alerts_go_once_per_level_each_month() {
        let ceiling = 150_000_000;
        let mut sent = 0;
        let mut emailed = vec![];
        // Spend climbs through the month, checked every 15 minutes.
        for used in [10_000_000, 74_000_000, 75_000_000, 80_000_000, 112_500_000, 120_000_000, 135_000_000, 140_000_000, 150_000_000, 170_000_000] {
            if let Some(level) = alert_to_send(alert_level(used, ceiling), sent) {
                emailed.push(level);
                sent = level;
            }
        }
        assert_eq!(emailed, vec![50, 75, 90, 100]);
        // A jump straight past several levels sends only the highest.
        assert_eq!(alert_to_send(alert_level(140_000_000, ceiling), 0), Some(90));
        // A new month starts from nothing sent.
        assert_eq!(alert_to_send(alert_level(80_000_000, ceiling), 0), Some(50));
    }

    #[test]
    fn the_breaker_trips_at_the_cap_and_staff_can_lift_it_for_the_day() {
        let cap = 75_000_000;
        assert!(!breaker_open(74_999_999, cap, false));
        assert!(breaker_open(75_000_000, cap, false));
        // Lifted: open no more today.
        assert!(!breaker_open(90_000_000, cap, true));
        // Off.
        assert!(!breaker_open(1_000_000_000, 0, false));
        // Tomorrow's total starts at zero: the breaker resets by itself.
        assert!(!breaker_open(0, cap, false));
        let message = breaker_refusal(80_000_000, cap);
        assert!(message.contains("$80.00 of its $75.00") && message.contains("00:00 UTC"), "{message}");
    }

    #[test]
    fn the_breaker_is_about_hosted_model_agent_runs() {
        assert!(breaker_applies(ComputeKind::Agent, Some(true)));
        assert!(breaker_applies(ComputeKind::Agent, None));
        assert!(!breaker_applies(ComputeKind::Agent, Some(false)));
        assert!(!breaker_applies(ComputeKind::Check, None));
        assert!(!breaker_applies(ComputeKind::Workflow, Some(true)));
    }

    #[test]
    fn workspaces_paying_with_real_money_are_never_paused_by_the_breaker() {
        assert!(covered_by_revenue(PlanKind::Paid, false, false, true));
        assert!(covered_by_revenue(PlanKind::Enterprise, false, false, true));
        // Test-mode payments are not money.
        assert!(!covered_by_revenue(PlanKind::Paid, false, false, false));
        // The plan given by staff, comped, free: g1t pays.
        assert!(!covered_by_revenue(PlanKind::Paid, false, true, true));
        assert!(!covered_by_revenue(PlanKind::Internal, true, false, true));
        assert!(!covered_by_revenue(PlanKind::Free, false, false, true));
    }

    #[test]
    fn spend_a_testing_reset_wiped_is_found_by_the_reset_after_it() {
        // syntaqx's $7.41 of 2026-10-02 to 10-05, reset on 10-07: still
        // g1t's spend, gone from its ledger.
        assert_eq!(crate::rename::parameters(RESET_SPEND_SQL), 1);
        assert!(RESET_SPEND_SQL.contains("a.action = 'reset'") && RESET_SPEND_SQL.contains("substr(a.created_at, 1, 10) >= s.day"));
    }

    #[test]
    fn amounts_read_in_cents() {
        assert_eq!(cents(150_000_000), "$150.00");
        assert_eq!(cents(1_234_567), "$1.23");
        assert_eq!(cents(5_000), "$0.01");
    }
}
