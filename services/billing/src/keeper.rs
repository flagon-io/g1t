//! Keeps every price current with what g1t actually pays.
//!
//! g1t passes its own costs through, so a price is only right while the
//! cost under it is. Two jobs keep them right, on the billing service's
//! cron:
//!
//! - **Settling runs** (every 15 minutes). A model run is charged when it
//!   finishes at what the sandbox reported. Each of g1t's hosted runs goes
//!   through its AI Gateway, which prices every request at the provider's
//!   current rates and logs it with the run's session. Settling sums those
//!   logs and corrects the charge to the gateway's figure, with a
//!   correction on the statement. A run whose sandbox died before
//!   reporting is charged here instead of never.
//! - **Checking costs** (daily). What Cloudflare billed g1t's account, from
//!   its usage API, is measured against how much was used: Containers
//!   against the seconds containers ran, Workers for Platforms per request
//!   and per CPU millisecond. When a measured cost moves, the price book
//!   moves with it, since each price is its cost plus a set markup, and
//!   the change is recorded where anyone can see it. A measurement far off
//!   the current cost is not adopted, only logged, so one odd day of data
//!   cannot reprice everything.

use g1t_contracts::billing::{EntryKind, MICROS_PER_DOLLAR, Price, PriceBook, PriceChange};
use g1t_contracts::new_id;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Result};

use crate::{Billing, RunRow, charge_micros};

/// The cron that also checks costs against Cloudflare's bill.
pub(crate) const DAILY: &str = "17 4 * * *";

/// A run is settled once its logs have had time to land.
const SETTLE_AFTER_MS: u64 = 5 * 60 * 1000;
/// A run with no gateway logs after this is left as reported.
const GIVE_UP_AFTER_MS: u64 = 3 * 60 * 60 * 1000;
/// A run never finished after this died without reporting.
const ABANDONED_AFTER_MS: u64 = 3 * 60 * 60 * 1000;
/// Smaller moves are noise.
const MIN_CHANGE: f64 = 0.02;
/// A measurement outside this factor of the current cost is suspect.
const MAX_FACTOR: f64 = 4.0;

/// Where the keeper reads what g1t pays.
pub(crate) struct Keeper {
    /// `CLOUDFLARE_USAGE_TOKEN`: Billing, Account Analytics and AI Gateway,
    /// read only.
    token: Option<String>,
    account: String,
    gateway: String,
}

impl Keeper {
    pub(crate) fn from_env(env: &Env) -> Self {
        let var = |name: &str| env.var(name).map(|v| v.to_string()).unwrap_or_default();
        Keeper {
            token: env.secret("CLOUDFLARE_USAGE_TOKEN").ok().map(|v| v.to_string()).filter(|v| !v.is_empty()),
            account: var("CLOUDFLARE_ACCOUNT_ID"),
            gateway: var("AI_GATEWAY_ID"),
        }
    }

    async fn send(&self, method: Method, url: &str, body: Option<Value>) -> Result<Value> {
        let Some(token) = &self.token else {
            return Err(worker::Error::RustError("no CLOUDFLARE_USAGE_TOKEN".into()));
        };
        let headers = Headers::new();
        headers.set("authorization", &format!("Bearer {token}"))?;
        headers.set("content-type", "application/json")?;
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(body) = body {
            init.with_body(Some(body.to_string().into()));
        }
        let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
        let status = response.status_code();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status != 200 {
            return Err(worker::Error::RustError(format!("Cloudflare answered {status}: {value}")));
        }
        Ok(value)
    }

    fn api(&self, path: &str) -> String {
        format!("https://api.cloudflare.com/client/v4/accounts/{}{path}", self.account)
    }

