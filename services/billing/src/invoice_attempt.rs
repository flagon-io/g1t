//! Durable invoice requests. Stripe's idempotency cache is not a database:
//! freeze the request locally, and stop ambiguous old attempts for review.

use crate::Billing;
use serde::{Deserialize, Serialize};
use worker::Result;

pub(crate) const INSERT: &str = "INSERT OR IGNORE INTO invoice_attempts (id, workspace, payload, created_ms)
    SELECT ?1, ?2, ?3, ?4 FROM accounts WHERE workspace = ?2 AND balance_micros = ?5";
pub(crate) const RETIRE: &str = "DELETE FROM invoice_attempts WHERE workspace = ?1 AND invoice_id IN
    (SELECT invoice_id FROM workspace_invoices WHERE workspace = ?1 AND status IN ('paid', 'void'))";

#[derive(Serialize, Deserialize)]
pub(crate) struct Request {
    pub customer: String,
    pub workspace: String,
    pub reason: String,
    pub period: String,
    pub through_at: String,
    pub lines: Vec<g1t_contracts::billing::InvoiceItem>,
}

#[derive(Deserialize)]
pub(crate) struct Attempt {
    pub id: String,
    pub payload: String,
    pub created_ms: u64,
    pub invoice_id: Option<String>,
}

// Leave an hour before Stripe may prune the idempotency key. An unfinished
// older draft needs reconciliation, never a blind second charge or line.
pub(crate) fn safe_to_build(created: u64, now: u64) -> bool {
    now.saturating_sub(created) < 23 * 60 * 60 * 1000
}

impl Billing {
    pub(crate) async fn pending_invoice_attempt(&self, workspace: &str) -> Result<Option<Attempt>> {
        self.db.prepare(RETIRE).bind(&[workspace.into()])?.run().await?;
        self.db
            .prepare("SELECT id, payload, created_ms, invoice_id FROM invoice_attempts WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Attempt>(None)
            .await
    }

    pub(crate) async fn begin_invoice_attempt(&self, workspace: &str, balance: i64, request: Request) -> Result<Attempt> {
        let now = g1t_kit::now_ms();
        let payload = serde_json::to_string(&request).map_err(|e| worker::Error::RustError(e.to_string()))?;
        self.db
            .prepare(INSERT)
            .bind(&[
                g1t_contracts::new_id("invoice", now).into(),
                workspace.into(),
                payload.into(),
                (now as f64).into(),
                (balance as f64).into(),
            ])?
            .run()
            .await?;
        // Do not retire here: another caller may just have completed this
        // same attempt. Return it, rather than starting another invoice.
        self.db
            .prepare("SELECT id, payload, created_ms, invoice_id FROM invoice_attempts WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Attempt>(None)
            .await?
            .ok_or_else(|| worker::Error::RustError("Invoice attempt changed; retry".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_idempotency_keys_are_never_reused_to_build_an_invoice() {
        assert!(safe_to_build(1_000, 1_000 + 23 * 60 * 60 * 1000 - 1));
        assert!(!safe_to_build(1_000, 1_000 + 23 * 60 * 60 * 1000));
        assert!(!safe_to_build(0, u64::MAX));
    }
}
