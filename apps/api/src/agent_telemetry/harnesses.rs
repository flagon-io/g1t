//! What each coding agent's OpenTelemetry says a session used, read from
//! the few events and metrics that carry it. Everything else a harness
//! sends is passed over unread: its prompts (`user_prompt`,
//! `codex.user_prompt`), responses (`assistant_response`,
//! `codex.agent_response`, Gemini CLI's `response_text`), tool input and
//! output (`tool_result`, `codex.tool_result`), request and response
//! bodies, and Cursor's `conversation.*` messages. Only counts, costs, a
//! model, ids and a repository's name leave this module.
//!
//! As each harness documents it (checked 2026-10-22):
//!
//! - Claude Code (https://code.claude.com/docs/en/monitoring-usage): the
//!   `claude_code.api_request` event (`event.name` `api_request`) with
//!   `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
//!   `cache_creation_tokens` and `cost_usd`; the metrics
//!   `claude_code.token.usage` (`type` input, output, cacheRead,
//!   cacheCreation) and `claude_code.cost.usage`. Session: `session.id`.
//!   Repository: `vcs.repository.*`, with
//!   `OTEL_METRICS_INCLUDE_REPOSITORY=true`.
//! - Codex (https://learn.chatgpt.com/docs/config-file/config-advanced and
//!   codex-rs/otel): `codex.sse_event` of kind `response.completed` with
//!   `input_token_count` (cached and cache-written tokens included),
//!   `cached_token_count`, `cache_write_token_count` and
//!   `output_token_count`; `codex.turn_cost` with `usage.estimated_usd`;
//!   the counter `codex.turn.cost_microusd`. Session: `conversation.id`.
//! - Cursor (https://cursor.com/docs/enterprise/opentelemetry-export/wire):
//!   the `api_request` log (named in its body) with
//!   `cursor.api.request.input_tokens`, `.output_tokens`,
//!   `.cache_read_tokens`, `.cache_creation_tokens` and `cursor.model.name`;
//!   `cursor.token.usage` and `cursor.cost.usage`, used when a point names
//!   its conversation. Session: `cursor.conversation.id`; person:
//!   `cursor.user.email`.
//! - Gemini CLI (google-gemini/gemini-cli docs/cli/telemetry.md):
//!   `gemini_cli.api_response` with `input_token_count` (cached tokens
//!   included), `cached_content_token_count`, `output_token_count`,
//!   `thoughts_token_count` (billed as output) and `tool_token_count`
//!   (billed as input); the metric `gemini_cli.token.usage` (`type` input,
//!   output, thought, cache, tool). Session: `session.id`.
//! - GitHub Copilot in VS Code
//!   (https://code.visualstudio.com/docs/agents/guides/monitoring-agents):
//!   the histogram `gen_ai.client.token.usage` (`gen_ai.token.type` input
//!   or output, `gen_ai.response.model` or `gen_ai.request.model`).
//!   Session: the resource's `session.id`, VS Code's.

use std::collections::BTreeMap;

use g1t_contracts::model_prices::{MAX_USAGE_TOKENS, ModelUsage};
use g1t_contracts::work::{Harness, TelemetrySignal, TelemetryUsage};

use super::wire::{AnyValue, Attributes, LogRecord, ResourceLogs, ResourceMetrics, Temporality, attribute};

/// The resource attribute that names the g1t repository a harness works
/// in, as `owner/name` (`OTEL_RESOURCE_ATTRIBUTES=g1t.repository=…`).
pub const REPOSITORY_ATTRIBUTE: &str = "g1t.repository";

/// What one request says one harness session used.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub harness: Harness,
    pub harness_session_id: String,
    /// The address the records name: whose session it is for a workspace
    /// token, through an address they verified. A person's own token
    /// never reads it.
    pub email: Option<String>,
    pub signal: TelemetrySignal,
    pub cumulative: bool,
    pub usage: Vec<TelemetryUsage>,
    pub repo: Option<String>,
    /// The latest record's time, in nanoseconds since 1970 (0: none said).
    pub seen_unix_nano: u64,
    /// How many records or points it came from.
    pub records: u64,
}

impl Found {
    /// The model it used most, if any.
    pub fn model(&self) -> Option<String> {
        self.usage
            .iter()
            .filter(|one| !one.usage.model.is_empty())
            .max_by_key(|one| tokens(&one.usage))
            .map(|one| one.usage.model.clone())
    }
}

