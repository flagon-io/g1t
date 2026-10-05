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

/// Never charged automatically for less.
const AUTOPAY_MIN_CENTS: i64 = 500;

#[derive(Deserialize)]
struct LimitRow {
    spend_limit_micros: Option<i64>,
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
            .prepare("SELECT spend_limit_micros, autopay_failed_at, autopay_error FROM limits WHERE workspace = ?")
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
        let exposure = (used - if live { paid_month } else { 0 }).max(0);

        let (trust, trust_ceiling) = match account.terms.kind {
            TermsKind::Comped => (Trust::Internal, None),
            _ if account.terms.ceiling_micros.is_some() => (Trust::Reviewed, account.terms.ceiling_micros),
            _ => {
                let paid = self.live_paid(&members).await?;
                if paid > 0 {
                    (Trust::Paid, Some(self.ceilings.for_paid(paid)))
                } else {
                    (Trust::New, Some(self.ceilings.new))
                }
            }
        };
        let spend_limit = row.as_ref().and_then(|row| row.spend_limit_micros);
        // A card declined when g1t charged it at the limit stops work until
        // it is paid; any payment clears it.
        let declined = row.as_ref().and_then(|row| row.autopay_failed_at.clone().map(|at| (at, row.autopay_error.clone())));
        let ceiling = match (trust_ceiling, spend_limit) {
            (Some(ceiling), Some(own)) => Some(ceiling.min(own)),
            (None, Some(own)) => Some(own),
            (ceiling, None) => ceiling,
        };
        let state = if declined.is_some() && exposure > 0 { LimitState::Stopped } else { state(exposure, ceiling) };
        let who = if account.kind == g1t_contracts::billing::AccountKind::Enterprise {
            format!("The {} enterprise, which pays for {workspace},", account.name)
        } else {
            format!("The {workspace} workspace")
        };
        let message = match state {
            LimitState::Ok => None,
            LimitState::Warning => Some(format!(
                "{who} has used {} of its {} limit this month. At the limit, its sandboxes, builds and apps stop until it pays or the month turns.",
                dollars_plain(exposure),
                dollars_plain(ceiling.unwrap_or_default()),
            )),
            LimitState::Stopped if declined.is_some() => Some(format!(
                "{who} could not be charged for its usage ({}), so its sandboxes, builds and apps are stopped. An owner can pay under Billing with another card.",
                declined.as_ref().and_then(|(_, error)| error.clone()).unwrap_or_else(|| "the card was declined".to_owned()),
            )),
            LimitState::Stopped => Some(if spend_limit.is_some() && ceiling == spend_limit {
                format!(
                    "The {workspace} workspace reached the {} spend limit its owners set for this month, so its sandboxes, builds and apps are stopped. An owner can raise it under Billing.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            } else {
                format!(
                    "{who} reached its {} limit for usage not yet paid for, so its sandboxes, builds and apps are stopped. The limit grows as a workspace pays g1t; an owner can pay under Billing, or write to support to have it raised.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            }),
        };
        Ok(Limit {
            workspace,
            account: account.id,
            account_name: account.name,
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
                 WHERE workspace IN ({marks}) AND kind = 'top_up' AND reference NOT LIKE 'crd%'"
            ))
            .bind(members)?
            .first::<Paid>(None)
            .await?
            .and_then(|row| row.paid)
            .unwrap_or(0))
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
        let Some(stripe) = self.stripe.as_ref().filter(|stripe| stripe.live()) else {
            return Ok(());
        };
        #[derive(Deserialize)]
        struct Candidate {
            workspace: String,
            customer_id: Option<String>,
        }
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let candidates = self
            .db
            .prepare(
                "SELECT DISTINCT ledger.workspace AS workspace, accounts.customer_id AS customer_id
                 FROM ledger JOIN accounts ON accounts.workspace = ledger.workspace
                 WHERE ledger.kind = 'usage' AND ledger.created_at >= ? AND accounts.customer_id IS NOT NULL",
            )
            .bind(&[month_start.as_str().into()])?
            .all()
            .await?
            .results::<Candidate>()?;
        for candidate in candidates {
            let Some(customer) = candidate.customer_id else { continue };
            let limit = self.limit_of(&candidate.workspace).await?;
            let own_limit = limit.spend_limit_micros.is_some() && limit.ceiling_micros == limit.spend_limit_micros;
            if limit.state == LimitState::Ok
                || own_limit
                || limit.trust == Trust::Internal
                || limit.account.starts_with("ent_")
            {
                continue;
            }
            let cents = ((limit.exposure_micros + 9_999) / 10_000).max(AUTOPAY_MIN_CENTS);
            let key = format!("autopay/{}/{}/{}", candidate.workspace, &month_start[..7], limit.exposure_micros / 1_000_000);
            let description = format!("g1t usage for {}, paid automatically near its limit", candidate.workspace);
            let now = rfc3339(now_ms());
            match stripe.charge_saved_card(&customer, cents, &description, &key).await {
                Ok(payment) if payment.status == "succeeded" => {
                    self.enter(
                        &candidate.workspace,
                        g1t_contracts::billing::EntryKind::TopUp,
                        payment.amount_received.max(cents) * 10_000,
                        &format!("Paid automatically by card, near the {} limit", dollars_plain(limit.ceiling_micros.unwrap_or_default())),
                        &payment.id,
                        None,
                        None,
                        None,
                        Some(&customer),
                    )
                    .await?;
                    self.db
                        .prepare("UPDATE limits SET autopay_failed_at = NULL, autopay_error = NULL WHERE workspace = ?")
                        .bind(&[candidate.workspace.as_str().into()])?
                        .run()
                        .await?;
                }
                outcome => {
                    let error = match outcome {
                        Ok(payment) => format!("the payment is {}", payment.status.replace('_', " ")),
                        Err(error) => error.to_string().chars().take(200).collect(),
                    };
                    self.db
                        .prepare(
                            "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at) VALUES (?1, ?2, ?3, ?2)
                             ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2",
                        )
                        .bind(&[candidate.workspace.as_str().into(), now.as_str().into(), error.as_str().into()])?
                        .run()
                        .await?;
                }
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
        let limit = a.spend_limit_micros.map_or(JsValue::NULL, |limit| (limit as f64).into());
        self.db
            .prepare(
                "INSERT INTO limits (workspace, spend_limit_micros, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (workspace) DO UPDATE SET spend_limit_micros = ?2, updated_at = ?3",
            )
            .bind(&[workspace.as_str().into(), limit, rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.limit_of(&workspace).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
