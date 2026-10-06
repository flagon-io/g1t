//! The billing service: what g1t's compute costs, charged to the workspace
//! it ran for at what g1t pays plus 20%.
//!
//! One paid plan, "g1t" (see `features`): $20 a month per workspace, never
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
mod budget;
mod cards;
mod closing;
mod compute;
mod costs;
mod margin;
mod pricing;
mod credits;
mod overages;
mod requests;
mod storage;
mod invoices;
mod sales;
mod statement;
mod webhooks;
mod features;
mod keeper;
mod limits;
mod rename;
mod retention;
mod stripe;
mod stripe_sync;

use g1t_contracts::billing::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, new_id};
use g1t_contracts::billing::TermsKind;
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use sha2::{Digest, Sha256};
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
/// A run's reported cost is believed up to this much. A sandbox cannot
/// spend more in the time it has, so anything above is a fault.
const MAX_RUN_COST_USD: f64 = 100.0;

/// What a run is charged: its cost plus the margin, rounded up to a whole
/// millionth of a dollar.
pub fn charge_micros(cost_usd: f64, margin_percent: u32) -> i64 {
    let cost_micros = (cost_usd.clamp(0.0, MAX_RUN_COST_USD) * MICROS_PER_DOLLAR as f64).ceil();
    (cost_micros * f64::from(100 + margin_percent) / 100.0).ceil() as i64
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
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
        }
    }
}

#[derive(Deserialize)]
struct RunRow {
    workspace: String,
    repo: String,
    number: u32,
    task: String,
    model: String,
    token_hash: String,
    billed_to: Option<String>,
}

impl RunRow {
    fn own_provider(&self) -> bool {
        self.billed_to.as_deref() == Some("workspace")
    }
}