fn tokens(usage: &ModelUsage) -> u64 {
    [usage.input_tokens, usage.output_tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens, usage.cache_read_tokens]
        .into_iter()
        .fold(0u64, u64::saturating_add)
}

/// Gemini CLI's harness, by the name the work service knows it by, or
/// `other` where it has none.
fn gemini() -> Harness {
    Harness::parse("gemini").or_else(|| Harness::parse("gemini_cli")).unwrap_or(Harness::Other)
}

/// The harness a resource's records come from: by its `service.name`, or
/// the prefix of the record's or metric's name.
fn harness_of(resource: &Attributes, name: &str) -> Option<Harness> {
    let service = attribute(resource, "service.name").and_then(AnyValue::text).unwrap_or_default().to_ascii_lowercase();
    if service.starts_with("claude-code") || name.starts_with("claude_code.") {
        Some(Harness::ClaudeCode)
    } else if service.starts_with("codex") || name.starts_with("codex.") {
        Some(Harness::Codex)
    } else if service == "cursor" || name.starts_with("cursor.") {
        Some(Harness::Cursor)
    } else if service.starts_with("gemini") || name.starts_with("gemini_cli.") {
        Some(gemini())
    } else if service.contains("copilot") {
        Some(Harness::Copilot)
    } else {
        None
    }
}

/// An attribute of a record or point, else of its resource.
fn lookup<'a>(own: &'a Attributes, resource: &'a Attributes, key: &str) -> Option<&'a AnyValue> {
    attribute(own, key).or_else(|| attribute(resource, key))
}

fn text_of(own: &Attributes, resource: &Attributes, key: &str) -> Option<String> {
    lookup(own, resource, key).and_then(AnyValue::text).map(|text| text.trim().to_owned()).filter(|text| !text.is_empty())
}

/// A count as kept: a whole number of tokens, from 0 to [`MAX_USAGE_TOKENS`].
fn count_of(own: &Attributes, resource: &Attributes, key: &str) -> u64 {
    lookup(own, resource, key).and_then(AnyValue::number).map_or(0, |n| n.clamp(0.0, MAX_USAGE_TOKENS as f64) as u64)
}

fn cost_of(own: &Attributes, resource: &Attributes, key: &str) -> Option<f64> {
    lookup(own, resource, key).and_then(AnyValue::number).filter(|n| *n >= 0.0)
}

/// The repository the attributes name, as `owner/name`: g1t's own
/// attribute, else Claude Code's `vcs.owner.name` and
/// `vcs.repository.name`, else the last two parts of
/// `vcs.repository.url.full`.
fn repo_of(own: &Attributes, resource: &Attributes) -> Option<String> {
    if let Some(named) = text_of(own, resource, REPOSITORY_ATTRIBUTE) {
        return Some(named);
    }
    if let (Some(owner), Some(name)) = (text_of(own, resource, "vcs.owner.name"), text_of(own, resource, "vcs.repository.name")) {
        return Some(format!("{owner}/{name}"));
    }
    let url = text_of(own, resource, "vcs.repository.url.full")?;
    let path = url.trim_end_matches('/').trim_end_matches(".git");
    // `https://host/owner/name` or `git@host:owner/name`.
    let path = path.rsplit_once(':').filter(|(head, _)| !head.contains("//")).map_or(path, |(_, tail)| tail);
    let mut parts = path.rsplit('/');
    let name = parts.next()?;
    let owner = parts.next()?;
    (!owner.is_empty() && !name.is_empty() && !owner.contains(':')).then(|| format!("{owner}/{name}"))
}

/// The session id attribute each harness uses.
fn session_of(harness: Harness, own: &Attributes, resource: &Attributes) -> Option<String> {
    let keys: &[&str] = match harness {
        Harness::Codex => &["conversation.id"],
        Harness::Cursor => &["cursor.conversation.id"],
        Harness::Copilot => &["gen_ai.conversation.id", "session.id"],
        _ => &["session.id"],
    };
    keys.iter().find_map(|key| text_of(own, resource, key))
}

fn email_of(harness: Harness, own: &Attributes, resource: &Attributes) -> Option<String> {
    let key = if harness == Harness::Cursor { "cursor.user.email" } else { "user.email" };
    text_of(own, resource, key).map(|email| email.to_ascii_lowercase())
}

