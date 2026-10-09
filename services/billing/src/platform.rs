//! Platform spend guardrails: what Cloudflare counts for all of g1t, read
//! every hour, and a g1t-wide pause to stop it. See
//! docs/SPEND-GUARDRAILS.md.
//!
//! The caps in `budget` hold what g1t pays for agents and sandboxes; this
//! is about the platform underneath, which no workspace's limit covers and
//! Cloudflare never caps: Workers requests and CPU, D1 rows, Queue
//! operations, Durable Objects, KV and Artifacts. A loop in any of them is
//! otherwise found on the bill.
//!
//! - **The pause** (`platform_pause`): four independent levels, set by
//!   staff in sudo (Costs & margin, Platform pause) or by the watcher on a
//!   severe breach. `compute` refuses every reservation through `reserve`
//!   but embeddings; `indexing` refuses embeddings, and context's and
//!   search's backfills check it themselves; `schedules` stops Actions'
//!   cron runs and the runner's sweep; `renders` makes social cards a
//!   static image. Callers keep the answer 30 seconds in their isolate
//!   (`g1t_kit::pause`, `@g1t/contracts` `platformPaused`), and so does
//!   billing (`pause_now`): never a database read per request. When the
//!   flag cannot be read, nothing is paused: a pause is pulled on purpose,
//!   and a billing outage must not stop the platform with it.
//! - **The watcher** (`watch_platform`): at the quarter past each hour, the
//!   hour before and the month so far, from Cloudflare's GraphQL Analytics
//!   with the costs reconciliation's token (`CLOUDFLARE_BILLING_TOKEN`, else
//!   `CLOUDFLARE_USAGE_TOKEN`; Account Analytics Read). Each hour goes in
//!   `platform_usage` with the script, queue, database or namespace that
//!   counted most. A metric over its hourly threshold (`PLATFORM_HOURLY_*`),
//!   or over `PLATFORM_SPIKE_FACTOR` times the last week's median hour (and
//!   at least `PLATFORM_SPIKE_FLOOR_PERCENT` of its threshold), is a breach:
//!   staff are emailed (`COSTS_ALERT_EMAIL`, once per metric every 6
//!   hours) and sudo shows it. Over `PLATFORM_SEVERE_FACTOR` times its
//!   threshold, the levels that metric feeds are paused, of those
//!   `AUTO_PAUSE` allows (`schedules,indexing` unless set).
//!
//! A dataset GraphQL refuses (a field renamed, a dataset the token cannot
//! read) is logged and skipped; the others still count.

use std::cell::RefCell;
use std::collections::BTreeMap;

use futures_util::future::join_all;
use g1t_contracts::billing::{
    AdminSetPauseArgs, PauseLevel, PauseState, PlatformBreach, PlatformGuard, PlatformMetric, PlatformPause,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::{Env, Result};

use crate::Billing;
use crate::keeper::Keeper;

const HOUR_MS: u64 = 60 * 60 * 1000;
/// How long a pause read is kept in the isolate.
const KEEP_MS: u64 = 30_000;
/// A metric's breach is emailed at most this often.
const ALERT_EVERY_MS: u64 = 6 * HOUR_MS;
/// The spike rule needs this many hours of history first.
const SPIKE_MIN_HOURS: usize = 24;

thread_local! {
    static KEPT: RefCell<Option<(PlatformPause, u64)>> = const { RefCell::new(None) };
}

/// One metric the watcher reads, with its threshold's variable and the
/// pause levels it feeds.
pub(crate) struct Metric {
    pub key: &'static str,
    pub title: &'static str,
    /// `PLATFORM_HOURLY_<VAR>`.
    pub var: &'static str,
    /// The hourly threshold when the variable is not set: about a dollar
    /// to a few dollars an hour at Cloudflare's list prices, far above a
    /// small alpha's normal hour.
    pub default: f64,
    /// What kind of thing `top_name` is, for the alert.
    pub of: &'static str,
    /// The levels a severe breach may pause (of those `AUTO_PAUSE` allows).
    pub levels: &'static [PauseLevel],
}

use PauseLevel::{Compute, Indexing, Renders, Schedules};

pub(crate) const METRICS: &[Metric] = &[
    Metric { key: "workers_requests", title: "Workers requests", var: "WORKERS_REQUESTS", default: 20_000_000.0, of: "script", levels: &[Schedules, Indexing, Renders] },
    Metric { key: "workers_cpu_ms", title: "Workers CPU (ms)", var: "WORKERS_CPU_MS", default: 100_000_000.0, of: "script", levels: &[Schedules, Indexing, Renders] },
    Metric { key: "d1_rows_read", title: "D1 rows read", var: "D1_ROWS_READ", default: 2_000_000_000.0, of: "D1 database id", levels: &[Schedules, Indexing] },
    Metric { key: "d1_rows_written", title: "D1 rows written", var: "D1_ROWS_WRITTEN", default: 5_000_000.0, of: "D1 database id", levels: &[Schedules, Indexing] },
    Metric { key: "queue_operations", title: "Queue operations", var: "QUEUE_OPERATIONS", default: 5_000_000.0, of: "queue id", levels: &[Schedules, Indexing] },
    Metric { key: "do_requests", title: "Durable Object requests", var: "DO_REQUESTS", default: 20_000_000.0, of: "script", levels: &[Compute, Schedules] },
    Metric { key: "do_rows_written", title: "Durable Object rows written", var: "DO_ROWS_WRITTEN", default: 5_000_000.0, of: "Durable Object namespace id", levels: &[Compute, Schedules] },
    Metric { key: "do_storage_write_units", title: "Durable Object storage writes", var: "DO_STORAGE_WRITE_UNITS", default: 5_000_000.0, of: "Durable Object namespace id", levels: &[Compute, Schedules] },
    Metric { key: "do_active_seconds", title: "Durable Object active seconds", var: "DO_ACTIVE_SECONDS", default: 3_000_000.0, of: "Durable Object namespace id", levels: &[Compute, Schedules] },
    Metric { key: "kv_reads", title: "KV reads", var: "KV_READS", default: 10_000_000.0, of: "KV namespace id", levels: &[Indexing, Renders] },
    Metric { key: "kv_writes", title: "KV writes", var: "KV_WRITES", default: 200_000.0, of: "KV namespace id", levels: &[Indexing, Renders] },
    Metric { key: "kv_deletes", title: "KV deletes", var: "KV_DELETES", default: 200_000.0, of: "KV namespace id", levels: &[Indexing, Renders] },
    Metric { key: "kv_lists", title: "KV lists", var: "KV_LISTS", default: 200_000.0, of: "KV namespace id", levels: &[Indexing, Renders] },
    Metric { key: "artifacts_events", title: "Artifacts events", var: "ARTIFACTS_EVENTS", default: 1_000_000.0, of: "repository", levels: &[Compute, Schedules] },
];

pub(crate) fn metric(key: &str) -> Option<&'static Metric> {
    METRICS.iter().find(|m| m.key == key)
}