    /// What AI Gateway priced a session's requests at, in dollars, and how
    /// many there were.
    async fn session_cost(&self, session: &str) -> Result<(f64, u32)> {
        let mut cost = 0.0;
        let mut count = 0;
        for page in 1..=40 {
            // The filter goes as URL-encoded JSON; the bracket form is
            // ignored, and would sum every log there is. Session ids are
            // [a-z0-9_], which need no escaping inside it.
            let filter = format!(
                "%5B%7B%22key%22%3A%22metadata.value%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%5B%22{session}%22%5D%7D%5D"
            );
            let url = self.api(&format!(
                "/ai-gateway/gateways/{}/logs?per_page=50&page={page}&filters={filter}",
                self.gateway
            ));
            let body = self.send(Method::Get, &url, None).await?;
            let logs = body["result"].as_array().cloned().unwrap_or_default();
            for log in &logs {
                cost += log["cost"].as_f64().unwrap_or(0.0);
                count += 1;
            }
            if logs.len() < 50 {
                break;
            }
        }
        Ok((cost, count))
    }

    /// The account's billable usage, one row per service per day, as
    /// Cloudflare reports it.
    async fn billable_usage(&self, from: &str, to: &str) -> Result<Vec<UsageRow>> {
        let body = self
            .send(Method::Get, &self.api(&format!("/billable-usage?from={from}&to={to}")), None)
            .await?;
        let rows = body["result"].as_array().cloned().unwrap_or_default();
        Ok(rows.iter().filter_map(UsageRow::from_value).collect())
    }

