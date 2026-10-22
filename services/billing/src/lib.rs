//! The billing service: what g1t's compute costs, charged to the workspace
//! it ran for at what g1t pays plus 20%.
//!
//! One paid plan, "g1t" (see `features`): $21 a month per workspace, never
//! per person, with $10 of usage included, deployments, and more private
//! storage. The forge is free for everyone; compute needs the plan or a
//! card check (see `compute` and `cards`). Before anything that costs money
//! starts, the service that starts it reserves its estimate here; when it
//! is done, what it cost goes on the ledger plus the margin, drawn first
//! from what the plan includes, a trial or g1t's pools (see `credits`).
//! Every change is a ledger entry, and a balance is always the sum of its
//! ledger.
//!
//! Without a card processor configured the service says so and charges
//! nothing, so that g1t still runs where billing has not been set up.
//!
//! Reached only through service bindings; see `g1t_contracts::billing` for
//! the methods and their arguments.

mod accounts;
mod allocation;
mod complimentary;
mod enterprise_attempt;
mod budget;
mod charged;
mod cards;
mod closing;
mod compute;
mod costs;
mod cycle;
mod detach;
mod margin;
mod git_edge;
mod platform;
mod pricing;
mod provider_costs;
mod report;
mod details;
mod credits;
mod grants;
mod overages;
mod requests;
mod storage;
mod invoices;
mod invoice_attempt;
mod sales;
mod statement;
mod webhooks;
mod features;
mod keeper;
mod limits;
mod rename;
mod reset;
mod retention;
mod stripe;
mod stripe_sync;
mod subscriptions;
mod tax;

use g1t_contracts::billing::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, MessageBatch, MessageExt, Request, Response, Result, ScheduleContext, ScheduledEvent, event};
use futures_util::future::{try_join, try_join5};

use stripe::Stripe;

/// Prepaying: $25 at the least; by card up to $10,000 at a time, and by
/// bank transfer from $1,000 to $100,000.
const MIN_TOP_UP_CENTS: u32 = 2_500;
const MAX_TOP_UP_CENTS: u32 = 1_000_000;
const MIN_BANK_TRANSFER_CENTS: u32 = 100_000;
const MAX_BANK_TRANSFER_CENTS: u32 = 10_000_000;
const LEDGER_PAGE: u32 = 100;
/// What a cost g1t trusts (the price book's) is charged at: plus the
/// margin, rounded up to a whole millionth.
pub fn margin_on(cost_micros: i64, margin_percent: u32) -> i64 {
    let cost = i128::from(cost_micros.max(0));
    let charge = (cost * i128::from(100 + margin_percent) + 99) / 100;
    i64::try_from(charge).unwrap_or(i64::MAX)
}

fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

#[derive(Deserialize)]
struct AccountRow {
    balance_micros: i64,
    customer_id: Option<String>,
}

#[derive(Deserialize)]
struct LedgerRow {
    id: String,
    kind: EntryKind,
    amount_micros: i64,
    description: String,
    repo: Option<String>,
    number: Option<u32>,
    task: Option<String>,
    model: Option<String>,
    created_by: Option<String>,
    created_at: String,
    billed_to: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    credit_micros: Option<i64>,
    #[serde(default)]
    trial_micros: Option<i64>,
    #[serde(default)]
    oss_micros: Option<i64>,
    #[serde(default)]
    given_micros: Option<i64>,
    #[serde(default)]
    gift_micros: Option<i64>,
    #[serde(default)]
    credit_kind: Option<String>,
    #[serde(default)]
    discount_micros: Option<i64>,
}

impl From<LedgerRow> for LedgerEntry {
    fn from(row: LedgerRow) -> Self {
        LedgerEntry {
            id: row.id,
            kind: row.kind,
            amount_micros: row.amount_micros,
            description: row.description,
            repo: row.repo,
            number: row.number,
            task: row.task,
            model: row.model,
            billed_to: row.billed_to.unwrap_or_else(|| "g1t".to_owned()),
            created_by: row.created_by,
            created_at: row.created_at,
            workspace: row.workspace,
            credit_micros: row.credit_micros.unwrap_or(0),
            trial_micros: row.trial_micros.unwrap_or(0),
            oss_micros: row.oss_micros.unwrap_or(0),
            given_micros: row.given_micros.unwrap_or(0),
            gift_micros: row.gift_micros.unwrap_or(0),
            credit_kind: row.credit_kind.as_deref().and_then(CreditKind::parse),
            discount_micros: row.discount_micros.unwrap_or(0),
        }
    }
}

#[derive(Deserialize)]
struct CheckoutRow {
    workspace: String,
    created_by: String,
    #[serde(default)]
    fee_cents: Option<u32>,
}

/// A payment page started, as `checkouts` keeps it.
pub(crate) struct NewCheckout<'a> {
    pub id: &'a str,
    pub workspace: &'a str,
    /// What it pays for, in cents: the prepayment or the plan's price; 0
    /// for a card check.
    pub amount_cents: u32,
    /// The card fee on top: always 0 now that g1t's prices include it; the
    /// column keeps what pages from before were opened with.
    pub fee_cents: u32,
    pub created_by: &'a str,
    /// None for a prepayment; `plan`, `security` or `card_check` otherwise
    /// (`ai_credit` on pages from before AI credit was retired).
    pub feature: Option<&'a str>,
}

/// The one insert every payment page goes through, every column named, so
/// a column added to `checkouts` with no default is caught by
/// `tests::every_checkout_insert_fills_the_table` rather than by a 500.
/// A page asked for twice in Stripe's idempotency window is the same page:
/// the row the first made stands, and the second is handed the same page.
pub(crate) const CHECKOUT_INSERT: &str = "INSERT OR IGNORE INTO checkouts (id, workspace, amount_cents, fee_cents, created_by, created_at, feature, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')";

impl Billing {
    pub(crate) async fn record_checkout(&self, c: &NewCheckout<'_>) -> Result<()> {
        self.db
            .prepare(CHECKOUT_INSERT)
            .bind(&[
                c.id.into(),
                c.workspace.into(),
                c.amount_cents.into(),
                c.fee_cents.into(),
                c.created_by.into(),
                rfc3339(now_ms()).into(),
                optional(c.feature),
            ])?
            .run()
            .await?;
        Ok(())
    }
}

/// Lifts a workspace's stop (`?1`) for a declined card or a dispute, unless
/// a dispute is still open or what a lost one took back is still unpaid.
pub(crate) const CLEAR_STOP: &str = "UPDATE limits SET autopay_failed_at = NULL, autopay_error = NULL
     WHERE workspace = ?1 AND dispute_owed_micros = 0
       AND NOT EXISTS (SELECT 1 FROM disputes WHERE disputes.workspace = ?1 AND disputes.status = 'open')";

/// Whether D1 refused a write because the row is there already: a ledger
/// entry for a payment someone else credited first (`ledger.reference` is
/// unique), so it is never credited twice.
pub(crate) fn is_duplicate(error: &worker::Error) -> bool {
    error.to_string().contains("UNIQUE constraint failed")
}

/// A row an `UPDATE … RETURNING` touched.
#[derive(Deserialize)]
struct Touched {
    #[allow(dead_code)]
    id: String,
}

struct Billing {
    db: D1Database,
    /// Absent when no card processor is configured.
    stripe: Option<Stripe>,
    /// Whether g1t charges for usage (`CHARGING`): every "is this charged"
    /// decision keys on it, never on whether the card processor's key is
    /// set. On without a key, usage is still recorded and free workspaces
    /// are held to their limits (fail closed); off, nothing is gated or
    /// charged (a self-hosted g1t).
    charging: bool,
    /// The destination's signing secret from Stripe (`STRIPE_WEBHOOK_SECRET`);
    /// without it no event is believed.
    webhook_secret: Option<String>,
    margin_percent: u32,
    /// While g1t is being built out, nothing is charged (`FREE_WHILE_BUILDING`).
    free: bool,
    /// Whether new workspaces get trial credit (`TRIAL_WORKSPACE_MICROS`
    /// and `TRIAL_MONTHLY_POOL_MICROS` both above zero).
    trials_on: bool,
    /// The plans' and pools' numbers; see `credits`.
    plans: credits::Config,
    /// The repos service: which repositories are public, what private ones
    /// hold, and their git operations. Absent where it is not bound.
    repos: Option<worker::Fetcher>,
    /// The packages service: what each workspace's packages hold.
    packages: Option<worker::Fetcher>,
    /// The identity service, which emails owners. Absent where it is not
    /// bound.
    identity: Option<worker::Fetcher>,
    /// How far unpaid usage may go; see `limits`.
    ceilings: limits::Ceilings,
    /// The caps on what g1t pays for itself; see `budget`.
    caps: budget::Caps,
    /// What seals the AI providers' admin keys a workspace connects for
    /// their cost reports (`BILLING_KEY`); without it none can be
    /// connected. See `provider_costs`.
    sealer: Option<g1t_secrets::Sealer>,
    /// The worker's bindings, for emailing staff (`EMAIL`).
    env: Env,
}

