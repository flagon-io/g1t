//! How far a workspace can run up costs g1t has not been paid for, and how
//! far its owners let it spend.
//!
//! Every sandbox second, build, app request and model token costs g1t
//! money at Cloudflare or a model provider before the workspace pays for
//! it. So each workspace has a ceiling on that unpaid usage:
//!
//! - **Free**: a few dollars (`LIMIT_NEW_MICROS`), for what a free
//!   workspace can owe at all (private storage past 1 GB). Free workspaces
//!   have no on-demand compute: the trial and g1t's pools pay for it.
//! - **Paid, first month**: `LIMIT_PAID_START_MICROS` ($100) while the plan
//!   is in its first billing cycle.
//! - **Paid, after**: twice what it has paid g1t once payments clear
//!   (`SETTLE_DAYS`), never less than the starting ceiling; after three
//!   steady months it follows the monthly spend, up to $10,000.
//! - **Reviewed**: a ceiling g1t staff set by hand.
//! - **Internal**: g1t's own workspaces, with none.
//!
//! A ceiling g1t granted (an approved request, or the owners' one-time
//! raise) is a floor under the trust ceiling. Money paid in advance raises
//! what can be used before work stops by the same amount, at once: it comes
//! off what is owed before anything counts against the ceiling.
//!
//! Owners also set a monthly **spend limit** on what is charged. They may
//! put it anywhere up to the highest ceiling the workspace has ever had,
//! plus what is prepaid, without asking anyone; once per workspace they may
//! raise it to twice that highest ceiling themselves. Past that, they ask
//! (see `requests`), and g1t answers within one business day.
//!
//! Alerts go out at 50, 75, 90 and 100% of the plan's included usage, the
//! spend limit and the ceiling, in the app and by email. At the ceiling or
//! the spend limit, new work stops: no new sandboxes, builds or app
//! requests until it is paid, raised, or the month turns. Runs already
//! under way finish.
//!
//! Usage counts at what it cost g1t or what it is charged, whichever is
//! more. Test-mode payments are not money, so they do not raise trust.

