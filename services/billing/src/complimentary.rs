//! Complimentary and custom terms: g1t staff enroll a workspace by hand in
//! sudo (`admin_set_complimentary`); nothing enrolls a workspace on its own,
//! and new workspaces stay free.
//!
//! **What it gives.** The plan's features; a monthly usage allowance valued
//! at ordinary usage prices (not at cost, and not a discount); and a
//! recurring monthly fee of its own, often waived. The fee and the
//! allowance are separate amounts. Calendar months in UTC, no rollover.
//!
//! **Where it stops.** Past the allowance new billable work is refused
//! (`reserve`, and `has_plan` false for storage and caches). There is never
//! an overage, a saved card or not. Work already running when the allowance
//! ran out finishes; what it cost past the allowance is g1t's
//! (`ledger.given_micros`), recorded apart from the allowance
//! (`ledger.gift_micros`) and never charged afterwards. Admission counts the
//! month's used allowance, usage metered but not on the ledger yet (storage,
//! git operations) and what running work holds.
//!
//! **Periods.** Terms are kept as periods (`complimentary_periods`). A usage
//! line draws on the period covering its own time (`allocate_usage.sql`), so
//! late usage lands where it happened. Changing the amount closes one period
//! and opens the next; consumption is per month, so it is kept, and an amount
//! lowered below it leaves nothing more this month, never a debt.
//!
//! **Stripe.** A real customer and subscription stand for the enrollment,
//! with the grant's identity and terms in its metadata. The workspace sees
//! the enrollment only once Stripe has the subscription: until then it is
//! `pending` and keeps its plan. Each Stripe step is written down first
//! (`pending_op`) with an idempotency key made from the grant, so a retry
//! after a crash or a timeout repeats the same request; one older than
//! Stripe keeps keys for is reconciled by looking for the grant at Stripe
//! instead, never sent again under a new key. The fifteen-minute tick picks
//! up any step still owed. A waived fee is a $0 price on the plan's
//! product; g1t's own unlimited enrollment (flagon-io) is the plan's price
//! with a 100% coupon, a fully discounted real subscription.
//!
//! The allowance is never a ledger top-up: it is not money and not credit
//! on the balance. Money received (plan and fee invoices, payments in
//! advance, bank transfers) and promotional credit are shown apart.
//!
//! **Converting.** An owner can start the plan on the same customer and
//! subscription (`convert_to_paid`): its one item becomes the plan's price
//! with `payment_behavior=pending_if_incomplete`, so Stripe changes nothing
//! until the first payment succeeds. A decline, a bank asking for the person
//! (3DS), an abandoned page or a second click leave the enrollment as it
//! was, with one subscription. Only once Stripe shows the plan's price on
//! the item does the enrollment end (`converted`). Usage up to that moment
//! stays as the allowance paid for it.

use g1t_contracts::billing::{
    AdminComplimentaryArgs, AdminEndComplimentaryArgs, AdminSetComplimentaryArgs, CardCheckArgs, ComplimentaryMonth, ComplimentaryPeriod,
    ComplimentaryStanding, Conversion, ConvertToPaidArgs, Feature, UsageAlert, MAX_COMPLIMENTARY_FEE_CENTS, MAX_COMPLIMENTARY_MICROS,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::Billing;
use crate::features::{cents, dollars};
use crate::stripe::{Stripe, StripeSubscription, is_missing};

/// Stripe keeps an idempotency key for 24 hours. An operation older than
/// this is reconciled by looking for what it made, never sent again.
const KEY_KEPT_MS: u64 = 23 * 60 * 60 * 1000;
/// The coupon behind a fully discounted enrollment (g1t's own).
pub(crate) const FULL_DISCOUNT_COUPON: &str = "g1t_complimentary_100";
/// Pending Stripe steps tried each tick.
const TICK_BATCH: u32 = 10;

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Row {
    pub workspace: String,
    pub grant_id: String,
    pub status: String,
    pub allowance_micros: i64,
    pub unlimited: i64,
    pub fee_cents: i64,
    /// `stop` or `charge`: what happens past the allowance.
    pub overage: String,
    pub live: i64,
    pub customer_id: Option<String>,
    pub subscription_id: Option<String>,
    pub item_id: Option<String>,
    pub price_id: Option<String>,
    pub stripe_status: Option<String>,
    pub pending_op: Option<String>,
    pub last_error: Option<String>,
    pub note: String,
    pub created_by: String,
    pub created_at: String,
    pub created_ms: i64,
    pub updated_by: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    pub ended_reason: Option<String>,
}

impl Row {
    fn unlimited(&self) -> bool {
        self.unlimited != 0
    }

    /// Past the allowance, the workspace's own card is charged.
    pub(crate) fn charges_past(&self) -> bool {
        self.overage == "charge"
    }
}

/// Fully discounted: the plan's price under the 100% coupon. Only g1t's own
/// workspaces (a 100% discount in their terms) with an unlimited allowance
/// and no fee are; any other enrollment is its own price.
pub(crate) fn fully_discounted(row: &Row, internal: bool) -> bool {
    internal && row.unlimited() && row.fee_cents == 0
}

/// A Stripe step still owed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum Op {
    /// Make the customer (if needed) and the subscription.
    Create,
    /// Bring the subscription's price and metadata to the open period's.
    Terms { period: String },
    /// Cancel the subscription now.
    Cancel,
    /// The owner's conversion to the plan, attempt `attempt` started at
    /// `started_ms` (both in its idempotency keys, so a refused attempt is
    /// never replayed by the next).
    Convert { attempt: u32, by: String, started_ms: u64 },
}

impl Op {
    pub(crate) fn parse(text: Option<&str>) -> Option<Op> {
        serde_json::from_str(text?).ok()
    }

