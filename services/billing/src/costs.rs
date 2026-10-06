//! What Cloudflare charges g1t, day by day and product by product.
//!
//! Prices are what g1t pays plus 20%, so g1t has to know what it pays, as
//! Cloudflare counts it, not as g1t assumes it. Some of what g1t runs on
//! is in beta (Artifacts bills "operations" from 2026-10-14 without saying
//! exactly which calls are one), so nothing here assumes a product list:
//! every line Cloudflare bills is kept, whatever it is, and how a line
//! maps to what g1t sells is data (`cost_map`), changed without a deploy.
//!
//! Once a day (`keeper::DAILY`) billing reads:
//!
//! - **Billable usage** (`GET /accounts/{id}/billable-usage`, FOCUS
//!   columns): one row per service per day, with its quantity and what it
//!   cost g1t. Every Cloudflare product g1t uses appears here once it is
//!   used: Workers, Workers for Platforms, D1, KV, R2, Queues, Containers,
//!   Durable Objects, Artifacts, Browser Rendering, Workers AI, Vectorize,
//!   Cloudflare for SaaS and Email.
//! - **Artifacts events** (GraphQL `artifactsEventsAdaptiveGroups`), by
//!   event type and day: what Artifacts itself counted, to compare with
//!   what g1t counted (`margin`).
//!
//! Each becomes cost lines in `cost_lines`, one per (day, source,
//! product, meter), upserted, so reading a day again replaces it. The
//! first run reads the last 31 days; after that the last few, since
//! Cloudflare restates recent days as usage settles.
//!
//! The token is `CLOUDFLARE_BILLING_TOKEN` (Account: Billing Read and
//! Account Analytics Read), or the keeper's `CLOUDFLARE_USAGE_TOKEN`,
//! which has both. Without either, nothing is read and nothing fails.

use std::collections::BTreeMap;

use g1t_contracts::repos::{GitOperationsArgs, WorkspaceGitOperations};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::Result;

use crate::Billing;
use crate::keeper::Keeper;

/// Where a cost line came from.
pub(crate) const SOURCE_BILLABLE: &str = "billable_usage";
pub(crate) const SOURCE_ARTIFACTS: &str = "artifacts_events";

/// How far back the first run reads: the 31 days GraphQL keeps.
pub(crate) const BACKFILL_DAYS: u64 = 31;
/// How many recent days every later run reads again.
pub(crate) const RESTATE_DAYS: u64 = 4;

pub(crate) const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// One day of one meter of one Cloudflare product.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CostLine {
    /// YYYY-MM-DD, UTC.
    pub day: String,
    pub source: &'static str,
    /// `containers`, `workers`, `workers_kv`, `artifacts`, … from
    /// Cloudflare's own family name.
    pub product: String,
    /// The service within it, such as `container_memory_per_gib_second`
    /// or `events_push`.
    pub meter: String,
    pub unit: String,
    pub quantity: f64,
    /// What g1t pays, in dollars: contracted, billed, or list.
    pub cost_usd: f64,
    /// The name as Cloudflare gave it, for people.
    pub raw_name: String,
}

/// `Workers for Platforms CPU ms (First 60M ms are included)` →
/// `workers_for_platforms_cpu_ms`: lower case, words joined by `_`, and
/// what is in parentheses (the included amount, which changes) left out.
pub(crate) fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    let mut gap = false;
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            c if c.is_ascii_alphanumeric() => {
                if gap && !out.is_empty() {
                    out.push('_');
                }
                gap = false;
                out.push(c.to_ascii_lowercase());
            }
            _ => gap = true,
        }
    }
    out
}

/// The product and meter for a family and service name, such as
/// (`D1`, `D1 - Rows Read (first 25 billion included)`) → (`d1`,
/// `d1_rows_read`). Without a family, the service's first word.
pub(crate) fn product_and_meter(family: &str, service: &str) -> (String, String) {
    let (family, service) = if family.trim().is_empty() {
        match service.split_once(" / ") {
            Some((family, service)) => (family, service),
            None => (service.split_whitespace().next().unwrap_or("other"), service),
        }
    } else {
        (family, service)
    };
    let product = slug(family);
    let product = if product.is_empty() { "other".to_owned() } else { product };
    // Kept whole: `Workers for Platforms Requests` under `Workers` must stay
    // `workers_for_platforms_requests`.
    let meter = slug(service);
    let meter = if meter.is_empty() { "usage".to_owned() } else { meter };
    (product, meter)
}