impl Billing {
    fn status(&self) -> Status {
        Status {
            enabled: self.stripe.is_some(),
            live: self.stripe.as_ref().is_some_and(Stripe::live),
            free: self.free,
        }
    }

    async fn row(&self, workspace: &str) -> Result<Option<AccountRow>> {
        self.db
            .prepare("SELECT balance_micros, customer_id FROM accounts WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<AccountRow>(None)
            .await
    }

    async fn standing(&self, workspace: &str) -> Result<Account> {
        // The card as last synced (stripe_sync.rs), not asked of Stripe.
        let (row, card) = try_join(self.row(workspace), self.saved_card(workspace)).await?;
        Ok(Account {
            workspace: workspace.to_owned(),
            balance_micros: row.map_or(0, |row| row.balance_micros),
            status: self.status(),
            margin_percent: self.margin_percent,
            card,
        })
    }

    /// The workspace's customer at Stripe, made the first time one is needed.
    pub(crate) async fn customer_for(&self, workspace: &str) -> Result<String> {
        let Some(stripe) = &self.stripe else {
            return Err(worker::Error::RustError("payments are not set up".into()));
        };
        if let Some(customer) = self.row(workspace).await?.and_then(|row| row.customer_id) {
            return Ok(customer);
        }
        let email = self.owner_email(workspace).await;
        let customer = stripe.create_customer(workspace, email.as_deref()).await?;
        // Two asking at once: the first customer saved stays, and both use it.
        self.db
            .prepare(
                "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at) VALUES (?1, 0, ?2, ?3)
                 ON CONFLICT (workspace) DO UPDATE SET customer_id = COALESCE(customer_id, ?2)",
            )
            .bind(&[workspace.into(), customer.as_str().into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(self.row(workspace).await?.and_then(|row| row.customer_id).unwrap_or(customer))
    }

    /// The address for a new Stripe customer's receipts and billing page
    /// sign-in: the workspace's billing email, set on its profile, or else
    /// an owner's email. None when identity cannot say; the owners can add
    /// one on the billing page.
    async fn owner_email(&self, workspace: &str) -> Option<String> {
        let identity = self.identity.as_ref()?;
        let args = g1t_contracts::identity::SlugArgs { slug: workspace.to_owned() };
        match g1t_kit::call::<_, Option<g1t_contracts::identity::AdminWorkspaceDetail>>(identity, "admin_workspace", &args).await {
            Ok(found) => {
                let found = found?;
                found.billing_email.or_else(|| {
                    found.members.into_iter().find(|m| m.role == g1t_contracts::Role::Owner && m.email.is_some()).and_then(|m| m.email)
                })
            }
            Err(error) => {
                worker::console_error!("{workspace}: no owner email for its Stripe customer: {error}");
                None
            }
        }
    }

    /// Stripe's hosted billing page for the workspace. Owners only.
    async fn billing_portal(&self, a: BillingPortalArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.manages_billing(&workspace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner or a billing manager can manage the workspace's billing."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        let customer = match self.customer_for(&workspace).await {
            Ok(customer) => customer,
            Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error))),
        };
        match stripe.portal_session(&customer, &a.return_url).await {
            Ok(url) => Ok(Outcome::Ok(Checkout { url })),
            Err(error) if stripe::is_missing(&error) => {
                // The customer was removed at Stripe: a new one next time.
                self.forget_customer(&workspace).await?;
                Ok(Outcome::fail(FailureCode::Conflict, "Stripe no longer had this workspace's customer. Try again."))
            }
            Err(error) => Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error))),
        }
    }

    /// Gives the workspace's Stripe customer a new email, when the billing
    /// email changes on the workspace's profile. Owners and billing
    /// managers only. False when there is nothing to change: no email, no
    /// customer yet (the first one is made with the billing email, see
    /// `owner_email`), or payments not set up.
    async fn set_customer_email(&self, a: SetCustomerEmailArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.manages_billing(&workspace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner or a billing manager can change the workspace's billing email."));
        }
        let email = a.email.trim();
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::Ok(false));
        };
        if email.is_empty() {
            return Ok(Outcome::Ok(false));
        }
        let Some(customer) = self.row(&workspace).await?.and_then(|row| row.customer_id) else {
            return Ok(Outcome::Ok(false));
        };
        match stripe.set_customer_email(&customer, email).await {
            Ok(()) => Ok(Outcome::Ok(true)),
            Err(error) if stripe::is_missing(&error) => {
                // The customer was removed at Stripe: the next one is made with this email.
                self.forget_customer(&workspace).await?;
                Ok(Outcome::Ok(false))
            }
            Err(error) => Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error))),
        }
    }

    /// Adds a ledger entry and moves the balance by the same amount, as
    /// one write.
    #[allow(clippy::too_many_arguments)]
    async fn enter(
        &self,
        workspace: &str,
        kind: EntryKind,
        amount_micros: i64,
        description: &str,
        reference: &str,
        cost_micros: Option<i64>,
        created_by: Option<&str>,
        customer: Option<&str>,
    ) -> Result<()> {
        let mut statements = self.entry_statements(workspace, kind, amount_micros, description, reference, cost_micros, created_by, customer)?;
        let kind = match kind {
            EntryKind::TopUp => "top_up",
            EntryKind::Usage => "usage",
        };
        statements.extend(self.after_entry_statements(workspace, kind, amount_micros)?);
        self.db.batch(statements).await?;
        Ok(())
    }

    /// The two writes of a ledger entry (the entry, and the balance moved
    /// by as much), for a caller that makes them part of a larger batch.
    /// A reference entered before fails the whole batch.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn entry_statements(
        &self,
        workspace: &str,
        kind: EntryKind,
        amount_micros: i64,
        description: &str,
        reference: &str,
        cost_micros: Option<i64>,
        created_by: Option<&str>,
        customer: Option<&str>,
    ) -> Result<Vec<worker::D1PreparedStatement>> {
        let now = now_ms();
        let timestamp = rfc3339(now);
        let kind = match kind {
            EntryKind::TopUp => "top_up",
            EntryKind::Usage => "usage",
        };
        Ok(vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, cost_micros, reference, created_by, created_at, billed_to)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'g1t')",
                    )
                    .bind(&[
                        new_id("led", now).into(),
                        workspace.into(),
                        kind.into(),
                        // D1 takes numbers as doubles, which hold every
                        // amount this service will see exactly.
                        (amount_micros as f64).into(),
                        description.into(),
                        cost_micros.map_or(JsValue::NULL, |cost| (cost as f64).into()),
                        reference.into(),
                        optional(created_by),
                        timestamp.as_str().into(),
                    ])?,
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (workspace) DO UPDATE SET
                           balance_micros = balance_micros + ?2,
                           customer_id = COALESCE(?3, customer_id)",
                    )
                    .bind(&[
                        workspace.into(),
                        (amount_micros as f64).into(),
                        optional(customer),
                        timestamp.as_str().into(),
                    ])?,
            ])
    }

    /// What follows an entry entered on its own.
    fn after_entry_statements(&self, workspace: &str, kind: &str, amount_micros: i64) -> Result<Vec<worker::D1PreparedStatement>> {
        // Money in clears a card declined at the limit. A refund or a lost
        // dispute is a top-up of less than nothing: money out, which never
        // clears it. A stop for a dispute lifts only once no dispute is open
        // and what lost ones took back is paid again, over one payment or
        // several (`dispute_owed_micros`): a smaller, unrelated payment
        // leaves it.
        if kind == "top_up" && amount_micros > 0 {
            return Ok(vec![
                    self.db
                        .prepare(
                            "UPDATE limits SET dispute_owed_micros = MAX(dispute_owed_micros - ?2, 0)
                             WHERE workspace = ?1 AND dispute_owed_micros > 0",
                        )
                        .bind(&[workspace.into(), (amount_micros as f64).into()])?,
                    self.db.prepare(CLEAR_STOP).bind(&[workspace.into()])?,
                ]);
        }
        Ok(vec![])
    }

    async fn account(&self, a: AccountArgs) -> Result<Outcome<Account>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        Ok(Outcome::Ok(self.standing(&workspace).await?))
    }

    async fn ledger(&self, a: AccountArgs) -> Result<Outcome<Vec<LedgerEntry>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let rows = self
            .db
            .prepare("SELECT * FROM ledger WHERE workspace = ? ORDER BY id DESC LIMIT ?")
            .bind(&[workspace.into(), LEDGER_PAGE.into()])?
            .all()
            .await?
            .results::<LedgerRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter().map(LedgerEntry::from).collect(),
        ))
    }

    async fn usage(&self, a: UsageArgs) -> Result<Outcome<Usage>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        #[derive(serde::Deserialize)]
        struct SliceRow {
            key: Option<String>,
            micros: Option<i64>,
            runs: Option<u32>,
        }
        // While g1t is free, what was used at cost is what there is to show.
        // With a discount, usage at its price, so a 100% discount still
        // shows what the workspace would pay.
        // Every slice measures usage at price (statement::PRICE_SQL), the one
        // figure every page shows as usage, whatever paid for it.
        let discount_percent = self.terms_of(&workspace).await?.percent_off();
        let measure = if self.free { "COALESCE(cost_micros, 0)" } else { crate::statement::PRICE_SQL };
        let slices = |key: &str, limit: u32| {
            format!(
                "SELECT {key} AS key, SUM({measure}) AS micros, COUNT(*) AS runs FROM ledger
                 WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?2
                 GROUP BY 1 ORDER BY micros DESC LIMIT {limit}"
            )
        };
        let query = |sql: String| {
            let db = &self.db;
            let workspace = workspace.clone();
            let since = a.since.clone();
            async move {
                let rows = db
                    .prepare(sql)
                    .bind(&[workspace.into(), since.into()])?
                    .all()
                    .await?
                    .results::<SliceRow>()?;
                Ok::<Vec<UsageSlice>, worker::Error>(
                    rows.into_iter()
                        .map(|row| UsageSlice {
                            key: row.key.unwrap_or_else(|| "other".to_owned()),
                            micros: row.micros.unwrap_or_default(),
                            runs: row.runs.unwrap_or_default(),
                        })
                        .collect(),
                )
            }
        };
        #[derive(serde::Deserialize)]
        struct Totals {
            spent: Option<i64>,
            cost: Option<i64>,
            provider: Option<i64>,
            runs: Option<u32>,
            added: Option<i64>,
            discount: Option<i64>,
            covered: Option<i64>,
            price: Option<i64>,
        }
        let totals = async {
            self.db
                .prepare(format!(
                    "SELECT
                       -SUM(CASE WHEN kind = 'usage' THEN amount_micros END) AS spent,
                       SUM(CASE WHEN kind = 'usage' THEN COALESCE(credit_micros, 0) + COALESCE(gift_micros, 0) + COALESCE(trial_micros, 0)
                                + COALESCE(oss_micros, 0) + COALESCE(given_micros, 0) END) AS covered,
                       SUM(CASE WHEN kind = 'usage' THEN {price} END) AS price,",
                    price = crate::statement::PRICE_SQL
                ) + "
                       SUM(CASE WHEN kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' THEN cost_micros END) AS cost,
                       SUM(CASE WHEN kind = 'usage' AND billed_to = 'workspace' THEN cost_micros END) AS provider,
                       SUM(CASE WHEN kind = 'usage' AND " + crate::statement::RUN_SQL + " THEN 1 ELSE 0 END) AS runs,
                       SUM(CASE WHEN kind = 'top_up' THEN amount_micros END) AS added,
                       SUM(CASE WHEN kind = 'usage' THEN discount_micros END) AS discount
                     FROM ledger WHERE workspace = ?1 AND created_at >= ?2",
                )
                .bind(&[workspace.as_str().into(), a.since.as_str().into()])?
                .first::<Totals>(None)
                .await
        };
        // The totals and the five slices read the same rows independently,
        // so they go to D1 at once: one round trip of waiting, not six.
        let (totals, (by_day, by_task, by_repo, by_pull, by_model)) = try_join(
            totals,
            try_join5(
                query(slices("substr(created_at, 1, 10) || '/' || COALESCE(task, 'other')", 400)),
                query(slices("task", 20)),
                query(slices("repo", 20)),
                query(slices("repo || '#' || number", 10)),
                query(slices("model", 10)),
            ),
        )
        .await?;
        let totals = totals.unwrap_or(Totals {
            spent: None,
            cost: None,
            provider: None,
            runs: None,
            added: None,
            discount: None,
            covered: None,
            price: None,
        });
        Ok(Outcome::Ok(Usage {
            spent_micros: totals.spent.unwrap_or_default(),
            // What the included usage, the trial, a pool or g1t paid, as the
            // entries record it.
            covered_micros: totals.covered.unwrap_or_default(),
            price_micros: if self.free { totals.cost.unwrap_or_default() } else { totals.price.unwrap_or_default() },
            cost_micros: totals.cost.unwrap_or_default(),
            provider_micros: totals.provider.unwrap_or_default(),
            used_micros: totals.cost.unwrap_or_default() + totals.provider.unwrap_or_default(),
            free: self.free,
            discount_micros: totals.discount.unwrap_or_default(),
            discount_percent: (discount_percent > 0).then_some(discount_percent),
            runs: totals.runs.unwrap_or_default(),
            added_micros: totals.added.unwrap_or_default(),
            by_day,
            by_task,
            by_repo,
            by_pull,
            by_model,
            since: a.since,
        }))
    }

    /// `checkout`: prepays usage, by card or (from $1,000) bank transfer.
    async fn checkout(&self, a: CheckoutArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.manages_billing(&workspace) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner or a billing manager can prepay for a workspace.",
            ));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "Payments are not set up on this g1t yet.",
            ));
        };
        let bank_transfer = a.method.as_deref() == Some("bank_transfer");
        if let Err(why) = prepay_amount(a.amount_cents, bank_transfer) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        // A bank transfer needs a customer for its account details.
        let customer = if bank_transfer {
            match self.customer_for(&workspace).await {
                Ok(customer) => Some(customer),
                Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, stripe::friendly(&error))),
            }
        } else {
            self.row(&workspace).await?.and_then(|row| row.customer_id)
        };
        // No card fee: what is prepaid is what is paid, before tax.
        let started = match stripe.start_checkout(&workspace, a.amount_cents, customer.as_deref(), &a.return_url, bank_transfer).await {
            // A customer saved under another Stripe account: start afresh.
            Err(error) if customer.is_some() && stripe::is_missing(&error) => {
                self.forget_customer(&workspace).await?;
                let customer = if bank_transfer { self.customer_for(&workspace).await.ok() } else { None };
                stripe.start_checkout(&workspace, a.amount_cents, customer.as_deref(), &a.return_url, bank_transfer).await
            }
            other => other,
        };
        self.page_opened(started, &workspace, a.amount_cents, 0, &a.actor.username, None).await
    }

    /// A payment page Stripe started (or refused), recorded in `checkouts`
    /// and handed back; any failure as a sentence for the page, never a
    /// raw error.
    pub(crate) async fn page_opened(
        &self,
        started: Result<stripe::Session>,
        workspace: &str,
        amount_cents: u32,
        fee_cents: u32,
        created_by: &str,
        feature: Option<&str>,
    ) -> Result<Outcome<Checkout>> {
        let session = match started {
            Ok(session) => session,
            Err(error) => {
                worker::console_error!("{workspace}: Stripe refused a payment page ({}): {error}", feature.unwrap_or("prepay"));
                return Ok(Outcome::fail(FailureCode::Conflict, stripe::friendly(&error)));
            }
        };
        let Some(url) = session.url.clone() else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Stripe returned no payment page. Try again in a minute."));
        };
        let recorded = self
            .record_checkout(&NewCheckout { id: &session.id, workspace, amount_cents, fee_cents, created_by, feature })
            .await;
        if let Err(error) = recorded {
            worker::console_error!("{workspace}: a payment page could not be recorded: {error}");
            return Ok(Outcome::fail(FailureCode::Conflict, "g1t could not keep track of the payment page. Nothing was charged; try again."));
        }
        Ok(Outcome::Ok(Checkout { url }))
    }

    /// Credits a payment if the processor says it was made and it has not
    /// been credited before. The amount credited is what the processor
    /// says was paid, not what anyone here remembers asking for.
    async fn confirm(&self, a: ConfirmArgs) -> Result<Outcome<Account>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let (Some(stripe), Some(checkout)) = (
            &self.stripe,
            self.db
                .prepare(
                    // A prepayment only: a plan's or a card check's page is
                    // settled where it was started, never credited as money
                    // paid in advance.
                    "SELECT workspace, created_by, fee_cents FROM checkouts
                     WHERE id = ? AND workspace = ? AND status = 'open' AND feature IS NULL",
                )
                .bind(&[a.session.as_str().into(), workspace.as_str().into()])?
                .first::<CheckoutRow>(None)
                .await?,
        ) else {
            // Unknown, someone else's, or already credited: nothing to do.
            return Ok(Outcome::Ok(self.standing(&workspace).await?));
        };
        let session = match stripe.session(&a.session).await {
            Ok(session) => session,
            Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error))),
        };
        if session.payment_status == "paid" && session.amount_total.is_some() {
            // The credit first, then the page marked paid: entered once
            // (the ledger's reference is the page), however many confirm it
            // at once, and never a page marked paid with no credit if the
            // second write fails; the next to look marks it.
            self.credit_prepayment(&checkout.workspace, &session, checkout.fee_cents.unwrap_or(0), &checkout.created_by).await?;
            self.db
                .prepare("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open'")
                .bind(&[a.session.as_str().into()])?
                .run()
                .await?;
        }
        Ok(Outcome::Ok(self.standing(&workspace).await?))
    }

    /// Enters a paid prepayment page: what its lines came to before tax,
    /// less any card fee (only pages opened before the fee was folded into
    /// prices had one), as credit; its tax and fee kept apart. Once per
    /// page, by the ledger's unique reference: a page credited already
    /// enters nothing (0). The credit in cents.
    pub(crate) async fn credit_prepayment(&self, workspace: &str, session: &stripe::Session, fee_cents: u32, by: &str) -> Result<i64> {
        let seen = self.db.prepare("SELECT id FROM ledger WHERE reference = ?").bind(&[session.id.as_str().into()])?.first::<Touched>(None).await?;
        if seen.is_some() {
            return Ok(0);
        }
        let fee = i64::from(fee_cents);
        let cents = tax::prepay_credit_cents(session.before_tax_cents(), fee);
        let tax_cents = session.tax_cents();
        let description = format!("Paid in advance{}", tax::paid_with(tax::Extras { tax_cents, fee_cents: fee }));
        let mut writes = self
            .entry_statements(
                workspace,
                EntryKind::TopUp,
                cents * MICROS_PER_DOLLAR / 100,
                &description,
                &session.id,
                None,
                Some(by),
                session.customer.as_deref(),
            )?;
        writes.extend(self.after_entry_statements(workspace, "top_up", cents * 10_000)?);
        writes.extend(self.extras_statements(workspace, &session.id, session.payment_intent.as_deref(), tax::Extras { tax_cents, fee_cents: fee }, None)?);
        match self.db.batch(writes).await {
            Ok(_) => {}
            // Credited a moment ago by whoever confirmed it alongside.
            Err(error) if is_duplicate(&error) => return Ok(0),
            Err(error) => return Err(error),
        }
        Ok(cents)
    }

    /// Drops a saved customer the card processor no longer knows.
    pub(crate) async fn forget_customer(&self, workspace: &str) -> Result<()> {
        self.db
            .prepare(
                "UPDATE accounts SET customer_id = NULL, card_brand = NULL, card_last4 = NULL, card_exp_month = NULL,
                   card_exp_year = NULL, card_synced_at = NULL WHERE workspace = ?",
            )
            .bind(&[workspace.into()])?
            .run()
            .await?;
        Ok(())
    }
}