use g1t_contracts::billing::{
    CheckLimitArgs, Limit, LimitArgs, LimitState, NotePendingArgs, PlanKind, SetSpendLimitArgs, TermsKind, Trust,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{Env, Result};

use crate::features::dollars as dollars_plain;
use crate::{Billing, members_only};

/// The ceilings, from the billing service's variables.
pub(crate) struct Ceilings {
    /// `LIMIT_NEW_MICROS`: a free workspace's.
    pub new: i64,
    /// `LIMIT_PAID_MIN_MICROS` and `LIMIT_PAID_MAX_MICROS`: the bounds of a
    /// paid workspace's, from what it has paid.
    pub paid_min: i64,
    pub paid_max: i64,
}

impl Ceilings {
    pub(crate) fn from_env(env: &Env) -> Self {
        let number = |name: &str, default: i64| {
            env.var(name).ok().and_then(|v| v.to_string().parse::<i64>().ok()).unwrap_or(default)
        };
        Ceilings {
            new: number("LIMIT_NEW_MICROS", 3_000_000),
            paid_min: number("LIMIT_PAID_MIN_MICROS", 25_000_000),
            paid_max: number("LIMIT_PAID_MAX_MICROS", 1_000_000_000),
        }
    }

    /// The ceiling for a workspace that has paid `paid` in live money.
    pub(crate) fn for_paid(&self, paid: i64) -> i64 {
        (paid * 2).clamp(self.paid_min, self.paid_max)
    }
}

/// Where a workspace stands against its ceiling.
pub(crate) fn state(exposure: i64, ceiling: Option<i64>) -> LimitState {
    match ceiling {
        Some(ceiling) if exposure >= ceiling => LimitState::Stopped,
        Some(ceiling) if exposure * 5 >= ceiling * 4 => LimitState::Warning,
        _ => LimitState::Ok,
    }
}

/// The automatic monthly spend limit's floor: $200.
pub(crate) const DEFAULT_SPEND_MICROS: i64 = 200_000_000;
/// Established workspaces' ceiling: three times their steady monthly
/// spend, up to $10,000.
const ESTABLISHED_FACTOR: i64 = 3;
const ESTABLISHED_MAX_MICROS: i64 = 10_000_000_000;
/// A month counts toward Established at this much spend or more.
const ESTABLISHED_MONTH_MICROS: i64 = 20_000_000;
/// Payments raise trust once this old: past the time most bad cards are
/// caught.
pub(crate) const SETTLE_DAYS: u64 = 7;

/// The automatic spend limit: $200, or twice last month's spend.
pub(crate) fn automatic_spend_limit(last_month_charged: i64) -> i64 {
    DEFAULT_SPEND_MICROS.max(last_month_charged * 2)
}

/// An Established workspace's ceiling, from its last three months'
/// charges, if each was steady enough.
pub(crate) fn established_ceiling(months: &[i64]) -> Option<i64> {
    if months.len() < 3 || months.iter().any(|m| *m < ESTABLISHED_MONTH_MICROS) {
        return None;
    }
    let average = months.iter().sum::<i64>() / months.len() as i64;
    Some((average * ESTABLISHED_FACTOR).min(ESTABLISHED_MAX_MICROS))
}

/// Days since 1970-01-01 of a `YYYY-MM-DD…` date, for comparing dates
/// without a clock (Howard Hinnant's days-from-civil).
pub(crate) fn days(date: &str) -> i64 {
    let year: i64 = date.get(..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let month: i64 = date.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    let day: i64 = date.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(1);
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Whether a plan that started at `started_at` is still in its first
/// billing cycle: its paid period ends no more than a month after it
/// started (a renewal moves the end a month on), or, with no period known,
/// it started within the last 31 days.
pub(crate) fn in_first_cycle(started_at: &str, period_end: Option<&str>, now: &str) -> bool {
    match period_end {
        Some(end) => days(end) - days(started_at) <= 32 && days(now) <= days(end),
        None => days(now) - days(started_at) <= 31,
    }
}

/// g1t's ceiling for a workspace on the plan: the starting one in its
/// first month; after it, what it has paid (or its Established ceiling),
/// never less than the starting one.
pub(crate) fn paid_ceiling(ceilings: &Ceilings, start: i64, first_month: bool, paid: i64, established: Option<i64>) -> i64 {
    if first_month {
        return start;
    }
    let from_paid = if paid > 0 { ceilings.for_paid(paid) } else { 0 };
    start.max(from_paid).max(established.unwrap_or(0))
}

/// What the owners may set their spend limit to without asking, and the
/// one-time raise if it is still theirs to use: up to the highest ceiling
/// ever (or the current one, if higher) plus what is prepaid; once, twice
/// the highest ceiling.
pub(crate) fn spend_bounds(ceiling: i64, max_ever: i64, prepaid: i64, raised: bool) -> (i64, Option<i64>) {
    let highest = ceiling.max(max_ever);
    let available = highest + prepaid.max(0);
    let once = (!raised).then(|| (highest * 2 + prepaid.max(0)).max(available));
    (available, once)
}

/// Whether `requested` is a spend limit the owners may set themselves.
/// `Ok(true)` when it takes the one-time raise.
pub(crate) fn self_serve(requested: i64, available: i64, once: Option<i64>, raise_once: bool) -> std::result::Result<bool, String> {
    if requested < 0 {
        return Err("A spend limit cannot be negative.".to_owned());
    }
    if requested <= available {
        return Ok(false);
    }
    match once {
        Some(once) if raise_once && requested <= once => Ok(true),
        Some(once) if raise_once => Err(format!(
            "The one-time raise goes up to {}. For more, ask g1t with Raise my limit; the answer comes within one business day.",
            dollars_plain(once)
        )),
        Some(once) => Err(format!(
            "You can set up to {} yourself, or use your one-time raise to go up to {}. For more, ask g1t with Raise my limit.",
            dollars_plain(available),
            dollars_plain(once)
        )),
        None => Err(format!(
            "You can set up to {} yourself, and the one-time raise is used. For more, ask g1t with Raise my limit; the answer comes within one business day.",
            dollars_plain(available)
        )),
    }
}

/// Which alert a measure has reached: 100, 90, 75, 50, or none (0).
pub(crate) fn alert_level(used: i64, limit: i64) -> u32 {
    if limit <= 0 || used <= 0 {
        return 0;
    }
    for level in [100u32, 90, 75, 50] {
        if used * 100 >= limit * i64::from(level) {
            return level;
        }
    }
    0
}

/// What is owed and what is prepaid, from this month's usage and payments
/// and the balance the month started with (positive: paid in advance;
/// negative: owed from before).
pub(crate) fn exposure(used: i64, paid_month: i64, balance_before: i64) -> (i64, i64) {
    let prepaid_in = balance_before.max(0);
    let carried = (-balance_before).max(0);
    let net = used - paid_month - prepaid_in;
    (net.max(0) + carried, (-net).max(0))
}

#[derive(Deserialize)]
struct LimitRow {
    spend_limit_micros: Option<i64>,
    #[serde(default)]
    spend_limit_full: Option<i64>,
    autopay_failed_at: Option<String>,
    autopay_error: Option<String>,
    #[serde(default)]
    max_ceiling_micros: Option<i64>,
    #[serde(default)]
    granted_ceiling_micros: Option<i64>,
    #[serde(default)]
    raised_at: Option<String>,
}

#[derive(Deserialize)]
struct Month {
    used: Option<i64>,
    paid: Option<i64>,
}

#[derive(Deserialize)]
struct Paid {
    paid: Option<i64>,
}

impl Billing {
    /// The workspace's limit, worked out from the ledger of the account
    /// that pays for it: its own, or its enterprise's, whose workspaces'
    /// usage and payments count together.
    pub(crate) async fn limit_of(&self, workspace: &str) -> Result<Limit> {
        let workspace = workspace.to_lowercase();
        let account = self.account_of(&workspace).await?;
        let row = self
            .db
            .prepare(
                "SELECT spend_limit_micros, spend_limit_full, autopay_failed_at, autopay_error,
                        max_ceiling_micros, granted_ceiling_micros, raised_at
                 FROM limits WHERE workspace = ?",
            )
            .bind(&[workspace.as_str().into()])?
            .first::<LimitRow>(None)
            .await?;
        let now = rfc3339(now_ms());
        let month_start = format!("{}-01", &now[..7]);
        let marks = vec!["?"; account.workspaces.len().max(1)].join(", ");
        let members: Vec<JsValue> = if account.workspaces.is_empty() {
            vec![JsValue::from(workspace.as_str())]
        } else {
            account.workspaces.iter().map(|w| JsValue::from(w.as_str())).collect()
        };
        let mut with_month = members.clone();
        with_month.push(month_start.as_str().into());
        // Each usage entry at its cost to g1t or its charge, whichever is
        // more; on the workspace's own provider, only what g1t charged.
        // What the plan's included usage, the trial, the open-source pool
        // or g1t itself paid for is not unpaid: those are budgets already
        // paid for.
        let month = self
            .db
            .prepare(format!(
                "SELECT
                   SUM(CASE WHEN kind = 'usage' THEN
                         CASE WHEN COALESCE(billed_to, 'g1t') = 'g1t'
                              THEN MAX(COALESCE(cost_micros, 0) - COALESCE(credit_micros, 0)
                                         - COALESCE(trial_micros, 0) - COALESCE(oss_micros, 0)
                                         - COALESCE(given_micros, 0),
                                       -amount_micros)
                              ELSE -amount_micros END
                       END) AS used,
                   SUM(CASE WHEN kind = 'top_up' THEN amount_micros END) AS paid
                 FROM ledger WHERE workspace IN ({marks}) AND created_at >= ?"
            ))
            .bind(&with_month)?
            .first::<Month>(None)
            .await?;
        let (used, paid_month) = month.map_or((0, 0), |m| (m.used.unwrap_or(0), m.paid.unwrap_or(0)));
        // And what is metered but not charged until the month closes.
        let mut pending_args = members.clone();
        pending_args.push(month_start[..7].into());
        let pending = self
            .db
            .prepare(format!(
                "SELECT SUM(charge_micros) AS paid FROM pending_usage WHERE workspace IN ({marks}) AND month = ?"
            ))
            .bind(&pending_args)?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .unwrap_or(0);
        let used = used + pending;
        // Test-mode payments are not money: they pay nothing off.
        let live = self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live);
        // The balance the month started with: owed from before (so a new
        // month is not a fresh allowance for an account that never pays),
        // or paid in advance. Credits g1t gave count; test-mode payments
        // do not.
        let mut before = members.clone();
        before.push(month_start.as_str().into());
        let balance_before = self
            .db
            .prepare(format!(
                "SELECT SUM(CASE WHEN kind = 'usage' THEN amount_micros
                                 WHEN kind = 'top_up' AND ({live} = 1 OR reference LIKE 'crd%') THEN amount_micros
                                 ELSE 0 END) AS paid
                 FROM ledger WHERE workspace IN ({marks}) AND created_at < ?",
                live = u8::from(live)
            ))
            .bind(&before)?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .unwrap_or(0);
        let (exposure, prepaid) = exposure(used, if live { paid_month } else { 0 }, balance_before);

        let plan = self.plan_kind(&workspace).await?;
        let mut first_month = false;
        let (trust, trust_ceiling) = match account.terms.kind {
            TermsKind::Comped => (Trust::Internal, None),
            _ if account.terms.ceiling_micros.is_some() => (Trust::Reviewed, account.terms.ceiling_micros),
            _ => {
                let paid = self.live_paid(&members).await?;
                let established = if paid > 0 { self.established(&members).await? } else { None };
                if plan == PlanKind::Free {
                    // Nothing on demand: only what a free workspace can owe.
                    (Trust::New, Some(self.ceilings.new))
                } else {
                    first_month = plan == PlanKind::Paid && self.first_month(&workspace).await?;
                    let ceiling = paid_ceiling(&self.ceilings, self.plans.paid_start_micros, first_month, paid, established);
                    (if established.is_some() { Trust::Established } else { Trust::Paid }, Some(ceiling))
                }
            }
        };
        // A ceiling g1t granted is a floor under the trust ceiling.
        let granted = row.as_ref().and_then(|row| row.granted_ceiling_micros);
        let ceiling = trust_ceiling.map(|c| c.max(granted.unwrap_or(0)));
        // The highest ceiling ever, kept as it rises.
        let stored_max = row.as_ref().and_then(|row| row.max_ceiling_micros);
        let max_ever = match (stored_max, ceiling) {
            (Some(stored), Some(now)) => Some(stored.max(now)),
            (stored, now) => stored.or(now),
        };
        if let (Some(max), true) = (max_ever, ceiling.is_some() && max_ever != stored_max && plan != PlanKind::Free) {
            self.db
                .prepare(
                    "INSERT INTO limits (workspace, max_ceiling_micros, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT (workspace) DO UPDATE SET max_ceiling_micros = MAX(COALESCE(max_ceiling_micros, 0), ?2), updated_at = ?3",
                )
                .bind(&[workspace.as_str().into(), (max as f64).into(), now.as_str().into()])?
                .run()
                .await?;
        }
        // This month's charges, and last month's, for the spend limit.
        let (spent, last_month) = self.charged_months(&members, &month_start).await?;
        let spent = spent + pending;
        let raised_at = row.as_ref().and_then(|row| row.raised_at.clone());
        let self_serve = matches!(trust, Trust::New | Trust::Paid | Trust::Established) && plan != PlanKind::Free;
        let (available, raise_once) = match (ceiling, self_serve) {
            (Some(ceiling), true) => {
                let (available, once) = spend_bounds(ceiling, max_ever.unwrap_or(ceiling), prepaid, raised_at.is_some());
                (Some(available), once)
            }
            (ceiling, _) => (ceiling, None),
        };
        // The owners' own monthly limit: theirs, none, or the automatic one
        // ($200, or twice last month), which self-serve workspaces start on.
        let chosen = row.as_ref().and_then(|row| row.spend_limit_micros);
        let full = row.as_ref().and_then(|row| row.spend_limit_full).unwrap_or(0) == 1;
        let default_spend_limit = chosen.is_none() && !full && self_serve;
        let spend_limit = match (chosen, full) {
            (Some(own), _) => Some(own),
            (None, true) => None,
            (None, false) if self_serve => Some(automatic_spend_limit(last_month)),
            _ => None,
        };
        // A card declined when g1t charged it at the limit stops work until
        // it is paid; any payment clears it.
        let declined = row.as_ref().and_then(|row| row.autopay_failed_at.clone().map(|at| (at, row.autopay_error.clone())));
        // Two limits: g1t's on what is unpaid, the owners' on what is spent.
        let risk = state(exposure, ceiling);
        let budget = state(spent, spend_limit);
        let over_budget = budget == LimitState::Stopped;
        let state = if declined.is_some() && exposure > 0 {
            LimitState::Stopped
        } else if risk == LimitState::Stopped || over_budget {
            LimitState::Stopped
        } else if risk == LimitState::Warning || budget == LimitState::Warning {
            LimitState::Warning
        } else {
            LimitState::Ok
        };
        let who = if account.kind == g1t_contracts::billing::AccountKind::Enterprise {
            format!("The {} enterprise, which pays for {workspace},", account.name)
        } else {
            format!("The {workspace} workspace")
        };
        let billing = format!("/{workspace}/-/billing");
        let message = match state {
            LimitState::Ok => None,
            LimitState::Warning if budget == LimitState::Warning => Some(format!(
                "{who} has spent {} of its {} monthly spend limit. At the limit, its sandboxes, builds and apps stop until the month turns or an owner raises it at {billing}.",
                dollars_plain(spent),
                dollars_plain(spend_limit.unwrap_or_default()),
            )),
            LimitState::Warning => Some(format!(
                "{who} has {} of usage not yet paid for, of the {} g1t allows. With a card on file g1t charges it now; prepaying at {billing} raises what it can use at once.",
                dollars_plain(exposure),
                dollars_plain(ceiling.unwrap_or_default()),
            )),
            LimitState::Stopped if declined.is_some() => Some(format!(
                "{who} could not be charged for its usage ({}), so its sandboxes, builds and apps are stopped. An owner can pay with another card at {billing}.",
                declined.as_ref().and_then(|(_, error)| error.clone()).unwrap_or_else(|| "the card was declined".to_owned()),
            )),
            LimitState::Stopped => Some(if over_budget {
                format!(
                    "{who} reached its {} monthly spend limit, so its sandboxes, builds and apps are stopped until the month turns. An owner can raise it at {billing}.",
                    dollars_plain(spend_limit.unwrap_or_default()),
                )
            } else {
                format!(
                    "{who} reached its {} limit for usage not yet paid for, so its sandboxes, builds and apps are stopped. An owner can pay or prepay, or ask for a higher limit, at {billing}.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            }),
        };
        let growth = match trust {
            Trust::New => Some("Free workspaces have no on-demand usage: the g1t plan starts at a $100 limit.".to_owned()),
            Trust::Paid if first_month => Some(format!(
                "Your first month's limit is {}. After it, the limit grows to twice what you have paid as payments clear ({SETTLE_DAYS} days), up to $1,000. Prepaying raises it at once, and you can ask for more.",
                dollars_plain(self.plans.paid_start_micros)
            )),
            Trust::Paid => Some(format!(
                "Grows to twice what you have paid, as payments clear ({SETTLE_DAYS} days), up to $1,000. After three steady months it follows your monthly spend, up to $10,000, by itself. Prepaying raises it at once."
            )),
            Trust::Established => Some("Follows your monthly spend, up to $10,000, by itself. Prepaying raises it at once, and you can ask for more.".to_owned()),
            Trust::Reviewed | Trust::Internal => None,
        };
        Ok(Limit {
            workspace,
            account: account.id,
            account_name: account.name,
            spent_micros: spent,
            default_spend_limit,
            available_micros: available,
            growth,
            trust,
            exposure_micros: exposure,
            ceiling_micros: ceiling,
            trust_ceiling_micros: trust_ceiling,
            spend_limit_micros: spend_limit,
            state,
            message,
            prepaid_micros: prepaid,
            max_ceiling_micros: max_ever.filter(|_| plan != PlanKind::Free),
            raise_once_micros: raise_once,
            raised_at,
            first_month,
        })
    }

    /// Whether the workspace's plan is in its first billing cycle.
    pub(crate) async fn first_month(&self, workspace: &str) -> Result<bool> {
        Ok(match self.plan_cycle(workspace).await? {
            Some((started_at, period_end)) => in_first_cycle(&started_at, period_end.as_deref(), &rfc3339(now_ms())),
            None => false,
        })
    }

    /// Real money the workspaces have paid g1t, cleared: usage payments and
    /// the plan's price. Nothing in test mode, and credits g1t gave are not
    /// payments.
    pub(crate) async fn live_paid(&self, members: &[JsValue]) -> Result<i64> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(0);
        }
        let marks = vec!["?"; members.len().max(1)].join(", ");
        let settled = rfc3339(now_ms() - SETTLE_DAYS * 24 * 60 * 60 * 1000);
        Ok(self
            .db
            .prepare(format!(
                "SELECT
                   (SELECT COALESCE(SUM(amount_micros), 0) FROM ledger
                     WHERE workspace IN ({marks}) AND kind = 'top_up' AND reference NOT LIKE 'crd%'
                       AND (amount_micros < 0
                            OR (disputed = 0 AND COALESCE(funding, '') <> 'prepaid'
                                AND created_at <= '{settled}')))
                 + (SELECT COALESCE(SUM(amount_micros), 0) FROM plan_payments
                     WHERE workspace IN ({marks}) AND paid_at <= '{settled}') AS paid"
            ))
            .bind(&[members, members].concat())?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .unwrap_or(0))
    }

    /// This month's charges and last month's, across the workspaces.
    async fn charged_months(&self, members: &[JsValue], month_start: &str) -> Result<(i64, i64)> {
        #[derive(Deserialize)]
        struct Charged {
            this_month: Option<i64>,
            last_month: Option<i64>,
        }
        let last_start = format!("{}-01", previous_month(&month_start[..7]));
        let marks = vec!["?"; members.len().max(1)].join(", ");
        let row = self
            .db
            .prepare(format!(
                "SELECT
                   -SUM(CASE WHEN created_at >= '{month_start}' THEN amount_micros END) AS this_month,
                   -SUM(CASE WHEN created_at >= '{last_start}' AND created_at < '{month_start}' THEN amount_micros END) AS last_month
                 FROM ledger WHERE kind = 'usage' AND workspace IN ({marks}) AND created_at >= '{last_start}'"
            ))
            .bind(members)?
            .first::<Charged>(None)
            .await?;
        Ok(row.map_or((0, 0), |r| (r.this_month.unwrap_or(0).max(0), r.last_month.unwrap_or(0).max(0))))
    }

    /// An Established ceiling, if the workspaces have paid steadily: three
    /// full months of real spend, each invoiced and paid, nothing declined
    /// in 90 days and nothing ever disputed.
    async fn established(&self, members: &[JsValue]) -> Result<Option<i64>> {
        let marks = vec!["?"; members.len().max(1)].join(", ");
        let now = rfc3339(now_ms());
        let mut months = vec![];
        let mut month = previous_month(&now[..7]);
        for _ in 0..3 {
            months.push(month.clone());
            month = previous_month(&month);
        }
        #[derive(Deserialize)]
        struct Count {
            n: Option<i64>,
        }
        let troubled = self
            .db
            .prepare(format!(
                "SELECT (SELECT COUNT(*) FROM ledger WHERE workspace IN ({marks}) AND disputed = 1)
                      + (SELECT COUNT(*) FROM limits WHERE workspace IN ({marks}) AND autopay_failed_at >= '{since}') AS n",
                since = rfc3339(now_ms() - 90 * 24 * 60 * 60 * 1000)
            ))
            .bind(&[members, members].concat())?
            .first::<Count>(None)
            .await?
            .and_then(|c| c.n)
            .unwrap_or(0);
        if troubled > 0 {
            return Ok(None);
        }
        let mut charged = vec![];
        for month in &months {
            #[derive(Deserialize)]
            struct Month {
                charged: Option<i64>,
                unpaid: Option<i64>,
            }
            let next = {
                let year: i32 = month[..4].parse().unwrap_or(1970);
                let number: u32 = month[5..7].parse().unwrap_or(1);
                if number == 12 { format!("{}-01", year + 1) } else { format!("{year}-{:02}", number + 1) }
            };
            let row = self
                .db
                .prepare(format!(
                    "SELECT
                       (SELECT -SUM(amount_micros) FROM ledger WHERE kind = 'usage' AND workspace IN ({marks})
                          AND created_at >= '{month}-01' AND created_at < '{next}-01') AS charged,
                       (SELECT COUNT(*) FROM workspace_invoices WHERE workspace IN ({marks}) AND reason = 'month'
                          AND period = '{month}' AND status <> 'paid') AS unpaid"
                ))
                .bind(&[members, members].concat())?
                .first::<Month>(None)
                .await?;
            let Some(row) = row else { return Ok(None) };
            if row.unpaid.unwrap_or(0) > 0 {
                return Ok(None);
            }
            charged.push(row.charged.unwrap_or(0));
        }
        Ok(established_ceiling(&charged))
    }

    /// A refusal, with the reason, when the workspace's work is stopped.
    /// None while billing is off: a g1t without payments has no limits.
    pub(crate) async fn stopped<T>(&self, workspace: &str) -> Result<Option<Outcome<T>>> {
        if self.stripe.is_none() {
            return Ok(None);
        }
        let limit = self.limit_of(workspace).await?;
        Ok((limit.state == LimitState::Stopped).then(|| {
            Outcome::fail(
                FailureCode::PaymentRequired,
                limit.message.unwrap_or_else(|| "This workspace is over its limit.".to_owned()),
            )
        }))
    }

    pub(crate) async fn limit(&self, a: LimitArgs) -> Result<Outcome<Limit>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        Ok(Outcome::Ok(self.limit_of(&workspace).await?))
    }

    /// What a source cost so far this month. `security`, `context`,
    /// `storage` and `git` are charged by billing once the month is over
    /// (see `storage`); `deployments` charges its own.
    pub(crate) async fn note_pending(&self, a: NotePendingArgs) -> Result<bool> {
        // The actions cache is the plan's to pay for; free workspaces are
        // held to its quota instead.
        if crate::storage::PLAN_ONLY.contains(&a.source.as_str()) && !self.has_plan(&a.workspace.to_lowercase()).await? {
            return Ok(false);
        }
        let now = rfc3339(now_ms());
        let detail = a.detail.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(|d| d.chars().take(200).collect::<String>());
        self.set_pending(&a.workspace, &a.source, &now[..7], a.cost_micros, detail.as_deref()).await?;
        Ok(true)
    }

    /// Charges the saved card of each workspace nearing its limit, for what
    /// it owes, so that a workspace that pays never has its work stopped.
    /// Only with live payments: test-mode payments are not money and lower
    /// nothing. Not for a workspace's own spend limit, which means stop, nor
    /// for enterprises, which are invoiced. A charge at the limit always
    /// goes through, whatever the minimum charge.
    pub(crate) async fn autopay(&self) -> Result<()> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct Candidate {
            workspace: String,
        }
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        // With a card, and not already declined: a declined card waits for
        // the owners, rather than being tried again every few minutes.
        let candidates = self
            .db
            .prepare(
                "SELECT DISTINCT ledger.workspace AS workspace
                 FROM ledger JOIN accounts ON accounts.workspace = ledger.workspace
                 LEFT JOIN limits ON limits.workspace = ledger.workspace
                 WHERE ledger.kind = 'usage' AND ledger.created_at >= ? AND accounts.customer_id IS NOT NULL
                   AND limits.autopay_failed_at IS NULL",
            )
            .bind(&[month_start.as_str().into()])?
            .all()
            .await?
            .results::<Candidate>()?;
        for candidate in candidates {
            let limit = self.limit_of(&candidate.workspace).await?;
            // Near g1t's ceiling on what is unpaid; the spend limit is the
            // owners' and stops work by itself, but what is owed is still owed.
            let near = limit.ceiling_micros.is_some_and(|ceiling| limit.exposure_micros * 5 >= ceiling * 4);
            if !near || limit.trust == Trust::Internal || limit.account.starts_with("ent_") {
                continue;
            }
            let today = rfc3339(now_ms())[..10].to_owned();
            match self.invoice_workspace(&candidate.workspace, "threshold", &today).await? {
                Ok(_) => {}
                Err(why) => worker::console_log!("{}: no threshold invoice: {why}", candidate.workspace),
            }
        }
        Ok(())
    }

    /// Closes last month for each workspace with a card on file: charges
    /// what it owed when the month ended. Live payments only, once per
    /// workspace and month; a declined card stops work until it is paid.
    /// Comped workspaces owe nothing, and enterprises are invoiced. Only
    /// here does the minimum charge apply: less carries over.
    pub(crate) async fn close_months(&self) -> Result<()> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(());
        }
        let now = rfc3339(now_ms());
        let month_start = format!("{}-01", &now[..7]);
        let closing = previous_month(&now[..7]);
        #[derive(Deserialize)]
        struct Open {
            workspace: String,
            balance: Option<i64>,
        }
        let open = self
            .db
            .prepare(
                "SELECT accounts.workspace AS workspace,
                        (SELECT SUM(amount_micros) FROM ledger
                          WHERE ledger.workspace = accounts.workspace AND ledger.created_at < ?1) AS balance
                 FROM accounts
                 WHERE accounts.customer_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM month_closes
                                    WHERE month_closes.workspace = accounts.workspace AND month_closes.month = ?2)
                 LIMIT 20",
            )
            .bind(&[month_start.as_str().into(), closing.as_str().into()])?
            .all()
            .await?
            .results::<Open>()?;
        for account in open {
            let record = |status: &str, amount: i64, payment: Option<&str>, error: Option<&str>| {
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO month_closes (workspace, month, status, amount_micros, payment_id, error, closed_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        account.workspace.as_str().into(),
                        closing.as_str().into(),
                        status.into(),
                        (amount as f64).into(),
                        crate::optional(payment),
                        crate::optional(error),
                        now.as_str().into(),
                    ])
            };
            let payer = self.account_of(&account.workspace).await?;
            if payer.terms.kind == TermsKind::Comped || payer.id.starts_with("ent_") {
                record("skipped", 0, None, None)?.run().await?;
                continue;
            }
            let owed = (-account.balance.unwrap_or(0)).max(0);
            if owed == 0 {
                record("nothing", 0, None, None)?.run().await?;
                continue;
            }
            if !worth_charging(owed, self.plans.min_charge_micros) {
                // Under the minimum charge: a card payment's fee would be
                // too much of it. It stays owed and goes on the next
                // invoice that reaches the minimum.
                record("carried", owed, None, None)?.run().await?;
                continue;
            }
            match self.invoice_workspace(&account.workspace, "month", &closing).await? {
                Ok(invoice) if invoice.status == "paid" => {
                    record("paid", invoice.amount_micros, Some(&invoice.invoice_id), None)?.run().await?;
                }
                Ok(invoice) => {
                    record("failed", invoice.amount_micros, Some(&invoice.invoice_id), Some("the card was declined"))?.run().await?;
                }
                Err(why) => {
                    record("nothing", 0, None, Some(&why))?.run().await?;
                }
            }
        }
        Ok(())
    }

    /// Emails a workspace's owners as it passes 50, 75, 90 and 100% of its
    /// plan's included usage, its spend limit and g1t's ceiling, once each a
    /// month; when its card was declined; and when a spend spike paused it.
    /// The same alerts show in the app (`entitlements`).
    pub(crate) async fn warn_limits(&self, identity: &worker::Fetcher) -> Result<()> {
        if self.stripe.is_none() {
            return Ok(());
        }
        let now = rfc3339(now_ms());
        let month = &now[..7];
        #[derive(Deserialize)]
        struct Candidate {
            workspace: String,
        }
        let candidates = self
            .db
            .prepare(
                "SELECT DISTINCT workspace FROM ledger WHERE kind = 'usage' AND created_at >= ?1
                 UNION SELECT workspace FROM limits WHERE autopay_failed_at IS NOT NULL",
            )
            .bind(&[format!("{month}-01").into()])?
            .all()
            .await?
            .results::<Candidate>()?;
        #[derive(Deserialize)]
        struct Told {
            autopay_failed_at: Option<String>,
            declined_told_at: Option<String>,
        }
        #[derive(Deserialize)]
        struct Sent {
            meter: String,
            level: Option<i64>,
        }
        for Candidate { workspace } in candidates {
            let told = self
                .db
                .prepare("SELECT autopay_failed_at, declined_told_at FROM limits WHERE workspace = ?")
                .bind(&[workspace.as_str().into()])?
                .first::<Told>(None)
                .await?;
            let billing = format!("https://g1t.sh/{workspace}/-/billing");

            // A declined card, once per decline.
            if let Some(Told { autopay_failed_at: Some(failed), declined_told_at }) = &told {
                if declined_told_at.as_deref().is_none_or(|at| at < failed.as_str()) {
                    let limit = self.limit_of(&workspace).await?;
                    let sent = notify(
                        identity,
                        &workspace,
                        &format!("g1t: the card for {workspace} was declined"),
                        &limit.message.clone().unwrap_or_else(|| format!("g1t could not charge the card on file for {workspace}.")),
                        "Update the card",
                        &billing,
                    )
                    .await;
                    if sent {
                        self.db
                            .prepare("UPDATE limits SET declined_told_at = ? WHERE workspace = ?")
                            .bind(&[now.as_str().into(), workspace.as_str().into()])?
                            .run()
                            .await?;
                    }
                }
            }

            // 50, 75, 90 and 100%, once each a month and meter: only the
            // highest new level is emailed.
            let alerts = self.alerts_for(&workspace).await?;
            if alerts.is_empty() {
                continue;
            }
            let sent: Vec<Sent> = self
                .db
                .prepare("SELECT meter, MAX(level) AS level FROM alerts_sent WHERE workspace = ? AND month = ? GROUP BY meter")
                .bind(&[workspace.as_str().into(), month.into()])?
                .all()
                .await?
                .results::<Sent>()?;
            for alert in alerts {
                let already = sent.iter().find(|s| s.meter == alert.meter).and_then(|s| s.level).unwrap_or(0);
                if i64::from(alert.level) <= already {
                    continue;
                }
                let subject = match alert.meter.as_str() {
                    "included" => format!("g1t: {workspace} has used {}% of its included usage", alert.level),
                    "spend_limit" => format!("g1t: {workspace} has used {}% of its spend limit", alert.level),
                    _ => format!("g1t: {workspace} has used {}% of its usage limit", alert.level),
                };
                if notify(identity, &workspace, &subject, &alert.message, "Open billing", &billing).await {
                    self.db
                        .prepare(
                            "INSERT OR IGNORE INTO alerts_sent (workspace, month, meter, level, sent_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        )
                        .bind(&[workspace.as_str().into(), month.into(), alert.meter.as_str().into(), alert.level.into(), now.as_str().into()])?
                        .run()
                        .await?;
                }
            }
        }
        self.tell_spikes(identity).await?;
        Ok(())
    }

    pub(crate) async fn check_limit(&self, a: CheckLimitArgs) -> Result<Outcome<Limit>> {
        Ok(Outcome::Ok(self.limit_of(&a.workspace).await?))
    }

    /// The owners' spend limit: anywhere up to what is available without
    /// asking; once, up to twice the highest ceiling (`raise_once`), which
    /// also raises g1t's ceiling to match.
    pub(crate) async fn set_spend_limit(&self, a: SetSpendLimitArgs) -> Result<Outcome<Limit>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can set the workspace's spend limit.",
            ));
        }
        let before = self.limit_of(&workspace).await?;
        let mut raising = false;
        if let (Some(requested), false) = (a.spend_limit_micros, a.use_full_limit) {
            match (before.available_micros, matches!(before.trust, Trust::Internal | Trust::Reviewed)) {
                (_, true) | (None, _) => {
                    if requested < 0 {
                        return Ok(Outcome::fail(FailureCode::Invalid, "A spend limit cannot be negative."));
                    }
                }
                (Some(available), false) => match self_serve(requested, available, before.raise_once_micros, a.raise_once) {
                    Ok(uses_raise) => raising = uses_raise,
                    Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, why)),
                },
            }
        }
        let now = rfc3339(now_ms());
        let limit = if a.use_full_limit { JsValue::NULL } else { a.spend_limit_micros.map_or(JsValue::NULL, |limit| (limit as f64).into()) };
        self.db
            .prepare(
                "INSERT INTO limits (workspace, spend_limit_micros, spend_limit_full, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (workspace) DO UPDATE SET spend_limit_micros = ?2, spend_limit_full = ?3, updated_at = ?4",
            )
            .bind(&[workspace.as_str().into(), limit, (if a.use_full_limit { 1 } else { 0 }).into(), now.as_str().into()])?
            .run()
            .await?;
        if raising {
            let raised = a.spend_limit_micros.unwrap_or_default();
            // The ceiling rises with it, once.
            self.db
                .prepare(
                    "UPDATE limits SET granted_ceiling_micros = MAX(COALESCE(granted_ceiling_micros, 0), ?2),
                       raised_at = ?3, updated_at = ?3 WHERE workspace = ?1 AND raised_at IS NULL",
                )
                .bind(&[workspace.as_str().into(), (raised as f64).into(), now.as_str().into()])?
                .run()
                .await?;
            let account = self.account_of(&workspace).await?;
            self.audit(&account.id, "raise_once", &format!("{workspace} used its one-time raise: {}", dollars_plain(raised)), &a.actor.username)
                .await?;
        }
        Ok(Outcome::Ok(self.limit_of(&workspace).await?))
    }
}