/// One record's or point's usage of one model.
#[derive(Default)]
struct Use {
    model: String,
    usage: ModelUsage,
    cost: Option<f64>,
}

/// The name of the event a log record is: its `event_name`, its
/// `event.name` attribute, or a short body.
fn event_of(record: &LogRecord) -> String {
    if !record.event_name.is_empty() {
        return record.event_name.clone();
    }
    attribute(&record.attributes, "event.name").and_then(AnyValue::text).or_else(|| record.body_name.clone()).unwrap_or_default()
}

/// What a log record says was used, for a record that says any.
fn log_use(harness: Harness, event: &str, own: &Attributes, resource: &Attributes) -> Option<Use> {
    let count = |key: &str| count_of(own, resource, key);
    let text = |key: &str| text_of(own, resource, key).unwrap_or_default();
    let named = |name: &str| event == name || event.rsplit('.').next() == Some(name);
    match harness {
        Harness::ClaudeCode if named("api_request") => Some(Use {
            model: text("model"),
            usage: ModelUsage {
                input_tokens: count("input_tokens"),
                output_tokens: count("output_tokens"),
                cache_read_tokens: count("cache_read_tokens"),
                cache_write_5m_tokens: count("cache_creation_tokens"),
                ..ModelUsage::default()
            },
            cost: cost_of(own, resource, "cost_usd").or_else(|| cost_of(own, resource, "cost_usd_micros").map(|micros| micros / 1e6)),
        }),
        Harness::Codex if event == "codex.sse_event" => {
            (text("event.kind") == "response.completed").then(|| {
                let (cached, written) = (count("cached_token_count"), count("cache_write_token_count"));
                Use {
                    model: text("model"),
                    usage: ModelUsage {
                        input_tokens: count("input_token_count").saturating_sub(cached).saturating_sub(written),
                        output_tokens: count("output_token_count"),
                        cache_read_tokens: cached,
                        cache_write_5m_tokens: written,
                        ..ModelUsage::default()
                    },
                    cost: None,
                }
            })
        }
        Harness::Codex if event == "codex.turn_cost" => {
            Some(Use { model: text("model"), usage: ModelUsage::default(), cost: Some(cost_of(own, resource, "usage.estimated_usd")?) })
        }
        Harness::Cursor if named("api_request") => Some(Use {
            model: text("cursor.model.name"),
            usage: ModelUsage {
                input_tokens: count("cursor.api.request.input_tokens"),
                output_tokens: count("cursor.api.request.output_tokens"),
                cache_read_tokens: count("cursor.api.request.cache_read_tokens"),
                cache_write_5m_tokens: count("cursor.api.request.cache_creation_tokens"),
                ..ModelUsage::default()
            },
            cost: None,
        }),
        _ if harness == gemini() && event == "gemini_cli.api_response" => {
            let cached = count("cached_content_token_count");
            Some(Use {
                model: text("model"),
                usage: ModelUsage {
                    input_tokens: count("input_token_count").saturating_sub(cached).saturating_add(count("tool_token_count")),
                    output_tokens: count("output_token_count").saturating_add(count("thoughts_token_count")),
                    cache_read_tokens: cached,
                    ..ModelUsage::default()
                },
                cost: None,
            })
        }
        _ => None,
    }
}