#[derive(Deserialize)]
struct CheckoutRow {
    workspace: String,
    created_by: String,
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
    /// The identity service, which emails owners. Absent where it is not
    /// bound.
    identity: Option<worker::Fetcher>,
    /// How far unpaid usage may go; see `limits`.
    ceilings: limits::Ceilings,
    /// `PREPAID_ONLY`: the old rule, that agents need credit first.
    prepaid_only: bool,
    /// The caps on what g1t pays for itself; see `budget`.
    caps: budget::Caps,
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
        let customer = stripe.create_customer(workspace).await?;
        self.db
            .prepare(
                "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at) VALUES (?1, 0, ?2, ?3)
                 ON CONFLICT (workspace) DO UPDATE SET customer_id = ?2",
            )
            .bind(&[workspace.into(), customer.as_str().into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(customer)
    }

    /// Stripe's hosted billing page for the workspace. Owners only.
    async fn billing_portal(&self, a: BillingPortalArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can manage the workspace's billing."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        let customer = match self.customer_for(&workspace).await {
            Ok(customer) => customer,
            Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, format!("Stripe could not be reached: {error}"))),
        };
        match stripe.portal_session(&customer, &a.return_url).await {
            Ok(url) => Ok(Outcome::Ok(Checkout { url })),
            Err(error) if stripe::is_missing(&error) => {
                // The customer was removed at Stripe: a new one next time.
                self.forget_customer(&workspace).await?;
                Ok(Outcome::fail(FailureCode::Conflict, "Stripe no longer had this workspace's customer. Try again."))
            }
            Err(error) => Ok(Outcome::fail(FailureCode::Conflict, format!("Stripe's billing page could not be opened: {error}"))),
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
        run: Option<&RunRow>,
        cost_micros: Option<i64>,
        created_by: Option<&str>,
        customer: Option<&str>,
    ) -> Result<()> {
        let now = now_ms();
        let timestamp = rfc3339(now);
        let kind = match kind {
            EntryKind::TopUp => "top_up",
            EntryKind::Usage => "usage",
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, repo, number, task,
                            model, cost_micros, reference, created_by, created_at, billed_to)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        new_id("led", now).into(),
                        workspace.into(),
                        kind.into(),
                        // D1 takes numbers as doubles, which hold every
                        // amount this service will see exactly.
                        (amount_micros as f64).into(),
                        description.into(),
                        optional(run.map(|run| run.repo.as_str())),
                        run.map_or(JsValue::NULL, |run| run.number.into()),
                        optional(run.map(|run| run.task.as_str())),
                        optional(run.map(|run| run.model.as_str())),
                        cost_micros.map_or(JsValue::NULL, |cost| (cost as f64).into()),
                        reference.into(),
                        optional(created_by),
                        timestamp.as_str().into(),
                        run.map_or("g1t", |run| if run.own_provider() { "workspace" } else { "g1t" }).into(),
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
            .await?;
        // Money in clears a card declined at the limit.
        if kind == "top_up" {
            self.db
                .prepare("UPDATE limits SET autopay_failed_at = NULL, autopay_error = NULL WHERE workspace = ?")
                .bind(&[workspace.into()])?
                .run()
                .await?;
        }
        Ok(())
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
        // While nothing is charged, what was used is what there is to show.
        let measure = if self.free { "COALESCE(cost_micros, 0)" } else { "-amount_micros" };
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
        }
        let totals = async {
            self.db
                .prepare(
                    "SELECT
                       -SUM(CASE WHEN kind = 'usage' THEN amount_micros END) AS spent,
                       SUM(CASE WHEN kind = 'usage' AND COALESCE(billed_to, 'g1t') = 'g1t' THEN cost_micros END) AS cost,
                       SUM(CASE WHEN kind = 'usage' AND billed_to = 'workspace' THEN cost_micros END) AS provider,
                       SUM(CASE WHEN kind = 'usage' THEN 1 ELSE 0 END) AS runs,
                       SUM(CASE WHEN kind = 'top_up' THEN amount_micros END) AS added
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
        });
        Ok(Outcome::Ok(Usage {
            spent_micros: totals.spent.unwrap_or_default(),
            cost_micros: totals.cost.unwrap_or_default(),
            provider_micros: totals.provider.unwrap_or_default(),
            used_micros: totals.cost.unwrap_or_default() + totals.provider.unwrap_or_default(),
            free: self.free,
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
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can prepay for a workspace.",
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
                Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, format!("Stripe could not be reached: {error}"))),
            }
        } else {
            self.row(&workspace).await?.and_then(|row| row.customer_id)
        };
        let session = match stripe
            .start_checkout(&workspace, a.amount_cents, customer.as_deref(), &a.return_url, bank_transfer)
            .await
        {
            Ok(session) => session,
            // A customer saved under another Stripe account: start afresh.
            Err(error) if customer.is_some() && stripe::is_missing(&error) => {
                self.forget_customer(&workspace).await?;
                let customer = if bank_transfer { Some(self.customer_for(&workspace).await?) } else { None };
                stripe.start_checkout(&workspace, a.amount_cents, customer.as_deref(), &a.return_url, bank_transfer).await?
            }
            Err(error) => return Err(error),
        };
        let Some(url) = session.url else {
            return Err(worker::Error::RustError(
                "the card processor returned no payment page".into(),
            ));
        };
        self.db
            .prepare(
                "INSERT INTO checkouts (id, workspace, amount_cents, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&[
                session.id.into(),
                workspace.into(),
                a.amount_cents.into(),
                a.actor.username.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
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
                    "SELECT workspace, created_by FROM checkouts
                     WHERE id = ? AND workspace = ? AND status = 'open'",
                )
                .bind(&[a.session.as_str().into(), workspace.as_str().into()])?
                .first::<CheckoutRow>(None)
                .await?,
        ) else {
            // Unknown, someone else's, or already credited: nothing to do.
            return Ok(Outcome::Ok(self.standing(&workspace).await?));
        };
        let session = stripe.session(&a.session).await?;
        let paid = session
            .amount_total
            .filter(|_| session.payment_status == "paid");
        if let Some(cents) = paid {
            // Only whoever flips it from open to paid enters the credit.
            let claimed = self
                .db
                .prepare(
                    "UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open'
                     RETURNING id",
                )
                .bind(&[a.session.as_str().into()])?
                .first::<Touched>(None)
                .await?;
            if claimed.is_some() {
                self.enter(
                    &checkout.workspace,
                    EntryKind::TopUp,
                    i64::from(cents) * MICROS_PER_DOLLAR / 100,
                    "Paid in advance",
                    &session.id,
                    None,
                    None,
                    Some(&checkout.created_by),
                    session.customer.as_deref(),
                )
                .await?;
            }
        }
        Ok(Outcome::Ok(self.standing(&workspace).await?))
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

    /// A refusal if the workspace has no credit to start an agent with.
    async fn out_of_credit<T>(&self, workspace: &str) -> Result<Option<Outcome<T>>> {
        // Billing is postpaid: usage limits decide whether work starts
        // (see `limits`), and credit is a prepayment that lowers what is
        // owed. A balance no longer has to be positive to start.
        if self.free || !self.prepaid_only {
            return Ok(None);
        }
        let balance = self
            .row(workspace)
            .await?
            .map_or(0, |row| row.balance_micros);
        Ok((balance <= 0).then(|| {
            Outcome::fail(
                FailureCode::PaymentRequired,
                format!(
                    "The {workspace} workspace has no agent credit. An owner can add some under Billing on the workspace's page."
                ),
            )
        }))
    }

    async fn can_start(&self, a: CanStartArgs) -> Result<Outcome<bool>> {
        if self.stripe.is_none() {
            return Ok(Outcome::Ok(true));
        }
        if let Some(stopped) = self.stopped(&a.workspace).await? {
            return Ok(stopped);
        }
        Ok(self
            .out_of_credit(&a.workspace.to_lowercase())
            .await?
            .unwrap_or(Outcome::Ok(true)))
    }

    async fn start_run(&self, a: StartRunArgs) -> Result<Outcome<Option<RunTicket>>> {
        if self.stripe.is_none() {
            return Ok(Outcome::Ok(None));
        }
        let workspace = a.workspace.to_lowercase();
        if let Some(stopped) = self.stopped(&workspace).await? {
            return Ok(stopped);
        }
        if let Some(refused) = self.out_of_credit(&workspace).await? {
            return Ok(refused);
        }
        let now = now_ms();
        let run_id = new_id("run", now);
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("no source of randomness");
        let token = hex::encode(bytes);
        self.db
            .prepare(
                "INSERT INTO runs (id, workspace, repo, number, task, model, token_hash, created_at, billed_to, session_id, tier)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                run_id.as_str().into(),
                workspace.into(),
                format!("{}/{}", a.repo.namespace, a.repo.name).into(),
                a.number.into(),
                a.task.into(),
                a.model.into(),
                hash(&token).into(),
                rfc3339(now).into(),
                if a.billed_to == "workspace" { "workspace" } else { "g1t" }.into(),
                optional(a.session.as_deref().filter(|_| a.billed_to != "workspace")),
                optional(
                    a.tier
                        .as_deref()
                        .filter(|tier| a.billed_to != "workspace" && matches!(*tier, "small" | "large")),
                ),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(Some(RunTicket { run_id, token })))
    }

    async fn finish_run(&self, a: FinishRunArgs) -> Result<Outcome<bool>> {
        let run = self
            .db
            .prepare(
                "SELECT workspace, repo, number, task, model, token_hash, billed_to FROM runs
                 WHERE id = ? AND finished_at IS NULL",
            )
            .bind(&[a.run_id.as_str().into()])?
            .first::<RunRow>(None)
            .await?;
        let Some(run) = run.filter(|run| run.token_hash == hash(&a.token)) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Run not found."));
        };
        if !a.cost_usd.is_finite() || a.cost_usd < 0.0 {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not a cost."));
        }
        // Only whoever closes the run charges for it.
        let claimed = self
            .db
            .prepare(
                "UPDATE runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL RETURNING id",
            )
            .bind(&[rfc3339(now_ms()).into(), a.run_id.as_str().into()])?
            .first::<Touched>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::Ok(false));
        }
        // On the workspace's own provider, the model was paid for there,
        // and the run's sandbox time is recorded on its own: nothing more
        // to charge.
        if run.own_provider() {
            return Ok(Outcome::Ok(true));
        }
        // Its cost plus the margin, on the account's terms; then the plan's
        // included usage and the trial credit pay what they can, and g1t
        // covers a free workspace's overrun (see `credits`). Agents are
        // never the open-source pool's.
        let base = charge_micros(a.cost_usd, self.margin_percent);
        let (charge, terms_note) = self.charged(&run.workspace, base).await?;
        let month = credits::month_of(&rfc3339(now_ms()));
        let eligible = credits::eligible_for(Some(ComputeKind::Agent), None);
        let drawn = self.draw(&run.workspace, charge, &month, &eligible).await?;
        let mut description = match run.task.as_str() {
            "plan" => format!("Planning for {}", run.repo),
            "review" => format!("Review of {}#{}", run.repo, run.number),
            "update" => format!("Catching up {}#{}", run.repo, run.number),
            _ => format!("Work on {}#{}", run.repo, run.number),
        };
        description.push_str(&terms_note);
        description.push_str(&drawn.note());
        self.enter(
            &run.workspace,
            EntryKind::Usage,
            -(charge - drawn.total()),
            &description,
            &a.run_id,
            Some(&run),
            Some(charge_micros(a.cost_usd, 0)),
            None,
            None,
        )
        .await?;
        self.record_drawn(&a.run_id, &drawn).await?;
        self.count_spend(&run.workspace, charge_micros(a.cost_usd, 0), charge - drawn.total(), &drawn).await;
        Ok(Outcome::Ok(true))
    }
}