/// The watcher's numbers, from the billing service's variables.
#[derive(Clone, Debug)]
pub(crate) struct Watch {
    /// Each metric's hourly threshold; zero turns its threshold rule off.
    pub thresholds: BTreeMap<&'static str, f64>,
    /// `PLATFORM_SPIKE_FACTOR`: an hour above this many times the week's
    /// median hour is a spike. Zero: no spike rule.
    pub spike_factor: f64,
    /// `PLATFORM_SPIKE_FLOOR_PERCENT`: a spike must also be at least this
    /// share of the metric's threshold, so a quiet metric doubling is not one.
    pub spike_floor_percent: f64,
    /// `PLATFORM_SEVERE_FACTOR`: this many times the threshold pauses.
    pub severe_factor: f64,
    /// `AUTO_PAUSE`: the levels a severe breach may pause.
    pub auto_pause: Vec<PauseLevel>,
}

impl Watch {
    pub(crate) fn from_env(env: &Env) -> Self {
        let var = |name: &str| env.var(name).ok().map(|v| v.to_string());
        Watch::from_vars(var)
    }

    pub(crate) fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let number = |name: &str, default: f64| {
            var(name).and_then(|v| v.trim().replace('_', "").parse::<f64>().ok()).filter(|n| n.is_finite() && *n >= 0.0).unwrap_or(default)
        };
        let thresholds = METRICS.iter().map(|m| (m.key, number(&format!("PLATFORM_HOURLY_{}", m.var), m.default))).collect();
        let auto_pause = match var("AUTO_PAUSE") {
            Some(list) => list.split(',').filter_map(PauseLevel::parse).collect(),
            None => vec![Schedules, Indexing],
        };
        Watch {
            thresholds,
            spike_factor: number("PLATFORM_SPIKE_FACTOR", 10.0),
            spike_floor_percent: number("PLATFORM_SPIKE_FLOOR_PERCENT", 10.0),
            severe_factor: number("PLATFORM_SEVERE_FACTOR", 5.0).max(1.0),
            auto_pause,
        }
    }

    pub(crate) fn threshold(&self, key: &str) -> f64 {
        self.thresholds.get(key).copied().unwrap_or(0.0)
    }
}

// ---- The pause ------------------------------------------------------------

/// What a refused reservation is told while `level` is paused.
pub(crate) fn pause_refusal(level: PauseLevel) -> String {
    let what = match level {
        Compute => "new agent runs, checks, workflow jobs and builds",
        Indexing => "new indexing and semantic search embeddings",
        Schedules => "scheduled workflow runs and queued agents",
        Renders => "new social card images",
    };
    format!("g1t has paused {what} across the platform while it looks into unusual usage. Work already running finishes; try again later.")
}

/// The level a reservation of `kind` waits on.
pub(crate) fn level_for(kind: g1t_contracts::billing::ComputeKind) -> PauseLevel {
    if kind == g1t_contracts::billing::ComputeKind::Embedding { Indexing } else { Compute }
}

#[derive(Deserialize)]
struct PauseRow {
    level: String,
    paused: i64,
    note: Option<String>,
    set_by: Option<String>,
    set_at: Option<String>,
    auto: i64,
}

#[derive(Deserialize)]
struct UsageRow {
    metric: String,
    value: f64,
    top_name: Option<String>,
    top_value: Option<f64>,
}

#[derive(Deserialize)]
struct AlertRow {
    id: String,
    metric: String,
    hour: String,
    rule: String,
    value: f64,
    threshold: f64,
    severe: i64,
    top_name: Option<String>,
    detail: String,
    paused: Option<String>,
    opened_at: String,
    emailed_at: Option<String>,
}

impl Billing {
    async fn pause_rows(&self) -> Result<Vec<PauseRow>> {
        self.db.prepare("SELECT level, paused, note, set_by, set_at, auto FROM platform_pause").all().await?.results::<PauseRow>()
    }

