//! Tax and the card processing fee: what is paid with a payment on top of
//! what reaches the workspace's balance.
//!
//! - **Tax.** Stripe Tax works it out on every Checkout page, subscription,
//!   invoice and off-session charge (`stripe::checkout_tax_fields`,
//!   `invoice_tax_fields`, `tax_calculation`), at g1t's tax code, every
//!   price excluding tax. Prices on g1t are shown before tax.
//! - **The card fee.** Stripe's fee, grossed up (`card_fee_cents`), as a
//!   line of its own on every card payment: the plan and Security and
//!   quality (a monthly item), prepaying and invoices charged to a card. Never on a bank transfer or an invoice
//!   sent to be paid (an enterprise's). Switched by the `card_fee` cost
//!   setting, on by default. Tax applies to it as to what it is paid with.
//! - **Neither is revenue.** A payment's balance credit is what it paid
//!   less its tax and fee; each is kept in `tax_and_fees`, shown as its own
//!   line on the statement, and in sudo's Costs as tax collected, never as
//!   cash.
//! - **No address.** When Stripe Tax cannot place a customer, g1t does not
//!   charge: it marks the account (`accounts.tax_address_needed_at`), tells
//!   the owners once, and the Billing page asks for the address. Saving
//!   billing details with one clears it.

use g1t_contracts::billing::{CardFee, MICROS_PER_DOLLAR};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Billing;

/// A payment's tax and card fee, in cents, apart from what it paid for.
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

/// The card fee on `credit_cents`, so that what is left after Stripe's fee
/// is the credit: the total is `(credit + fixed) / (1 − percent)`, rounded
/// up to the cent. None when the fee is off.
pub(crate) fn card_fee_cents(credit_cents: u32, fee: &CardFee) -> u32 {
    if !fee.on || credit_cents == 0 {
        return 0;
    }
    let rate = fee.percent_micros / MICROS_PER_DOLLAR as f64;
    if !(0.0..0.5).contains(&rate) {
        return 0;
    }
    let total = ((f64::from(credit_cents) + f64::from(fee.fixed_cents)) / (1.0 - rate)).ceil();
    (total as u32).saturating_sub(credit_cents)
}

/// The card fee on a card payment of `cents`, when the setting is on.
pub(crate) fn fee_for(cents: i64, fee: &CardFee) -> i64 {
    if cents <= 0 {
        return 0;
    }
    i64::from(card_fee_cents(u32::try_from(cents).unwrap_or(u32::MAX), fee))
}

/// What the owners are told when Stripe Tax cannot place the workspace.
pub(crate) fn address_needed_message(workspace: &str) -> String {
    format!(
        "Add {workspace}'s billing address under Invoice details on the Billing page (/{workspace}/-/billing#details). Stripe needs it to work out tax, so g1t did not charge the card; nothing is lost, and the charge goes through once the address is there."
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

    /// The card fee, as the price book and the `card_fee` setting have it.
    pub(crate) async fn card_fee(&self) -> Result<CardFee> {
        #[derive(Deserialize)]
        struct Row {
            value: String,
        }
        let on = self
            .db
            .prepare("SELECT value FROM cost_settings WHERE key = 'card_fee'")
            .first::<Row>(None)
            .await?
            .is_none_or(|row| row.value.trim() != "off");
        let percent = self.price("card_fee_percent").await?.map_or(29_000.0, |(_, price)| price);
        let fixed = self.price("card_fee_fixed").await?.map_or(300_000.0, |(_, price)| price);
        Ok(CardFee { on, percent_micros: percent, fixed_cents: (fixed / 10_000.0).round().max(0.0) as u32 })
    }

    /// The card fee on a card payment, as the price book and the `card_fee`
    /// setting have it now.
    pub(crate) async fn card_fee_on(&self, cents: i64) -> Result<i64> {
        Ok(fee_for(cents, &self.card_fee().await?))
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
                &format!("https://g1t.sh/{workspace}/-/billing#details"),
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

    fn fee(on: bool) -> CardFee {
        CardFee { on, percent_micros: 29_000.0, fixed_cents: 30 }
    }

    #[test]
    fn the_card_fee_is_stripes_fee_grossed_up_and_off_when_switched_off() {
        // $25: ($25 + $0.30) / 0.971 = $26.06, so a $1.06 fee.
        assert_eq!(card_fee_cents(2_500, &fee(true)), 106);
        // What is left after Stripe's 2.9% + 30¢ is at least the amount.
        for credit in [1_000u32, 2_500, 5_000, 10_000, 100_000] {
            let total = credit + card_fee_cents(credit, &fee(true));
            let net = f64::from(total) - (f64::from(total) * 0.029).round() - 30.0;
            assert!(net >= f64::from(credit) - 1.0, "{credit}: {total} leaves {net}");
        }
        assert_eq!(card_fee_cents(2_500, &fee(false)), 0);
        assert_eq!(card_fee_cents(0, &fee(true)), 0);
    }

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
    fn the_card_fee_is_on_card_payments_unless_switched_off() {
        // A $20 plan: $0.91, so that $20 is left after Stripe's 2.9% + 30¢.
        assert_eq!(fee_for(2_000, &fee(true)), 91);
        assert_eq!(fee_for(2_000, &fee(false)), 0);
        assert_eq!(fee_for(0, &fee(true)), 0);
        assert_eq!(fee_for(-500, &fee(true)), 0);
        // The default is on: a setting never written reads as on.
        assert!(g1t_contracts::billing::CostSettings::default().card_fee);
    }

    #[test]
    fn the_owners_are_told_where_to_add_the_address() {
        let message = address_needed_message("acme");
        assert!(message.contains("/acme/-/billing#details"));
        assert!(message.contains("tax"));
    }
}
