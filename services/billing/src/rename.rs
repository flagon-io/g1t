//! A workspace renamed: everything billing keeps under its slug moves to
//! the new one.
//!
//! Identity publishes `workspace.renamed` with the old and new slugs. The
//! handler asks identity what the workspace is called now, so that a late
//! or repeated delivery still converges on the current slug, and moves the
//! rows of each stale slug in one D1 batch (one transaction).
//!
//! Rows may already exist under the current slug: usage recorded in the
//! seconds between the rename and this event. Those are merged, never
//! dropped where money is concerned: balances are summed, sandbox seconds
//! are summed, and owners' limits are kept field by field.

use g1t_contracts::events::{Event, WorkspaceRenamed};
use g1t_contracts::identity::UsernamesArgs;
use serde::Deserialize;
use serde_json::Value;
use worker::wasm_bindgen::JsValue;
use worker::{Fetcher, Result};

use crate::Billing;
use crate::accounts::own_account;

/// The event this module handles.
pub(crate) const RENAMED: &str = "workspace.renamed";

/// The statements that move one stale slug's rows to the current slug, in
/// order. Parameters: `?1` the current slug, `?2` the stale one, `?3` and
/// `?4` their own billing accounts (`ws_<slug>`).
///
/// Every statement is a no-op once the stale slug has no rows, so running
/// the batch again changes nothing.
pub(crate) const STATEMENTS: &[&str] = &[
    // Plain rows: many per workspace, keyed by their own id.
    "UPDATE ledger SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE runs SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE credit_grants SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE checkouts SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE ai_reloads SET workspace = ?1 WHERE workspace = ?2",
    // Auto-reload's settings: the stale slug's, when the current has none.
    "INSERT OR IGNORE INTO ai_reload (workspace, enabled, threshold_micros, target_micros, monthly_max_micros, updated_by, updated_at, failed_at, error)
     SELECT ?1, enabled, threshold_micros, target_micros, monthly_max_micros, updated_by, updated_at, failed_at, error FROM ai_reload WHERE workspace = ?2",
    "DELETE FROM ai_reload WHERE workspace = ?2",
    "UPDATE workspace_invoices SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE sales_notes SET workspace = ?1 WHERE workspace = ?2",
    // Repositories are named `<slug>/<name>`. Compared exactly rather than
    // with LIKE, so nothing in a slug is read as a wildcard.
    "UPDATE ledger SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE runs SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    // The balance is the sum of the ledger, and both ledgers are now the
    // current slug's: the balances add. The older customer (with the card
    // and the payment history) is kept when both have one.
    "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at)
     SELECT ?1, balance_micros, customer_id, created_at FROM accounts WHERE workspace = ?2
     ON CONFLICT (workspace) DO UPDATE SET
       balance_micros = accounts.balance_micros + excluded.balance_micros,
       customer_id = COALESCE(excluded.customer_id, accounts.customer_id),
       created_at = MIN(accounts.created_at, excluded.created_at)",
    "DELETE FROM accounts WHERE workspace = ?2",
    // Replaced on each report with the month's whole figure: the newer
    // report wins.
    "INSERT INTO pending_usage (workspace, source, month, charge_micros, cost_micros, charged_at, updated_at, detail)
     SELECT ?1, source, month, charge_micros, cost_micros, charged_at, updated_at, detail FROM pending_usage WHERE workspace = ?2
     ON CONFLICT (workspace, source, month) DO UPDATE SET
       charge_micros = CASE WHEN excluded.updated_at > pending_usage.updated_at
                            THEN excluded.charge_micros ELSE pending_usage.charge_micros END,
       cost_micros = CASE WHEN excluded.updated_at > pending_usage.updated_at
                          THEN excluded.cost_micros ELSE pending_usage.cost_micros END,
       detail = CASE WHEN excluded.updated_at > pending_usage.updated_at
                     THEN excluded.detail ELSE pending_usage.detail END,
       charged_at = COALESCE(pending_usage.charged_at, excluded.charged_at),
       updated_at = MAX(pending_usage.updated_at, excluded.updated_at)",
    "DELETE FROM pending_usage WHERE workspace = ?2",
    // Monthly allowances drawn by the workspace (its plan's included usage,
    // its build time) add up; a repository's share of the open-source pool
    // follows the repository's new name.
    "INSERT INTO allowance_use (kind, scope, month, used)
     SELECT kind, ?1, month, used FROM allowance_use WHERE scope = ?2
     ON CONFLICT (kind, scope, month) DO UPDATE SET used = allowance_use.used + excluded.used",
    "DELETE FROM allowance_use WHERE scope = ?2",
    "UPDATE OR IGNORE allowance_use SET scope = ?1 || substr(scope, length(?2) + 1)
     WHERE kind = 'oss_repo' AND substr(scope, 1, length(?2) + 1) = ?2 || '/'",
    // One trial grant per workspace: the current slug's stays if it has one.
    "UPDATE OR IGNORE trial_grants SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM trial_grants WHERE workspace = ?2",
    "UPDATE OR IGNORE storage_days SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM storage_days WHERE workspace = ?2",
    "UPDATE OR IGNORE package_storage_days SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM package_storage_days WHERE workspace = ?2",
    // Month-end snapshots, by day: the current slug's stays if it has one.
    "UPDATE OR IGNORE pending_days SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM pending_days WHERE workspace = ?2",
    // Model tokens, by day, person, session and model: the counts add.
    "INSERT INTO token_usage (day, workspace, person, session, model, tier, input, output, cache_read, cache_write, requests)
     SELECT day, ?1, person, session, model, tier, input, output, cache_read, cache_write, requests FROM token_usage WHERE workspace = ?2
     ON CONFLICT (day, workspace, person, session, model) DO UPDATE SET
       input = token_usage.input + excluded.input,
       output = token_usage.output + excluded.output,
       cache_read = token_usage.cache_read + excluded.cache_read,
       cache_write = token_usage.cache_write + excluded.cache_write,
       requests = token_usage.requests + excluded.requests",
    "DELETE FROM token_usage WHERE workspace = ?2",
    // Price notices sent, one per version: told once is told.
    "UPDATE OR IGNORE price_notices SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM price_notices WHERE workspace = ?2",
    "UPDATE OR IGNORE closed_workspaces SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM closed_workspaces WHERE workspace = ?2",
    // The margin figures and counts are redone each day from the ledger and
    // the meters; moved so the days between keep adding up.
    "UPDATE OR IGNORE workspace_costs SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM workspace_costs WHERE workspace = ?2",
    "UPDATE OR IGNORE own_counts SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM own_counts WHERE workspace = ?2",
    "UPDATE margin_alerts SET subject = ?1 WHERE kind = 'workspace' AND subject = ?2",
    // Holds, spikes, requests and the plan's payments: many per workspace.
    "UPDATE reservations SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE reservations SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE spikes SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE limit_requests SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE plan_payments SET workspace = ?1 WHERE workspace = ?2",
    // One card check per workspace; alerts sent, one per level a month.
    "UPDATE OR IGNORE card_checks SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM card_checks WHERE workspace = ?2",
    "UPDATE OR IGNORE alerts_sent SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM alerts_sent WHERE workspace = ?2",
    // Limits, field by field: a ceiling or an owner's spend limit set under
    // either slug is kept (the current slug's if both), a stop for a
    // declined card stays, and the highest warning this month is kept.
    "INSERT INTO limits (workspace, ceiling_micros, spend_limit_micros, spend_limit_full, autopay_failed_at,
                         autopay_error, warned_month, warned_level, declined_told_at, updated_at,
                         max_ceiling_micros, granted_ceiling_micros, raised_at)
     SELECT ?1, ceiling_micros, spend_limit_micros, spend_limit_full, autopay_failed_at,
            autopay_error, warned_month, warned_level, declined_told_at, updated_at,
            max_ceiling_micros, granted_ceiling_micros, raised_at
     FROM limits WHERE workspace = ?2
     ON CONFLICT (workspace) DO UPDATE SET
       ceiling_micros = COALESCE(limits.ceiling_micros, excluded.ceiling_micros),
       max_ceiling_micros = MAX(COALESCE(limits.max_ceiling_micros, 0), COALESCE(excluded.max_ceiling_micros, 0)),
       granted_ceiling_micros = MAX(COALESCE(limits.granted_ceiling_micros, 0), COALESCE(excluded.granted_ceiling_micros, 0)),
       raised_at = COALESCE(limits.raised_at, excluded.raised_at),
       spend_limit_micros = CASE WHEN limits.spend_limit_micros IS NOT NULL OR limits.spend_limit_full = 1
                                 THEN limits.spend_limit_micros ELSE excluded.spend_limit_micros END,
       spend_limit_full = CASE WHEN limits.spend_limit_micros IS NOT NULL OR limits.spend_limit_full = 1
                               THEN limits.spend_limit_full ELSE excluded.spend_limit_full END,
       autopay_error = CASE WHEN limits.autopay_failed_at IS NOT NULL
                            THEN limits.autopay_error ELSE excluded.autopay_error END,
       autopay_failed_at = COALESCE(limits.autopay_failed_at, excluded.autopay_failed_at),
       warned_level = CASE WHEN excluded.warned_month > COALESCE(limits.warned_month, '') THEN excluded.warned_level
                           WHEN excluded.warned_month = limits.warned_month THEN MAX(limits.warned_level, excluded.warned_level)
                           ELSE limits.warned_level END,
       warned_month = COALESCE(MAX(limits.warned_month, excluded.warned_month), limits.warned_month, excluded.warned_month),
       declined_told_at = COALESCE(MAX(limits.declined_told_at, excluded.declined_told_at), limits.declined_told_at, excluded.declined_told_at),
       updated_at = MAX(limits.updated_at, excluded.updated_at)",
    "DELETE FROM limits WHERE workspace = ?2",
    // Plans: one per feature. A live plan under the stale slug replaces a
    // canceled one under the current slug; otherwise the current one stays.
    "DELETE FROM subscriptions WHERE workspace = ?1 AND status = 'canceled'
       AND feature IN (SELECT feature FROM subscriptions WHERE workspace = ?2 AND status <> 'canceled')",
    "UPDATE OR IGNORE subscriptions SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM subscriptions WHERE workspace = ?2",
    // Records of one per workspace (per month): the current slug's stays
    // if it has one.
    "UPDATE OR IGNORE month_closes SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM month_closes WHERE workspace = ?2",
    "UPDATE OR IGNORE account_members SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM account_members WHERE workspace = ?2",
    "UPDATE OR IGNORE sales_records SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM sales_records WHERE workspace = ?2",
    // An enterprise invoice's line for the workspace: amounts add.
    "INSERT INTO enterprise_invoice_lines (invoice_id, workspace, amount_micros)
     SELECT invoice_id, ?1, amount_micros FROM enterprise_invoice_lines WHERE workspace = ?2
     ON CONFLICT (invoice_id, workspace) DO UPDATE SET
       amount_micros = enterprise_invoice_lines.amount_micros + excluded.amount_micros",
    "DELETE FROM enterprise_invoice_lines WHERE workspace = ?2",
    // The workspace's own billing account, `ws_<slug>`. Terms set by staff
    // are kept: a standard row under the current slug gives way to the
    // stale one; two with terms keep the current one.
    "DELETE FROM billing_accounts WHERE id = ?3 AND terms_kind = 'standard'
       AND EXISTS (SELECT 1 FROM billing_accounts WHERE id = ?4)",
    "UPDATE OR IGNORE billing_accounts SET id = ?3, name = CASE WHEN name = ?2 THEN ?1 ELSE name END WHERE id = ?4",
    "DELETE FROM billing_accounts WHERE id = ?4",
    "UPDATE admin_actions SET account = ?3 WHERE account = ?4",
    "UPDATE OR IGNORE budget_alerts SET account = ?3 WHERE account = ?4",
    "DELETE FROM budget_alerts WHERE account = ?4",
    "UPDATE account_members SET account_id = ?3 WHERE account_id = ?4",
    "UPDATE enterprise_invoices SET account_id = ?3 WHERE account_id = ?4",
];

