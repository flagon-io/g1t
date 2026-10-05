//! Who pays for a workspace, and on what terms.
//!
//! Every workspace is paid for by a billing account. By default that is
//! its own (`ws_<slug>`), on standard terms, and needs no row. g1t staff
//! can change that in sudo.g1t.sh:
//!
//! - **Terms.** Comped (nothing charged, usage still recorded with its
//!   cost; for g1t's own workspaces and partners), or custom (a discount,
//!   a ceiling of its own, or both), optionally until a date.
//! - **Enterprises.** One account paying for several workspaces, as GitHub
//!   Enterprise does: their usage and payments count together against one
//!   limit, on one set of terms.
//! - **Credits**, such as refunds.
//!
//! Every change names who made it and is kept in `admin_actions`.

use g1t_contracts::billing::{
    AccountDetail, AccountKind, AccountSummary, AdminAccountArgs, AdminAccountsArgs, AdminAction, AdminAttachArgs,
    AdminCreateEnterpriseArgs, AdminCreditArgs, AdminSetTermsArgs, BillingAccount, EntryKind, LedgerEntry, Terms,
    TermsKind,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Billing, LedgerRow, optional};

#[derive(Deserialize)]
struct AccountRow {
    id: String,
    kind: String,
    name: String,
    terms_kind: String,
    discount_percent: u32,
    ceiling_micros: Option<i64>,
    note: String,
    terms_until: Option<String>,
    terms_set_by: Option<String>,
    terms_set_at: Option<String>,
    created_at: String,
}

impl AccountRow {
    fn terms(&self) -> Terms {
        let expired = self.terms_until.as_deref().is_some_and(|until| until < rfc3339(now_ms()).as_str());
        if expired {
            return Terms::standard();
        }
        Terms {
            kind: match self.terms_kind.as_str() {
                "comped" => TermsKind::Comped,
                "custom" => TermsKind::Custom,
                _ => TermsKind::Standard,
            },
            discount_percent: self.discount_percent,
            ceiling_micros: self.ceiling_micros,
            note: self.note.clone(),
            until: self.terms_until.clone(),
            set_by: self.terms_set_by.clone(),
            set_at: self.terms_set_at.clone(),
        }
    }
}

#[derive(Deserialize)]
struct Member {
    workspace: String,
}

#[derive(Deserialize)]
struct ActionRow {
    id: String,
    account: String,
    action: String,
    detail: String,
    by: String,
    created_at: String,
}

/// `ws_<slug>`: a workspace's own account.
pub(crate) fn own_account(workspace: &str) -> String {
    format!("ws_{}", workspace.to_lowercase())
}

fn kind_text(kind: TermsKind) -> &'static str {
    match kind {
        TermsKind::Standard => "standard",
        TermsKind::Comped => "comped",
        TermsKind::Custom => "custom",
    }
}

fn describe(terms: &Terms) -> String {
    let mut text = match terms.kind {
        TermsKind::Standard => "standard".to_owned(),
        TermsKind::Comped => "comped".to_owned(),
        TermsKind::Custom => {
            let mut parts = vec![];
            if terms.discount_percent > 0 {
                parts.push(format!("{}% off", terms.discount_percent));
            }
            if let Some(ceiling) = terms.ceiling_micros {
                parts.push(format!("ceiling {}", crate::features::dollars(ceiling)));
            }
            format!("custom ({})", if parts.is_empty() { "no changes".to_owned() } else { parts.join(", ") })
        }
    };
    if let Some(until) = &terms.until {
        text.push_str(&format!(" until {}", &until[..until.len().min(10)]));
    }
    if !terms.note.is_empty() {
        text.push_str(&format!(": {}", terms.note));
    }
    text
}

impl Billing {
    async fn account_row(&self, id: &str) -> Result<Option<AccountRow>> {
        self.db
            .prepare("SELECT * FROM billing_accounts WHERE id = ?")
            .bind(&[id.into()])?
            .first::<AccountRow>(None)
            .await
    }