impl Billing {
    /// Records how long a sandbox ran, with its cost and its charge: every
    /// second, from the first, at the price book's price; on its own CPU
    /// when it reports it. Settles its reservation, if it names one.
    async fn record_sandbox(&self, a: RecordSandboxArgs) -> Result<Outcome<bool>> {
        // Self-hosted time is recorded wherever g1t runs, for its minutes;
        // anything else only where there is a bill to put it on.
        if (!self.charging && !a.self_hosted) || a.seconds == 0 {
            return Ok(Outcome::Ok(false));
        }
        let workspace = a.workspace.to_lowercase();
        let seen = self
            .db
            .prepare("SELECT id FROM ledger WHERE reference = ?")
            .bind(&[a.reference.as_str().into()])?
            .first::<Touched>(None)
            .await?;
        if seen.is_some() {
            return Ok(Outcome::Ok(false));
        }
        let now = now_ms();
        let timestamp = rfc3339(now);
        let seconds = i64::from(a.seconds);
        // On the workspace's own machine: its minutes go on usage, at $0,
        // and whatever was reserved for it is given back.
        if a.self_hosted {
            let description = format!("{}: {} of self-hosted runner time, $0", a.description, duration(seconds));
            self.db
                .prepare(
                    "INSERT INTO ledger
                       (id, workspace, kind, amount_micros, description, repo, task,
                        cost_micros, reference, created_at, billed_to, credit_micros, trial_micros, oss_micros, given_micros, quantity)
                     VALUES (?, ?, 'usage', 0, ?, ?, 'self_hosted', 0, ?, ?, 'workspace', 0, 0, 0, 0, ?)
                     ON CONFLICT (reference) DO NOTHING",
                )
                .bind(&[
                    new_id("led", now).into(),
                    workspace.as_str().into(),
                    description.as_str().into(),
                    optional(a.repo.as_deref()),
                    a.reference.as_str().into(),
                    timestamp.as_str().into(),
                    (seconds as f64).into(),
                ])?
                .run()
                .await?;
            if let Some(reservation) = &a.reservation_id {
                self.settle_reservation(SettleArgs { reservation_id: reservation.clone(), actual_micros: 0 }).await?;
            }
            return Ok(Outcome::Ok(true));
        }
        // From the price book, which follows what Cloudflare bills g1t. A
        // sandbox is the same container as a build, so without a row it is
        // a build second's cost plus the margin.
        let (cost_per_second, _) = self.price("sandbox_second").await?.unwrap_or_else(|| {
            let cost = deployment_costs::MICROS_PER_BUILD_SECOND as f64;
            (cost, Price::price_for(cost, self.margin_percent))
        });
        // The machine it ran on, from the catalogue by its `runs-on` label
        // (a retired machine's too, for a job started before it retired);
        // the standard one otherwise. What it cost g1t: a machine's memory
        // and disk cost what they are each second, and without its own CPU
        // it is costed at its vCPUs as busy as the standard machine's.
        let instance = a.instance.as_deref().and_then(g1t_contracts::actions::billed_instance).unwrap_or(g1t_contracts::actions::STANDARD_INSTANCE);
        let base_scale = keeper::base_scale(instance.memory_gib, instance.disk_gb);
        let cost_scale = keeper::busy_scale(&instance);
        let vcpus = instance.vcpu.max(4.0);
        // Its own CPU when the sandbox reports it; otherwise the average.
        let parts = match a.cpu_seconds.filter(|cpu| cpu.is_finite() && *cpu >= 0.0) {
            Some(cpu) => match (self.price("sandbox_base_second").await?, self.price("sandbox_cpu_second").await?) {
                (Some((base, _)), Some((vcpu, _))) => {
                    Some((keeper::run_cost(seconds, cpu.min(seconds as f64 * vcpus), base * base_scale, vcpu), cpu))
                }
                _ => None,
            },
            None => None,
        };
        let cost = parts.map_or(seconds as f64 * cost_per_second * cost_scale, |(cost, _)| cost).ceil() as i64;
        // Charged by the job: its minutes, rounded up, at the machine's rate
        // (never under what it cost g1t plus the margin).
        let (minutes, price) = keeper::runner_charge(seconds, &instance, cost, self.margin_percent);
        let (charge, terms_note, discount) = self.charged(&workspace, price).await?;
        let eligible = credits::eligible_for(a.kind, a.repo.as_deref());
        let month = credits::month_of(&timestamp);
        // Resolve price versions before the atomic allocation and posting.
        let meters: &[&str] = if parts.is_some() { &["sandbox_base_second", "sandbox_cpu_second"] } else { &["sandbox_second"] };
        let mut versions = Vec::new();
        for meter in meters {
            versions.extend(self.version_now(meter).await?);
        }
        let price_version = versions.join(",");
        let drawn = credits::Drawn::default();
        let plan = self.has_plan(&workspace).await?;
        let charge = charge - drawn.total();
        let description = format!(
            "{}: {}, {} on the {} machine{terms_note}{}",
            a.description,
            duration(seconds),
            keeper::minutes_text(minutes),
            instance.machine,
            drawn.note()
        );
        // The ledger's unique reference decides between duplicate
        // deliveries: the entry goes in, and the balance moves, only for the
        // first; a later delivery consumes no allowance.
        let id = new_id("led", now);
        let mut writes = vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, repo, task,
                            cost_micros, reference, created_at, billed_to, credit_micros, trial_micros, oss_micros, given_micros, price_version, quantity, compute, machine)
                         VALUES (?, ?, 'usage', ?, ?, ?, 'sandbox', ?, ?, ?, 'g1t', ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (reference) DO NOTHING RETURNING id",
                    )
                    .bind(&[
                        id.as_str().into(),
                        workspace.as_str().into(),
                        (-(charge as f64)).into(),
                        description.as_str().into(),
                        optional(a.repo.as_deref()),
                        (cost as f64).into(),
                        a.reference.as_str().into(),
                        timestamp.as_str().into(),
                        (drawn.credit as f64).into(),
                        (drawn.trial as f64).into(),
                        (drawn.oss as f64).into(),
                        (drawn.given as f64).into(),
                        optional(Some(price_version.as_str()).filter(|v| !v.is_empty())),
                        // Runner minutes, as charged; lines with no machine
                        // (before minutes) hold seconds.
                        (minutes as f64).into(),
                        optional(a.kind.map(ComputeKind::as_str)),
                        instance.machine.into(),
                    ])?,
            ];
        writes.extend(self.allocation_statements(&id, &workspace, &month, &eligible, plan).await?);
        writes.push(self.balance_if_posted(&workspace, &id)?);
        let results = self.db.batch(writes).await?;
        if !storage::posted(&results)? {
            return Ok(Outcome::Ok(false));
        }
        let (charge, drawn) = self.posted_allocation(&a.reference).await?;
        self.record_discount(&a.reference, discount).await?;
        self.count_spend(&workspace, cost, charge, &drawn).await;
        if let Some(reservation) = &a.reservation_id {
            self.settle_reservation(SettleArgs { reservation_id: reservation.clone(), actual_micros: cost }).await?;
        }
        Ok(Outcome::Ok(true))
    }
}