/// The highest `?N` a statement names: how many values it is bound with.
pub(crate) fn parameters(sql: &str) -> usize {
    let bytes = sql.as_bytes();
    let mut highest = 0;
    for (i, byte) in bytes.iter().enumerate() {
        if *byte == b'?' {
            let digits: String = bytes[i + 1..].iter().take_while(|b| b.is_ascii_digit()).map(|b| *b as char).collect();
            highest = highest.max(digits.parse().unwrap_or(0));
        }
    }
    highest
}

/// The values `STATEMENTS` are bound with, in parameter order.
pub(crate) fn values(stale: &str, current: &str) -> [String; 4] {
    [current.to_owned(), stale.to_owned(), own_account(current), own_account(stale)]
}

impl Billing {
    /// Handles one event from the bus; every type but a rename is ignored.
    pub(crate) async fn on_event(&self, identity: Option<&Fetcher>, event: &Event) -> Result<()> {
        if event.kind != RENAMED {
            return Ok(());
        }
        let renamed: WorkspaceRenamed = serde_json::from_value(event.data.clone())?;
        let current = match identity {
            Some(identity) => {
                let names: std::collections::HashMap<String, String> = g1t_kit::call(
                    identity,
                    "usernames",
                    &UsernamesArgs { ids: vec![renamed.workspace_id.clone()] },
                )
                .await?;
                names.get(&renamed.workspace_id).cloned().unwrap_or_else(|| renamed.to.clone())
            }
            None => renamed.to.clone(),
        };
        self.rename_workspace(&renamed, &current.to_lowercase()).await
    }

