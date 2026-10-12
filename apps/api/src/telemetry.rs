//! Observability over REST and MCP: what a project's running software did,
//! as requests, logs, traces, errors and metrics, and how it is collected
//! (settings, ingest tokens and exports).
//!
//! The telemetry service keeps each project's store and checks nothing:
//! this resolves the project through the projects service and decides
//! first, as the site does. Reading takes a role of the viewer's own on
//! the project's repository (logs and request addresses can hold private
//! data, so a public repository is not enough); resolving and ignoring
//! errors takes Triage; settings, ingest tokens, exports and usage take
//! Admin (`manage_integrations`). Anyone who may not read is told there is
//! no such project.

use g1t_contracts::access::{self, Capability, RepoRef};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Map, Value, json};
use worker::{Headers, Method, Request, RequestInit, Result};

use crate::operations::Services;

/// One operation on a project's observability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelemetryOp {
    GetOverview,
    ListRequests,
    GetRequest,
    ListLogs,
    ListTraces,
    GetTrace,
    ListErrors,
    UpdateError,
    ListMetrics,
    GetMetric,
    GetSettings,
    UpdateSettings,
    ListTokens,
    CreateToken,
    DeleteToken,
    ListExports,
    CreateExport,
    UpdateExport,
    DeleteExport,
    GetUsage,
}

/// Log levels, as the telemetry service groups them.
const SEVERITIES: [&str; 6] = ["trace", "debug", "info", "warn", "error", "fatal"];
/// An error group's states.
const ERROR_STATES: [&str; 3] = ["open", "resolved", "ignored"];
/// What a metric's values in a step may be reduced to.
const AGGREGATES: [&str; 7] = ["avg", "sum", "min", "max", "p50", "p95", "p99"];
/// The signals an export may send.
const SIGNALS: [&str; 3] = ["traces", "logs", "metrics"];
/// Retention a project can choose, in days (`RETENTION_CHOICES` in @g1t/contracts).
const RETENTION_DAYS: [u64; 5] = [1, 3, 7, 14, 30];

/// Fields keyed by what the software sent (OpenTelemetry attributes and
/// resources), passed through as they are rather than put in `snake_case`.
pub const AS_GIVEN: &[&str] = &["attributes", "resource"];

/// What an operation needs of the viewer on the project's repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Need {
    /// A role of their own: a member, a collaborator, or the workspace's token.
    Insider,
    Can(Capability),
}