/// What a metric's point says was used, for a metric that says any.
fn metric_use(harness: Harness, metric: &str, value: f64, own: &Attributes, resource: &Attributes) -> Option<Use> {
    let text = |key: &str| text_of(own, resource, key).unwrap_or_default();
    let tokens = value.clamp(0.0, MAX_USAGE_TOKENS as f64) as u64;
    let cost = (value.is_finite() && value >= 0.0).then_some(value);
    let by_type = |kind: &str, input: &[&str], output: &[&str], read: &[&str], write: &[&str]| {
        let mut usage = ModelUsage::default();
        if input.contains(&kind) {
            usage.input_tokens = tokens;
        } else if output.contains(&kind) {
            usage.output_tokens = tokens;
        } else if read.contains(&kind) {
            usage.cache_read_tokens = tokens;
        } else if write.contains(&kind) {
            usage.cache_write_5m_tokens = tokens;
        } else {
            return None;
        }
        Some(usage)
    };
    let (model, usage, cost) = match (harness, metric) {
        (Harness::ClaudeCode, "claude_code.token.usage") => {
            (text("model"), by_type(&text("type"), &["input"], &["output"], &["cacheRead"], &["cacheCreation"])?, None)
        }
        (Harness::ClaudeCode, "claude_code.cost.usage") => (text("model"), ModelUsage::default(), cost),
        (Harness::Codex, "codex.turn.cost_microusd") => (text("model"), ModelUsage::default(), cost.map(|micros| micros / 1e6)),
        (Harness::Cursor, "cursor.token.usage") => (
            text("cursor.model.name"),
            by_type(&text("cursor.token.type"), &["input"], &["output"], &["cache_read"], &["cache_creation"])?,
            None,
        ),
        (Harness::Cursor, "cursor.cost.usage") => (text("cursor.model.name"), ModelUsage::default(), cost),
        // Gemini CLI's input counts its cached tokens: they are taken
        // back out once the request's points are added up.
        (_, "gemini_cli.token.usage") if harness == gemini() => {
            (text("model"), by_type(&text("type"), &["input", "tool"], &["output", "thought"], &["cache"], &[])?, None)
        }
        (Harness::Copilot, "gen_ai.client.token.usage") => {
            let model = text_of(own, resource, "gen_ai.response.model").or_else(|| text_of(own, resource, "gen_ai.request.model"));
            (model.unwrap_or_default(), by_type(&text("gen_ai.token.type"), &["input"], &["output"], &[], &[])?, None)
        }
        _ => return None,
    };
    Some(Use { model, usage, cost })
}

/// One request's usage, added up per session and model.
#[derive(Default)]
struct Totals {
    sessions: BTreeMap<String, Found>,
}

impl Totals {
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        harness: Harness,
        session: String,
        email: Option<String>,
        signal: TelemetrySignal,
        cumulative: bool,
        repo: Option<String>,
        time: u64,
        one: Use,
    ) {
        // A session is one person's: the address any of its records names.
        let id = format!("{}\u{0}{session}\u{0}{cumulative}", harness.as_str());
        let found = self.sessions.entry(id).or_insert_with(|| Found {
            harness,
            harness_session_id: session,
            email: None,
            signal,
            cumulative,
            usage: Vec::new(),
            repo: None,
            seen_unix_nano: 0,
            records: 0,
        });
        found.records += 1;
        found.seen_unix_nano = found.seen_unix_nano.max(time);
        if found.email.is_none() {
            found.email = email;
        }
        if repo.is_some() {
            found.repo = repo;
        }
        let model = one.model;
        let known = match found.usage.iter_mut().find(|known| known.usage.model == model) {
            Some(known) => known,
            None => {
                found.usage.push(TelemetryUsage { usage: ModelUsage { model, ..ModelUsage::default() }, cost_usd: None });
                found.usage.last_mut().expect("just pushed")
            }
        };
        let add = |total: &mut u64, more: u64| *total = total.saturating_add(more).min(MAX_USAGE_TOKENS);
        add(&mut known.usage.input_tokens, one.usage.input_tokens);
        add(&mut known.usage.output_tokens, one.usage.output_tokens);
        add(&mut known.usage.cache_read_tokens, one.usage.cache_read_tokens);
        add(&mut known.usage.cache_write_5m_tokens, one.usage.cache_write_5m_tokens);
        if let Some(cost) = one.cost {
            known.cost_usd = Some(known.cost_usd.unwrap_or(0.0) + cost);
        }
    }

    fn found(self) -> Vec<Found> {
        self.sessions.into_values().collect()
    }
}

/// What a request's log records say each session used, and how many
/// records said nothing g1t reads (content, other events) or named no session.
pub fn read_logs(resources: &[ResourceLogs]) -> (Vec<Found>, u64) {
    let mut totals = Totals::default();
    let mut unread = 0;
    for resource in resources {
        for record in &resource.records {
            let event = event_of(record);
            let read = harness_of(&resource.resource, &event).and_then(|harness| {
                let one = log_use(harness, &event, &record.attributes, &resource.resource)?;
                let session = session_of(harness, &record.attributes, &resource.resource)?;
                Some((harness, session, one))
            });
            let Some((harness, session, one)) = read else {
                unread += 1;
                continue;
            };
            let time = if record.time_unix_nano > 0 { record.time_unix_nano } else { record.observed_time_unix_nano };
            totals.add(
                harness,
                session,
                email_of(harness, &record.attributes, &resource.resource),
                TelemetrySignal::Logs,
                false,
                repo_of(&record.attributes, &resource.resource),
                time,
                one,
            );
        }
    }
    (totals.found(), unread)
}