    /// Every level, kept in the isolate for 30 seconds. Nothing paused
    /// when the table cannot be read.
    pub(crate) async fn pause_now(&self) -> PlatformPause {
        let now = now_ms();
        if let Some(pause) = KEPT.with(|kept| kept.borrow().filter(|(_, until)| *until > now).map(|(p, _)| p)) {
            return pause;
        }
        let pause = match self.pause_rows().await {
            Ok(rows) => {
                let mut pause = PlatformPause::default();
                for row in rows {
                    if let Some(level) = PauseLevel::parse(&row.level) {
                        pause.set(level, row.paused != 0);
                    }
                }
                pause
            }
            Err(error) => {
                worker::console_error!("platform pause unreadable, so nothing is paused: {error}");
                PlatformPause::default()
            }
        };
        KEPT.with(|kept| *kept.borrow_mut() = Some((pause, now + KEEP_MS)));
        pause
    }

    /// Why a reservation of `kind` is refused by a platform pause, if it is.
    pub(crate) async fn platform_refuses(&self, kind: g1t_contracts::billing::ComputeKind) -> Option<String> {
        let level = level_for(kind);
        self.pause_now().await.is(level).then(|| pause_refusal(level))
    }

    /// Pauses or resumes a level, and records who and why in the audit log.
    async fn set_pause(&self, level: PauseLevel, paused: bool, note: &str, by: &str, auto: bool) -> Result<()> {
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO platform_pause (level, paused, note, set_by, set_at, auto) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (level) DO UPDATE SET paused = ?2, note = ?3, set_by = ?4, set_at = ?5, auto = ?6",
            )
            .bind(&[level.as_str().into(), i32::from(paused).into(), note.into(), by.into(), now.as_str().into(), i32::from(auto).into()])?
            .run()
            .await?;
        KEPT.with(|kept| *kept.borrow_mut() = None);
        let action = if paused { "platform_paused" } else { "platform_resumed" };
        self.audit("costs", action, &format!("{}: {note}", level.as_str()), by).await
    }

    /// `admin_set_pause`: staff pause or resume one level, with why.
    pub(crate) async fn admin_set_pause(&self, a: AdminSetPauseArgs, keeper: &Keeper) -> Result<Outcome<PlatformGuard>> {
        let (by, note) = (a.by.trim(), a.note.trim());
        let Some(level) = PauseLevel::parse(&a.level) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Pick compute, schedules, indexing or renders."));
        };
        if by.is_empty() || note.chars().count() < 5 {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who is changing it, and why, in the note."));
        }
        let note: String = note.chars().take(500).collect();
        self.set_pause(level, a.paused, &note, by, false).await?;
        Ok(Outcome::Ok(self.platform_guard(keeper).await?))
    }

    /// `admin_platform_guard`: the pauses, the last hour, the month so far
    /// and the last day's breaches.
    pub(crate) async fn platform_guard(&self, keeper: &Keeper) -> Result<PlatformGuard> {
        let watch = Watch::from_env(&self.env);
        let rows = self.pause_rows().await?;
        let levels = PauseLevel::ALL
            .iter()
            .map(|level| match rows.iter().find(|r| r.level == level.as_str()) {
                Some(r) => PauseState {
                    level: r.level.clone(),
                    paused: r.paused != 0,
                    note: r.note.clone(),
                    set_by: r.set_by.clone(),
                    set_at: r.set_at.clone(),
                    auto: r.auto != 0,
                },
                None => PauseState { level: level.as_str().to_owned(), ..PauseState::default() },
            })
            .collect();
        #[derive(Deserialize)]
        struct Hour {
            hour: Option<String>,
        }
        let hour = self.db.prepare("SELECT MAX(hour) AS hour FROM platform_usage").first::<Hour>(None).await?.and_then(|h| h.hour);
        let to_metrics = |rows: Vec<UsageRow>| -> Vec<PlatformMetric> {
            METRICS
                .iter()
                .filter_map(|m| {
                    let row = rows.iter().find(|r| r.metric == m.key)?;
                    Some(PlatformMetric {
                        metric: m.key.to_owned(),
                        title: m.title.to_owned(),
                        value: row.value,
                        threshold: watch.threshold(m.key),
                        top_name: row.top_name.clone(),
                        top_value: row.top_value,
                    })
                })
                .collect()
        };
        let last_hour = match &hour {
            Some(hour) => to_metrics(
                self.db
                    .prepare("SELECT metric, value, top_name, top_value FROM platform_usage WHERE hour = ?")
                    .bind(&[hour.as_str().into()])?
                    .all()
                    .await?
                    .results::<UsageRow>()?,
            ),
            None => vec![],
        };
        let month = rfc3339(now_ms())[..7].to_owned();
        let month_to_date = to_metrics(
            self.db
                .prepare("SELECT metric, value, top_name, top_value FROM platform_usage_month WHERE month = ?")
                .bind(&[month.as_str().into()])?
                .all()
                .await?
                .results::<UsageRow>()?,
        );
        let breaches = self
            .db
            .prepare(
                "SELECT id, metric, hour, rule, value, threshold, severe, top_name, detail, paused, opened_at, emailed_at
                 FROM platform_alerts WHERE opened_at >= ? ORDER BY opened_at DESC LIMIT 50",
            )
            .bind(&[rfc3339(now_ms().saturating_sub(24 * HOUR_MS)).into()])?
            .all()
            .await?
            .results::<AlertRow>()?
            .into_iter()
            .map(|r| PlatformBreach {
                id: r.id,
                metric: r.metric,
                hour: r.hour,
                rule: r.rule,
                value: r.value,
                threshold: r.threshold,
                severe: r.severe != 0,
                top_name: r.top_name,
                detail: r.detail,
                paused: r.paused.map(|p| p.split(',').filter(|s| !s.is_empty()).map(str::to_owned).collect()).unwrap_or_default(),
                opened_at: r.opened_at,
                emailed_at: r.emailed_at,
            })
            .collect();
        Ok(PlatformGuard {
            levels,
            hour,
            last_hour,
            month,
            month_to_date,
            breaches,
            can_read: keeper.can_read_bill(),
            auto_pause: watch.auto_pause.iter().map(|l| l.as_str().to_owned()).collect(),
        })
    }
}