impl TelemetryOp {
    /// Every one: `Op::ALL` lists each as `Op::Telemetry(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [TelemetryOp; 20] = [
        TelemetryOp::GetOverview,
        TelemetryOp::ListRequests,
        TelemetryOp::GetRequest,
        TelemetryOp::ListLogs,
        TelemetryOp::ListTraces,
        TelemetryOp::GetTrace,
        TelemetryOp::ListErrors,
        TelemetryOp::UpdateError,
        TelemetryOp::ListMetrics,
        TelemetryOp::GetMetric,
        TelemetryOp::GetSettings,
        TelemetryOp::UpdateSettings,
        TelemetryOp::ListTokens,
        TelemetryOp::CreateToken,
        TelemetryOp::DeleteToken,
        TelemetryOp::ListExports,
        TelemetryOp::CreateExport,
        TelemetryOp::UpdateExport,
        TelemetryOp::DeleteExport,
        TelemetryOp::GetUsage,
    ];

    pub fn name(self) -> &'static str {
        match self {
            TelemetryOp::GetOverview => "get_observability_overview",
            TelemetryOp::ListRequests => "list_requests",
            TelemetryOp::GetRequest => "get_request",
            TelemetryOp::ListLogs => "list_logs",
            TelemetryOp::ListTraces => "list_traces",
            TelemetryOp::GetTrace => "get_trace",
            TelemetryOp::ListErrors => "list_errors",
            TelemetryOp::UpdateError => "update_error",
            TelemetryOp::ListMetrics => "list_metrics",
            TelemetryOp::GetMetric => "get_metric",
            TelemetryOp::GetSettings => "get_observability_settings",
            TelemetryOp::UpdateSettings => "update_observability_settings",
            TelemetryOp::ListTokens => "list_ingest_tokens",
            TelemetryOp::CreateToken => "create_ingest_token",
            TelemetryOp::DeleteToken => "delete_ingest_token",
            TelemetryOp::ListExports => "list_telemetry_exports",
            TelemetryOp::CreateExport => "create_telemetry_export",
            TelemetryOp::UpdateExport => "update_telemetry_export",
            TelemetryOp::DeleteExport => "delete_telemetry_export",
            TelemetryOp::GetUsage => "get_observability_usage",
        }
    }

    /// For the API reference: "List logs".
    pub fn title(self) -> &'static str {
        match self {
            TelemetryOp::GetOverview => "Get a project's observability overview",
            TelemetryOp::ListRequests => "List requests",
            TelemetryOp::GetRequest => "Get a request",
            TelemetryOp::ListLogs => "List logs",
            TelemetryOp::ListTraces => "List traces",
            TelemetryOp::GetTrace => "Get a trace",
            TelemetryOp::ListErrors => "List errors",
            TelemetryOp::UpdateError => "Update an error",
            TelemetryOp::ListMetrics => "List metrics",
            TelemetryOp::GetMetric => "Get a metric",
            TelemetryOp::GetSettings => "Get observability settings",
            TelemetryOp::UpdateSettings => "Update observability settings",
            TelemetryOp::ListTokens => "List ingest tokens",
            TelemetryOp::CreateToken => "Create an ingest token",
            TelemetryOp::DeleteToken => "Delete an ingest token",
            TelemetryOp::ListExports => "List telemetry exports",
            TelemetryOp::CreateExport => "Create a telemetry export",
            TelemetryOp::UpdateExport => "Update a telemetry export",
            TelemetryOp::DeleteExport => "Delete a telemetry export",
            TelemetryOp::GetUsage => "Get observability usage",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            TelemetryOp::GetOverview => "A project's numbers over a period (the last 24 hours unless you say): totals (requests, errors, error_rate, and latency and CPU percentiles p50, p75, p95 and p99 in milliseconds) and the same for the period before it, to compare; points, one per step (step_s seconds), with requests, errors, counts by status class and percentiles; routes, by requests; deployments, each one's numbers newest first, so a regression points at the deployment it began with; services and regions. from and to are RFC 3339 times or Unix milliseconds. Narrow it by environment, service or deployment_id. Needs a role on the project's repository.",
            TelemetryOp::ListRequests => "The requests (and other invocations) a project's software answered, newest first: each with its method, url, route (ids taken out), status, outcome, duration_us, cpu_ms, region, trace_id, log_count, error, and where it came from (service, environment, deployment_id, commit_sha, source). Apps on g1t.page send them with nothing to set up; software elsewhere, as OpenTelemetry server spans. Filter by words in q, status (2xx, 3xx, 4xx, 5xx or a status, comma-separated), errors_only (a 5xx or an outcome other than ok), route, min_duration_ms, environment, service and deployment_id, between from and to. A page holds limit; pass next back as cursor for the next. Needs a role on the project's repository.",
            TelemetryOp::GetRequest => "One request by id, with every log line it wrote, oldest first. Needs a role on the project's repository.",
            TelemetryOp::ListLogs => "Search a project's logs, newest first. q finds lines holding all of its words, or a phrase in quotes. level narrows to levels (trace, debug, info, warn, error, fatal, comma-separated); trace_id and request_id to one trace's or one request's lines; environment, service and deployment_id to where they ran; from and to to a period. Each line has its time_us, severity, body, attributes, trace_id, span_id and request_id. A page holds limit; pass next back as cursor for the next. Needs a role on the project's repository.",
            TelemetryOp::ListTraces => "A project's traces, newest first: each its root span's name, start_us, duration_us, span_count, error_count, the services it crossed and its HTTP status. Filter by words in q, errors_only, min_duration_ms, environment and service, between from and to. A page holds limit; pass next back as cursor for the next. Needs a role on the project's repository.",
            TelemetryOp::GetTrace => "One trace by its id (32 hex characters): every span, with its parent, kind, timing, status, attributes, resource, events and links, and the log lines written under it. Needs a role on the project's repository.",
            TelemetryOp::ListErrors => "A project's errors, grouped: the same exception (its name, its message with numbers and ids taken out, and the top frame of its stack) is one group, with its count, first and last time seen, the deployment it was first seen on (what likely brought it in), its last request and trace, its state (open, resolved or ignored) and the issue made for it. Most recently seen first, at most 200. Filter by state, environment and service, between from and to. Needs a role on the project's repository.",
            TelemetryOp::UpdateError => "Resolve, ignore or reopen an error group (state), or link it to the issue made for it (issue_number; null unlinks it). A resolved group that happens again opens again. Needs the Triage role or higher.",
            TelemetryOp::ListMetrics => "The metrics a project's software has sent: each with its name, kind (gauge, sum, histogram or summary), unit, description, the services that send it and when it last did. Needs a role on the project's repository.",
            TelemetryOp::GetMetric => "One metric over time, one value per step: gauges averaged in each step (or min or max), sums added (a cumulative sum becomes its increase), histograms their mean or a percentile (p50, p95, p99) from their buckets. group_by splits it into a series per value of an attribute (or service). The last 24 hours unless from and to say. Needs a role on the project's repository.",
            TelemetryOp::GetSettings => "How long a project's requests, logs and spans are kept (retention_days; charts are kept longer, as per-minute counts) and whether its apps on g1t.page send telemetry (deployments). Needs the Admin role.",
            TelemetryOp::UpdateSettings => "Change how long a project's telemetry is kept (retention_days: 1, 3, 7, 14 or 30) and whether its apps on g1t.page send it (deployments; off keeps the tokens and history). Only what you give changes. Needs the Admin role.",
            TelemetryOp::ListTokens => "A project's ingest tokens, which OpenTelemetry SDKs and collectors send with: each its name, hint (its first characters), who made it, when, and when it was last used. managed marks the one g1t made for its own deployments, which people cannot delete. Secrets are never returned. Needs the Admin role.",
            TelemetryOp::CreateToken => "Make an ingest token for a project. Returns token and secret: the secret is shown this once, so keep it. Send it as `Authorization: Bearer <secret>` (or `x-g1t-token`) with OTLP over HTTP to the project's endpoint. Needs the Admin role.",
            TelemetryOp::DeleteToken => "Delete an ingest token: what sends with it is refused from then on. The token g1t made for its own deployments cannot be deleted. Needs the Admin role.",
            TelemetryOp::ListExports => "Where a project's telemetry is also sent as it arrives: each export's name, OTLP/HTTP endpoint, signals (traces, logs, metrics), header_names (values are never returned), whether it is enabled, and its last error and send. Needs the Admin role.",
            TelemetryOp::CreateExport => "Send a project's telemetry on to any OTLP/HTTP endpoint as it arrives: a collector, or a vendor that takes OTLP. signals are traces, logs (requests go as log records) and metrics, all three unless you say; headers are sent with each request, such as an API key, and are written, never read back. Needs the Admin role.",
            TelemetryOp::UpdateExport => "Change an export: its name, endpoint, signals and whether it is enabled. Only what you give changes. Headers given are set; a header given as \"\" is removed; those not given are kept. Needs the Admin role.",
            TelemetryOp::DeleteExport => "Stop sending a project's telemetry to an export. Needs the Admin role.",
            TelemetryOp::GetUsage => "What a project has sent and kept this month: ingested_bytes (what ingest is metered by), requests, logs, spans, metric_points and stored_bytes. Needs the Admin role.",
        }
    }

    /// Whether it changes anything.
    pub fn writes(self) -> bool {
        matches!(
            self,
            TelemetryOp::UpdateError
                | TelemetryOp::UpdateSettings
                | TelemetryOp::CreateToken
                | TelemetryOp::DeleteToken
                | TelemetryOp::CreateExport
                | TelemetryOp::UpdateExport
                | TelemetryOp::DeleteExport
        )
    }

    fn need(self) -> Need {
        match self {
            TelemetryOp::UpdateError => Need::Can(Capability::Triage),
            TelemetryOp::GetSettings
            | TelemetryOp::UpdateSettings
            | TelemetryOp::ListTokens
            | TelemetryOp::CreateToken
            | TelemetryOp::DeleteToken
            | TelemetryOp::ListExports
            | TelemetryOp::CreateExport
            | TelemetryOp::UpdateExport
            | TelemetryOp::DeleteExport
            | TelemetryOp::GetUsage => Need::Can(Capability::ManageIntegrations),
            _ => Need::Insider,
        }
    }

    pub fn input(self) -> Value {
        let text = |what: &str| json!({ "type": "string", "description": what });
        let integer = |what: &str| json!({ "type": "integer", "description": what });
        let mut properties = Map::new();
        properties.insert("workspace".into(), text("The workspace's slug, e.g. \"flagon-io\"."));
        properties.insert("project".into(), text("The project's slug, as in g1t.sh/{workspace}/{project}."));
        let mut required = vec!["workspace", "project"];
        let mut add = |name: &str, schema: Value| {
            properties.insert(name.to_owned(), schema);
        };
        let period = |add: &mut dyn FnMut(&str, Value)| {
            add("from", text("The start of the period: an RFC 3339 time or Unix milliseconds. 24 hours before `to` unless you say."));
            add("to", text("The end of the period: an RFC 3339 time or Unix milliseconds. Now unless you say."));
        };
        let place = |add: &mut dyn FnMut(&str, Value)| {
            add("environment", text("Only what ran in this environment, such as production or preview; several comma-separated."));
            add("service", text("Only what this service sent (OpenTelemetry's service.name; an app on g1t.page is its project's name); several comma-separated."));
        };
        let page = |add: &mut dyn FnMut(&str, Value)| {
            add("cursor", text("Where to carry on from: the last page's `next`."));
            add("limit", integer("How many a page holds."));
        };
        let words = "Words to find, all of them, or a phrase in quotes.";
        match self {
            TelemetryOp::GetOverview => {
                period(&mut add);
                place(&mut add);
                add("deployment_id", text("Only this deployment's (dpl_…)."));
                add("step", integer("Seconds per point of the charts; chosen from the period unless you say."));
            }
            TelemetryOp::ListRequests => {
                period(&mut add);
                add("q", text(words));
                add("status", text("Only these statuses: 2xx, 3xx, 4xx, 5xx or a status such as 404, comma-separated."));
                add("errors_only", json!({ "type": "boolean", "description": "Only those that failed: a 5xx, or an outcome other than ok." }));
                add("route", text("Only this route, as the list shows it, such as /users/:id."));
                add("min_duration_ms", integer("Only those that took at least this many milliseconds."));
                place(&mut add);
                add("deployment_id", text("Only this deployment's (dpl_…)."));
                page(&mut add);
            }
            TelemetryOp::GetRequest => {
                add("id", text("The request's id."));
                required.push("id");
            }
            TelemetryOp::ListLogs => {
                period(&mut add);
                add("q", text(words));
                add("level", json!({ "type": "string", "description": "Only these levels: trace, debug, info, warn, error or fatal, comma-separated." }));
                add("trace_id", text("Only the lines written under this trace."));
                add("request_id", text("Only the lines this request wrote."));
                place(&mut add);
                add("deployment_id", text("Only this deployment's (dpl_…)."));
                page(&mut add);
            }
            TelemetryOp::ListTraces => {
                period(&mut add);
                add("q", text(words));
                add("errors_only", json!({ "type": "boolean", "description": "Only traces with a span that failed." }));
                add("min_duration_ms", integer("Only traces that took at least this many milliseconds."));
                place(&mut add);
                page(&mut add);
            }
            TelemetryOp::GetTrace => {
                add("trace_id", text("The trace's id, 32 hex characters."));
                required.push("trace_id");
            }
            TelemetryOp::ListErrors => {
                add("state", json!({ "type": "string", "enum": ERROR_STATES, "description": "Only groups in this state." }));
                place(&mut add);
                period(&mut add);
            }
            TelemetryOp::UpdateError => {
                add("fingerprint", text("The error group's fingerprint, as list_errors gives it."));
                add("state", json!({ "type": "string", "enum": ERROR_STATES, "description": "Its state now: resolved, ignored, or open again." }));
                add("issue_number", json!({ "type": ["integer", "null"], "description": "The issue made for it; null unlinks it." }));
                required.push("fingerprint");
            }
            TelemetryOp::ListMetrics
            | TelemetryOp::GetSettings
            | TelemetryOp::ListTokens
            | TelemetryOp::ListExports
            | TelemetryOp::GetUsage => {}
            TelemetryOp::GetMetric => {
                add("metric", text("The metric's name, such as http.server.request.duration."));
                required.push("metric");
                period(&mut add);
                add("aggregate", json!({ "type": "string", "enum": AGGREGATES, "description": "How each step's values are reduced: avg for gauges and sum for sums unless you say; a percentile for histograms." }));
                add("group_by", text("An attribute (or service) to split it into a series per value."));
                add("step", integer("Seconds per point; chosen from the period unless you say."));
                place(&mut add);
            }
            TelemetryOp::UpdateSettings => {
                add("retention_days", json!({ "type": "integer", "enum": RETENTION_DAYS, "description": "Days requests, logs and spans are kept." }));
                add("deployments", json!({ "type": "boolean", "description": "Whether the project's apps on g1t.page send telemetry." }));
            }
            TelemetryOp::CreateToken => {
                add("name", text("What it is for, such as the machine or collector that sends with it."));
                required.push("name");
            }
            TelemetryOp::DeleteToken => {
                add("id", text("The token's id."));
                required.push("id");
            }
            TelemetryOp::CreateExport | TelemetryOp::UpdateExport => {
                if self == TelemetryOp::UpdateExport {
                    add("id", text("The export's id."));
                    required.push("id");
                } else {
                    required.extend(["name", "endpoint"]);
                }
                add("name", text("Its name, for people."));
                add("endpoint", text("The OTLP/HTTP base address, such as https://otlp.example.com; /v1/traces and the rest are added."));
                add("signals", json!({ "type": "array", "items": { "type": "string", "enum": SIGNALS }, "description": "What it sends: traces, logs and metrics. All three unless you say." }));
                add("headers", json!({ "type": "object", "additionalProperties": { "type": "string" }, "description": "Headers sent with each request, such as an API key. Written, never read back; \"\" removes one." }));
                add("enabled", json!({ "type": "boolean", "description": "Whether it sends. True unless you say." }));
            }
            TelemetryOp::DeleteExport => {
                add("id", text("The export's id."));
                required.push("id");
            }
        }
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

/// A non-empty string field, trimmed.
fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

/// A number given as a number or as text.
fn number(input: &Value, key: &str) -> std::result::Result<Option<u64>, String> {
    match &input[key] {
        Value::Null => Ok(None),
        Value::Number(number) => number.as_u64().map(Some).ok_or_else(|| format!("{key} must be a whole number.")),
        Value::String(digits) if digits.trim().is_empty() => Ok(None),
        Value::String(digits) => digits.trim().parse().map(Some).map_err(|_| format!("{key} must be a whole number.")),
        _ => Err(format!("{key} must be a whole number.")),
    }
}

/// A flag given as a boolean or as text.
fn flag(input: &Value, key: &str) -> std::result::Result<Option<bool>, String> {
    match &input[key] {
        Value::Null => Ok(None),
        Value::Bool(value) => Ok(Some(*value)),
        Value::String(text) => match text.trim() {
            "" => Ok(None),
            "true" | "1" => Ok(Some(true)),
            "false" | "0" => Ok(Some(false)),
            _ => Err(format!("{key} is true or false.")),
        },
        _ => Err(format!("{key} is true or false.")),
    }
}

/// A list given as an array or as comma-separated text.
fn list(input: &Value, key: &str) -> Vec<String> {
    match &input[key] {
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned).collect(),
        Value::String(text) => text.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned).collect(),
        _ => Vec::new(),
    }
}