impl Billing {
    /// Records how long a sandbox ran, with its cost and its charge: every
    /// second, from the first, at the price book's price; on its own CPU
    /// when it reports it. Settles its reservation, if it names one.
    async fn record_sandbox(&self, a: RecordSandboxArgs) -> Result<Outcome<bool>> {
        // Self-hosted time is recorded wherever g1t runs, for its minutes;
        // anything else only where there is a bill to put it on.
        if (self.stripe.is_none() && !a.self_hosted) || a.seconds == 0 {
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
                        cost_micros, reference, created_at, billed_to, credit_micros, trial_micros, oss_micros, given_micros)
                     VALUES (?, ?, 'usage', 0, ?, ?, 'self_hosted', 0, ?, ?, 'workspace', 0, 0, 0, 0)",
                )
                .bind(&[
                    new_id("led", now).into(),
                    workspace.as_str().into(),
                    description.as_str().into(),
                    optional(a.repo.as_deref()),
                    a.reference.as_str().into(),
                    timestamp.as_str().into(),
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
        // A larger machine (`runs-on: g1t-4core`): its memory and disk
        // cost more each second, and without its own CPU it is priced at
        // its vCPUs as busy as the standard machine's.
        let instance = a.instance.as_deref().and_then(g1t_contracts::actions::instance_named);
        let base_scale = instance.map_or(1.0, |i| keeper::base_scale(i.memory_gib, i.disk_gb));
        let price_scale = instance.map_or(1.0, |i| i.price_scale);
        let vcpus = instance.map_or(4.0, |i| i.vcpu.max(4.0));
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
        let cost = parts.map_or(seconds as f64 * cost_per_second * price_scale, |(cost, _)| cost).ceil() as i64;
        let (charge, terms_note) = self.charged(&workspace, credits::with_margin(cost, self.margin_percent)).await?;
        let eligible = credits::eligible_for(a.kind, a.repo.as_deref());
        let drawn = self.draw(&workspace, charge, &credits::month_of(&timestamp), &eligible).await?;
        let charge = charge - drawn.total();
        let cpu_note = parts.map_or(String::new(), |(_, cpu)| format!(", {cpu:.0} vCPU-seconds"));
        let description = format!("{}: {} of sandbox time{cpu_note}{terms_note}{}", a.description, duration(seconds), drawn.note());
        // The price versions it was charged at (pricing.rs).
        let meters: &[&str] = if parts.is_some() { &["sandbox_base_second", "sandbox_cpu_second"] } else { &["sandbox_second"] };
        let mut versions = Vec::new();
        for meter in meters {
            versions.extend(self.version_now(meter).await?);
        }
        let price_version = versions.join(",");
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO ledger
                           (id, workspace, kind, amount_micros, description, repo, task,
                            cost_micros, reference, created_at, billed_to, credit_micros, trial_micros, oss_micros, given_micros, price_version)
                         VALUES (?, ?, 'usage', ?, ?, ?, 'sandbox', ?, ?, ?, 'g1t', ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        new_id("led", now).into(),
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
                    ])?,
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, created_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET balance_micros = balance_micros + ?2",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        (-(charge as f64)).into(),
                        timestamp.as_str().into(),
                    ])?,
            ])
            .await?;
        self.count_spend(&workspace, cost, charge, &drawn).await;
        if let Some(reservation) = &a.reservation_id {
            self.settle_reservation(SettleArgs { reservation_id: reservation.clone(), actual_micros: cost }).await?;
        }
        Ok(Outcome::Ok(true))
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
    pub(crate) async fn charged(&self, workspace: &str, base: i64) -> Result<(i64, String)> {
        if self.free {
            return Ok((0, " (free while g1t is being built out)".to_owned()));
        }
        let terms = self.terms_of(workspace).await?;
        let charge = terms.apply(base);
        let note = match terms.kind {
            TermsKind::Comped => " (comped)".to_owned(),
            TermsKind::Custom if terms.discount_percent > 0 && base > 0 => format!(" ({}% off)", terms.discount_percent),
            _ => String::new(),
        };
        Ok((charge, note))
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
            Ok(Billing {
            db: env.d1("DB")?,
            stripe: env
                .secret("STRIPE_SECRET_KEY")
                .ok()
                .map(|key| key.to_string())
                .filter(|key| !key.is_empty())
                .map(Stripe::new),
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
            prepaid_only: env.var("PREPAID_ONLY").is_ok_and(|v| v.to_string() == "true"),
            trials_on: {
                let plans = credits::Config::from_env(env);
                plans.trial_workspace_micros > 0 && plans.trial_monthly_pool_micros > 0
            },
            plans: credits::Config::from_env(env),
            repos: env.service("REPOS").ok(),
            identity: env.service("IDENTITY").ok(),
            caps: budget::Caps::from_env(env),
            env: env.clone(),
        })
    }
}