// ---- Reading Cloudflare's analytics ---------------------------------------

/// One GraphQL query: a dataset, what to sum, and what to group by.
pub(crate) struct Query {
    pub key: &'static str,
    pub dataset: &'static str,
    /// What the dataset is selected with: `sum { … }`, or `count`.
    pub select: &'static str,
    /// The dimension that names what counted (and `actionType` for KV).
    pub dimensions: &'static str,
    /// The filter fields for an hour: `datetime` (Time) on most datasets,
    /// `datetimeHour` on D1's.
    pub hour_filter: &'static str,
}

/// Each metric from its own query where a field is less certain, so one
/// GraphQL refuses does not take the others with it. Field names as
/// Cloudflare documents them; a refused one is logged and skipped.
pub(crate) const QUERIES: &[Query] = &[
    Query { key: "workers", dataset: "workersInvocationsAdaptive", select: "sum { requests }", dimensions: "scriptName", hour_filter: "datetime" },
    Query { key: "workers_cpu", dataset: "workersInvocationsAdaptive", select: "sum { cpuTimeUs }", dimensions: "scriptName", hour_filter: "datetime" },
    Query { key: "d1", dataset: "d1AnalyticsAdaptiveGroups", select: "sum { rowsRead rowsWritten }", dimensions: "databaseId", hour_filter: "datetimeHour" },
    Query { key: "queues", dataset: "queueMessageOperationsAdaptiveGroups", select: "sum { billableOperations }", dimensions: "queueId", hour_filter: "datetime" },
    Query { key: "do_invocations", dataset: "durableObjectsInvocationsAdaptiveGroups", select: "sum { requests }", dimensions: "scriptName", hour_filter: "datetime" },
    Query { key: "do_periodic", dataset: "durableObjectsPeriodicGroups", select: "sum { activeTime storageWriteUnits }", dimensions: "namespaceId", hour_filter: "datetime" },
    Query { key: "do_sql", dataset: "durableObjectsPeriodicGroups", select: "sum { rowsWritten }", dimensions: "namespaceId", hour_filter: "datetime" },
    Query { key: "kv", dataset: "kvOperationsAdaptiveGroups", select: "sum { requests }", dimensions: "namespaceId actionType", hour_filter: "datetime" },
    Query { key: "artifacts", dataset: "artifactsEventsAdaptiveGroups", select: "count", dimensions: "repositoryName", hour_filter: "datetime" },
];

/// A window to read: one hour (`Time` bounds) or days (`Date` bounds).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Window {
    Hour { since: String, until: String },
    Days { since: String, until: String },
}

/// The hour before the one `now` is in, `[since, until)`, as Cloudflare's
/// `Time` takes it.
pub(crate) fn last_hour(now: u64) -> Window {
    let until = now / HOUR_MS * HOUR_MS;
    Window::Hour { since: hour_label(until - HOUR_MS), until: hour_label(until) }
}

/// The month so far (UTC), today included.
pub(crate) fn month_so_far(now: u64) -> Window {
    let today = rfc3339(now)[..10].to_owned();
    Window::Days { since: format!("{}-01", &today[..7]), until: today }
}

/// `2026-10-08T13:00:00Z`.
pub(crate) fn hour_label(ms: u64) -> String {
    format!("{}:00:00Z", &rfc3339(ms)[..13])
}

/// The request body for `query` over `window`, its dataset aliased `rows`.
pub(crate) fn query_body(account: &str, query: &Query, window: &Window) -> Value {
    let (filter, kind, since, until) = match window {
        Window::Hour { since, until } => (format!("{f}_geq: $since, {f}_lt: $until", f = query.hour_filter), "Time", since, until),
        Window::Days { since, until } => ("date_geq: $since, date_leq: $until".to_owned(), "Date", since, until),
    };
    let text = format!(
        "query ($account: String!, $since: {kind}!, $until: {kind}!) {{
  viewer {{ accounts(filter: {{ accountTag: $account }}) {{
    rows: {dataset}(limit: 10000, filter: {{ {filter} }}) {{
      {select}
      dimensions {{ {dimensions} }}
    }}
  }} }}
}}",
        dataset = query.dataset,
        select = query.select,
        dimensions = query.dimensions,
    );
    json!({ "query": text, "variables": { "account": account, "since": since, "until": until } })
}

/// What one query counted, per metric: the total and each name's part.
pub(crate) type Counted = BTreeMap<&'static str, BTreeMap<String, f64>>;

/// A KV operation's metric, by its `actionType`.
fn kv_metric(action: &str) -> Option<&'static str> {
    match action.to_ascii_lowercase().as_str() {
        "read" | "get" => Some("kv_reads"),
        "write" | "put" => Some("kv_writes"),
        "delete" => Some("kv_deletes"),
        "list" => Some("kv_lists"),
        _ => None,
    }
}

