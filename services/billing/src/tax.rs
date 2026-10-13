//! Tax: what is paid with a payment on top of what reaches the workspace's
//! balance.
//!
//! - **Tax.** Stripe Tax works it out on every Checkout page, subscription,
//!   invoice and off-session charge (`stripe::checkout_tax_fields`,
//!   `invoice_tax_fields`, `tax_calculation`), at g1t's tax code, every
//!   price excluding tax. Prices on g1t are shown before tax.
//! - **No card fee.** Stripe's fee for taking a card is part of g1t's
//!   prices (the plan's price and the margin on usage), never a line of its
//!   own on anything. Payments from before that may still carry a
//!   `card_fee` row in `tax_and_fees`; those are kept and shown as they
//!   were, and every new payment records none.
//! - **Tax is not revenue.** A payment's balance credit is what it paid
//!   less its tax; tax is kept in `tax_and_fees`, shown as its own line on
//!   the statement, and in sudo's Costs as tax collected, never as cash.
//! - **No address.** When Stripe Tax cannot place a customer, g1t does not
//!   charge: it marks the account (`accounts.tax_address_needed_at`), tells
//!   the owners once, and the Billing page asks for the address. Saving
//!   billing details with one clears it.

use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Billing;

/// A payment's tax and card fee, in cents, apart from what it paid for. The
/// fee is only ever non-zero on payments from before it was folded into
/// prices.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Extras {
    pub tax_cents: i64,
    pub fee_cents: i64,
}

/// What a prepayment credits: what its lines came to before tax, less the
/// card fee line, in cents. Never less than nothing.
pub(crate) fn prepay_credit_cents(before_tax_cents: i64, fee_cents: i64) -> i64 {
    (before_tax_cents - fee_cents.max(0)).max(0)
}

/// What of a refund came off the balance, and what was tax and fee given
/// back with it: the refund split in the proportion the payment was.
/// `extras_cents` is the payment's tax and fee together.
pub(crate) fn refund_split(refunded_cents: i64, paid_cents: i64, tax_cents: i64, fee_cents: i64) -> (i64, i64, i64) {
    if paid_cents <= 0 || refunded_cents <= 0 {
        return (refunded_cents.max(0), 0, 0);
    }
    let refunded = refunded_cents.min(paid_cents);
    let tax = (i128::from(refunded) * i128::from(tax_cents.max(0)) / i128::from(paid_cents)) as i64;
    let fee = (i128::from(refunded) * i128::from(fee_cents.max(0)) / i128::from(paid_cents)) as i64;
    (refunded - tax - fee, tax, fee)
}

/// What a payment's ledger line says was paid with it besides what it
/// credited: its tax, and a card fee only on payments from before the fee
/// was folded into prices. Nothing when there was neither.
pub(crate) fn paid_with(extras: Extras) -> String {
    let money = |cents: i64| crate::features::cents(cents * 10_000);
    match (extras.tax_cents > 0, extras.fee_cents > 0) {
        (false, false) => String::new(),
        (true, false) => format!(" (tax {} paid with it)", money(extras.tax_cents)),
        (false, true) => format!(" (card fee {} paid with it)", money(extras.fee_cents)),
        (true, true) => format!(" (tax {} and card fee {} paid with it)", money(extras.tax_cents), money(extras.fee_cents)),
    }
}

/// What the owners are told when Stripe Tax cannot place the workspace.
pub(crate) fn address_needed_message(workspace: &str) -> String {
    format!(
        "Add {workspace}'s billing address in Stripe: on the Billing page (/{workspace}/-/billing#stripe), choose Manage billing. Stripe needs it to work out tax, so g1t did not charge the card; nothing is lost, and the charge goes through once the address is there."
    )
}

#[derive(Deserialize)]
struct Sum {
    micros: Option<f64>,
}