/// A time as microseconds since the epoch, from Unix milliseconds or an
/// RFC 3339 time, in UTC (`Z`) or with an offset (`+02:00`).
pub(crate) fn micros(given: &Value) -> Option<u64> {
    let text = match given {
        Value::Number(number) => return number.as_u64().map(|ms| ms * 1000),
        Value::String(text) => text.trim(),
        _ => return None,
    };
    if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
        return text.parse::<u64>().ok().map(|ms| ms * 1000);
    }
    if let Some(ms) = g1t_contracts::time::parse_rfc3339(text) {
        return Some(ms * 1000);
    }
    // An offset: the time there, less the offset, is UTC.
    let at = text.len().checked_sub(6)?;
    let (local, offset) = text.split_at(at);
    let sign: i64 = match offset.as_bytes().first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return None,
    };
    let (hours, minutes) = offset[1..].split_once(':')?;
    let shift = sign * (hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().ok()?) * 60_000;
    let ms = g1t_contracts::time::parse_rfc3339(&format!("{local}Z"))? as i64 - shift;
    u64::try_from(ms).ok().map(|ms| ms * 1000)
}

/// The period and the place every list narrows by, in the service's names.
fn filter(input: &Value, out: &mut Map<String, Value>) -> std::result::Result<(), String> {
    for (key, field) in [("from", "from_us"), ("to", "to_us")] {
        let given = &input[key];
        if given.is_null() || given.as_str().is_some_and(|text| text.trim().is_empty()) {
            continue;
        }
        let at = micros(given).ok_or_else(|| format!("{key} must be an RFC 3339 time or Unix milliseconds."))?;
        out.insert(field.into(), at.into());
    }
    for (key, field) in [("environment", "environments"), ("service", "services")] {
        let values = list(input, key);
        if !values.is_empty() {
            out.insert(field.into(), json!(values));
        }
    }
    Ok(())
}

