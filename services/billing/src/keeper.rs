//! Keeps every price current with what g1t actually pays.
//!
//! g1t passes its own costs through, so a price is only right while the
//! cost under it is. One job keeps them right, on the billing service's
//! daily cron:
//!
//! - **Checking costs** (daily). What Cloudflare billed g1t's account, from
//!   its usage API, is measured against how much was used: Containers
//!   against the seconds containers ran, Workers for Platforms per request
//!   and per CPU millisecond. When a measured cost moves, the price book
//!   moves with it, since each price is its cost plus a set markup, and
//!   the change is recorded where anyone can see it. A measurement goes
//!   through `pricing` as a proposal: a small move is applied on its own (a
//!   rise only after customers have had notice), a large or suspect one
//!   waits for staff in sudo, so one odd day of data cannot reprice
//!   everything.

use g1t_contracts::billing::{MICROS_PER_DOLLAR, Price, PriceBook, PriceChange};

use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Result};

use crate::Billing;

/// The cron that also checks costs against Cloudflare's bill.
pub(crate) const DAILY: &str = "17 4 * * *";
/// The quarter-hourly tick: settling, and once an hour the platform watch.
pub(crate) const QUARTER_HOURLY: &str = "*/15 * * * *";

/// Where the keeper reads what g1t pays.
pub(crate) struct Keeper {
    /// `CLOUDFLARE_USAGE_TOKEN`: Billing and Account Analytics, read only.
    token: Option<String>,
    /// What reads the bill for `costs`: `CLOUDFLARE_BILLING_TOKEN`
    /// (Account: Billing Read and Account Analytics Read), or the usage
    /// token, which has both.
    billing_token: Option<String>,
    account: String,
}

impl Keeper {
    pub(crate) fn from_env(env: &Env) -> Self {
        let var = |name: &str| env.var(name).map(|v| v.to_string()).unwrap_or_default();
        let secret = |name: &str| env.secret(name).ok().map(|v| v.to_string()).filter(|v| !v.is_empty());
        let token = secret("CLOUDFLARE_USAGE_TOKEN");
        Keeper {
            billing_token: secret("CLOUDFLARE_BILLING_TOKEN").or_else(|| token.clone()),
            token,
            account: var("CLOUDFLARE_ACCOUNT_ID"),
        }
    }

    async fn send(&self, method: Method, url: &str, body: Option<Value>) -> Result<Value> {
        let Some(token) = &self.token else {
            return Err(worker::Error::RustError("no CLOUDFLARE_USAGE_TOKEN".into()));
        };
        send_with(token, method, url, body).await
    }

    /// Whether Cloudflare's bill can be read.
    pub(crate) fn can_read_bill(&self) -> bool {
        self.billing_token.is_some() && !self.account.is_empty()
    }

    fn billing_token(&self) -> Result<&str> {
        self.billing_token
            .as_deref()
            .ok_or_else(|| worker::Error::RustError("no CLOUDFLARE_BILLING_TOKEN or CLOUDFLARE_USAGE_TOKEN".into()))
    }

    /// Billable usage from `from` to `to` (dates), every page of it, as one
    /// answer (`result` holds all the rows), and how many pages it took.
    /// An answer that says it failed is returned as it is.
    pub(crate) async fn billable_usage_pages(&self, from: &str, to: &str) -> Result<(Value, u32)> {
        usage_pages(self.billing_token()?, &self.api(&format!("/billable-usage?from={from}&to={to}"))).await
    }

    /// The account's subscriptions (Workers Paid, add-ons), as Cloudflare
    /// answers them. Needs Account: Billing Read.
    pub(crate) async fn subscriptions_body(&self) -> Result<Value> {
        send_with(self.billing_token()?, Method::Get, &self.api("/subscriptions"), None).await
    }

    /// A GraphQL Analytics query, as Cloudflare answers it, errors and all.
    pub(crate) async fn graphql(&self, body: Value) -> Result<Value> {
        send_with(self.billing_token()?, Method::Post, "https://api.cloudflare.com/client/v4/graphql", Some(body)).await
    }

    pub(crate) fn account(&self) -> &str {
        &self.account
    }

    fn api(&self, path: &str) -> String {
        format!("https://api.cloudflare.com/client/v4/accounts/{}{path}", self.account)
    }

