//! Coding agents' own telemetry: what a harness session used and cost, as
//! the harness exports it over OpenTelemetry to the API's OTLP receiver
//! (`POST /v1/logs` and `/v1/metrics`), recorded with
//! `record_agent_telemetry`.
//!
//! Only counts arrive here: tokens by model and the cost the harness itself
//! reported. The receiver drops prompts, responses, tool input and output
//! and every other attribute before anything is sent on.
//!
//! A session is found by its harness and the harness's own id for it
//! (`sessions.harness_session_id`), for the person it belongs to. Its
//! usage is kept per signal, model and tier (`agent_telemetry`), so one
//! export adds to what came before, and a session's usage reads from its
//! logs when any arrived, else from its metrics: the same requests are
//! never counted from both. A session whose plugin reported usage of its
//! own (`g1t session heartbeat --usage-json`), or one of whose subagents
//! did, keeps the plugin's: telemetry never adds to it.

use serde::{Deserialize, Serialize};

use super::Harness;
use crate::User;
use crate::model_prices::ModelUsage;

/// The most sessions one `record_agent_telemetry` names.
pub const MAX_TELEMETRY_SESSIONS: usize = 200;
/// The most people one `record_agent_telemetry` names.
pub const MAX_TELEMETRY_PEOPLE: usize = 50;
/// The longest harness session id kept, as `start_session` keeps it.
pub const MAX_TELEMETRY_ID_CHARS: usize = 200;
/// How long telemetry for a session g1t has not found waits for one.
pub const TELEMETRY_KEEP_DAYS: u64 = 30;

/// Which OpenTelemetry signal a session's usage came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySignal {
    /// Log records (events), one per request: `claude_code.api_request`,
    /// `codex.sse_event`, `cursor` `api_request`, `gemini_cli.api_response`.
    Logs,
    /// Counters: `claude_code.token.usage`, `gen_ai.client.token.usage`, …
    Metrics,
}

impl TelemetrySignal {
    pub fn as_str(self) -> &'static str {
        match self {
            TelemetrySignal::Logs => "logs",
            TelemetrySignal::Metrics => "metrics",
        }
    }
}

/// What one model (and tier) of a session used in one export.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TelemetryUsage {
    #[serde(flatten)]
    pub usage: ModelUsage,
    /// What the harness said it cost, in US dollars, when it said: Claude
    /// Code's `cost_usd`, Codex's `usage.estimated_usd`. Otherwise the
    /// tokens are priced at list price, as a plugin's are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// One session's usage in one export.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TelemetrySession {
    /// Whose session it is: one of [`RecordTelemetryArgs::people`].
    pub actor_id: String,
    pub harness: Harness,
    /// The harness's own id for the session: Claude Code's and Gemini
    /// CLI's `session.id`, Codex's `conversation.id`, Cursor's
    /// `cursor.conversation.id`.
    pub harness_session_id: String,
    pub signal: TelemetrySignal,
    /// Whether the counts are running totals since the harness started
    /// (cumulative temporality) rather than what was used since its last
    /// export (delta): a total replaces a smaller one, a delta adds.
    #[serde(default)]
    pub cumulative: bool,
    pub usage: Vec<TelemetryUsage>,
    /// The repository the telemetry names, as `owner/name`: the
    /// `g1t.repository` resource attribute, or Claude Code's
    /// `vcs.repository.*` ones. A session g1t has not seen starts there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The model it used most, for a session that starts from telemetry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// RFC 3339: when its latest record happened, never later than it arrived.
    pub seen_at: String,
}

/// `record_agent_telemetry`: services only (the API's OTLP receiver).
/// Adds each session's usage to what its earlier exports said, then
/// gives each session g1t has found the total: one recorded by a plugin or
/// a hook, or one this starts in the repository the telemetry names. A
/// session neither finds waits, for [`TELEMETRY_KEEP_DAYS`], for one to
/// start. Returns [`TelemetryRecorded`].
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RecordTelemetryArgs {
    /// Whose sessions these are: the person a personal access token is, or
    /// the members a workspace token's records name through an address
    /// they have verified (carrying that token's access).
    pub people: Vec<User>,
    /// For a workspace token, its workspace: sessions start only in its
    /// repositories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    pub sessions: Vec<TelemetrySession>,
}

/// What `record_agent_telemetry` did with the sessions it was given.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelemetryRecorded {
    /// Sessions whose usage and cost now come from telemetry.
    pub recorded: u32,
    /// Sessions whose plugin reported usage of its own, which they keep.
    pub reported_by_plugin: u32,
    /// Sessions g1t has not found yet, and no repository to start one in.
    pub waiting: u32,
}
