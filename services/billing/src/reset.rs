//! A test workspace's billing, wiped: `admin_reset_billing`.
//!
//! While billing runs on Stripe's test key, staff can return a workspace
//! used for testing to how a new customer starts: no ledger, balance,
//! plan, limits, trial grant, invoices, holds, signals or cost rows. Its
//! workspace, members and repositories are not billing's and stay. Never
//! with a live Stripe key, never for a comped workspace, and never for one
//! an enterprise pays for. The reset itself is kept in the audit log, and
//! g1t's own counts of the workspace's git operations stay: they are what
//! Cloudflare's bill is compared with, not what the workspace owes.

use g1t_contracts::billing::{AdminResetBillingArgs, BillingReset};
use g1t_contracts::{FailureCode, Outcome};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;
use crate::accounts::own_account;

/// The statements, in order. Parameters: `?1` the workspace, `?2` its own
/// billing account (`ws_<slug>`).
pub(crate) const STATEMENTS: &[&str] = &[
    "DELETE FROM workspace_invoice_lines WHERE invoice_id IN (SELECT invoice_id FROM workspace_invoices WHERE workspace = ?1)",
    "DELETE FROM workspace_invoices WHERE workspace = ?1",
    "DELETE FROM ledger WHERE workspace = ?1",
    "DELETE FROM runs WHERE workspace = ?1",
    "DELETE FROM reservations WHERE workspace = ?1",
    "DELETE FROM checkouts WHERE workspace = ?1",
    "DELETE FROM accounts WHERE workspace = ?1",
    "DELETE FROM plan_payments WHERE workspace = ?1",
    "DELETE FROM subscriptions WHERE workspace = ?1",
    "DELETE FROM limits WHERE workspace = ?1",
    "DELETE FROM limit_requests WHERE workspace = ?1",
    "DELETE FROM trial_grants WHERE workspace = ?1",
    "DELETE FROM card_checks WHERE workspace = ?1",
    "DELETE FROM alerts_sent WHERE workspace = ?1",
    "DELETE FROM price_notices WHERE workspace = ?1",
    "DELETE FROM pending_usage WHERE workspace = ?1",
    "DELETE FROM pending_days WHERE workspace = ?1",
    "DELETE FROM month_closes WHERE workspace = ?1",
    "DELETE FROM storage_days WHERE workspace = ?1",
    "DELETE FROM package_storage_days WHERE workspace = ?1",
    "DELETE FROM sandbox_months WHERE workspace = ?1",
    "DELETE FROM token_usage WHERE workspace = ?1",
    "DELETE FROM spikes WHERE workspace = ?1",
    "DELETE FROM closed_workspaces WHERE workspace = ?1",
    "DELETE FROM sales_records WHERE workspace = ?1",
    "DELETE FROM sales_notes WHERE workspace = ?1",
    "DELETE FROM workspace_costs WHERE workspace = ?1",
    "DELETE FROM margin_alerts WHERE kind = 'workspace' AND subject = ?1",
    // Allowances drawn by the workspace, and its repositories' shares of
    // the open-source pool (`<slug>/<name>`, compared exactly).
    "DELETE FROM allowance_use WHERE scope = ?1 OR (kind = 'oss_repo' AND substr(scope, 1, length(?1) + 1) = ?1 || '/')",
    "DELETE FROM budget_alerts WHERE account = ?2",
    "DELETE FROM billing_accounts WHERE id = ?2",
];

impl Billing {
    pub(crate) async fn admin_reset_billing(&self, a: AdminResetBillingArgs) -> Result<Outcome<BillingReset>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "A reset needs a workspace and who did it."));
        }
        if a.note.trim().len() < 5 {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why it is reset, for whoever looks next."));
        }
        if a.confirm.trim() != workspace {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Type the workspace's slug, {workspace}, exactly, to reset it.")));
        }
        if self.stripe.as_ref().is_some_and(|s| s.live()) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Billing takes real cards: a workspace's billing is never wiped."));
        }
        #[derive(Deserialize)]
        struct Found {
            comped: i64,
            enterprise: i64,
        }
        let found = self
            .db
            .prepare(format!(
                "SELECT CASE WHEN ?1 IN ({}) THEN 1 ELSE 0 END AS comped,
                        (SELECT COUNT(*) FROM account_members WHERE workspace = ?1) AS enterprise",
                crate::sales::INTERNAL_SQL
            ))
            .bind(&[workspace.as_str().into()])?
            .first::<Found>(None)
            .await?;
        if let Some(found) = found {
            if found.comped > 0 {
                return Ok(Outcome::fail(FailureCode::Forbidden, format!("{workspace} is comped (g1t's own): its spend is a budget, kept.")));
            }
            if found.enterprise > 0 {
                return Ok(Outcome::fail(FailureCode::Forbidden, format!("An enterprise pays for {workspace}: move it off first.")));
            }
        }
        let account = own_account(&workspace);
        let mut batch = Vec::with_capacity(STATEMENTS.len());
        for sql in STATEMENTS {
            let values: Vec<JsValue> =
                [workspace.as_str(), account.as_str()][..crate::rename::parameters(sql)].iter().map(|v| (*v).into()).collect();
            batch.push(self.db.prepare(*sql).bind(&values)?);
        }
        let mut rows = 0usize;
        for result in self.db.batch(batch).await? {
            rows += result.meta()?.and_then(|m| m.changes).unwrap_or(0);
        }
        self.audit(&account, "reset", &format!("billing of {workspace} reset ({rows} rows): {}", a.note.trim()), &a.by).await?;
        Ok(Outcome::Ok(BillingReset { workspace, rows: rows as u32 }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_with_a_workspace_is_wiped_or_kept_on_purpose() {
        let all = STATEMENTS.join("\n");
        // What is kept: the audit log, and g1t's own counts compared with
        // Cloudflare's bill.
        let kept = ["admin_actions", "own_counts"];
        for table in [
            "ledger", "runs", "checkouts", "workspace_invoices", "workspace_invoice_lines", "sales_notes", "accounts",
            "pending_usage", "pending_days", "limits", "subscriptions", "month_closes", "sales_records",
            "billing_accounts", "allowance_use", "trial_grants", "storage_days", "package_storage_days",
            "sandbox_months", "token_usage", "reservations", "spikes", "limit_requests", "plan_payments",
            "card_checks", "alerts_sent", "price_notices", "closed_workspaces", "workspace_costs",
            "margin_alerts", "budget_alerts",
        ] {
            assert!(!kept.contains(&table));
            assert!(all.contains(&format!("DELETE FROM {table} WHERE")), "{table}");
        }
    }

    #[test]
    fn statements_name_at_most_the_workspace_and_its_account() {
        assert!(STATEMENTS.iter().all(|sql| crate::rename::parameters(sql) <= 2));
        assert_eq!(crate::rename::parameters(STATEMENTS.last().unwrap()), 2);
    }
}
