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
/// Too little spend to measure a cost from.
const MIN_MEASURED_USD: f64 = 5.0;
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
            let url = self.api(&format!(
                "/ai-gateway/gateways/{}/logs?per_page=50&page={page}\
                 &filters[0][key]=metadata.value&filters[0][operator]=eq&filters[0][value][0]={session}",
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

    /// The account's billable usage this month, as Cloudflare reports it.
    async fn billable_usage(&self, from: &str, to: &str) -> Result<Vec<UsageRow>> {
        let body = self
            .send(Method::Get, &self.api(&format!("/billing/usage/paygo?from={from}&to={to}")), None)
            .await?;
        let rows = body["result"].as_array().cloned().unwrap_or_default();
        Ok(rows.iter().filter_map(UsageRow::from_value).collect())
    }

    /// Seconds g1t's containers ran since `since` (RFC 3339), across the
    /// account.
    async fn container_seconds(&self, since: &str, until: &str) -> Result<f64> {
        let query = "query ($account: String!, $since: Time!, $until: Time!) {
          viewer { accounts(filter: { accountTag: $account }) {
            containersMetricsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $since, datetime_leq: $until }) {
              sum { containerUptime }
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
        let groups = body["data"]["viewer"]["accounts"][0]["containersMetricsAdaptiveGroups"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        Ok(groups.iter().map(|g| g["sum"]["containerUptime"].as_f64().unwrap_or(0.0)).sum())
    }
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
            unit: text(&["ConsumedUnit", "PricingUnit", "consumed_unit"]),
            quantity: number(&["PricingQuantity", "ConsumedQuantity", "pricing_quantity"]),
            cost: number(&["ContractedCost", "BilledCost", "contracted_cost"]),
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
                    reason: row.reason,
                    created_at: row.created_at,
                })
                .collect(),
            model_margin_percent: self.margin_percent,
        })
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
            .prepare("SELECT cost_micros, description FROM ledger WHERE reference = ?")
            .bind(&[run.id.as_str().into()])?
            .first::<Charged>(None)
            .await?;
        let charge_for = |micros: i64| {
            if self.free {
                0
            } else {
                charge_micros(micros as f64 / MICROS_PER_DOLLAR as f64, self.margin_percent)
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
                let description = format!(
                    "Work on {}#{}, settled from AI Gateway after the sandbox stopped without reporting{free_note}",
                    run.repo, run.number
                );
                self.enter(&run.workspace, EntryKind::Usage, -charge_for(gateway_micros), &description, &run.id, Some(&row), Some(gateway_micros), None, None)
                    .await?;
            }
            Some(charged) => {
                let reported = charged.cost_micros.unwrap_or(0);
                let delta = gateway_micros - reported;
                if delta == 0 {
                    return Ok(());
                }
                let amount = -(charge_for(gateway_micros) - charge_for(reported));
                let description = format!(
                    "Correction to “{}”: AI Gateway priced its {requests} model requests at {}, not {}",
                    charged.description,
                    crate::features::dollars(gateway_micros),
                    crate::features::dollars(reported),
                );
                self.enter(
                    &run.workspace,
                    EntryKind::Usage,
                    amount,
                    &description,
                    &format!("{}/settled", run.id),
                    Some(&row),
                    Some(delta),
                    None,
                    None,
                )
                .await?;
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
        let month_start = format!("{}-01", &now[..7]);
        let today = &now[..10];
        let rows = keeper.billable_usage(&month_start, today).await?;
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

        let matching = |service: &str, unit: Option<&str>| -> (f64, f64) {
            rows.iter()
                .filter(|r| r.service.to_lowercase().contains(service))
                .filter(|r| unit.is_none_or(|u| r.unit.to_lowercase().contains(u)))
                .fold((0.0, 0.0), |(q, c), r| (q + r.quantity, c + r.cost))
        };

        // Containers: what they cost, over the seconds they ran.
        let (_, container_cost) = matching("container", None);
        if container_cost >= MIN_MEASURED_USD {
            let seconds = keeper.container_seconds(&format!("{month_start}T00:00:00Z"), &now).await?;
            if seconds > 0.0 {
                let per_second = container_cost * MICROS_PER_DOLLAR as f64 / seconds;
                for meter in ["sandbox_second", "build_second"] {
                    self.measure(meter, per_second, &format!("Cloudflare billed ${container_cost:.2} for {seconds:.0} container-seconds this month")).await?;
                }
            }
        }
        // Workers for Platforms: per million requests and CPU milliseconds.
        for (meter, unit, scale) in [("app_requests", "request", 1e6), ("app_cpu", "ms", 1e6)] {
            let (quantity, cost) = matching("workers for platforms", Some(unit));
            if cost >= MIN_MEASURED_USD && quantity > 0.0 {
                let per = cost * MICROS_PER_DOLLAR as f64 / quantity * scale;
                self.measure(meter, per, &format!("Cloudflare billed ${cost:.2} for {quantity:.0} {unit}s this month")).await?;
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
    fn small_moves_are_noise_and_wild_ones_are_not_believed() {
        assert_eq!(adopt(21.0, 21.2), Ok(None));
        assert_eq!(adopt(21.0, 25.0), Ok(Some(25.0)));
        assert_eq!(adopt(21.0, 15.0), Ok(Some(15.0)));
        assert!(adopt(21.0, 200.0).is_err());
        assert!(adopt(21.0, 0.0).is_err());
    }

    #[test]
    fn usage_rows_are_read_by_their_focus_names() {
        let row = UsageRow::from_value(&json!({
            "ServiceFamilyName": "Containers",
            "ServiceName": "Memory",
            "ConsumedUnit": "GiB-seconds",
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
