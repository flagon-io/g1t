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
    "DELETE FROM credit_grants WHERE workspace = ?1",
    "DELETE FROM card_checks WHERE workspace = ?1",
    "DELETE FROM alerts_sent WHERE workspace = ?1",
    "DELETE FROM price_notices WHERE workspace = ?1",
    "DELETE FROM pending_usage WHERE workspace = ?1",
    "DELETE FROM pending_days WHERE workspace = ?1",
    "DELETE FROM month_closes WHERE workspace = ?1",
    "DELETE FROM storage_days WHERE workspace = ?1",
    "DELETE FROM package_storage_days WHERE workspace = ?1",
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
    pub(crate) async fn admin_reset_billing(&self, env: &worker::Env, a: AdminResetBillingArgs) -> Result<Outcome<BillingReset>> {
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
        // The margin figures still hold the workspace's past usage: redo
        // them now (the day's analysis: the bill, 31 days, the alerts), so
        // the pages show the reset at once.
        let refreshed = match self.costs_daily(env, &crate::keeper::Keeper::from_env(env)).await {
            Ok(run) => run.problems.is_empty(),
            Err(error) => {
                worker::console_error!("costs after a reset of {workspace}: {error}");
                false
            }
        };
        Ok(Outcome::Ok(BillingReset { workspace, rows: rows as u32, refreshed }))
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
            "billing_accounts", "allowance_use", "trial_grants", "credit_grants", "storage_days", "package_storage_days",
            "token_usage", "reservations", "spikes", "limit_requests", "plan_payments",
            "card_checks", "alerts_sent", "price_notices", "closed_workspaces", "workspace_costs",
            "margin_alerts", "budget_alerts",
        ] {
            assert!(!kept.contains(&table));
            assert!(all.contains(&format!("DELETE FROM {table} WHERE")), "{table}");
        }
    }

    /// The tables the migrations leave: every one made, less those dropped.
    fn live_tables() -> std::collections::BTreeSet<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        let mut live = std::collections::BTreeSet::new();
        for file in files {
            let sql = std::fs::read_to_string(file).unwrap();
            for line in sql.lines().map(str::trim) {
                let words: Vec<&str> = line.split(|c: char| c.is_whitespace() || c == '(' || c == ';').filter(|w| !w.is_empty()).collect();
                let name = |at: usize| words.get(at).map(|w| w.to_string());
                match words.as_slice() {
                    ["CREATE", "TABLE", "IF", "NOT", "EXISTS", ..] => live.extend(name(5)),
                    ["CREATE", "TABLE", ..] => live.extend(name(2)),
                    ["DROP", "TABLE", "IF", "EXISTS", ..] => {
                        name(4).map(|n| live.remove(&n));
                    }
                    ["DROP", "TABLE", ..] => {
                        name(2).map(|n| live.remove(&n));
                    }
                    _ => {}
                }
            }
        }
        live
    }

    #[test]
    fn every_table_wiped_is_one_the_migrations_leave() {
        let live = live_tables();
        assert!(live.contains("ledger") && !live.contains("sandbox_months"), "{live:?}");
        for sql in STATEMENTS {
            let table = sql.split_whitespace().nth(2).unwrap();
            assert!(live.contains(table), "{table} is not a table after the migrations");
        }
    }

    #[test]
    fn a_rename_moves_every_table_a_reset_wipes() {
        let moved = crate::rename::STATEMENTS.join("\n");
        // Lines follow their invoice, which carries the workspace.
        for sql in STATEMENTS.iter().filter(|sql| !sql.contains("workspace_invoice_lines")) {
            let table = sql.split_whitespace().nth(2).unwrap();
            assert!(moved.contains(&format!(" {table} ")), "{table} is wiped on a reset but not moved on a rename");
        }
    }

    #[test]
    fn statements_name_at_most_the_workspace_and_its_account() {
        assert!(STATEMENTS.iter().all(|sql| crate::rename::parameters(sql) <= 2));
        assert_eq!(crate::rename::parameters(STATEMENTS.last().unwrap()), 2);
    }
}