#[event(scheduled)]
async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let Ok(billing) = Billing::from_env(&env) else {
        return;
    };
    let keeper = keeper::Keeper::from_env(&env);
    if let Err(error) = billing.settle_runs(&keeper).await {
        worker::console_error!("settling runs failed: {error}");
    }
    // Stripe events billing never received, handled now.
    match billing.replay_events().await {
        Ok(done) => worker::console_log!("stripe replay: {done}"),
        Err(error) => worker::console_error!("replaying Stripe events failed: {error}"),
    }
    if let Err(error) = billing.autopay().await {
        worker::console_error!("paying at the limit failed: {error}");
    }
    // Last month's metered usage (scans, embeddings, storage) goes on the
    // ledger before the month is closed and invoiced.
    if let Err(error) = billing.charge_pending().await {
        worker::console_error!("charging last month's metered usage failed: {error}");
    }
    if let Err(error) = billing.close_months().await {
        worker::console_error!("closing the month failed: {error}");
    }
    if let Err(error) = billing.invoice_enterprises().await {
        worker::console_error!("invoicing enterprises failed: {error}");
    }
    // Comped budgets' alerts, and a tripped breaker staff were not told of.
    if let Err(error) = billing.watch_spend().await {
        worker::console_error!("watching g1t's own spend failed: {error}");
    }
    if let Ok(identity) = env.service("IDENTITY")
        && let Err(error) = billing.warn_limits(&identity).await {
            worker::console_error!("warning owners failed: {error}");
        }
    // Once a day: Stripe's endpoint kept listening to billing's events and
    // enabled, and saved cards and plans not read in a while read again.
    if event.cron() == keeper::DAILY {
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
    if (event.cron() == keeper::DAILY || billing.never_checked().await.unwrap_or(false))
        && let Err(error) = billing.reconcile(&keeper).await {
            worker::console_error!("checking costs against Cloudflare failed: {error}");
        }
    // Once a day: what Cloudflare charged, reconciled against what g1t
    // counted and charged; prices whose day has come; margin alerts
    // (margin.rs). After the keeper, so its proposals are in.
    if event.cron() == keeper::DAILY {
        match billing.costs_daily(&env, &keeper).await {
            Ok(run) => worker::console_log!("costs: {} lines, {} days, {} proposals, {} alerts", run.lines, run.days, run.proposals, run.alerts),
            Err(error) => worker::console_error!("reconciling costs failed: {error}"),
        }
    }
    // Once a day: what each workspace's private repositories hold, its git
    // operations, Deployments plans from before the g1t plan set to end,
    // and old reservations cleared.
    if event.cron() == keeper::DAILY {
        if let Err(error) = billing.measure_storage().await {
            worker::console_error!("measuring storage failed: {error}");
        }
        if let Err(error) = billing.measure_git().await {
            worker::console_error!("measuring git operations failed: {error}");
        }
        if let Err(error) = billing.retire_deployments_plans().await {
            worker::console_error!("ending Deployments plans failed: {error}");
        }
        if let Err(error) = billing.sweep_reservations().await {
            worker::console_error!("clearing reservations failed: {error}");
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
        "usage" => reply(&billing.usage(args(body)?).await?),
        "checkout" => reply(&billing.checkout(args(body)?).await?),
        "confirm" => reply(&billing.confirm(args(body)?).await?),
        "can_start" => reply(&billing.can_start(args(body)?).await?),
        "trial" => reply(&billing.trial(args(body)?).await?),
        "start_run" => reply(&billing.start_run(args(body)?).await?),
        "finish_run" => reply(&billing.finish_run(args(body)?).await?),
        "features" => reply(&billing.features(args(body)?).await?),
        "subscribe" => reply(&billing.subscribe(args(body)?).await?),
        "confirm_subscription" => reply(&billing.confirm_subscription(args(body)?).await?),
        "cancel_subscription" => reply(&billing.cancel_subscription(args(body)?).await?),
        "close_workspace" => reply(&billing.close_workspace(args(body)?).await?),
        "has_feature" => reply(&billing.has_feature(args(body)?).await?),
        "charge_feature" => reply(&billing.charge_feature(args(body)?).await?),
        "record_sandbox" => reply(&billing.record_sandbox(args(body)?).await?),
        "limit" => reply(&billing.limit(args(body)?).await?),
        "check_limit" => reply(&billing.check_limit(args(body)?).await?),
        "set_spend_limit" => reply(&billing.set_spend_limit(args(body)?).await?),
        "prices" => reply(&billing.prices().await?),
        "billing_portal" => reply(&billing.billing_portal(args(body)?).await?),
        "admin_billing_link" => reply(&billing.admin_billing_link(args(body)?).await?),
        "admin_stripe" => reply(&billing.admin_stripe(args(body)?).await?),
        "admin_enterprise_billing" => reply(&billing.admin_enterprise_billing(args(body)?).await?),
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
        "note_pending" => reply(&billing.note_pending(args(body)?).await?),
        "admin_accounts" => reply(&billing.admin_accounts(args(body)?).await?),
        "admin_account" => reply(&billing.admin_account(args(body)?).await?),
        "admin_set_terms" => reply(&billing.admin_set_terms(args(body)?).await?),
        "admin_create_enterprise" => reply(&billing.admin_create_enterprise(args(body)?).await?),
        "admin_attach" => reply(&billing.admin_attach(args(body)?).await?),
        "admin_credit" => reply(&billing.admin_credit(args(body)?).await?),
        "admin_set_allowances" => reply(&billing.admin_set_allowances(args(body)?).await?),
        "entitlements" => reply(&billing.entitlements(args(body)?).await?),
        "audit_retention" => reply(&billing.audit_retention(args(body)?).await?),
        "reserve" => reply(&billing.reserve(args(body)?).await?),
        "settle" => reply(&billing.settle_reservation(args(body)?).await?),
        "card_check" => reply(&billing.card_check(args(body)?).await?),
        "confirm_card_check" => reply(&billing.confirm_card_check(args(body)?).await?),
        "request_limit" => reply(&billing.request_limit(args(body)?).await?),
        "limit_requests" => reply(&billing.limit_requests(args(body)?).await?),
        "confirm_spike" => reply(&billing.confirm_spike(args(body)?).await?),
        "set_caps" => reply(&billing.set_caps(args(body)?).await?),
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
    fn a_run_is_charged_its_cost_plus_the_margin() {
        // $0.05 at 20% is six cents.
        assert_eq!(charge_micros(0.05, 20), 60_000);
        assert_eq!(charge_micros(1.0, 20), 1_200_000);
        assert_eq!(charge_micros(0.05, 0), 50_000);
    }

    #[test]
    fn fractions_of_a_millionth_round_up_and_nothing_costs_less_than_nothing() {
        assert_eq!(charge_micros(0.000_000_4, 20), 2);
        assert_eq!(charge_micros(0.0, 20), 0);
        assert_eq!(charge_micros(-3.0, 20), 0);
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

    #[test]
    fn an_absurd_cost_is_capped() {
        assert_eq!(charge_micros(1e9, 20), 120 * MICROS_PER_DOLLAR);
    }
}