/// Whether `owed` is enough to charge a card when a month closes: at least
/// the minimum charge (`MIN_CHARGE_MICROS`). Less carries over to the next
/// invoice. Charges at a limit do not ask.
pub(crate) fn worth_charging(owed: i64, min_charge: i64) -> bool {
    owed > 0 && owed >= min_charge
}

/// Emails the workspace's owners through identity. False if nothing was sent.
pub(crate) async fn notify(identity: &worker::Fetcher, workspace: &str, subject: &str, intro: &str, action: &str, link: &str) -> bool {
    let args = g1t_contracts::identity::NotifyOwnersArgs {
        workspace: workspace.to_owned(),
        subject: subject.to_owned(),
        intro: intro.to_owned(),
        action: action.to_owned(),
        link: link.to_owned(),
        footer: "You get this because you own this workspace on g1t. Limits and alerts are explained at https://docs.g1t.sh/guides/usage-and-billing/#limits".to_owned(),
    };
    match g1t_kit::call::<_, u32>(identity, "notify_owners", &args).await {
        Ok(sent) => sent > 0,
        Err(error) => {
            worker::console_error!("could not tell {workspace}'s owners: {error}");
            false
        }
    }
}

/// `2026-09` for `2026-10`, and `2025-12` for `2026-01`.
pub(crate) fn previous_month(month: &str) -> String {
    let year: i32 = month[..4].parse().unwrap_or(1970);
    let number: u32 = month[5..7].parse().unwrap_or(1);
    if number == 1 {
        format!("{}-12", year - 1)
    } else {
        format!("{year}-{:02}", number - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_automatic_spend_limit_follows_last_month() {
        assert_eq!(automatic_spend_limit(0), 200_000_000);
        assert_eq!(automatic_spend_limit(50_000_000), 200_000_000);
        assert_eq!(automatic_spend_limit(900_000_000), 1_800_000_000);
    }

    #[test]
    fn three_steady_months_make_a_workspace_established() {
        assert_eq!(established_ceiling(&[900_000_000, 850_000_000, 950_000_000]), Some(2_700_000_000));
        assert_eq!(established_ceiling(&[5_000_000_000, 5_000_000_000, 5_000_000_000]), Some(10_000_000_000));
        assert_eq!(established_ceiling(&[900_000_000, 10_000_000, 950_000_000]), None);
        assert_eq!(established_ceiling(&[900_000_000, 900_000_000]), None);
    }

    #[test]
    fn alerts_come_at_half_three_quarters_ninety_and_the_limit() {
        assert_eq!(alert_level(0, 10_000_000), 0);
        assert_eq!(alert_level(4_999_999, 10_000_000), 0);
        assert_eq!(alert_level(5_000_000, 10_000_000), 50);
        assert_eq!(alert_level(7_500_000, 10_000_000), 75);
        assert_eq!(alert_level(8_999_999, 10_000_000), 75);
        assert_eq!(alert_level(9_000_000, 10_000_000), 90);
        assert_eq!(alert_level(10_000_000, 10_000_000), 100);
        assert_eq!(alert_level(25_000_000, 10_000_000), 100);
        // Nothing to measure against: no alert.
        assert_eq!(alert_level(5, 0), 0);
    }

    #[test]
    fn amounts_under_the_minimum_carry_over_only_at_the_month_close() {
        let min = 5_000_000;
        assert!(!worth_charging(0, min));
        assert!(!worth_charging(4_990_000, min));
        assert!(worth_charging(5_000_000, min));
        assert!(worth_charging(12_000_000, min));
        // $3 carried from last month and $2.50 this month: charged together.
        let carried = 3_000_000;
        assert!(!worth_charging(carried, min));
        assert!(worth_charging(carried + 2_500_000, min));
    }

    #[test]
    fn the_month_before_wraps_the_year() {
        assert_eq!(previous_month("2026-10"), "2026-09");
        assert_eq!(previous_month("2026-01"), "2025-12");
    }

    fn ceilings() -> Ceilings {
        Ceilings { new: 3_000_000, paid_min: 25_000_000, paid_max: 1_000_000_000 }
    }

    #[test]
    fn trust_grows_with_what_was_paid_within_bounds() {
        assert_eq!(ceilings().for_paid(5_000_000), 25_000_000);
        assert_eq!(ceilings().for_paid(100_000_000), 200_000_000);
        assert_eq!(ceilings().for_paid(10_000_000_000), 1_000_000_000);
    }

    #[test]
    fn a_new_paid_workspace_starts_at_a_hundred_dollars_and_only_goes_up() {
        let start = 100_000_000;
        // The first month: the starting ceiling, whatever was paid.
        assert_eq!(paid_ceiling(&ceilings(), start, true, 900_000_000, None), start);
        // After it, with little paid: never below the start.
        assert_eq!(paid_ceiling(&ceilings(), start, false, 20_000_000, None), start);
        assert_eq!(paid_ceiling(&ceilings(), start, false, 0, None), start);
        // Payments that cleared raise it: twice what was paid.
        assert_eq!(paid_ceiling(&ceilings(), start, false, 300_000_000, None), 600_000_000);
        // Established follows the monthly spend.
        assert_eq!(paid_ceiling(&ceilings(), start, false, 300_000_000, Some(2_700_000_000)), 2_700_000_000);
    }

    #[test]
    fn the_first_billing_cycle_is_the_first_month() {
        // A plan that started on the 5th, paid through the 5th of next month.
        assert!(in_first_cycle("2026-10-05T10:00:00Z", Some("2026-11-05T10:00:00Z"), "2026-10-20T00:00:00Z"));
        // Renewed: the period now ends two months after the start.
        assert!(!in_first_cycle("2026-10-05T10:00:00Z", Some("2026-12-05T10:00:00Z"), "2026-11-20T00:00:00Z"));
        // No period known yet: the first 31 days.
        assert!(in_first_cycle("2026-10-05T10:00:00Z", None, "2026-11-04T00:00:00Z"));
        assert!(!in_first_cycle("2026-10-05T10:00:00Z", None, "2026-11-10T00:00:00Z"));
        // Day counting is exact across months and years.
        assert_eq!(days("1970-01-01"), 0);
        assert_eq!(days("2026-11-01") - days("2026-10-01"), 31);
        assert_eq!(days("2028-03-01") - days("2028-02-28"), 2);
        assert_eq!(days("2027-01-01") - days("2026-12-31"), 1);
    }

    #[test]
    fn owners_set_their_limit_up_to_the_highest_ceiling_without_asking() {
        // First month at $100; the highest ever is $100.
        let (available, once) = spend_bounds(100_000_000, 100_000_000, 0, false);
        assert_eq!(available, 100_000_000);
        assert_eq!(once, Some(200_000_000));
        assert_eq!(self_serve(80_000_000, available, once, false), Ok(false));
        assert_eq!(self_serve(100_000_000, available, once, false), Ok(false));
        // Above it without the raise: refused, saying what to do.
        assert!(self_serve(150_000_000, available, once, false).unwrap_err().contains("one-time raise"));
        // With the raise: up to twice the highest ceiling, once.
        assert_eq!(self_serve(200_000_000, available, once, true), Ok(true));
        assert!(self_serve(200_000_001, available, once, true).unwrap_err().contains("Raise my limit"));
        // Once used, it is gone.
        let (available, once) = spend_bounds(200_000_000, 200_000_000, 0, true);
        assert_eq!(once, None);
        assert_eq!(self_serve(200_000_000, available, once, false), Ok(false));
        assert!(self_serve(300_000_000, available, once, true).unwrap_err().contains("is used"));
        // A ceiling that came down still leaves the highest one available.
        let (available, _) = spend_bounds(100_000_000, 400_000_000, 0, true);
        assert_eq!(available, 400_000_000);
        assert!(self_serve(-1, available, None, false).is_err());
    }

    #[test]
    fn prepaying_raises_what_can_be_used_at_once() {
        // $500 prepaid this month, $120 used: nothing owed, $380 left.
        assert_eq!(exposure(120_000_000, 500_000_000, 0), (0, 380_000_000));
        // Prepaid last month and carried in.
        assert_eq!(exposure(120_000_000, 0, 500_000_000), (0, 380_000_000));
        // Used past the prepayment: the rest is owed.
        assert_eq!(exposure(620_000_000, 500_000_000, 0), (120_000_000, 0));
        // Owed from before adds to this month's.
        assert_eq!(exposure(10_000_000, 0, -4_000_000), (14_000_000, 0));
        // With a $100 ceiling and $500 prepaid, work stops at $600 of use,
        // not at $100.
        let ceiling = 100_000_000;
        assert_eq!(state(exposure(599_000_000, 500_000_000, 0).0, Some(ceiling)), LimitState::Warning);
        assert_eq!(state(exposure(600_000_000, 500_000_000, 0).0, Some(ceiling)), LimitState::Stopped);
        // And the owners may set their spend limit that much higher.
        assert_eq!(spend_bounds(ceiling, ceiling, 500_000_000, true).0, 600_000_000);
    }

    #[test]
    fn work_warns_at_eighty_percent_and_stops_at_the_ceiling() {
        assert_eq!(state(0, Some(100)), LimitState::Ok);
        assert_eq!(state(79, Some(100)), LimitState::Ok);
        assert_eq!(state(80, Some(100)), LimitState::Warning);
        assert_eq!(state(100, Some(100)), LimitState::Stopped);
        assert_eq!(state(1_000_000, None), LimitState::Ok);
    }
}
