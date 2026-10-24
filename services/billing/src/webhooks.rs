//! Stripe telling billing what happened, and enterprise invoices.
//!
//! Most of billing asks Stripe when it needs to know: a payment page is
//! confirmed when the person comes back, a plan is checked when its period
//! ends. That misses whatever happens while no one is looking: a page paid
//! for and closed, a renewal that failed, a refund, a dispute, an invoice
//! paid by bank transfer a week later. Stripe sends each as an event to
//! `https://api.g1t.sh/stripe/webhook`; the API passes the raw body and its
//! signature here, untouched.
//!
//! - The endpoint is registered by billing itself, from sudo, once per
//!   mode. Its signing secret is the worker's `STRIPE_WEBHOOK_SECRET`
//!   environment secret, never kept in the database or shown, and nothing
//!   can be posted here without it.
//! - An event whose `livemode` is not the key's mode is rejected before
//!   claiming its ID: an early live delivery must remain retryable after
//!   cutover, and test events never move live balances.
//! - Each event is handled once, by id, and recorded with what was done.
//! - Every handler is safe alongside the paths that ask Stripe directly:
//!   both claim the same rows.
//!
//! Enterprises are invoiced: one Stripe invoice per month (or sooner, from
//! sudo), with a line per workspace for what it owes, sent to the
//! enterprise's billing email and paid on Stripe's hosted invoice page.
//! When it is paid, each workspace is credited its line; when it goes
//! overdue, their work stops until it is paid.

use g1t_contracts::billing::{
    AdminEnterpriseAddressArgs, AdminEnterpriseBillingArgs, AdminInvoiceEnterpriseArgs, AdminStripeArgs, BillingAccount, EnterpriseInvoice,
    EntryKind, InvoiceLine, StripeEventSummary, StripePortalStatus, StripeStatus, StripeTaxStatus, StripeWebhook, StripeWebhookArgs,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::Value;
use sha2::Sha256;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;

/// Where Stripe sends events.
pub(crate) const WEBHOOK_URL: &str = "https://api.g1t.sh/stripe/webhook";

pub(crate) const ENTERPRISE_STATUS: &str =
    "UPDATE enterprise_invoices SET status = ? WHERE invoice_id = ? AND status IN ('open', 'overdue') RETURNING invoice_id";
pub(crate) const ENTERPRISE_OVERDUE_STOP: &str = "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at)
    SELECT ?1, ?2, ?3, ?2 WHERE EXISTS (SELECT 1 FROM enterprise_invoices WHERE invoice_id = ?4 AND status = 'overdue')
    ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2";

/// The events billing acts on.
pub(crate) const EVENTS: &[&str] = &[
    "checkout.session.completed",
    // A prepayment by bank transfer: the page completes when the transfer
    // is set up, and this comes when the money arrives.
    "checkout.session.async_payment_succeeded",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.overdue",
    "invoice.voided",
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.closed",
    // The saved card, kept on the account row (stripe_sync.rs).
    "customer.updated",
    "payment_method.attached",
    "payment_method.detached",
    "payment_method.updated",
    "payment_method.automatically_updated",
    "setup_intent.succeeded",
];

/// The subscription an invoice is for: `subscription` at the API version
/// billing asks in, `parent.subscription_details.subscription` in events
/// sent at a newer one (a destination keeps the version it was made at).
pub(crate) fn invoice_subscription(invoice: &Value) -> Option<&str> {
    invoice["subscription"].as_str().or_else(|| invoice["parent"]["subscription_details"]["subscription"].as_str())
}

/// Why an event is not for this key, when its `livemode` disagrees with the
/// key's mode (`live` or `test`): a test event never moves real balances,
/// nor a live one test balances. None when it agrees, or says nothing.
pub(crate) fn wrong_mode(livemode: Option<bool>, mode: &str) -> Option<String> {
    let live = livemode?;
    let key_live = mode == "live";
    (live != key_live).then(|| format!("a {} event, and the key is in {mode} mode", if live { "live" } else { "test" }))
}

/// What earlier refunds of a charge (`?1`, `refund/<charge>/%`) took back,
/// as a positive amount: from the plan's payments and from the ledger alike.
pub(crate) const ALREADY_REFUNDED_SQL: &str =
    "SELECT -(COALESCE((SELECT SUM(amount_micros) FROM plan_payments WHERE invoice_id LIKE ?1), 0)
          + COALESCE((SELECT SUM(amount_micros) FROM ledger WHERE reference LIKE ?1), 0)) AS micros";

pub(crate) const REFUND_BALANCE: &str = "UPDATE accounts SET balance_micros = balance_micros +
    (SELECT amount_micros FROM ledger WHERE reference = ?1) WHERE workspace = ?2 AND changes() > 0";

/// Why a workspace's work is stopped while one of its payments is disputed.
const DISPUTE_STOP: &str = "a payment was disputed with the card's bank";

/// Where a dispute stands, from Stripe's `status`: `lost`, `won` (a
/// warning closed without a dispute counts as won), else `open`.
pub(crate) fn dispute_state(status: &str) -> &'static str {
    match status {
        "lost" => "lost",
        "won" | "warning_closed" | "prevented" => "won",
        _ => "open",
    }
}

/// Whether a dispute event moves the dispute from where billing has it
/// (`known`, none for a dispute not seen before) to `state`: an event that
/// says what billing knows already does nothing. Once lost, only a win
/// (Stripe reversing it) moves it again; once detached (a test-mode
/// dispute), nothing does.
pub(crate) fn dispute_moves(known: Option<&str>, state: &str) -> bool {
    match known {
        None => true,
        Some(known) if known == state => false,
        // Closed by a test-mode detach: a test dispute, never acted on.
        Some("detached") => false,
        Some("lost") => state == "won",
        Some(_) => true,
    }
}

/// What a dispute won after it was lost gives back: what the loss took
/// (`taken`), only on that move. Nothing for any other.
pub(crate) fn restore_on_win(known: Option<&str>, state: &str, taken: i64) -> i64 {
    if known == Some("lost") && state == "won" { taken.max(0) } else { 0 }
}

/// Where a lost dispute's reversal is given back: `dispute/<id>/won`,
/// unique, so it is given back once.
pub(crate) fn won_reference(dispute_id: &str) -> String {
    format!("dispute/{dispute_id}/won")
}

/// What a dispute won after it was lost no longer leaves owed: `?1` the
/// workspace, `?2` what the loss took. Never below nothing.
pub(crate) const LOWER_DISPUTE_OWED: &str = "UPDATE limits SET dispute_owed_micros = MAX(0, dispute_owed_micros - ?2) WHERE workspace = ?1";

/// Events billing handles that `has` does not include, in billing's order.
pub(crate) fn missing_events(has: &[String]) -> Vec<String> {
    // `*` is every event.
    if has.iter().any(|event| event == "*") {
        return Vec::new();
    }
    EVENTS.iter().filter(|event| !has.iter().any(|h| h == *event)).map(|event| (*event).to_owned()).collect()
}

/// How old a signed event may be, so a captured one cannot be replayed.
const TOLERANCE_SECONDS: i64 = 5 * 60;

/// Whether `header` (`t=…,v1=…`) signs `payload` with `secret`, within the
/// tolerance of `now_seconds`.
pub(crate) fn verify(payload: &str, header: &str, secret: &str, now_seconds: i64) -> bool {
    let mut timestamp = None;
    let mut signatures = vec![];
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", value)) => timestamp = value.parse::<i64>().ok(),
            Some(("v1", value)) => signatures.push(value.to_owned()),
            _ => {}
        }
    }
    let Some(timestamp) = timestamp else { return false };
    if now_seconds.abs_diff(timestamp) > TOLERANCE_SECONDS as u64 {
        return false;
    }
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return false };
    mac.update(format!("{timestamp}.{payload}").as_bytes());
    let expected = mac.finalize().into_bytes();
    signatures.iter().any(|signature| {
        hex::decode(signature).is_ok_and(|given| {
            // Constant time: compare every byte whatever the first difference.
            given.len() == expected.len() && given.iter().zip(expected.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
        })
    })
}

/// The destination at billing's address, as Stripe lists it.
#[derive(Deserialize)]
pub(crate) struct Destination {
    pub(crate) id: String,
    url: String,
    /// `enabled` or `disabled`.
    pub(crate) status: String,
    pub(crate) enabled_events: Vec<String>,
    created: i64,
}

#[derive(Deserialize)]
struct EventRow {
    id: String,
    r#type: String,
    outcome: String,
    received_at: String,
}