/// Whether g1t charges, from `CHARGING`: `on` or `off`; unset (or
/// anything else), whether the card processor's key is set, as before the
/// switch.
pub(crate) fn charging_from(var: Option<&str>, has_key: bool) -> bool {
    match var.map(str::trim) {
        Some("on") => true,
        Some("off") => false,
        _ => has_key,
    }
}

/// Whether an amount may be prepaid: $25 at the least by card, and from
/// $1,000 by bank transfer.
pub(crate) fn prepay_amount(cents: u32, bank_transfer: bool) -> std::result::Result<(), String> {
    let (min, max) = if bank_transfer { (MIN_BANK_TRANSFER_CENTS, MAX_BANK_TRANSFER_CENTS) } else { (MIN_TOP_UP_CENTS, MAX_TOP_UP_CENTS) };
    if (min..=max).contains(&cents) {
        return Ok(());
    }
    Err(if bank_transfer {
        format!("Prepay between ${} and ${} by bank transfer.", min / 100, group(max / 100))
    } else {
        format!("Prepay between ${} and ${} by card; from $1,000, a bank transfer works too.", min / 100, group(max / 100))
    })
}

/// `10,000` for 10000.
fn group(n: u32) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
/// What `seconds` of sandbox time are charged at `price_per_second`, in
/// millionths of a dollar: every second, rounded up to the next millionth.
fn sandbox_charge(seconds: i64, price_per_second: f64) -> i64 {
    (seconds as f64 * price_per_second).ceil() as i64
}

