//! The card check: a card saved and verified with Stripe, never charged.
//!
//! Compute costs g1t real money from the first second, so a workspace
//! without the plan needs a card check before its trial ($5 of usage, once)
//! or g1t's open-source pool will pay for anything. It is the smallest gate
//! that stops free compute being mined: a real card, one trial per card.
//!
//! The check is Stripe Checkout in setup mode with 3-D Secure asked for
//! wherever the card supports it. The card's bank sees a $0 or $1
//! authorization that is never captured. The card is saved as the
//! workspace's default, so starting the plan later needs no second page.
//!
//! It completes when the person comes back (`confirm_card_check`) or when
//! Stripe says so (`checkout.session.completed`), whichever is first: both
//! claim the same checkout row.

use g1t_contracts::billing::{CardCheckArgs, Checkout, ConfirmCardCheckArgs, Entitlements, EntitlementsArgs};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::{Billing, members_only};

/// What the checkout row for a card check is marked with.
pub(crate) const CARD_CHECK: &str = "card_check";

/// Whether a card's trial is still to be had: one trial per card,
/// whichever workspace it was checked for first, and never on a prepaid
/// card, which anyone can buy as many of as they like to farm trials. A
/// prepaid card still works for the plan and for paying.
pub(crate) fn trial_for_card(fingerprint: Option<&str>, funding: Option<&str>, checked_elsewhere: u32) -> bool {
    fingerprint.is_some() && funding != Some("prepaid") && checked_elsewhere == 0
}