/// Reads one query's answer into metrics. Errors when GraphQL does.
pub(crate) fn counted(query: &Query, body: &Value) -> std::result::Result<Counted, String> {
    if let Some(errors) = body["errors"].as_array().filter(|e| !e.is_empty()) {
        let messages: Vec<&str> = errors.iter().filter_map(|e| e["message"].as_str()).collect();
        return Err(format!("{} ({}): {}", query.dataset, query.key, messages.join("; ")));
    }
    let Some(groups) = body["data"]["viewer"]["accounts"][0]["rows"].as_array() else {
        return Err(format!("{} ({}): no rows in the answer", query.dataset, query.key));
    };
    let mut out: Counted = BTreeMap::new();
    let mut add = |metric: &'static str, name: &str, value: f64| {
        if value.is_finite() && value > 0.0 {
            *out.entry(metric).or_default().entry(name.to_owned()).or_default() += value;
        }
    };
    for g in groups {
        let sum = &g["sum"];
        let number = |field: &str| sum[field].as_f64().unwrap_or(0.0);
        let dims = &g["dimensions"];
        let name_of = |field: &str| dims[field].as_str().filter(|s| !s.is_empty()).unwrap_or("(unnamed)").to_owned();
        match query.key {
            "workers" => add("workers_requests", &name_of("scriptName"), number("requests")),
            "workers_cpu" => add("workers_cpu_ms", &name_of("scriptName"), number("cpuTimeUs") / 1000.0),
            "d1" => {
                let name = name_of("databaseId");
                add("d1_rows_read", &name, number("rowsRead"));
                add("d1_rows_written", &name, number("rowsWritten"));
            }
            "queues" => add("queue_operations", &name_of("queueId"), number("billableOperations")),
            "do_invocations" => add("do_requests", &name_of("scriptName"), number("requests")),
            "do_periodic" => {
                let name = name_of("namespaceId");
                // activeTime is in microseconds.
                add("do_active_seconds", &name, number("activeTime") / 1_000_000.0);
                add("do_storage_write_units", &name, number("storageWriteUnits"));
            }
            "do_sql" => add("do_rows_written", &name_of("namespaceId"), number("rowsWritten")),
            "kv" => {
                if let Some(metric) = dims["actionType"].as_str().and_then(kv_metric) {
                    add(metric, &name_of("namespaceId"), number("requests"));
                }
            }
            "artifacts" => add("artifacts_events", &name_of("repositoryName"), g["count"].as_f64().unwrap_or(0.0)),
            _ => {}
        }
    }
    Ok(out)
}

/// A metric's total, and the name that counted most.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Total {
    pub value: f64,
    pub top_name: Option<String>,
    pub top_value: Option<f64>,
}

/// Every query's answers merged into one total per metric.
pub(crate) fn totals(answers: &[Counted]) -> BTreeMap<&'static str, Total> {
    let mut merged: Counted = BTreeMap::new();
    for answer in answers {
        for (metric, names) in answer {
            let entry = merged.entry(metric).or_default();
            for (name, value) in names {
                *entry.entry(name.clone()).or_default() += value;
            }
        }
    }
    merged
        .into_iter()
        .map(|(metric, names)| {
            let value = names.values().sum();
            let top = names.into_iter().max_by(|a, b| a.1.total_cmp(&b.1));
            (metric, Total { value, top_name: top.as_ref().map(|t| t.0.clone()), top_value: top.map(|t| t.1) })
        })
        .collect()
}

// ---- Deciding what is a breach --------------------------------------------

/// The middle of the week's hours (the mean of the middle two when even).
pub(crate) fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 0 { (values[mid - 1] + values[mid]) / 2.0 } else { values[mid] })
}

/// A breach of one metric, before it is recorded.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Breach {
    pub metric: &'static str,
    /// `threshold` or `spike`.
    pub rule: &'static str,
    pub value: f64,
    /// What it was held to: the threshold, or the spike's line.
    pub limit: f64,
    pub severe: bool,
}

/// Whether an hour's `value` of `metric` is a breach, given the week's
/// earlier hours (`history`). The threshold rule wins over the spike rule.
pub(crate) fn judge(watch: &Watch, metric: &'static str, value: f64, history: &[f64]) -> Option<Breach> {
    let threshold = watch.threshold(metric);
    if threshold > 0.0 && value > threshold {
        return Some(Breach { metric, rule: "threshold", value, limit: threshold, severe: value >= threshold * watch.severe_factor });
    }
    if watch.spike_factor <= 0.0 || history.len() < SPIKE_MIN_HOURS {
        return None;
    }
    let mut week = history.to_vec();
    let usual = median(&mut week)?;
    let line = usual * watch.spike_factor;
    let floor = threshold * watch.spike_floor_percent / 100.0;
    // A metric with no threshold never spikes: there is no floor to hold it to.
    (threshold > 0.0 && value > line && value >= floor).then_some(Breach { metric, rule: "spike", value, limit: line, severe: false })
}

/// The levels a severe breach of `metric` pauses: those it feeds that
/// `AUTO_PAUSE` allows.
pub(crate) fn levels_to_pause(watch: &Watch, breach: &Breach) -> Vec<PauseLevel> {
    if !breach.severe {
        return vec![];
    }
    metric(breach.metric).map_or(vec![], |m| m.levels.iter().copied().filter(|l| watch.auto_pause.contains(l)).collect())
}

/// `20,000,000`, or `1.5` for small fractions.
pub(crate) fn amount(n: f64) -> String {
    if n.fract().abs() > 0.0 && n.abs() < 100.0 {
        return format!("{n:.1}");
    }
    let digits = format!("{:.0}", n.abs());
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0.0 { format!("-{out}") } else { out }
}

/// The sentence an alert and sudo carry for a breach.
pub(crate) fn describe(breach: &Breach, hour: &str, top: Option<(&str, f64)>) -> String {
    let m = metric(breach.metric);
    let title = m.map_or(breach.metric, |m| m.title);
    let of = m.map_or("source", |m| m.of);
    let what = match breach.rule {
        "spike" => format!("more than its spike line of {} (the last week's usual hour times PLATFORM_SPIKE_FACTOR)", amount(breach.limit)),
        _ => format!(
            "over its hourly threshold of {} (PLATFORM_HOURLY_{})",
            amount(breach.limit),
            m.map_or("?", |m| m.var)
        ),
    };
    let mut text = format!("{title}: {} in the hour from {hour}, {what}.", amount(breach.value));
    if let Some((name, value)) = top {
        text.push_str(&format!(" Most of it from the {of} {name} ({}).", amount(value)));
    }
    text
}