/// The arguments the telemetry service takes for `op`, from the
/// operation's input, without the project; `Err` says what is missing or
/// wrong. `actor` is who makes a token.
pub(crate) fn args(op: TelemetryOp, input: &Value, actor: Option<&str>) -> std::result::Result<(&'static str, Map<String, Value>), String> {
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, keys: &[(&str, &str)]| {
        for (key, field) in keys {
            if let Some(value) = text(input, key) {
                out.insert((*field).to_owned(), value.into());
            }
        }
    };
    let page = |out: &mut Map<String, Value>| -> std::result::Result<(), String> {
        copy(out, &[("cursor", "cursor")]);
        if let Some(limit) = number(input, "limit")? {
            out.insert("limit".into(), limit.into());
        }
        Ok(())
    };
    let required = |key: &str, what: &str| text(input, key).ok_or_else(|| format!("Give {what}."));
    let method = match op {
        TelemetryOp::GetOverview => {
            filter(input, &mut out)?;
            copy(&mut out, &[("deployment_id", "deployment_id")]);
            if let Some(step) = number(input, "step")? {
                out.insert("step_s".into(), step.into());
            }
            "overview"
        }
        TelemetryOp::ListRequests => {
            filter(input, &mut out)?;
            copy(&mut out, &[("q", "text"), ("route", "route"), ("deployment_id", "deployment_id")]);
            let status = list(input, "status");
            if !status.is_empty() {
                out.insert("status".into(), json!(status));
            }
            if let Some(errors) = flag(input, "errors_only")? {
                out.insert("errors_only".into(), errors.into());
            }
            if let Some(ms) = number(input, "min_duration_ms")? {
                out.insert("min_duration_ms".into(), ms.into());
            }
            page(&mut out)?;
            "requests"
        }
        TelemetryOp::GetRequest => {
            out.insert("id".into(), required("id", "the request's id")?.into());
            "request"
        }
        TelemetryOp::ListLogs => {
            filter(input, &mut out)?;
            copy(&mut out, &[("q", "text"), ("trace_id", "trace_id"), ("request_id", "request_id"), ("deployment_id", "deployment_id")]);
            let levels: Vec<String> = list(input, "level").into_iter().map(|level| level.to_lowercase()).collect();
            if let Some(unknown) = levels.iter().find(|level| !SEVERITIES.contains(&level.as_str())) {
                return Err(format!("{unknown} is not a level: use trace, debug, info, warn, error or fatal."));
            }
            if !levels.is_empty() {
                out.insert("severities".into(), json!(levels));
            }
            page(&mut out)?;
            "logs"
        }
        TelemetryOp::ListTraces => {
            filter(input, &mut out)?;
            copy(&mut out, &[("q", "text")]);
            if let Some(errors) = flag(input, "errors_only")? {
                out.insert("errors_only".into(), errors.into());
            }
            if let Some(ms) = number(input, "min_duration_ms")? {
                out.insert("min_duration_ms".into(), ms.into());
            }
            page(&mut out)?;
            "traces"
        }
        TelemetryOp::GetTrace => {
            out.insert("trace_id".into(), required("trace_id", "the trace's id")?.to_lowercase().into());
            "trace"
        }
        TelemetryOp::ListErrors => {
            filter(input, &mut out)?;
            if let Some(state) = text(input, "state") {
                if !ERROR_STATES.contains(&state.as_str()) {
                    return Err(format!("{state} is not a state: use open, resolved or ignored."));
                }
                out.insert("state".into(), state.into());
            }
            "errors"
        }
        TelemetryOp::UpdateError => {
            out.insert("fingerprint".into(), required("fingerprint", "the error group's fingerprint")?.into());
            if let Some(state) = text(input, "state") {
                if !ERROR_STATES.contains(&state.as_str()) {
                    return Err(format!("{state} is not a state: use open, resolved or ignored."));
                }
                out.insert("state".into(), state.into());
            }
            match input.get("issue_number") {
                None => {}
                Some(Value::Null) => {
                    out.insert("issue_number".into(), Value::Null);
                }
                Some(_) => {
                    let issue = number(input, "issue_number")?.ok_or("issue_number must be a whole number, or null.")?;
                    out.insert("issue_number".into(), issue.into());
                }
            }
            if !out.contains_key("state") && !out.contains_key("issue_number") {
                return Err("Give a state, or an issue_number.".to_owned());
            }
            "set_error"
        }
        TelemetryOp::ListMetrics => "metrics",
        TelemetryOp::GetMetric => {
            out.insert("name".into(), required("metric", "the metric's name")?.into());
            filter(input, &mut out)?;
            if let Some(aggregate) = text(input, "aggregate") {
                if !AGGREGATES.contains(&aggregate.as_str()) {
                    return Err(format!("{aggregate} is not an aggregate: use avg, sum, min, max, p50, p95 or p99."));
                }
                out.insert("aggregate".into(), aggregate.into());
            }
            copy(&mut out, &[("group_by", "group_by")]);
            if let Some(step) = number(input, "step")? {
                out.insert("step_s".into(), step.into());
            }
            "metric"
        }
        TelemetryOp::GetSettings => "settings",
        TelemetryOp::UpdateSettings => {
            if let Some(days) = number(input, "retention_days")? {
                if !RETENTION_DAYS.contains(&days) {
                    return Err("retention_days is 1, 3, 7, 14 or 30.".to_owned());
                }
                out.insert("retention_days".into(), days.into());
            }
            if let Some(on) = flag(input, "deployments")? {
                out.insert("deployments".into(), on.into());
            }
            "set_settings"
        }
        TelemetryOp::ListTokens => "tokens",
        TelemetryOp::CreateToken => {
            out.insert("name".into(), required("name", "the token a name")?.into());
            out.insert("created_by".into(), actor.map_or(Value::Null, Value::from));
            "create_token"
        }
        TelemetryOp::DeleteToken => {
            out.insert("id".into(), required("id", "the token's id")?.into());
            "revoke_token"
        }
        TelemetryOp::ListExports => "exports",
        TelemetryOp::CreateExport | TelemetryOp::UpdateExport => {
            if op == TelemetryOp::UpdateExport {
                out.insert("id".into(), required("id", "the export's id")?.into());
            } else {
                required("name", "the export a name")?;
                required("endpoint", "the endpoint to send to")?;
            }
            copy(&mut out, &[("name", "name"), ("endpoint", "endpoint")]);
            if !input["signals"].is_null() {
                let signals = list(input, "signals");
                if let Some(unknown) = signals.iter().find(|signal| !SIGNALS.contains(&signal.as_str())) {
                    return Err(format!("{unknown} is not a signal: use traces, logs or metrics."));
                }
                out.insert("signals".into(), json!(signals));
            }
            match &input["headers"] {
                Value::Null => {}
                Value::Object(headers) => {
                    let mut sent = Map::new();
                    for (name, value) in headers {
                        let value = value.as_str().ok_or_else(|| format!("The header {name} must be text."))?;
                        sent.insert(name.trim().to_owned(), value.into());
                    }
                    out.insert("headers".into(), Value::Object(sent));
                }
                _ => return Err("headers must be an object of names and values.".to_owned()),
            }
            if let Some(enabled) = flag(input, "enabled")? {
                out.insert("enabled".into(), enabled.into());
            }
            "put_export"
        }
        TelemetryOp::DeleteExport => {
            out.insert("id".into(), required("id", "the export's id")?.into());
            "delete_export"
        }
        TelemetryOp::GetUsage => "usage",
    };
    Ok((method, out))
}

