//! How far a workspace can run up costs g1t has not been paid for.
//!
//! Every sandbox second, build, app request and model token costs g1t
//! money at Cloudflare or a model provider before the workspace pays for
//! it. So, like Fly or Cloudflare with new accounts, each workspace has a
//! ceiling on that unpaid usage, set by how much it has paid g1t before:
//!
//! - **New**: no live payment yet. A few dollars, enough for the free
//!   allowances and a little more.
//! - **Paid**: twice what it has paid g1t, within bounds.
//! - **Reviewed**: a ceiling g1t set by hand.
//! - **Internal**: g1t's own workspaces, with none.
//!
//! An owner can set a lower spend limit of their own. Past 80% the
//! workspace is warned; at the ceiling its work stops: no new sandboxes,
//! builds or app requests, until it pays or the month turns. Runs already
//! under way finish.
//!
//! Usage counts at what it cost g1t or what it is charged, whichever is
//! more, so it counts while g1t is free too: free is a price, not an
//! exemption from the ceiling. Test-mode payments are not money, so they
//! do not raise trust.

use g1t_contracts::billing::{CheckLimitArgs, Limit, LimitArgs, NotePendingArgs, TermsKind, LimitState, SetSpendLimitArgs, Trust};
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
    /// `LIMIT_NEW_MICROS`.
    pub new: i64,
    /// `LIMIT_PAID_MIN_MICROS` and `LIMIT_PAID_MAX_MICROS`.
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
const SETTLE_DAYS: u64 = 7;

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