    fn text(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Why staff's terms cannot be saved, or None.
pub(crate) fn invalid(a: &AdminSetComplimentaryArgs) -> Option<String> {
    if a.workspace.trim().is_empty() {
        return Some("Name the workspace.".into());
    }
    if a.note.trim().len() < 3 {
        return Some("Say why, in a few words: it goes in the audit log.".into());
    }
    if a.by.trim().is_empty() {
        return Some("Who is making the change is missing.".into());
    }
    if !(0..=MAX_COMPLIMENTARY_MICROS).contains(&a.allowance_micros) {
        return Some(format!("The monthly allowance is between $0 and {}; for more, make it unlimited.", cents(MAX_COMPLIMENTARY_MICROS)));
    }
    if a.fee_cents > MAX_COMPLIMENTARY_FEE_CENTS {
        return Some(format!("The monthly fee is at most {}.", cents(i64::from(MAX_COMPLIMENTARY_FEE_CENTS) * 10_000)));
    }
    if !a.unlimited && a.allowance_micros == 0 && a.fee_cents == 0 {
        return Some("An enrollment with no allowance and no fee gives nothing: set an allowance, or end the enrollment.".into());
    }
    None
}

/// A month's standing from its figures. `remaining` is what new work may
/// still hold: what is left after used, pending and held usage.
pub(crate) fn month_standing(month: &str, row: &Row, used: i64, pending: i64, held: i64, overrun: i64, has_card: bool) -> ComplimentaryMonth {
    let remaining = if row.unlimited() { crate::credits::left(g1t_contracts::billing::UNLIMITED_MICROS, used) } else {
        crate::credits::left(row.allowance_micros, used + pending.max(0) + held.max(0))
    };
    ComplimentaryMonth {
        month: month.to_owned(),
        allowance_micros: row.allowance_micros,
        unlimited: row.unlimited(),
        used_micros: used,
        pending_micros: pending.max(0),
        held_micros: held.max(0),
        remaining_micros: remaining,
        overrun_micros: overrun,
        resets_at: crate::credits::next_month_start(month),
        fee_cents: row.fee_cents.max(0) as u32,
        charge_past_allowance: row.charges_past(),
        has_card,
    }
}

/// The subscription's metadata: the grant and its terms, so Stripe shows
/// what the $0 (or custom) price stands for.
fn metadata_fields(row: &Row) -> Vec<(&'static str, String)> {
    vec![
        ("metadata[workspace]", row.workspace.clone()),
        ("metadata[feature]", "complimentary".to_owned()),
        ("metadata[g1t_grant]", row.grant_id.clone()),
        ("metadata[g1t_allowance_micros]", row.allowance_micros.to_string()),
        ("metadata[g1t_unlimited]", row.unlimited().to_string()),
        ("metadata[g1t_fee_cents]", row.fee_cents.to_string()),
        ("metadata[g1t_past_allowance]", row.overage.clone()),
    ]
}

/// The one item's price: the fee (a $0 price when waived), or the plan's
/// price under the 100% coupon for a fully discounted enrollment.
fn price_fields(row: &Row, product: &str, plan_cents: u32, prefix: &'static str, fully: bool) -> Vec<(String, String)> {
    let amount = if fully { i64::from(plan_cents) } else { row.fee_cents.max(0) };
    vec![
        (format!("{prefix}[price_data][currency]"), "usd".to_owned()),
        (format!("{prefix}[price_data][product]"), product.to_owned()),
        (format!("{prefix}[price_data][unit_amount]"), amount.to_string()),
        (format!("{prefix}[price_data][recurring][interval]"), "month".to_owned()),
        (format!("{prefix}[price_data][tax_behavior]"), "exclusive".to_owned()),
    ]
}

/// A new enrollment's subscription. A fee is invoiced (sent, payable for 30
/// days): negotiated terms are not charged to a card nobody gave. A waived
/// fee has nothing to tax or collect; converting turns both on.
pub(crate) fn create_fields(row: &Row, customer: &str, product: &str, plan_cents: u32, fully: bool) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = vec![("customer".into(), customer.to_owned())];
    fields.extend(price_fields(row, product, plan_cents, "items[0]", fully));
    fields.extend(metadata_fields(row).into_iter().map(|(k, v)| (k.to_owned(), v)));
    fields.push(("description".into(), format!("Complimentary g1t plan for {}", row.workspace)));
    if fully {
        fields.push(("discounts[0][coupon]".into(), FULL_DISCOUNT_COUPON.to_owned()));
    }
    if row.fee_cents > 0 {
        fields.push(("collection_method".into(), "send_invoice".into()));
        fields.push(("days_until_due".into(), "30".into()));
        fields.push(("automatic_tax[enabled]".into(), "true".into()));
    }
    fields
}

/// Whether Stripe shows the conversion done: an owner's conversion is in
/// progress (`converting`), nothing waits on a payment, and the item now has
/// a new price at the plan's amount. A staff terms change also gives the
/// item a new price, so the price alone never counts.
pub(crate) fn converted(price_id: Option<&str>, subscription: &StripeSubscription, plan_cents: u32, converting: bool) -> bool {
    let price = subscription.first_item().and_then(|item| item.price.as_ref());
    converting
        && subscription.pending_update.as_ref().is_none_or(serde_json::Value::is_null)
        && matches!(subscription.status.as_str(), "active" | "trialing")
        && price_id.is_some()
        && price.is_some_and(|p| Some(p.id.as_str()) != price_id && p.unit_amount == Some(i64::from(plan_cents)))
}

fn owned(fields: &[(String, String)]) -> Vec<(&str, String)> {
    fields.iter().map(|(k, v)| (k.as_str(), v.clone())).collect()
}

#[derive(Deserialize)]
struct Sum {
    micros: Option<i64>,
}

impl Billing {
    pub(crate) async fn complimentary_row(&self, workspace: &str) -> Result<Option<Row>> {
        self.db.prepare("SELECT * FROM complimentary WHERE workspace = ?").bind(&[workspace.into()])?.first::<Row>(None).await
    }

    /// The workspace's enrollment, when the workspace has it now.
    pub(crate) async fn complimentary_active(&self, workspace: &str) -> Result<Option<Row>> {
        Ok(self.complimentary_row(workspace).await?.filter(|row| row.status == "active"))
    }

    async fn sum(&self, sql: &str, binds: &[worker::wasm_bindgen::JsValue]) -> Result<i64> {
        Ok(self.db.prepare(sql).bind(binds)?.first::<Sum>(None).await?.and_then(|s| s.micros).unwrap_or(0))
    }

    /// This month's standing of an active enrollment. `held` is what open
    /// reservations hold, when the caller has read it.
    pub(crate) async fn complimentary_month(&self, row: &Row, held: Option<i64>) -> Result<ComplimentaryMonth> {
        let month = crate::credits::month_of(&rfc3339(now_ms()));
        let used = self.allowance_used("complimentary", &row.workspace, &month).await?;
        // Metered this month and not on the ledger yet: the allowance pays
        // for it when the month closes.
        let pending = self
            .sum(
                &format!(
                    "SELECT SUM({}) AS micros FROM pending_usage WHERE workspace = ?1 AND month = ?2 AND charged_at IS NULL",
                    crate::storage::NET_CHARGE
                ),
                &[row.workspace.as_str().into(), month.as_str().into()],
            )
            .await?;
        let held = match held {
            Some(held) => held,
            None => self
                .sum(
                    "SELECT SUM(hold_micros) AS micros FROM reservations WHERE workspace = ?1 AND settled_at IS NULL AND expires_at > ?2",
                    &[row.workspace.as_str().into(), rfc3339(now_ms()).into()],
                )
                .await?,
        };
        let overrun = self
            .sum(
                "SELECT SUM(given_micros) AS micros FROM ledger
                 WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?2 AND given_micros > 0 AND EXISTS (
                   SELECT 1 FROM complimentary_periods p WHERE p.workspace = ?1 AND p.starts_at <= ledger.created_at
                     AND (p.ends_at IS NULL OR p.ends_at > ledger.created_at))",
                &[row.workspace.as_str().into(), format!("{month}-01").into()],
            )
            .await?;
        let has_card = row.charges_past() && self.has_card(&row.workspace).await?;
        Ok(month_standing(&month, row, used, pending, held, overrun, has_card))
    }

    /// Whether the workspace's own terms are a 100% discount: g1t's own.
    async fn internal_terms(&self, workspace: &str) -> Result<bool> {
        Ok(self.account_of(workspace).await?.terms.full_discount())
    }