/// What a request's metrics say each session used, and how many points
/// said nothing g1t reads or named no session.
pub fn read_metrics(resources: &[ResourceMetrics]) -> (Vec<Found>, u64) {
    let mut totals = Totals::default();
    let mut unread = 0;
    for resource in resources {
        for metric in &resource.metrics {
            let Some(harness) = harness_of(&resource.resource, &metric.name) else {
                unread += metric.points.len() as u64;
                continue;
            };
            for point in &metric.points {
                let read = metric_use(harness, &metric.name, point.value, &point.attributes, &resource.resource)
                    .zip(session_of(harness, &point.attributes, &resource.resource));
                let Some((one, session)) = read else {
                    unread += 1;
                    continue;
                };
                totals.add(
                    harness,
                    session,
                    email_of(harness, &point.attributes, &resource.resource),
                    TelemetrySignal::Metrics,
                    metric.temporality == Temporality::Cumulative,
                    repo_of(&point.attributes, &resource.resource),
                    point.time_unix_nano,
                    one,
                );
            }
        }
    }
    let mut found = totals.found();
    for one in found.iter_mut().filter(|one| one.harness == gemini()) {
        for usage in &mut one.usage {
            usage.usage.input_tokens = usage.usage.input_tokens.saturating_sub(usage.usage.cache_read_tokens);
        }
    }
    (found, unread)
}

#[cfg(test)]
mod tests {
    use super::super::wire::{LogRecord, Metric, Point, logs_from_json};
    use super::*;

    fn s(value: &str) -> AnyValue {
        AnyValue::Str(value.to_owned())
    }

    fn attrs(pairs: &[(&str, AnyValue)]) -> Attributes {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()
    }