fn text<'a>(row: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().find_map(|k| row[*k].as_str()).unwrap_or_default()
}

fn number(row: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|k| row[*k].as_f64().or_else(|| row[*k].as_str().and_then(|s| s.trim().parse().ok())))
}

/// One row of billable usage, read leniently: the API is new, and its
/// field names are FOCUS's (in either case). None without a service or a
/// day.
pub(crate) fn line_from_focus(row: &Value) -> Option<CostLine> {
    let service = text(row, &["ServiceName", "service_name", "service"]);
    let day = text(row, &["ChargePeriodStart", "charge_period_start", "UsageDate", "date"]);
    if service.is_empty() || day.len() < 10 {
        return None;
    }
    let family = text(row, &["ServiceFamilyName", "service_family_name", "ServiceCategory"]);
    let (product, meter) = product_and_meter(family, service);
    // What g1t pays: contracted, else billed, else list.
    let cost = [
        &["ContractedCost", "contracted_cost"][..],
        &["BilledCost", "billed_cost"][..],
        &["EffectiveCost", "effective_cost"][..],
        &["ListCost", "list_cost"][..],
    ]
    .iter()
    .find_map(|keys| number(row, keys).filter(|c| *c > 0.0))
    .unwrap_or(0.0);
    Some(CostLine {
        day: day[..10].to_owned(),
        source: SOURCE_BILLABLE,
        product,
        meter,
        unit: text(row, &["PricingUnit", "pricing_unit", "ConsumedUnit", "consumed_unit"]).to_owned(),
        quantity: number(row, &["PricingQuantity", "pricing_quantity", "ConsumedQuantity", "consumed_quantity"]).unwrap_or(0.0),
        cost_usd: cost,
        raw_name: if family.is_empty() { service.to_owned() } else { format!("{family} / {service}") },
    })
}

/// Lines with the same key added together, in key order. Cloudflare can
/// give one service several rows a day (regions, tiers); an upsert of
/// each would keep only the last.
pub(crate) fn aggregate(lines: Vec<CostLine>) -> Vec<CostLine> {
    let mut out: Vec<CostLine> = Vec::new();
    for line in lines {
        match out
            .iter_mut()
            .find(|l| l.day == line.day && l.source == line.source && l.product == line.product && l.meter == line.meter)
        {
            Some(existing) => {
                existing.quantity += line.quantity;
                existing.cost_usd += line.cost_usd;
            }
            None => out.push(line),
        }
    }
    out.sort_by(|a, b| (&a.day, a.source, &a.product, &a.meter).cmp(&(&b.day, b.source, &b.product, &b.meter)));
    out
}

/// Every line of a billable-usage answer, aggregated. Errors when
/// Cloudflare says it failed.
pub(crate) fn lines_from_billable(body: &Value) -> std::result::Result<Vec<CostLine>, String> {
    if body["success"] == Value::Bool(false) {
        return Err(format!("billable usage failed: {}", body["errors"]));
    }
    let rows = body["result"].as_array().cloned().unwrap_or_default();
    Ok(aggregate(rows.iter().filter_map(line_from_focus).collect()))
}

/// The GraphQL query for Artifacts' events by type and day.
pub(crate) const ARTIFACTS_QUERY: &str = "query ($account: String!, $since: Date!, $until: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    artifactsEventsAdaptiveGroups(limit: 10000, filter: { date_geq: $since, date_leq: $until }) {
      count
      dimensions { date eventType repositoryName }
    }
  } }
}";

pub(crate) fn artifacts_variables(account: &str, since: &str, until: &str) -> Value {
    json!({ "query": ARTIFACTS_QUERY, "variables": { "account": account, "since": since, "until": until } })
}