    /// What g1t's containers used from `since` to `until` (dates), as
    /// Cloudflare bills it: memory in byte-seconds, and CPU seconds.
    async fn container_usage(&self, since: &str, until: &str) -> Result<ContainerUsage> {
        let query = "query ($account: String!, $since: Date!, $until: Date!) {
          viewer { accounts(filter: { accountTag: $account }) {
            containersUsageAdaptiveGroups(limit: 1000, filter: { date_geq: $since, date_leq: $until }) {
              sum { cpuTimeSec allocatedMemory }
            }
          } }
        }";
        let body = self
            .send(
                Method::Post,
                "https://api.cloudflare.com/client/v4/graphql",
                Some(json!({ "query": query, "variables": { "account": self.account, "since": since, "until": until } })),
            )
            .await?;
        let groups = body["data"]["viewer"]["accounts"][0]["containersUsageAdaptiveGroups"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        Ok(groups.iter().fold(ContainerUsage::default(), |total, g| ContainerUsage {
            cpu_seconds: total.cpu_seconds + g["sum"]["cpuTimeSec"].as_f64().unwrap_or(0.0),
            memory_byte_seconds: total.memory_byte_seconds + g["sum"]["allocatedMemory"].as_f64().unwrap_or(0.0),
        }))
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct ContainerUsage {
    cpu_seconds: f64,
    memory_byte_seconds: f64,
}

/// g1t's sandboxes: Containers' standard-1, half a vCPU, 4 GiB, 8 GB disk.
const SANDBOX_GIB: f64 = 4.0;
const SANDBOX_DISK_GB: f64 = 8.0;
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
/// The Durable Object behind each container is billed for as long as the
/// container runs, at 128 MB.
const SANDBOX_DO_GB: f64 = 0.125;

/// Cloudflare's published Containers rates, in dollars, used for any rate
/// the bill does not show yet (while usage is inside the included amount).
const LIST_MEMORY_GIB_SECOND: f64 = 0.000_002_5;
const LIST_DISK_GB_SECOND: f64 = 0.000_000_07;
const LIST_VCPU_SECOND: f64 = 0.000_02;
/// Durable Objects duration: $12.50 per million GB-seconds.
const LIST_DO_GB_SECOND: f64 = 0.000_012_5;

/// What one second of a sandbox costs whatever it does, in millionths of a
/// dollar: its memory and disk, and the Durable Object behind it, for the
/// whole second. CPU is billed only while busy, on top.
pub(crate) fn sandbox_base_micros(memory: f64, disk: f64, durable_object: f64) -> f64 {
    (SANDBOX_GIB * memory + SANDBOX_DISK_GB * disk + SANDBOX_DO_GB * durable_object) * MICROS_PER_DOLLAR as f64
}

/// What one second of a sandbox costs on average, in millionths of a
/// dollar: its base, and the CPU sandboxes actually use per second of
/// running. Runs that report their own CPU are priced on it instead (see
/// `run_cost`).
pub(crate) fn sandbox_second_micros(usage: ContainerUsage, memory: f64, disk: f64, vcpu: f64, durable_object: f64) -> Option<f64> {
    let instance_seconds = usage.memory_byte_seconds / (SANDBOX_GIB * GIB);
    if instance_seconds < 3600.0 {
        return None;
    }
    let cpu_share = usage.cpu_seconds / instance_seconds;
    Some(sandbox_base_micros(memory, disk, durable_object) + cpu_share * vcpu * MICROS_PER_DOLLAR as f64)
}

/// How much more a second of a larger machine's memory and disk (and the
/// Durable Object behind it) costs than the standard sandbox's, at
/// Cloudflare's list rates: 1 for the standard machine.
pub(crate) fn base_scale(memory_gib: f64, disk_gb: f64) -> f64 {
    let base = |memory: f64, disk: f64| memory * LIST_MEMORY_GIB_SECOND + disk * LIST_DISK_GB_SECOND + SANDBOX_DO_GB * LIST_DO_GB_SECOND;
    base(memory_gib, disk_gb) / base(SANDBOX_GIB, SANDBOX_DISK_GB)
}

/// What a run that reported its own CPU cost g1t: its base for every
/// second, and its vCPU-seconds at the vCPU rate.
pub(crate) fn run_cost(seconds: i64, cpu_seconds: f64, base_per_second: f64, per_vcpu_second: f64) -> f64 {
    seconds.max(0) as f64 * base_per_second + cpu_seconds.max(0.0) * per_vcpu_second
}

/// A unit's marginal rate from the bill: the median, over the days that
/// were charged, of cost over quantity. None while nothing was charged.
pub(crate) fn billed_rate(rows: &[&UsageRow]) -> Option<f64> {
    let mut rates: Vec<f64> = rows
        .iter()
        .filter(|r| r.cost > 0.0 && r.quantity > 0.0)
        .map(|r| r.cost / r.quantity)
        .collect();
    if rates.is_empty() {
        return None;
    }
    rates.sort_by(f64::total_cmp);
    Some(rates[rates.len() / 2])
}

/// One line of Cloudflare's billable usage.
#[derive(Debug, Clone)]
pub(crate) struct UsageRow {
    period_start: String,
    period_end: String,
    service: String,
    unit: String,
    quantity: f64,
    cost: f64,
}

impl UsageRow {
    /// Read leniently: the API is new, and its field names are FOCUS's.
    fn from_value(row: &Value) -> Option<Self> {
        let text = |keys: &[&str]| keys.iter().find_map(|k| row[*k].as_str()).unwrap_or_default().to_owned();
        let number = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| row[*k].as_f64().or_else(|| row[*k].as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0.0)
        };
        let service = text(&["ServiceName", "service_name", "service"]);
        if service.is_empty() {
            return None;
        }
        let family = text(&["ServiceFamilyName", "service_family_name"]);
        Some(UsageRow {
            period_start: text(&["ChargePeriodStart", "charge_period_start"]),
            period_end: text(&["ChargePeriodEnd", "charge_period_end"]),
            service: if family.is_empty() { service } else { format!("{family} / {service}") },
            unit: text(&["PricingUnit", "ConsumedUnit", "consumed_unit"]),
            quantity: number(&["PricingQuantity", "ConsumedQuantity", "pricing_quantity"]),
            // What g1t pays; list price if nothing was contracted.
            cost: Some(number(&["ContractedCost", "BilledCost", "contracted_cost"]))
                .filter(|cost| *cost > 0.0)
                .unwrap_or_else(|| number(&["ListCost", "list_cost"])),
        })
    }
}

/// What a cost should become from a measurement, or why not.
pub(crate) fn adopt(current: f64, measured: f64) -> std::result::Result<Option<f64>, String> {
    if !measured.is_finite() || measured <= 0.0 {
        return Err("nothing to measure".into());
    }
    let ratio = measured / current;
    if !(1.0 / MAX_FACTOR..=MAX_FACTOR).contains(&ratio) {
        return Err(format!("measured {measured:.4} against {current:.4}, too far off to adopt"));
    }
    Ok(((ratio - 1.0).abs() >= MIN_CHANGE).then_some(measured))
}

#[derive(Deserialize)]
struct PriceRow {
    meter: String,
    title: String,
    unit: String,
    cost_micros: f64,
    markup_percent: u32,
    source: String,
    checked_at: Option<String>,
    updated_at: String,
}

#[derive(Deserialize)]
struct ChangeRow {
    meter: String,
    old_cost_micros: f64,
    new_cost_micros: f64,
    markup_percent: u32,
    old_markup_percent: Option<u32>,
    reason: String,
    created_at: String,
}

#[derive(Deserialize)]
struct Unsettled {
    id: String,
    workspace: String,
    repo: String,
    number: u32,
    task: String,
    model: String,
    token_hash: String,
    billed_to: Option<String>,
    session_id: String,
    created_at: String,
    finished_at: Option<String>,
}

#[derive(Deserialize)]
struct Charged {
    cost_micros: Option<i64>,
    description: String,
    amount_micros: i64,
}

/// What a settled run's correction comes to, from the charges at the
/// reported and the gateway's cost and what the workspace was charged at
/// first. A charge up is drawn down like any charge; a charge down is
/// given back only up to what the workspace paid, since what a credit or
/// a pool paid was never the workspace's money.
pub(crate) fn correction(reported_charge: i64, gateway_charge: i64, first_charged: i64) -> i64 {
    let delta = gateway_charge - reported_charge;
    if delta >= 0 { delta } else { delta.max(-first_charged.max(0)) }
}

fn ms(timestamp: &str) -> u64 {
    // RFC 3339 in UTC, as g1t writes them.
    worker::js_sys::Date::parse(timestamp) as u64
}

impl Billing {
    pub(crate) async fn prices(&self) -> Result<PriceBook> {
        let prices = self
            .db
            .prepare("SELECT * FROM prices ORDER BY rowid")
            .all()
            .await?
            .results::<PriceRow>()?;
        let changes = self
            .db
            .prepare("SELECT * FROM price_changes ORDER BY created_at DESC LIMIT 20")
            .all()
            .await?
            .results::<ChangeRow>()?;
        Ok(PriceBook {
            prices: prices
                .into_iter()
                .map(|row| Price {
                    price_micros: Price::price_for(row.cost_micros, row.markup_percent),
                    meter: row.meter,
                    title: row.title,
                    unit: row.unit,
                    cost_micros: row.cost_micros,
                    markup_percent: row.markup_percent,
                    source: row.source,
                    checked_at: row.checked_at,
                    updated_at: row.updated_at,
                })
                .collect(),
            changes: changes
                .into_iter()
                .map(|row| PriceChange {
                    meter: row.meter,
                    old_cost_micros: row.old_cost_micros,
                    new_cost_micros: row.new_cost_micros,
                    markup_percent: row.markup_percent,
                    old_markup_percent: row.old_markup_percent,
                    reason: row.reason,
                    created_at: row.created_at,
                })
                .collect(),
            model_margin_percent: self.margin_percent,
            plans: g1t_contracts::billing::Feature::ALL.iter().map(|feature| self.plan(*feature)).collect(),
            free: Some(g1t_contracts::billing::FreeTier {
                trial_workspace_micros: if self.trials_on { self.plans.trial_workspace_micros } else { 0 },
                trial_monthly_pool_micros: if self.trials_on { self.plans.trial_monthly_pool_micros } else { 0 },
                oss_pool_micros: self.plans.oss_pool_micros,
                oss_repo_micros: self.plans.oss_repo_micros,
                free_private_storage_bytes: self.plans.free_storage_bytes,
                audit_retention_days: self.plans.audit_days,
                min_charge_micros: self.plans.min_charge_micros,
                git_operations_included: self.plans.git_included,
                paid_start_ceiling_micros: self.plans.paid_start_micros,
                overage_forgive_cost_micros: self.plans.forgive_cost_micros,
            }),
        })
    }

