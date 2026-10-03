//! The billing service: what agents cost, charged to the workspace they
//! worked for.
//!
//! A workspace buys credit with a card. Before the runner starts an agent
//! it asks here, and is refused if the workspace has none. When the
//! agent's sandbox finishes it reports what the model cost, and that plus
//! g1t's margin comes off the balance. Every change is a ledger entry, and
//! a balance is always the sum of its ledger.
//!
//! Without a card processor configured the service says so and charges
//! nothing, so that g1t still runs where billing has not been set up.
//!
//! Reached only through service bindings; see `g1t_contracts::billing` for
//! the methods and their arguments.

mod stripe;

use g1t_contracts::billing::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Request, Response, Result, event};

use stripe::Stripe;

const MIN_TOP_UP_CENTS: u32 = 500;
const MAX_TOP_UP_CENTS: u32 = 50_000;
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
    margin_percent: u32,
    /// Charged for a run on the workspace's own model provider.
    orchestration_fee_micros: i64,
}

impl Billing {
    fn status(&self) -> Status {
        Status {
            enabled: self.stripe.is_some(),
            live: self.stripe.as_ref().is_some_and(Stripe::live),
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
        Ok(Account {
            workspace: workspace.to_owned(),
            balance_micros: self
                .row(workspace)
                .await?
                .map_or(0, |row| row.balance_micros),
            status: self.status(),
            margin_percent: self.margin_percent,
            orchestration_fee_micros: self.orchestration_fee_micros,
        })
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
        let slices = |key: &str, limit: u32| {
            format!(
                "SELECT {key} AS key, -SUM(amount_micros) AS micros, COUNT(*) AS runs FROM ledger
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
        let totals = self
            .db
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
            runs: totals.runs.unwrap_or_default(),
            added_micros: totals.added.unwrap_or_default(),
            by_day: query(slices("substr(created_at, 1, 10) || '/' || COALESCE(task, 'other')", 400)).await?,
            by_task: query(slices("task", 20)).await?,
            by_repo: query(slices("repo", 20)).await?,
            by_pull: query(slices("repo || '#' || number", 10)).await?,
            by_model: query(slices("model", 10)).await?,
            since: a.since,
        }))
    }

    async fn checkout(&self, a: CheckoutArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can add credit to a workspace.",
            ));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "Payments are not set up on this g1t yet.",
            ));
        };
        if !(MIN_TOP_UP_CENTS..=MAX_TOP_UP_CENTS).contains(&a.amount_cents) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!(
                    "Add between ${} and ${} at a time.",
                    MIN_TOP_UP_CENTS / 100,
                    MAX_TOP_UP_CENTS / 100
                ),
            ));
        }
        let customer = self.row(&workspace).await?.and_then(|row| row.customer_id);
        let session = stripe
            .start_checkout(
                &workspace,
                a.amount_cents,
                customer.as_deref(),
                &a.return_url,
            )
            .await?;
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
                    "Credit added by card",
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

    /// A refusal if the workspace has no credit to start an agent with.
    async fn out_of_credit<T>(&self, workspace: &str) -> Result<Option<Outcome<T>>> {
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
                "INSERT INTO runs (id, workspace, repo, number, task, model, token_hash, created_at, billed_to)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        // On the workspace's own provider, the model was paid for there:
        // g1t charges its fee, and keeps the provider's cost to show.
        let charge = if run.own_provider() {
            self.orchestration_fee_micros
        } else {
            charge_micros(a.cost_usd, self.margin_percent)
        };
        let mut description = match run.task.as_str() {
            "plan" => format!("Planning for {}", run.repo),
            "review" => format!("Review of {}#{}", run.repo, run.number),
            "update" => format!("Catching up {}#{}", run.repo, run.number),
            _ => format!("Work on {}#{}", run.repo, run.number),
        };
        if run.own_provider() {
            description.push_str(", on your own model provider");
        }
        self.enter(
            &run.workspace,
            EntryKind::Usage,
            -charge,
            &description,
            &a.run_id,
            Some(&run),
            Some(charge_micros(a.cost_usd, 0)),
            None,
            None,
        )
        .await?;
        Ok(Outcome::Ok(true))
    }
}

fn members_only<T>() -> Outcome<T> {
    Outcome::fail(
        FailureCode::Forbidden,
        "Only members can see a workspace's billing.",
    )
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: serde_json::Value = request.json().await?;
    let billing = Billing {
        db: env.d1("DB")?,
        stripe: env
            .secret("STRIPE_SECRET_KEY")
            .ok()
            .map(|key| key.to_string())
            .filter(|key| !key.is_empty())
            .map(Stripe::new),
        margin_percent: env
            .var("MARGIN_PERCENT")
            .ok()
            .and_then(|percent| percent.to_string().parse().ok())
            .unwrap_or(20),
        orchestration_fee_micros: env
            .var("ORCHESTRATION_FEE_MICROS")
            .ok()
            .and_then(|fee| fee.to_string().parse().ok())
            .unwrap_or(100_000),
    };
    match method.as_str() {
        "status" => reply(&billing.status()),
        "account" => reply(&billing.account(args(body)?).await?),
        "ledger" => reply(&billing.ledger(args(body)?).await?),
        "usage" => reply(&billing.usage(args(body)?).await?),
        "checkout" => reply(&billing.checkout(args(body)?).await?),
        "confirm" => reply(&billing.confirm(args(body)?).await?),
        "can_start" => reply(&billing.can_start(args(body)?).await?),
        "start_run" => reply(&billing.start_run(args(body)?).await?),
        "finish_run" => reply(&billing.finish_run(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
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
    fn an_absurd_cost_is_capped() {
        assert_eq!(charge_micros(1e9, 20), 120 * MICROS_PER_DOLLAR);
    }
}