    async fn members(&self, account: &str) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare("SELECT workspace FROM account_members WHERE account_id = ? ORDER BY workspace")
            .bind(&[account.into()])?
            .all()
            .await?
            .results::<Member>()?
            .into_iter()
            .map(|m| m.workspace)
            .collect())
    }

    fn to_account(&self, row: &AccountRow, workspaces: Vec<String>) -> BillingAccount {
        BillingAccount {
            id: row.id.clone(),
            kind: if row.kind == "enterprise" { AccountKind::Enterprise } else { AccountKind::Workspace },
            name: row.name.clone(),
            terms: row.terms(),
            workspaces,
            created_at: row.created_at.clone(),
        }
    }

    /// The account that pays for a workspace.
    pub(crate) async fn account_of(&self, workspace: &str) -> Result<BillingAccount> {
        let workspace = workspace.to_lowercase();
        #[derive(Deserialize)]
        struct Link {
            account_id: String,
        }
        let linked = self
            .db
            .prepare("SELECT account_id FROM account_members WHERE workspace = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<Link>(None)
            .await?;
        if let Some(link) = linked {
            if let Some(row) = self.account_row(&link.account_id).await? {
                let members = self.members(&row.id).await?;
                return Ok(self.to_account(&row, members));
            }
        }
        let id = own_account(&workspace);
        Ok(match self.account_row(&id).await? {
            Some(row) => self.to_account(&row, vec![workspace]),
            None => BillingAccount {
                id,
                kind: AccountKind::Workspace,
                name: workspace.clone(),
                terms: Terms::standard(),
                workspaces: vec![workspace],
                created_at: String::new(),
            },
        })
    }

    /// The terms a workspace is charged on.
    pub(crate) async fn terms_of(&self, workspace: &str) -> Result<Terms> {
        Ok(self.account_of(workspace).await?.terms)
    }

    /// An account by id, or the account of a workspace by its slug.
    async fn find_account(&self, id: &str) -> Result<Option<BillingAccount>> {
        let id = id.trim().to_lowercase();
        if id.starts_with("ent_") {
            return Ok(match self.account_row(&id).await? {
                Some(row) => {
                    let members = self.members(&row.id).await?;
                    Some(self.to_account(&row, members))
                }
                None => None,
            });
        }
        let slug = id.strip_prefix("ws_").unwrap_or(&id);
        if slug.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.account_of(slug).await?))
    }

    async fn audit(&self, account: &str, action: &str, detail: &str, by: &str) -> Result<()> {
        let now = now_ms();
        self.db
            .prepare("INSERT INTO admin_actions (id, account, action, detail, by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&[
                new_id("adm", now).into(),
                account.into(),
                action.into(),
                detail.into(),
                by.into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Where an account stands this month.
    async fn summary(&self, account: BillingAccount) -> Result<AccountSummary> {
        let first = account.workspaces.first().cloned().unwrap_or_else(|| account.name.clone());
        let limit = self.limit_of(&first).await?;
        #[derive(Deserialize)]
        struct Totals {
            charged: Option<i64>,
            cost: Option<i64>,
        }
        #[derive(Deserialize)]
        struct Paid {
            paid: Option<i64>,
        }
        let marks = vec!["?"; account.workspaces.len().max(1)].join(", ");
        let mut values: Vec<JsValue> = account.workspaces.iter().map(|w| JsValue::from(w.as_str())).collect();
        if values.is_empty() {
            values.push(JsValue::from(""));
        }
        let month_start = format!("{}-01", &rfc3339(now_ms())[..7]);
        let mut with_month = values.clone();
        with_month.push(month_start.as_str().into());
        let totals = self
            .db
            .prepare(format!(
                "SELECT -SUM(amount_micros) AS charged, SUM(cost_micros) AS cost FROM ledger
                 WHERE kind = 'usage' AND workspace IN ({marks}) AND created_at >= ?"
            ))
            .bind(&with_month)?
            .first::<Totals>(None)
            .await?;
        let paid = self
            .db
            .prepare(format!("SELECT SUM(amount_micros) AS paid FROM ledger WHERE kind = 'top_up' AND workspace IN ({marks})"))
            .bind(&values)?
            .first::<Paid>(None)
            .await?;
        Ok(AccountSummary {
            account,
            limit,
            charged_micros: totals.as_ref().and_then(|t| t.charged).unwrap_or(0),
            cost_micros: totals.and_then(|t| t.cost).unwrap_or(0),
            paid_micros: paid.and_then(|p| p.paid).unwrap_or(0),
        })
    }

    // --- Staff ------------------------------------------------------------

    pub(crate) async fn admin_accounts(&self, a: AdminAccountsArgs) -> Result<Vec<AccountSummary>> {
        // Every workspace that has used or paid for anything, and every
        // account with terms of its own.
        #[derive(Deserialize)]
        struct Slug {
            workspace: String,
        }
        let mut slugs: Vec<String> = self
            .db
            .prepare(
                "SELECT DISTINCT workspace FROM ledger
                 UNION SELECT workspace FROM accounts
                 UNION SELECT substr(id, 4) FROM billing_accounts WHERE kind = 'workspace'",
            )
            .all()
            .await?
            .results::<Slug>()?
            .into_iter()
            .map(|s| s.workspace)
            .collect();
        if let Some(query) = a.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            let query = query.to_lowercase();
            slugs.retain(|slug| slug.contains(&query));
        }
        let mut seen = std::collections::HashSet::new();
        let mut summaries = vec![];
        for slug in slugs.into_iter().take(200) {
            let account = self.account_of(&slug).await?;
            if !seen.insert(account.id.clone()) {
                continue;
            }
            summaries.push(self.summary(account).await?);
        }
        // Enterprises with no usage yet.
        #[derive(Deserialize)]
        struct Id {
            id: String,
        }
        let enterprises = self
            .db
            .prepare("SELECT id FROM billing_accounts WHERE kind = 'enterprise'")
            .all()
            .await?
            .results::<Id>()?;
        for Id { id } in enterprises {
            if seen.contains(&id) {
                continue;
            }
            if let Some(account) = self.find_account(&id).await? {
                if a.query.as_deref().is_none_or(|q| account.name.to_lowercase().contains(&q.to_lowercase())) {
                    seen.insert(id);
                    summaries.push(self.summary(account).await?);
                }
            }
        }
        summaries.sort_by(|x, y| y.limit.exposure_micros.cmp(&x.limit.exposure_micros));
        Ok(summaries)
    }

    pub(crate) async fn admin_account(&self, a: AdminAccountArgs) -> Result<Outcome<AccountDetail>> {
        let Some(account) = self.find_account(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let mut workspaces = vec![];
        for workspace in &account.workspaces {
            workspaces.push(self.limit_of(workspace).await?);
        }
        let marks = vec!["?"; account.workspaces.len().max(1)].join(", ");
        let mut values: Vec<JsValue> = account.workspaces.iter().map(|w| JsValue::from(w.as_str())).collect();
        if values.is_empty() {
            values.push(JsValue::from(""));
        }
        let ledger = self
            .db
            .prepare(format!("SELECT * FROM ledger WHERE workspace IN ({marks}) ORDER BY id DESC LIMIT 100"))
            .bind(&values)?
            .all()
            .await?
            .results::<LedgerRow>()?
            .into_iter()
            .map(LedgerEntry::from)
            .collect();
        let audit = self
            .db
            .prepare("SELECT * FROM admin_actions WHERE account = ? ORDER BY created_at DESC LIMIT 50")
            .bind(&[account.id.as_str().into()])?
            .all()
            .await?
            .results::<ActionRow>()?
            .into_iter()
            .map(|row| AdminAction {
                id: row.id,
                account: row.account,
                action: row.action,
                detail: row.detail,
                by: row.by,
                created_at: row.created_at,
            })
            .collect();
        Ok(Outcome::Ok(AccountDetail { summary: self.summary(account).await?, workspaces, ledger, audit }))
    }

    pub(crate) async fn admin_set_terms(&self, a: AdminSetTermsArgs) -> Result<Outcome<BillingAccount>> {
        if a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is making the change."));
        }
        if a.terms.kind != TermsKind::Standard && a.terms.note.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why, in the note."));
        }
        if a.terms.discount_percent > 100 || a.terms.ceiling_micros.is_some_and(|c| c < 0) {
            return Ok(Outcome::fail(FailureCode::Invalid, "A discount is 0 to 100%, and a ceiling is not negative."));
        }
        let Some(account) = self.find_account(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let now = rfc3339(now_ms());
        // A workspace's own account gets a row the first time its terms change.
        self.db
            .prepare(
                "INSERT INTO billing_accounts (id, kind, name, terms_kind, discount_percent, ceiling_micros, note,
                   terms_until, terms_set_by, terms_set_at, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?10)
                 ON CONFLICT (id) DO UPDATE SET terms_kind = ?4, discount_percent = ?5, ceiling_micros = ?6,
                   note = ?7, terms_until = ?8, terms_set_by = ?9, terms_set_at = ?10",
            )
            .bind(&[
                account.id.as_str().into(),
                if account.kind == AccountKind::Enterprise { "enterprise" } else { "workspace" }.into(),
                account.name.as_str().into(),
                kind_text(a.terms.kind).into(),
                a.terms.discount_percent.into(),
                a.terms.ceiling_micros.map_or(JsValue::NULL, |c| (c as f64).into()),
                a.terms.note.trim().into(),
                optional(a.terms.until.as_deref()),
                a.by.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        self.audit(&account.id, "terms", &format!("{} → {}", describe(&account.terms), describe(&a.terms)), &a.by)
            .await?;
        Ok(Outcome::Ok(self.find_account(&account.id).await?.unwrap_or(account)))
    }

    pub(crate) async fn admin_create_enterprise(&self, a: AdminCreateEnterpriseArgs) -> Result<Outcome<BillingAccount>> {
        let name = a.name.trim();
        if name.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "An enterprise needs a name, and who is making it."));
        }
        let now = now_ms();
        let id = new_id("ent", now).to_lowercase();
        self.db
            .prepare(
                "INSERT INTO billing_accounts (id, kind, name, terms_kind, discount_percent, note, created_by, created_at)
                 VALUES (?, 'enterprise', ?, 'standard', 0, '', ?, ?)",
            )
            .bind(&[id.as_str().into(), name.into(), a.by.as_str().into(), rfc3339(now).into()])?
            .run()
            .await?;
        self.audit(&id, "create", &format!("Enterprise {name}"), &a.by).await?;
        for workspace in &a.workspaces {
            let workspace = workspace.trim().to_lowercase();
            if !workspace.is_empty() {
                self.attach(&workspace, Some(&id), &a.by).await?;
            }
        }
        Ok(match self.find_account(&id).await? {
            Some(account) => Outcome::Ok(account),
            None => Outcome::fail(FailureCode::NotFound, "The enterprise was not saved."),
        })
    }

    async fn attach(&self, workspace: &str, account: Option<&str>, by: &str) -> Result<()> {
        let before = self.account_of(workspace).await?;
        match account {
            Some(account) => {
                self.db
                    .prepare(
                        "INSERT INTO account_members (workspace, account_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (workspace) DO UPDATE SET account_id = ?2, added_by = ?3, added_at = ?4",
                    )
                    .bind(&[workspace.into(), account.into(), by.into(), rfc3339(now_ms()).into()])?
                    .run()
                    .await?;
                self.audit(account, "attach", &format!("{workspace} joined, from {}", before.name), by).await?;
            }
            None => {
                self.db
                    .prepare("DELETE FROM account_members WHERE workspace = ?")
                    .bind(&[workspace.into()])?
                    .run()
                    .await?;
                self.audit(&before.id, "detach", &format!("{workspace} left, back to paying for itself"), by).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn admin_attach(&self, a: AdminAttachArgs) -> Result<Outcome<BillingAccount>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace, and who is making the change."));
        }
        if let Some(account) = &a.account {
            match self.account_row(account).await? {
                Some(row) if row.kind == "enterprise" => {}
                _ => return Ok(Outcome::fail(FailureCode::NotFound, "Workspaces can only join an enterprise.")),
            }
        }
        self.attach(&workspace, a.account.as_deref(), &a.by).await?;
        Ok(Outcome::Ok(self.account_of(&workspace).await?))
    }

    pub(crate) async fn admin_credit(&self, a: AdminCreditArgs) -> Result<Outcome<LedgerEntry>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() || a.note.trim().is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "A credit needs a workspace, a note and who gave it."));
        }
        if a.amount_micros <= 0 || a.amount_micros > 10_000 * g1t_contracts::billing::MICROS_PER_DOLLAR {
            return Ok(Outcome::fail(FailureCode::Invalid, "A credit is more than $0 and at most $10,000."));
        }
        let reference = new_id("crd", now_ms());
        let description = format!("Credit from g1t: {}", a.note.trim());
        self.enter(&workspace, EntryKind::TopUp, a.amount_micros, &description, &reference, None, None, Some(&a.by), None)
            .await?;
        let account = self.account_of(&workspace).await?;
        self.audit(&account.id, "credit", &format!("{} to {workspace}: {}", crate::features::dollars(a.amount_micros), a.note.trim()), &a.by)
            .await?;
        let row = self
            .db
            .prepare("SELECT * FROM ledger WHERE reference = ?")
            .bind(&[reference.as_str().into()])?
            .first::<LedgerRow>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(LedgerEntry::from(row)),
            None => Outcome::fail(FailureCode::NotFound, "The credit was not saved."),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(kind: TermsKind, discount: u32) -> Terms {
        Terms { kind, discount_percent: discount, ..Terms::standard() }
    }

    #[test]
    fn terms_shape_every_charge() {
        assert_eq!(terms(TermsKind::Standard, 0).apply(1_000), 1_000);
        assert_eq!(terms(TermsKind::Comped, 0).apply(1_000), 0);
        assert_eq!(terms(TermsKind::Custom, 25).apply(1_000), 750);
        assert_eq!(terms(TermsKind::Custom, 250).apply(1_000), 0);
    }

    #[test]
    fn terms_read_plainly_in_the_audit_log() {
        let custom = Terms { ceiling_micros: Some(50_000_000), note: "Design partner".into(), ..terms(TermsKind::Custom, 20) };
        assert_eq!(describe(&custom), "custom (20% off, ceiling $50.00): Design partner");
        assert_eq!(describe(&Terms::standard()), "standard");
    }
}