    /// A request shaped as Claude Code sends it over http/json, from the
    /// attributes its monitoring documentation lists: an `api_request`, and
    /// a `user_prompt` and a `tool_result` that carry content.
    const CLAUDE_CODE_LOGS: &str = r#"{
      "resourceLogs": [{
        "resource": { "attributes": [
          { "key": "service.name", "value": { "stringValue": "claude-code" } },
          { "key": "service.version", "value": { "stringValue": "2.1.270" } },
          { "key": "os.type", "value": { "stringValue": "darwin" } }
        ] },
        "scopeLogs": [{
          "scope": { "name": "com.anthropic.claude_code.events", "version": "2.1.270" },
          "logRecords": [
            {
              "timeUnixNano": "1792692000000000000",
              "observedTimeUnixNano": "1792692000100000000",
              "body": { "stringValue": "claude_code.api_request" },
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "api_request" } },
                { "key": "event.timestamp", "value": { "stringValue": "2026-10-22T18:00:00.000Z" } },
                { "key": "event.sequence", "value": { "intValue": "41" } },
                { "key": "session.id", "value": { "stringValue": "4f1c2b8e-7d1a-4c55-9e0b-1a2b3c4d5e6f" } },
                { "key": "user.email", "value": { "stringValue": "ana@example.com" } },
                { "key": "user.account_uuid", "value": { "stringValue": "9a8b7c6d" } },
                { "key": "organization.id", "value": { "stringValue": "org-1" } },
                { "key": "terminal.type", "value": { "stringValue": "vscode" } },
                { "key": "prompt.id", "value": { "stringValue": "p-7" } },
                { "key": "model", "value": { "stringValue": "claude-opus-5-5" } },
                { "key": "cost_usd", "value": { "stringValue": "0.0842" } },
                { "key": "duration_ms", "value": { "stringValue": "5321" } },
                { "key": "input_tokens", "value": { "stringValue": "1200" } },
                { "key": "output_tokens", "value": { "stringValue": "640" } },
                { "key": "cache_read_tokens", "value": { "stringValue": "88000" } },
                { "key": "cache_creation_tokens", "value": { "stringValue": "4100" } },
                { "key": "request_id", "value": { "stringValue": "req_011" } },
                { "key": "query_source", "value": { "stringValue": "main" } },
                { "key": "vcs.owner.name", "value": { "stringValue": "acme" } },
                { "key": "vcs.repository.name", "value": { "stringValue": "web" } }
              ]
            },
            {
              "timeUnixNano": "1792692003000000000",
              "body": { "stringValue": "claude_code.api_request" },
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "api_request" } },
                { "key": "session.id", "value": { "stringValue": "4f1c2b8e-7d1a-4c55-9e0b-1a2b3c4d5e6f" } },
                { "key": "model", "value": { "stringValue": "claude-haiku-5-5" } },
                { "key": "cost_usd", "value": { "doubleValue": 0.0011 } },
                { "key": "input_tokens", "value": { "intValue": "900" } },
                { "key": "output_tokens", "value": { "intValue": "120" } },
                { "key": "query_source", "value": { "stringValue": "subagent" } }
              ]
            },
            {
              "timeUnixNano": "1792692001000000000",
              "body": { "stringValue": "claude_code.user_prompt" },
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "user_prompt" } },
                { "key": "session.id", "value": { "stringValue": "4f1c2b8e-7d1a-4c55-9e0b-1a2b3c4d5e6f" } },
                { "key": "prompt_length", "value": { "stringValue": "38" } },
                { "key": "prompt", "value": { "stringValue": "rotate the staging database password" } }
              ]
            },
            {
              "timeUnixNano": "1792692002000000000",
              "body": { "stringValue": "claude_code.tool_result" },
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "tool_result" } },
                { "key": "session.id", "value": { "stringValue": "4f1c2b8e-7d1a-4c55-9e0b-1a2b3c4d5e6f" } },
                { "key": "tool_name", "value": { "stringValue": "Bash" } },
                { "key": "tool_parameters", "value": { "stringValue": "{\"command\":\"cat .env\"}" } }
              ]
            }
          ]
        }]
      }]
    }"#;

    #[test]
    fn claude_codes_api_requests_are_read_and_its_prompts_are_not() {
        let resources = logs_from_json(CLAUDE_CODE_LOGS.as_bytes()).unwrap();
        let (found, unread) = read_logs(&resources);
        assert_eq!(unread, 2, "the prompt and the tool result");
        assert_eq!(found.len(), 1);
        let session = &found[0];
        assert_eq!(session.harness, Harness::ClaudeCode);
        assert_eq!(session.harness_session_id, "4f1c2b8e-7d1a-4c55-9e0b-1a2b3c4d5e6f");
        assert_eq!(session.signal, TelemetrySignal::Logs);
        assert_eq!(session.email.as_deref(), Some("ana@example.com"));
        assert_eq!(session.repo.as_deref(), Some("acme/web"));
        assert_eq!(session.records, 2);
        assert_eq!(session.seen_unix_nano, 1_792_692_003_000_000_000);
        let opus = session.usage.iter().find(|one| one.usage.model == "claude-opus-5-5").unwrap();
        assert_eq!(
            (opus.usage.input_tokens, opus.usage.output_tokens, opus.usage.cache_read_tokens, opus.usage.cache_write_5m_tokens),
            (1200, 640, 88_000, 4100)
        );
        assert_eq!(opus.cost_usd, Some(0.0842));
        let haiku = session.usage.iter().find(|one| one.usage.model == "claude-haiku-5-5").unwrap();
        assert_eq!(haiku.cost_usd, Some(0.0011));
        assert_eq!(session.model().as_deref(), Some("claude-opus-5-5"));
        // Nothing read carries the prompt or the tool's input.
        let kept = format!("{found:?}");
        assert!(!kept.contains("staging") && !kept.contains(".env"), "{kept}");
    }

    #[test]
    fn codex_tokens_come_apart_from_their_cache_and_its_turn_cost_counts() {
        let resource = attrs(&[("service.name", s("codex_cli_rs"))]);
        let shared = [("conversation.id", s("thr_1")), ("model", s("gpt-5.3-codex"))];
        let completed = LogRecord {
            attributes: attrs(&[
                &shared[..],
                &[
                    ("event.name", s("codex.sse_event")),
                    ("event.kind", s("response.completed")),
                    ("input_token_count", AnyValue::Int(10_000)),
                    ("cached_token_count", AnyValue::Int(8_000)),
                    ("cache_write_token_count", AnyValue::Int(500)),
                    ("output_token_count", AnyValue::Int(300)),
                    ("tool_token_count", AnyValue::Int(10_300)),
                ],
            ]
            .concat()),
            ..LogRecord::default()
        };
        let delta = LogRecord {
            attributes: attrs(&[&shared[..], &[("event.name", s("codex.sse_event")), ("event.kind", s("response.output_text.delta"))]].concat()),
            ..LogRecord::default()
        };
        let cost = LogRecord {
            attributes: attrs(&[&shared[..], &[("event.name", s("codex.turn_cost")), ("usage.estimated_usd", s("0.0213"))]].concat()),
            ..LogRecord::default()
        };
        let prompt = LogRecord {
            attributes: attrs(&[&shared[..], &[("event.name", s("codex.user_prompt")), ("prompt", s("[REDACTED]"))]].concat()),
            ..LogRecord::default()
        };
        let (found, unread) = read_logs(&[ResourceLogs { resource, records: vec![completed, delta, cost, prompt] }]);
        assert_eq!(unread, 2);
        let usage = &found[0].usage[0];
        assert_eq!(found[0].harness, Harness::Codex);
        assert_eq!(found[0].harness_session_id, "thr_1");
        assert_eq!(
            (usage.usage.input_tokens, usage.usage.cache_read_tokens, usage.usage.cache_write_5m_tokens, usage.usage.output_tokens),
            (1_500, 8_000, 500, 300)
        );
        assert_eq!(usage.cost_usd, Some(0.0213));
    }

    #[test]
    fn cursors_requests_are_named_in_their_body_and_name_their_person() {
        let resource = attrs(&[("service.name", s("cursor")), ("cursor.user.email", s("Ana@Example.com")), ("cursor.team.id", AnyValue::Int(7))]);
        let request = LogRecord {
            body_name: Some("api_request".into()),
            attributes: attrs(&[
                ("cursor.conversation.id", s("conv-9")),
                ("cursor.event.id", s("evt-1")),
                ("cursor.model.name", s("claude-sonnet-5")),
                ("cursor.api.request.input_tokens", AnyValue::Int(400)),
                ("cursor.api.request.output_tokens", AnyValue::Int(50)),
                ("cursor.api.request.cache_read_tokens", AnyValue::Int(2_000)),
            ]),
            ..LogRecord::default()
        };
        let message = LogRecord {
            body_name: Some("conversation.user_message".into()),
            attributes: attrs(&[("cursor.conversation.id", s("conv-9")), ("text", s("secret"))]),
            ..LogRecord::default()
        };
        let (found, unread) = read_logs(&[ResourceLogs { resource, records: vec![request, message] }]);
        assert_eq!(unread, 1);
        assert_eq!(found[0].harness, Harness::Cursor);
        assert_eq!(found[0].email.as_deref(), Some("ana@example.com"));
        assert_eq!(found[0].usage[0].usage.cache_read_tokens, 2_000);
    }

    #[test]
    fn gemini_clis_responses_count_thoughts_as_output_and_cached_tokens_once() {
        let resource = attrs(&[("service.name", s("gemini-cli")), ("session.id", s("g-1"))]);
        let response = LogRecord {
            body_name: None,
            attributes: attrs(&[
                ("event.name", s("gemini_cli.api_response")),
                ("model", s("gemini-3-pro")),
                ("input_token_count", AnyValue::Int(5_000)),
                ("cached_content_token_count", AnyValue::Int(4_000)),
                ("output_token_count", AnyValue::Int(200)),
                ("thoughts_token_count", AnyValue::Int(800)),
                ("tool_token_count", AnyValue::Int(30)),
                ("response_text", s("the answer")),
            ]),
            ..LogRecord::default()
        };
        let (found, _) = read_logs(&[ResourceLogs { resource: resource.clone(), records: vec![response] }]);
        let usage = &found[0].usage[0].usage;
        assert_eq!(found[0].harness, gemini());
        assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (1_030, 4_000, 1_000));
        let point = |kind: &str, value: f64| Point { value, attributes: attrs(&[("type", s(kind)), ("model", s("gemini-3-pro"))]), ..Point::default() };
        let metrics = ResourceMetrics {
            resource,
            metrics: vec![Metric {
                name: "gemini_cli.token.usage".into(),
                points: vec![point("input", 5_000.0), point("cache", 4_000.0), point("thought", 800.0), point("output", 200.0)],
                temporality: Temporality::Cumulative,
            }],
        };
        let (found, _) = read_metrics(&[metrics]);
        let usage = &found[0].usage[0].usage;
        assert!(found[0].cumulative);
        assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (1_000, 4_000, 1_000));
    }

    #[test]
    fn claude_codes_metrics_add_tokens_and_cost_per_model() {
        let resource = attrs(&[("service.name", s("claude-code"))]);
        let point = |kind: Option<&str>, value: f64| Point {
            value,
            attributes: attrs(
                &[
                    vec![("session.id", s("abc")), ("model", s("claude-opus-5-5"))],
                    kind.map(|kind| vec![("type", s(kind))]).unwrap_or_default(),
                ]
                .concat(),
            ),
            ..Point::default()
        };
        let metrics = ResourceMetrics {
            resource,
            metrics: vec![
                Metric {
                    name: "claude_code.token.usage".into(),
                    points: vec![point(Some("input"), 10.0), point(Some("output"), 5.0), point(Some("cacheRead"), 100.0), point(Some("other"), 1.0)],
                    temporality: Temporality::Delta,
                },
                Metric { name: "claude_code.cost.usage".into(), points: vec![point(None, 0.5), point(None, 0.25)], temporality: Temporality::Delta },
                Metric { name: "claude_code.session.count".into(), points: vec![point(None, 1.0)], temporality: Temporality::Delta },
            ],
        };
        let (found, unread) = read_metrics(&[metrics]);
        assert_eq!(unread, 2, "an unknown token type and a count of sessions");
        assert_eq!(found.len(), 1);
        let usage = &found[0].usage[0];
        assert_eq!((usage.usage.input_tokens, usage.usage.output_tokens, usage.usage.cache_read_tokens), (10, 5, 100));
        assert_eq!(usage.cost_usd, Some(0.75));
        assert_eq!(found[0].signal, TelemetrySignal::Metrics);
    }

    #[test]
    fn copilots_token_histogram_is_read_by_its_vs_code_session() {
        let resource = attrs(&[("service.name", s("copilot-chat")), ("session.id", s("vs-1"))]);
        let point = |kind: &str, value: f64| Point {
            value,
            attributes: attrs(&[("gen_ai.token.type", s(kind)), ("gen_ai.request.model", s("gpt-6-sol"))]),
            ..Point::default()
        };
        let metrics = ResourceMetrics {
            resource: resource.clone(),
            metrics: vec![Metric { name: "gen_ai.client.token.usage".into(), points: vec![point("input", 300.0), point("output", 40.0)], temporality: Temporality::Cumulative }],
        };
        let (found, _) = read_metrics(&[metrics]);
        assert_eq!(found[0].harness, Harness::Copilot);
        assert_eq!(found[0].harness_session_id, "vs-1");
        assert_eq!((found[0].usage[0].usage.input_tokens, found[0].usage[0].usage.output_tokens), (300, 40));
        // Another program's gen_ai metrics are not a harness's.
        let other = ResourceMetrics {
            resource: attrs(&[("service.name", s("my-app")), ("session.id", s("x"))]),
            metrics: vec![Metric { name: "gen_ai.client.token.usage".into(), points: vec![point("input", 1.0)], temporality: Temporality::Delta }],
        };
        let (found, unread) = read_metrics(&[other]);
        assert!(found.is_empty());
        assert_eq!(unread, 1);
    }

    #[test]
    fn a_repository_is_read_from_g1ts_attribute_or_the_vcs_ones() {
        let none = Attributes::new();
        let named = |pairs: &[(&str, AnyValue)]| repo_of(&attrs(pairs), &none);
        assert_eq!(named(&[(REPOSITORY_ATTRIBUTE, s("acme/web")), ("vcs.repository.name", s("x"))]).as_deref(), Some("acme/web"));
        assert_eq!(named(&[("vcs.repository.url.full", s("https://github.com/acme/web.git"))]).as_deref(), Some("acme/web"));
        assert_eq!(named(&[("vcs.repository.url.full", s("git@g1t.sh:acme/web"))]).as_deref(), Some("acme/web"));
        assert_eq!(named(&[("vcs.repository.url.full", s("https://g1t.sh/"))]), None);
        assert_eq!(named(&[]), None);
    }

    #[test]
    fn a_record_with_no_session_is_not_read() {
        let resource = attrs(&[("service.name", s("claude-code"))]);
        let record = LogRecord {
            attributes: attrs(&[("event.name", s("api_request")), ("model", s("claude-opus-5-5")), ("input_tokens", AnyValue::Int(5))]),
            ..LogRecord::default()
        };
        let (found, unread) = read_logs(&[ResourceLogs { resource, records: vec![record] }]);
        assert!(found.is_empty());
        assert_eq!(unread, 1);
    }
}
