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

/// A workspace invoice's draft: charged to the card, and holding only the
/// lines put on it, never whatever is pending on the customer.
fn draft_fields(customer: &str, workspace: &str, reason: &str, period: &str, description: String) -> Vec<(&'static str, String)> {
    vec![
        ("customer", customer.to_owned()),
        ("collection_method", "charge_automatically".to_owned()),
        ("auto_advance", "false".to_owned()),
        ("pending_invoice_items_behavior", "exclude".to_owned()),
        ("description", description),
        ("metadata[g1t_workspace]", workspace.to_owned()),
        ("metadata[reason]", reason.to_owned()),
        ("metadata[period]", period.to_owned()),
    ]
}

/// One line, on the draft `invoice`.
fn item_fields(customer: &str, invoice: &str, workspace: &str, description: &str, cents: i64) -> Vec<(&'static str, String)> {
    vec![
        ("customer", customer.to_owned()),
        ("invoice", invoice.to_owned()),
        ("amount", cents.to_string()),
        ("currency", "usd".to_owned()),
        ("description", description.to_owned()),
        ("metadata[workspace]", workspace.to_owned()),
    ]
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
        let Some(account) = self.row(workspace).await? else { return Ok(Err("Nothing billed yet.".into())) };
        let Some(customer) = account.customer_id else { return Ok(Err("No card on file.".into())) };
        let owed = (-account.balance_micros).max(0);
        // Only a month's close charges no less than the minimum
        // (`MIN_CHARGE_MICROS`), so a payment's fee is never most of it;
        // less carries over. A charge because a limit was reached always
        // goes through, whatever its size, so a new workspace's limit never
        // strands it.
        if reason == "month" && !crate::limits::worth_charging(owed, self.plans.min_charge_micros) {
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
                          WHEN task = 'sandbox' THEN 'Sandbox time'
                          WHEN task = 'self_hosted' THEN 'Self-hosted runner time'
                          WHEN task = 'deployments' THEN 'Deployments: builds and usage past the plan'
                          WHEN task = 'security' THEN 'Security scans'
                          WHEN task = 'context' THEN 'Search embeddings'
                          WHEN task = 'storage' THEN 'Private repository storage'
                          WHEN task = 'git' THEN 'Git operations'
                          WHEN billed_to = 'workspace' THEN 'Runs on your own model provider'
                          ELSE 'Agents on g1t''s models' END AS kind,
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
        let key = format!("ws-invoice/{workspace}/{reason}/{period}/{}", owed / 10_000);
        let description = match reason {
            "month" => format!("g1t usage for {workspace}, {period}"),
            _ => format!("g1t usage for {workspace}, charged as it neared its limit"),
        };
        // The draft first, then its lines on it: lines left pending on the
        // customer by an attempt that failed half way would otherwise be
        // swept into the next invoice (this one's retry with a different
        // total, or the plan's renewal) on top of their own new lines.
        let draft: StripeInvoice =
            stripe.post_idempotent("/invoices", &draft_fields(&customer, workspace, reason, period, description), &key).await?;
        let cents = line_cents(&lines);
        for (position, (line, cents)) in lines.iter().zip(&cents).enumerate() {
            let fields = item_fields(&customer, &draft.id, workspace, &line.description, *cents);
            let _: Value = stripe.post_idempotent("/invoiceitems", &fields, &format!("{key}/item/{position}")).await?;
        }
        // A retry finds it finalized already; that is fine.
        let _ = stripe.post::<Value>(&format!("/invoices/{}/finalize", draft.id), &[]).await;
        // Charge the card now; a decline comes back as an error.
        let paid = stripe.post::<StripeInvoice>(&format!("/invoices/{}/pay", draft.id), &[("off_session", "true".to_owned())]).await;
        let invoice: StripeInvoice = stripe.get(&format!("/invoices/{}", draft.id)).await?;
        let total = lines.iter().map(|l| l.amount_micros).sum::<i64>();
        let status = if invoice.status.as_deref() == Some("paid") { "paid" } else { "failed" };
        // Only the card saying no is a decline, which stops work until it
        // is paid. Stripe failing to answer, or answering busy, is g1t's
        // problem and never stops a payer: the invoice stays as it is, and
        // the next attempt (the same total finds the same invoice) pays it.
        if status == "failed" && !paid.as_ref().err().is_some_and(|error| is_decline(&error.to_string())) {
            return Ok(Err("The card processor did not finish the payment; it is tried again.".into()));
        }
        let mut writes = vec![self
            .db
            .prepare(
                "INSERT OR REPLACE INTO workspace_invoices
                   (invoice_id, workspace, reason, period, amount_micros, status, hosted_url, pdf_url, through_at, created_at, paid_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                invoice.id.as_str().into(),
                workspace.into(),
                reason.into(),
                period.into(),
                (total as f64).into(),
                status.into(),
                crate::optional(invoice.hosted_invoice_url.as_deref()),
                crate::optional(invoice.invoice_pdf.as_deref()),
                now.as_str().into(),
                now.as_str().into(),
                crate::optional((status == "paid").then_some(now.as_str())),
            ])?];
        for (position, line) in lines.iter().enumerate() {
            writes.push(
                self.db
                    .prepare("INSERT OR REPLACE INTO workspace_invoice_lines (invoice_id, position, description, amount_micros) VALUES (?, ?, ?, ?)")
                    .bind(&[invoice.id.as_str().into(), (position as u32).into(), line.description.as_str().into(), (line.amount_micros as f64).into()])?,
            );
        }
        self.db.batch(writes).await?;
        if status == "paid" {
            self.credit_invoice(workspace, &invoice).await?;
        } else {
            let error = paid.err().map_or_else(|| "the card was declined".to_owned(), |e| e.to_string().chars().take(200).collect());
            self.mark_declined(workspace, &error).await?;
        }
        Ok(Ok(WorkspaceInvoice {
            invoice_id: invoice.id,
            workspace: workspace.to_owned(),
            reason: reason.to_owned(),
            period: period.to_owned(),
            amount_micros: total,
            status: status.to_owned(),
            hosted_url: invoice.hosted_invoice_url,
            pdf_url: invoice.invoice_pdf,
            lines,
            created_at: now,
        }))
    }

    /// Enters an invoice's payment once, with the kind of card that paid.
    async fn credit_invoice(&self, workspace: &str, invoice: &StripeInvoice) -> Result<bool> {
        let seen = self
            .db
            .prepare("SELECT id FROM ledger WHERE reference = ?")
            .bind(&[invoice.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if seen.is_some() {
            return Ok(false);
        }
        let amount = invoice.amount_paid * 10_000;
        if amount <= 0 {
            return Ok(false);
        }
        self.enter(workspace, EntryKind::TopUp, amount, &format!("Paid invoice {}", invoice.id), &invoice.id, None, None, None, None)
            .await?;
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

    /// A workspace invoice paid later, on Stripe's page or by a retry.
    pub(crate) async fn workspace_invoice_paid(&self, invoice_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
        }
        let Some(row) = self
            .db
            .prepare("SELECT workspace FROM workspace_invoices WHERE invoice_id = ?")
            .bind(&[invoice_id.into()])?
            .first::<Row>(None)
            .await?
        else {
            return Ok(None);
        };
        let Some(stripe) = &self.stripe else { return Ok(None) };
        let invoice: StripeInvoice = stripe.get(&format!("/invoices/{invoice_id}")).await?;
        self.db
            .prepare("UPDATE workspace_invoices SET status = 'paid', paid_at = ? WHERE invoice_id = ?")
            .bind(&[rfc3339(now_ms()).into(), invoice_id.into()])?
            .run()
            .await?;
        let credited = self.credit_invoice(&row.workspace, &invoice).await?;
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
            invoices.push(WorkspaceInvoice {
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
            });
        }
        Ok(invoices)
    }

    /// `invoices`: for the workspace's members.
    pub(crate) async fn invoices(&self, a: InvoicesArgs) -> Result<Outcome<Vec<WorkspaceInvoice>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can see a workspace's invoices."));
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