/// Artifacts' events as lines (`events_push`, `events_pull`, …), with no
/// cost: billable usage carries the cost. Errors when GraphQL does.
pub(crate) fn lines_from_artifacts(body: &Value) -> std::result::Result<Vec<CostLine>, String> {
    if let Some(errors) = body["errors"].as_array().filter(|e| !e.is_empty()) {
        return Err(format!("Artifacts events failed: {}", Value::Array(errors.clone())));
    }
    let groups = body["data"]["viewer"]["accounts"][0]["artifactsEventsAdaptiveGroups"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(aggregate(
        groups
            .iter()
            .filter_map(|g| {
                let day = g["dimensions"]["date"].as_str()?;
                let kind = g["dimensions"]["eventType"].as_str()?;
                if day.len() < 10 {
                    return None;
                }
                Some(CostLine {
                    day: day[..10].to_owned(),
                    source: SOURCE_ARTIFACTS,
                    product: "artifacts".to_owned(),
                    meter: format!("events_{}", slug(kind)),
                    unit: "events".to_owned(),
                    quantity: g["count"].as_f64().unwrap_or(0.0),
                    cost_usd: 0.0,
                    raw_name: format!("Artifacts / {kind}"),
                })
            })
            .collect(),
    ))
}

/// The workspace a repository in the store belongs to: keys are
/// `<workspace>--<repo>`; a pull request's fork (`pulls--<id>`) says none.
pub(crate) fn workspace_of_store_key(key: &str) -> Option<String> {
    let (workspace, rest) = key.split_once("--")?;
    (!workspace.is_empty() && !rest.is_empty() && workspace != "pulls").then(|| workspace.to_lowercase())
}

/// Artifacts' billable operations per workspace and day, by repository
/// name: how Cloudflare's own count shares out. The meter is
/// `cloudflare_git`, which shares out the git bucket's cost (`margin`).
pub(crate) fn artifacts_by_workspace(body: &Value) -> Vec<(String, String, f64)> {
    let groups = body["data"]["viewer"]["accounts"][0]["artifactsEventsAdaptiveGroups"].as_array().cloned().unwrap_or_default();
    let mut out: BTreeMap<(String, String), f64> = BTreeMap::new();
    for g in &groups {
        let (Some(day), Some(kind)) = (g["dimensions"]["date"].as_str(), g["dimensions"]["eventType"].as_str()) else { continue };
        if day.len() < 10 || !ARTIFACTS_OPERATIONS.contains(&format!("events_{}", slug(kind)).as_str()) {
            continue;
        }
        let Some(workspace) = g["dimensions"]["repositoryName"].as_str().and_then(workspace_of_store_key) else { continue };
        *out.entry((day[..10].to_owned(), workspace)).or_default() += g["count"].as_f64().unwrap_or(0.0);
    }
    out.into_iter().map(|((day, workspace), count)| (day, workspace, count)).collect()
}

/// Artifacts' event types that are operations it bills: what its
/// pricing names (create, push, pull, clone) and the metrics list.
/// Errors such as `rateLimited` are not.
pub(crate) const ARTIFACTS_OPERATIONS: [&str; 5] = ["events_create", "events_fork", "events_push", "events_pull", "events_delete"];

/// The days to read: the 31 before today on the first run (`last` is
/// None), else the last few, never further back than the backfill.
pub(crate) fn window(last_fetched_day: Option<&str>, now_ms: u64) -> (String, String) {
    let day = |ms: u64| g1t_contracts::time::rfc3339(ms)[..10].to_owned();
    let today = day(now_ms);
    let since = match last_fetched_day {
        None => day(now_ms.saturating_sub(BACKFILL_DAYS * DAY_MS)),
        Some(last) => {
            let restate = day(now_ms.saturating_sub(RESTATE_DAYS * DAY_MS));
            let floor = day(now_ms.saturating_sub(BACKFILL_DAYS * DAY_MS));
            // A gap since the last run is read too, up to the backfill.
            let from = if last < restate.as_str() { last.to_owned() } else { restate };
            if from < floor { floor } else { from }
        }
    };
    (since, today)
}

/// Every day from `since` to `until`, inclusive.
pub(crate) fn days_between(since: &str, until: &str) -> Vec<String> {
    let start = g1t_contracts::time::parse_rfc3339(&format!("{since}T00:00:00Z"));
    let end = g1t_contracts::time::parse_rfc3339(&format!("{until}T00:00:00Z"));
    match (start, end) {
        (Some(start), Some(end)) if start <= end => (0..=((end - start) / DAY_MS))
            .map(|n| g1t_contracts::time::rfc3339(start + n * DAY_MS)[..10].to_owned())
            .collect(),
        _ => Vec::new(),
    }
}

/// A rule from `cost_map`: which Cloudflare lines feed which of g1t's
/// products.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub(crate) struct Rule {
    /// Cloudflare's product, as slugged here.
    pub product: String,
    /// A meter prefix, or `*` for any meter of the product.
    pub meter: String,
    /// g1t's product it is a cost of: `sandboxes`, `git`, `platform`, …
    pub bucket: String,
    /// The price book meter whose cost it measures, if any.
    pub price_meter: Option<String>,
    /// g1t's own count of the same units, to compare quantities.
    pub own_meter: Option<String>,
    /// How far g1t's count may be from Cloudflare's before it is drift.
    pub drift_percent: f64,
}