    /// The account's billable usage, one row per service per day, as
    /// Cloudflare reports it.
    async fn billable_usage(&self, from: &str, to: &str) -> Result<Vec<UsageRow>> {
        let Some(token) = &self.token else {
            return Err(worker::Error::RustError("no CLOUDFLARE_USAGE_TOKEN".into()));
        };
        let (body, _) = usage_pages(token, &self.api(&format!("/billable-usage?from={from}&to={to}"))).await?;
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

/// A request to Cloudflare's API with a bearer token; anything but 200 is
/// an error with what Cloudflare said.
/// The most pages of billable usage read in one go: far more than a few
/// months of g1t's meters.
const MAX_USAGE_PAGES: u32 = 50;

/// Every page of a billable-usage answer, its rows together. Before
/// 2026-10-09 only the first page was read.
async fn usage_pages(token: &str, url: &str) -> Result<(Value, u32)> {
    let mut rows: Vec<Value> = Vec::new();
    let mut pages = 0;
    let mut next = url.to_owned();
    loop {
        let body = send_with(token, Method::Get, &next, None).await?;
        if body["success"] == Value::Bool(false) {
            return Ok((body, pages + 1));
        }
        pages += 1;
        rows.extend(body["result"].as_array().cloned().unwrap_or_default());
        match crate::costs::next_page(&body, pages).filter(|_| pages < MAX_USAGE_PAGES) {
            Some(query) => next = format!("{url}&{query}"),
            None => break,
        }
    }
    Ok((json!({ "success": true, "result": rows }), pages))
}

async fn send_with(token: &str, method: Method, url: &str, body: Option<Value>) -> Result<Value> {
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

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct ContainerUsage {
    cpu_seconds: f64,
    memory_byte_seconds: f64,
}

/// g1t's standard sandbox (`STANDARD_INSTANCE` in the contracts): a custom
/// Containers instance type of 1 vCPU, 4 GiB and 20 GB of disk.
const SANDBOX_GIB: f64 = 4.0;
const SANDBOX_DISK_GB: f64 = 20.0;
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

/// A unit's rate from the bill: the median, over the days with a list
/// cost, of list cost over quantity. Never what was billed: that is net of
/// the included amounts (nothing while a cycle is inside them, part of a
/// day's usage on the day it passes one), so over all of the quantity it
/// reads as a lower price when nothing changed. None without a list cost;
/// the published rates stand in.
pub(crate) fn billed_rate(rows: &[&UsageRow]) -> Option<f64> {
    let mut rates: Vec<f64> = rows
        .iter()
        .filter(|r| r.list_cost > 0.0 && r.quantity > 0.0)
        .map(|r| r.list_cost / r.quantity)
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
    /// The quantity at list price, before the included amounts.
    list_cost: f64,
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
            list_cost: number(&["ListCost", "list_cost"]),
        })
    }
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

impl Billing {
    pub(crate) async fn prices(&self) -> Result<PriceBook> {
        // Three reads at once; the plans are priced from the rows already
        // read, not one query per meter (status.g1t.sh times this call).
        let (prices, changes, coming) = futures_util::future::join3(
            async { self.db.prepare("SELECT * FROM prices ORDER BY rowid").all().await?.results::<PriceRow>() },
            async {
                self.db
                    .prepare("SELECT * FROM price_changes ORDER BY created_at DESC LIMIT 20")
                    .all()
                    .await?
                    .results::<ChangeRow>()
            },
            // Changes still to come first, so a rise is seen before it is charged.
            self.coming_changes(),
        )
        .await;
        let (prices, changes, coming) = (prices?, changes?, coming?);
        // Agents' and models' meters, from before g1t stopped running
        // agents, stay in the table but are no longer prices.
        let prices: Vec<PriceRow> = prices.into_iter().filter(|row| !crate::pricing::retired(&row.meter)).collect();
        let changes: Vec<ChangeRow> = changes.into_iter().filter(|row| !crate::pricing::retired(&row.meter)).collect();
        let coming: Vec<PriceChange> = coming.into_iter().filter(|change| !crate::pricing::retired(&change.meter)).collect();
        let book: std::collections::BTreeMap<&str, f64> = prices
            .iter()
            .map(|row| (row.meter.as_str(), Price::price_for(row.cost_micros, row.markup_percent)))
            .collect();
        // With the card fee on top of each monthly price, as it is charged.
        let card_fee = self.card_fee().await?;
        let plans: Vec<_> = g1t_contracts::billing::Feature::ALL
            .iter()
            .map(|feature| {
                let mut plan = match feature {
                    g1t_contracts::billing::Feature::Security => crate::features::security_plan_at(&book),
                    _ => self.plan_at(&book),
                };
                plan.card_fee_cents = crate::tax::fee_for(i64::from(plan.monthly_cents), &card_fee) as u32;
                plan
            })
            .collect();
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
            changes: coming
                .into_iter()
                .chain(changes.into_iter().map(|row| PriceChange {
                    meter: row.meter,
                    old_cost_micros: row.old_cost_micros,
                    new_cost_micros: row.new_cost_micros,
                    markup_percent: row.markup_percent,
                    old_markup_percent: row.old_markup_percent,
                    reason: row.reason,
                    created_at: row.created_at,
                    effective_at: None,
                }))
                .collect(),
            // Nothing is charged for models any more; kept for readers.
            model_margin_percent: self.margin_percent,
            plans,
            free: Some(g1t_contracts::billing::FreeTier {
                trial_workspace_micros: if self.trials_on { self.plans.trial_workspace_micros } else { 0 },
                trial_monthly_pool_micros: if self.trials_on { self.plans.trial_monthly_pool_micros } else { 0 },
                oss_pool_micros: self.plans.oss_pool_micros,
                oss_repo_micros: self.plans.oss_repo_micros,
                free_private_storage_bytes: self.plans.free_storage_bytes,
                audit_retention_days: self.plans.free_audit_days,
                plan_audit_retention_days: self.plans.audit_days,
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

        // Containers: each resource at the list cost the bill shows for it
        // (before the included amounts), or the published rate without one,
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
        let parts_reason = "Cloudflare's Containers and Durable Objects rates, as listed on the bill or published";
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
                    format!("{} at the list cost on Cloudflare's bill", billed.join(", "))
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
                let reason = format!("Cloudflare's bill lists Workers {unit} at ${:.2} per million", rate * 1e6);
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

    /// Proposes moving a meter's cost to a measurement (see `pricing`):
    /// applied on its own when small, after notice when a rise; left for
    /// staff when large or suspect.
    async fn measure(&self, meter: &str, measured: f64, reason: &str) -> Result<()> {
        if let Some(outcome) = self.propose(meter, measured, reason, "keeper").await? {
            worker::console_log!("{meter}: {outcome}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cost_plus_the_margin_rounds_up_to_a_whole_micro() {
        assert_eq!(crate::margin_on(140_000_000, 20), 168_000_000);
        // Exactly cost plus the margin, rounded up, in whole micros, never under it.
        for cost in [0_i64, 1, 7, 999, 123_457, 99_999_999] {
            let exact = (cost * 120 + 99) / 100;
            assert_eq!(crate::margin_on(cost, 20), exact, "{cost}");
            assert!(crate::margin_on(cost, 20) * 100 >= cost * 120, "{cost}");
        }
    }

    #[test]
    fn a_sandbox_second_is_its_memory_and_disk_and_the_cpu_it_uses() {
        // An hour of sandboxes that kept a fifth of a vCPU busy.
        let usage = ContainerUsage { cpu_seconds: 720.0, memory_byte_seconds: 3600.0 * 4.0 * GIB };
        let micros =
            sandbox_second_micros(usage, LIST_MEMORY_GIB_SECOND, LIST_DISK_GB_SECOND, LIST_VCPU_SECOND, LIST_DO_GB_SECOND).unwrap();
        // 4 x 2.5 + 20 x 0.07 + 0.125 x 12.5 + 0.2 x 20 = 16.9625
        assert!((micros - 16.9625).abs() < 1e-9, "{micros}");
        // The Durable Object adds about 14% to the second it left out.
        assert!((sandbox_base_micros(LIST_MEMORY_GIB_SECOND, LIST_DISK_GB_SECOND, LIST_DO_GB_SECOND) - 12.9625).abs() < 1e-9);
        // Too little use to say anything.
        assert!(sandbox_second_micros(ContainerUsage { cpu_seconds: 1.0, memory_byte_seconds: GIB }, 1.0, 1.0, 1.0, 1.0).is_none());
    }

    #[test]
    fn a_run_that_reports_its_cpu_is_priced_on_it() {
        let base = sandbox_base_micros(LIST_MEMORY_GIB_SECOND, LIST_DISK_GB_SECOND, LIST_DO_GB_SECOND);
        let vcpu = LIST_VCPU_SECOND * MICROS_PER_DOLLAR as f64;
        // A 10-minute cargo build that kept half its vCPU busy throughout.
        let heavy = run_cost(600, 300.0, base, vcpu);
        assert!((heavy - (600.0 * 12.9625 + 300.0 * 20.0)).abs() < 1e-6);
        // The same ten minutes, mostly idle, costs less.
        let light = run_cost(600, 30.0, base, vcpu);
        assert!(light < heavy);
        // The average would have under-priced the heavy one.
        let average = 600.0 * (base + 0.195 * vcpu);
        assert!(average < heavy && average > light);
        assert_eq!(run_cost(0, -1.0, base, vcpu), 0.0);
        // A larger machine's base: its memory and disk, not its CPU.
        assert!((base_scale(SANDBOX_GIB, SANDBOX_DISK_GB) - 1.0).abs() < 1e-12);
        assert!((base_scale(12.0, 20.0) - 2.54).abs() < 0.01, "{}", base_scale(12.0, 20.0));
        assert!((base_scale(8.0, 20.0) - 1.77).abs() < 0.01, "{}", base_scale(8.0, 20.0));
        // Each machine in the contracts, priced from its own memory and disk.
        for instance in g1t_contracts::actions::INSTANCE_TYPES {
            let scale = base_scale(instance.memory_gib, instance.disk_gb);
            assert!(scale >= 1.0 && scale < instance.price_scale.max(1.0) + 1e-9, "{}: {scale}", instance.label);
        }
    }

    #[test]
    fn a_billed_rate_is_the_median_of_the_charged_days() {
        let row = |quantity: f64, list_cost: f64| UsageRow {
            period_start: String::new(),
            period_end: String::new(),
            service: "Containers / Container Memory".into(),
            unit: "Count".into(),
            quantity,
            cost: list_cost,
            list_cost,
        };
        let rows = [row(100.0, 0.0), row(100.0, 0.0002), row(100.0, 0.00025), row(100.0, 0.00025)];
        assert_eq!(billed_rate(&rows.iter().collect::<Vec<_>>()), Some(0.000_002_5));
        assert_eq!(billed_rate(&[&row(5.0, 0.0)]), None);
    }

    #[test]
    fn a_rate_is_the_list_price_not_what_was_billed_past_the_included_amount() {
        // 126,870 GiB-seconds, of which the 36,870 past the included 90,000
        // were billed: $0.09 billed, $0.32 at list. The rate is the list's.
        let row = UsageRow {
            period_start: String::new(),
            period_end: String::new(),
            service: "Containers / Container Memory".into(),
            unit: "GiB-seconds".into(),
            quantity: 126_870.0,
            cost: 0.092_175,
            list_cost: 0.317_175,
        };
        assert!((billed_rate(&[&row]).unwrap() - 0.000_002_5).abs() < 1e-15);
        // Billed with no list cost says nothing about the price.
        assert_eq!(billed_rate(&[&UsageRow { list_cost: 0.0, ..row }]), None);
    }

    #[test]
    fn usage_rows_are_read_by_their_focus_names() {
        let row = UsageRow::from_value(&json!({
            "ServiceFamilyName": "Containers",
            "ServiceName": "Memory",
            "PricingUnit": "GiB-seconds",
            "PricingQuantity": "1200.5",
            "ContractedCost": 0.003,
            "ListCost": 0.0030,
            "ChargePeriodStart": "2026-10-01",
        }))
        .unwrap();
        assert_eq!(row.service, "Containers / Memory");
        assert_eq!(row.quantity, 1200.5);
        assert_eq!(row.cost, 0.003);
        assert_eq!(row.list_cost, 0.003);
        assert!(UsageRow::from_value(&json!({ "nothing": 1 })).is_none());
    }
}