impl Billing {
    /// `card_check`: Stripe's page to save and verify a card.
    pub(crate) async fn card_check(&self, a: CardCheckArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can check a card for the workspace."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t, so there is nothing to check."));
        };
        let customer = match self.customer_for(&workspace).await {
            Ok(customer) => customer,
            Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, format!("Stripe could not be reached: {error}"))),
        };
        let session = match stripe.start_card_check(&workspace, &customer, &a.return_url).await {
            Ok(session) => session,
            Err(error) if crate::stripe::is_missing(&error) => {
                self.forget_customer(&workspace).await?;
                let customer = self.customer_for(&workspace).await?;
                stripe.start_card_check(&workspace, &customer, &a.return_url).await?
            }
            Err(error) => return Err(error),
        };
        let Some(url) = session.url else {
            return Err(worker::Error::RustError("Stripe returned no page for the card check".into()));
        };
        self.db
            .prepare(
                "INSERT INTO checkouts (id, workspace, amount_cents, created_by, created_at, feature)
                 VALUES (?, ?, 0, ?, ?, ?)",
            )
            .bind(&[
                session.id.as_str().into(),
                workspace.as_str().into(),
                a.actor.username.as_str().into(),
                rfc3339(now_ms()).into(),
                CARD_CHECK.into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(Checkout { url }))
    }

    /// `confirm_card_check`: records the check once Stripe says it passed.
    pub(crate) async fn confirm_card_check(&self, a: ConfirmCardCheckArgs) -> Result<Outcome<Entitlements>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let mine = self
            .db
            .prepare("SELECT workspace FROM checkouts WHERE id = ? AND workspace = ? AND feature = ?")
            .bind(&[a.session.as_str().into(), workspace.as_str().into(), CARD_CHECK.into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if mine.is_some() {
            if let Err(why) = self.settle_card_check(&a.session).await? {
                return Ok(Outcome::fail(FailureCode::Conflict, why));
            }
        }
        Ok(Outcome::Ok(self.entitlements(EntitlementsArgs { workspace }).await?))
    }

    /// Records a card check whose page is done, once, and grants the trial
    /// if the card has not had one and this month's pool has room. Returns
    /// what happened, or why the check did not pass.
    pub(crate) async fn settle_card_check(&self, session_id: &str) -> Result<std::result::Result<String, String>> {
        #[derive(Deserialize)]
        struct Open {
            workspace: String,
            created_by: String,
            status: String,
        }
        let Some(open) = self
            .db
            .prepare("SELECT workspace, created_by, status FROM checkouts WHERE id = ? AND feature = ?")
            .bind(&[session_id.into(), CARD_CHECK.into()])?
            .first::<Open>(None)
            .await?
        else {
            return Ok(Ok("ignored: not a card check".to_owned()));
        };
        if open.status != "open" {
            return Ok(Ok("ignored: already settled".to_owned()));
        }
        let Some(stripe) = &self.stripe else { return Ok(Ok("ignored: payments off".to_owned())) };
        let session = stripe.session(session_id).await?;
        let Some(setup) = session.setup_intent.as_deref() else {
            return Ok(Err("The card check is not finished yet.".to_owned()));
        };
        let Some(card) = stripe.checked_card(setup).await? else {
            return Ok(Err("The card could not be verified. Try another card, or try again.".to_owned()));
        };
        let claimed = self
            .db
            .prepare("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open' RETURNING id")
            .bind(&[session_id.into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Ok("ignored: settled meanwhile".to_owned()));
        }
        let workspace = open.workspace;
        let now = rfc3339(now_ms());
        #[derive(Deserialize)]
        struct Count {
            n: Option<u32>,
        }
        let elsewhere = match card.fingerprint.as_deref() {
            Some(fingerprint) => self
                .db
                .prepare("SELECT COUNT(*) AS n FROM card_checks WHERE fingerprint = ? AND workspace <> ?")
                .bind(&[fingerprint.into(), workspace.as_str().into()])?
                .first::<Count>(None)
                .await?
                .and_then(|c| c.n)
                .unwrap_or(0),
            None => 0,
        };
        self.db
            .prepare(
                "INSERT INTO card_checks (workspace, setup_intent, payment_method, fingerprint, brand, last4, funding, country, checked_by, checked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (workspace) DO UPDATE SET setup_intent = ?2, payment_method = ?3, fingerprint = ?4, brand = ?5,
                   last4 = ?6, funding = ?7, country = ?8, checked_by = ?9, checked_at = ?10",
            )
            .bind(&[
                workspace.as_str().into(),
                setup.into(),
                card.payment_method.as_str().into(),
                crate::optional(card.fingerprint.as_deref()),
                crate::optional(card.brand.as_deref()),
                crate::optional(card.last4.as_deref()),
                crate::optional(card.funding.as_deref()),
                crate::optional(card.country.as_deref()),
                open.created_by.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        // The card the plan and later charges use.
        if let Some(customer) = session.customer.as_deref() {
            if let Err(error) = stripe.set_default_card(customer, &card.payment_method).await {
                worker::console_error!("{workspace}: the checked card was not made the default: {error}");
            }
            self.db
                .prepare("UPDATE accounts SET customer_id = COALESCE(customer_id, ?2) WHERE workspace = ?1")
                .bind(&[workspace.as_str().into(), customer.into()])?
                .run()
                .await?;
        }
        let account = self.account_of(&workspace).await?;
        let trial = if trial_for_card(card.fingerprint.as_deref(), card.funding.as_deref(), elsewhere) {
            match self.ensure_grant(&workspace).await? {
                Some(grant) => format!("trial of {} granted", crate::features::dollars(grant.granted_micros)),
                None => "no trial: this month's pool is given out".to_owned(),
            }
        } else if card.funding.as_deref() == Some("prepaid") {
            "no trial: prepaid cards cannot start one".to_owned()
        } else {
            "no trial: the card had one for another workspace".to_owned()
        };
        self.audit(
            &account.id,
            "card_check",
            &format!(
                "{workspace}: {} ending {} checked ({}); {trial}",
                card.brand.as_deref().unwrap_or("card"),
                card.last4.as_deref().unwrap_or("????"),
                card.funding.as_deref().unwrap_or("unknown")
            ),
            &open.created_by,
        )
        .await?;
        Ok(Ok(format!("{workspace}: card checked; {trial}")))
    }

    /// Whether the workspace's checked card may start a trial: it has a
    /// fingerprint, and no other workspace checked the same card before.
    pub(crate) async fn trial_allowed(&self, workspace: &str) -> Result<bool> {
        #[derive(Deserialize)]
        struct Row {
            fingerprint: Option<String>,
            funding: Option<String>,
            earlier: Option<u32>,
        }
        let row = self
            .db
            .prepare(
                "SELECT c.fingerprint AS fingerprint, c.funding AS funding,
                        (SELECT COUNT(*) FROM card_checks o
                          WHERE o.fingerprint = c.fingerprint AND o.workspace <> c.workspace AND o.checked_at <= c.checked_at) AS earlier
                 FROM card_checks c WHERE c.workspace = ?",
            )
            .bind(&[workspace.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.is_some_and(|r| trial_for_card(r.fingerprint.as_deref(), r.funding.as_deref(), r.earlier.unwrap_or(0))))
    }

    /// The checked card's payment method, for starting the plan on it.
    pub(crate) async fn checked_card(&self, workspace: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            payment_method: String,
        }
        Ok(self
            .db
            .prepare("SELECT payment_method FROM card_checks WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| row.payment_method))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_trial_per_card() {
        assert!(trial_for_card(Some("fp_1"), Some("credit"), 0));
        assert!(trial_for_card(Some("fp_1"), Some("debit"), 0));
        // The same card checked for another workspace first: no second trial.
        assert!(!trial_for_card(Some("fp_1"), Some("credit"), 1));
        // A card Stripe could not fingerprint gets no trial.
        assert!(!trial_for_card(None, Some("credit"), 0));
        // Prepaid cards are how trials get farmed: none.
        assert!(!trial_for_card(Some("fp_2"), Some("prepaid"), 0));
    }
}
