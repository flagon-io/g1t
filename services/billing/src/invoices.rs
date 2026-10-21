//! A workspace's invoices from g1t.
//!
//! Every time g1t charges a workspace's card, it is a real Stripe invoice:
//! when each month closes, and when the workspace nears its limit mid-month
//! (a threshold invoice, as Cloudflare and Fly do). Each is itemised by
//! what was used since the last one, with any credit paid in advance taken
//! off and anything left unpaid from before added, so its total is exactly
//! what is owed. Stripe charges the card, emails the receipt, and keeps
//! the invoice and its PDF in the workspace's billing page.

use g1t_contracts::billing::{EntryKind, InvoiceItem, InvoicesArgs, WorkspaceInvoice};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;

/// The invoice's lines: what was used since the last one, by kind, then
/// whatever makes the total what is owed.
pub(crate) fn invoice_lines(used: &[(String, i64)], owed: i64) -> Vec<InvoiceItem> {
    let mut lines: Vec<InvoiceItem> = used
        .iter()
        .filter(|(_, amount)| *amount > 0)
        .map(|(kind, amount)| InvoiceItem { description: kind.clone(), amount_micros: *amount })
        .collect();
    let difference = owed - lines.iter().map(|l| l.amount_micros).sum::<i64>();
    if difference < 0 {
        lines.push(InvoiceItem { description: "Paid in advance".to_owned(), amount_micros: difference });
    } else if difference > 0 {
        lines.push(InvoiceItem { description: "Unpaid from earlier".to_owned(), amount_micros: difference });
    }
    lines
}

/// Each line in whole cents, for the card processor. Their sum is what is
/// owed rounded up to the next cent, never down: cutting each line to a
/// cent on its own would charge up to a cent less per line than is owed (and
/// a credit line a cent less of a credit), and leave the rest stranded under
/// the minimum charge. The cent each needs is given to the lines with the
/// largest fractions first.
pub(crate) fn line_cents(lines: &[InvoiceItem]) -> Vec<i64> {
    const MICROS_PER_CENT: i64 = 10_000;
    let total: i64 = lines.iter().map(|l| l.amount_micros).sum();
    let total_cents = total.div_euclid(MICROS_PER_CENT) + i64::from(total.rem_euclid(MICROS_PER_CENT) > 0);
    let mut cents: Vec<i64> = lines.iter().map(|l| l.amount_micros.div_euclid(MICROS_PER_CENT)).collect();
    let mut short = total_cents - cents.iter().sum::<i64>();
    let mut by_fraction: Vec<usize> = (0..lines.len()).collect();
    by_fraction.sort_by_key(|&i| std::cmp::Reverse(lines[i].amount_micros.rem_euclid(MICROS_PER_CENT)));
    for i in by_fraction {
        if short <= 0 || lines[i].amount_micros.rem_euclid(MICROS_PER_CENT) == 0 {
            break;
        }
        cents[i] += 1;
        short -= 1;
    }
    cents
}

/// Whether paying an invoice failed because the card said no (Stripe's
/// 402, a `card_error`), rather than because Stripe could not be reached,
/// was busy or failed itself. Only a decline stops a workspace's work.
pub(crate) fn is_decline(error: &str) -> bool {
    error.contains("answered 402") || error.contains("\"card_error\"")
}

/// The HTTP status in an error from the card processor ("the card
/// processor answered 400: …"), if it is one.
fn answered(error: &str) -> Option<u16> {
    let rest = error.split_once("the card processor answered ")?.1;
    rest.get(..3)?.parse().ok()
}

/// Whether Stripe refused to charge for good, for want of a way to pay:
/// a 400 or 404 `invalid_request_error` (no default payment method, a
/// payment method gone or unusable off session, and the like). Trying
/// again never changes that, so it stops like a decline, with Stripe's
/// reason. A 5xx, a 429 or no answer at all is tried again, and so is a
/// 401 or 403: g1t's key, never the payer's card.
pub(crate) fn needs_card(error: &str) -> bool {
    matches!(answered(error), Some(400 | 404)) && error.contains("\"invalid_request_error\"")
}