/// Calls the telemetry service: its answer, or its refusal of a bad
/// argument (`400`, in words) as invalid.
async fn ask(services: &Services, method: &str, args: &Value) -> Result<Outcome<Value>> {
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(serde_json::to_string(args)?.into()));
    let request = Request::new_with_init(&format!("https://service/rpc/{method}"), &init)?;
    let mut response = services.telemetry.fetch_request(request).await?;
    let text = response.text().await.unwrap_or_default();
    match response.status_code() {
        200 => Ok(Outcome::Ok(g1t_kit::read_answer(method, &text)?)),
        400 => Ok(Outcome::fail(FailureCode::Invalid, text.trim())),
        status => Err(worker::Error::RustError(format!("telemetry {method} failed with status {status}: {text}"))),
    }
}

/// The repository a project's permission comes from, as the deployments
/// service reads it: a project without a hosted source has none, and its
/// workspace's base permission decides.
fn repo_of(project: &Value) -> (String, String, bool) {
    let source = &project["source"];
    let private = project["private"].as_bool().unwrap_or(true);
    if source["kind"] == "hosted" {
        (
            source["repoId"].as_str().unwrap_or_default().to_owned(),
            source["repo"]["namespace"].as_str().unwrap_or_default().to_owned(),
            private,
        )
    } else {
        (String::new(), project["workspace"].as_str().unwrap_or_default().to_owned(), private)
    }
}

