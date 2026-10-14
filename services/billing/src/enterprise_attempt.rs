use g1t_contracts::billing::InvoiceLine;
use serde::{Deserialize, Serialize};
use worker::Result;
use crate::Billing;

pub(crate) const RETIRE: &str = "DELETE FROM enterprise_invoice_attempts WHERE account_id=?1 AND completed=1";
// The snapshots used to calculate the invoice must still match at acquisition.
// In particular, a caller that read before another invoice committed must not
// invoice the same balance again after that attempt was retired.
pub(crate) const INSERT: &str = "INSERT OR IGNORE INTO enterprise_invoice_attempts (account_id,id,payload,created_ms)
 SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (
   SELECT 1 FROM json_each(?5) s
   WHERE COALESCE((SELECT balance_micros FROM accounts WHERE workspace=json_extract(s.value,'$.workspace')),0) <> json_extract(s.value,'$.balance')
     OR COALESCE((SELECT SUM(l.amount_micros) FROM enterprise_invoice_lines l JOIN enterprise_invoices i ON i.invoice_id=l.invoice_id
         WHERE l.workspace=json_extract(s.value,'$.workspace') AND i.status IN ('open','overdue')),0) <> json_extract(s.value,'$.invoiced')
     OR NOT EXISTS (SELECT 1 FROM account_members WHERE account_id=?1 AND workspace=json_extract(s.value,'$.workspace'))
 )";

#[derive(Serialize, Deserialize)]
pub(crate) struct Request {
    pub customer: String,
    pub name: String,
    pub period: String,
    pub by: String,
    pub lines: Vec<InvoiceLine>,
}

#[derive(Serialize)]
pub(crate) struct Snapshot {
    pub workspace: String,
    pub balance: i64,
    pub invoiced: i64,
}

#[derive(Deserialize)]
pub(crate) struct Attempt {
    pub id: String,
    pub payload: String,
    pub created_ms: u64,
    pub invoice_id: Option<String>,
}

impl Billing {
    pub(crate) async fn enterprise_attempt(&self, account: &str) -> Result<Option<Attempt>> {
        self.db.prepare("SELECT id,payload,created_ms,invoice_id FROM enterprise_invoice_attempts WHERE account_id=?")
            .bind(&[account.into()])?.first::<Attempt>(None).await
    }

    pub(crate) async fn begin_enterprise_attempt(&self, account: &str, request: Request, snapshots: Vec<Snapshot>) -> Result<Attempt> {
        let now = g1t_kit::now_ms();
        let json = |value| serde_json::to_string(value).map_err(|e| worker::Error::RustError(e.to_string()));
        let payload = json(&request)?;
        let snapshots = serde_json::to_string(&snapshots).map_err(|e| worker::Error::RustError(e.to_string()))?;
        self.db.prepare(INSERT).bind(&[
            account.into(), g1t_contracts::new_id("einv", now).into(), payload.into(), (now as f64).into(), snapshots.into(),
        ])?.run().await?;
        self.enterprise_attempt(account).await?.ok_or_else(|| worker::Error::RustError("Enterprise invoice balances changed; retry".into()))
    }
}