/// Stripe's own sentence in an error, else the error, short.
pub(crate) fn stripe_reason(error: &str) -> String {
    error
        .split_once(": ")
        .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
        .and_then(|body| body["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| error.to_owned())
        .chars()
        .take(200)
        .collect()
}

/// What charging an invoice came to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PayOutcome {
    Paid,
    /// The card said no: work stops until it is paid.
    Declined,
    /// Stripe will not charge it at all (no card it can use): work stops
    /// until one is added and it is paid, as for a decline.
    NeedsCard,
    /// Voided or marked uncollectible at Stripe meanwhile: never to be paid.
    Void,
    /// Stripe did not answer, or failed: tried again, nobody stopped.
    Retry,
}

/// What charging an invoice came to, from the invoice's status after the
/// attempt and the error the attempt came back with, if any.
pub(crate) fn pay_outcome(status: Option<&str>, error: Option<&str>) -> PayOutcome {
    match status {
        Some("paid") => PayOutcome::Paid,
        Some("void" | "uncollectible") => PayOutcome::Void,
        _ => match error {
            Some(error) if is_decline(error) => PayOutcome::Declined,
            Some(error) if needs_card(error) => PayOutcome::NeedsCard,
            _ => PayOutcome::Retry,
        },
    }
}

/// Whether `viewer` may see a workspace's invoices: its owners and billing
/// managers, as for its billing details; never any other member.
pub(crate) fn may_see_invoices(viewer: &g1t_contracts::Viewer, workspace: &str) -> bool {
    viewer.as_ref().is_some_and(|viewer| viewer.manages_billing(workspace))
}

/// What settling a workspace's unpaid invoices came to.
pub(crate) enum Settled {
    /// None is left unpaid; the last one paid now, if any.
    Clear(Option<WorkspaceInvoice>),
    /// One is still unpaid (declined, no card, or Stripe not finished):
    /// nothing else is invoiced until it is paid.
    Stop(std::result::Result<WorkspaceInvoice, String>),
}

/// A workspace invoice's draft: charged to the card, taxed by Stripe Tax,
/// and holding only the lines put on it, never whatever is pending on the
/// customer.
fn draft_fields(customer: &str, workspace: &str, reason: &str, period: &str, description: String) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("customer", customer.to_owned()),
        ("collection_method", "charge_automatically".to_owned()),
        ("auto_advance", "false".to_owned()),
        ("pending_invoice_items_behavior", "exclude".to_owned()),
        ("description", description),
        ("metadata[g1t_workspace]", workspace.to_owned()),
        ("metadata[reason]", reason.to_owned()),
        ("metadata[period]", period.to_owned()),
    ];
    fields.extend(crate::stripe::invoice_tax_fields());
    fields
}

/// One line, on the draft `invoice`, at g1t's tax code, excluding tax.
fn item_fields(customer: &str, invoice: &str, workspace: &str, description: &str, cents: i64) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("customer", customer.to_owned()),
        ("invoice", invoice.to_owned()),
        ("amount", cents.to_string()),
        ("currency", "usd".to_owned()),
        ("description", description.to_owned()),
        ("metadata[workspace]", workspace.to_owned()),
    ];
    fields.extend(crate::stripe::item_tax_fields());
    fields
}

/// Whether Stripe left an invoice a draft because Stripe Tax could not
/// place the customer.
pub(crate) fn needs_tax_location(invoice: &Value) -> bool {
    invoice["automatic_tax"]["status"].as_str() == Some("requires_location_inputs")
}

#[derive(Deserialize)]
struct InvoiceRow {
    invoice_id: String,
    workspace: String,
    reason: String,
    period: String,
    amount_micros: i64,
    status: String,
    hosted_url: Option<String>,
    pdf_url: Option<String>,
    created_at: String,
    #[serde(default)]
    fee_micros: i64,
    #[serde(default)]
    tax_micros: i64,
}

#[derive(Deserialize)]
struct LineRow {
    description: String,
    amount_micros: i64,
}

/// A Stripe invoice, as far as billing reads it.
#[derive(Deserialize)]
struct StripeInvoice {
    id: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    hosted_invoice_url: Option<String>,
    #[serde(default)]
    invoice_pdf: Option<String>,
    #[serde(default)]
    amount_paid: i64,
    #[serde(default)]
    charge: Option<String>,
    #[serde(default)]
    payment_intent: Option<String>,
    /// The tax Stripe added, in cents (`tax`, in this API version).
    #[serde(default)]
    tax: Option<i64>,
}

impl StripeInvoice {
    fn tax_cents(&self) -> i64 {
        self.tax.unwrap_or(0).max(0)
    }
}

