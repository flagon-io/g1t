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
//!   mode, and its signing secret is kept in billing's database. It is never
//!   shown, and nothing can be posted here without it.
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
    AdminEnterpriseBillingArgs, AdminInvoiceEnterpriseArgs, AdminStripeArgs, BillingAccount, EnterpriseInvoice,
    EntryKind, InvoiceLine, StripeEventSummary, StripeStatus, StripeWebhook, StripeWebhookArgs,
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
    if (now_seconds - timestamp).abs() > TOLERANCE_SECONDS {
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
        Ok(StripeStatus {
            mode: self.mode().to_owned(),
            secret_set: self.webhook_secret.is_some(),
            webhook,
            missing_events,
            recent_events,
            error,
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
            "customer.subscription.updated" | "customer.subscription.deleted" => {
                self.settle_subscription(&text("id")).await?
            }
            "invoice.paid" => {
                if let Some(subscription) = object["subscription"].as_str() {
                    self.plan_paid(subscription, &text("id"), object["amount_paid"].as_i64().unwrap_or(0)).await?;
                    self.settle_subscription(subscription).await?
                } else if let Some(done) = self.workspace_invoice_paid(&text("id")).await? {
                    done
                } else {
                    self.enterprise_invoice_paid(&text("id")).await?
                }
            }
            "invoice.payment_failed" => match (object["subscription"].as_str(), object["metadata"]["g1t_workspace"].as_str()) {
                (Some(subscription), _) => self.settle_subscription(subscription).await?,
                (None, Some(tagged)) => {
                    // The invoice's own row names the workspace as it is
                    // now; the metadata keeps the slug it was sent under.
                    let workspace = self.workspace_of_invoice(&text("id")).await?.unwrap_or_else(|| tagged.to_owned());
                    let workspace = workspace.as_str();
                    self.mark_declined(workspace, "the card was declined for an invoice").await?;
                    format!("{workspace}: invoice payment failed; work stopped")
                }
                _ => "ignored: not g1t's".to_owned(),
            },
            "invoice.overdue" => self.enterprise_invoice_status(&text("id"), "overdue").await?,
            "invoice.voided" => self.enterprise_invoice_status(&text("id"), "void").await?,
            "charge.refunded" => self.refunded(object).await?,
            "charge.dispute.created" => self.disputed(object, true).await?,
            "charge.dispute.closed" => self.disputed(object, object["status"].as_str() == Some("lost")).await?,
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
    async fn settle_checkout(&self, session_id: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Open {
            workspace: String,
            created_by: String,
            feature: Option<String>,
        }
        let Some(open) = self
            .db
            .prepare("SELECT workspace, created_by, feature FROM checkouts WHERE id = ? AND status = 'open'")
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
        let Some(stripe) = &self.stripe else { return Ok("ignored: payments off".to_owned()) };
        let session = stripe.session(session_id).await?;
        if session.payment_status != "paid" && open.feature.is_none() {
            return Ok("ignored: not paid".to_owned());
        }
        let claimed = self
            .db
            .prepare("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open' RETURNING id")
            .bind(&[session_id.into()])?
            .first::<Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok("ignored: settled meanwhile".to_owned());
        }
        match open.feature.as_deref() {
            None => {
                let cents = i64::from(session.amount_total.unwrap_or(0));
                self.enter(
                    &open.workspace,
                    EntryKind::TopUp,
                    cents * 10_000,
                    "Paid in advance",
                    &session.id,
                    None,
                    None,
                    Some(&open.created_by),
                    session.customer.as_deref(),
                )
                .await?;
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
                Ok(format!("{} plan started for {}", feature.title(), open.workspace))
            }
        }
    }

    /// The plan's monthly price, paid: revenue that never goes through the
    /// ledger, recorded once per invoice for sudo's figures and for trust.
    async fn plan_paid(&self, subscription_id: &str, invoice_id: &str, amount_cents: i64) -> Result<()> {
        if amount_cents <= 0 || invoice_id.is_empty() {
            return Ok(());
        }
        self.db
            .prepare(
                "INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at)
                 SELECT ?1, workspace, ?2, ?3 FROM subscriptions WHERE subscription_id = ?4
                 ON CONFLICT (invoice_id) DO NOTHING",
            )
            .bind(&[
                invoice_id.into(),
                ((amount_cents * 10_000) as f64).into(),
                rfc3339(now_ms()).into(),
                subscription_id.into(),
            ])?
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
        let Some(plan) = self
            .db
            .prepare("SELECT workspace, feature, started_by FROM subscriptions WHERE subscription_id = ?")
            .bind(&[subscription_id.into()])?
            .first::<Plan>(None)
            .await?
        else {
            return Ok("ignored: not a g1t plan".to_owned());
        };
        let (Some(stripe), Some(feature)) = (&self.stripe, g1t_contracts::billing::Feature::parse(&plan.feature)) else {
            return Ok("ignored".to_owned());
        };
        let subscription = stripe.subscription(subscription_id).await?;
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
    async fn workspace_of_invoice(&self, invoice_id: &str) -> Result<Option<String>> {
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

    /// Money given back: what was paid is less, by the refund.
    async fn refunded(&self, charge: &Value) -> Result<String> {
        let Some(customer) = charge["customer"].as_str() else { return Ok("ignored: no customer".to_owned()) };
        let Some(workspace) = self.workspace_of_customer(customer).await? else {
            return Ok("ignored: not a workspace's customer".to_owned());
        };
        let refunded = charge["amount_refunded"].as_i64().unwrap_or(0);
        if refunded <= 0 {
            return Ok("ignored: nothing refunded".to_owned());
        }
        // Each refund total once, so partial refunds add up correctly.
        let charge_id = charge["id"].as_str().unwrap_or_default();
        #[derive(Deserialize)]
        struct Sum {
            micros: Option<i64>,
        }
        let already = self
            .db
            .prepare("SELECT -SUM(amount_micros) AS micros FROM ledger WHERE reference LIKE ?")
            .bind(&[format!("refund/{charge_id}/%").into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0);
        let new = refunded * 10_000 - already;
        if new <= 0 {
            return Ok("ignored: refund already recorded".to_owned());
        }
        self.enter(
            &workspace,
            EntryKind::TopUp,
            -new,
            "Refunded to the card",
            &format!("refund/{charge_id}/{refunded}"),
            None,
            None,
            None,
            None,
        )
        .await?;
        Ok(format!("refund of {} recorded for {workspace}", crate::features::dollars(new)))
    }

    /// A disputed payment stops the workspace's work until it is resolved;
    /// one closed in the workspace's favour lets it go on.
    async fn disputed(&self, dispute: &Value, stop: bool) -> Result<String> {
        let Some(stripe) = &self.stripe else { return Ok("ignored".to_owned()) };
        let Some(charge_id) = dispute["charge"].as_str() else { return Ok("ignored: no charge".to_owned()) };
        let charge: Value = stripe.get(&format!("/charges/{charge_id}")).await?;
        let Some(workspace) = (match charge["customer"].as_str() {
            Some(customer) => self.workspace_of_customer(customer).await?,
            None => None,
        }) else {
            return Ok("ignored: not a workspace's customer".to_owned());
        };
        let now = rfc3339(now_ms());
        // The disputed payment never counts toward trust again.
        for reference in [charge["payment_intent"].as_str(), charge["invoice"].as_str()].into_iter().flatten() {
            self.db
                .prepare("UPDATE ledger SET disputed = ? WHERE workspace = ? AND reference = ?")
                .bind(&[(if stop { 1 } else { 0 }).into(), workspace.as_str().into(), reference.into()])?
                .run()
                .await?;
        }
        if stop {
            self.db
                .prepare(
                    "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at) VALUES (?1, ?2, ?3, ?2)
                     ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2",
                )
                .bind(&[workspace.as_str().into(), now.as_str().into(), "a payment was disputed with the card's bank".into()])?
                .run()
                .await?;
        } else {
            self.db
                .prepare("UPDATE limits SET autopay_failed_at = NULL, autopay_error = NULL WHERE workspace = ?")
                .bind(&[workspace.as_str().into()])?
                .run()
                .await?;
        }
        let account = self.account_of(&workspace).await?;
        let what = if stop { "dispute: work stopped" } else { "dispute closed in the workspace's favour" };
        self.audit(&account.id, "dispute", &format!("{workspace}: {what}"), "stripe").await?;
        Ok(format!("{workspace}: {what}"))
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
        let fields = [
            ("name", row.name.clone()),
            ("email", email.clone()),
            ("metadata[g1t_enterprise]", a.id.clone()),
        ];
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

    pub(crate) async fn admin_invoice_enterprise(&self, a: AdminInvoiceEnterpriseArgs) -> Result<Outcome<EnterpriseInvoice>> {
        if a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is sending it."));
        }
        match self.invoice_enterprise(&a.id, "now", &a.by).await? {
            Ok(invoice) => Ok(Outcome::Ok(invoice)),
            Err(why) => Ok(Outcome::fail(FailureCode::Conflict, why)),
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
        let Some(stripe) = &self.stripe else { return Ok(Err("Payments are not set up.".into())) };
        let Some(account) = self.enterprise(id).await? else { return Ok(Err("No such enterprise.".into())) };
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
            let owed = (-balance).max(0) - invoiced;
            if owed >= 10_000 {
                lines.push(InvoiceLine { workspace: workspace.clone(), amount_micros: owed });
            }
        }
        if lines.is_empty() {
            return Ok(Err("Its workspaces owe nothing to invoice.".into()));
        }
        let fields = [
            ("customer", customer.clone()),
            ("collection_method", "send_invoice".to_owned()),
            ("days_until_due", "30".to_owned()),
            ("pending_invoice_items_behavior", "exclude".to_owned()),
            ("description", format!("g1t usage for the {} enterprise", account.name)),
            ("metadata[g1t_enterprise]", id.to_owned()),
            ("metadata[period]", period.to_owned()),
        ];
        #[derive(Deserialize)]
        struct Invoice {
            id: String,
            #[serde(default)]
            hosted_invoice_url: Option<String>,
            #[serde(default)]
            amount_due: i64,
        }
        // The draft first, keyed on what it bills, and its lines put on it:
        // an attempt that failed half way is found again, never billed again
        // by an invoice sweeping its pending lines in.
        let cents: Vec<i64> = lines.iter().map(|line| (line.amount_micros + 9_999) / 10_000).collect();
        let keyed: Vec<(&str, i64)> = lines.iter().zip(&cents).map(|(line, cents)| (line.workspace.as_str(), *cents)).collect();
        let key = enterprise_invoice_key(id, period, &keyed);
        let draft: Invoice = stripe.post_idempotent("/invoices", &fields, &key).await?;
        for (line, cents) in lines.iter().zip(&cents) {
            let fields = [
                ("customer", customer.clone()),
                ("invoice", draft.id.clone()),
                ("amount", cents.to_string()),
                ("currency", "usd".to_owned()),
                ("description", format!("{}: g1t usage", line.workspace)),
                ("metadata[workspace]", line.workspace.clone()),
            ];
            let _: Value = stripe.post_idempotent("/invoiceitems", &fields, &format!("{key}/item/{}", line.workspace)).await?;
        }
        // A retry finds it finalized already; that is fine.
        let _ = stripe.post::<Value>(&format!("/invoices/{}/finalize", draft.id), &[]).await;
        let sent: Invoice = stripe.post(&format!("/invoices/{}/send", draft.id), &[]).await?;
        let now = rfc3339(now_ms());
        let total = lines.iter().map(|l| l.amount_micros).sum::<i64>().max(sent.amount_due * 10_000);
        let mut writes = vec![self
            .db
            .prepare(
                "INSERT INTO enterprise_invoices (invoice_id, account_id, period, amount_micros, status, hosted_url, created_by, created_at)
                 VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
            )
            .bind(&[
                sent.id.as_str().into(),
                id.into(),
                period.into(),
                (total as f64).into(),
                crate::optional(sent.hosted_invoice_url.as_deref()),
                by.into(),
                now.as_str().into(),
            ])?];
        for line in &lines {
            writes.push(
                self.db
                    .prepare("INSERT INTO enterprise_invoice_lines (invoice_id, workspace, amount_micros) VALUES (?, ?, ?)")
                    .bind(&[sent.id.as_str().into(), line.workspace.as_str().into(), (line.amount_micros as f64).into()])?,
            );
        }
        self.db.batch(writes).await?;
        self.audit(id, "invoice", &format!("Invoice {} for {} sent ({period})", sent.id, crate::features::dollars(total)), by)
            .await?;
        Ok(Ok(EnterpriseInvoice {
            invoice_id: sent.id,
            hosted_url: sent.hosted_invoice_url,
            amount_micros: total,
            status: "open".to_owned(),
            period: period.to_owned(),
            lines,
            created_at: now,
        }))
    }

    /// An enterprise invoice paid: each workspace is credited its line, and
    /// any stop for the invoice is lifted.
    async fn enterprise_invoice_paid(&self, invoice_id: &str) -> Result<String> {
        let claimed = self
            .db
            .prepare(
                "UPDATE enterprise_invoices SET status = 'paid', paid_at = ? WHERE invoice_id = ? AND status <> 'paid'
                 RETURNING invoice_id",
            )
            .bind(&[rfc3339(now_ms()).into(), invoice_id.into()])?
            .first::<Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok("ignored: not an open enterprise invoice".to_owned());
        }
        let lines = self.invoice_lines(invoice_id).await?;
        for line in &lines {
            self.enter(
                &line.workspace,
                EntryKind::TopUp,
                line.amount_micros,
                &format!("Paid on the enterprise's invoice {invoice_id}"),
                &format!("inv/{invoice_id}/{}", line.workspace),
                None,
                None,
                None,
                None,
            )
            .await?;
        }
        Ok(format!("invoice {invoice_id} paid; {} workspaces credited", lines.len()))
    }

    /// An enterprise invoice that went overdue stops its workspaces' work;
    /// one voided is simply closed.
    async fn enterprise_invoice_status(&self, invoice_id: &str, status: &str) -> Result<String> {
        let updated = self
            .db
            .prepare("UPDATE enterprise_invoices SET status = ? WHERE invoice_id = ? AND status <> 'paid' RETURNING invoice_id")
            .bind(&[status.into(), invoice_id.into()])?
            .first::<Value>(None)
            .await?;
        if updated.is_none() {
            return Ok("ignored: not an open enterprise invoice".to_owned());
        }
        if status == "overdue" {
            let now = rfc3339(now_ms());
            for line in self.invoice_lines(invoice_id).await? {
                self.db
                    .prepare(
                        "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at) VALUES (?1, ?2, ?3, ?2)
                         ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2",
                    )
                    .bind(&[line.workspace.as_str().into(), now.as_str().into(), format!("the enterprise's invoice {invoice_id} is overdue").into()])?
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
        // Stripe may sign with more than one secret while one is rolled.
        let both = format!("{},v1=00ff", sign(payload, "whsec_test", 1_000_000));
        assert!(verify(payload, &both, "whsec_test", 1_000_000));
    }
}