#[derive(Deserialize)]
struct InvoiceRow {
    invoice_id: String,
    period: String,
    amount_micros: i64,
    status: String,
    hosted_url: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct LineRow {
    workspace: String,
    amount_micros: i64,
}

/// The idempotency key of an enterprise's invoice: the same enterprise,
/// period and amounts are the same invoice however often it is attempted.
#[cfg(test)]
pub(crate) fn enterprise_invoice_key(id: &str, period: &str, lines: &[(&str, i64)]) -> String {
    // FNV-1a over every line, so the key stays short however many there are.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (workspace, cents) in lines {
        for byte in format!("{workspace}={cents};").bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("ent-invoice/{id}/{period}/{hash:016x}")
}

impl Billing {
    pub(crate) fn mode(&self) -> &'static str {
        match &self.stripe {
            None => "off",
            Some(stripe) if stripe.live() => "live",
            Some(_) => "test",
        }
    }

    /// The destination at billing's address in Stripe, for this key's
    /// mode: an enabled one first. None when there is none.
    pub(crate) async fn destination(&self) -> Result<Option<Destination>> {
        let Some(stripe) = &self.stripe else { return Ok(None) };
        #[derive(Deserialize)]
        struct List {
            data: Vec<Destination>,
        }
        let mut ours: Vec<Destination> =
            stripe.get::<List>("/webhook_endpoints?limit=100").await?.data.into_iter().filter(|d| d.url == WEBHOOK_URL).collect();
        ours.sort_by_key(|d| d.status != "enabled");
        Ok(ours.into_iter().next())
    }

    // --- Staff ------------------------------------------------------------