/// Whether the quarter-hour tick at `now` is the hour's watch: the one at
/// a quarter past, when the hour before is in Cloudflare's analytics.
pub(crate) fn hourly_due(now: u64) -> bool {
    let minute = now / 60_000 % 60;
    (15..30).contains(&minute)
}

impl Billing {
    /// Each hour: the hour before and the month so far, from Cloudflare,
    /// kept and judged; staff emailed and levels paused on a breach.
    /// Returns how many metrics were read and how many breached.
    pub(crate) async fn watch_platform(&self, keeper: &Keeper) -> Result<(usize, usize)> {
        if !keeper.can_read_bill() {
            worker::console_log!("platform watch: no Cloudflare token with Account Analytics Read, so nothing is read");
            return Ok((0, 0));
        }
        let now = now_ms();
        let watch = Watch::from_env(&self.env);
        let hour_window = last_hour(now);
        let month_window = month_so_far(now);
        let Window::Hour { since: hour, .. } = &hour_window else { unreachable!() };
        let hour = hour.clone();
        let month = rfc3339(now)[..7].to_owned();
        let read = |window: &Window| {
            join_all(QUERIES.iter().map(|query| {
                let body = query_body(keeper.account(), query, window);
                async move {
                    match keeper.graphql(body).await {
                        Ok(answer) => counted(query, &answer),
                        Err(error) => Err(format!("{} ({}): {error}", query.dataset, query.key)),
                    }
                }
            }))
        };
        let (hour_answers, month_answers) = futures_util::future::join(read(&hour_window), read(&month_window)).await;
        let keep = |answers: Vec<std::result::Result<Counted, String>>| {
            answers
                .into_iter()
                .filter_map(|answer| answer.map_err(|error| worker::console_error!("platform watch: skipped {error}")).ok())
                .collect::<Vec<_>>()
        };
        let hourly = totals(&keep(hour_answers));
        let monthly = totals(&keep(month_answers));
        let read_at = rfc3339(now);
        let mut writes = vec![];
        for (table, period, values) in [("platform_usage", "hour", &hourly), ("platform_usage_month", "month", &monthly)] {
            let key = if period == "hour" { hour.as_str() } else { month.as_str() };
            for (metric, total) in values.iter() {
                writes.push(
                    self.db
                        .prepare(format!(
                            "INSERT INTO {table} ({period}, metric, value, top_name, top_value, read_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                             ON CONFLICT ({period}, metric) DO UPDATE SET value = ?3, top_name = ?4, top_value = ?5, read_at = ?6"
                        ))
                        .bind(&[
                            key.into(),
                            (*metric).into(),
                            total.value.into(),
                            crate::optional(total.top_name.as_deref()),
                            total.top_value.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                            read_at.as_str().into(),
                        ])?,
                );
            }
        }
        if !writes.is_empty() {
            self.db.batch(writes).await?;
        }
        // The week before this hour, for the spike rule.
        #[derive(Deserialize)]
        struct Past {
            metric: String,
            value: f64,
        }
        let past = self
            .db
            .prepare("SELECT metric, value FROM platform_usage WHERE hour >= ? AND hour < ?")
            .bind(&[hour_label(now / HOUR_MS * HOUR_MS - 8 * 24 * HOUR_MS).into(), hour.as_str().into()])?
            .all()
            .await?
            .results::<Past>()?;
        let mut breaches = vec![];
        for (metric, total) in &hourly {
            let history: Vec<f64> = past.iter().filter(|p| p.metric == *metric).map(|p| p.value).collect();
            if let Some(breach) = judge(&watch, metric, total.value, &history) {
                breaches.push((breach, total.clone()));
            }
        }
        let found = breaches.len();
        if found > 0 {
            self.on_breaches(&watch, &hour, breaches).await?;
        }
        Ok((hourly.len(), found))
    }

