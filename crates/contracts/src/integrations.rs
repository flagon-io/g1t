//! The integrations service: a workspace's connections to systems outside
//! g1t, and everything that crosses between them.
//!
//! - **AI providers.** A workspace keeps the credentials for the AI
//!   providers its team uses (Anthropic, OpenAI, Gemini, and anything
//!   compatible with either API), sealed, so work can be handed to them.
//!   Workspace admins add, test, update and remove them.
//! - **Alerts.** Sentry, Datadog or any signed webhook opens an issue in a
//!   repository, once per problem however often it fires.
//! - **Trackers.** A Jira or Linear key, such as `TECH-1234`, resolves to the
//!   ticket: people and their tools read it, people import it as an issue,
//!   and when the work lands the ticket is told.
//! - **Ask g1t.** A conversation with g1t from the top bar, answered by the
//!   AI provider and model an owner chose from the workspace's own
//!   connections, on the workspace's own key. g1t hosts no model for it and
//!   bills nothing for it; the key never leaves this service.
//!
//! Mirrors `packages/contracts/src/integrations.ts`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Which outside system a connection is to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    // Model providers: the labs.
    Anthropic,
    Openai,
    /// Through Gemini's OpenAI-compatible endpoint.
    Gemini,
    Xai,
    Mistral,
    Deepseek,
    // Model providers: platforms that serve many labs' models.
    /// A deployment on the workspace's own Azure OpenAI resource.
    AzureOpenai,
    Openrouter,
    Groq,
    Together,
    Fireworks,
    Cerebras,
    // Model providers: anything else.
    /// Any endpoint that speaks Anthropic's Messages API: the workspace's
    /// own Cloudflare AI Gateway, LiteLLM, a proxy in front of Bedrock or
    /// Vertex, or a self-hosted model.
    AnthropicEndpoint,
    /// Any endpoint that speaks OpenAI's Chat Completions API: vLLM,
    /// Ollama behind a tunnel, LiteLLM, a gateway.
    OpenaiEndpoint,
    // Alerts.
    Sentry,
    Datadog,
    /// Anything that can send a signed JSON request.
    Webhook,
    // Trackers.
    Jira,
    Linear,
}

/// What g1t knows about a provider.
pub struct Spec {
    pub provider: Provider,
    pub name: &'static str,
    pub label: &'static str,
    pub kind: ProviderKind,
    /// For a model provider: the API it speaks, `anthropic` or `openai`.
    pub api: &'static str,
    /// For a model provider with a fixed address: where its API is, with
    /// the version for OpenAI's API and without it for Anthropic's. Empty
    /// when the connection gives its own.
    pub base_url: &'static str,
    /// The header the key goes in; `authorization` means `Bearer <key>`.
    pub auth_header: &'static str,
}

const fn model(provider: Provider, name: &'static str, label: &'static str, api: &'static str, base_url: &'static str, auth_header: &'static str) -> Spec {
    Spec {
        provider,
        name,
        label,
        kind: ProviderKind::Models,
        api,
        base_url,
        auth_header,
    }
}

const fn other(provider: Provider, name: &'static str, label: &'static str, kind: ProviderKind) -> Spec {
    Spec {
        provider,
        name,
        label,
        kind,
        api: "",
        base_url: "",
        auth_header: "",
    }
}