impl Billing {
    /// Invoices the workspace for what it owes, charging its card. `Ok(Err)`
    /// says why not, when there was nothing to do or no card.
    pub(crate) async fn invoice_workspace(
        &self,
        workspace: &str,
        reason: &str,
        period: &str,
    ) -> Result<std::result::Result<WorkspaceInvoice, String>> {
        let Some(stripe) = &self.stripe else { return Ok(Err("Payments are not set up.".into())) };
        if self.row(workspace).await?.and_then(|row| row.customer_id).is_none() {
            return Ok(Err("No card on file.".into()));
        }
        // An invoice already sent and not paid is paid (or found paid, or
        // found voided) before any other is made: two invoices for the same
        // money would charge it twice. Once all are paid, what is owed
        // beyond them is invoiced too; one still unpaid stops here.
        let settled = match self.settle_unpaid_invoices(workspace).await? {
            Settled::Clear(paid) => paid,
            Settled::Stop(unpaid) => return Ok(unpaid),
        };
        if let Some(attempt) = self.pending_invoice_attempt(workspace).await? {
            return self.finish_invoice_attempt(workspace, attempt).await;
        }
        // Read again: paying an earlier invoice credited the balance.
        let Some(account) = self.row(workspace).await? else { return Ok(Err("Nothing billed yet.".into())) };
        let Some(customer) = account.customer_id else { return Ok(Err("No card on file.".into())) };
        // AI credit left (bought before g1t stopped selling it) props up the
        // balance but pays only for models: it is not money for anything else.
        let owed = self.owed_with(workspace, account.balance_micros).await?;
        // Nothing owed is nothing to invoice, whatever the reason: a limit
        // reached on usage not entered yet is not a charge. An earlier
        // invoice paid just now is what this came to.
        if owed <= 0 {
            return Ok(settled.ok_or_else(|| "Nothing is owed.".to_owned()));
        }
        // Only a month's close charges no less than the minimum
        // (`MIN_CHARGE_MICROS`); less carries over. A charge because a limit was reached always
        // goes through, whatever its size, so a new workspace's limit never
        // strands it.
        if reason == "month" && !crate::limits::worth_charging(owed, self.plans.min_charge_micros) {
            if let Some(paid) = settled {
                return Ok(Ok(paid));
            }
            return Ok(Err(format!(
                "{} is owed, under the {} minimum charge; it carries over to the next invoice.",
                crate::features::dollars(owed),
                crate::features::dollars(self.plans.min_charge_micros)
            )));
        }
        // What was used since the last invoice, by kind.
        #[derive(Deserialize)]
        struct Last {
            through_at: Option<String>,
        }
        let since = self
            .db
            .prepare("SELECT MAX(through_at) AS through_at FROM workspace_invoices WHERE workspace = ? AND status <> 'void'")
            .bind(&[workspace.into()])?
            .first::<Last>(None)
            .await?
            .and_then(|l| l.through_at)
            .unwrap_or_default();
        #[derive(Deserialize)]
        struct Used {
            kind: String,
            charged: Option<i64>,
        }
        let now = rfc3339(now_ms());
        let used: Vec<(String, i64)> = self
            .db
            .prepare(
                "SELECT CASE
                          WHEN task = 'sandbox' AND machine IS NOT NULL THEN 'Runner minutes, ' || machine
                          WHEN task = 'sandbox' THEN 'Sandbox time'
                          WHEN task = 'self_hosted' THEN 'Self-hosted runner time'
                          WHEN task = 'deployments' THEN 'Deployments: builds and usage past the plan'
                          WHEN task = 'security' THEN 'Security scans'
                          WHEN task = 'context' THEN 'Search embeddings'
                          WHEN task = 'storage' THEN 'Private repository storage'
                          WHEN task = 'git' THEN 'Git operations'
                          WHEN task = 'cache' THEN 'Actions cache storage'
                          WHEN task = 'domains' THEN 'Custom domains'
                          WHEN task = 'package_storage' THEN 'Package storage'
                          WHEN task = 'telemetry' THEN 'Observability data'
                          -- From when g1t ran agents and sold model access.
                          WHEN billed_to = 'workspace' THEN 'Runs on your own model provider'
                          WHEN reference LIKE 'run%' OR task = 'gateway' THEN 'Agents on g1t''s models'
                          ELSE 'Other usage' END AS kind,
                        -SUM(amount_micros) AS charged
                 FROM ledger WHERE workspace = ? AND kind = 'usage' AND created_at > ? AND created_at <= ?
                 GROUP BY 1 ORDER BY charged DESC",
            )
            .bind(&[workspace.into(), since.as_str().into(), now.as_str().into()])?
            .all()
            .await?
            .results::<Used>()?
            .into_iter()
            .map(|u| (u.kind, u.charged.unwrap_or(0)))
            .collect();
        let lines = invoice_lines(&used, owed);
        // Stripe Tax needs to know where the customer is. Without an
        // address nothing is charged: the owners are asked for one, and the
        // charge goes through once it is there.
        match stripe.customer_placed(&customer).await {
            Ok(true) => {}
            Ok(false) => {
                self.tax_address_needed(workspace).await?;
                return Ok(Err(crate::tax::address_needed_message(workspace)));
            }
            // A customer Stripe no longer has: forgotten, so the next card
            // saved makes a new one.
            Err(error) if crate::stripe::is_missing(&error) => {
                self.forget_customer(workspace).await?;
                return Ok(Err("No card on file.".into()));
            }
            Err(error) => return Err(error),
        }
        let attempt = self.begin_invoice_attempt(workspace, account.balance_micros, crate::invoice_attempt::Request {
            customer, workspace: workspace.to_owned(), reason: reason.to_owned(), period: period.to_owned(),
            through_at: now, lines,
        }).await?;
        self.finish_invoice_attempt(workspace, attempt).await
    }