    /// Whether the workspace has a card to charge: one saved by a card
    /// check, or the customer's default card as last synced from Stripe.
    pub(crate) async fn has_card(&self, workspace: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare(
                "SELECT 1 AS found WHERE EXISTS (SELECT 1 FROM card_checks WHERE workspace = ?1)
                    OR EXISTS (SELECT 1 FROM accounts WHERE workspace = ?1 AND customer_id IS NOT NULL AND card_last4 IS NOT NULL)",
            )
            .bind(&[workspace.into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    async fn complimentary_standing(&self, row: Row) -> Result<ComplimentaryStanding> {
        #[derive(Deserialize)]
        struct PeriodRow {
            id: String,
            starts_at: String,
            ends_at: Option<String>,
            allowance_micros: i64,
            unlimited: i64,
            fee_cents: i64,
            overage: String,
            note: String,
            created_by: String,
        }
        let periods = self
            .db
            .prepare("SELECT * FROM complimentary_periods WHERE workspace = ? ORDER BY starts_at DESC LIMIT 50")
            .bind(&[row.workspace.as_str().into()])?
            .all()
            .await?
            .results::<PeriodRow>()?
            .into_iter()
            .map(|p| ComplimentaryPeriod {
                id: p.id,
                starts_at: p.starts_at,
                ends_at: p.ends_at,
                allowance_micros: p.allowance_micros,
                unlimited: p.unlimited != 0,
                fee_cents: p.fee_cents.max(0) as u32,
                charge_past_allowance: p.overage == "charge",
                note: p.note,
                created_by: p.created_by,
            })
            .collect();
        let w: worker::wasm_bindgen::JsValue = row.workspace.as_str().into();
        // Money in: plan and fee invoices, and top-ups that are payments
        // (card prepayments, bank transfers), never credit from g1t.
        let plans = self.sum("SELECT SUM(amount_micros) AS micros FROM plan_payments WHERE workspace = ?", &[w.clone()]).await?;
        let paid = self
            .sum(
                "SELECT SUM(amount_micros) AS micros FROM ledger WHERE workspace = ? AND kind = 'top_up' AND credit_kind IS NULL AND reference NOT LIKE 'crd%'",
                &[w.clone()],
            )
            .await?;
        let promotional = self
            .sum(
                "SELECT SUM(amount_micros) AS micros FROM ledger WHERE workspace = ? AND kind = 'top_up' AND credit_kind IN ('promotional', 'goodwill')",
                &[w.clone()],
            )
            .await?;
        let gifted = self.sum("SELECT SUM(gift_micros) AS micros FROM ledger WHERE workspace = ? AND kind = 'usage'", &[w]).await?;
        let month = if row.status == "active" { Some(self.complimentary_month(&row, None).await?) } else { None };
        Ok(ComplimentaryStanding {
            workspace: row.workspace.clone(),
            grant_id: row.grant_id.clone(),
            status: row.status.clone(),
            allowance_micros: row.allowance_micros,
            unlimited: row.unlimited(),
            fee_cents: row.fee_cents.max(0) as u32,
            charge_past_allowance: row.charges_past(),
            live: row.live != 0,
            customer_id: row.customer_id.clone(),
            subscription_id: row.subscription_id.clone(),
            stripe_status: row.stripe_status.clone(),
            pending_op: Op::parse(row.pending_op.as_deref()).map(|op| match op {
                Op::Create => "create".to_owned(),
                Op::Terms { .. } => "terms".to_owned(),
                Op::Cancel => "cancel".to_owned(),
                Op::Convert { .. } => "convert".to_owned(),
            }),
            last_error: row.last_error.clone(),
            note: row.note.clone(),
            created_by: row.created_by.clone(),
            created_at: row.created_at.clone(),
            updated_by: row.updated_by.clone(),
            updated_at: row.updated_at.clone(),
            ended_at: row.ended_at.clone(),
            ended_reason: row.ended_reason.clone(),
            month,
            periods,
            money_received_micros: plans + paid,
            promotional_credit_micros: promotional,
            gifted_micros: gifted,
        })
    }

    /// `admin_complimentary`.
    pub(crate) async fn admin_complimentary(&self, a: AdminComplimentaryArgs) -> Result<Option<ComplimentaryStanding>> {
        match self.complimentary_row(&a.workspace.trim().to_lowercase()).await? {
            Some(row) => Ok(Some(self.complimentary_standing(row).await?)),
            None => Ok(None),
        }
    }

    /// `admin_set_complimentary`: enrolls, or changes the terms from now on.
    pub(crate) async fn admin_set_complimentary(&self, a: AdminSetComplimentaryArgs) -> Result<Outcome<ComplimentaryStanding>> {
        if let Some(why) = invalid(&a) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t: an enrollment needs a Stripe subscription."));
        };
        let workspace = a.workspace.trim().to_lowercase();
        let by = a.by.trim();
        let note = a.note.trim();
        let account = self.account_of(&workspace).await?;
        if account.kind == g1t_contracts::billing::AccountKind::Enterprise {
            return Ok(Outcome::fail(FailureCode::Conflict, "An enterprise pays for this workspace. Detach it from the enterprise first."));
        }
        // Never two billable subscriptions: a paid plan ends (or the owner
        // keeps it) before an enrollment starts.
        let paying = self
            .db
            .prepare("SELECT subscription_id FROM subscriptions WHERE workspace = ? AND feature IN ('plan', 'deployments') AND status <> 'canceled' LIMIT 1")
            .bind(&[workspace.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if paying.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "The workspace pays for the g1t plan. Cancel that subscription (or let it end) before enrolling it, so it is never billed twice.",
            ));
        }
        // A plan's payment page still open would start a second subscription.
        let checkout = self
            .db
            .prepare("SELECT id FROM checkouts WHERE workspace = ? AND feature IN ('plan', 'deployments') AND status = 'open' AND created_at > ? LIMIT 1")
            .bind(&[workspace.as_str().into(), rfc3339(now_ms().saturating_sub(KEY_KEPT_MS + 60 * 60 * 1000)).into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if checkout.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "An owner has a payment page open for the g1t plan. Wait for it to finish or expire (a day) before enrolling the workspace.",
            ));
        }
        let now_ms = now_ms();
        let now = rfc3339(now_ms);
        let unlimited = i32::from(a.unlimited);
        let fee = f64::from(a.fee_cents);
        let overage = if a.charge_past_allowance { "charge" } else { "stop" };
        let terms = format!(
            "{} a month, fee {}, past it {}",
            if a.unlimited { "unlimited allowance".to_owned() } else { format!("{} allowance", cents(a.allowance_micros)) },
            if a.fee_cents == 0 { "waived".to_owned() } else { cents(i64::from(a.fee_cents) * 10_000) },
            if a.charge_past_allowance { "charged to their card" } else { "work stops" }
        );
        let existing = self.complimentary_row(&workspace).await?;
        match existing.as_ref().map(|row| row.status.as_str()) {
            None | Some("ended") => {
                // A canceled enrollment whose cancel is still owed at Stripe
                // would be forgotten, still billing: finish it first.
                if existing.as_ref().is_some_and(|row| row.pending_op.is_some()) {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        "The last enrollment's subscription is still being canceled at Stripe; try again once it is (it is retried every fifteen minutes).",
                    ));
                }
                let grant = new_id("cmp", now_ms);
                self.db
                    .prepare(
                        "INSERT INTO complimentary (workspace, grant_id, status, allowance_micros, unlimited, fee_cents, live, pending_op, note,
                                                    created_by, created_at, created_ms, updated_by, updated_at, overage)
                         VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?9, ?10, ?12)
                         ON CONFLICT (workspace) DO UPDATE SET grant_id = ?2, status = 'pending', allowance_micros = ?3, unlimited = ?4,
                           fee_cents = ?5, pending_op = ?7, note = ?8, created_by = ?9, created_at = ?10, created_ms = ?11,
                           updated_by = ?9, updated_at = ?10, overage = ?12, subscription_id = NULL, item_id = NULL, price_id = NULL,
                           stripe_status = NULL, last_error = NULL, ended_at = NULL, ended_reason = NULL, converted_at = NULL,
                           -- A customer of the other Stripe mode is never reused.
                           customer_id = CASE WHEN complimentary.live = ?6 THEN complimentary.customer_id END, live = ?6
                         WHERE complimentary.status = 'ended' AND complimentary.pending_op IS NULL",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        grant.as_str().into(),
                        (a.allowance_micros as f64).into(),
                        unlimited.into(),
                        fee.into(),
                        i32::from(stripe.live()).into(),
                        Op::Create.text().into(),
                        note.into(),
                        by.into(),
                        now.as_str().into(),
                        (now_ms as f64).into(),
                        overage.into(),
                    ])?
                    .run()
                    .await?;
                self.audit(&account.id, "complimentary", &format!("{workspace} enrolled ({grant}): {terms}: {note}"), by).await?;
            }
            Some("pending") => {
                // Not visible yet: its first period takes these terms.
                self.db
                    .prepare(
                        "UPDATE complimentary SET allowance_micros = ?2, unlimited = ?3, fee_cents = ?4, note = ?5, updated_by = ?6, updated_at = ?7,
                           overage = ?8
                         WHERE workspace = ?1 AND status = 'pending'",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        (a.allowance_micros as f64).into(),
                        unlimited.into(),
                        fee.into(),
                        note.into(),
                        by.into(),
                        now.as_str().into(),
                        overage.into(),
                    ])?
                    .run()
                    .await?;
                self.audit(&account.id, "complimentary", &format!("{workspace} pending enrollment changed: {terms}: {note}"), by).await?;
            }
            Some(_) => {
                let row = existing.as_ref().expect("matched an existing row");
                if matches!(Op::parse(row.pending_op.as_deref()), Some(Op::Convert { .. } | Op::Create)) {
                    return Ok(Outcome::fail(FailureCode::Conflict, "The owner is converting this workspace to the plan; wait for that to finish."));
                }
                // One batch: the open period closes and the next opens with
                // the new terms. What this month used stays used.
                let period = new_id("cmpp", now_ms);
                self.db
                    .batch(vec![
                        self.db
                            .prepare("UPDATE complimentary_periods SET ends_at = ?2 WHERE workspace = ?1 AND ends_at IS NULL")
                            .bind(&[workspace.as_str().into(), now.as_str().into()])?,
                        self.db
                            .prepare(
                                "INSERT INTO complimentary_periods (id, workspace, grant_id, starts_at, allowance_micros, unlimited, fee_cents, note, created_by, created_at, overage)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?4, ?10)",
                            )
                            .bind(&[
                                period.as_str().into(),
                                workspace.as_str().into(),
                                row.grant_id.as_str().into(),
                                now.as_str().into(),
                                (a.allowance_micros as f64).into(),
                                unlimited.into(),
                                fee.into(),
                                note.into(),
                                by.into(),
                                overage.into(),
                            ])?,
                        self.db
                            .prepare(
                                "UPDATE complimentary SET allowance_micros = ?2, unlimited = ?3, fee_cents = ?4, note = ?5, updated_by = ?6, updated_at = ?7,
                                   pending_op = ?8, overage = ?9 WHERE workspace = ?1 AND status = 'active'",
                            )
                            .bind(&[
                                workspace.as_str().into(),
                                (a.allowance_micros as f64).into(),
                                unlimited.into(),
                                fee.into(),
                                note.into(),
                                by.into(),
                                now.as_str().into(),
                                Op::Terms { period: period.clone() }.text().into(),
                                overage.into(),
                            ])?,
                    ])
                    .await?;
                self.audit(
                    &account.id,
                    "complimentary",
                    &format!(
                        "{workspace} terms changed from {} allowance, fee {} to {terms}: {note}",
                        if row.unlimited() { "unlimited".to_owned() } else { cents(row.allowance_micros) },
                        cents(row.fee_cents * 10_000)
                    ),
                    by,
                )
                .await?;
            }
        }
        self.drive_logged(&workspace).await;
        match self.complimentary_row(&workspace).await? {
            Some(row) => Ok(Outcome::Ok(self.complimentary_standing(row).await?)),
            None => Ok(Outcome::fail(FailureCode::NotFound, "The enrollment was not saved.")),
        }
    }

    /// `admin_end_complimentary`: the workspace goes back to Free now.
    pub(crate) async fn admin_end_complimentary(&self, a: AdminEndComplimentaryArgs) -> Result<Outcome<ComplimentaryStanding>> {
        let workspace = a.workspace.trim().to_lowercase();
        if a.note.trim().len() < 3 || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why, in a few words: it goes in the audit log."));
        }
        let Some(row) = self.complimentary_row(&workspace).await?.filter(|row| row.status != "ended") else {
            return Ok(Outcome::fail(FailureCode::NotFound, "The workspace has no enrollment to end."));
        };
        if matches!(Op::parse(row.pending_op.as_deref()), Some(Op::Convert { .. })) {
            return Ok(Outcome::fail(FailureCode::Conflict, "The owner is converting this workspace to the plan; wait for that to finish."));
        }
        self.end(&row, "revoked", a.by.trim(), a.note.trim()).await?;
        self.drive_logged(&workspace).await;
        match self.complimentary_row(&workspace).await? {
            Some(row) => Ok(Outcome::Ok(self.complimentary_standing(row).await?)),
            None => Ok(Outcome::fail(FailureCode::NotFound, "The enrollment is gone.")),
        }
    }

    /// Ends an enrollment: month-end usage so far is put on the ledger
    /// under the allowance, the open period closes, and the subscription is
    /// canceled (revoked) or left to the plan (converted).
    async fn end(&self, row: &Row, reason: &str, by: &str, note: &str) -> Result<()> {
        let now_ms = now_ms();
        let now = rfc3339(now_ms);
        if row.status == "active" {
            self.post_pending_under_allowance(row, now_ms).await?;
        }
        let op = if reason == "revoked" && (row.subscription_id.is_some() || row.status == "pending") { Some(Op::Cancel.text()) } else { None };
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE complimentary_periods SET ends_at = ?2 WHERE workspace = ?1 AND ends_at IS NULL")
                    .bind(&[row.workspace.as_str().into(), now.as_str().into()])?,
                self.db
                    .prepare(
                        "UPDATE complimentary SET status = 'ended', ended_at = ?2, ended_reason = ?3, pending_op = ?4, updated_by = ?5, updated_at = ?2,
                           converted_at = CASE WHEN ?3 = 'converted' THEN ?2 END
                         WHERE workspace = ?1 AND grant_id = ?6 AND status <> 'ended'",
                    )
                    .bind(&[
                        row.workspace.as_str().into(),
                        now.as_str().into(),
                        reason.into(),
                        crate::optional(op.as_deref()),
                        by.into(),
                        row.grant_id.as_str().into(),
                    ])?,
            ])
            .await?;
        let account = self.account_of(&row.workspace).await?;
        self.audit(&account.id, "complimentary", &format!("{} enrollment {} ended ({reason}): {note}", row.workspace, row.grant_id), by).await
    }

    /// Month-end meters (storage, git operations…) run up so far this month
    /// go on the ledger now, timed just before the period closes, so the
    /// allowance pays for them as it would have at the close. The month's
    /// later charge takes only what is metered after (`pending_baselines`).
    /// Never charges usage gifted while enrolled.
    async fn post_pending_under_allowance(&self, row: &Row, now_ms: u64) -> Result<()> {
        #[derive(Deserialize)]
        struct Pending {
            source: String,
            month: String,
            cost_micros: Option<i64>,
            raw_cost: Option<i64>,
            raw_charge: Option<i64>,
        }
        let at = rfc3339(now_ms.saturating_sub(1));
        let month = crate::credits::month_of(&at);
        let marks = crate::storage::CHARGED_HERE.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ");
        let rows = self
            .db
            .prepare(format!(
                "SELECT source, month, {} AS cost_micros, cost_micros AS raw_cost, charge_micros AS raw_charge FROM pending_usage
                 WHERE workspace = ?1 AND month = ?2 AND charged_at IS NULL AND source IN ({marks})",
                crate::storage::NET_COST
            ))
            .bind(&[row.workspace.as_str().into(), month.as_str().into()])?
            .all()
            .await?
            .results::<Pending>()?;
        for pending in rows {
            let cost = pending.cost_micros.unwrap_or(0);
            // The baseline moves to exactly the figure posted here, read
            // above: a report landing meanwhile stays past it, charged at the
            // month's close. An empty row still marks where the next starts.
            let baseline = self
                .db
                .prepare(
                    "INSERT INTO pending_baselines (workspace, source, month, cost_micros, charge_micros, created_at)
                     VALUES (?1, ?2, ?3, ?5, ?6, ?4)
                     ON CONFLICT (workspace, source, month) DO UPDATE SET
                       cost_micros = MAX(pending_baselines.cost_micros, excluded.cost_micros),
                       charge_micros = MAX(pending_baselines.charge_micros, excluded.charge_micros), created_at = excluded.created_at",
                )
                .bind(&[
                    row.workspace.as_str().into(),
                    pending.source.as_str().into(),
                    pending.month.as_str().into(),
                    at.as_str().into(),
                    (pending.raw_cost.unwrap_or(0) as f64).into(),
                    (pending.raw_charge.unwrap_or(0) as f64).into(),
                ])?;
            if cost <= 0 {
                baseline.run().await?;
                continue;
            }
            let base = crate::credits::with_margin(cost, self.margin_percent);
            let (charge, terms_note, discount) = self.charged(&row.workspace, base).await?;
            let description = format!(
                "{} in {} while enrolled{terms_note}",
                crate::storage::title(&pending.source),
                pending.month
            );
            let reference = format!("{}/{}/{}/{}", pending.source, row.workspace, pending.month, row.grant_id);
            let eligible = crate::credits::Eligible::default();
            let line = crate::storage::UsageLine {
                workspace: &row.workspace,
                charged: charge,
                description: &description,
                repo: None,
                task: &pending.source,
                cost,
                reference: &reference,
                created_at: &at,
                drawn: crate::credits::Drawn::default(),
            };
            if self.post_usage_with(line, vec![baseline], Some((&pending.month, &eligible, false))).await? {
                self.record_discount(&reference, discount).await?;
            }
        }
        Ok(())
    }

    /// Runs the workspace's owed Stripe step, writing down an error for sudo
    /// rather than failing the change staff made.
    async fn drive_logged(&self, workspace: &str) {
        if let Err(error) = self.drive(workspace).await {
            worker::console_error!("{workspace}: complimentary Stripe step failed; tried again next tick: {error}");
            let noted = match self.db.prepare("UPDATE complimentary SET last_error = ?2 WHERE workspace = ?1")
                .bind(&[workspace.into(), crate::stripe::friendly(&error).into()]) {
                Ok(statement) => statement.run().await.map(|_| ()),
                Err(error) => Err(error),
            };
            if let Err(error) = noted {
                worker::console_error!("{workspace}: could not note the error: {error}");
            }
        }
    }

    /// The fifteen-minute tick: every enrollment with a Stripe step owed.
    pub(crate) async fn complimentary_tick(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Owed {
            workspace: String,
        }
        let owed = self
            .db
            .prepare("SELECT workspace FROM complimentary WHERE pending_op IS NOT NULL ORDER BY updated_at LIMIT ?")
            .bind(&[TICK_BATCH.into()])?
            .all()
            .await?
            .results::<Owed>()?;
        for row in owed {
            if let Err(error) = self.drive(&row.workspace).await {
                worker::console_error!("{}: complimentary Stripe step failed: {error}", row.workspace);
                self.db
                    .prepare("UPDATE complimentary SET last_error = ?2 WHERE workspace = ?1")
                    .bind(&[row.workspace.as_str().into(), crate::stripe::friendly(&error).into()])?
                    .run()
                    .await?;
            }
        }
        Ok(())
    }

    /// Does the owed Stripe step, if any.
    async fn drive(&self, workspace: &str) -> Result<()> {
        let Some(stripe) = &self.stripe else { return Ok(()) };
        let Some(row) = self.complimentary_row(workspace).await? else { return Ok(()) };
        let Some(op) = Op::parse(row.pending_op.as_deref()) else { return Ok(()) };
        // Test objects are never carried into live mode, nor the reverse.
        if (row.live != 0) != stripe.live() && (row.subscription_id.is_some() || row.customer_id.is_some()) {
            return Err(worker::Error::RustError(format!(
                "this enrollment's Stripe objects are {}-mode and billing now uses a {}-mode key: end it and enroll again",
                if row.live != 0 { "live" } else { "test" },
                if stripe.live() { "live" } else { "test" }
            )));
        }
        match op {
            Op::Create => self.drive_create(stripe, &row).await,
            Op::Terms { period } => self.drive_terms(stripe, &row, &period).await,
            Op::Cancel => self.drive_cancel(stripe, &row).await,
            // A conversion moves on when its payment does: the webhook or
            // the owner's next look settles it (`settle_complimentary`).
            Op::Convert { started_ms, .. } => {
                if let Some(id) = &row.subscription_id {
                    self.settle_complimentary(id).await?;
                }
                // A conversion Stripe gave up on (its pending update expires
                // after 23 hours) stops waiting, and the enrollment stands.
                let fresh = self.complimentary_row(workspace).await?;
                if now_ms().saturating_sub(started_ms) > 2 * KEY_KEPT_MS && fresh.as_ref().is_some_and(|r| r.status == "active") {
                    // Preparing it charged the subscription automatically; a
                    // fee goes back to being invoiced.
                    if let (true, Some(id)) = (row.fee_cents > 0, &row.subscription_id) {
                        let _: serde_json::Value = stripe
                            .post_idempotent(
                                &format!("/subscriptions/{id}"),
                                &[("collection_method", "send_invoice".to_owned()), ("days_until_due", "30".to_owned())],
                                &format!("cmp/{}/convert/{started_ms}/undo", row.grant_id),
                            )
                            .await?;
                    }
                    self.db
                        .prepare("UPDATE complimentary SET pending_op = NULL WHERE workspace = ?1 AND pending_op = ?2 AND status = 'active'")
                        .bind(&[row.workspace.as_str().into(), row.pending_op.clone().unwrap_or_default().into()])?
                        .run()
                        .await?;
                }
                Ok(())
            }
        }
    }

    /// The customer for an enrollment: the workspace's own, or one made
    /// under the grant's key.
    async fn enrollment_customer(&self, stripe: &Stripe, row: &Row) -> Result<String> {
        if let Some(customer) = &row.customer_id {
            return Ok(customer.clone());
        }
        let existing = self.row(&row.workspace).await?.and_then(|account| account.customer_id);
        let customer = match existing {
            Some(customer) => customer,
            None => {
                let old = now_ms().saturating_sub(row.created_ms.max(0) as u64) > KEY_KEPT_MS;
                let found = if old {
                    let query = crate::stripe::form(&[("query", format!("metadata['g1t_grant']:'{}'", row.grant_id))]);
                    let list: serde_json::Value = stripe.get(&format!("/customers/search?{query}")).await?;
                    list["data"].as_array().and_then(|d| d.first()).and_then(|c| c["id"].as_str()).map(str::to_owned)
                } else {
                    None
                };
                match found {
                    Some(customer) => customer,
                    // Search sees a customer within about a minute; a day
                    // later, none found means none was made.
                    None => {
                        let email = self.owner_email(&row.workspace).await;
                        let mut fields = crate::stripe::customer_fields(&row.workspace, email.as_deref());
                        fields.push(("metadata[g1t_grant]", row.grant_id.clone()));
                        #[derive(Deserialize)]
                        struct Customer {
                            id: String,
                        }
                        let key = if old { format!("cmp/{}/customer/late", row.grant_id) } else { format!("cmp/{}/customer", row.grant_id) };
                        let made: Customer = stripe.post_idempotent("/customers", &fields, &key).await?;
                        made.id
                    }
                }
            }
        };
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE complimentary SET customer_id = ?2 WHERE workspace = ?1 AND grant_id = ?3")
                    .bind(&[row.workspace.as_str().into(), customer.as_str().into(), row.grant_id.as_str().into()])?,
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at) VALUES (?1, 0, ?2, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET customer_id = COALESCE(customer_id, ?2)",
                    )
                    .bind(&[row.workspace.as_str().into(), customer.as_str().into(), rfc3339(now_ms()).into()])?,
            ])
            .await?;
        Ok(customer)
    }

    /// The 100% coupon, made once under its own id.
    async fn ensure_coupon(&self, stripe: &Stripe) -> Result<()> {
        match stripe.get::<serde_json::Value>(&format!("/coupons/{FULL_DISCOUNT_COUPON}")).await {
            Ok(_) => Ok(()),
            Err(error) if is_missing(&error) => {
                let _: serde_json::Value = stripe
                    .post_idempotent(
                        "/coupons",
                        &[
                            ("id", FULL_DISCOUNT_COUPON.to_owned()),
                            ("percent_off", "100".to_owned()),
                            ("duration", "forever".to_owned()),
                            ("name", "g1t complimentary (100%)".to_owned()),
                        ],
                        &format!("coupon/{FULL_DISCOUNT_COUPON}"),
                    )
                    .await?;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// A subscription Stripe already has for the grant, found by its
    /// metadata: what an ambiguous creation made.
    async fn grant_subscription(&self, stripe: &Stripe, customer: &str, grant: &str) -> Result<Option<StripeSubscription>> {
        #[derive(Deserialize)]
        struct List {
            data: Vec<StripeSubscription>,
        }
        let query = crate::stripe::form(&[("customer", customer.to_owned()), ("status", "all".to_owned()), ("limit", "100".to_owned())]);
        let list: List = stripe.get(&format!("/subscriptions?{query}")).await?;
        Ok(list
            .data
            .into_iter()
            .find(|s| s.metadata.as_ref().and_then(|m| m.get("g1t_grant")).map(String::as_str) == Some(grant) && s.status != "canceled"))
    }

    async fn drive_create(&self, stripe: &Stripe, row: &Row) -> Result<()> {
        if row.status != "pending" {
            return self.clear_op(row, &Op::Create).await;
        }
        let customer = self.enrollment_customer(stripe, row).await?;
        let old = now_ms().saturating_sub(row.created_ms.max(0) as u64) > KEY_KEPT_MS;
        let found = if old { self.grant_subscription(stripe, &customer, &row.grant_id).await? } else { None };
        let subscription = match found {
            Some(subscription) => subscription,
            // Older than the key and nothing found: making it now is safe,
            // as the search above saw none.
            None => {
                let fully = fully_discounted(row, self.internal_terms(&row.workspace).await?);
                if fully {
                    self.ensure_coupon(stripe).await?;
                }
                let product = stripe.product(Feature::Plan.as_str(), &format!("{} plan", Feature::Plan.title())).await?;
                let fields = create_fields(row, &customer, &product, self.plans.plan_monthly_cents, fully);
                let key = if old { format!("cmp/{}/subscription/late", row.grant_id) } else { format!("cmp/{}/subscription", row.grant_id) };
                stripe.post_idempotent("/subscriptions", &owned(&fields), &key).await?
            }
        };
        let item = subscription.first_item();
        let item_id = item.and_then(|i| i.id.clone());
        let price_id = item.and_then(|i| i.price.as_ref()).map(|p| p.id.clone());
        let now = rfc3339(now_ms());
        let period = new_id("cmpp", now_ms());
        // Stripe has it: the workspace sees the enrollment from now, with
        // its first period, in one batch.
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE complimentary SET status = 'active', subscription_id = ?2, item_id = ?3, price_id = ?4, stripe_status = ?5,
                           pending_op = NULL, last_error = NULL, updated_at = ?6
                         WHERE workspace = ?1 AND grant_id = ?7 AND status = 'pending'",
                    )
                    .bind(&[
                        row.workspace.as_str().into(),
                        subscription.id.as_str().into(),
                        crate::optional(item_id.as_deref()),
                        crate::optional(price_id.as_deref()),
                        subscription.status.as_str().into(),
                        now.as_str().into(),
                        row.grant_id.as_str().into(),
                    ])?,
                self.db
                    .prepare(
                        "INSERT INTO complimentary_periods (id, workspace, grant_id, starts_at, allowance_micros, unlimited, fee_cents, note, created_by, created_at, overage)
                         SELECT ?1, workspace, grant_id, ?2, allowance_micros, unlimited, fee_cents, note, updated_by, ?2, overage
                           FROM complimentary WHERE workspace = ?3 AND grant_id = ?4 AND status = 'active' AND subscription_id = ?5
                            AND NOT EXISTS (SELECT 1 FROM complimentary_periods WHERE workspace = ?3 AND ends_at IS NULL)",
                    )
                    .bind(&[period.as_str().into(), now.as_str().into(), row.workspace.as_str().into(), row.grant_id.as_str().into(), subscription.id.as_str().into()])?,
            ])
            .await?;
        Ok(())
    }

    async fn drive_terms(&self, stripe: &Stripe, row: &Row, period: &str) -> Result<()> {
        let (Some(subscription), Some(item)) = (&row.subscription_id, &row.item_id) else {
            return self.clear_op(row, &Op::Terms { period: period.to_owned() }).await;
        };
        let fully = fully_discounted(row, self.internal_terms(&row.workspace).await?);
        if fully {
            self.ensure_coupon(stripe).await?;
        }
        let product = stripe.product(Feature::Plan.as_str(), &format!("{} plan", Feature::Plan.title())).await?;
        let mut fields: Vec<(String, String)> = vec![("items[0][id]".into(), item.clone()), ("proration_behavior".into(), "none".into())];
        fields.extend(price_fields(row, &product, self.plans.plan_monthly_cents, "items[0]", fully));
        fields.extend(metadata_fields(row).into_iter().map(|(k, v)| (k.to_owned(), v)));
        if fully {
            fields.push(("discounts[0][coupon]".into(), FULL_DISCOUNT_COUPON.to_owned()));
        } else {
            fields.push(("discounts".into(), String::new()));
        }
        // A fee is invoiced; with none there is nothing to collect, and
        // converting needs automatic collection.
        if row.fee_cents > 0 {
            fields.push(("collection_method".into(), "send_invoice".into()));
            fields.push(("days_until_due".into(), "30".into()));
        } else {
            fields.push(("collection_method".into(), "charge_automatically".into()));
        }
        let updated: StripeSubscription = stripe
            .post_idempotent(&format!("/subscriptions/{subscription}"), &owned(&fields), &format!("cmp/{}/terms/{period}", row.grant_id))
            .await?;
        let price_id = updated.first_item().and_then(|i| i.price.as_ref()).map(|p| p.id.clone());
        self.db
            .prepare(
                "UPDATE complimentary SET price_id = ?2, stripe_status = ?3, pending_op = NULL, last_error = NULL
                 WHERE workspace = ?1 AND pending_op = ?4",
            )
            .bind(&[
                row.workspace.as_str().into(),
                crate::optional(price_id.as_deref()),
                updated.status.as_str().into(),
                Op::Terms { period: period.to_owned() }.text().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    async fn drive_cancel(&self, stripe: &Stripe, row: &Row) -> Result<()> {
        // A creation that may have happened is looked for first.
        let subscription = match (&row.subscription_id, &row.customer_id) {
            (Some(id), _) => Some(id.clone()),
            (None, Some(customer)) => self.grant_subscription(stripe, customer, &row.grant_id).await?.map(|s| s.id),
            (None, None) => None,
        };
        if let Some(id) = &subscription {
            match stripe.cancel_now(id).await {
                Ok(_) => {}
                Err(error) if is_missing(&error) || error.to_string().contains("canceled subscription") => {}
                Err(error) => return Err(error),
            }
        } else if row.status == "pending" && now_ms().saturating_sub(row.created_ms.max(0) as u64) <= KEY_KEPT_MS {
            // A creation may still land under its key: make it now so it can
            // be canceled, rather than leave one behind.
            if row.customer_id.is_some() {
                return Err(worker::Error::RustError("waiting for Stripe to show the enrollment's subscription before canceling it".into()));
            }
        }
        self.db
            .prepare("UPDATE complimentary SET stripe_status = 'canceled', pending_op = NULL, last_error = NULL WHERE workspace = ?1 AND pending_op = ?2")
            .bind(&[row.workspace.as_str().into(), Op::Cancel.text().into()])?
            .run()
            .await?;
        Ok(())
    }

    async fn clear_op(&self, row: &Row, op: &Op) -> Result<()> {
        self.db
            .prepare("UPDATE complimentary SET pending_op = NULL WHERE workspace = ?1 AND pending_op = ?2")
            .bind(&[row.workspace.as_str().into(), op.text().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A Stripe change to an enrollment's subscription: renewed, paid,
    /// canceled at Stripe, or converted to the plan. None when the
    /// subscription is no enrollment's.
    pub(crate) async fn settle_complimentary(&self, subscription_id: &str) -> Result<Option<String>> {
        let Some(row) = self
            .db
            .prepare("SELECT * FROM complimentary WHERE subscription_id = ?")
            .bind(&[subscription_id.into()])?
            .first::<Row>(None)
            .await?
        else {
            return Ok(None);
        };
        let Some(stripe) = &self.stripe else { return Ok(Some("ignored: payments off".into())) };
        let subscription = match stripe.subscription(subscription_id).await {
            Ok(subscription) => subscription,
            Err(error) if is_missing(&error) => {
                if row.status == "active" {
                    self.end(&row, "revoked", "stripe", "its subscription is gone at Stripe").await?;
                }
                return Ok(Some(format!("{}: enrollment's subscription is gone at Stripe", row.workspace)));
            }
            Err(error) => return Err(error),
        };
        // Converting: an owner's attempt in progress, or (with no staff change
        // in flight) the plan's price on an enrollment whose own price
        // differs from it, which only a conversion puts there.
        let converting = match Op::parse(row.pending_op.as_deref()) {
            Some(Op::Convert { .. }) => true,
            None => row.fee_cents != i64::from(self.plans.plan_monthly_cents) && !self.internal_terms(&row.workspace).await?,
            _ => false,
        };
        if row.status == "active" && converted(row.price_id.as_deref(), &subscription, self.plans.plan_monthly_cents, converting) {
            let by = match Op::parse(row.pending_op.as_deref()) {
                Some(Op::Convert { by, .. }) => by,
                _ => "stripe".to_owned(),
            };
            self.finish_conversion(&row, &subscription, &by).await?;
            return Ok(Some(format!("{} converted to the plan", row.workspace)));
        }
        self.db
            .prepare("UPDATE complimentary SET stripe_status = ?2 WHERE workspace = ?1")
            .bind(&[row.workspace.as_str().into(), subscription.status.as_str().into()])?
            .run()
            .await?;
        // Canceled (or unpaid) at Stripe: the enrollment ends with it.
        if row.status == "active" && matches!(subscription.status.as_str(), "canceled" | "incomplete_expired" | "unpaid") {
            self.end(&row, "revoked", "stripe", &format!("its subscription is {} at Stripe", subscription.status)).await?;
            return Ok(Some(format!("{}: enrollment ended, subscription {}", row.workspace, subscription.status)));
        }
        Ok(Some(format!("{}: enrollment subscription is {}", row.workspace, subscription.status)))
    }

    /// The conversion done at Stripe: the enrollment ends, the same
    /// subscription becomes the workspace's plan, and its first invoice is
    /// the plan's payment.
    async fn finish_conversion(&self, row: &Row, subscription: &StripeSubscription, by: &str) -> Result<()> {
        self.end(row, "converted", by, "the owner started the g1t plan").await?;
        self.record(&row.workspace, Feature::Plan, subscription, by).await?;
        // Best effort: Stripe's view of what the subscription is now.
        if let Some(stripe) = &self.stripe {
            let _ = stripe
                .post::<serde_json::Value>(
                    &format!("/subscriptions/{}", subscription.id),
                    &[("metadata[feature]", "plan".to_owned()), ("metadata[g1t_converted_from]", row.grant_id.clone())],
                )
                .await;
        }
        Ok(())
    }

    /// `convert_to_paid`.
    pub(crate) async fn convert_to_paid(&self, a: ConvertToPaidArgs) -> Result<Outcome<Conversion>> {
        let workspace = a.workspace.trim().to_lowercase();
        if !a.actor.manages_billing(&workspace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner or a billing manager can start the g1t plan."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        let Some(row) = self.complimentary_active(&workspace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "The workspace has no complimentary enrollment to convert."));
        };
        if fully_discounted(&row, self.internal_terms(&workspace).await?) {
            return Ok(Outcome::fail(FailureCode::Conflict, "This enrollment is g1t's own and is not converted."));
        }
        let (Some(subscription_id), Some(item), Some(customer)) = (row.subscription_id.clone(), row.item_id.clone(), row.customer_id.clone()) else {
            return Ok(Outcome::fail(FailureCode::Conflict, "The enrollment's Stripe subscription is not set up yet; try again in a few minutes."));
        };
        // Where the subscription stands now decides: converted already, or
        // a payment waiting on the bank, is answered, never started again.
        let current = stripe.subscription(&subscription_id).await?;
        let converting = matches!(Op::parse(row.pending_op.as_deref()), Some(Op::Convert { .. }));
        if converted(row.price_id.as_deref(), &current, self.plans.plan_monthly_cents, converting) {
            self.finish_conversion(&row, &current, &a.actor.username).await?;
            return Ok(Outcome::Ok(Conversion { status: "converted".into(), url: None, message: "The g1t plan is on.".into() }));
        }
        let attempt = match Op::parse(row.pending_op.as_deref()) {
            Some(Op::Convert { attempt, .. }) => {
                if current.pending_update.as_ref().is_some_and(|p| !p.is_null()) {
                    return self.waiting(stripe, &current).await;
                }
                attempt + 1
            }
            Some(_) => {
                return Ok(Outcome::fail(FailureCode::Conflict, "g1t is still updating this enrollment at Stripe; try again in a few minutes."));
            }
            None => 1,
        };
        // A card to charge, with its billing address for tax: none yet, the
        // card check page asks for both and charges nothing.
        let saved = stripe.default_payment_method(&customer).await?;
        let Some(saved) = saved else {
            return self.needs_card(&a, "Add a card to start the plan; nothing is charged until you confirm.").await;
        };
        stripe.set_default_card(&customer, &saved.id).await?;
        // Durable before Stripe is asked: a crash after this is picked up
        // with the same attempt and key.
        let started_ms = now_ms();
        let op = Op::Convert { attempt, by: a.actor.username.clone(), started_ms };
        let claimed = self
            .db
            .prepare(
                "UPDATE complimentary SET pending_op = ?2, updated_at = ?3
                 WHERE workspace = ?1 AND status = 'active' AND (pending_op IS NULL OR pending_op LIKE '{\"op\":\"convert\"%')
                 RETURNING workspace",
            )
            .bind(&[workspace.as_str().into(), op.text().into(), rfc3339(now_ms()).into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "g1t is still updating this enrollment at Stripe; try again in a few minutes."));
        }
        // Charged automatically from now, taxed: both change nothing on a
        // $0 subscription, and neither can wait on a payment.
        let prepared = stripe
            .post_idempotent::<serde_json::Value>(
                &format!("/subscriptions/{subscription_id}"),
                &[("collection_method", "charge_automatically".to_owned()), ("automatic_tax[enabled]", "true".to_owned())],
                &format!("cmp/{}/convert/{attempt}/{started_ms}/prepare", row.grant_id),
            )
            .await;
        if let Err(error) = prepared {
            worker::console_error!("{workspace}: preparing the conversion failed: {error}");
            self.clear_op(&row, &op).await?;
            if crate::stripe::is_tax_location_error(&error) {
                return self.needs_card(&a, "Add your billing address with a card so tax can be worked out; nothing is charged until you confirm.").await;
            }
            return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error)));
        }
        let product = stripe.product(Feature::Plan.as_str(), &format!("{} plan", Feature::Plan.title())).await?;
        let fields = conversion_fields(&item, &product, self.plans.plan_monthly_cents);
        let changed: std::result::Result<StripeSubscription, _> = stripe
            .post_idempotent(
                &format!("/subscriptions/{subscription_id}"),
                &owned(&fields),
                &format!("cmp/{}/convert/{attempt}/{started_ms}", row.grant_id),
            )
            .await;
        let changed = match changed {
            Ok(changed) => changed,
            Err(error) => {
                worker::console_error!("{workspace}: converting to the plan failed: {error}");
                // A definite refusal with nothing waiting at Stripe leaves
                // nothing pending; a pending update (its invoice can still
                // be paid for 23 hours) or anything else is settled later.
                let refused = crate::invoices::is_decline(&error.to_string()) || error.to_string().contains("answered 400");
                let waiting = stripe.subscription(&subscription_id).await.map_or(true, |s| s.pending_update.as_ref().is_some_and(|p| !p.is_null()));
                if refused && !waiting {
                    self.clear_op(&row, &op).await?;
                }
                return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error)));
            }
        };
        if converted(row.price_id.as_deref(), &changed, self.plans.plan_monthly_cents, true) {
            self.finish_conversion(&row, &changed, &a.actor.username).await?;
            return Ok(Outcome::Ok(Conversion { status: "converted".into(), url: None, message: "The g1t plan is on.".into() }));
        }
        self.waiting(stripe, &changed).await
    }

    /// A conversion waiting on its first payment: where to finish it.
    async fn waiting(&self, stripe: &Stripe, subscription: &StripeSubscription) -> Result<Outcome<Conversion>> {
        let invoice: Option<serde_json::Value> = match &subscription.latest_invoice {
            Some(id) => Some(stripe.get(&format!("/invoices/{id}?expand[]=payment_intent")).await?),
            None => None,
        };
        let url = invoice.as_ref().and_then(|i| i["hosted_invoice_url"].as_str()).map(str::to_owned);
        let intent = invoice.as_ref().and_then(|i| i["payment_intent"]["status"].as_str()).unwrap_or_default().to_owned();
        Ok(Outcome::Ok(if intent == "requires_action" {
            Conversion {
                status: "needs_action".into(),
                url,
                message: "Your bank wants to confirm the payment. Finish it on Stripe's page; the plan starts once it is paid, and nothing changes until then.".into(),
            }
        } else {
            Conversion {
                status: "declined".into(),
                url,
                message: "The card was declined, so nothing changed: the complimentary terms stand. Pay with another card on Stripe's page to start the plan.".into(),
            }
        }))
    }

    async fn needs_card(&self, a: &ConvertToPaidArgs, message: &str) -> Result<Outcome<Conversion>> {
        let page = self
            .card_check(CardCheckArgs { actor: a.actor.clone(), workspace: a.workspace.clone(), return_url: a.return_url.clone() })
            .await?;
        Ok(match page {
            Outcome::Ok(checkout) => Outcome::Ok(Conversion { status: "needs_card".into(), url: Some(checkout.url), message: message.to_owned() }),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

}

/// The conversion itself: the one item to the plan's price, a new cycle
/// from now, charged at once, applied only if the payment succeeds.
pub(crate) fn conversion_fields(item: &str, product: &str, plan_cents: u32) -> Vec<(String, String)> {
    vec![
        ("items[0][id]".into(), item.to_owned()),
        ("items[0][price_data][currency]".into(), "usd".into()),
        ("items[0][price_data][product]".into(), product.to_owned()),
        ("items[0][price_data][unit_amount]".into(), plan_cents.to_string()),
        ("items[0][price_data][recurring][interval]".into(), "month".into()),
        ("items[0][price_data][tax_behavior]".into(), "exclusive".into()),
        ("payment_behavior".into(), "pending_if_incomplete".into()),
        ("proration_behavior".into(), "always_invoice".into()),
        ("billing_cycle_anchor".into(), "now".into()),
    ]
}

/// Where this month stands against the allowance, from 50%: used, metered
/// and held together, as admission counts them.
pub(crate) fn alert(workspace: &str, month: &ComplimentaryMonth) -> Option<UsageAlert> {
    if month.unlimited || month.allowance_micros <= 0 {
        return None;
    }
    let taken = month.used_micros + month.pending_micros + month.held_micros;
    let level = crate::limits::alert_level(taken, month.allowance_micros);
    (level > 0).then(|| UsageAlert {
        meter: "complimentary".into(),
        level,
        used_micros: taken,
        limit_micros: month.allowance_micros,
        message: if level >= 100 && month.charge_past_allowance {
            format!(
                "{workspace} has used all of this month's {} complimentary allowance. Usage from here is charged to the workspace's card at the usual prices, up to its spend limit{}.",
                dollars(month.allowance_micros),
                if month.has_card { "" } else { "; add a card on Billing to keep going" }
            )
        } else if level >= 100 {
            format!(
                "{workspace} has used all of this month's {} complimentary allowance. New work that costs money starts again on {}; an owner can start the g1t plan to keep going now.",
                dollars(month.allowance_micros),
                &month.resets_at[..10]
            )
        } else if month.charge_past_allowance {
            format!(
                "{workspace} has used {} of this month's {} complimentary allowance ({level}%). Past it, usage is charged to the workspace's card at the usual prices.",
                dollars(taken),
                dollars(month.allowance_micros)
            )
        } else {
            format!(
                "{workspace} has used {} of this month's {} complimentary allowance ({level}%). Past it, new work that costs money stops until {}; nothing is ever charged for it.",
                dollars(taken),
                dollars(month.allowance_micros),
                &month.resets_at[..10]
            )
        },
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn row(allowance: i64, unlimited: bool, fee: i64) -> Row {
        Row {
            workspace: "acme".into(),
            grant_id: "cmp_1".into(),
            status: "active".into(),
            allowance_micros: allowance,
            unlimited: i64::from(unlimited),
            fee_cents: fee,
            overage: "stop".into(),
            live: 0,
            customer_id: Some("cus_1".into()),
            subscription_id: Some("sub_1".into()),
            item_id: Some("si_1".into()),
            price_id: Some("price_comp".into()),
            stripe_status: Some("active".into()),
            pending_op: None,
            last_error: None,
            note: "partner".into(),
            created_by: "staff".into(),
            created_at: "2026-10-01T00:00:00.000Z".into(),
            created_ms: 0,
            updated_by: "staff".into(),
            updated_at: "2026-10-01T00:00:00.000Z".into(),
            ended_at: None,
            ended_reason: None,
        }
    }

    fn args(allowance: i64, unlimited: bool, fee: u32) -> AdminSetComplimentaryArgs {
        AdminSetComplimentaryArgs {
            workspace: "acme".into(),
            allowance_micros: allowance,
            unlimited,
            fee_cents: fee,
            charge_past_allowance: false,
            note: "partner deal".into(),
            by: "staff".into(),
        }
    }

    #[test]
    fn staff_terms_are_bounded_and_say_why() {
        assert!(invalid(&args(100_000_000, false, 0)).is_none());
        assert!(invalid(&args(500_000_000, false, 5_000)).is_none());
        assert!(invalid(&args(0, true, 0)).is_none());
        assert!(invalid(&args(0, false, 2_500)).is_none(), "a fee alone is custom terms");
        assert!(invalid(&args(0, false, 0)).unwrap().contains("gives nothing"));
        assert!(invalid(&args(-1, false, 0)).is_some());
        assert!(invalid(&args(MAX_COMPLIMENTARY_MICROS + 1, false, 0)).unwrap().contains("unlimited"));
        assert!(invalid(&args(1, false, MAX_COMPLIMENTARY_FEE_CENTS + 1)).is_some());
        let mut quiet = args(1, false, 0);
        quiet.note = " ".into();
        assert!(invalid(&quiet).unwrap().contains("why"));
    }

    #[test]
    fn remaining_counts_used_pending_and_held_and_never_goes_below_nothing() {
        let r = row(100_000_000, false, 0);
        let m = month_standing("2026-10", &r, 60_000_000, 25_000_000, 10_000_000, 0, false);
        assert_eq!(m.remaining_micros, 5_000_000);
        assert_eq!(m.resets_at, "2026-11-01T00:00:00Z");
        // Lowered below what was used: nothing left, never a debt.
        let lowered = row(50_000_000, false, 0);
        assert_eq!(month_standing("2026-10", &lowered, 60_000_000, 0, 0, 0, false).remaining_micros, 0);
        // Unlimited ignores pending and held.
        let all = row(0, true, 0);
        assert!(month_standing("2026-12", &all, 9_000_000, 1, 1, 0, false).remaining_micros > 1_000_000_000);
        assert_eq!(month_standing("2026-12", &all, 0, 0, 0, 0, false).resets_at, "2027-01-01T00:00:00Z");
    }

    #[test]
    fn a_waived_fee_is_a_zero_price_and_g1t_s_own_is_fully_discounted() {
        let waived = create_fields(&row(100_000_000, false, 0), "cus_1", "prod_plan", 2_100, false);
        let get = |fields: &[(String, String)], key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        assert_eq!(get(&waived, "items[0][price_data][unit_amount]").as_deref(), Some("0"));
        assert_eq!(get(&waived, "metadata[g1t_grant]").as_deref(), Some("cmp_1"));
        assert_eq!(get(&waived, "metadata[g1t_allowance_micros]").as_deref(), Some("100000000"));
        assert!(get(&waived, "discounts[0][coupon]").is_none());
        assert!(get(&waived, "collection_method").is_none(), "nothing to collect");
        let custom = create_fields(&row(500_000_000, false, 5_000), "cus_1", "prod_plan", 2_100, false);
        assert_eq!(get(&custom, "items[0][price_data][unit_amount]").as_deref(), Some("5000"));
        assert_eq!(get(&custom, "collection_method").as_deref(), Some("send_invoice"));
        assert_eq!(get(&custom, "automatic_tax[enabled]").as_deref(), Some("true"));
        // Only g1t's own (internal terms) is fully discounted; anyone else
        // unlimited with no fee is a $0 price, and may convert.
        assert!(fully_discounted(&row(0, true, 0), true));
        assert!(!fully_discounted(&row(0, true, 0), false));
        assert!(!fully_discounted(&row(0, true, 100), true));
        let own = create_fields(&row(0, true, 0), "cus_1", "prod_plan", 2_100, true);
        assert_eq!(get(&own, "items[0][price_data][unit_amount]").as_deref(), Some("2100"));
        assert_eq!(get(&own, "discounts[0][coupon]").as_deref(), Some(FULL_DISCOUNT_COUPON));
    }

    fn subscription(json: serde_json::Value) -> StripeSubscription {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_conversion_counts_only_once_stripe_applied_it() {
        let item = |price: &str| serde_json::json!({"data": [{"id": "si_1", "price": {"id": price, "unit_amount": 2100}}]});
        let converted = |price: Option<&str>, s: &StripeSubscription| converted(price, s, 2_100, true);
        // Paid: the item has the plan's price and nothing waits.
        assert!(converted(Some("price_comp"), &subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": item("price_plan")}))));
        // A staff terms change gives the item a new price too: never a
        // conversion without one in progress, nor at another amount.
        let terms = subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": item("price_plan")}));
        assert!(!super::converted(Some("price_comp"), &terms, 2_100, false));
        let fee = subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": {"data": [{"id": "si_1", "price": {"id": "price_fee", "unit_amount": 2500}}]}}));
        assert!(!super::converted(Some("price_comp"), &fee, 2_100, true));
        // 3DS or declined: Stripe keeps the old price behind a pending update.
        let waiting = subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": item("price_comp"), "pending_update": {"subscription_items": []}}));
        assert!(!converted(Some("price_comp"), &waiting));
        let pending_new = subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": item("price_plan"), "pending_update": {"x": 1}}));
        assert!(!converted(Some("price_comp"), &pending_new));
        // Unchanged, canceled, or nothing known to compare with.
        assert!(!converted(Some("price_comp"), &subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": item("price_comp")}))));
        assert!(!converted(Some("price_comp"), &subscription(serde_json::json!({"id": "sub_1", "status": "canceled", "items": item("price_plan")}))));
        assert!(!converted(None, &subscription(serde_json::json!({"id": "sub_1", "status": "active", "items": item("price_plan")}))));
    }

    #[test]
    fn a_conversion_waits_on_its_payment() {
        let fields = conversion_fields("si_1", "prod_plan", 2_100);
        let get = |key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(get("payment_behavior"), Some("pending_if_incomplete"));
        assert_eq!(get("items[0][id]"), Some("si_1"));
        assert_eq!(get("items[0][price_data][unit_amount]"), Some("2100"));
        assert_eq!(get("billing_cycle_anchor"), Some("now"));
    }

    #[test]
    fn alerts_count_what_admission_counts() {
        let r = row(100_000_000, false, 0);
        assert!(alert("acme", &month_standing("2026-10", &r, 40_000_000, 0, 0, 0, false)).is_none());
        let half = alert("acme", &month_standing("2026-10", &r, 30_000_000, 15_000_000, 5_000_000, 0, false)).unwrap();
        assert_eq!((half.meter.as_str(), half.level, half.used_micros), ("complimentary", 50, 50_000_000));
        let done = alert("acme", &month_standing("2026-10", &r, 100_000_000, 0, 0, 0, false)).unwrap();
        assert_eq!(done.level, 100);
        assert!(done.message.contains("2026-11-01") && !done.message.contains("charged at"));
        assert!(alert("acme", &month_standing("2026-10", &row(0, true, 0), 1, 0, 0, 0, false)).is_none());
    }

    #[test]
    fn owed_steps_round_trip() {
        for op in [Op::Create, Op::Cancel, Op::Terms { period: "cmpp_1".into() }, Op::Convert { attempt: 2, by: "ana".into(), started_ms: 5 }] {
            assert_eq!(Op::parse(Some(&op.text())), Some(op));
        }
        assert_eq!(Op::Create.text(), r#"{"op":"create"}"#);
        assert!(Op::Convert { attempt: 1, by: "a".into(), started_ms: 0 }.text().starts_with(r#"{"op":"convert""#));
        assert_eq!(Op::parse(Some("nonsense")), None);
    }
}