/// The rule for a line: its product's rule with the longest matching
/// meter prefix, `*` last. None means no one decided what pays for it:
/// a leak until someone does.
pub(crate) fn classify<'a>(rules: &'a [Rule], product: &str, meter: &str) -> Option<&'a Rule> {
    rules
        .iter()
        .filter(|r| r.product == product && (r.meter == "*" || meter.starts_with(r.meter.as_str())))
        .max_by_key(|r| if r.meter == "*" { 0 } else { r.meter.len() + 1 })
}

/// What a bucket is called in sudo.
pub(crate) fn bucket_title(bucket: &str) -> String {
    match bucket {
        "sandboxes" => "Sandboxes and builds".into(),
        "deployments" => "Deployments".into(),
        "git" => "Git operations".into(),
        "repo_storage" => "Repository storage".into(),
        "actions_cache" => "Actions cache".into(),
        "embeddings" => "Search embeddings".into(),
        "security" => "Security scans".into(),
        "domains" => "Custom domains".into(),
        "models" => "Models".into(),
        "platform" => "Running g1t (paid by the plan)".into(),
        UNMAPPED => "Not mapped".into(),
        other => other.replace('_', " "),
    }
}

/// The bucket of a line no rule claims.
pub(crate) const UNMAPPED: &str = "unmapped";

/// A day's count per workspace from counts "from this day to the end of
/// its month" (what the repos service's `git_operations` answers with a
/// `since`): each day's is its own less the next day's, within a month.
/// The last day (today, so far) is its own.
pub(crate) fn daily_from_cumulative(days: &[String], cumulative: &[BTreeMap<String, u64>]) -> Vec<(String, String, u64)> {
    let mut out = Vec::new();
    for (index, day) in days.iter().enumerate() {
        let Some(today) = cumulative.get(index) else { break };
        let next = days
            .get(index + 1)
            .filter(|next| next[..7] == day[..7])
            .and_then(|_| cumulative.get(index + 1));
        for (workspace, count) in today {
            let later = next.and_then(|n| n.get(workspace)).copied().unwrap_or(0);
            let own = count.saturating_sub(later);
            if own > 0 {
                out.push((day.clone(), workspace.clone(), own));
            }
        }
    }
    out
}

/// One row of the repos service's `artifacts_usage`, read leniently while
/// its shape settles: a day, a workspace, a raw meter and a count.
pub(crate) fn raw_usage_row(row: &Value) -> Option<(String, String, String, f64)> {
    let day = text(row, &["day", "date"]);
    let workspace = text(row, &["namespace", "workspace"]);
    let meter = text(row, &["meter", "kind", "event", "operation"]);
    let count = number(row, &["count", "quantity", "operations", "value"])?;
    (day.len() >= 10 && !workspace.is_empty() && !meter.is_empty())
        .then(|| (day[..10].to_owned(), workspace.to_lowercase(), slug(meter), count))
}

/// A price meter's units from raw counts and `billable_units` weights:
/// what g1t charges for, from what was counted.
pub(crate) fn billable(raw: &[(String, f64)], weights: &BTreeMap<String, f64>) -> f64 {
    raw.iter().map(|(meter, count)| count * weights.get(meter).copied().unwrap_or(0.0)).sum()
}

impl Billing {
    /// Reads Cloudflare's bill for the days due (see `window`) into
    /// `cost_lines`: the days read and how many lines. None without a
    /// token. What could not be read is added to `problems`.
    pub(crate) async fn read_cloudflare(&self, keeper: &Keeper, problems: &mut Vec<String>) -> Result<Option<(String, String, u32)>> {
        if !keeper.can_read_bill() {
            return Ok(None);
        }
        #[derive(Deserialize)]
        struct Last {
            day: Option<String>,
        }
        let last = self
            .db
            .prepare("SELECT MAX(day) AS day FROM cost_lines WHERE source = ?")
            .bind(&[SOURCE_BILLABLE.into()])?
            .first::<Last>(None)
            .await?
            .and_then(|l| l.day);
        let (since, until) = window(last.as_deref(), now_ms());
        let fetched_at = rfc3339(now_ms());
        let mut written = 0;
        match keeper.billable_usage_body(&since, &until).await.map_err(|e| e.to_string()).and_then(|b| lines_from_billable(&b)) {
            Ok(lines) => written += self.upsert_lines(&lines, &fetched_at).await?,
            Err(error) => problems.push(format!("Cloudflare's billable usage could not be read: {error}")),
        }
        match keeper.graphql(artifacts_variables(keeper.account(), &since, &until)).await.map_err(|e| e.to_string()) {
            Ok(body) => match lines_from_artifacts(&body) {
                Ok(lines) => {
                    written += self.upsert_lines(&lines, &fetched_at).await?;
                    self.keep_cloudflare_counts(&since, &until, &artifacts_by_workspace(&body), &fetched_at).await?;
                }
                Err(error) => problems.push(format!("Artifacts events could not be read: {error}")),
            },
            Err(error) => problems.push(format!("Artifacts events could not be read: {error}")),
        }
        Ok(Some((since, until, written)))
    }