    async fn finish_invoice_attempt(
        &self, workspace: &str, attempt: crate::invoice_attempt::Attempt,
    ) -> Result<std::result::Result<WorkspaceInvoice, String>> {
        let Some(stripe) = &self.stripe else { return Ok(Err("Payments are not set up.".into())) };
        let request: crate::invoice_attempt::Request = serde_json::from_str(&attempt.payload)
            .map_err(|e| worker::Error::RustError(e.to_string()))?;
        let customer = request.customer;
        let reason = request.reason.as_str();
        let period = request.period.as_str();
        let now = request.through_at;
        let lines = request.lines;
        let cents = line_cents(&lines);
        let key = attempt.id;
        let original_workspace = &request.workspace;
        let description = match reason {
            "month" => format!("g1t usage for {original_workspace}, {period}"),
            _ => format!("g1t usage for {original_workspace}, charged as it neared its limit"),
        };
        // The draft first, then its lines on it: lines left pending on the
        // customer by an attempt that failed half way would otherwise be
        // swept into the next invoice (this one's retry with a different
        // total, or the plan's renewal) on top of their own new lines.
        let too_old = !crate::invoice_attempt::safe_to_build(attempt.created_ms, now_ms());
        let draft: StripeInvoice = if let Some(id) = &attempt.invoice_id {
            stripe.get(&format!("/invoices/{id}")).await?
        } else {
            if too_old {
                return Err(worker::Error::RustError(format!("{workspace}: invoice attempt {key} needs reconciliation before retrying an expired Stripe idempotency key")));
            }
            let draft: StripeInvoice = stripe.post_idempotent(
                "/invoices", &draft_fields(&customer, &request.workspace, reason, period, description), &key,
            ).await?;
            self.db.prepare("UPDATE invoice_attempts SET invoice_id = ? WHERE id = ?")
                .bind(&[draft.id.as_str().into(), key.as_str().into()])?.run().await?;
            draft
        };
        if draft.status.as_deref() == Some("draft") {
            if too_old {
                return Err(worker::Error::RustError(format!("{workspace}: draft {} needs reconciliation before retrying expired invoice-item keys", draft.id)));
            }
            for (position, (line, cents)) in lines.iter().zip(&cents).enumerate() {
                let fields = item_fields(&customer, &draft.id, &request.workspace, &line.description, *cents);
                let _: Value = stripe.post_idempotent("/invoiceitems", &fields, &format!("{key}/item/{position}")).await?;
            }
        }
        // A retry finds it finalized already; that is fine.
        let finalized = stripe.post::<Value>(&format!("/invoices/{}/finalize", draft.id), &[]).await;
        if let Err(error) = &finalized
            && crate::stripe::is_tax_location_error(error)
        {
            self.tax_address_needed(workspace).await?;
            return Ok(Err(crate::tax::address_needed_message(workspace)));
        }
        if let Ok(left) = stripe.get::<Value>(&format!("/invoices/{}", draft.id)).await
            && left["status"].as_str() == Some("draft")
            && needs_tax_location(&left)
        {
            self.tax_address_needed(workspace).await?;
            return Ok(Err(crate::tax::address_needed_message(workspace)));
        }
        self.tax_address_given(workspace).await?;
        // Kept as open before the card is charged: whatever happens to the
        // charge, the invoice is known here, so paying it later (on Stripe's
        // page, or by the next attempt) is credited, and no second invoice
        // is made for the same money while it is open.
        let invoice: StripeInvoice = stripe.get(&format!("/invoices/{}", draft.id)).await?;
        let total = lines.iter().map(|l| l.amount_micros).sum::<i64>();
        let tax_micros = invoice.tax_cents() * 10_000;
        let mut writes = vec![self
            .db
            .prepare(
                "INSERT OR IGNORE INTO workspace_invoices
                   (invoice_id, workspace, reason, period, amount_micros, status, hosted_url, pdf_url, through_at, created_at, paid_at,
                    fee_micros, tax_micros)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                invoice.id.as_str().into(),
                workspace.into(),
                reason.into(),
                period.into(),
                (total as f64).into(),
                "open".into(),
                crate::optional(invoice.hosted_invoice_url.as_deref()),
                crate::optional(invoice.invoice_pdf.as_deref()),
                now.as_str().into(),
                now.as_str().into(),
                JsValue::NULL,
                // No card fee on new invoices; the column keeps old ones'.
                0.into(),
                (tax_micros as f64).into(),
            ])?];
        for (position, line) in lines.iter().enumerate() {
            writes.push(
                self.db
                    .prepare("INSERT OR IGNORE INTO workspace_invoice_lines (invoice_id, position, description, amount_micros) VALUES (?, ?, ?, ?)")
                    .bind(&[invoice.id.as_str().into(), (position as u32).into(), line.description.as_str().into(), (line.amount_micros as f64).into()])?,
            );
        }
        self.db.batch(writes).await?;
        self.pay_invoice(workspace, &invoice.id, 0).await
    }

    /// Charges the card for an invoice kept as open (or declined before),
    /// and records what came of it. Paid: credited, then marked paid. The
    /// card saying no, or Stripe refusing for want of a card it can charge:
    /// marked failed, and work stops until it is paid. Voided at Stripe
    /// meanwhile: closed here.
    /// Stripe failing to answer, or answering busy, is g1t's problem and
    /// never stops a payer: the invoice stays open, an `Err` says so, and
    /// the next attempt pays this same invoice.
    async fn pay_invoice(&self, workspace: &str, invoice_id: &str, fee_cents: i64) -> Result<std::result::Result<WorkspaceInvoice, String>> {
        let Some(stripe) = &self.stripe else { return Ok(Err("Payments are not set up.".into())) };
        let paid = stripe.post::<StripeInvoice>(&format!("/invoices/{invoice_id}/pay"), &[("off_session", "true".to_owned())]).await;
        let invoice: StripeInvoice = stripe.get(&format!("/invoices/{invoice_id}")).await?;
        let error = paid.as_ref().err().map(ToString::to_string);
        match pay_outcome(invoice.status.as_deref(), error.as_deref()) {
            PayOutcome::Paid => {
                self.credit_invoice(workspace, &invoice, fee_cents).await?;
                self.db
                    .prepare("UPDATE workspace_invoices SET status = 'paid', paid_at = ?, tax_micros = ? WHERE invoice_id = ?")
                    .bind(&[rfc3339(now_ms()).into(), ((invoice.tax_cents() * 10_000) as f64).into(), invoice_id.into()])?
                    .run()
                    .await?;
            }
            PayOutcome::Declined => {
                self.db
                    .prepare("UPDATE workspace_invoices SET status = 'failed' WHERE invoice_id = ? AND status <> 'paid'")
                    .bind(&[invoice_id.into()])?
                    .run()
                    .await?;
                let error = error.map_or_else(|| "the card was declined".to_owned(), |e| e.chars().take(200).collect());
                self.mark_declined(workspace, &error).await?;
            }
            PayOutcome::NeedsCard => {
                self.db
                    .prepare("UPDATE workspace_invoices SET status = 'failed' WHERE invoice_id = ? AND status <> 'paid'")
                    .bind(&[invoice_id.into()])?
                    .run()
                    .await?;
                let why = format!(
                    "Stripe could not charge the card on file ({}). Add a card on the Billing page.",
                    stripe_reason(error.as_deref().unwrap_or_default()).trim_end_matches('.')
                );
                self.mark_declined(workspace, &why).await?;
            }
            PayOutcome::Void => {
                self.void_row(invoice_id).await?;
                return Ok(Err(format!("Invoice {invoice_id} was voided at Stripe.")));
            }
            PayOutcome::Retry => {
                let why = error.unwrap_or_else(|| format!("invoice is {}", invoice.status.as_deref().unwrap_or("unknown")));
                return Err(worker::Error::RustError(format!(
                    "{workspace}: the card processor did not finish paying invoice {invoice_id}; it is tried again: {}",
                    why.chars().take(200).collect::<String>()
                )));
            }
        }
        Ok(self.workspace_invoice(invoice_id).await?.ok_or_else(|| "The invoice was not recorded.".to_owned()))
    }

    /// Settles the workspace's invoices that were sent but not paid
    /// (`open`, or `failed` for a decline) before another is made, oldest
    /// first: found paid at Stripe, credited; voided or gone, closed here;
    /// still open, charged again. Each paid goes on to the next; the first
    /// still unpaid after its charge stops it there.
    async fn settle_unpaid_invoices(&self, workspace: &str) -> Result<Settled> {
        let Some(stripe) = &self.stripe else { return Ok(Settled::Clear(None)) };
        #[derive(Deserialize)]
        struct Unpaid {
            invoice_id: String,
            #[serde(default)]
            fee_micros: i64,
        }
        let unpaid = self
            .db
            .prepare("SELECT invoice_id, fee_micros FROM workspace_invoices WHERE workspace = ? AND status IN ('open', 'failed') ORDER BY created_at")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<Unpaid>()?;
        let mut last_paid = None;
        for row in unpaid {
            let found = match stripe.get::<StripeInvoice>(&format!("/invoices/{}", row.invoice_id)).await {
                Ok(found) => found,
                // From another Stripe account: never to be paid here.
                Err(error) if crate::stripe::is_missing(&error) => {
                    self.void_row(&row.invoice_id).await?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let charged = match found.status.as_deref() {
                Some("paid") => {
                    self.workspace_invoice_paid(&row.invoice_id).await?;
                    last_paid = self.workspace_invoice(&row.invoice_id).await?.or(last_paid);
                    continue;
                }
                Some("void") | Some("uncollectible") => {
                    self.void_row(&row.invoice_id).await?;
                    continue;
                }
                Some("draft") => {
                    // Kept before it was finalized: finalize, then charge.
                    let _ = stripe.post::<Value>(&format!("/invoices/{}/finalize", row.invoice_id), &[]).await;
                    self.pay_invoice(workspace, &row.invoice_id, row.fee_micros / 10_000).await?
                }
                _ => self.pay_invoice(workspace, &row.invoice_id, row.fee_micros / 10_000).await?,
            };
            match charged {
                Ok(invoice) if invoice.status == "paid" => last_paid = Some(invoice),
                // Voided at Stripe as it was charged: closed, on to the next.
                Err(_) if self.workspace_invoice(&row.invoice_id).await?.is_some_and(|i| i.status == "void") => {}
                other => return Ok(Settled::Stop(other)),
            }
        }
        Ok(Settled::Clear(last_paid))
    }

    async fn void_row(&self, invoice_id: &str) -> Result<()> {
        self.db
            .prepare("UPDATE workspace_invoices SET status = 'void' WHERE invoice_id = ? AND status <> 'paid'")
            .bind(&[invoice_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A late `invoice.payment_failed` for a workspace invoice: the invoice
    /// is read as it is now, and a decline counts only if it is still
    /// unpaid (a retry or Stripe's page may have paid it since).
    pub(crate) async fn workspace_invoice_failed(&self, invoice_id: &str, tagged: &str) -> Result<String> {
        let Some(stripe) = &self.stripe else { return Ok("ignored: payments off".to_owned()) };
        let invoice: StripeInvoice = stripe.get(&format!("/invoices/{invoice_id}")).await?;
        if matches!(invoice.status.as_deref(), Some("paid" | "void" | "uncollectible")) {
            return Ok(format!("ignored: invoice {invoice_id} is {} now", invoice.status.as_deref().unwrap_or_default()));
        }
        // The invoice's own row names the workspace as it is now; the
        // metadata keeps the slug it was sent under.
        let workspace = self.workspace_of_invoice(invoice_id).await?.unwrap_or_else(|| tagged.to_owned());
        self.db
            .prepare("UPDATE workspace_invoices SET status = 'failed' WHERE invoice_id = ? AND status = 'open'")
            .bind(&[invoice_id.into()])?
            .run()
            .await?;
        self.mark_declined(&workspace, "the card was declined for an invoice").await?;
        Ok(format!("{workspace}: invoice payment failed; work stopped"))
    }

    /// Enters an invoice's payment once, with the kind of card that paid:
    /// what it paid for usage, never its tax or card fee, which are kept
    /// apart (`tax_and_fees`).
    async fn credit_invoice(&self, workspace: &str, invoice: &StripeInvoice, fee_cents: i64) -> Result<bool> {
        let seen = self
            .db
            .prepare("SELECT id FROM ledger WHERE reference = ?")
            .bind(&[invoice.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if seen.is_some() {
            return Ok(false);
        }
        let extras = crate::tax::Extras { tax_cents: invoice.tax_cents(), fee_cents };
        let amount = (invoice.amount_paid - extras.tax_cents - extras.fee_cents).max(0) * 10_000;
        if amount <= 0 {
            return Ok(false);
        }
        let description = format!("Paid invoice {}{}", invoice.id, crate::tax::paid_with(extras));
        let mut writes = self.entry_statements(workspace, EntryKind::TopUp, amount, &description, &invoice.id, None, None, None)?;
        writes.extend(self.after_entry_statements(workspace, "top_up", amount)?);
        writes.extend(self.extras_statements(workspace, &invoice.id, invoice.payment_intent.as_deref(), extras, None)?);
        match self.db.batch(writes).await {
            Ok(_) => {}
            // Credited a moment ago by the event or the charge alongside.
            Err(error) if crate::is_duplicate(&error) => return Ok(false),
            Err(error) => return Err(error),
        }
        // Prepaid cards pay, but never raise the limit.
        if let (Some(stripe), Some(charge)) = (&self.stripe, &invoice.charge)
            && let Ok(charge) = stripe.get::<Value>(&format!("/charges/{charge}")).await
                && let Some(funding) = charge["payment_method_details"]["card"]["funding"].as_str() {
                    self.db
                        .prepare("UPDATE ledger SET funding = ? WHERE reference = ?")
                        .bind(&[funding.into(), invoice.id.as_str().into()])?
                        .run()
                        .await?;
                }
        Ok(true)
    }

    pub(crate) async fn mark_declined(&self, workspace: &str, error: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO limits (workspace, autopay_failed_at, autopay_error, updated_at) VALUES (?1, ?2, ?3, ?2)
                 ON CONFLICT (workspace) DO UPDATE SET autopay_failed_at = ?2, autopay_error = ?3, updated_at = ?2",
            )
            .bind(&[workspace.into(), now.as_str().into(), error.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Why the workspace's card last could not be charged, while it still
    /// cannot.
    pub(crate) async fn autopay_error(&self, workspace: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            autopay_error: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT autopay_error FROM limits WHERE workspace = ? AND autopay_failed_at IS NOT NULL")
            .bind(&[workspace.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.autopay_error))
    }

    /// A workspace invoice paid later, on Stripe's page or by a retry. One
    /// g1t made but never kept (from before invoices were kept as open
    /// before they were charged) is found by its `metadata[g1t_workspace]`
    /// and kept now. Credited first, then marked paid. None when it is not
    /// a workspace invoice.
    pub(crate) async fn workspace_invoice_paid(&self, invoice_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
            #[serde(default)]
            fee_micros: i64,
        }
        let Some(stripe) = &self.stripe else { return Ok(None) };
        let kept = self
            .db
            .prepare("SELECT workspace, fee_micros FROM workspace_invoices WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .first::<Row>(None)
            .await?;
        // Read at billing's API version, whatever the event's was.
        let found: Value = stripe.get(&format!("/invoices/{invoice_id}")).await?;
        let invoice: StripeInvoice = serde_json::from_value(found.clone()).map_err(|e| worker::Error::RustError(e.to_string()))?;
        let row = match kept {
            Some(row) => row,
            None => {
                let Some(tagged) = found["metadata"]["g1t_workspace"].as_str().filter(|_| crate::webhooks::invoice_subscription(&found).is_none())
                else {
                    return Ok(None);
                };
                // Under its slug now, by its customer; else as it was sent.
                let workspace = match found["customer"].as_str() {
                    Some(customer) => self.workspace_of_customer(customer).await?,
                    None => None,
                }
                .unwrap_or_else(|| tagged.to_owned());
                let split = crate::stripe::invoice_split(&found, invoice.amount_paid);
                let created = rfc3339(found["created"].as_i64().unwrap_or(0).max(0) as u64 * 1000);
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO workspace_invoices
                           (invoice_id, workspace, reason, period, amount_micros, status, hosted_url, pdf_url, through_at, created_at, paid_at,
                            fee_micros, tax_micros)
                         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, ?, ?)",
                    )
                    .bind(&[
                        invoice_id.into(),
                        workspace.as_str().into(),
                        found["metadata"]["reason"].as_str().unwrap_or("month").into(),
                        found["metadata"]["period"].as_str().unwrap_or_default().into(),
                        ((split.net_cents * 10_000) as f64).into(),
                        crate::optional(invoice.hosted_invoice_url.as_deref()),
                        crate::optional(invoice.invoice_pdf.as_deref()),
                        created.as_str().into(),
                        created.as_str().into(),
                        ((split.fee_cents * 10_000) as f64).into(),
                        ((split.tax_cents * 10_000) as f64).into(),
                    ])?
                    .run()
                    .await?;
                Row { workspace, fee_micros: split.fee_cents * 10_000 }
            }
        };
        if invoice.status.as_deref() != Some("paid") {
            return Ok(Some(format!("ignored: invoice {invoice_id} is {} now", invoice.status.as_deref().unwrap_or("unknown"))));
        }
        let credited = self.credit_invoice(&row.workspace, &invoice, row.fee_micros / 10_000).await?;
        self.db
            .prepare("UPDATE workspace_invoices SET status = 'paid', paid_at = ?, tax_micros = ? WHERE invoice_id = ?")
            .bind(&[rfc3339(now_ms()).into(), ((invoice.tax_cents() * 10_000) as f64).into(), invoice_id.into()])?
            .run()
            .await?;
        Ok(Some(format!(
            "invoice {invoice_id} for {} paid{}",
            row.workspace,
            if credited { "" } else { " (already credited)" }
        )))
    }

    pub(crate) async fn workspace_invoices(&self, workspace: &str) -> Result<Vec<WorkspaceInvoice>> {
        let rows = self
            .db
            .prepare("SELECT * FROM workspace_invoices WHERE workspace = ? ORDER BY created_at DESC LIMIT 36")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<InvoiceRow>()?;
        let mut invoices = vec![];
        for row in rows {
            invoices.push(self.with_lines(row).await?);
        }
        Ok(invoices)
    }

    /// One workspace invoice as kept, with its lines.
    async fn workspace_invoice(&self, invoice_id: &str) -> Result<Option<WorkspaceInvoice>> {
        let row = self
            .db
            .prepare("SELECT * FROM workspace_invoices WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .first::<InvoiceRow>(None)
            .await?;
        Ok(match row {
            Some(row) => Some(self.with_lines(row).await?),
            None => None,
        })
    }

    async fn with_lines(&self, row: InvoiceRow) -> Result<WorkspaceInvoice> {
        let lines = self
            .db
            .prepare("SELECT description, amount_micros FROM workspace_invoice_lines WHERE invoice_id = ? ORDER BY position")
            .bind(&[row.invoice_id.as_str().into()])?
            .all()
            .await?
            .results::<LineRow>()?
            .into_iter()
            .map(|l| InvoiceItem { description: l.description, amount_micros: l.amount_micros })
            .collect();
        Ok(WorkspaceInvoice {
            invoice_id: row.invoice_id,
            workspace: row.workspace,
            reason: row.reason,
            period: row.period,
            amount_micros: row.amount_micros,
            status: row.status,
            hosted_url: row.hosted_url,
            pdf_url: row.pdf_url,
            lines,
            created_at: row.created_at,
            fee_micros: row.fee_micros,
            tax_micros: row.tax_micros,
        })
    }

    /// `invoices`: for the workspace's owners and billing managers, as its
    /// billing details are.
    pub(crate) async fn invoices(&self, a: InvoicesArgs) -> Result<Outcome<Vec<WorkspaceInvoice>>> {
        let workspace = a.workspace.to_lowercase();
        if !may_see_invoices(&a.viewer, &workspace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner or a billing manager can see a workspace's invoices."));
        }
        Ok(Outcome::Ok(self.workspace_invoices(&workspace).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invoice_adds_up_to_what_is_owed() {
        let used = vec![("Agents on g1t's models".to_owned(), 40_000_000), ("Sandbox time".to_owned(), 10_000_000)];
        // $10 of credit was paid in advance.
        let lines = invoice_lines(&used, 40_000_000);
        assert_eq!(lines.last().unwrap().description, "Paid in advance");
        assert_eq!(lines.iter().map(|l| l.amount_micros).sum::<i64>(), 40_000_000);
        // $5 was left unpaid from before.
        let lines = invoice_lines(&used, 55_000_000);
        assert_eq!(lines.last().unwrap().description, "Unpaid from earlier");
        assert_eq!(lines.iter().map(|l| l.amount_micros).sum::<i64>(), 55_000_000);
        // Exactly what was used.
        assert_eq!(invoice_lines(&used, 50_000_000).len(), 2);
    }

    #[test]
    fn an_invoice_holds_only_its_own_lines() {
        let draft = draft_fields("cus_1", "acme", "month", "2026-09", "g1t usage".to_owned());
        assert!(draft.contains(&("pending_invoice_items_behavior", "exclude".to_owned())));
        // Taxed by Stripe Tax, every line at g1t's tax code, excluding tax.
        assert!(draft.contains(&("automatic_tax[enabled]", "true".to_owned())));
        let line = item_fields("cus_1", "in_1", "acme", "Sandbox time", 61);
        assert!(line.contains(&("tax_code", crate::stripe::TAX_CODE.to_owned())));
        assert!(line.contains(&("tax_behavior", "exclusive".to_owned())));
        // Left a draft for want of an address: asked for, never charged.
        assert!(needs_tax_location(&serde_json::json!({ "automatic_tax": { "status": "requires_location_inputs" } })));
        assert!(!needs_tax_location(&serde_json::json!({ "automatic_tax": { "status": "complete" } })));
        let item = item_fields("cus_1", "in_1", "acme", "Sandbox time", 1_234);
        assert!(item.contains(&("invoice", "in_1".to_owned())));
        assert!(item.contains(&("amount", "1234".to_owned())));
    }

    #[test]
    fn only_the_card_saying_no_is_a_decline() {
        let declined = r#"the card processor answered 402: {"error": {"code": "card_declined", "type": "card_error"}}"#;
        assert!(is_decline(declined));
        assert!(is_decline(r#"the card processor answered 400: {"error": {"type": "card_error"}}"#));
        // Stripe down, busy or failing, or the network: tried again, nobody stopped.
        assert!(!is_decline(r#"the card processor answered 500: {"error": {"type": "api_error"}}"#));
        assert!(!is_decline(r#"the card processor answered 429: {"error": {"type": "rate_limit_error"}}"#));
        assert!(!is_decline("Network connection lost."));
    }

    #[test]
    fn only_owners_and_billing_managers_see_invoices() {
        let user = |role: &str, org_roles: &[&str]| -> g1t_contracts::Viewer {
            Some(
                serde_json::from_value(serde_json::json!({
                    "id": "u_1", "username": "ana",
                    "workspaces": [{ "slug": "acme", "role": role, "org_roles": org_roles }],
                }))
                .unwrap(),
            )
        };
        assert!(may_see_invoices(&user("owner", &[]), "acme"));
        assert!(may_see_invoices(&user("member", &["billing_manager"]), "acme"));
        assert!(!may_see_invoices(&user("member", &[]), "acme"));
        assert!(!may_see_invoices(&user("member", &["security_manager"]), "acme"));
        assert!(!may_see_invoices(&user("owner", &[]), "other"));
        assert!(!may_see_invoices(&None, "acme"));
    }

    const DECLINED: &str = r#"the card processor answered 402: {"error": {"code": "card_declined", "type": "card_error"}}"#;
    const NO_METHOD: &str = r#"the card processor answered 400: {"error": {"message": "This customer has no attached payment source or default payment method.", "type": "invalid_request_error"}}"#;

    #[test]
    fn only_a_paid_invoice_is_credited_and_only_a_decline_stops_work() {
        assert_eq!(pay_outcome(Some("paid"), None), PayOutcome::Paid);
        // Paid after all, whatever the attempt said.
        assert_eq!(pay_outcome(Some("paid"), Some(DECLINED)), PayOutcome::Paid);
        assert_eq!(pay_outcome(Some("open"), Some(DECLINED)), PayOutcome::Declined);
        // Stripe did not answer: kept open, tried again, nobody stopped.
        assert_eq!(pay_outcome(Some("open"), None), PayOutcome::Retry);
        assert_eq!(pay_outcome(None, None), PayOutcome::Retry);
        // Voided at Stripe meanwhile: closed, never charged.
        assert_eq!(pay_outcome(Some("void"), Some(NO_METHOD)), PayOutcome::Void);
    }

    #[test]
    fn a_refusal_for_want_of_a_card_stops_instead_of_retrying_for_ever() {
        assert!(needs_card(NO_METHOD));
        assert_eq!(pay_outcome(Some("open"), Some(NO_METHOD)), PayOutcome::NeedsCard);
        assert_eq!(stripe_reason(NO_METHOD), "This customer has no attached payment source or default payment method.");
        // Only 5xx, 429 and no answer are tried again.
        for transient in [
            r#"the card processor answered 500: {"error": {"type": "api_error"}}"#,
            r#"the card processor answered 429: {"error": {"type": "invalid_request_error", "code": "rate_limit"}}"#,
            "Network connection lost.",
        ] {
            assert!(!needs_card(transient), "{transient}");
            assert_eq!(pay_outcome(Some("open"), Some(transient)), PayOutcome::Retry, "{transient}");
        }
        // A key problem (401) is g1t's, never the payer's: tried again.
        assert!(!needs_card(r#"the card processor answered 401: {"error": {"type": "invalid_request_error"}}"#));
    }

    fn items(micros: &[i64]) -> Vec<InvoiceItem> {
        micros.iter().map(|&amount_micros| InvoiceItem { description: String::new(), amount_micros }).collect()
    }

    #[test]
    fn the_card_is_charged_what_is_owed_rounded_up_to_the_cent_never_down() {
        // $1.234567 + $2.345678 = $3.580245 owed: 359 cents, where cutting
        // each line would have charged 357.
        let cents = line_cents(&items(&[1_234_567, 2_345_678]));
        assert_eq!(cents.iter().sum::<i64>(), 359);
        assert_eq!(cents, vec![124, 235]);
        // Whole cents stay as they are.
        assert_eq!(line_cents(&items(&[40_000_000, 10_000_000])), vec![4_000, 1_000]);
        // A credit line keeps its full credit; the total still rounds up.
        // $50.004 used, $10.0025 paid in advance: $40.0015 owed, 4,001 cents.
        let cents = line_cents(&items(&[50_004_000, -10_002_500]));
        assert_eq!(cents.iter().sum::<i64>(), 4_001);
        // Lines under a cent each add up to the cents they make together.
        let cents = line_cents(&items(&[4_000, 4_000, 4_000]));
        assert_eq!(cents.iter().sum::<i64>(), 2);
        // Every invoice the close makes: never less than owed, never a cent more.
        for (used, owed) in [(vec![("a".to_owned(), 7_777_777), ("b".to_owned(), 3)], 6_000_001), (vec![("a".to_owned(), 5_000_001)], 5_000_001)] {
            let lines = invoice_lines(&used, owed);
            let charged = line_cents(&lines).iter().sum::<i64>() * 10_000;
            assert!(charged >= owed && charged - owed < 10_000, "{charged} for {owed}");
        }
    }
}