/// `1h 2m`, `3m 12s` or `40s`.
fn duration(seconds: i64) -> String {
    let (h, m, s) = (seconds / 3600, seconds % 3600 / 60, seconds % 60);
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m {s}s")
    } else {
        format!("{s}s")
    }
}

impl Billing {
    /// What a workspace is charged for something that would be `base`:
    /// nothing while g1t is free, or as its account's terms say. With a
    /// note for the statement when it differs.
    /// A charge at cost plus the margin (`base`) on the account's terms:
    /// what is charged, the note for the statement, and what a discount
    /// gave away below `base`. That last is written on the entry
    /// (`record_discount`) so the reconciliation counts it as given, never
    /// as margin lost: a sold charge is worth at least its cost plus the
    /// margin.
    pub(crate) async fn charged(&self, workspace: &str, base: i64) -> Result<(i64, String, i64)> {
        if self.free {
            return Ok((0, " (free while g1t is being built out)".to_owned(), 0));
        }
        let terms = self.terms_of(workspace).await?;
        let (charge, discount) = terms.discounted(base);
        let note = match terms.discount_label() {
            Some(label) if base > 0 => format!(" ({label})"),
            _ => String::new(),
        };
        Ok((charge, note, discount))
    }

    /// What a discount gave away on an entry, below cost plus the margin
    /// (less than nothing on a correction down).
    pub(crate) async fn record_discount(&self, reference: &str, micros: i64) -> Result<()> {
        if micros == 0 {
            return Ok(());
        }
        self.db
            .prepare("UPDATE ledger SET discount_micros = ? WHERE reference = ?")
            .bind(&[(micros as f64).into(), reference.into()])?
            .run()
            .await?;
        Ok(())
    }
}

fn members_only<T>() -> Outcome<T> {
    Outcome::fail(
        FailureCode::Forbidden,
        "Only members can see a workspace's billing.",
    )
}

impl Billing {
    fn from_env(env: &Env) -> Result<Self> {
        let stripe = env
            .secret("STRIPE_SECRET_KEY")
            .ok()
            .map(|key| key.to_string())
            .filter(|key| !key.is_empty())
            .map(Stripe::new);
        let charging = charging_from(env.var("CHARGING").ok().map(|v| v.to_string()).as_deref(), stripe.is_some());
        if charging && stripe.is_none() {
            worker::console_error!(
                "CHARGING is on but STRIPE_SECRET_KEY is not set: usage is recorded, free workspaces are held to their limits, and nothing can be paid"
            );
        }
            Ok(Billing {
            db: env.d1("DB")?,
            stripe,
            charging,
            webhook_secret: env
                .secret("STRIPE_WEBHOOK_SECRET")
                .ok()
                .map(|secret| secret.to_string().trim().to_owned())
                .filter(|secret| !secret.is_empty()),
            margin_percent: env
                .var("MARGIN_PERCENT")
                .ok()
                .and_then(|percent| percent.to_string().parse().ok())
                .unwrap_or(20),
            free: env.var("FREE_WHILE_BUILDING").is_ok_and(|v| v.to_string() == "true"),
            ceilings: limits::Ceilings::from_env(env),
            trials_on: {
                let plans = credits::Config::from_env(env);
                plans.trial_workspace_micros > 0 && plans.trial_monthly_pool_micros > 0
            },
            plans: credits::Config::from_env(env),
            repos: env.service("REPOS").ok(),
            packages: env.service("PACKAGES").ok(),
            identity: env.service("IDENTITY").ok(),
            caps: budget::Caps::from_env(env),
            sealer: env.secret("BILLING_KEY").ok().and_then(|key| g1t_secrets::Sealer::new(&key.to_string())),
            env: env.clone(),
        })
    }
}

/// The fifteen-minute steps, each on its own: one failing never skips the
/// rest.
async fn tick(billing: &Billing, env: &Env) {
    // Stripe events billing never received, handled now.
    match billing.replay_events().await {
        Ok(done) => worker::console_log!("stripe replay: {done}"),
        Err(error) => worker::console_error!("replaying Stripe events failed: {error}"),
    }
    // This month's users, read once for autopay and the warnings.
    let users = if billing.charging {
        match billing.month_users().await {
            Ok(users) => Some(users),
            Err(error) => {
                worker::console_error!("reading this month's users failed: {error}");
                None
            }
        }
    } else {
        None
    };
    if let Some(users) = &users
        && let Err(error) = billing.autopay(users).await {
            worker::console_error!("paying at the limit failed: {error}");
        }
    // Last month's final count of git operations, once it is over: until
    // it is taken, last month is neither charged nor closed.
    if let Err(error) = billing.measure_last_month_git().await {
        worker::console_error!("measuring last month's git operations failed: {error}");
    }
    // Last month's metered usage (scans, embeddings, storage) goes on the
    // ledger before the month is closed and invoiced.
    if let Err(error) = billing.charge_pending().await {
        worker::console_error!("charging last month's metered usage failed: {error}");
    }
    if let Err(error) = billing.close_months().await {
        worker::console_error!("closing the month failed: {error}");
    }
    // Complimentary enrollments' Stripe steps still owed.
    if let Err(error) = billing.complimentary_tick().await {
        worker::console_error!("complimentary Stripe steps failed: {error}");
    }
    if let Err(error) = billing.invoice_enterprises().await {
        worker::console_error!("invoicing enterprises failed: {error}");
    }
    if let Some(users) = &users
        && let Ok(identity) = env.service("IDENTITY")
        && let Err(error) = billing.warn_limits(&identity, users).await {
            worker::console_error!("warning owners failed: {error}");
        }
}