/// Every provider, in the order people are shown them.
pub const PROVIDERS: [Spec; 19] = [
    model(Provider::Anthropic, "anthropic", "Anthropic", "anthropic", "https://api.anthropic.com", "x-api-key"),
    model(Provider::Openai, "openai", "OpenAI", "openai", "https://api.openai.com/v1", "authorization"),
    model(Provider::Gemini, "gemini", "Google Gemini", "openai", "https://generativelanguage.googleapis.com/v1beta/openai", "authorization"),
    model(Provider::Xai, "xai", "xAI", "openai", "https://api.x.ai/v1", "authorization"),
    model(Provider::Mistral, "mistral", "Mistral", "openai", "https://api.mistral.ai/v1", "authorization"),
    model(Provider::Deepseek, "deepseek", "DeepSeek", "openai", "https://api.deepseek.com/v1", "authorization"),
    model(Provider::AzureOpenai, "azure_openai", "Azure OpenAI", "openai", "", "api-key"),
    model(Provider::Openrouter, "openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1", "authorization"),
    model(Provider::Groq, "groq", "Groq", "openai", "https://api.groq.com/openai/v1", "authorization"),
    model(Provider::Together, "together", "Together AI", "openai", "https://api.together.xyz/v1", "authorization"),
    model(Provider::Fireworks, "fireworks", "Fireworks AI", "openai", "https://api.fireworks.ai/inference/v1", "authorization"),
    model(Provider::Cerebras, "cerebras", "Cerebras", "openai", "https://api.cerebras.ai/v1", "authorization"),
    model(Provider::AnthropicEndpoint, "anthropic_endpoint", "Anthropic-compatible endpoint", "anthropic", "", "x-api-key"),
    model(Provider::OpenaiEndpoint, "openai_endpoint", "OpenAI-compatible endpoint", "openai", "", "authorization"),
    other(Provider::Sentry, "sentry", "Sentry", ProviderKind::Alerts),
    other(Provider::Datadog, "datadog", "Datadog", ProviderKind::Alerts),
    other(Provider::Webhook, "webhook", "Webhook", ProviderKind::Alerts),
    other(Provider::Jira, "jira", "Jira", ProviderKind::Tracker),
    other(Provider::Linear, "linear", "Linear", ProviderKind::Tracker),
];

impl Provider {
    pub fn spec(self) -> &'static Spec {
        PROVIDERS
            .iter()
            .find(|spec| spec.provider == self)
            .expect("every provider is in the catalogue")
    }

    pub fn all() -> impl Iterator<Item = Provider> {
        PROVIDERS.iter().map(|spec| spec.provider)
    }

    pub fn name(self) -> &'static str {
        self.spec().name
    }

    pub fn parse(name: &str) -> Option<Provider> {
        PROVIDERS.iter().find(|spec| spec.name == name).map(|spec| spec.provider)
    }

    /// What people call it.
    pub fn label(self) -> &'static str {
        self.spec().label
    }

    pub fn kind(self) -> ProviderKind {
        self.spec().kind
    }

    /// Whether it sends g1t requests, at the connection's own address.
    pub fn receives(self) -> bool {
        self.kind() == ProviderKind::Alerts
    }

    /// For a model provider, the API it speaks: `anthropic` or `openai`.
    pub fn api(self) -> &'static str {
        self.spec().api
    }

    /// Whether the connection gives the address, rather than g1t knowing it.
    pub fn own_address(self) -> bool {
        self.kind() == ProviderKind::Models && self.spec().base_url.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// An AI provider whose credentials the workspace keeps.
    Models,
    /// Problems that become issues.
    Alerts,
    /// Tickets that people read and import.
    Tracker,
}

/// A connection's settings: everything about it except its secrets. Each
/// provider uses the fields that apply to it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    /// For alerts: the repository issues are opened in, `owner/name`. For a
    /// tracker: where an imported ticket goes when no repository is named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// For alerts: the label put on each issue opened. `bug` when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Tell the outside system when the work lands: resolve the Sentry
    /// issue, comment on the ticket.
    #[serde(default = "yes")]
    pub write_back: bool,
    /// Sentry: the organization's slug.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    /// The system's address, for Jira (`https://acme.atlassian.net`) or a
    /// Sentry that is not sentry.io.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    /// Jira: the account the API token belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Jira project keys or Linear team keys this connection answers for,
    /// such as `TECH`. Empty answers for every key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
    /// Your own endpoint: its base URL, without `/v1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Your own endpoint: send the key as `x-api-key` (the default) or as
    /// `authorization: Bearer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_header: Option<String>,
    /// For an AI provider: the model the team uses on it, when it names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn yes() -> bool {
    true
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        ConnectionConfig {
            repo: None,
            label: None,
            write_back: true,
            organization: None,
            site: None,
            email: None,
            keys: Vec::new(),
            base_url: None,
            auth_header: None,
            model: None,
        }
    }
}

/// A connection, as anyone in the workspace sees it. Secrets are never
/// shown after they are saved; `secretHint` is enough to tell keys apart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub workspace: String,
    pub provider: Provider,
    pub kind: ProviderKind,
    pub name: String,
    pub config: ConnectionConfig,
    /// The last four characters of the saved key, such as `…3f9a`.
    pub secret_hint: Option<String>,
    /// For a provider that sends g1t requests: where it sends them.
    pub webhook_url: Option<String>,
    pub created_by: String,
    /// RFC 3339.
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// The last thing that went wrong talking to it, until it next works.
    pub last_error: Option<String>,
    /// For a model provider: the models it offered when last checked.
    #[serde(default)]
    pub models: Vec<String>,
}