    /// Moves every row of the rename's stale slugs to `current`.
    pub(crate) async fn rename_workspace(&self, renamed: &WorkspaceRenamed, current: &str) -> Result<()> {
        for stale in renamed.stale_slugs(current) {
            let stale = stale.to_lowercase();
            if stale.is_empty() || stale == current {
                continue;
            }
            let values = values(&stale, current);
            let mut batch = Vec::with_capacity(STATEMENTS.len());
            for sql in STATEMENTS {
                let binds: Vec<JsValue> = values[..parameters(sql)].iter().map(|v| JsValue::from(v.as_str())).collect();
                batch.push(self.db.prepare(*sql).bind(&binds)?);
            }
            self.db.batch(batch).await?;
            self.rename_customer(&stale, current).await;
        }
        Ok(())
    }

    /// The Stripe customer carries the slug as its name and metadata; both
    /// follow the rename. A name someone changed at Stripe is left alone.
    /// Best effort: a failure here moves no money.
    async fn rename_customer(&self, stale: &str, current: &str) {
        let Some(stripe) = &self.stripe else { return };
        let Ok(Some(customer)) = self.row(current).await.map(|row| row.and_then(|row| row.customer_id)) else {
            return;
        };
        #[derive(Deserialize)]
        struct Customer {
            name: Option<String>,
            metadata: Option<std::collections::HashMap<String, String>>,
        }
        let path = format!("/customers/{customer}");
        let found: Customer = match stripe.get(&path).await {
            Ok(found) => found,
            Err(error) => {
                worker::console_error!("renaming {stale} at Stripe: could not read {customer}: {error}");
                return;
            }
        };
        let mut fields = vec![];
        if found.name.as_deref() == Some(stale) {
            fields.push(("name", current.to_owned()));
        }
        let tagged = found.metadata.as_ref().and_then(|m| m.get("workspace")).map(String::as_str);
        if tagged != Some(current) {
            fields.push(("metadata[workspace]", current.to_owned()));
        }
        if fields.is_empty() {
            return;
        }
        if let Err(error) = stripe.post::<Value>(&path, &fields).await {
            worker::console_error!("renaming {stale} at Stripe: could not update {customer}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_statement_is_bound_with_what_it_names() {
        for sql in STATEMENTS {
            let n = parameters(sql);
            assert!((1..=4).contains(&n), "{sql}");
            // Numbered only: a bare `?` would take the wrong value.
            assert!(!sql.contains("? ") && !sql.ends_with('?'), "{sql}");
        }
        assert_eq!(parameters("UPDATE t SET a = ?1 WHERE b = ?2"), 2);
        assert_eq!(parameters("UPDATE t SET a = ?3 WHERE b = ?4"), 4);
    }

    #[test]
    fn the_values_name_both_slugs_and_their_accounts() {
        assert_eq!(values("acme", "acme-co"), ["acme-co".to_owned(), "acme".into(), "ws_acme-co".into(), "ws_acme".into()]);
    }

    #[test]
    fn every_table_keyed_by_a_slug_is_moved() {
        let all = STATEMENTS.join("\n");
        for table in [
            "ledger", "runs", "checkouts", "workspace_invoices", "sales_notes", "accounts",
            "pending_usage", "limits", "subscriptions", "month_closes", "account_members", "sales_records",
            "enterprise_invoice_lines", "billing_accounts", "admin_actions", "enterprise_invoices",
            "allowance_use", "trial_grants", "credit_grants", "storage_days",
            "reservations", "spikes", "limit_requests", "plan_payments", "card_checks", "alerts_sent",
            "package_storage_days", "pending_days", "token_usage", "price_notices", "closed_workspaces",
            "workspace_costs", "own_counts", "ai_reload", "ai_reloads",
        ] {
            assert!(all.contains(&format!("FROM {table} WHERE workspace = ?2"))
                || all.contains(&format!("UPDATE {table} SET"))
                || all.contains(&format!("UPDATE OR IGNORE {table} SET")), "{table}");
        }
    }
}