#[derive(Deserialize)]
struct LimitRow {
    spend_limit_micros: Option<i64>,
    #[serde(default)]
    spend_limit_full: Option<i64>,
    autopay_failed_at: Option<String>,
    autopay_error: Option<String>,
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
            .prepare("SELECT spend_limit_micros, spend_limit_full, autopay_failed_at, autopay_error FROM limits WHERE workspace = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<LimitRow>(None)
            .await?;
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let marks = vec!["?"; account.workspaces.len().max(1)].join(", ");
        let members: Vec<JsValue> = if account.workspaces.is_empty() {
            vec![JsValue::from(workspace.as_str())]
        } else {
            account.workspaces.iter().map(|w| JsValue::from(w.as_str())).collect()
        };
        let mut with_month = members.clone();
        with_month.push(month_start.as_str().into());
        // Each usage entry at its cost to g1t or its charge, whichever is
        // more; on the workspace's own provider, only g1t's fee is g1t's.
        let month = self
            .db
            .prepare(format!(
                "SELECT
                   SUM(CASE WHEN kind = 'usage' THEN
                         CASE WHEN COALESCE(billed_to, 'g1t') = 'g1t'
                              THEN MAX(COALESCE(cost_micros, 0), -amount_micros)
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
        // Charges from earlier months still unpaid carry over, so a new
        // month is not a fresh allowance for an account that never pays.
        // Credits g1t gave count as paid; test-mode payments do not.
        let mut before = members.clone();
        before.push(month_start.as_str().into());
        let carried = self
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
            .map_or(0, |balance| (-balance).max(0));
        let exposure = (used - if live { paid_month } else { 0 }).max(0) + carried;

        let (trust, trust_ceiling) = match account.terms.kind {
            TermsKind::Comped => (Trust::Internal, None),
            _ if account.terms.ceiling_micros.is_some() => (Trust::Reviewed, account.terms.ceiling_micros),
            _ => {
                let paid = self.live_paid(&members).await?;
                let established = if paid > 0 { self.established(&members).await? } else { None };
                match established {
                    Some(ceiling) => (Trust::Established, Some(ceiling.max(self.ceilings.for_paid(paid)))),
                    None if paid > 0 => (Trust::Paid, Some(self.ceilings.for_paid(paid))),
                    None => (Trust::New, Some(self.ceilings.new)),
                }
            }
        };
        // This month's charges, and last month's, for the spend limit.
        let (spent, last_month) = self.charged_months(&members, &month_start).await?;
        let spent = spent + pending;
        // The owners' own monthly limit: theirs, none, or the automatic one
        // ($200, or twice last month), which self-serve workspaces start on.
        let chosen = row.as_ref().and_then(|row| row.spend_limit_micros);
        let full = row.as_ref().and_then(|row| row.spend_limit_full).unwrap_or(0) == 1;
        let self_serve = matches!(trust, Trust::New | Trust::Paid | Trust::Established);
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
        let ceiling = trust_ceiling;
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
        let message = match state {
            LimitState::Ok => None,
            LimitState::Warning if budget == LimitState::Warning => Some(format!(
                "{who} has spent {} of its {} monthly spend limit. At the limit, its sandboxes, builds and apps stop until the month turns or an owner raises it under Billing.",
                dollars_plain(spent),
                dollars_plain(spend_limit.unwrap_or_default()),
            )),
            LimitState::Warning => Some(format!(
                "{who} has {} of usage not yet paid for, of the {} g1t allows. With a card on file g1t charges it now; without one, at the limit its sandboxes, builds and apps stop until it pays.",
                dollars_plain(exposure),
                dollars_plain(ceiling.unwrap_or_default()),
            )),
            LimitState::Stopped if declined.is_some() => Some(format!(
                "{who} could not be charged for its usage ({}), so its sandboxes, builds and apps are stopped. An owner can pay under Billing with another card.",
                declined.as_ref().and_then(|(_, error)| error.clone()).unwrap_or_else(|| "the card was declined".to_owned()),
            )),
            LimitState::Stopped => Some(if over_budget {
                format!(
                    "{who} reached its {} monthly spend limit, so its sandboxes, builds and apps are stopped until the month turns. An owner can raise it under Billing.",
                    dollars_plain(spend_limit.unwrap_or_default()),
                )
            } else {
                format!(
                    "{who} reached its {} limit for usage not yet paid for, so its sandboxes, builds and apps are stopped. The limit grows as a workspace pays g1t; an owner can pay under Billing, or write to support to have it raised.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            }),
        };
        let growth = match trust {
            Trust::New => Some("Pay g1t once, by card or credit, and this grows to $25; after that it grows with every payment.".to_owned()),
            Trust::Paid => Some(format!(
                "Grows to twice what you have paid, as payments clear (after {SETTLE_DAYS} days), up to $1,000. After three steady months it follows your monthly spend, up to $10,000, by itself."
            )),
            Trust::Established => Some("Follows your monthly spend, up to $10,000, by itself. For more, contact us.".to_owned()),
            Trust::Reviewed | Trust::Internal => None,
        };
        Ok(Limit {
            workspace,
            account: account.id,
            account_name: account.name,
            spent_micros: spent,
            default_spend_limit,
            available_micros: trust_ceiling,
            growth,
            trust,
            exposure_micros: exposure,
            ceiling_micros: ceiling,
            trust_ceiling_micros: trust_ceiling,
            spend_limit_micros: spend_limit,
            state,
            message,
        })
    }

    /// Real money the workspaces have paid g1t. Nothing in test mode, and
    /// credits g1t gave are not payments.
    async fn live_paid(&self, members: &[JsValue]) -> Result<i64> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(0);
        }
        let marks = vec!["?"; members.len().max(1)].join(", ");
        Ok(self
            .db
            .prepare(format!(
                "SELECT SUM(amount_micros) AS paid FROM ledger
                 WHERE workspace IN ({marks}) AND kind = 'top_up' AND reference NOT LIKE 'crd%'
                   AND (amount_micros < 0
                        OR (disputed = 0 AND COALESCE(funding, '') <> 'prepaid'
                            AND created_at <= '{settled}'))",
                settled = rfc3339(now_ms() - SETTLE_DAYS * 24 * 60 * 60 * 1000)
            ))
            .bind(members)?
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

    pub(crate) async fn note_pending(&self, a: NotePendingArgs) -> Result<bool> {
        let now = rfc3339(now_ms());
        let charge = crate::charge_micros(a.cost_micros.max(0) as f64 / g1t_contracts::billing::MICROS_PER_DOLLAR as f64, self.margin_percent);
        self.db
            .prepare(
                "INSERT INTO pending_usage (workspace, source, month, charge_micros, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (workspace, source, month) DO UPDATE SET charge_micros = ?4, updated_at = ?5",
            )
            .bind(&[
                a.workspace.to_lowercase().into(),
                a.source.as_str().into(),
                now[..7].into(),
                (charge as f64).into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(true)
    }

    /// Charges the saved card of each workspace nearing its limit, for what
    /// it owes, so that a workspace that pays never has its work stopped.
    /// Only with live payments: test-mode payments are not money and lower
    /// nothing. Not for a workspace's own spend limit, which means stop, nor
    /// for enterprises, which are invoiced.
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
            // An invoice for what it owes, charged to its card now: never
            // the cost of what was free to it.
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
    /// Comped workspaces owe nothing, and enterprises are invoiced.
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
            if owed < 10_000 {
                // Under a cent: nothing worth charging.
                record("nothing", 0, None, None)?.run().await?;
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

    /// Emails a workspace's owners as it passes 50%, 80% and 100% of its
    /// limit, once each a month, and when its card was declined, so that
    /// work never stops without warning.
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
            warned_month: Option<String>,
            warned_level: Option<i64>,
            autopay_failed_at: Option<String>,
            declined_told_at: Option<String>,
        }
        for Candidate { workspace } in candidates {
            let limit = self.limit_of(&workspace).await?;
            let told = self
                .db
                .prepare("SELECT warned_month, warned_level, autopay_failed_at, declined_told_at FROM limits WHERE workspace = ?")
                .bind(&[workspace.as_str().into()])?
                .first::<Told>(None)
                .await?;
            let billing = format!("https://g1t.sh/{workspace}/-/billing");

            // A declined card, once per decline.
            if let Some(Told { autopay_failed_at: Some(failed), declined_told_at, .. }) = &told {
                if declined_told_at.as_deref().is_none_or(|at| at < failed.as_str()) {
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

            let Some(ceiling) = limit.ceiling_micros.filter(|c| *c > 0) else { continue };
            let level = warning_level(limit.exposure_micros, ceiling);
            let already = told
                .as_ref()
                .filter(|t| t.warned_month.as_deref() == Some(month))
                .and_then(|t| t.warned_level)
                .unwrap_or(0);
            if level <= already {
                continue;
            }
            let (subject, intro) = match level {
                100 => (
                    format!("g1t: {workspace} reached its usage limit"),
                    limit.message.clone().unwrap_or_else(|| format!("{workspace} reached its usage limit.")),
                ),
                _ => (
                    format!("g1t: {workspace} has used {level}% of its usage limit"),
                    format!(
                        "{workspace} has used {} of its {} usage limit this month. At the limit its sandboxes, builds and apps stop until it pays or the month turns. With a card on file, g1t charges it as the limit nears, so work keeps going.",
                        dollars_plain(limit.exposure_micros),
                        dollars_plain(ceiling),
                    ),
                ),
            };
            if notify(identity, &workspace, &subject, &intro, "Open billing", &billing).await {
                self.db
                    .prepare(
                        "INSERT INTO limits (workspace, warned_month, warned_level, updated_at) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (workspace) DO UPDATE SET warned_month = ?2, warned_level = ?3, updated_at = ?4",
                    )
                    .bind(&[workspace.as_str().into(), month.into(), (level as f64).into(), now.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn check_limit(&self, a: CheckLimitArgs) -> Result<Outcome<Limit>> {
        Ok(Outcome::Ok(self.limit_of(&a.workspace).await?))
    }

    pub(crate) async fn set_spend_limit(&self, a: SetSpendLimitArgs) -> Result<Outcome<Limit>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can set the workspace's spend limit.",
            ));
        }
        if a.spend_limit_micros.is_some_and(|limit| limit < 0) {
            return Ok(Outcome::fail(FailureCode::Invalid, "A spend limit cannot be negative."));
        }
        let limit = if a.use_full_limit { JsValue::NULL } else { a.spend_limit_micros.map_or(JsValue::NULL, |limit| (limit as f64).into()) };
        self.db
            .prepare(
                "INSERT INTO limits (workspace, spend_limit_micros, spend_limit_full, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (workspace) DO UPDATE SET spend_limit_micros = ?2, spend_limit_full = ?3, updated_at = ?4",
            )
            .bind(&[workspace.as_str().into(), limit, (if a.use_full_limit { 1 } else { 0 }).into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.limit_of(&workspace).await?))
    }
}

/// Which warning a workspace has reached: 100, 80, 50 or none (0).
pub(crate) fn warning_level(exposure: i64, ceiling: i64) -> i64 {
    if exposure >= ceiling {
        100
    } else if exposure * 5 >= ceiling * 4 {
        80
    } else if exposure * 2 >= ceiling {
        50
    } else {
        0
    }
}

/// Emails the workspace's owners through identity. False if nothing was sent.
async fn notify(identity: &worker::Fetcher, workspace: &str, subject: &str, intro: &str, action: &str, link: &str) -> bool {
    let args = g1t_contracts::identity::NotifyOwnersArgs {
        workspace: workspace.to_owned(),
        subject: subject.to_owned(),
        intro: intro.to_owned(),
        action: action.to_owned(),
        link: link.to_owned(),
        footer: "You get this because you own this workspace on g1t. Usage limits are explained at https://docs.g1t.sh/guides/usage-and-billing/#usage-limits".to_owned(),
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
    fn warnings_come_at_half_four_fifths_and_the_limit() {
        assert_eq!(warning_level(0, 300), 0);
        assert_eq!(warning_level(149, 300), 0);
        assert_eq!(warning_level(150, 300), 50);
        assert_eq!(warning_level(240, 300), 80);
        assert_eq!(warning_level(300, 300), 100);
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
    fn work_warns_at_eighty_percent_and_stops_at_the_ceiling() {
        assert_eq!(state(0, Some(100)), LimitState::Ok);
        assert_eq!(state(79, Some(100)), LimitState::Ok);
        assert_eq!(state(80, Some(100)), LimitState::Warning);
        assert_eq!(state(100, Some(100)), LimitState::Stopped);
        assert_eq!(state(1_000_000, None), LimitState::Ok);
    }
}