/// Every fifteen minutes: runs settled, Stripe replayed, cards charged at
/// the limit, months closed, owners warned. Once a day, at
/// [`keeper::DAILY`], in an invocation of its own: the slower checks
/// against Stripe and Cloudflare, and measuring.
///
/// Each step logs its own failure and the next still runs. The spend
/// breaker and budget alerts go first: a step that runs out of CPU ends
/// the invocation, and must never take the alerts with it.
#[event(scheduled)]
async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let Ok(billing) = Billing::from_env(&env) else {
        return;
    };
    // Comped budgets' alerts, and a tripped breaker staff were not told of.
    if let Err(error) = billing.watch_spend().await {
        worker::console_error!("watching g1t's own spend failed: {error}");
    }
    let keeper = keeper::Keeper::from_env(&env);
    // Once an hour, at the quarter past: what Cloudflare counted for the
    // whole platform in the hour before, against its thresholds
    // (platform.rs).
    if event.cron() == keeper::QUARTER_HOURLY && platform::hourly_due(now_ms()) {
        match billing.watch_platform(&keeper).await {
            Ok((read, breached)) => worker::console_log!("platform watch: {read} metrics, {breached} breaches"),
            Err(error) => worker::console_error!("watching platform usage failed: {error}"),
        }
    }
    let daily = event.cron() == keeper::DAILY;
    if !daily {
        tick(&billing, &env).await;
    }
    // Once a day: Stripe's endpoint kept listening to billing's events and
    // enabled, and saved cards and plans not read in a while read again.
    if daily {
        match billing.keep_endpoint("billing").await {
            Ok(done) => worker::console_log!("stripe endpoint: {done}"),
            Err(error) => worker::console_error!("keeping Stripe's endpoint failed: {error}"),
        }
        match billing.refresh_from_stripe().await {
            Ok(done) => worker::console_log!("stripe refresh: {done}"),
            Err(error) => worker::console_error!("refreshing from Stripe failed: {error}"),
        }
    }
    // Once a day, and at once if the costs were never checked: check every
    // cost against what Cloudflare billed.
    if (daily || billing.never_checked().await.unwrap_or(false))
        && let Err(error) = billing.reconcile(&keeper).await {
            worker::console_error!("checking costs against Cloudflare failed: {error}");
        }
    // Once a day: credit from g1t past its expiry stops counting
    // (grants.rs), before the day is reconciled.
    if daily {
        match billing.expire_credits().await {
            Ok(closed) => worker::console_log!("credits expired: {closed}"),
            Err(error) => worker::console_error!("expiring credits failed: {error}"),
        }
    }
    // Once a day: what Cloudflare charged, reconciled against what g1t
    // counted and charged; prices whose day has come; margin alerts
    // (margin.rs). After the keeper, so its proposals are in.
    if daily {
        match billing.costs_daily(&env, &keeper).await {
            Ok(run) => worker::console_log!("costs: {} lines, {} days, {} proposals, {} alerts", run.lines, run.days, run.proposals, run.alerts),
            Err(error) => worker::console_error!("reconciling costs failed: {error}"),
        }
    }
    // Once a day: what each workspace's private repositories hold, its git
    // operations, Deployments plans from before the g1t plan set to end,
    // and old reservations cleared.
    if daily {
        if let Err(error) = billing.measure_packages().await {
            worker::console_error!("measuring package storage failed: {error}");
        }
        if let Err(error) = billing.measure_storage().await {
            worker::console_error!("measuring storage failed: {error}");
        }
        if let Err(error) = billing.measure_git().await {
            worker::console_error!("measuring git operations failed: {error}");
        }
        if let Err(error) = billing.retire_deployments_plans().await {
            worker::console_error!("ending Deployments plans failed: {error}");
        }
        if let Err(error) = billing.retire_security_activations().await {
            worker::console_error!("ending Security and quality activations failed: {error}");
        }
        if let Err(error) = billing.sweep_reservations().await {
            worker::console_error!("clearing reservations failed: {error}");
        }
        // What each connected AI provider says its organization spent
        // (provider_costs.rs): the last days again, each provider on its own.
        match billing.sync_provider_costs().await {
            Ok((read, failed)) => worker::console_log!("provider costs: {read} read, {failed} failed"),
            Err(error) => worker::console_error!("reading provider costs failed: {error}"),
        }
        // The AI Gateway's request log, from when there was one, still
        // keeps only its last 30 days until it is empty.
        let cutoff = rfc3339(now_ms().saturating_sub(30 * 24 * 60 * 60 * 1000));
        let cleared = match billing.db.prepare("DELETE FROM gateway_requests WHERE created_at < ?").bind(&[cutoff.into()]) {
            Ok(statement) => statement.run().await.map(|_| ()),
            Err(error) => Err(error),
        };
        if let Err(error) = cleared {
            worker::console_error!("clearing old AI Gateway requests failed: {error}");
        }
    }
}

