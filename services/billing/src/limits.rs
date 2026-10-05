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

use g1t_contracts::billing::{CheckLimitArgs, Limit, LimitArgs, LimitState, SetSpendLimitArgs, Trust};
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
    /// `LIMIT_EXEMPT`: g1t's own workspaces, comma-separated.
    pub exempt: Vec<String>,
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
            exempt: env
                .var("LIMIT_EXEMPT")
                .map(|v| v.to_string())
                .unwrap_or_default()
                .split(',')
                .map(|name| name.trim().to_lowercase())
                .filter(|name| !name.is_empty())
                .collect(),
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

#[derive(Deserialize)]
struct LimitRow {
    ceiling_micros: Option<i64>,
    spend_limit_micros: Option<i64>,
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
    /// The workspace's limit, worked out from its ledger.
    pub(crate) async fn limit_of(&self, workspace: &str) -> Result<Limit> {
        let workspace = workspace.to_lowercase();
        let row = self
            .db
            .prepare("SELECT ceiling_micros, spend_limit_micros FROM limits WHERE workspace = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<LimitRow>(None)
            .await?;
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        // Each usage entry at its cost to g1t or its charge, whichever is
        // more; on the workspace's own provider, only g1t's fee is g1t's.
        let month = self
            .db
            .prepare(
                "SELECT
                   SUM(CASE WHEN kind = 'usage' THEN
                         CASE WHEN COALESCE(billed_to, 'g1t') = 'g1t'
                              THEN MAX(COALESCE(cost_micros, 0), -amount_micros)
                              ELSE -amount_micros END
                       END) AS used,
                   SUM(CASE WHEN kind = 'top_up' THEN amount_micros END) AS paid
                 FROM ledger WHERE workspace = ?1 AND created_at >= ?2",
            )
            .bind(&[workspace.as_str().into(), month_start.as_str().into()])?
            .first::<Month>(None)
            .await?;
        let (used, paid_month) = month.map_or((0, 0), |m| (m.used.unwrap_or(0), m.paid.unwrap_or(0)));
        // Test-mode payments are not money: they pay nothing off.
        let live = self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live);
        let exposure = (used - if live { paid_month } else { 0 }).max(0);

        let (trust, trust_ceiling) = if self.ceilings.exempt.iter().any(|name| *name == workspace) {
            (Trust::Internal, None)
        } else if let Some(ceiling) = row.as_ref().and_then(|row| row.ceiling_micros) {
            (Trust::Reviewed, Some(ceiling))
        } else {
            let paid = self.live_paid(&workspace).await?;
            if paid > 0 {
                (Trust::Paid, Some(self.ceilings.for_paid(paid)))
            } else {
                (Trust::New, Some(self.ceilings.new))
            }
        };
        let spend_limit = row.and_then(|row| row.spend_limit_micros);
        let ceiling = match (trust_ceiling, spend_limit) {
            (Some(ceiling), Some(own)) => Some(ceiling.min(own)),
            (None, Some(own)) => Some(own),
            (ceiling, None) => ceiling,
        };
        let state = state(exposure, ceiling);
        let message = match state {
            LimitState::Ok => None,
            LimitState::Warning => Some(format!(
                "The {workspace} workspace has used {} of its {} limit this month. At the limit, its sandboxes, builds and apps stop until it pays or the month turns.",
                dollars_plain(exposure),
                dollars_plain(ceiling.unwrap_or_default()),
            )),
            LimitState::Stopped => Some(if spend_limit.is_some() && ceiling == spend_limit {
                format!(
                    "The {workspace} workspace reached the {} spend limit its owners set for this month, so its sandboxes, builds and apps are stopped. An owner can raise it under Billing.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            } else {
                format!(
                    "The {workspace} workspace reached its {} limit for usage not yet paid for, so its sandboxes, builds and apps are stopped. The limit grows as a workspace pays g1t; an owner can pay under Billing, or write to support to have it raised.",
                    dollars_plain(ceiling.unwrap_or_default()),
                )
            }),
        };
        Ok(Limit {
            workspace,
            trust,
            exposure_micros: exposure,
            ceiling_micros: ceiling,
            trust_ceiling_micros: trust_ceiling,
            spend_limit_micros: spend_limit,
            state,
            message,
        })
    }

    /// Real money the workspace has paid g1t. Nothing in test mode.
    async fn live_paid(&self, workspace: &str) -> Result<i64> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(0);
        }
        Ok(self
            .db
            .prepare("SELECT SUM(amount_micros) AS paid FROM ledger WHERE workspace = ? AND kind = 'top_up'")
            .bind(&[workspace.into()])?
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
        Ceilings { new: 3_000_000, paid_min: 25_000_000, paid_max: 1_000_000_000, exempt: vec![] }
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
