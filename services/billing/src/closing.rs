//! Closing a workspace's billing before the workspace is deleted.
//!
//! Identity asks first (`dry_run`), to show the owner what stands in the
//! way, and then for real, just before it deletes anything. A workspace can
//! be closed when nothing is left between it and g1t:
//!
//! - no invoice of its failed and is still unpaid;
//! - no prepaid credit is left (it would be lost);
//! - what it owes can be charged now, to its card, with no minimum;
//! - no usage this month is still being metered (storage and git
//!   operations are charged when the month closes).
//!
//! A comped workspace owes nothing, so only its plan is ended. A workspace
//! an enterprise pays for is closed by g1t staff, who detach it first.
//!
//! Closing ends the plan at Stripe at once, puts the workspace's own
//! account back on standard terms (so the name, if made again, starts
//! like any other), and records it. The ledger, invoices and statements
//! stay, under the slug, for accounting.

use g1t_contracts::billing::{CloseWorkspaceArgs, TermsKind};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Billing;
use crate::accounts::own_account;
use crate::features::cents;

/// `repo.transferred` (see `g1t_kit::transfer`): `?1` the repository's
/// path now, `?2` a path it had. Ledger rows, runs and holds keep the path
/// they were charged under.
pub(crate) const TRANSFERRED: &[&str] = &[
    "UPDATE OR IGNORE allowance_use SET scope = ?1 WHERE kind = 'oss_repo' AND scope = ?2",
];

/// Everything that decides whether a workspace's billing can be closed.
#[derive(Debug, Default)]
pub(crate) struct Facts {
    pub workspace: String,
    /// The enterprise that pays for it, by name.
    pub enterprise: Option<String>,
    pub comped: bool,
    pub failed_invoices: u32,
    /// Positive is credit, negative is owed.
    pub balance_micros: i64,
    pub has_card: bool,
    /// Usage this month that is charged when the month closes.
    pub metering_micros: i64,
    /// The first day of next month, `YYYY-MM-DD`.
    pub next_month: String,
}

/// What closing does about money.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settle {
    Nothing,
    /// Charge the card this much now.
    Charge(i64),
}

pub(crate) fn decide(facts: &Facts) -> std::result::Result<Settle, String> {
    let ws = &facts.workspace;
    if let Some(enterprise) = &facts.enterprise {
        return Err(format!(
            "{ws} is billed through {enterprise}. Write to support@g1t.sh to have it moved off that account first."
        ));
    }
    if facts.comped {
        return Ok(Settle::Nothing);
    }
    if facts.failed_invoices > 0 {
        return Err(format!(
            "{ws} has an unpaid invoice. Pay it from the workspace's Billing page first."
        ));
    }
    if facts.balance_micros > 0 {
        return Err(format!(
            "{ws} has {} of prepaid credit left, which would be lost. Spend it, or write to support@g1t.sh about a refund, first.",
            cents(facts.balance_micros)
        ));
    }
    if facts.metering_micros > 0 {
        return Err(format!(
            "{ws} has {} of usage this month (storage and git operations) that is charged when the month closes. You can delete it from {}.",
            cents(facts.metering_micros),
            facts.next_month
        ));
    }
    let owed = -facts.balance_micros;
    if owed > 0 {
        if !facts.has_card {
            return Err(format!(
                "{ws} owes {}. Add a card or pay it from the workspace's Billing page first.",
                cents(owed)
            ));
        }
        return Ok(Settle::Charge(owed));
    }
    Ok(Settle::Nothing)
}

#[derive(Deserialize)]
struct Count {
    n: Option<f64>,
}

#[derive(Deserialize)]
struct Subscription {
    feature: String,
    subscription_id: String,
}

impl Billing {
    async fn closing_facts(&self, workspace: &str) -> Result<Facts> {
        let account = self.account_of(workspace).await?;
        let row = self.row(workspace).await?;
        let failed = self
            .db
            .prepare("SELECT count(*) AS n FROM workspace_invoices WHERE workspace = ? AND status = 'failed'")
            .bind(&[workspace.into()])?
            .first::<Count>(None)
            .await?
            .and_then(|c| c.n)
            .unwrap_or(0.0) as u32;
        let now = rfc3339(now_ms());
        let month = crate::credits::month_of(&now);
        let metering = self
            .db
            .prepare(
                "SELECT SUM(charge_micros) AS n FROM pending_usage
                 WHERE workspace = ? AND charged_at IS NULL AND month >= ?",
            )
            .bind(&[workspace.into(), month.as_str().into()])?
            .first::<Count>(None)
            .await?
            .and_then(|c| c.n)
            .unwrap_or(0.0) as i64;
        Ok(Facts {
            workspace: workspace.to_owned(),
            enterprise: account.id.starts_with("ent_").then(|| account.name.clone()),
            comped: account.terms.kind == TermsKind::Comped,
            failed_invoices: failed,
            balance_micros: row.as_ref().map_or(0, |r| r.balance_micros),
            has_card: row.as_ref().is_some_and(|r| r.customer_id.is_some()) && self.stripe.is_some(),
            metering_micros: metering,
            next_month: crate::credits::next_month_start(&month)[..10].to_owned(),
        })
    }