/// One request an outside system sent, and what g1t did with it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    /// RFC 3339.
    pub received_at: String,
    /// What it was about, in the sender's terms: `issue.created`.
    pub event: String,
    /// `opened`, `updated`, `reopened`, `ignored` or `refused`.
    pub outcome: String,
    pub detail: String,
    /// The issue it opened or updated, `owner/name#number`.
    pub issue: Option<String>,
}

/// Something outside g1t, fetched as it is now. Its text was written outside
/// g1t, so it is reference material and never instructions.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub provider: Provider,
    /// `TECH-1234`, or the Sentry issue's short id.
    pub key: String,
    pub title: String,
    pub url: String,
    /// Its status in that system: `In Progress`, `unresolved`.
    pub status: Option<String>,
    /// Its description, as plain text, shortened if long.
    pub body: String,
    /// RFC 3339: when g1t fetched it.
    pub fetched_at: String,
}

/// An issue's tie to something outside g1t.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub provider: Provider,
    pub connection_id: String,
    pub key: String,
    pub title: String,
    pub url: String,
    /// How many times an alert has fired for it.
    pub count: u32,
    /// RFC 3339.
    pub first_seen: String,
    pub last_seen: String,
}

// --- Methods -----------------------------------------------------------------

/// `list`. Returns `Outcome<Vec<Connection>>`. Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `connect`. Returns `Outcome<Connected>`. Owners only.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub actor: User,
    pub workspace: String,
    pub provider: Provider,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub config: ConnectionConfig,
    /// The API key or token g1t uses to call it.
    #[serde(default)]
    pub secret: Option<String>,
    /// What it signs its requests to g1t with: Sentry's client secret.
    /// Made by g1t for Datadog and webhooks, and shown once.
    #[serde(default)]
    pub signing_secret: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub connection: Connection,
    /// A signing secret g1t made, shown this once.
    pub signing_secret: Option<String>,
}

/// `update`: only the fields given change. Returns `Outcome<Connection>`.
/// Owners only.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub config: Option<ConnectionConfig>,
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub signing_secret: Option<String>,
}

/// `disconnect` and `test`. `disconnect` returns `Outcome<bool>`; `test`
/// returns `Outcome<Tested>`. Owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tested {
    pub ok: bool,
    pub message: String,
}

/// `deliveries`: the latest requests a connection received, newest first.
/// Returns `Outcome<Vec<Delivery>>`. Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeliveriesArgs {
    pub workspace: String,
    pub viewer: Viewer,
    pub id: String,
}

/// `receive`: a request an outside system sent to a connection's address.
/// Returns `Received`. Anyone can send one; only a signed one is acted on.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReceiveArgs {
    pub id: String,
    /// Header names in lowercase.
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Received {
    /// The HTTP status to answer with.
    pub status: u16,
    pub message: String,
}

/// `resolve`: fetches one outside reference. Returns `Outcome<ContextItem>`.
/// Members of the workspace only.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveArgs {
    pub workspace: String,
    pub viewer: Viewer,
    /// `TECH-1234`, or a Jira, Linear or Sentry address.
    pub reference: String,
}

/// `import`: opens an issue from a ticket. Returns `Outcome<Imported>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub reference: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Imported {
    pub number: u32,
    pub item: ContextItem,
    /// False when the ticket had been imported already, and `number` is
    /// that issue.
    pub created: bool,
}

/// `links`: what an issue is tied to outside g1t. Returns `Vec<Link>`.
/// Callers must have checked the viewer may see the issue.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksArgs {
    pub repo: RepoPath,
    pub number: u32,
}

// --- Ask g1t ---------------------------------------------------------------

/// The most messages one ask sends: the conversation's latest turns.
pub const ASK_MAX_MESSAGES: usize = 40;
/// The longest one message may be, in characters.
pub const ASK_MAX_MESSAGE_CHARS: usize = 16_000;
/// The longest a whole conversation may be, in characters.
pub const ASK_MAX_TOTAL_CHARS: usize = 64_000;
/// The most tokens one answer may run to.
pub const ASK_MAX_OUTPUT_TOKENS: u32 = 4_096;

