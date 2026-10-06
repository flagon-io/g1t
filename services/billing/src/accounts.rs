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
    AdminCreateEnterpriseArgs, AdminCreditArgs, AdminSetAllowancesArgs, AdminSetTermsArgs, Allowances, BillingAccount,
    EntryKind, LedgerEntry, Terms, TermsKind, WorkspaceFigures,
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
    #[serde(default)]
    billing_email: Option<String>,
    #[serde(default)]
    team_granted: Option<i64>,
    #[serde(default)]
    oss_repo_micros: Option<i64>,
    #[serde(default)]
    trial_micros: Option<i64>,
    #[serde(default)]
    max_concurrent_agents: Option<u32>,
    #[serde(default)]
    run_cap_micros: Option<i64>,
    #[serde(default)]
    issue_cap_micros: Option<i64>,
    #[serde(default)]
    hold: Option<String>,
}

impl AccountRow {
    fn allowances(&self) -> Allowances {
        Allowances {
            // The column is named for the plan's old name.
            plan: self.team_granted.unwrap_or(0) != 0,
            oss_repo_micros: self.oss_repo_micros,
            trial_micros: self.trial_micros,
            max_concurrent_agents: self.max_concurrent_agents,
            run_cap_micros: self.run_cap_micros,
            issue_cap_micros: self.issue_cap_micros,
            hold: self.hold.clone().filter(|h| !h.trim().is_empty()),
        }
    }
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
            billing_email: row.billing_email.clone(),
            invoices: vec![],
            allowances: row.allowances(),
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
                billing_email: None,
                invoices: vec![],
                allowances: Allowances::default(),
            },
        })
    }

    /// The terms a workspace is charged on.
    pub(crate) async fn terms_of(&self, workspace: &str) -> Result<Terms> {
        Ok(self.account_of(workspace).await?.terms)
    }

    /// An enterprise, with its invoices.
    pub(crate) async fn enterprise(&self, id: &str) -> Result<Option<BillingAccount>> {
        let Some(row) = self.account_row(id).await?.filter(|row| row.kind == "enterprise") else {
            return Ok(None);
        };
        let members = self.members(&row.id).await?;
        let mut account = self.to_account(&row, members);
        account.invoices = self.enterprise_invoices(&row.id).await?;
        Ok(Some(account))
    }

    /// An account by id, or the account of a workspace by its slug.
    async fn find_account(&self, id: &str) -> Result<Option<BillingAccount>> {
        let id = id.trim().to_lowercase();
        if id.starts_with("ent_") {
            return self.enterprise(&id).await;
        }
        let slug = id.strip_prefix("ws_").unwrap_or(&id);
        if slug.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.account_of(slug).await?))
    }

    pub(crate) async fn audit(&self, account: &str, action: &str, detail: &str, by: &str) -> Result<()> {
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
            workspace: String,
            charged: Option<i64>,
            cost: Option<i64>,
        }
        #[derive(Deserialize)]
        struct Paid {
            workspace: String,
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
                "SELECT workspace, -SUM(amount_micros) AS charged,
                        SUM(CASE WHEN COALESCE(billed_to, 'g1t') = 'g1t' THEN cost_micros ELSE 0 END) AS cost
                 FROM ledger WHERE kind = 'usage' AND workspace IN ({marks}) AND created_at >= ? GROUP BY workspace"
            ))
            .bind(&with_month)?
            .all()
            .await?
            .results::<Totals>()?;
        let paid = self
            .db
            .prepare(format!(
                "SELECT workspace, SUM(amount_micros) AS paid FROM ledger
                 WHERE kind = 'top_up' AND workspace IN ({marks}) GROUP BY workspace"
            ))
            .bind(&values)?
            .all()
            .await?
            .results::<Paid>()?;
        // Each workspace's share, in the account's order; the account's
        // figures are their sum.
        let mut by_workspace: Vec<WorkspaceFigures> = vec![];
        for workspace in &account.workspaces {
            figures_for(&mut by_workspace, workspace);
        }
        for t in &totals {
            let f = figures_for(&mut by_workspace, &t.workspace);
            f.charged_micros += t.charged.unwrap_or(0);
            f.cost_micros += t.cost.unwrap_or(0);
        }
        for p in &paid {
            figures_for(&mut by_workspace, &p.workspace).paid_micros += p.paid.unwrap_or(0);
        }
        let months = self.months_for(&account.workspaces, 6).await?;
        Ok(AccountSummary {
            months,
            charged_micros: by_workspace.iter().map(|f| f.charged_micros).sum(),
            cost_micros: by_workspace.iter().map(|f| f.cost_micros).sum(),
            paid_micros: by_workspace.iter().map(|f| f.paid_micros).sum(),
            by_workspace,
            account,
            limit,
        })
    }

    // --- Staff ------------------------------------------------------------

    pub(crate) async fn admin_accounts(&self, a: AdminAccountsArgs) -> Result<Vec<AccountSummary>> {
        // Exactly the workspaces asked for, such as one page of sudo's list.
        if let Some(workspaces) = &a.workspaces {
            let mut seen = std::collections::HashSet::new();
            let mut summaries = vec![];
            for slug in workspaces.iter().take(200) {
                let account = self.account_of(slug).await?;
                if seen.insert(account.id.clone()) {
                    summaries.push(self.summary(account).await?);
                }
            }
            return Ok(summaries);
        }
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

    /// The plan without its price, the plan's caps, a hold on new compute,
    /// and the account's share of g1t's pools.
    pub(crate) async fn admin_set_allowances(&self, a: AdminSetAllowancesArgs) -> Result<Outcome<BillingAccount>> {
        if a.by.trim().is_empty() || a.note.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is making the change, and why, in the note."));
        }
        let money = |m: Option<i64>| m.is_none_or(|m| (0..=1_000 * g1t_contracts::billing::MICROS_PER_DOLLAR).contains(&m));
        if !money(a.allowances.oss_repo_micros) || !money(a.allowances.trial_micros) || !money(a.allowances.run_cap_micros) || !money(a.allowances.issue_cap_micros) {
            return Ok(Outcome::fail(FailureCode::Invalid, "A pool share or run cap is between $0 and $1,000."));
        }
        if a.allowances.max_concurrent_agents.is_some_and(|n| n == 0 || n > 1_000) {
            return Ok(Outcome::fail(FailureCode::Invalid, "Agents at once is between 1 and 1,000."));
        }
        let Some(account) = self.find_account(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such account."));
        };
        let now = rfc3339(now_ms());
        let opt = |m: Option<i64>| m.map_or(JsValue::NULL, |m| (m as f64).into());
        // A workspace's own account gets a row the first time anything is set.
        self.db
            .prepare(
                "INSERT INTO billing_accounts (id, kind, name, terms_kind, discount_percent, note, created_by, created_at,
                   team_granted, oss_repo_micros, trial_micros, max_concurrent_agents, run_cap_micros, hold, issue_cap_micros)
                 VALUES (?1, ?2, ?3, 'standard', 0, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT (id) DO UPDATE SET team_granted = ?6, oss_repo_micros = ?7, trial_micros = ?8,
                   max_concurrent_agents = ?9, run_cap_micros = ?10, hold = ?11, issue_cap_micros = ?12",
            )
            .bind(&[
                account.id.as_str().into(),
                if account.kind == AccountKind::Enterprise { "enterprise" } else { "workspace" }.into(),
                account.name.as_str().into(),
                a.by.as_str().into(),
                now.as_str().into(),
                u32::from(a.allowances.plan).into(),
                opt(a.allowances.oss_repo_micros),
                opt(a.allowances.trial_micros),
                a.allowances.max_concurrent_agents.map_or(JsValue::NULL, JsValue::from),
                opt(a.allowances.run_cap_micros),
                optional(a.allowances.hold.as_deref().map(str::trim).filter(|h| !h.is_empty())),
                opt(a.allowances.issue_cap_micros),
            ])?
            .run()
            .await?;
        // A trial amount from staff replaces each workspace's grant, outside
        // the monthly pool; what was used stays used.
        if let Some(amount) = a.allowances.trial_micros {
            for workspace in &account.workspaces {
                self.db
                    .prepare(
                        "INSERT INTO trial_grants (workspace, month, granted_micros, used_micros, created_at)
                         VALUES (?1, 'staff', ?2, 0, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET month = 'staff', granted_micros = ?2",
                    )
                    .bind(&[workspace.as_str().into(), (amount as f64).into(), now.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        self.audit(
            &account.id,
            "allowances",
            &format!("{} → {}: {}", describe_allowances(&account.allowances), describe_allowances(&a.allowances), a.note.trim()),
            &a.by,
        )
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

    pub(crate) async fn admin_billing_link(
        &self,
        a: g1t_contracts::billing::AdminBillingLinkArgs,
    ) -> Result<Outcome<g1t_contracts::billing::BillingLink>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() || a.by.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace, and who is asking."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        let customer = match self.customer_for(&workspace).await {
            Ok(customer) => customer,
            Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, format!("Stripe could not be reached: {error}"))),
        };
        let link = async {
            let configuration = stripe.portal_configuration().await?;
            let portal_url = stripe.portal_session(&customer, "https://g1t.sh/").await?;
            let customer_email = stripe.customer_email(&customer).await.ok().flatten();
            Ok::<_, worker::Error>(g1t_contracts::billing::BillingLink {
                portal_url,
                login_url: configuration.login_page.and_then(|page| page.url),
                customer_email,
                expires_note: "The one-time link works for a short while and only once; the sign-in page does not expire."
                    .to_owned(),
            })
        }
        .await;
        match link {
            Ok(link) => {
                let account = self.account_of(&workspace).await?;
                self.audit(&account.id, "billing_link", &format!("Stripe billing link for {workspace}"), &a.by).await?;
                Ok(Outcome::Ok(link))
            }
            Err(error) => Ok(Outcome::fail(FailureCode::Conflict, format!("Stripe's billing page could not be opened: {error}"))),
        }
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

/// Allowances as the audit log reads them.
fn describe_allowances(a: &Allowances) -> String {
    let mut parts = vec![if a.plan { "plan given" } else { "plan not given" }.to_owned()];
    if let Some(m) = a.oss_repo_micros {
        parts.push(format!("open-source share {} a repository", crate::features::dollars(m)));
    }
    if let Some(m) = a.trial_micros {
        parts.push(format!("trial {}", crate::features::dollars(m)));
    }
    if let Some(n) = a.max_concurrent_agents {
        parts.push(format!("{n} agents at once"));
    }
    if let Some(m) = a.run_cap_micros {
        parts.push(format!("run cap {}", crate::features::dollars(m)));
    }
    if let Some(m) = a.issue_cap_micros {
        parts.push(format!("issue cap {}", crate::features::dollars(m)));
    }
    if let Some(hold) = &a.hold {
        parts.push(format!("hold: {hold}"));
    }
    parts.join(", ")
}

/// A workspace's figures in `list`, added at the end the first time.
fn figures_for<'a>(list: &'a mut Vec<WorkspaceFigures>, workspace: &str) -> &'a mut WorkspaceFigures {
    let i = match list.iter().position(|f| f.workspace == workspace) {
        Some(i) => i,
        None => {
            list.push(WorkspaceFigures { workspace: workspace.to_owned(), ..Default::default() });
            list.len() - 1
        }
    };
    &mut list[i]
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

    #[test]
    fn allowances_read_plainly_in_the_audit_log() {
        assert_eq!(describe_allowances(&Allowances::default()), "plan not given");
        let given = Allowances {
            plan: true,
            oss_repo_micros: Some(5_000_000),
            trial_micros: Some(2_000_000),
            max_concurrent_agents: Some(4),
            run_cap_micros: Some(3_000_000),
            issue_cap_micros: None,
            hold: Some("mining".into()),
        };
        assert_eq!(
            describe_allowances(&given),
            "plan given, open-source share $5.00 a repository, trial $2.00, 4 agents at once, run cap $3.00, hold: mining"
        );
    }

    #[test]
    fn each_workspace_gets_one_share() {
        let mut list = vec![];
        figures_for(&mut list, "acme").charged_micros += 5;
        figures_for(&mut list, "beta").cost_micros += 2;
        figures_for(&mut list, "acme").charged_micros += 7;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], WorkspaceFigures { workspace: "acme".into(), charged_micros: 12, ..Default::default() });
        assert_eq!(list[1].cost_micros, 2);
    }
}