/// Whether the viewer may do what `need` says on the project; otherwise
/// the refusal.
fn allowed(viewer: &Viewer, project: &Value, need: Need) -> std::result::Result<(), Outcome<Value>> {
    let (id, namespace, private) = repo_of(project);
    let repo = RepoRef { id: &id, namespace: &namespace, private };
    let user = viewer.as_ref();
    if !user.is_some_and(|user| access::granted(user, repo).is_some()) {
        return Err(Outcome::fail(FailureCode::NotFound, "There is no such project."));
    }
    if let Need::Can(capability) = need
        && !access::can(user, repo, capability)
    {
        let name = format!("{}/{}", project["workspace"].as_str().unwrap_or_default(), project["slug"].as_str().unwrap_or_default());
        return Err(Outcome::fail(FailureCode::Forbidden, access::needs(capability, &name)));
    }
    Ok(())
}

pub async fn run(op: TelemetryOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let slug = |key: &str| text(input, key).map(|value| value.to_lowercase());
    let (Some(workspace), Some(slug)) = (slug("workspace"), slug("project")) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the workspace's slug and the project's."));
    };
    let Some(user) = viewer else {
        let what = if op.writes() { "Changing" } else { "Reading" };
        return Ok(Outcome::fail(FailureCode::Unauthenticated, format!("{what} a project's observability needs a g1t access token.")));
    };
    let (method, mut args) = match args(op, input, Some(&user.username)) {
        Ok(found) => found,
        Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
    };
    let found: Outcome<Value> =
        g1t_kit::call(&services.projects, "get", &json!({ "workspace": workspace, "slug": slug, "viewer": viewer })).await?;
    let project = match found {
        Outcome::Ok(project) => project,
        Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
    };
    if let Err(refused) = allowed(viewer, &project, op.need()) {
        return Ok(refused);
    }
    let Some(project_id) = project["id"].as_str() else {
        return Ok(Outcome::fail(FailureCode::NotFound, "There is no such project."));
    };
    args.insert("project_id".into(), project_id.into());

    // A change to an export names only what changes: the rest is as it is.
    if op == TelemetryOp::UpdateExport {
        let listed = ask(services, "exports", &json!({ "project_id": project_id })).await?;
        let Outcome::Ok(Value::Array(exports)) = listed else {
            return Ok(listed);
        };
        let Some(current) = exports.iter().find(|export| export["id"] == args["id"]) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "The project has no export with that id."));
        };
        for key in ["name", "endpoint", "signals", "enabled"] {
            if !args.contains_key(key) {
                args.insert(key.into(), current[key].clone());
            }
        }
    }
    if op == TelemetryOp::CreateExport {
        args.entry("signals").or_insert_with(|| json!(SIGNALS));
        args.entry("enabled").or_insert(Value::Bool(true));
    }

    let answered = ask(services, method, &Value::Object(args)).await?;
    // Nothing found answers null, and deleting nothing false.
    let missing = match op {
        TelemetryOp::GetRequest => Some("The project has no request with that id."),
        TelemetryOp::GetTrace => Some("The project has no trace with that id."),
        TelemetryOp::UpdateError => Some("The project has no error with that fingerprint."),
        TelemetryOp::DeleteToken => Some("The project has no ingest token with that id that people can delete."),
        TelemetryOp::DeleteExport => Some("The project has no export with that id."),
        _ => None,
    };
    Ok(match (answered, missing) {
        (Outcome::Ok(Value::Null | Value::Bool(false)), Some(message)) => Outcome::fail(FailureCode::NotFound, message),
        (answered, _) => answered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_becomes_the_services_arguments() {
        let (method, args) = super::args(
            TelemetryOp::ListLogs,
            &json!({ "workspace": "acme", "project": "web", "q": "timeout", "level": "Error,warn", "environment": "production", "from": "1790918179000", "limit": "50", "ignored": 1 }),
            None,
        )
        .unwrap();
        assert_eq!(method, "logs");
        assert_eq!(args["text"], json!("timeout"));
        assert_eq!(args["severities"], json!(["error", "warn"]));
        assert_eq!(args["environments"], json!(["production"]));
        assert_eq!(args["from_us"], json!(1_790_918_179_000_000u64));
        assert_eq!(args["limit"], json!(50));
        assert!(!args.contains_key("ignored") && !args.contains_key("workspace"));
        assert!(super::args(TelemetryOp::ListLogs, &json!({ "level": "loud" }), None).is_err());
        assert!(super::args(TelemetryOp::ListLogs, &json!({ "from": "yesterday" }), None).is_err());

        let (method, args) = super::args(
            TelemetryOp::ListRequests,
            &json!({ "status": "5xx,404", "errors_only": "true", "min_duration_ms": 250, "service": "api" }),
            None,
        )
        .unwrap();
        assert_eq!(method, "requests");
        assert_eq!((args["status"].clone(), args["errors_only"].clone(), args["min_duration_ms"].clone()), (json!(["5xx", "404"]), json!(true), json!(250)));
        assert_eq!(args["services"], json!(["api"]));

        let (method, args) = super::args(TelemetryOp::GetMetric, &json!({ "metric": "http.server.request.duration", "aggregate": "p95", "step": "60" }), None).unwrap();
        assert_eq!((method, args["name"].clone(), args["step_s"].clone()), ("metric", json!("http.server.request.duration"), json!(60)));
        assert!(super::args(TelemetryOp::GetMetric, &json!({ "metric": "x", "aggregate": "median" }), None).is_err());
    }

    #[test]
    fn changes_say_only_what_they_change() {
        let (method, args) = super::args(TelemetryOp::UpdateError, &json!({ "fingerprint": "f1", "issue_number": null }), None).unwrap();
        assert_eq!(method, "set_error");
        assert_eq!(args.get("issue_number"), Some(&Value::Null), "null unlinks the issue");
        assert!(!args.contains_key("state"));
        assert!(super::args(TelemetryOp::UpdateError, &json!({ "fingerprint": "f1" }), None).is_err());
        assert!(super::args(TelemetryOp::UpdateError, &json!({ "fingerprint": "f1", "state": "fixed" }), None).is_err());
        assert!(super::args(TelemetryOp::UpdateSettings, &json!({ "retention_days": 5 }), None).is_err());
        let (method, args) = super::args(TelemetryOp::CreateToken, &json!({ "name": "laptop" }), Some("ada")).unwrap();
        assert_eq!((method, args["created_by"].clone()), ("create_token", json!("ada")));
        let (method, args) = super::args(TelemetryOp::UpdateExport, &json!({ "id": "e1", "headers": { "x-api-key": "" } }), None).unwrap();
        assert_eq!(method, "put_export");
        assert_eq!(args["headers"], json!({ "x-api-key": "" }));
        assert!(!args.contains_key("signals"));
        assert!(super::args(TelemetryOp::CreateExport, &json!({ "name": "vendor" }), None).is_err());
        assert!(super::args(TelemetryOp::CreateExport, &json!({ "name": "v", "endpoint": "https://x", "signals": ["spans"] }), None).is_err());
    }

    #[test]
    fn times_are_milliseconds_or_rfc_3339() {
        assert_eq!(micros(&json!(1_790_918_179_000u64)), Some(1_790_918_179_000_000));
        assert_eq!(micros(&json!("2026-10-02T05:16:19Z")), Some(1_790_918_179_000_000));
        assert_eq!(micros(&json!("2026-10-02T07:16:19+02:00")), Some(1_790_918_179_000_000));
        assert_eq!(micros(&json!("2026-10-02T00:16:19.500-05:00")), Some(1_790_918_179_500_000));
        assert_eq!(micros(&json!("soon")), None);
    }

    #[test]
    fn reading_takes_a_role_of_ones_own() {
        use g1t_contracts::User;
        let project = json!({
            "id": "prj_1", "workspace": "acme", "slug": "web", "private": false,
            "source": { "kind": "hosted", "repoId": "repo_1", "repo": { "namespace": "acme", "name": "web" } },
        });
        let person = |username: &str, membership: Value| -> Viewer {
            let mut user = User { username: username.into(), ..User::default() };
            if !membership.is_null() {
                user.workspaces = vec![serde_json::from_value(membership).unwrap()];
            }
            Some(user)
        };
        let refused = |viewer: &Viewer, need: Need| match allowed(viewer, &project, need) {
            Err(Outcome::Fail(failure)) => Some(failure.code),
            _ => None,
        };
        // A public project's telemetry is not public.
        assert_eq!(refused(&person("eve", Value::Null), Need::Insider), Some(FailureCode::NotFound));
        assert_eq!(refused(&None, Need::Insider), Some(FailureCode::NotFound));
        let reader = person("ada", json!({ "slug": "acme", "role": "member", "base_permission": "read" }));
        assert_eq!(refused(&reader, Need::Insider), None);
        assert_eq!(refused(&reader, TelemetryOp::UpdateError.need()), Some(FailureCode::Forbidden));
        let writer = person("bo", json!({ "slug": "acme", "role": "member" }));
        assert_eq!(refused(&writer, TelemetryOp::UpdateError.need()), None);
        assert_eq!(refused(&writer, TelemetryOp::ListTokens.need()), Some(FailureCode::Forbidden));
        let owner = person("ana", json!({ "slug": "acme", "role": "owner" }));
        for op in TelemetryOp::ALL {
            assert_eq!(refused(&owner, op.need()), None, "{}", op.name());
        }
        assert_eq!(TelemetryOp::GetSettings.need(), Need::Can(Capability::ManageIntegrations));
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in TelemetryOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Telemetry(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            let required = op.input()["required"].as_array().unwrap().clone();
            assert!(required.contains(&json!("workspace")) && required.contains(&json!("project")), "{}", op.name());
            for field in required {
                assert!(op.input()["properties"].get(field.as_str().unwrap()).is_some(), "{}: {field}", op.name());
            }
        }
    }
}