/// What Ask g1t answers with in a workspace: the connection and model an
/// owner chose, or why it cannot answer yet.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AskSetup {
    pub connection_id: Option<String>,
    /// The connection's name, as its owner named it.
    pub connection_name: Option<String>,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    /// Why Ask cannot answer, in words for the person asking. `None` when
    /// it can.
    pub problem: Option<String>,
}

/// `ask_settings`: what Ask answers with. Returns `Outcome<AskSetup>`.
/// Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct AskSettingsArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `set_ask_settings`: chooses the connection and model Ask answers with;
/// no `connection_id` turns Ask off. Returns `Outcome<AskSetup>`. Owners
/// only.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetAskSettingsArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    /// One of the models the connection offers; its own model (an Azure
    /// deployment) when not given.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskRole {
    User,
    Assistant,
}

/// One turn of an Ask conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AskMessage {
    pub role: AskRole,
    pub content: String,
}

/// Where the person asking is in g1t, so the answer is about their work.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AskPage {
    /// The page's path, such as `/acme/web/issues/12`.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    #[serde(default)]
    pub issue: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
}

/// `ask`: one answer, streamed as newline-delimited JSON [`AskEvent`]s:
/// `meta` first, then `text` as it comes, then `done`, or `error` at any
/// point. Members only. The conversation alternates, starting and ending
/// with the person.
#[derive(Debug, Serialize, Deserialize)]
pub struct AskArgs {
    pub actor: User,
    pub workspace: String,
    pub messages: Vec<AskMessage>,
    #[serde(default)]
    pub page: AskPage,
}

/// One line of an `ask` answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AskEvent {
    /// Who is answering.
    Meta { provider: Provider, provider_label: String, model: String },
    /// The next piece of the answer.
    Text { text: String },
    /// The answer is complete. `stop_reason` as the provider said it, such
    /// as `end_turn`, `stop` or `max_tokens`.
    Done { stop_reason: Option<String> },
    /// The answer stopped: what went wrong, for the person asking.
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_is_named_once_and_found_again() {
        let mut names: Vec<&str> = PROVIDERS.iter().map(|spec| spec.name).collect();
        for provider in Provider::all() {
            assert_eq!(Provider::parse(provider.name()), Some(provider));
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), PROVIDERS.len());
    }

    #[test]
    fn ai_providers_are_connections_like_any_other() {
        assert_eq!(Provider::parse("anthropic"), Some(Provider::Anthropic));
        let stored: Provider = serde_json::from_str("\"openai_endpoint\"").unwrap();
        assert_eq!(stored.kind(), ProviderKind::Models);
        assert!(stored.own_address());
        assert!(!Provider::Anthropic.own_address());
        assert!(Provider::all().any(|provider| provider == Provider::Groq));
        assert!(Provider::all().any(|provider| provider == Provider::Sentry));
    }

    #[test]
    fn stored_configs_with_old_fields_parse() {
        let config: ConnectionConfig =
            serde_json::from_str(r#"{"repo":"acme/web","assign":true,"gatewayModels":["*"],"writeBack":false}"#).unwrap();
        assert_eq!(config.repo.as_deref(), Some("acme/web"));
        assert!(!config.write_back);
    }

    #[test]
    fn model_providers_say_how_to_reach_them() {
        for spec in PROVIDERS.iter().filter(|spec| spec.kind == ProviderKind::Models) {
            assert!(spec.api == "anthropic" || spec.api == "openai", "{}", spec.name);
            assert!(!spec.auth_header.is_empty(), "{}", spec.name);
            assert!(spec.base_url.is_empty() || spec.base_url.starts_with("https://"), "{}", spec.name);
        }
    }

    #[test]
    fn ask_events_are_tagged_lines() {
        let line = serde_json::to_string(&AskEvent::Text { text: "Hi".into() }).unwrap();
        assert_eq!(line, r#"{"type":"text","text":"Hi"}"#);
        let meta: AskEvent =
            serde_json::from_str(r#"{"type":"meta","provider":"anthropic","provider_label":"Anthropic","model":"claude"}"#).unwrap();
        assert_eq!(
            meta,
            AskEvent::Meta { provider: Provider::Anthropic, provider_label: "Anthropic".into(), model: "claude".into() }
        );
        let page: AskPage = serde_json::from_str("{}").unwrap();
        assert_eq!(page, AskPage::default());
    }
}