impl Billing {
    /// Keeps a payment's tax and card fee apart from what it paid for, once
    /// per payment and kind.
    pub(crate) async fn record_extras(
        &self,
        workspace: &str,
        reference: &str,
        payment_intent: Option<&str>,
        extras: Extras,
        tax_transaction: Option<&str>,
    ) -> Result<()> {
        let now = rfc3339(now_ms());
        let mut writes = vec![];
        for (kind, cents) in [("tax", extras.tax_cents), ("card_fee", extras.fee_cents)] {
            if cents == 0 {
                continue;
            }
            writes.push(
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO tax_and_fees (id, workspace, kind, amount_micros, reference, payment_intent, tax_transaction, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        format!("{reference}/{kind}").into(),
                        workspace.into(),
                        kind.into(),
                        ((cents * 10_000) as f64).into(),
                        reference.into(),
                        crate::optional(payment_intent),
                        crate::optional(if kind == "tax" { tax_transaction } else { None }),
                        now.as_str().into(),
                    ])?,
            );
        }
        if !writes.is_empty() {
            self.db.batch(writes).await?;
        }
        Ok(())
    }

    /// A payment's tax and fee, as kept, by the PaymentIntent that took it
    /// or the invoice it paid; and its tax transaction, if any.
    pub(crate) async fn extras_of(&self, payment_intent: Option<&str>, invoice: Option<&str>) -> Result<(Extras, Option<String>)> {
        #[derive(Deserialize)]
        struct Row {
            kind: String,
            amount_micros: i64,
            tax_transaction: Option<String>,
        }
        let rows = self
            .db
            .prepare(
                "SELECT kind, amount_micros, tax_transaction FROM tax_and_fees
                 WHERE ((payment_intent IS NOT NULL AND payment_intent = ?1) OR reference = ?2) AND reference NOT LIKE 'refund/%'",
            )
            .bind(&[payment_intent.unwrap_or("").into(), invoice.unwrap_or("").into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut extras = Extras::default();
        let mut transaction = None;
        for row in rows {
            match row.kind.as_str() {
                "tax" => {
                    extras.tax_cents += row.amount_micros / 10_000;
                    transaction = transaction.or(row.tax_transaction);
                }
                _ => extras.fee_cents += row.amount_micros / 10_000,
            }
        }
        Ok((extras, transaction))
    }

    /// Marks that Stripe Tax could not place the workspace, and tells its
    /// owners the first time.
    pub(crate) async fn tax_address_needed(&self, workspace: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        #[derive(Deserialize)]
        struct Row {
            #[allow(dead_code)]
            workspace: String,
        }
        let first = self
            .db
            .prepare("UPDATE accounts SET tax_address_needed_at = ? WHERE workspace = ? AND tax_address_needed_at IS NULL RETURNING workspace")
            .bind(&[now.as_str().into(), workspace.into()])?
            .first::<Row>(None)
            .await?
            .is_some();
        if first && let Some(identity) = &self.identity {
            crate::limits::notify_with(
                identity,
                workspace,
                &format!("g1t: add a billing address for {workspace}"),
                &address_needed_message(workspace),
                "Add the address",
                &format!("https://g1t.sh/{workspace}/-/billing#stripe"),
                "You get this because you own this workspace on g1t. Tax is explained at https://docs.g1t.sh/guides/usage-and-billing/#tax",
            )
            .await;
        }
        Ok(())
    }

    /// Clears the mark once an address is saved.
    pub(crate) async fn tax_address_given(&self, workspace: &str) -> Result<()> {
        self.db
            .prepare("UPDATE accounts SET tax_address_needed_at = NULL WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// When Stripe Tax last could not place the workspace, while it still
    /// cannot.
    pub(crate) async fn tax_address_needed_at(&self, workspace: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            tax_address_needed_at: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT tax_address_needed_at FROM accounts WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.tax_address_needed_at))
    }

    /// Tax and card fees kept between two days (inclusive, `YYYY-MM-DD`),
    /// in micros, for sudo: (tax, fees).
    pub(crate) async fn extras_between(&self, from: &str, to: &str) -> Result<(i64, i64)> {
        let sum = |kind: &'static str| async move {
            Ok::<i64, worker::Error>(
                self.db
                    .prepare("SELECT SUM(amount_micros) AS micros FROM tax_and_fees WHERE kind = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?")
                    .bind(&[kind.into(), from.into(), to.into()])?
                    .first::<Sum>(None)
                    .await?
                    .and_then(|s| s.micros)
                    .unwrap_or(0.0) as i64,
            )
        };
        Ok((sum("tax").await?, sum("card_fee").await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prepayment_credits_what_it_bought_never_its_tax_or_fee() {
        // $50 bought, $1.85 card fee, $4 tax: $50 credited.
        assert_eq!(prepay_credit_cents(5_185, 185), 5_000);
        assert_eq!(prepay_credit_cents(100_000, 0), 100_000);
        assert_eq!(prepay_credit_cents(100, 500), 0);
    }

    #[test]
    fn a_refund_gives_back_tax_and_fee_in_proportion() {
        // $54.00 paid: $50 credit, $1.85 fee, $2.15 tax; half refunded.
        let (balance, tax, fee) = refund_split(2_700, 5_400, 215, 185);
        assert_eq!(balance + tax + fee, 2_700);
        assert_eq!((tax, fee), (107, 92));
        // A payment with neither: all of it off the balance.
        assert_eq!(refund_split(1_000, 1_000, 0, 0), (1_000, 0, 0));
        // Never more than was paid.
        assert_eq!(refund_split(9_000, 5_400, 215, 185).0, 5_000);
    }

    #[test]
    fn a_payments_line_names_a_card_fee_only_when_there_was_one() {
        assert_eq!(paid_with(Extras::default()), "");
        assert_eq!(paid_with(Extras { tax_cents: 180, fee_cents: 0 }), " (tax $1.80 paid with it)");
        assert_eq!(paid_with(Extras { tax_cents: 180, fee_cents: 92 }), " (tax $1.80 and card fee $0.92 paid with it)");
    }

    #[test]
    fn the_owners_are_told_where_to_add_the_address() {
        let message = address_needed_message("acme");
        assert!(message.contains("/acme/-/billing#stripe") && message.contains("Manage billing"));
        assert!(message.contains("tax"));
    }
}