    pub(crate) async fn admin_stripe(&self, a: AdminStripeArgs) -> Result<StripeStatus> {
        let mut error = None;
        if a.fix
            && let Err(e) = self.keep_endpoint(a.by.as_deref().unwrap_or("sudo")).await
        {
            error = Some(e.to_string());
        }
        let (webhook, missing_events) = match self.destination().await {
            Ok(Some(d)) => {
                let missing = missing_events(&d.enabled_events);
                let webhook = StripeWebhook {
                    url: d.url,
                    endpoint_id: d.id,
                    status: d.status,
                    events: d.enabled_events,
                    created_at: rfc3339(d.created.max(0) as u64 * 1000),
                };
                (Some(webhook), missing)
            }
            Ok(None) => (None, Vec::new()),
            Err(e) => {
                error = error.or(Some(format!("Stripe could not be read: {e}")));
                (None, Vec::new())
            }
        };
        let recent_events = self
            .db
            .prepare("SELECT * FROM stripe_events ORDER BY received_at DESC LIMIT 25")
            .all()
            .await?
            .results::<EventRow>()?
            .into_iter()
            .map(|row| StripeEventSummary { id: row.id, kind: row.r#type, outcome: row.outcome, received_at: row.received_at })
            .collect();
        // Stripe Tax and the customer portal, for the go-live checklist:
        // read as Stripe has them, never made or changed here.
        let (mut tax, mut portal) = (None, None);
        if let Some(stripe) = &self.stripe {
            match stripe.tax_settings().await {
                Ok(settings) => {
                    tax = Some(StripeTaxStatus {
                        status: settings.status,
                        missing_fields: settings.status_details.pending.and_then(|p| p.missing_fields).unwrap_or_default(),
                    })
                }
                Err(e) => error = error.or(Some(format!("Stripe Tax's settings could not be read: {e}"))),
            }
            match stripe.our_portal().await {
                Ok(found) => portal = found.map(|c| StripePortalStatus { configuration_id: c.id, active: c.active }),
                Err(e) => error = error.or(Some(format!("The customer portal's settings could not be read: {e}"))),
            }
        }
        Ok(StripeStatus {
            mode: self.mode().to_owned(),
            secret_set: self.webhook_secret.is_some(),
            webhook,
            missing_events,
            recent_events,
            error,
            tax,
            portal,
        })
    }

    // --- Events -----------------------------------------------------------

    pub(crate) async fn stripe_webhook(&self, a: StripeWebhookArgs) -> Result<Outcome<bool>> {
        let Some(secret) = &self.webhook_secret else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "STRIPE_WEBHOOK_SECRET is not set, so billing cannot check that events come from Stripe.",
            ));
        };
        let now_seconds = (now_ms() / 1000) as i64;
        if !verify(&a.payload, &a.signature, secret, now_seconds) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "The signature does not match."));
        }
        let event: Value = serde_json::from_str(&a.payload).map_err(|e| worker::Error::RustError(e.to_string()))?;
        if event["id"].as_str().unwrap_or_default().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Not an event."));
        }
        Ok(Outcome::Ok(self.process_event(&event).await?))
    }

    /// Handles a Stripe event once, however often it arrives: by webhook,
    /// or again from the event list (stripe_sync.rs). False when it was
    /// seen before.
    pub(crate) async fn process_event(&self, event: &Value) -> Result<bool> {
        // Do not permanently acknowledge an event delivered while the live
        // webhook and API key are being switched. Recording it as ignored
        // would prevent both redelivery and event replay after cutover.
        if let Some(why) = wrong_mode(event["livemode"].as_bool(), self.mode()) {
            return Err(worker::Error::RustError(format!("Stripe mode mismatch; retry after configuration is corrected: {why}")));
        }
        let id = event["id"].as_str().unwrap_or_default().to_owned();
        let kind = event["type"].as_str().unwrap_or_default().to_owned();
        // Once each: the first to record it handles it.
        let claimed = self
            .db
            .prepare("INSERT OR IGNORE INTO stripe_events (id, type, outcome, received_at) VALUES (?, ?, 'handling', ?) RETURNING id")
            .bind(&[id.as_str().into(), kind.as_str().into(), rfc3339(now_ms()).into()])?
            .first::<Value>(None)
            .await?;
        if claimed.is_none() {
            // A concurrent handler has not acknowledged this event yet.
            // Returning success here could advance replay past work that
            // subsequently fails (or acknowledge Stripe's last retry).
            let pending = self
                .db
                .prepare("SELECT id FROM stripe_events WHERE id = ? AND outcome = 'handling'")
                .bind(&[id.as_str().into()])?
                .first::<Value>(None)
                .await?;
            if pending.is_some() {
                return Err(worker::Error::RustError("Stripe event is still being handled; retry it".into()));
            }
            return Ok(false);
        }
        let outcome = match self.handle(&kind, event).await {
            Ok(outcome) => outcome,
            Err(error) => {
                // Let Stripe send it again: forget it was seen.
                self.db.prepare("DELETE FROM stripe_events WHERE id = ?").bind(&[id.as_str().into()])?.run().await?;
                return Err(error);
            }
        };
        self.db
            .prepare("UPDATE stripe_events SET outcome = ? WHERE id = ?")
            .bind(&[outcome.as_str().into(), id.as_str().into()])?
            .run()
            .await?;
        Ok(true)
    }

    async fn handle(&self, kind: &str, event: &Value) -> Result<String> {
        let object = &event["data"]["object"];
        let text = |key: &str| object[key].as_str().unwrap_or_default().to_owned();
        // The customer whose saved card may have changed. A detached card
        // has no customer any more; the event says whose it was.
        let card_owner = match kind {
            "customer.updated" => object["id"].as_str(),
            "payment_method.detached" => event["data"]["previous_attributes"]["customer"].as_str(),
            _ => object["customer"].as_str(),
        };
        Ok(match kind {
            "checkout.session.completed" | "checkout.session.async_payment_succeeded" => self.settle_checkout(&text("id")).await?,
            "customer.subscription.updated" | "customer.subscription.deleted" => self.settle_subscription(&text("id")).await?,
            "invoice.paid" => {
                if let Some(subscription) = invoice_subscription(object) {
                    self.plan_paid(subscription, &text("id")).await?;
                    self.settle_subscription(subscription).await?
                } else if let Some(done) = self.workspace_invoice_paid(&text("id")).await? {
                    done
                } else {
                    self.enterprise_invoice_paid(&text("id")).await?
                }
            }
            "invoice.payment_failed" => match (invoice_subscription(object), object["metadata"]["g1t_workspace"].as_str()) {
                (Some(subscription), _) => self.settle_subscription(subscription).await?,
                (None, Some(tagged)) => self.workspace_invoice_failed(&text("id"), tagged).await?,
                _ => "ignored: not g1t's".to_owned(),
            },
            "invoice.overdue" => self.enterprise_invoice_status(&text("id"), "overdue").await?,
            "invoice.voided" => {
                // A workspace invoice voided at Stripe stops being open here.
                self.db
                    .prepare("UPDATE workspace_invoices SET status = 'void' WHERE invoice_id = ? AND status IN ('open', 'failed')")
                    .bind(&[text("id").into()])?
                    .run()
                    .await?;
                self.enterprise_invoice_status(&text("id"), "void").await?
            }
            "charge.refunded" => self.refunded(&text("id")).await?,
            // Created or closed, the dispute is read as it stands now, so
            // events late or out of order act on where it is.
            "charge.dispute.created" | "charge.dispute.closed" => self.disputed(&text("id")).await?,
            "customer.updated"
            | "payment_method.attached"
            | "payment_method.detached"
            | "payment_method.updated"
            | "payment_method.automatically_updated"
            | "setup_intent.succeeded" => match card_owner {
                Some(customer) => self.sync_card_of(customer).await?,
                None => "ignored: no customer".to_owned(),
            },
            _ => "ignored".to_owned(),
        })
    }

    /// A payment page done, whether or not the person came back to g1t.
    pub(crate) async fn settle_checkout(&self, session_id: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Open {
            workspace: String,
            created_by: String,
            feature: Option<String>,
            #[serde(default)]
            fee_cents: Option<u32>,
        }
        let Some(open) = self
            .db
            .prepare("SELECT workspace, created_by, feature, fee_cents FROM checkouts WHERE id = ? AND status = 'open'")
            .bind(&[session_id.into()])?
            .first::<Open>(None)
            .await?
        else {
            return Ok("ignored: already settled or not g1t's".to_owned());
        };
        // A card check: saved and verified, never charged.
        if open.feature.as_deref() == Some(crate::cards::CARD_CHECK) {
            return Ok(match self.settle_card_check(session_id).await? {
                Ok(done) => done,
                Err(why) => format!("card check not passed: {why}"),
            });
        }
        // AI credit, from before g1t stopped selling it: a page left open
        // then is never credited as anything else.
        if open.feature.as_deref() == Some("ai_credit") {
            return Ok("ignored: AI credit is no longer sold".to_owned());
        }
        let Some(stripe) = &self.stripe else { return Ok("ignored: payments off".to_owned()) };
        let session = stripe.session(session_id).await?;
        if session.payment_status != "paid" && open.feature.is_none() {
            return Ok("ignored: not paid".to_owned());
        }
        // What the page paid for first, then the page marked paid: a
        // failure between the two leaves it open, and settling it again
        // finds the credit (the ledger's reference) or the plan entered.
        let mark = self.db.prepare("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open'").bind(&[session_id.into()])?;
        match open.feature.as_deref() {
            None => {
                let cents = self.credit_prepayment(&open.workspace, &session, open.fee_cents.unwrap_or(0), &open.created_by).await?;
                mark.run().await?;
                if cents == 0 {
                    return Ok("ignored: credited meanwhile".to_owned());
                }
                Ok(format!("credited {} to {}", crate::features::dollars(cents * 10_000), open.workspace))
            }
            Some(feature) => {
                let Some(feature) = g1t_contracts::billing::Feature::parse(feature) else {
                    return Ok("ignored: unknown feature".to_owned());
                };
                if let Some(subscription_id) = &session.subscription {
                    let subscription = stripe.subscription(subscription_id).await?;
                    self.record(&open.workspace, feature, &subscription, &open.created_by).await?;
                }
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at) VALUES (?1, 0, ?2, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET customer_id = COALESCE(customer_id, ?2)",
                    )
                    .bind(&[open.workspace.as_str().into(), crate::optional(session.customer.as_deref()), rfc3339(now_ms()).into()])?
                    .run()
                    .await?;
                mark.run().await?;
                Ok(format!("{} plan started for {}", feature.title(), open.workspace))
            }
        }
    }

    /// The plan's monthly price, paid: revenue that never goes through the
    /// ledger, recorded once per invoice for sudo's figures and for trust.
    /// Only the plan's own price is revenue: the invoice's tax and card fee
    /// are kept apart (`tax_and_fees`).
    ///
    /// The invoice is read again at billing's API version: the event's copy
    /// is at the destination's, where `tax` and `payment_intent` may be
    /// gone.
    pub(crate) async fn plan_paid(&self, subscription_id: &str, invoice_id: &str) -> Result<()> {
        let Some(stripe) = &self.stripe else { return Ok(()) };
        if invoice_id.is_empty() {
            return Ok(());
        }
        let invoice: Value = stripe.get(&format!("/invoices/{invoice_id}")).await?;
        if invoice["status"].as_str() != Some("paid") {
            return Ok(());
        }
        let invoice = &invoice;
        let split = crate::stripe::invoice_split(invoice, invoice["amount_paid"].as_i64().unwrap_or(0));
        let amount_cents = split.net_cents;
        if amount_cents <= 0 {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct Owner {
            workspace: String,
        }
        // The plan's subscription, or an enrollment's: its custom fee, or
        // the first plan invoice of a conversion Stripe has not applied yet.
        // Either is money received.
        let Some(owner) = self
            .db
            .prepare(
                "SELECT workspace FROM subscriptions WHERE subscription_id = ?1
                 UNION ALL SELECT workspace FROM complimentary WHERE subscription_id = ?1 LIMIT 1",
            )
            .bind(&[subscription_id.into()])?
            .first::<Owner>(None)
            .await?
        else {
            return Ok(());
        };
        let extras = crate::tax::Extras { tax_cents: split.tax_cents, fee_cents: split.fee_cents };
        self.record_extras(&owner.workspace, invoice_id, invoice["payment_intent"].as_str(), extras, None).await?;
        self.db
            .prepare(
                "INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at)
                 VALUES (?1, ?4, ?2, ?3)
                 ON CONFLICT (invoice_id) DO NOTHING",
            )
            .bind(&[invoice_id.into(), ((amount_cents * 10_000) as f64).into(), rfc3339(now_ms()).into(), owner.workspace.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A plan that changed at Stripe: renewed, failed, canceled.
    pub(crate) async fn settle_subscription(&self, subscription_id: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Plan {
            workspace: String,
            feature: String,
            started_by: String,
        }
        let plan = self
            .db
            .prepare("SELECT workspace, feature, started_by FROM subscriptions WHERE subscription_id = ?")
            .bind(&[subscription_id.into()])?
            .first::<Plan>(None)
            .await?;
        // A complimentary enrollment's subscription (or one converting to
        // the plan, which has no plan row until Stripe applies it).
        let Some(plan) = plan else {
            return Ok(self.settle_complimentary(subscription_id).await?.unwrap_or_else(|| "ignored: not a g1t plan".to_owned()));
        };
        let (Some(stripe), Some(feature)) = (&self.stripe, g1t_contracts::billing::Feature::parse(&plan.feature)) else {
            return Ok("ignored".to_owned());
        };
        let subscription = match stripe.subscription(subscription_id).await {
            Ok(subscription) => subscription,
            // A plan Stripe no longer has (another account's, or deleted):
            // it has ended here.
            Err(error) if crate::stripe::is_missing(&error) => {
                self.db
                    .prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE subscription_id = ?")
                    .bind(&[rfc3339(now_ms()).into(), subscription_id.into()])?
                    .run()
                    .await?;
                return Ok(format!("{} plan for {} is gone at Stripe: canceled", feature.title(), plan.workspace));
            }
            Err(error) => return Err(error),
        };
        self.record(&plan.workspace, feature, &subscription, &plan.started_by).await?;
        Ok(format!("{} plan for {} is {}", feature.title(), plan.workspace, subscription.status))
    }

    /// The workspace a Stripe customer belongs to.
    pub(crate) async fn workspace_of_customer(&self, customer: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
        }
        Ok(self
            .db
            .prepare("SELECT workspace FROM accounts WHERE customer_id = ?")
            .bind(&[customer.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| row.workspace))
    }

    /// The workspace a workspace invoice was sent to, under its slug now.
    pub(crate) async fn workspace_of_invoice(&self, invoice_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
        }
        Ok(self
            .db
            .prepare("SELECT workspace FROM workspace_invoices WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| row.workspace))
    }

    /// Money given back: what was paid is less, by the refund. A refund of
    /// a plan's invoice takes back the plan's payment (`plan_payments`);
    /// any other takes back credit on the balance. The charge is read again
    /// at billing's API version, where it still carries `invoice`.
    async fn refunded(&self, charge_id: &str) -> Result<String> {
        let Some(stripe) = &self.stripe else { return Ok("ignored: payments off".to_owned()) };
        let charge: Value = stripe.get(&format!("/charges/{charge_id}")).await?;
        let charge = &charge;
        let Some(customer) = charge["customer"].as_str() else { return Ok("ignored: no customer".to_owned()) };
        let Some(workspace) = self.workspace_of_customer(customer).await? else {
            return Ok("ignored: not a workspace's customer".to_owned());
        };
        let refunded = charge["amount_refunded"].as_i64().unwrap_or(0);
        if refunded <= 0 {
            return Ok("ignored: nothing refunded".to_owned());
        }
        // Refunds can precede payment webhooks. Establish the original
        // payment and tax split first instead of treating tax as credit.
        let mut invoice_extras = None;
        let plan_invoice = if let Some(id) = charge["invoice"].as_str() {
            let invoice: Value = stripe.get(&format!("/invoices/{id}")).await?;
            let split = crate::stripe::invoice_split(&invoice, invoice["amount_paid"].as_i64().unwrap_or(0));
            invoice_extras = Some(crate::tax::Extras { tax_cents: split.tax_cents, fee_cents: split.fee_cents });
            if invoice_subscription(&invoice).is_some() {
                true
            } else {
                self.workspace_invoice_paid(id).await?;
                false
            }
        } else {
            if let Some(intent) = charge["payment_intent"].as_str() {
                let sessions: Value = stripe
                    .get(&format!(
                        "/checkout/sessions?{}",
                        crate::stripe::form(&[("payment_intent", intent.to_owned()), ("limit", "100".to_owned()),])
                    ))
                    .await?;
                for session in sessions["data"].as_array().into_iter().flatten() {
                    if let Some(id) = session["id"].as_str() {
                        self.settle_checkout(id).await?;
                    }
                }
            }
            false
        };
        // Each refund total once, so partial refunds add up correctly: what
        // earlier refunds of the charge took back, wherever they were kept.
        // A plan's refund recorded on the ledger (before plan refunds went
        // to `plan_payments`) counts as much as one recorded there.
        #[derive(Deserialize)]
        struct Sum {
            micros: Option<i64>,
        }
        let already = self
            .db
            .prepare(ALREADY_REFUNDED_SQL)
            .bind(&[format!("refund/{charge_id}/%").into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0);
        // A refund gives back the payment's tax and card fee in proportion:
        // only the rest comes off the balance, which never held them.
        let (extras, transaction) = self.extras_of(charge["payment_intent"].as_str(), charge["invoice"].as_str()).await?;
        let extras = invoice_extras.unwrap_or(extras);
        let paid = charge["amount"].as_i64().unwrap_or(refunded);
        let (balance_cents, tax_cents, fee_cents) = crate::tax::refund_split(refunded, paid, extras.tax_cents, extras.fee_cents);
        let (given_tax, given_fee) = self.refunded_extras(charge_id).await?;
        let new = balance_cents * 10_000 - already;
        let new_extras = crate::tax::Extras { tax_cents: -(tax_cents - given_tax), fee_cents: -(fee_cents - given_fee) };
        if new <= 0 && new_extras == crate::tax::Extras::default() {
            return Ok("ignored: refund already recorded".to_owned());
        }
        let reference = format!("refund/{charge_id}/{refunded}");
        // Compute each delta inside the transaction, not from the earlier
        // read: distinct partial-refund events can execute concurrently.
        let now = rfc3339(now_ms());
        let pattern = format!("refund/{charge_id}/%");
        let mut writes =
            vec![self.db.prepare(if plan_invoice { include_str!("refund_plan.sql") } else { include_str!("refund_ledger.sql") }).bind(
                &[
                    g1t_contracts::new_id("led", now_ms()).into(),
                    workspace.as_str().into(),
                    ((balance_cents * 10_000) as f64).into(),
                    reference.as_str().into(),
                    now.as_str().into(),
                    pattern.as_str().into(),
                ],
            )?];
        if !plan_invoice {
            // changes() is the preceding insert's count: replaying a
            // cumulative refund never moves the balance a second time.
            writes.push(self.db.prepare(REFUND_BALANCE).bind(&[reference.as_str().into(), workspace.as_str().into()])?);
        }
        for (kind, total) in [("tax", tax_cents), ("card_fee", fee_cents)] {
            writes.push(self.db.prepare(include_str!("refund_extras.sql")).bind(&[
                format!("{reference}/{kind}").into(),
                workspace.as_str().into(),
                kind.into(),
                ((total * 10_000) as f64).into(),
                reference.as_str().into(),
                crate::optional(charge["payment_intent"].as_str()),
                now.as_str().into(),
                pattern.as_str().into(),
            ])?);
        }
        self.db.batch(writes).await?;
        // An off-session charge's tax was recorded by g1t (auto-reload):
        // reverse what this refund gave back. Checkout's and invoices' tax
        // Stripe Tax keeps itself.
        if let (Some(stripe), Some(transaction)) = (&self.stripe, transaction.as_deref()) {
            let given_back = new.max(0) / 10_000 - new_extras.tax_cents - new_extras.fee_cents;
            if given_back > 0
                && let Err(error) = stripe.reverse_tax(transaction, &reference, given_back).await
            {
                worker::console_error!("{workspace}: the tax on refund {reference} was not reversed: {error}");
            }
        }
        Ok(format!("refund of {} recorded for {workspace}", crate::features::dollars(new.max(0))))
    }

    /// What earlier refunds of a charge gave back of its tax and card fee,
    /// in cents, as positive amounts.
    async fn refunded_extras(&self, charge_id: &str) -> Result<(i64, i64)> {
        #[derive(Deserialize)]
        struct Row {
            kind: String,
            micros: Option<i64>,
        }
        let rows = self
            .db
            .prepare("SELECT kind, SUM(amount_micros) AS micros FROM tax_and_fees WHERE reference LIKE ? GROUP BY kind")
            .bind(&[format!("refund/{charge_id}/%").into()])?
            .all()
            .await?
            .results::<Row>()?;
        let of = |kind: &str| rows.iter().filter(|r| r.kind == kind).map(|r| -r.micros.unwrap_or(0) / 10_000).sum::<i64>();
        Ok((of("tax"), of("card_fee")))
    }

    /// Whether a Stripe invoice is a plan's, its payment recorded in
    /// `plan_payments`.
    async fn plan_payment_of(&self, invoice_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT invoice_id FROM plan_payments WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .first::<Value>(None)
            .await?
            .is_some())
    }

    /// A disputed payment, acted on as Stripe says it stands now (so an
    /// event late, twice or out of order does the right thing):
    ///
    /// - Open: the payment never counts toward trust, and work stops.
    /// - Won: it counts again, and the stop lifts unless another dispute is
    ///   open or what a lost one took is unpaid. Won after it was lost (the
    ///   bank reversed itself), what was taken back is given back once
    ///   (`dispute/<id>/won`, where the loss was entered) and no longer
    ///   owed.
    /// - Lost: its credit is taken back once (`dispute/<id>` on the ledger,
    ///   or on `plan_payments` for a plan's invoice), in the share of the
    ///   payment that was not tax or card fee, and work stays stopped until
    ///   that much is paid again (`dispute_owed_micros`). A smaller payment
    ///   in the meantime is credit like any other, but does not lift it.
    async fn disputed(&self, dispute_id: &str) -> Result<String> {
        let Some(stripe) = &self.stripe else { return Ok("ignored".to_owned()) };
        let dispute: Value = stripe.get(&format!("/disputes/{dispute_id}")).await?;
        let state = dispute_state(dispute["status"].as_str().unwrap_or_default());
        let Some(charge_id) = dispute["charge"].as_str().or_else(|| dispute["charge"]["id"].as_str()) else {
            return Ok("ignored: no charge".to_owned());
        };
        let charge: Value = stripe.get(&format!("/charges/{charge_id}")).await?;
        let Some(workspace) = (match charge["customer"].as_str() {
            Some(customer) => self.workspace_of_customer(customer).await?,
            None => None,
        }) else {
            return Ok("ignored: not a workspace's customer".to_owned());
        };
        let now = rfc3339(now_ms());
        let payment_intent = charge["payment_intent"].as_str();
        let invoice = charge["invoice"].as_str();
        // The payment as the ledger knows it: its PaymentIntent, its
        // invoice, or the prepayment page that took it.
        let mut references: Vec<String> = [payment_intent, invoice].into_iter().flatten().map(str::to_owned).collect();
        if let Some(intent) = payment_intent {
            let pages: Value = stripe.get(&format!("/checkout/sessions?payment_intent={intent}&limit=10")).await?;
            references.extend(pages["data"].as_array().into_iter().flatten().filter_map(|page| page["id"].as_str().map(str::to_owned)));
        }
        // It counts toward trust again only if won.
        for reference in &references {
            self.db
                .prepare("UPDATE ledger SET disputed = ? WHERE workspace = ? AND reference = ?")
                .bind(&[(if state == "won" { 0 } else { 1 }).into(), workspace.as_str().into(), reference.as_str().into()])?
                .run()
                .await?;
        }
        #[derive(Deserialize)]
        struct Known {
            status: String,
            reversed_micros: Option<i64>,
        }
        let known_row = self
            .db
            .prepare("SELECT status, reversed_micros FROM disputes WHERE dispute_id = ?")
            .bind(&[dispute_id.into()])?
            .first::<Known>(None)
            .await?;
        let taken = known_row.as_ref().and_then(|row| row.reversed_micros).unwrap_or(0);
        let known = known_row.map(|row| row.status);
        // Where it stood already: an event twice, or late, changes nothing.
        // Work is not stopped again (an owner may have paid since), and
        // nothing is taken back or owed twice.
        if !dispute_moves(known.as_deref(), state) {
            return Ok(format!("ignored: dispute {dispute_id} is {state} already"));
        }
        let reference = format!("dispute/{dispute_id}");
        let mut writes = vec![];
        // A lost dispute's credit, taken back once: the reversal, the
        // dispute's row and what is owed go in one batch, so a delivery
        // alongside (whose reversal fails on the same reference, undoing
        // its whole batch) never adds what is owed a second time.
        let mut reversed = 0;
        if state == "lost" {
            let (extras, _) = self.extras_of(payment_intent, invoice).await?;
            let amount = dispute["amount"].as_i64().unwrap_or(0);
            let paid = charge["amount"].as_i64().unwrap_or(amount);
            reversed = crate::tax::refund_split(amount, paid, extras.tax_cents, extras.fee_cents).0 * 10_000;
            let plan = match invoice {
                Some(invoice) => self.plan_payment_of(invoice).await?,
                None => false,
            };
            if reversed > 0 && plan {
                // No `ON CONFLICT`: a second insert fails the batch.
                writes.push(
                    self.db
                        .prepare("INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at) VALUES (?, ?, ?, ?)")
                        .bind(&[reference.as_str().into(), workspace.as_str().into(), ((-reversed) as f64).into(), now.as_str().into()])?,
                );
            } else if reversed > 0 {
                writes.extend(self.entry_statements(
                    &workspace,
                    EntryKind::TopUp,
                    -reversed,
                    "Taken back by the card's bank: a dispute was lost",
                    &reference,
                    None,
                    None,
                    None,
                )?);
            }
        }
        // Lost, then won: what the loss took back is given back, where it
        // was taken (the plan's payments or the ledger), in the same batch
        // as the dispute's row, so a delivery alongside fails on the same
        // reference and gives nothing twice.
        let restored = restore_on_win(known.as_deref(), state, taken);
        if restored > 0 {
            let back = won_reference(dispute_id);
            if self.plan_payment_of(&reference).await? {
                // No `ON CONFLICT`: a second insert fails the batch.
                writes.push(
                    self.db
                        .prepare("INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at) VALUES (?, ?, ?, ?)")
                        .bind(&[back.as_str().into(), workspace.as_str().into(), (restored as f64).into(), now.as_str().into()])?,
                );
            } else {
                writes.extend(self.entry_statements(
                    &workspace,
                    EntryKind::TopUp,
                    restored,
                    "Given back by the card's bank: a lost dispute was reversed",
                    &back,
                    None,
                    None,
                    None,
                )?);
            }
        }
        let reversing = !writes.is_empty();
        writes.push(
            self.db
                .prepare(
                    "INSERT INTO disputes (dispute_id, workspace, charge_id, status, reversed_micros, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (dispute_id) DO UPDATE SET status = ?4, reversed_micros = reversed_micros + ?5, updated_at = ?6",
                )
                .bind(&[dispute_id.into(), workspace.as_str().into(), charge_id.into(), state.into(), (reversed as f64).into(), now.as_str().into()])?,
        );
        if state == "won" {
            if restored > 0 {
                writes.push(self.db.prepare(LOWER_DISPUTE_OWED).bind(&[workspace.as_str().into(), (restored as f64).into()])?);
            }
            // Only the stop a dispute made: a declined card stays stopped.
            writes.push(
                self.db
                    .prepare(format!("{} AND autopay_error = ?2", crate::CLEAR_STOP))
                    .bind(&[workspace.as_str().into(), DISPUTE_STOP.into()])?,
            );
        } else {
            writes.push(
                self.db
                    .prepare(
                        "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, dispute_owed_micros, updated_at) VALUES (?1, ?2, ?3, ?4, ?2)
                         ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3,
                           dispute_owed_micros = dispute_owed_micros + ?4, updated_at = ?2",
                    )
                    .bind(&[workspace.as_str().into(), now.as_str().into(), DISPUTE_STOP.into(), (reversed as f64).into()])?,
            );
        }
        match self.db.batch(writes).await {
            Ok(_) => {}
            // The reversal was entered already: by a delivery alongside,
            // whose batch recorded the dispute and what is owed with it, or
            // (before these went in one batch) on its own, its dispute
            // left unrecorded. Only then is the dispute recorded now, at
            // the amount entered, once.
            // Given back already, by a delivery alongside.
            Err(error) if restored > 0 && crate::is_duplicate(&error) => {
                return Ok(format!("ignored: dispute {dispute_id} is won already"));
            }
            Err(error) if reversing && crate::is_duplicate(&error) => {
                return self.dispute_reversed_before(&workspace, dispute_id, charge_id, &reference, &now).await;
            }
            Err(error) => return Err(error),
        }
        let account = self.account_of(&workspace).await?;
        let what = match state {
            "won" if restored > 0 => {
                format!("dispute reversed in the workspace's favour: {} given back", crate::features::dollars(restored))
            }
            "won" => "dispute closed in the workspace's favour".to_owned(),
            "lost" => format!("dispute lost: {} taken back; work stopped until it is paid", crate::features::dollars(reversed)),
            _ => "dispute: work stopped".to_owned(),
        };
        self.audit(&account.id, "dispute", &format!("{workspace}: {what}"), "stripe").await?;
        Ok(format!("{workspace}: {what}"))
    }

    /// A lost dispute whose reversal is on the ledger (or the plan's
    /// payments) already. Recorded as lost, and what it took back owed,
    /// only by the one delivery that moves the dispute's row to lost.
    async fn dispute_reversed_before(
        &self,
        workspace: &str,
        dispute_id: &str,
        charge_id: &str,
        reference: &str,
        now: &str,
    ) -> Result<String> {
        #[derive(Deserialize)]
        struct Sum {
            micros: Option<i64>,
        }
        let reversed = self
            .db
            .prepare(
                "SELECT -(COALESCE((SELECT SUM(amount_micros) FROM ledger WHERE reference = ?1), 0)
                        + COALESCE((SELECT SUM(amount_micros) FROM plan_payments WHERE invoice_id = ?1), 0)) AS micros",
            )
            .bind(&[reference.into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0)
            .max(0);
        let moved = self
            .db
            .prepare(
                "INSERT INTO disputes (dispute_id, workspace, charge_id, status, reversed_micros, updated_at) VALUES (?1, ?2, ?3, 'lost', ?4, ?5)
                 ON CONFLICT (dispute_id) DO UPDATE SET status = 'lost', reversed_micros = ?4, updated_at = ?5 WHERE disputes.status <> 'lost'
                 RETURNING dispute_id",
            )
            .bind(&[dispute_id.into(), workspace.into(), charge_id.into(), (reversed as f64).into(), now.into()])?
            .first::<Value>(None)
            .await?
            .is_some();
        if !moved {
            return Ok(format!("ignored: dispute {dispute_id} is lost already"));
        }
        self.db
            .prepare(
                "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, dispute_owed_micros, updated_at) VALUES (?1, ?2, ?3, ?4, ?2)
                 ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3,
                   dispute_owed_micros = dispute_owed_micros + ?4, updated_at = ?2",
            )
            .bind(&[workspace.into(), now.into(), DISPUTE_STOP.into(), (reversed as f64).into()])?
            .run()
            .await?;
        Ok(format!("{workspace}: dispute lost: {} taken back earlier; work stopped until it is paid", crate::features::dollars(reversed)))
    }

    // --- Enterprise invoices ------------------------------------------------

    pub(crate) async fn admin_enterprise_billing(&self, a: AdminEnterpriseBillingArgs) -> Result<Outcome<BillingAccount>> {
        let email = a.email.trim().to_lowercase();
        if !email.contains('@') || email.contains(char::is_whitespace) || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give the email the enterprise's invoices go to."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        #[derive(Deserialize)]
        struct Row {
            name: String,
            kind: String,
            customer_id: Option<String>,
        }
        let Some(row) = self
            .db
            .prepare("SELECT name, kind, customer_id FROM billing_accounts WHERE id = ?")
            .bind(&[a.id.as_str().into()])?
            .first::<Row>(None)
            .await?
            .filter(|row| row.kind == "enterprise")
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such enterprise."));
        };
        #[derive(Deserialize)]
        struct Customer {
            id: String,
        }
        let fields = [("name", row.name.clone()), ("email", email.clone()), ("metadata[g1t_enterprise]", a.id.clone())];
        let customer: Customer = match &row.customer_id {
            Some(id) => stripe.post(&format!("/customers/{id}"), &fields).await?,
            None => stripe.post("/customers", &fields).await?,
        };
        self.db
            .prepare("UPDATE billing_accounts SET billing_email = ?, customer_id = ? WHERE id = ?")
            .bind(&[email.as_str().into(), customer.id.as_str().into(), a.id.as_str().into()])?
            .run()
            .await?;
        self.audit(&a.id, "billing_email", &format!("Invoices go to {email}"), &a.by).await?;
        Ok(match self.enterprise(&a.id).await? {
            Some(account) => Outcome::Ok(account),
            None => Outcome::fail(FailureCode::NotFound, "No such enterprise."),
        })
    }

    /// `admin_enterprise_address`: the address Stripe Tax works the
    /// enterprise's invoices out from, and its tax ID, on its customer.
    pub(crate) async fn admin_enterprise_address(&self, a: AdminEnterpriseAddressArgs) -> Result<Outcome<bool>> {
        if a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is changing it."));
        }
        if let Some(why) = crate::details::address_invalid(&a.address)
            .or_else(|| crate::details::tax_id_invalid(a.tax_id_type.as_deref(), a.tax_id.as_deref()))
        {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let place = serde_json::json!({ "country": a.address.country.trim(), "postal_code": a.address.postal_code.trim(), "state": a.address.state.trim() });
        if !crate::stripe::address_places_customer(&place) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Give at least the country, and in the US the ZIP code: Stripe Tax needs them.",
            ));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        #[derive(Deserialize)]
        struct Row {
            kind: String,
            customer_id: Option<String>,
        }
        let Some(row) = self
            .db
            .prepare("SELECT kind, customer_id FROM billing_accounts WHERE id = ?")
            .bind(&[a.id.as_str().into()])?
            .first::<Row>(None)
            .await?
            .filter(|row| row.kind == "enterprise")
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such enterprise."));
        };
        let Some(customer) = row.customer_id else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Set where its invoices go first: that makes its Stripe customer."));
        };
        let fields: Vec<(&str, String)> = vec![
            ("address[line1]", a.address.line1.trim().to_owned()),
            ("address[line2]", a.address.line2.trim().to_owned()),
            ("address[city]", a.address.city.trim().to_owned()),
            ("address[state]", a.address.state.trim().to_owned()),
            ("address[postal_code]", a.address.postal_code.trim().to_owned()),
            ("address[country]", a.address.country.trim().to_uppercase()),
        ];
        if let Err(error) = stripe.post::<Value>(&format!("/customers/{customer}"), &fields).await {
            return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error)));
        }
        if let (Some(kind), Some(value)) = (a.tax_id_type.as_deref(), a.tax_id.as_deref())
            && let Err(why) = crate::details::replace_tax_id(stripe, &customer, &a.id, kind, value).await
        {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        self.audit(&a.id, "billing_address", &format!("Billing address set ({})", a.address.country.trim().to_uppercase()), &a.by).await?;
        Ok(Outcome::Ok(true))
    }

    pub(crate) async fn admin_invoice_enterprise(&self, a: AdminInvoiceEnterpriseArgs) -> Result<Outcome<EnterpriseInvoice>> {
        if a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is sending it."));
        }
        match self.invoice_enterprise(&a.id, "now", &a.by).await {
            Ok(Ok(invoice)) => Ok(Outcome::Ok(invoice)),
            Ok(Err(why)) => Ok(Outcome::fail(FailureCode::Conflict, why)),
            Err(error) => {
                worker::console_error!("enterprise invoice {} could not complete: {error}", a.id);
                Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "The invoice has not completed. Retry to resume the same invoice; if this continues, contact support.",
                ))
            }
        }
    }

    /// Invoices each enterprise for the month that closed. Live payments
    /// only; sudo can send one sooner in test mode.
    pub(crate) async fn invoice_enterprises(&self) -> Result<()> {
        if !self.stripe.as_ref().is_some_and(crate::stripe::Stripe::live) {
            return Ok(());
        }
        let closing = crate::limits::previous_month(&rfc3339(now_ms())[..7]);
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let due = self
            .db
            .prepare(format!(
                "SELECT id FROM billing_accounts WHERE kind = 'enterprise' AND customer_id IS NOT NULL
                   AND NOT {full}
                   AND NOT EXISTS (SELECT 1 FROM enterprise_invoices i WHERE i.account_id = billing_accounts.id AND i.period = ?)",
                full = crate::sales::FULL_DISCOUNT_SQL
            ))
            .bind(&[closing.as_str().into()])?
            .all()
            .await?
            .results::<Id>()?;
        for Id { id } in due {
            if let Err(why) = self.invoice_enterprise(&id, &closing, "month close").await? {
                worker::console_log!("enterprise {id} not invoiced for {closing}: {why}");
            }
        }
        Ok(())
    }

    /// One invoice for what each of the enterprise's workspaces owes now.
    async fn invoice_enterprise(&self, id: &str, period: &str, by: &str) -> Result<std::result::Result<EnterpriseInvoice, String>> {
        if self.stripe.is_none() {
            return Ok(Err("Payments are not set up.".into()));
        }
        let Some(account) = self.enterprise(id).await? else { return Ok(Err("No such enterprise.".into())) };
        self.db.prepare(crate::enterprise_attempt::RETIRE).bind(&[id.into()])?.run().await?;
        if let Some(attempt) = self.enterprise_attempt(id).await? {
            return self.finish_enterprise_attempt(id, attempt).await;
        }
        #[derive(Deserialize)]
        struct Customer {
            customer_id: Option<String>,
        }
        let Some(customer) = self
            .db
            .prepare("SELECT customer_id FROM billing_accounts WHERE id = ?")
            .bind(&[id.into()])?
            .first::<Customer>(None)
            .await?
            .and_then(|row| row.customer_id)
        else {
            return Ok(Err("Set where the enterprise's invoices go first.".into()));
        };
        // What each workspace owes: its charges less what it has paid, and
        // less what is on invoices still open.
        let mut lines = vec![];
        let mut snapshots = vec![];
        for workspace in &account.workspaces {
            let balance = self.row(workspace).await?.map_or(0, |row| row.balance_micros);
            #[derive(Deserialize)]
            struct Sum {
                micros: Option<i64>,
            }
            let invoiced = self
                .db
                .prepare(
                    "SELECT SUM(l.amount_micros) AS micros FROM enterprise_invoice_lines l
                     JOIN enterprise_invoices i ON i.invoice_id = l.invoice_id
                     WHERE l.workspace = ? AND i.status IN ('open', 'overdue')",
                )
                .bind(&[workspace.as_str().into()])?
                .first::<Sum>(None)
                .await?
                .and_then(|s| s.micros)
                .unwrap_or(0);
            snapshots.push(crate::enterprise_attempt::Snapshot { workspace: workspace.clone(), balance, invoiced });
            let owed = (-balance).max(0) - invoiced;
            if owed >= 10_000 {
                // Store precisely what Stripe bills, including cent rounding.
                lines.push(InvoiceLine { workspace: workspace.clone(), amount_micros: ((owed + 9_999) / 10_000) * 10_000 });
            }
        }
        if lines.is_empty() {
            return Ok(Err("Its workspaces owe nothing to invoice.".into()));
        }
        let attempt = self
            .begin_enterprise_attempt(
                id,
                crate::enterprise_attempt::Request { customer, name: account.name, period: period.to_owned(), by: by.to_owned(), lines },
                snapshots,
            )
            .await?;
        self.finish_enterprise_attempt(id, attempt).await
    }

    async fn finish_enterprise_attempt(
        &self,
        id: &str,
        attempt: crate::enterprise_attempt::Attempt,
    ) -> Result<std::result::Result<EnterpriseInvoice, String>> {
        let Some(stripe) = &self.stripe else { return Ok(Err("Payments are not set up.".into())) };
        let request: crate::enterprise_attempt::Request =
            serde_json::from_str(&attempt.payload).map_err(|e| worker::Error::RustError(e.to_string()))?;
        let customer = request.customer;
        let name = request.name;
        let period = request.period.as_str();
        let by = request.by.as_str();
        let lines = request.lines;
        // Stripe Tax places the customer by its address; without one the
        // invoice could not be finalized, so it is not started.
        match stripe.customer_placed(&customer).await {
            Ok(true) => {}
            Ok(false) => {
                return Ok(Err(format!(
                    "Add {}'s billing address first (Invoices → Billing address): Stripe needs it to work out tax.",
                    name
                )));
            }
            Err(error) => return Ok(Err(crate::stripe::friendly(&error))),
        }
        // Invoiced, never by card: no card fee. Tax on top, by Stripe Tax.
        let mut fields = vec![
            ("customer", customer.clone()),
            ("auto_advance", "false".to_owned()),
            ("collection_method", "send_invoice".to_owned()),
            ("days_until_due", "30".to_owned()),
            ("pending_invoice_items_behavior", "exclude".to_owned()),
            ("description", format!("g1t usage for the {} enterprise", name)),
            ("metadata[g1t_enterprise]", id.to_owned()),
            ("metadata[g1t_attempt]", attempt.id.clone()),
            ("metadata[period]", period.to_owned()),
        ];
        fields.extend(crate::stripe::invoice_tax_fields());
        #[derive(Deserialize)]
        struct Invoice {
            id: String,
            status: String,
            #[serde(default)]
            hosted_invoice_url: Option<String>,
            #[serde(default)]
            amount_due: i64,
            /// The tax Stripe added, in cents (`tax`, in this API version).
            #[serde(default)]
            tax: Option<i64>,
        }
        // The draft first, keyed on what it bills, and its lines put on it:
        // an attempt that failed half way is found again, never billed again
        // by an invoice sweeping its pending lines in.
        let cents: Vec<i64> = lines.iter().map(|line| (line.amount_micros + 9_999) / 10_000).collect();
        let key = attempt.id;
        let too_old = !crate::invoice_attempt::safe_to_build(attempt.created_ms, now_ms());
        let draft: Invoice = if let Some(invoice_id) = attempt.invoice_id {
            stripe.get(&format!("/invoices/{invoice_id}")).await?
        } else {
            if too_old {
                return Ok(Err(format!("Invoice attempt {key} needs reconciliation before retrying an expired Stripe idempotency key.")));
            }
            let invoice: Invoice = stripe.post_idempotent("/invoices", &fields, &key).await?;
            self.db
                .prepare("UPDATE enterprise_invoice_attempts SET invoice_id=? WHERE id=?")
                .bind(&[invoice.id.as_str().into(), key.as_str().into()])?
                .run()
                .await?;
            invoice
        };
        if draft.status == "draft" {
            if too_old {
                return Ok(Err(format!("Draft {} needs reconciliation before rebuilding old invoice items.", draft.id)));
            }
            for (line, cents) in lines.iter().zip(&cents) {
                let mut fields = vec![
                    ("customer", customer.clone()),
                    ("invoice", draft.id.clone()),
                    ("amount", cents.to_string()),
                    ("currency", "usd".to_owned()),
                    ("description", format!("{}: g1t usage", line.workspace)),
                    ("metadata[workspace]", line.workspace.clone()),
                    ("metadata[g1t_attempt]", key.clone()),
                ];
                fields.extend(crate::stripe::item_tax_fields());
                let _: Value = stripe.post_idempotent("/invoiceitems", &fields, &format!("{key}/item/{}", line.workspace)).await?;
            }
            let _: Invoice = stripe.post_idempotent(&format!("/invoices/{}/finalize", draft.id), &[], &format!("{key}/finalize")).await?;
        }
        let current: Invoice = stripe.get(&format!("/invoices/{}", draft.id)).await?;
        let sent: Invoice = match current.status.as_str() {
            "open" => stripe.post_idempotent(&format!("/invoices/{}/send", draft.id), &[], &format!("{key}/send")).await?,
            "paid" | "void" | "uncollectible" => current,
            _ => return Ok(Err(format!("Invoice {} is not ready to send ({}).", current.id, current.status))),
        };
        let now = rfc3339(now_ms());
        // What the workspaces owe, before tax: the tax is the enterprise's
        // to pay on top, never their usage, and is kept apart.
        let tax_cents = sent.tax.unwrap_or(0).max(0);
        let total = lines.iter().map(|l| l.amount_micros).sum::<i64>().max((sent.amount_due - tax_cents) * 10_000);
        let mut writes = vec![self
            .db
            .prepare(
                "INSERT INTO enterprise_invoices (invoice_id, account_id, period, amount_micros, status, hosted_url, created_by, created_at)
                 SELECT ?, ?, ?, ?, 'open', ?, ?, ?
                 WHERE EXISTS (SELECT 1 FROM enterprise_invoice_attempts WHERE id=? AND completed=0)
                 ON CONFLICT (invoice_id) DO NOTHING",
            )
            .bind(&[
                sent.id.as_str().into(),
                id.into(),
                period.into(),
                (total as f64).into(),
                crate::optional(sent.hosted_invoice_url.as_deref()),
                by.into(),
                now.as_str().into(),
                key.as_str().into(),
            ])?];
        for line in &lines {
            writes.push(
                self.db
                    .prepare(
                        "INSERT INTO enterprise_invoice_lines (invoice_id, workspace, amount_micros)
                        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM enterprise_invoice_attempts WHERE id=? AND completed=0)
                        ON CONFLICT (invoice_id, workspace) DO NOTHING",
                    )
                    .bind(&[
                        sent.id.as_str().into(),
                        line.workspace.as_str().into(),
                        (line.amount_micros as f64).into(),
                        key.as_str().into(),
                    ])?,
            );
        }
        writes.push(self.db.prepare("UPDATE enterprise_invoice_attempts SET completed=1 WHERE id=?").bind(&[key.as_str().into()])?);
        self.db.batch(writes).await?;
        if sent.status == "paid" {
            self.enterprise_invoice_paid(&sent.id).await?;
        } else if matches!(sent.status.as_str(), "void" | "uncollectible") {
            self.enterprise_invoice_status(&sent.id, &sent.status).await?;
        }
        self.audit(id, "invoice", &format!("Invoice {} for {} sent ({period})", sent.id, crate::features::dollars(total)), by).await?;
        Ok(Ok(EnterpriseInvoice {
            invoice_id: sent.id,
            hosted_url: sent.hosted_invoice_url,
            amount_micros: total,
            status: sent.status,
            period: period.to_owned(),
            lines,
            created_at: now,
        }))
    }

    /// An enterprise invoice paid: each workspace is credited its line, and
    /// any stop for the invoice is lifted.
    ///
    /// Each line is credited before the invoice is marked paid, once by its
    /// ledger reference: a failure part way leaves it open, and the event
    /// again credits only the lines not yet credited.
    async fn enterprise_invoice_paid(&self, invoice_id: &str) -> Result<String> {
        let open = self
            .db
            .prepare("SELECT invoice_id FROM enterprise_invoices WHERE invoice_id = ? AND status <> 'paid'")
            .bind(&[invoice_id.into()])?
            .first::<Value>(None)
            .await?;
        if open.is_none() {
            return Ok("ignored: not an open enterprise invoice".to_owned());
        }
        // Read at billing's API version, before anything is written: the
        // event's copy may lack `tax` and `payment_intent`.
        let fetched: Option<Value> = match &self.stripe {
            Some(stripe) => Some(stripe.get(&format!("/invoices/{invoice_id}")).await?),
            None => None,
        };
        if fetched.as_ref().and_then(|i| i["status"].as_str()) != Some("paid") {
            return Ok("ignored: enterprise invoice is not paid".to_owned());
        }
        let lines = self.invoice_lines(invoice_id).await?;
        for line in &lines {
            let reference = format!("inv/{invoice_id}/{}", line.workspace);
            let seen = self
                .db
                .prepare("SELECT id FROM ledger WHERE reference = ?")
                .bind(&[reference.as_str().into()])?
                .first::<Value>(None)
                .await?;
            if seen.is_some() {
                continue;
            }
            let entered = self
                .enter(
                    &line.workspace,
                    EntryKind::TopUp,
                    line.amount_micros,
                    &format!("Paid on the enterprise's invoice {invoice_id}"),
                    &reference,
                    None,
                    None,
                    None,
                )
                .await;
            match entered {
                Ok(()) => {}
                Err(error) if crate::is_duplicate(&error) => {}
                Err(error) => return Err(error),
            }
        }
        // Its tax is the enterprise's, paid on top of what its workspaces
        // owed, and never credited to them.
        #[derive(Deserialize)]
        struct Account {
            account_id: String,
        }
        if let Some(account) = self
            .db
            .prepare("SELECT account_id FROM enterprise_invoices WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .first::<Account>(None)
            .await?
            && let Some(invoice) = &fetched
        {
            let extras = crate::tax::Extras { tax_cents: invoice["tax"].as_i64().unwrap_or(0).max(0), fee_cents: 0 };
            self.record_extras(&account.account_id, invoice_id, invoice["payment_intent"].as_str(), extras, None).await?;
        }
        // Complete only after all retryable accounting work succeeded.
        let mut completed = vec![
            self.db
                .prepare("UPDATE enterprise_invoices SET status = 'paid', paid_at = ? WHERE invoice_id = ? AND status <> 'paid'")
                .bind(&[rfc3339(now_ms()).into(), invoice_id.into()])?,
        ];
        // Clear a concurrent overdue stop in the same transaction that makes
        // the invoice terminal. A late stop checks this state atomically.
        for line in &lines {
            completed.push(self.db.prepare(crate::CLEAR_STOP).bind(&[line.workspace.as_str().into()])?);
        }
        self.db.batch(completed).await?;
        Ok(format!("invoice {invoice_id} paid; {} workspaces credited", lines.len()))
    }

    /// An enterprise invoice that went overdue stops its workspaces' work;
    /// one voided is simply closed.
    async fn enterprise_invoice_status(&self, invoice_id: &str, status: &str) -> Result<String> {
        let Some(stripe) = &self.stripe else { return Ok("ignored: payments off".into()) };
        let invoice: Value = stripe.get(&format!("/invoices/{invoice_id}")).await?;
        let status = match invoice["status"].as_str() {
            Some("paid") => return self.enterprise_invoice_paid(invoice_id).await,
            Some("void") => "void",
            Some("open") if status == "overdue" && invoice["due_date"].as_i64().is_some_and(|due| due < (now_ms() / 1000) as i64) => {
                "overdue"
            }
            _ => return Ok("ignored: invoice is no longer in the event's state".into()),
        };
        let updated = self.db.prepare(ENTERPRISE_STATUS).bind(&[status.into(), invoice_id.into()])?.first::<Value>(None).await?;
        if updated.is_none() {
            return Ok("ignored: not an open enterprise invoice".to_owned());
        }
        if status == "overdue" {
            let now = rfc3339(now_ms());
            for line in self.invoice_lines(invoice_id).await? {
                self.db
                    .prepare(ENTERPRISE_OVERDUE_STOP)
                    .bind(&[
                        line.workspace.as_str().into(),
                        now.as_str().into(),
                        format!("the enterprise's invoice {invoice_id} is overdue").into(),
                        invoice_id.into(),
                    ])?
                    .run()
                    .await?;
            }
        }
        Ok(format!("invoice {invoice_id} is {status}"))
    }

    async fn invoice_lines(&self, invoice_id: &str) -> Result<Vec<InvoiceLine>> {
        Ok(self
            .db
            .prepare("SELECT workspace, amount_micros FROM enterprise_invoice_lines WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .all()
            .await?
            .results::<LineRow>()?
            .into_iter()
            .map(|row| InvoiceLine { workspace: row.workspace, amount_micros: row.amount_micros })
            .collect())
    }

    /// An enterprise's invoices, newest first.
    pub(crate) async fn enterprise_invoices(&self, id: &str) -> Result<Vec<EnterpriseInvoice>> {
        let rows = self
            .db
            .prepare("SELECT * FROM enterprise_invoices WHERE account_id = ? ORDER BY created_at DESC LIMIT 24")
            .bind(&[JsValue::from(id)])?
            .all()
            .await?
            .results::<InvoiceRow>()?;
        let mut invoices = vec![];
        for row in rows {
            invoices.push(EnterpriseInvoice {
                lines: self.invoice_lines(&row.invoice_id).await?,
                invoice_id: row.invoice_id,
                hosted_url: row.hosted_url,
                amount_micros: row.amount_micros,
                status: row.status,
                period: row.period,
                created_at: row.created_at,
            });
        }
        Ok(invoices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_enterprise_invoice_attempted_again_is_the_same_invoice() {
        let lines = [("acme", 1_250), ("acme-labs", 99)];
        let key = enterprise_invoice_key("ent_1", "2026-09", &lines);
        assert_eq!(key, enterprise_invoice_key("ent_1", "2026-09", &lines));
        assert!(key.len() < 255 && key.starts_with("ent-invoice/ent_1/2026-09/"));
        // Different amounts, even with the same total, are a different invoice.
        assert_ne!(key, enterprise_invoice_key("ent_1", "2026-09", &[("acme", 1_300), ("acme-labs", 49)]));
        assert_ne!(key, enterprise_invoice_key("ent_1", "2026-10", &lines));
    }

    #[test]
    fn an_event_from_the_other_mode_is_ignored() {
        assert!(wrong_mode(Some(false), "live").is_some());
        assert!(wrong_mode(Some(true), "test").is_some());
        assert!(wrong_mode(Some(true), "live").is_none());
        assert!(wrong_mode(Some(false), "test").is_none());
        assert!(wrong_mode(None, "live").is_none());
    }

    #[test]
    fn a_dispute_won_after_it_was_lost_gives_back_what_it_took_once() {
        // Lost then won: the $46.40 taken back is given back.
        assert_eq!(restore_on_win(Some("lost"), "won", 46_400_000), 46_400_000);
        // Won from open, or won again (a redelivery): nothing.
        assert_eq!(restore_on_win(Some("open"), "won", 0), 0);
        assert_eq!(restore_on_win(None, "won", 0), 0);
        assert_eq!(restore_on_win(Some("won"), "won", 46_400_000), 0);
        assert!(!dispute_moves(Some("won"), "won"));
        assert_eq!(restore_on_win(Some("lost"), "lost", 46_400_000), 0);
        assert_eq!(restore_on_win(Some("lost"), "won", -5), 0);
        // Its own reference: unique, so a delivery alongside fails the
        // batch instead of giving it back twice; apart from the loss's.
        assert_eq!(won_reference("dp_1"), "dispute/dp_1/won");
        assert_ne!(won_reference("dp_1"), "dispute/dp_1");
        // What is owed comes down by it, never below nothing, before the
        // stop is cleared (which needs nothing owed).
        assert!(LOWER_DISPUTE_OWED.contains("MAX(0, dispute_owed_micros - ?2)"));
        assert!(crate::CLEAR_STOP.contains("dispute_owed_micros = 0"));
    }

    #[test]
    fn a_dispute_event_twice_or_late_changes_nothing() {
        assert!(dispute_moves(None, "open"));
        assert!(dispute_moves(None, "lost"));
        assert!(dispute_moves(Some("open"), "lost"));
        assert!(dispute_moves(Some("open"), "won"));
        assert!(dispute_moves(Some("lost"), "won"));
        // The same state again: nothing stopped, taken back or owed twice.
        for state in ["open", "won", "lost"] {
            assert!(!dispute_moves(Some(state), state), "{state}");
        }
        // A late `created` after the dispute was lost never re-opens it.
        assert!(!dispute_moves(Some("lost"), "open"));
    }

    #[test]
    fn a_refund_counts_what_earlier_refunds_took_back_wherever_they_were_kept() {
        assert!(ALREADY_REFUNDED_SQL.contains("FROM plan_payments WHERE invoice_id LIKE ?1"));
        assert!(ALREADY_REFUNDED_SQL.contains("FROM ledger WHERE reference LIKE ?1"));
        assert_eq!(crate::rename::parameters(ALREADY_REFUNDED_SQL), 1);
    }

    #[test]
    fn a_dispute_is_acted_on_as_it_stands_now() {
        for open in ["warning_needs_response", "warning_under_review", "needs_response", "under_review"] {
            assert_eq!(dispute_state(open), "open");
        }
        assert_eq!(dispute_state("won"), "won");
        assert_eq!(dispute_state("warning_closed"), "won");
        assert_eq!(dispute_state("lost"), "lost");
        // A lost dispute takes back only the credit: $50 paid as $46.40
        // credit, $1.60 card fee and $2 tax.
        assert_eq!(crate::tax::refund_split(5_000, 5_000, 200, 160).0, 4_640);
        // Lifting a stop for a won dispute leaves a declined card's.
        assert!(crate::CLEAR_STOP.contains("dispute_owed_micros = 0") && crate::CLEAR_STOP.contains("status = 'open'"));
        assert!(!DISPUTE_STOP.is_empty());
    }

    fn sign(payload: &str, secret: &str, t: i64) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("{t}.{payload}").as_bytes());
        format!("t={t},v1={}", hex::encode(mac.finalize().into_bytes()))
    }

    #[test]
    fn a_destination_misses_the_events_billing_handles_that_it_does_not_send() {
        let has: Vec<String> = EVENTS.iter().take(11).map(|e| (*e).to_owned()).collect();
        assert_eq!(missing_events(&has), EVENTS[11..].iter().map(|e| (*e).to_owned()).collect::<Vec<_>>());
        let all: Vec<String> = EVENTS.iter().map(|e| (*e).to_owned()).collect();
        assert!(missing_events(&all).is_empty());
        assert!(missing_events(&["*".to_owned()]).is_empty());
    }

    #[test]
    fn a_signed_event_is_believed_only_as_signed_and_only_fresh() {
        let payload = r#"{"id":"evt_1","type":"invoice.paid"}"#;
        let header = sign(payload, "whsec_test", 1_000_000);
        assert!(verify(payload, &header, "whsec_test", 1_000_010));
        assert!(!verify(payload, &header, "whsec_other", 1_000_010));
        assert!(!verify(&payload.replace("paid", "voided"), &header, "whsec_test", 1_000_010));
        assert!(!verify(payload, &header, "whsec_test", 1_000_000 + 301));
        assert!(!verify(payload, "v1=abc", "whsec_test", 1_000_000));
        assert!(!verify(payload, &format!("t={},v1=00", i64::MIN), "whsec_test", i64::MAX));
        assert!(!verify(payload, &format!("t={},v1=00", i64::MAX), "whsec_test", i64::MIN));
        // Stripe may sign with more than one secret while one is rolled.
        let both = format!("{},v1=00ff", sign(payload, "whsec_test", 1_000_000));
        assert!(verify(payload, &both, "whsec_test", 1_000_000));
    }
}