    /// Cloudflare's own per-workspace counts for the days, replacing what
    /// was kept for them.
    async fn keep_cloudflare_counts(&self, since: &str, until: &str, counts: &[(String, String, f64)], fetched_at: &str) -> Result<()> {
        self.db
            .prepare("DELETE FROM own_counts WHERE meter = 'cloudflare_git' AND day >= ?1 AND day <= ?2")
            .bind(&[since.into(), until.into()])?
            .run()
            .await?;
        for chunk in counts.chunks(50) {
            let mut statements = Vec::with_capacity(chunk.len());
            for (day, workspace, count) in chunk {
                statements.push(
                    self.db
                        .prepare("INSERT OR REPLACE INTO own_counts (day, meter, workspace, quantity, fetched_at) VALUES (?, 'cloudflare_git', ?, ?, ?)")
                        .bind(&[day.as_str().into(), workspace.as_str().into(), (*count).into(), fetched_at.into()])?,
                );
            }
            self.db.batch(statements).await?;
        }
        Ok(())
    }

    /// Upserts lines, a day's line replacing what was read for it before.
    async fn upsert_lines(&self, lines: &[CostLine], fetched_at: &str) -> Result<u32> {
        for chunk in lines.chunks(50) {
            let mut statements = Vec::with_capacity(chunk.len());
            for line in chunk {
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO cost_lines (day, source, product, meter, unit, quantity, cost_usd, raw_name, fetched_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                             ON CONFLICT (day, source, product, meter) DO UPDATE SET
                               unit = ?5, quantity = ?6, cost_usd = ?7, raw_name = ?8, fetched_at = ?9",
                        )
                        .bind(&[
                            line.day.as_str().into(),
                            line.source.into(),
                            line.product.as_str().into(),
                            line.meter.as_str().into(),
                            line.unit.as_str().into(),
                            line.quantity.into(),
                            line.cost_usd.into(),
                            line.raw_name.as_str().into(),
                            fetched_at.into(),
                        ])?,
                );
            }
            self.db.batch(statements).await?;
        }
        Ok(lines.len() as u32)
    }

    /// The mapping from Cloudflare's meters to g1t's products.
    pub(crate) async fn rules(&self) -> Result<Vec<Rule>> {
        #[derive(Deserialize)]
        struct Row {
            product: String,
            meter: String,
            bucket: String,
            price_meter: Option<String>,
            own_meter: Option<String>,
            drift_percent: f64,
        }
        Ok(self
            .db
            .prepare("SELECT product, meter, bucket, price_meter, own_meter, drift_percent FROM cost_map")
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|r| Rule {
                product: r.product,
                meter: r.meter,
                bucket: r.bucket,
                price_meter: r.price_meter,
                own_meter: r.own_meter,
                drift_percent: r.drift_percent,
            })
            .collect())
    }

    /// g1t's own counts for the days: raw Artifacts meters from the repos
    /// service's `artifacts_usage` when it answers, and git operations,
    /// from those raw meters and `billable_units` weights when both exist,
    /// else from its `git_operations`.
    pub(crate) async fn count_own(&self, since: &str, until: &str) -> Result<()> {
        let Some(repos) = &self.repos else { return Ok(()) };
        let days = days_between(since, until);
        let fetched_at = rfc3339(now_ms());
        let mut rows: Vec<(String, String, String, f64)> = Vec::new();

        // Raw meters, while the repos service may not have them yet.
        let raw: Vec<(String, String, String, f64)> =
            match g1t_kit::call::<_, Value>(repos, "artifacts_usage", &json!({ "from": since, "to": until })).await {
                Ok(Value::Array(list)) => list.iter().filter_map(raw_usage_row).collect(),
                Ok(other) => other["rows"].as_array().map(|l| l.iter().filter_map(raw_usage_row).collect()).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
        #[derive(Deserialize)]
        struct Weight {
            raw_meter: String,
            weight: f64,
        }
        let weights: BTreeMap<String, f64> = self
            .db
            .prepare("SELECT raw_meter, weight FROM billable_units WHERE price_meter = 'git_operations'")
            .all()
            .await?
            .results::<Weight>()?
            .into_iter()
            .map(|w| (slug(&w.raw_meter), w.weight))
            .collect();
        for (day, workspace, meter, count) in &raw {
            rows.push((day.clone(), format!("artifacts_{meter}"), workspace.clone(), *count));
        }
        if !raw.is_empty() && !weights.is_empty() {
            let mut by: BTreeMap<(String, String), Vec<(String, f64)>> = BTreeMap::new();
            for (day, workspace, meter, count) in &raw {
                by.entry((day.clone(), workspace.clone())).or_default().push((meter.clone(), *count));
            }
            for ((day, workspace), counts) in by {
                rows.push((day, "git_operations".to_owned(), workspace, billable(&counts, &weights)));
            }
        } else {
            let mut cumulative = Vec::with_capacity(days.len());
            for day in &days {
                let list: Vec<WorkspaceGitOperations> = g1t_kit::call(
                    repos,
                    "git_operations",
                    &GitOperationsArgs { month: day[..7].to_owned(), since: Some(format!("{day}T00")), namespace: None },
                )
                .await?;
                cumulative.push(list.into_iter().map(|w| (w.namespace.to_lowercase(), w.operations)).collect::<BTreeMap<_, _>>());
            }
            for (day, workspace, count) in daily_from_cumulative(&days, &cumulative) {
                rows.push((day, "git_operations".to_owned(), workspace, count as f64));
            }
        }

        // Each day's counts replace what was there.
        self.db
            .prepare("DELETE FROM own_counts WHERE day >= ?1 AND day <= ?2 AND meter NOT LIKE 'cloudflare_%'")
            .bind(&[since.into(), until.into()])?
            .run()
            .await?;
        for chunk in rows.chunks(50) {
            let mut statements = Vec::with_capacity(chunk.len());
            for (day, meter, workspace, quantity) in chunk {
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO own_counts (day, meter, workspace, quantity, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)
                             ON CONFLICT (day, meter, workspace) DO UPDATE SET quantity = ?4, fetched_at = ?5",
                        )
                        .bind(&[day.as_str().into(), meter.as_str().into(), workspace.as_str().into(), (*quantity).into(), fetched_at.as_str().into()])?,
                );
            }
            self.db.batch(statements).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Billable usage as Cloudflare answered g1t on 2026-10-06 (two days,
    /// trimmed), plus rows past the included amounts, which cost money.
    fn billable_fixture() -> Value {
        json!({
            "success": true,
            "errors": [],
            "result": [
                {
                    "ChargePeriodStart": "2026-10-03T00:00:00Z",
                    "ChargePeriodEnd": "2026-10-04T00:00:00Z",
                    "ServiceFamilyName": "Containers",
                    "ServiceName": "Container Memory, per GiB-Second (First 25 GiB-hours included)",
                    "PricingUnit": "Count",
                    "PricingQuantity": "14000",
                    "ContractedCost": 0, "BilledCost": 0, "ListCost": 0
                },
                {
                    "ChargePeriodStart": "2026-10-03T00:00:00Z",
                    "ServiceFamilyName": "D1",
                    "ServiceName": "D1 - Rows Read (first 25 billion included)",
                    "PricingUnit": "Count",
                    "PricingQuantity": 1200000,
                    "BilledCost": 0
                },
                {
                    "ChargePeriodStart": "2026-10-15T00:00:00Z",
                    "ServiceFamilyName": "Artifacts",
                    "ServiceName": "Artifacts Operations (First 10,000 included)",
                    "PricingUnit": "Count",
                    "PricingQuantity": "30000",
                    "BilledCost": "3.00",
                    "ListCost": 4.5
                },
                {
                    "ChargePeriodStart": "2026-10-15T00:00:00Z",
                    "ServiceFamilyName": "Artifacts",
                    "ServiceName": "Artifacts Operations (First 10,000 included)",
                    "PricingUnit": "Count",
                    "PricingQuantity": "10000",
                    "BilledCost": "1.50"
                },
                {
                    "ChargePeriodStart": "2026-10-15T00:00:00Z",
                    "ServiceFamilyName": "Workers",
                    "ServiceName": "Workers for Platforms Requests (First 20M are included)",
                    "PricingUnit": "Count",
                    "PricingQuantity": 25000000,
                    "ListCost": 1.5
                },
                { "ServiceName": "No day, no line" }
            ]
        })
    }

    #[test]
    fn names_become_products_and_meters() {
        assert_eq!(slug("Workers for Platforms CPU ms (First 60M ms are included)"), "workers_for_platforms_cpu_ms");
        assert_eq!(product_and_meter("D1", "D1 - Rows Read (first 25 billion included)"), ("d1".into(), "d1_rows_read".into()));
        assert_eq!(product_and_meter("Workers KV", "KV Read Operations (First 10M is included)"), ("workers_kv".into(), "kv_read_operations".into()));
        assert_eq!(product_and_meter("", "Containers / Container vCPU"), ("containers".into(), "container_vcpu".into()));
        assert_eq!(product_and_meter("Email", ""), ("email".into(), "usage".into()));
    }

    #[test]
    fn billable_usage_is_parsed_and_rows_of_one_meter_are_added() {
        let lines = lines_from_billable(&billable_fixture()).unwrap();
        assert_eq!(lines.len(), 4, "{lines:#?}");
        let artifacts = lines.iter().find(|l| l.product == "artifacts").unwrap();
        // Two rows of the same day and meter: one line, added up.
        assert_eq!(artifacts.meter, "artifacts_operations");
        assert_eq!(artifacts.quantity, 40_000.0);
        assert!((artifacts.cost_usd - 4.5).abs() < 1e-9, "billed, not list: {}", artifacts.cost_usd);
        let wfp = lines.iter().find(|l| l.meter.starts_with("workers_for_platforms")).unwrap();
        assert_eq!(wfp.product, "workers");
        // No billed cost: the list cost.
        assert_eq!(wfp.cost_usd, 1.5);
        let memory = lines.iter().find(|l| l.product == "containers").unwrap();
        assert_eq!((memory.day.as_str(), memory.quantity, memory.cost_usd), ("2026-10-03", 14_000.0, 0.0));
        assert!(lines_from_billable(&json!({ "success": false, "errors": [{ "code": 10000 }] })).is_err());
    }

    #[test]
    fn reading_the_same_days_twice_gives_the_same_lines() {
        // Idempotent: the same answer aggregates to the same keys and
        // amounts, so the upsert replaces rather than adds.
        let once = lines_from_billable(&billable_fixture()).unwrap();
        let twice = lines_from_billable(&billable_fixture()).unwrap();
        assert_eq!(once, twice);
        let again = aggregate(once.clone());
        assert_eq!(again, once);
    }

    #[test]
    fn artifacts_events_are_counted_by_type_and_day() {
        let body = json!({
            "data": { "viewer": { "accounts": [{ "artifactsEventsAdaptiveGroups": [
                { "count": 120, "dimensions": { "date": "2026-10-05", "eventType": "pull" } },
                { "count": 30, "dimensions": { "date": "2026-10-05", "eventType": "push" } },
                { "count": 2, "dimensions": { "date": "2026-10-05", "eventType": "rateLimited" } },
                { "count": 5, "dimensions": { "date": "2026-10-06", "eventType": "pull" } }
            ] }] } },
            "errors": null
        });
        let lines = lines_from_artifacts(&body).unwrap();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].meter, "events_pull");
        assert_eq!(lines[0].quantity, 120.0);
        assert!(lines.iter().any(|l| l.meter == "events_ratelimited"));
        // By workspace, from the repository's store key; forks say none.
        let by_repo = json!({ "data": { "viewer": { "accounts": [{ "artifactsEventsAdaptiveGroups": [
            { "count": 100, "dimensions": { "date": "2026-10-05", "eventType": "pull", "repositoryName": "acme--api" } },
            { "count": 20, "dimensions": { "date": "2026-10-05", "eventType": "push", "repositoryName": "acme--web" } },
            { "count": 7, "dimensions": { "date": "2026-10-05", "eventType": "fork", "repositoryName": "pulls--123" } },
            { "count": 3, "dimensions": { "date": "2026-10-05", "eventType": "serverError", "repositoryName": "beta--x" } }
        ] }] } } });
        assert_eq!(artifacts_by_workspace(&by_repo), vec![("2026-10-05".to_string(), "acme".to_string(), 120.0)]);
        assert_eq!(workspace_of_store_key("Acme--api"), Some("acme".into()));
        assert_eq!(workspace_of_store_key("pulls--9"), None);
        assert_eq!(workspace_of_store_key("plain"), None);
        let operations: f64 = lines
            .iter()
            .filter(|l| l.day == "2026-10-05" && ARTIFACTS_OPERATIONS.contains(&l.meter.as_str()))
            .map(|l| l.quantity)
            .sum();
        assert_eq!(operations, 150.0);
        let failed = json!({ "data": null, "errors": [{ "message": "unknown field" }] });
        assert!(lines_from_artifacts(&failed).is_err());
    }

    #[test]
    fn the_first_run_backfills_31_days_and_later_runs_restate_a_few() {
        let now = g1t_contracts::time::parse_rfc3339("2026-10-06T04:17:00Z").unwrap();
        assert_eq!(window(None, now), ("2026-09-05".into(), "2026-10-06".into()));
        assert_eq!(window(Some("2026-10-06"), now), ("2026-10-02".into(), "2026-10-06".into()));
        // A week without a run: from the last day read.
        assert_eq!(window(Some("2026-09-28"), now), ("2026-09-28".into(), "2026-10-06".into()));
        // Never past the backfill.
        assert_eq!(window(Some("2026-01-01"), now), ("2026-09-05".into(), "2026-10-06".into()));
        assert_eq!(days_between("2026-09-29", "2026-10-02"), vec!["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
        assert!(days_between("2026-10-02", "2026-10-01").is_empty());
    }

    #[test]
    fn a_days_git_operations_are_its_count_less_the_next_days() {
        let days: Vec<String> = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].iter().map(|d| d.to_string()).collect();
        let map = |pairs: &[(&str, u64)]| pairs.iter().map(|(w, n)| (w.to_string(), *n)).collect::<BTreeMap<_, _>>();
        // From each day to the end of its month.
        let cumulative = vec![map(&[("acme", 30), ("beta", 4)]), map(&[("acme", 10)]), map(&[("acme", 7)]), map(&[("acme", 2)])];
        let daily = daily_from_cumulative(&days, &cumulative);
        assert_eq!(
            daily,
            vec![
                ("2026-09-29".into(), "acme".into(), 20),
                ("2026-09-29".into(), "beta".into(), 4),
                // The month's last day is its own.
                ("2026-09-30".into(), "acme".into(), 10),
                ("2026-10-01".into(), "acme".into(), 5),
                // Today so far.
                ("2026-10-02".into(), "acme".into(), 2),
            ]
        );
    }

    #[test]
    fn raw_meters_become_billable_units_by_their_weights() {
        let row = raw_usage_row(&json!({ "day": "2026-10-15", "namespace": "Acme", "meter": "upload_pack", "count": 12 })).unwrap();
        assert_eq!(row, ("2026-10-15".into(), "acme".into(), "upload_pack".into(), 12.0));
        assert!(raw_usage_row(&json!({ "day": "2026-10-15", "count": 1 })).is_none());
        let weights: BTreeMap<String, f64> = [("upload_pack".to_string(), 1.0), ("receive_pack".to_string(), 1.0), ("binding_read".to_string(), 0.0)].into();
        let raw = vec![("upload_pack".to_string(), 12.0), ("receive_pack".to_string(), 3.0), ("binding_read".to_string(), 400.0), ("ls_refs".to_string(), 9.0)];
        assert_eq!(billable(&raw, &weights), 15.0);
        // Cloudflare turns out to count binding reads: one row changes, and
        // so does what is counted from then on.
        let mut weights = weights;
        weights.insert("binding_read".into(), 1.0);
        assert_eq!(billable(&raw, &weights), 415.0);
    }

    #[test]
    fn the_most_specific_rule_claims_a_line() {
        let rule = |product: &str, meter: &str, bucket: &str| Rule {
            product: product.into(),
            meter: meter.into(),
            bucket: bucket.into(),
            price_meter: None,
            own_meter: None,
            drift_percent: 10.0,
        };
        let rules = vec![rule("workers", "*", "platform"), rule("workers", "workers_for_platforms", "deployments"), rule("artifacts", "*", "git")];
        assert_eq!(classify(&rules, "workers", "workers_for_platforms_cpu_ms").unwrap().bucket, "deployments");
        assert_eq!(classify(&rules, "workers", "workers_cpu_ms").unwrap().bucket, "platform");
        assert_eq!(classify(&rules, "artifacts", "artifacts_operations").unwrap().bucket, "git");
        assert!(classify(&rules, "browser_rendering", "browser_hours").is_none());
    }
}