/// Events from the bus, on billing's own queue: only a workspace's rename
/// matters here (see `rename`).
#[event(queue)]
async fn queue(batch: MessageBatch<g1t_contracts::events::Event>, env: Env, _ctx: Context) -> Result<()> {
    let billing = Billing::from_env(&env)?;
    let identity = env.service("IDENTITY").ok();
    for message in batch.messages()? {
        // A repository transferred: its share of the open-source pool this
        // month follows it. What it was charged stays with the workspace
        // it was charged to; usage from now on is charged to the new one.
        if g1t_kit::transfer::on_event(&env, &billing.db, message.body(), closing::TRANSFERRED).await? {
            message.ack();
            continue;
        }
        billing.on_event(identity.as_ref(), message.body()).await?;
        message.ack();
    }
    Ok(())
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    // A replica near the caller when it asks for one (crates/kit/src/d1.rs);
    // what other services call (can_start, start_run) asks for none.
    let (db, served) = g1t_kit::d1::open(&env, "DB", &request)?;
    let body: serde_json::Value = request.json().await?;
    let mut billing = Billing::from_env(&env)?;
    billing.db = db;
    let answered = match method.as_str() {
        "status" => reply(&billing.status()),
        "account" => reply(&billing.account(args(body)?).await?),
        "ledger" => reply(&billing.ledger(args(body)?).await?),
        "credits" => reply(&billing.credits(args(body)?).await?),
        "usage" => reply(&billing.usage(args(body)?).await?),
        "usage_report" => reply(&billing.usage_report(args(body)?).await?),
        "set_budget" => reply(&billing.set_budget(args(body)?).await?),
        "billing_details" => reply(&billing.billing_details(args(body)?).await?),
        "set_billing_details" => reply(&billing.set_billing_details(args(body)?).await?),
        // Provider cost reports (provider_costs.rs).
        "provider_connections" => reply(&billing.provider_connections(args(body)?).await?),
        "connect_provider" => reply(&billing.connect_provider(args(body)?).await?),
        "disconnect_provider" => reply(&billing.disconnect_provider(args(body)?).await?),
        "provider_costs" => reply(&billing.provider_costs(args(body)?).await?),
        "provider_person_costs" => reply(&billing.provider_person_costs(args(body)?).await?),
        "checkout" => reply(&billing.checkout(args(body)?).await?),
        "confirm" => reply(&billing.confirm(args(body)?).await?),
        "trial" => reply(&billing.trial(args(body)?).await?),
        "features" => reply(&billing.features(args(body)?).await?),
        "subscribe" => reply(&billing.subscribe(args(body)?).await?),
        "confirm_subscription" => reply(&billing.confirm_subscription(args(body)?).await?),
        "cancel_subscription" => reply(&billing.cancel_subscription(args(body)?).await?),
        "close_workspace" => reply(&billing.close_workspace(args(body)?).await?),
        "has_feature" => reply(&billing.has_feature(args(body)?).await?),
        "free_workspaces" => reply(&billing.free_workspaces(args(body)?).await?),
        "charge_feature" => reply(&billing.charge_feature(args(body)?).await?),
        "record_sandbox" => reply(&billing.record_sandbox(args(body)?).await?),
        "limit" => reply(&billing.limit(args(body)?).await?),
        "check_limit" => reply(&billing.check_limit(args(body)?).await?),
        "set_spend_limit" => reply(&billing.set_spend_limit(args(body)?).await?),
        "prices" => reply(&billing.prices().await?),
        "billing_portal" => reply(&billing.billing_portal(args(body)?).await?),
        "set_customer_email" => reply(&billing.set_customer_email(args(body)?).await?),
        "admin_billing_link" => reply(&billing.admin_billing_link(args(body)?).await?),
        "admin_stripe" => reply(&billing.admin_stripe(args(body)?).await?),
        "admin_enterprise_billing" => reply(&billing.admin_enterprise_billing(args(body)?).await?),
        "admin_enterprise_address" => reply(&billing.admin_enterprise_address(args(body)?).await?),
        "admin_invoice_enterprise" => reply(&billing.admin_invoice_enterprise(args(body)?).await?),
        "stripe_webhook" => reply(&billing.stripe_webhook(args(body)?).await?),
        "invoices" => reply(&billing.invoices(args(body)?).await?),
        "statement" => reply(&billing.statement(args(body)?).await?),
        "statement_entries" => reply(&billing.statement_entries(args(body)?).await?),
        "usage_meters" => reply(&billing.usage_meters(args(body)?).await?),
        "admin_workspace_invoices" => {
            let a: AdminWorkspaceInvoicesArgs = args(body)?;
            reply(&billing.workspace_invoices(&a.workspace.to_lowercase()).await?)
        }
        "admin_signals" => reply(&billing.admin_signals(args(body)?).await?),
        "admin_overview" => reply(&billing.admin_overview(args(body)?).await?),
        "admin_sales" => reply(&billing.admin_sales(args(body)?).await?),
        "admin_set_sales" => reply(&billing.admin_set_sales(args(body)?).await?),
        "admin_add_note" => reply(&billing.admin_add_note(args(body)?).await?),
        "admin_invoices" => reply(&billing.admin_invoices(args(body)?).await?),
        "admin_audit" => reply(&billing.admin_audit(args(body)?).await?),
        // A staff change made in another service, for sudo's audit log:
        // identity's restores and purges of deleted workspaces, and the
        // repos service's releases of storage holds, sent with a key so a
        // retried one is written once.
        "admin_log" => {
            let a: AdminLogArgs = args(body)?;
            let account = accounts::admin_log_account(&a).map_err(worker::Error::RustError)?;
            match accounts::admin_log_id(&a).map_err(worker::Error::RustError)? {
                Some(id) => billing.audit_once(&id, &account, &a.action, &a.detail, &a.by).await?,
                None => billing.audit(&account, &a.action, &a.detail, &a.by).await?,
            }
            reply(&true)
        }
        "note_pending" => reply(&billing.note_pending(args(body)?).await?),
        "admin_accounts" => reply(&billing.admin_accounts(args(body)?).await?),
        "admin_account" => reply(&billing.admin_account(args(body)?).await?),
        "admin_set_terms" => reply(&billing.admin_set_terms(args(body)?).await?),
        "admin_create_enterprise" => reply(&billing.admin_create_enterprise(args(body)?).await?),
        "admin_attach" => reply(&billing.admin_attach(args(body)?).await?),
        "admin_credit" => reply(&billing.admin_credit(args(body)?).await?),
        "admin_credits" => reply(&billing.admin_credits(args(body)?).await?),
        "admin_revoke_credit" => reply(&billing.admin_revoke_credit(args(body)?).await?),
        "admin_reset_billing" => reply(&billing.admin_reset_billing(&env, args(body)?).await?),
        "admin_detach_test_stripe" => reply(&billing.admin_detach_test_stripe(args(body)?).await?),
        "admin_set_allowances" => reply(&billing.admin_set_allowances(args(body)?).await?),
        "admin_complimentary" => reply(&billing.admin_complimentary(args(body)?).await?),
        "admin_set_complimentary" => reply(&billing.admin_set_complimentary(args(body)?).await?),
        "admin_end_complimentary" => reply(&billing.admin_end_complimentary(args(body)?).await?),
        "convert_to_paid" => reply(&billing.convert_to_paid(args(body)?).await?),
        "entitlements" => reply(&billing.entitlements(args(body)?).await?),
        "audit_retention" => reply(&billing.audit_retention(args(body)?).await?),
        "reserve" => reply(&billing.reserve(args(body)?).await?),
        "settle" => reply(&billing.settle_reservation(args(body)?).await?),
        "card_check" => reply(&billing.card_check(args(body)?).await?),
        "confirm_card_check" => reply(&billing.confirm_card_check(args(body)?).await?),
        "request_limit" => reply(&billing.request_limit(args(body)?).await?),
        "limit_requests" => reply(&billing.limit_requests(args(body)?).await?),
        "confirm_spike" => reply(&billing.confirm_spike(args(body)?).await?),
        "admin_limit_requests" => reply(&billing.admin_limit_requests(args(body)?).await?),
        "admin_decide_limit_request" => reply(&billing.admin_decide_limit_request(args(body)?).await?),
        "admin_overages" => reply(&billing.admin_overages(args(body)?).await?),
        "admin_goodwill" => reply(&billing.admin_goodwill(args(body)?).await?),
        "admin_velocity" => reply(&billing.admin_velocity(args(body)?).await?),
        "admin_record_payment" => reply(&billing.admin_record_payment(args(body)?).await?),
        "admin_costs" => reply(&billing.admin_costs(args(body)?, keeper::Keeper::from_env(&env).can_read_bill()).await?),
        "admin_cost_alerts" => reply(&billing.admin_cost_alerts(args(body)?).await?),
        "admin_spend_caps" => reply(&billing.spend_caps().await?),
        "admin_lift_breaker" => reply(&billing.admin_lift_breaker(args(body)?).await?),
        // Platform pauses (src/platform.rs): read by every service that
        // honours one, kept 30 seconds in each isolate.
        "platform_pause" => reply(&billing.pause_now().await),
        "admin_platform_guard" => reply(&billing.platform_guard(&keeper::Keeper::from_env(&env)).await?),
        "admin_set_pause" => reply(&billing.admin_set_pause(args(body)?, &keeper::Keeper::from_env(&env)).await?),
        // The git edge for sudo (src/git_edge.rs): its containers and cost.
        "admin_git_edge" => reply(&billing.git_edge(&keeper::Keeper::from_env(&env)).await?),
        "admin_decide_proposal" => reply(&billing.admin_decide_proposal(args(body)?).await?),
        "admin_set_cost_settings" => reply(&billing.admin_set_cost_settings(args(body)?).await?),
        "admin_set_cost_mapping" => reply(&billing.admin_set_cost_mapping(args(body)?).await?),
        "admin_run_costs" => reply(&billing.admin_run_costs(&env, args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    };
    served.finish(answered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charging_is_the_switch_not_the_key() {
        // On: charged and gated whether or not the key is set, so a lost
        // secret fails closed rather than admitting everyone for free.
        assert!(charging_from(Some("on"), false));
        assert!(charging_from(Some("on"), true));
        // Off: a self-hosted g1t charges nothing, key or not.
        assert!(!charging_from(Some("off"), false));
        assert!(!charging_from(Some("off"), true));
        // Unset: as before the switch, whether the key is set.
        assert!(charging_from(None, true));
        assert!(!charging_from(None, false));
        assert!(!charging_from(Some(""), false));
    }

    #[test]
    fn sandbox_time_is_charged_from_the_first_second() {
        // 21 millionths a second at cost, plus 20%.
        let price = Price::price_for(21.0, 20);
        assert_eq!(sandbox_charge(1, price), 26);
        assert_eq!(sandbox_charge(60, price), 1_512);
        assert_eq!(sandbox_charge(0, price), 0);
    }

    #[test]
    fn prepaying_starts_at_twenty_five_dollars_and_bank_transfers_at_a_thousand() {
        assert!(prepay_amount(2_500, false).is_ok());
        assert!(prepay_amount(2_499, false).is_err());
        assert!(prepay_amount(10_000, false).is_ok());
        assert!(prepay_amount(1_000_000, false).is_ok());
        assert_eq!(prepay_amount(1_000_001, false).unwrap_err(), "Prepay between $25 and $10,000 by card; from $1,000, a bank transfer works too.");
        assert!(prepay_amount(99_999, true).is_err());
        assert!(prepay_amount(100_000, true).is_ok());
    }

    #[test]
    fn durations_read_plainly() {
        assert_eq!(duration(40), "40s");
        assert_eq!(duration(192), "3m 12s");
        assert_eq!(duration(3720), "1h 2m");
    }

    /// Every migration, in order, as D1 applies them.
    const MIGRATIONS: &[&str] = &[
        include_str!("../migrations/0001_init.sql"),
        include_str!("../migrations/0002_own_provider.sql"),
        include_str!("../migrations/0003_subscriptions.sql"),
        include_str!("../migrations/0004_sandbox_time.sql"),
        include_str!("../migrations/0005_limits.sql"),
        include_str!("../migrations/0006_prices.sql"),
        include_str!("../migrations/0007_pending_usage.sql"),
        include_str!("../migrations/0008_accounts.sql"),
        include_str!("../migrations/0009_autopay.sql"),
        include_str!("../migrations/0010_month_close.sql"),
        include_str!("../migrations/0011_limit_warnings.sql"),
        include_str!("../migrations/0012_stripe_webhooks.sql"),
        include_str!("../migrations/0013_invoices_trust_sales.sql"),
        include_str!("../migrations/0014_custom_domain_price.sql"),
        include_str!("../migrations/0015_sandbox_at_cost.sql"),
        include_str!("../migrations/0016_plans_and_pools.sql"),
        include_str!("../migrations/0017_flagon_comped.sql"),
        include_str!("../migrations/0018_one_plan.sql"),
        include_str!("../migrations/0019_closed_workspaces.sql"),
        include_str!("../migrations/0020_syntaqx_standard.sql"),
        include_str!("../migrations/0021_no_quotas.sql"),
        include_str!("../migrations/0022_costs_and_margin.sql"),
        include_str!("../migrations/0023_one_operation_mapping.sql"),
        include_str!("../migrations/0024_spend_caps.sql"),
        include_str!("../migrations/0025_run_tier.sql"),
        include_str!("../migrations/0026_ledger_by_workspace_time.sql"),
        include_str!("../migrations/0027_stripe_cache.sql"),
        include_str!("../migrations/0028_drop_stripe_webhooks.sql"),
        include_str!("../migrations/0029_audit_retention.sql"),
        include_str!("../migrations/0030_token_usage.sql"),
        include_str!("../migrations/0031_package_storage.sql"),
        include_str!("../migrations/0032_workspace_value.sql"),
        include_str!("../migrations/0033_given_away.sql"),
        include_str!("../migrations/0034_given_by_why.sql"),
        include_str!("../migrations/0035_cf_subscriptions.sql"),
        include_str!("../migrations/0036_model_costs_in_full.sql"),
        include_str!("../migrations/0037_security_activation.sql"),
        include_str!("../migrations/0038_staff_credits.sql"),
        include_str!("../migrations/0039_discounts_not_comped.sql"),
        include_str!("../migrations/0040_ai_credit.sql"),
        include_str!("../migrations/0041_agent_rate_own_key.sql"),
        include_str!("../migrations/0042_agent_rate_weights.sql"),
        include_str!("../migrations/0043_tax_and_card_fees.sql"),
        include_str!("../migrations/0044_cache_reads_count_a_tenth.sql"),
        include_str!("../migrations/0045_gateway.sql"),
        include_str!("../migrations/0046_reset_costs.sql"),
        include_str!("../migrations/0047_gateway_formats.sql"),
        include_str!("../migrations/0048_model_catalogue.sql"),
        include_str!("../migrations/0049_superseded_proposals.sql"),
        include_str!("../migrations/0050_ledger_usage_by_time.sql"),
        include_str!("../migrations/0051_platform_guardrails.sql"),
        include_str!("../migrations/0052_cloudflare_cycle.sql"),
        include_str!("../migrations/0053_models_at_cost.sql"),
        include_str!("../migrations/0054_agent_attribution.sql"),
        include_str!("../migrations/0055_app_containers.sql"),
        include_str!("../migrations/0056_sandbox_standard_3.sql"),
        include_str!("../migrations/0057_runner_minutes.sql"),
        include_str!("../migrations/0058_payment_safety.sql"),
        include_str!("../migrations/0059_telemetry_ingest.sql"),
        include_str!("../migrations/0060_pending_baselines.sql"),
        include_str!("../migrations/0061_measured_months.sql"),
        include_str!("../migrations/0062_invoice_attempts.sql"),
        include_str!("../migrations/0063_enterprise_attempts.sql"),
        include_str!("../migrations/0064_complimentary.sql"),
        include_str!("../migrations/0065_free_except_flagon.sql"),
        include_str!("../migrations/0066_drop_issue_caps.sql"),
        include_str!("../migrations/0067_provider_costs.sql"),
        include_str!("../migrations/0068_provider_person_costs.sql"),
    ];

    /// The columns of `table` after the migrations: each with whether an
    /// insert must give it (NOT NULL, no default).
    fn columns(table: &str) -> Vec<(String, bool)> {
        let mut out = vec![];
        for sql in MIGRATIONS {
            let sql: String = sql.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
            if let Some(start) = sql.find(&format!("CREATE TABLE {table} (")) {
                let body = &sql[start + format!("CREATE TABLE {table} (").len()..];
                let body = &body[..body.find(");").unwrap()];
                for column in body.split(",\n") {
                    let column = column.trim();
                    let name = column.split_whitespace().next().unwrap_or("").to_owned();
                    if name.is_empty() || name == "PRIMARY" {
                        continue;
                    }
                    let required = column.contains("NOT NULL") && !column.contains("DEFAULT") && !column.contains("PRIMARY KEY");
                    out.push((name, required || column.contains("PRIMARY KEY")));
                }
            }
            for statement in sql.split(';') {
                let s = statement.trim();
                if let Some(rest) = s.strip_prefix(&format!("ALTER TABLE {table} ADD COLUMN ")) {
                    let name = rest.split_whitespace().next().unwrap().to_owned();
                    out.push((name, rest.contains("NOT NULL") && !rest.contains("DEFAULT")));
                }
            }
        }
        out
    }

    /// The columns an `INSERT [OR IGNORE] INTO table (…)` names.
    fn inserted(sql: &str, table: &str) -> Vec<String> {
        let start = sql.find(&format!("INTO {table} (")).unwrap() + format!("INTO {table} (").len();
        sql[start..start + sql[start..].find(')').unwrap()].split(',').map(|c| c.trim().to_owned()).collect()
    }


    #[test]
    fn every_checkout_insert_fills_the_table() {
        // The plan's, the activation's, a card check's and a prepayment's
        // pages all go through one insert, and it names every
        // column the table needs and none it lacks: a missing NOT NULL
        // column, or one from a migration not yet applied, was a 500.
        let table = columns("checkouts");
        let names: Vec<&str> = table.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["id", "workspace", "amount_cents", "created_by", "status", "created_at", "feature", "fee_cents"]);
        let given = inserted(CHECKOUT_INSERT, "checkouts");
        for column in &given {
            assert!(names.contains(&column.as_str()), "the insert names {column}, which checkouts does not have");
        }
        for (column, required) in &table {
            assert!(!required || given.contains(column), "checkouts needs {column}, which the insert leaves out");
        }
        // As many values as columns.
        let values = CHECKOUT_INSERT.split("VALUES").nth(1).unwrap();
        assert_eq!(values.matches('?').count() + values.matches("'open'").count(), given.len());
        // And no page writes a row of its own any more.
        for (file, source) in [
            ("lib.rs", include_str!("lib.rs")),
            ("features.rs", include_str!("features.rs")),
            ("cards.rs", include_str!("cards.rs")),
        ] {
            let inserts = source.matches(concat!("INTO ", "checkouts (")).count();
            assert!(inserts <= usize::from(file == "lib.rs"), "{file} inserts into checkouts on its own");
        }
        // The same page handed out twice (Stripe's idempotency window) is
        // one row, never a failed insert.
        assert!(CHECKOUT_INSERT.starts_with("INSERT OR IGNORE INTO checkouts"));
    }

    #[test]
    fn a_payment_credited_alongside_is_never_credited_twice() {
        assert!(is_duplicate(&worker::Error::RustError("D1_ERROR: UNIQUE constraint failed: ledger.reference: SQLITE_CONSTRAINT".into())));
        assert!(!is_duplicate(&worker::Error::RustError("D1_ERROR: network".into())));
        // The reference every credit is entered under is unique.
        assert!(include_str!("../migrations/0001_init.sql").contains("reference TEXT NOT NULL UNIQUE"));
    }

    #[test]
    fn a_new_ledger_column_has_a_default() {
        // The ledger is written from a dozen places; a column without a
        // default would break every one that does not name it.
        for (column, required) in columns("ledger") {
            assert!(!required || ["id", "workspace", "kind", "amount_micros", "description", "reference", "created_at"].contains(&column.as_str()), "{column}");
        }
    }
}