    /// Records each breach, pauses what a severe one should, and emails
    /// staff about the metrics not emailed in the last 6 hours.
    async fn on_breaches(&self, watch: &Watch, hour: &str, breaches: Vec<(Breach, Total)>) -> Result<()> {
        let now = now_ms();
        let opened_at = rfc3339(now);
        let current = self.pause_now().await;
        let mut lines = vec![];
        let mut ids = vec![];
        let mut paused_now: Vec<PauseLevel> = vec![];
        for (breach, total) in breaches {
            let top = total.top_name.as_deref().zip(total.top_value);
            let mut detail = describe(&breach, hour, top);
            let pause: Vec<PauseLevel> =
                levels_to_pause(watch, &breach).into_iter().filter(|l| !current.is(*l) && !paused_now.contains(l)).collect();
            for level in &pause {
                self.set_pause(*level, true, &format!("Automatic: {detail}"), "g1t-billing's usage watcher", true).await?;
                paused_now.push(*level);
            }
            if !pause.is_empty() {
                let names: Vec<&str> = pause.iter().map(|l| l.as_str()).collect();
                detail.push_str(&format!(" Severe (over {}× the threshold): paused {}.", amount(watch.severe_factor), names.join(" and ")));
            }
            let id = new_id("pal", now);
            let paused_text = pause.iter().map(|l| l.as_str()).collect::<Vec<_>>().join(",");
            self.db
                .prepare(
                    "INSERT INTO platform_alerts (id, metric, hour, rule, value, threshold, severe, top_name, top_value, detail, paused, opened_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&[
                    id.as_str().into(),
                    breach.metric.into(),
                    hour.into(),
                    breach.rule.into(),
                    breach.value.into(),
                    breach.limit.into(),
                    i32::from(breach.severe).into(),
                    crate::optional(total.top_name.as_deref()),
                    total.top_value.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                    detail.as_str().into(),
                    crate::optional(Some(paused_text.as_str()).filter(|t| !t.is_empty())),
                    opened_at.as_str().into(),
                ])?
                .run()
                .await?;
            // Emailed at most once per metric every 6 hours; a new pause is
            // always said.
            #[derive(Deserialize)]
            struct Last {
                at: Option<String>,
            }
            let last = self
                .db
                .prepare("SELECT MAX(emailed_at) AS at FROM platform_alerts WHERE metric = ? AND emailed_at >= ?")
                .bind(&[breach.metric.into(), rfc3339(now.saturating_sub(ALERT_EVERY_MS)).into()])?
                .first::<Last>(None)
                .await?
                .and_then(|l| l.at);
            if last.is_none() || !pause.is_empty() {
                lines.push(detail);
                ids.push(id);
            }
        }
        let alert_to = &self.caps.alert_to;
        if lines.is_empty() || alert_to.is_empty() {
            return Ok(());
        }
        let subject = if paused_now.is_empty() {
            format!("g1t: platform usage breach in the hour from {hour}")
        } else {
            let names: Vec<&str> = paused_now.iter().map(|l| l.as_str()).collect();
            format!("g1t: platform usage breach, {} paused", names.join(" and "))
        };
        lines.push(
            "Ids are Cloudflare's: `node scripts/ops/platform-usage.mjs` names them and shows the last 24 hours. To pause or resume a level: sudo, Costs & margin, Platform pause. Thresholds: PLATFORM_HOURLY_* in services/billing/wrangler.jsonc. See docs/SPEND-GUARDRAILS.md.".to_owned(),
        );
        match crate::margin::email_staff_page(&self.env, alert_to, &subject, &lines, ("Platform pause", "https://sudo.g1t.sh/costs#platform"), "g1t-billing's usage watcher").await {
            Ok(()) => {
                let at = rfc3339(now_ms());
                for id in ids {
                    self.db.prepare("UPDATE platform_alerts SET emailed_at = ? WHERE id = ?").bind(&[at.as_str().into(), id.as_str().into()])?.run().await?;
                }
            }
            Err(error) => worker::console_error!("could not email the platform usage breach: {error}"),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> Watch {
        Watch::from_vars(|_| None)
    }

    #[test]
    fn every_metric_has_a_threshold_and_a_query_that_counts_it() {
        let w = watch();
        for m in METRICS {
            assert!(w.threshold(m.key) > 0.0, "{}", m.key);
        }
        // The thresholds named in docs/SPEND-GUARDRAILS.md.
        assert_eq!(w.threshold("kv_lists"), 200_000.0);
        assert_eq!(w.threshold("queue_operations"), 5_000_000.0);
        assert_eq!(w.threshold("d1_rows_read"), 2_000_000_000.0);
        assert_eq!(w.threshold("do_rows_written"), 5_000_000.0);
        assert_eq!(w.threshold("workers_requests"), 20_000_000.0);
        assert_eq!(w.auto_pause, vec![Schedules, Indexing]);
    }

    #[test]
    fn variables_change_thresholds_and_auto_pause() {
        let w = Watch::from_vars(|name| match name {
            "PLATFORM_HOURLY_KV_LISTS" => Some("50_000".into()),
            "PLATFORM_HOURLY_D1_ROWS_READ" => Some("0".into()),
            "AUTO_PAUSE" => Some("compute, renders,nonsense".into()),
            "PLATFORM_SEVERE_FACTOR" => Some("0.5".into()),
            _ => None,
        });
        assert_eq!(w.threshold("kv_lists"), 50_000.0);
        assert_eq!(w.threshold("d1_rows_read"), 0.0);
        assert_eq!(w.auto_pause, vec![Compute, Renders]);
        // Never below the threshold itself.
        assert_eq!(w.severe_factor, 1.0);
        // Empty: nothing pauses by itself.
        assert!(Watch::from_vars(|n| (n == "AUTO_PAUSE").then(String::new)).auto_pause.is_empty());
    }

    #[test]
    fn the_hour_read_is_the_one_before_at_a_quarter_past() {
        // 2026-10-08 13:17:00 UTC.
        let now = 1_791_465_420_000;
        assert_eq!(rfc3339(now), "2026-10-08T13:17:00.000Z");
        assert!(hourly_due(now));
        assert!(!hourly_due(now - 15 * 60_000));
        assert!(!hourly_due(now + 15 * 60_000));
        assert_eq!(last_hour(now), Window::Hour { since: "2026-10-08T12:00:00Z".into(), until: "2026-10-08T13:00:00Z".into() });
        assert_eq!(month_so_far(now), Window::Days { since: "2026-10-01".into(), until: "2026-10-08".into() });
    }

    #[test]
    fn queries_alias_their_dataset_and_filter_by_the_window() {
        let d1 = QUERIES.iter().find(|q| q.key == "d1").unwrap();
        let hour = query_body("acct", d1, &last_hour(1_791_465_420_000));
        let text = hour["query"].as_str().unwrap();
        assert!(text.contains("rows: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetimeHour_geq: $since, datetimeHour_lt: $until })"), "{text}");
        assert!(text.contains("$since: Time!") && text.contains("sum { rowsRead rowsWritten }") && text.contains("dimensions { databaseId }"));
        assert_eq!(hour["variables"]["since"], "2026-10-08T12:00:00Z");
        let month = query_body("acct", d1, &month_so_far(1_791_465_420_000));
        let text = month["query"].as_str().unwrap();
        assert!(text.contains("date_geq: $since, date_leq: $until") && text.contains("$since: Date!"), "{text}");
    }

    fn answer(rows: Value) -> Value {
        json!({ "data": { "viewer": { "accounts": [{ "rows": rows }] } }, "errors": null })
    }

    fn query(key: &str) -> &'static Query {
        QUERIES.iter().find(|q| q.key == key).unwrap()
    }