    /// Whether the costs have never been checked against Cloudflare's bill.
    pub(crate) async fn never_checked(&self) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT meter FROM prices WHERE checked_at IS NOT NULL LIMIT 1")
            .first::<Value>(None)
            .await?
            .is_none())
    }

    /// A meter's cost and price per unit, from the book.
    pub(crate) async fn price(&self, meter: &str) -> Result<Option<(f64, f64)>> {
        #[derive(Deserialize)]
        struct Row {
            cost_micros: f64,
            markup_percent: u32,
        }
        Ok(self
            .db
            .prepare("SELECT cost_micros, markup_percent FROM prices WHERE meter = ?")
            .bind(&[meter.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| (row.cost_micros, Price::price_for(row.cost_micros, row.markup_percent))))
    }

    /// Corrects finished runs to what AI Gateway priced them at, and
    /// charges runs whose sandbox died before reporting.
    pub(crate) async fn settle_runs(&self, keeper: &Keeper) -> Result<()> {
        if keeper.token.is_none() || keeper.gateway.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        let runs = self
            .db
            .prepare(
                "SELECT id, workspace, repo, number, task, model, token_hash, billed_to, session_id, created_at, finished_at
                 FROM runs
                 WHERE session_id IS NOT NULL AND settled_at IS NULL
                   AND ((finished_at IS NOT NULL AND finished_at < ?1) OR created_at < ?2)
                 ORDER BY created_at LIMIT 10",
            )
            .bind(&[rfc3339(now - SETTLE_AFTER_MS).into(), rfc3339(now - ABANDONED_AFTER_MS).into()])?
            .all()
            .await?
            .results::<Unsettled>()?;
        for run in runs {
            let (cost_usd, requests) = match keeper.session_cost(&run.session_id).await {
                Ok(found) => found,
                Err(error) => {
                    worker::console_error!("could not read gateway logs for {}: {error}", run.id);
                    continue;
                }
            };
            let since = ms(run.finished_at.as_deref().unwrap_or(&run.created_at));
            if requests == 0 && now.saturating_sub(since) < GIVE_UP_AFTER_MS {
                continue;
            }
            self.settle(&run, cost_usd, requests).await?;
        }
        Ok(())
    }

    async fn settle(&self, run: &Unsettled, cost_usd: f64, requests: u32) -> Result<()> {
        let row = RunRow {
            workspace: run.workspace.clone(),
            repo: run.repo.clone(),
            number: run.number,
            task: run.task.clone(),
            model: run.model.clone(),
            token_hash: run.token_hash.clone(),
            billed_to: run.billed_to.clone(),
        };
        let gateway_micros = charge_micros(cost_usd, 0);
        let charged = self
            .db
            .prepare("SELECT cost_micros, description, amount_micros FROM ledger WHERE reference = ?")
            .bind(&[run.id.as_str().into()])?
            .first::<Charged>(None)
            .await?;
        let terms = self.terms_of(&run.workspace).await?;
        let charge_for = |micros: i64| {
            if self.free {
                0
            } else {
                terms.apply(charge_micros(micros as f64 / MICROS_PER_DOLLAR as f64, self.margin_percent))
            }
        };
        let settled_at = rfc3339(now_ms());
        // Claim it, so two crons never settle it twice.
        let claimed = self
            .db
            .prepare("UPDATE runs SET settled_at = ?, gateway_cost_micros = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND settled_at IS NULL RETURNING id")
            .bind(&[
                settled_at.as_str().into(),
                (gateway_micros as f64).into(),
                settled_at.as_str().into(),
                run.id.as_str().into(),
            ])?
            .first::<Value>(None)
            .await?;
        if claimed.is_none() || requests == 0 {
            return Ok(());
        }
        let free_note = if self.free { " (free while g1t is being built out)" } else { "" };
        match charged {
            // Never reported: charged now, from the gateway's figure.
            None => {
                let charge = charge_for(gateway_micros);
                let eligible = crate::credits::eligible_for(Some(g1t_contracts::billing::ComputeKind::Agent), None);
                let drawn = self.draw(&run.workspace, charge, &settled_at[..7], &eligible).await?;
                let description = format!(
                    "Work on {}#{}, settled from AI Gateway after the sandbox stopped without reporting{free_note}{}",
                    run.repo,
                    run.number,
                    drawn.note()
                );
                self.enter(&run.workspace, EntryKind::Usage, -(charge - drawn.total()), &description, &run.id, Some(&row), Some(gateway_micros), None, None)
                    .await?;
                self.record_drawn(&run.id, &drawn).await?;
            }
            Some(charged) => {
                let reported = charged.cost_micros.unwrap_or(0);
                let delta = gateway_micros - reported;
                if delta == 0 {
                    return Ok(());
                }
                let change = correction(charge_for(reported), charge_for(gateway_micros), -charged.amount_micros);
                // A charge up is paid for like any other charge.
                let drawn = if change > 0 {
                    let eligible = crate::credits::eligible_for(Some(g1t_contracts::billing::ComputeKind::Agent), None);
                    self.draw(&run.workspace, change, &settled_at[..7], &eligible).await?
                } else {
                    crate::credits::Drawn::default()
                };
                let description = format!(
                    "Correction to “{}”: AI Gateway priced its {requests} model requests at {}, not {}{}",
                    charged.description,
                    crate::features::dollars(gateway_micros),
                    crate::features::dollars(reported),
                    drawn.note(),
                );
                let reference = format!("{}/settled", run.id);
                self.enter(
                    &run.workspace,
                    EntryKind::Usage,
                    -(change - drawn.total()),
                    &description,
                    &reference,
                    Some(&row),
                    Some(delta),
                    None,
                    None,
                )
                .await?;
                self.record_drawn(&reference, &drawn).await?;
            }
        }
        Ok(())
    }

    /// Checks each cost against what Cloudflare billed this month, and
    /// moves the ones that changed.
    pub(crate) async fn reconcile(&self, keeper: &Keeper) -> Result<()> {
        if keeper.token.is_none() {
            return Ok(());
        }
        let now = rfc3339(now_ms());
        let today = &now[..10];
        let since = rfc3339(now_ms() - 30 * 24 * 60 * 60 * 1000);
        let rows = keeper.billable_usage(&since[..10], today).await?;
        for row in &rows {
            self.db
                .prepare(
                    "INSERT INTO cloudflare_usage (period_start, period_end, service, unit, quantity, cost_usd, fetched_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT (period_start, service, unit) DO UPDATE SET
                       period_end = ?2, quantity = ?5, cost_usd = ?6, fetched_at = ?7",
                )
                .bind(&[
                    row.period_start.as_str().into(),
                    row.period_end.as_str().into(),
                    row.service.as_str().into(),
                    row.unit.as_str().into(),
                    row.quantity.into(),
                    row.cost.into(),
                    now.as_str().into(),
                ])?
                .run()
                .await?;
        }

        let named = |words: &[&str]| -> Vec<&UsageRow> {
            rows.iter()
                .filter(|r| {
                    let service = r.service.to_lowercase();
                    words.iter().all(|word| service.contains(word))
                })
                .collect()
        };

        // Containers: each resource at what the bill shows it costs, or
        // the published rate while the included amount still covers it,
        // over how much CPU g1t's sandboxes really use per second.
        let memory = billed_rate(&named(&["container memory"]));
        let disk = billed_rate(&named(&["container disk"]));
        let vcpu = billed_rate(&named(&["container vcpu"]));
        let durable_object = billed_rate(&named(&["durable objects", "duration"]));
        let usage = keeper.container_usage(&since[..10], today).await?;
        let rates = (
            memory.unwrap_or(LIST_MEMORY_GIB_SECOND),
            disk.unwrap_or(LIST_DISK_GB_SECOND),
            vcpu.unwrap_or(LIST_VCPU_SECOND),
            durable_object.unwrap_or(LIST_DO_GB_SECOND),
        );
        // The parts, for runs that report their own CPU.
        let parts_reason = "Cloudflare's Containers and Durable Objects rates, as billed or published";
        self.measure("sandbox_base_second", sandbox_base_micros(rates.0, rates.1, rates.3), parts_reason).await?;
        self.measure("sandbox_cpu_second", rates.2 * MICROS_PER_DOLLAR as f64, parts_reason).await?;
        if let Some(per_second) = sandbox_second_micros(usage, rates.0, rates.1, rates.2, rates.3) {
            let instance_seconds = usage.memory_byte_seconds / (SANDBOX_GIB * GIB);
            let billed = [("memory", memory), ("disk", disk), ("vCPU", vcpu), ("Durable Object duration", durable_object)]
                .iter()
                .filter(|(_, rate)| rate.is_some())
                .map(|(name, _)| *name)
                .collect::<Vec<_>>();
            let reason = format!(
                "Sandboxes used {:.2} vCPU per second over {:.0} hours of Cloudflare Containers in the last 30 days, with the Durable Object behind each; {}",
                usage.cpu_seconds / instance_seconds,
                instance_seconds / 3600.0,
                if billed.is_empty() {
                    "rates are Cloudflare's published ones".to_owned()
                } else {
                    format!("{} at what Cloudflare billed", billed.join(", "))
                },
            );
            for meter in ["sandbox_second", "build_second"] {
                self.measure(meter, per_second, &reason).await?;
            }
        }
        // Apps run as Workers: per million requests and CPU milliseconds,
        // once the bill shows them charged.
        // Security scans' CPU follows the same Workers CPU rate.
        let app_meters: [(&str, &[&str], &str); 3] = [
            ("app_requests", &["workers", "requests"], "requests"),
            ("app_cpu", &["workers cpu"], "CPU ms"),
            ("scan_cpu", &["workers cpu"], "CPU ms"),
        ];
        for (meter, words, unit) in app_meters {
            if let Some(rate) = billed_rate(&named(words)) {
                let reason = format!("Cloudflare billed Workers {unit} at ${:.2} per million", rate * 1e6);
                self.measure(meter, rate * 1e6 * MICROS_PER_DOLLAR as f64, &reason).await?;
            }
        }
        self.db
            .prepare("UPDATE prices SET checked_at = ?")
            .bind(&[now.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Moves a meter's cost to a measurement, if it is sound and different.
    async fn measure(&self, meter: &str, measured: f64, reason: &str) -> Result<()> {
        let Some((current, _)) = self.price(meter).await? else {
            return Ok(());
        };
        match adopt(current, measured) {
            Err(why) => worker::console_log!("{meter}: {why}"),
            Ok(None) => {}
            Ok(Some(cost)) => {
                let now = now_ms();
                self.db
                    .batch(vec![
                        self.db
                            .prepare("UPDATE prices SET cost_micros = ?, source = 'cloudflare', updated_at = ? WHERE meter = ?")
                            .bind(&[cost.into(), rfc3339(now).into(), meter.into()])?,
                        self.db
                            .prepare(
                                "INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, reason, created_at)
                                 SELECT ?, meter, ?, ?, markup_percent, ?, ? FROM prices WHERE meter = ?",
                            )
                            .bind(&[
                                new_id("prc", now).into(),
                                current.into(),
                                cost.into(),
                                reason.into(),
                                rfc3339(now).into(),
                                meter.into(),
                            ])?,
                    ])
                    .await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_correction_never_gives_back_what_the_workspace_did_not_pay() {
        // Up by 2 cents: charged in full (then drawn down like any charge).
        assert_eq!(correction(100_000, 120_000, 100_000), 20_000);
        // Down by 2 cents, all of it paid by the workspace: given back.
        assert_eq!(correction(120_000, 100_000, 120_000), -20_000);
        // Down, but the open-source pool paid all but a cent: a cent back.
        assert_eq!(correction(120_000, 100_000, 10_000), -10_000);
        // Paid entirely by a credit or pool: nothing back.
        assert_eq!(correction(120_000, 100_000, 0), 0);
    }

    #[test]
    fn small_moves_are_noise_and_wild_ones_are_not_believed() {
        assert_eq!(adopt(21.0, 21.2), Ok(None));
        assert_eq!(adopt(21.0, 25.0), Ok(Some(25.0)));
        assert_eq!(adopt(21.0, 15.0), Ok(Some(15.0)));
        assert!(adopt(21.0, 200.0).is_err());
        assert!(adopt(21.0, 0.0).is_err());
    }

    #[test]
    fn a_sandbox_second_is_its_memory_and_disk_and_the_cpu_it_uses() {
        // An hour of sandboxes that kept a fifth of a vCPU busy.
        let usage = ContainerUsage { cpu_seconds: 720.0, memory_byte_seconds: 3600.0 * 4.0 * GIB };
        let micros =
            sandbox_second_micros(usage, LIST_MEMORY_GIB_SECOND, LIST_DISK_GB_SECOND, LIST_VCPU_SECOND, LIST_DO_GB_SECOND).unwrap();
        // 4 x 2.5 + 8 x 0.07 + 0.125 x 12.5 + 0.2 x 20 = 16.1225
        assert!((micros - 16.1225).abs() < 1e-9, "{micros}");
        // The Durable Object adds about 11% to the second it left out.
        assert!((sandbox_base_micros(LIST_MEMORY_GIB_SECOND, LIST_DISK_GB_SECOND, LIST_DO_GB_SECOND) - 12.1225).abs() < 1e-9);
        // Too little use to say anything.
        assert!(sandbox_second_micros(ContainerUsage { cpu_seconds: 1.0, memory_byte_seconds: GIB }, 1.0, 1.0, 1.0, 1.0).is_none());
    }

    #[test]
    fn a_run_that_reports_its_cpu_is_priced_on_it() {
        let base = sandbox_base_micros(LIST_MEMORY_GIB_SECOND, LIST_DISK_GB_SECOND, LIST_DO_GB_SECOND);
        let vcpu = LIST_VCPU_SECOND * MICROS_PER_DOLLAR as f64;
        // A 10-minute cargo build that kept its half vCPU busy throughout.
        let heavy = run_cost(600, 300.0, base, vcpu);
        assert!((heavy - (600.0 * 12.1225 + 300.0 * 20.0)).abs() < 1e-6);
        // The same ten minutes, mostly idle, costs less.
        let light = run_cost(600, 30.0, base, vcpu);
        assert!(light < heavy);
        // The average would have under-priced the heavy one.
        let average = 600.0 * (base + 0.195 * vcpu);
        assert!(average < heavy && average > light);
        assert_eq!(run_cost(0, -1.0, base, vcpu), 0.0);
        // A larger machine's base: its memory and disk, not its CPU.
        assert!((base_scale(SANDBOX_GIB, SANDBOX_DISK_GB) - 1.0).abs() < 1e-12);
        assert!((base_scale(12.0, 20.0) - 2.72).abs() < 0.01, "{}", base_scale(12.0, 20.0));
        assert!((base_scale(8.0, 16.0) - 1.87).abs() < 0.01, "{}", base_scale(8.0, 16.0));
    }

    #[test]
    fn a_billed_rate_is_the_median_of_the_charged_days() {
        let row = |quantity: f64, cost: f64| UsageRow {
            period_start: String::new(),
            period_end: String::new(),
            service: "Containers / Container Memory".into(),
            unit: "Count".into(),
            quantity,
            cost,
        };
        let rows = [row(100.0, 0.0), row(100.0, 0.0002), row(100.0, 0.00025), row(100.0, 0.00025)];
        assert_eq!(billed_rate(&rows.iter().collect::<Vec<_>>()), Some(0.000_002_5));
        assert_eq!(billed_rate(&[&row(5.0, 0.0)]), None);
    }

    #[test]
    fn usage_rows_are_read_by_their_focus_names() {
        let row = UsageRow::from_value(&json!({
            "ServiceFamilyName": "Containers",
            "ServiceName": "Memory",
            "PricingUnit": "GiB-seconds",
            "PricingQuantity": "1200.5",
            "ContractedCost": 0.003,
            "ChargePeriodStart": "2026-10-01",
        }))
        .unwrap();
        assert_eq!(row.service, "Containers / Memory");
        assert_eq!(row.quantity, 1200.5);
        assert_eq!(row.cost, 0.003);
        assert!(UsageRow::from_value(&json!({ "nothing": 1 })).is_none());
    }
}