    /// `close_workspace`: see `g1t_contracts::billing::CloseWorkspaceArgs`.
    pub(crate) async fn close_workspace(&self, a: CloseWorkspaceArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.trim().to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can close a workspace's billing.",
            ));
        }
        let facts = self.closing_facts(&workspace).await?;
        let settle = match decide(&facts) {
            Ok(settle) => settle,
            Err(reason) => return Ok(Outcome::fail(FailureCode::PaymentRequired, reason)),
        };
        if a.dry_run {
            return Ok(Outcome::Ok(true));
        }
        if let Settle::Charge(owed) = settle {
            let period = rfc3339(now_ms())[..10].to_owned();
            match self.invoice_workspace(&workspace, "close", &period).await? {
                Ok(invoice) if invoice.status == "paid" => {}
                Ok(_) => {
                    return Ok(Outcome::fail(
                        FailureCode::PaymentRequired,
                        format!(
                            "The card on file was declined for the {} {workspace} owes. Pay it from the workspace's Billing page first.",
                            cents(owed)
                        ),
                    ));
                }
                Err(why) => return Ok(Outcome::fail(FailureCode::PaymentRequired, why)),
            }
        }
        self.end_plans(&workspace).await?;
        let now = rfc3339(now_ms());
        let account = own_account(&workspace);
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO closed_workspaces (workspace, closed_by, closed_at, balance_micros)
                         VALUES (?, ?, ?, ?)",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        a.actor.username.as_str().into(),
                        now.as_str().into(),
                        (facts.balance_micros as f64).into(),
                    ])?,
                // Terms set for the workspace end with it; the name, made
                // again, starts on standard terms.
                self.db
                    .prepare(
                        "UPDATE billing_accounts SET terms_kind = 'standard', terms_set_by = 'closed', terms_set_at = ?
                         WHERE id = ? AND terms_kind <> 'standard'",
                    )
                    .bind(&[now.as_str().into(), account.as_str().into()])?,
            ])
            .await?;
        self.audit(
            &account,
            "close",
            &format!("Closed: {workspace} was deleted by {}", a.actor.username),
            &a.actor.username,
        )
        .await?;
        Ok(Outcome::Ok(true))
    }

    /// Ends every plan the workspace has at Stripe now, rather than at the
    /// end of the period: there is nothing left to use it for.
    async fn end_plans(&self, workspace: &str) -> Result<()> {
        let live = self
            .db
            .prepare(
                "SELECT feature, subscription_id FROM subscriptions
                 WHERE workspace = ? AND status <> 'canceled'",
            )
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<Subscription>()?;
        for plan in live {
            if let Some(stripe) = &self.stripe {
                match stripe.cancel_now(&plan.subscription_id).await {
                    Ok(_) => {}
                    Err(error) if crate::stripe::is_missing(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            self.db
                .prepare(
                    "UPDATE subscriptions SET status = 'canceled', updated_at = ?
                     WHERE workspace = ? AND feature = ?",
                )
                .bind(&[rfc3339(now_ms()).into(), workspace.into(), plan.feature.as_str().into()])?
                .run()
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            workspace: "acme".into(),
            has_card: true,
            next_month: "2026-11-01".into(),
            ..Facts::default()
        }
    }

    #[test]
    fn a_transfer_moves_only_the_pool_share() {
        for sql in TRANSFERRED {
            assert_eq!(g1t_kit::transfer::parameters(sql), 2, "{sql}");
        }
    }

    #[test]
    fn a_settled_workspace_closes() {
        assert_eq!(decide(&facts()), Ok(Settle::Nothing));
    }

    #[test]
    fn what_is_owed_is_charged_now() {
        assert_eq!(decide(&Facts { balance_micros: -2_500_000, ..facts() }), Ok(Settle::Charge(2_500_000)));
        let no_card = decide(&Facts { balance_micros: -2_500_000, has_card: false, ..facts() }).unwrap_err();
        assert!(no_card.contains("owes $2.50"), "{no_card}");
    }

    #[test]
    fn credit_metering_and_failed_invoices_wait() {
        assert!(decide(&Facts { balance_micros: 5_000_000, ..facts() }).unwrap_err().contains("prepaid credit"));
        assert!(decide(&Facts { failed_invoices: 1, ..facts() }).unwrap_err().contains("unpaid invoice"));
        let metering = decide(&Facts { metering_micros: 10_000, ..facts() }).unwrap_err();
        assert!(metering.contains("2026-11-01"), "{metering}");
    }

    #[test]
    fn comped_owes_nothing_and_enterprises_go_through_staff() {
        assert_eq!(
            decide(&Facts { comped: true, balance_micros: -9_000_000, metering_micros: 1, ..facts() }),
            Ok(Settle::Nothing)
        );
        assert!(decide(&Facts { enterprise: Some("Initech".into()), ..facts() }).unwrap_err().contains("Initech"));
    }
}