    #[test]
    fn answers_become_metrics_by_name_and_a_refused_dataset_is_skipped() {
        let kv = counted(
            query("kv"),
            &answer(json!([
                { "sum": { "requests": 150000 }, "dimensions": { "namespaceId": "ns_a", "actionType": "list" } },
                { "sum": { "requests": 90000 }, "dimensions": { "namespaceId": "ns_b", "actionType": "list" } },
                { "sum": { "requests": 4000 }, "dimensions": { "namespaceId": "ns_a", "actionType": "read" } },
                { "sum": { "requests": 7 }, "dimensions": { "namespaceId": "ns_a", "actionType": "mystery" } },
            ])),
        )
        .unwrap();
        let d1 = counted(query("d1"), &answer(json!([{ "sum": { "rowsRead": 10.0, "rowsWritten": 2.0 }, "dimensions": { "databaseId": "db1" } }]))).unwrap();
        let cpu = counted(query("workers_cpu"), &answer(json!([{ "sum": { "cpuTimeUs": 5_000_000 }, "dimensions": { "scriptName": "g1t-web" } }]))).unwrap();
        let refused = counted(query("do_sql"), &json!({ "data": null, "errors": [{ "message": "unknown field rowsWritten" }] }));
        assert!(refused.unwrap_err().contains("unknown field rowsWritten"));
        assert!(counted(query("queues"), &json!({ "data": { "viewer": { "accounts": [] } } })).is_err());
        let all = totals(&[kv, d1, cpu]);
        assert_eq!(all["kv_lists"], Total { value: 240_000.0, top_name: Some("ns_a".into()), top_value: Some(150_000.0) });
        assert_eq!(all["kv_reads"].value, 4_000.0);
        assert_eq!(all["d1_rows_written"].value, 2.0);
        assert_eq!(all["workers_cpu_ms"].value, 5_000.0);
        assert!(!all.contains_key("do_rows_written"));
    }

    #[test]
    fn over_the_threshold_is_a_breach_and_five_times_it_is_severe() {
        let w = watch();
        assert_eq!(judge(&w, "kv_lists", 200_000.0, &[]), None);
        let breach = judge(&w, "kv_lists", 240_000.0, &[]).unwrap();
        assert_eq!((breach.rule, breach.severe), ("threshold", false));
        assert!(levels_to_pause(&w, &breach).is_empty());
        let severe = judge(&w, "kv_lists", 1_000_000.0, &[]).unwrap();
        assert!(severe.severe);
        // KV feeds indexing and renders; AUTO_PAUSE allows indexing only.
        assert_eq!(levels_to_pause(&w, &severe), vec![Indexing]);
        // Durable Objects feed compute, which is never paused by itself by default.
        let dos = judge(&w, "do_rows_written", 30_000_000.0, &[]).unwrap();
        assert_eq!(levels_to_pause(&w, &dos), vec![Schedules]);
    }

    #[test]
    fn a_spike_is_ten_times_the_weeks_usual_hour_above_a_floor() {
        let w = watch();
        let quiet = vec![1_000.0; 168];
        // Ten times the usual hour, but under 10% of the 5M threshold: not one.
        assert_eq!(judge(&w, "queue_operations", 20_000.0, &quiet), None);
        let usual = vec![60_000.0; 168];
        let spike = judge(&w, "queue_operations", 700_000.0, &usual).unwrap();
        assert_eq!((spike.rule, spike.limit, spike.severe), ("spike", 600_000.0, false));
        assert_eq!(judge(&w, "queue_operations", 590_000.0, &usual), None);
        // Under a day of history: no spike rule yet.
        assert_eq!(judge(&w, "queue_operations", 700_000.0, &usual[..23]), None);
        assert_eq!(median(&mut [3.0, 1.0, 2.0, 10.0]), Some(2.5));
        assert_eq!(median(&mut []), None);
    }

    #[test]
    fn an_alert_names_where_to_look() {
        let breach = Breach { metric: "kv_lists", rule: "threshold", value: 1_250_000.0, limit: 200_000.0, severe: true };
        let text = describe(&breach, "2026-10-08T12:00:00Z", Some(("e627b571", 1_200_000.0)));
        assert_eq!(
            text,
            "KV lists: 1,250,000 in the hour from 2026-10-08T12:00:00Z, over its hourly threshold of 200,000 (PLATFORM_HOURLY_KV_LISTS). Most of it from the KV namespace id e627b571 (1,200,000)."
        );
        assert_eq!(amount(1.5), "1.5");
        assert_eq!(amount(5.0), "5");
    }

    #[test]
    fn a_pause_refuses_the_level_a_reservation_waits_on() {
        use g1t_contracts::billing::ComputeKind;
        assert_eq!(level_for(ComputeKind::Embedding), Indexing);
        for kind in [ComputeKind::Agent, ComputeKind::Check, ComputeKind::Workflow, ComputeKind::Queue, ComputeKind::Deploy] {
            assert_eq!(level_for(kind), Compute);
        }
        assert!(pause_refusal(Compute).contains("Work already running finishes"));
        assert_eq!(PauseLevel::parse(" indexing "), Some(Indexing));
        assert_eq!(PauseLevel::parse("everything"), None);
    }
}
