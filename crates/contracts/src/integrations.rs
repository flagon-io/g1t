//! The integrations service: a workspace's connections to systems outside
//! g1t, and everything that crosses between them.
//!
//! - **Models.** A workspace connects as many model providers as it uses
//!   (Anthropic, OpenAI, Gemini, and anything compatible with either API)
//!   and routes each kind of work to one of them, or to g1t's hosted models.
//!   Sandboxes never hold a key: they hold a token for one run, and the
//!   model proxy puts the credentials on each request, translating to
//!   OpenAI's API where the provider speaks it.
//! - **Alerts.** Sentry, Datadog or any signed webhook opens an issue in a
//!   repository, once per problem however often it fires, and can put an
//!   agent on it.
//! - **Trackers.** A Jira or Linear key, such as `TECH-1234`, resolves to the
//!   ticket: agents read it, people import it as an issue, and when the work
//!   lands the ticket is told.
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

/// The kinds of work a model is chosen for, and `default` for the rest.
pub const MODEL_TASKS: [&str; 5] = ["default", "implement", "review", "plan", "update"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Where agents' model requests go. A workspace can have several and
    /// routes each kind of work to one.
    Models,
    /// Problems that become issues.
    Alerts,
    /// Tickets that agents read and people import.
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
    /// For alerts: put a g1t agent on each issue opened.
    #[serde(default)]
    pub assign: bool,
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
    /// Models: the model used when a route to this connection names none.
    /// Required for providers that speak OpenAI's API; for Anthropic, g1t's
    /// choice for the kind of work when unset.
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
            assign: false,
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

/// Where one kind of work's model requests go in a workspace.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoute {
    /// One of [`MODEL_TASKS`].
    pub task: String,
    /// The workspace's own model connection, or `None` for g1t's hosted
    /// models.
    pub connection_id: Option<String>,
    /// The model at that connection; its default model when `None`.
    pub model: Option<String>,
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

/// Where a workspace's agents' model requests go.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSession {
    /// What the sandbox sends instead of a key. Lives as long as one run.
    pub token: String,
    /// `g1t` when g1t pays the provider and charges the workspace,
    /// `workspace` when the workspace's own account does.
    pub billed_to: String,
    /// The connection's name, when it is the workspace's own.
    pub provider_name: Option<String>,
    /// The model to use instead of g1t's choice, if the connection names one.
    pub model: Option<String>,
}

/// What the model proxy needs to forward one run's requests.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUpstream {
    /// `g1t`, `anthropic` or `endpoint`.
    pub route: String,
    /// The API the provider speaks: `anthropic` or `openai`, which the proxy
    /// translates to.
    pub api: String,
    /// The model every request of the run is sent to, when the route names
    /// one.
    pub model: Option<String>,
    /// For `openai`: OpenAI's own API, which shapes requests its own way.
    pub official: bool,
    /// Which provider it is, by name, so the proxy can meet its quirks.
    #[serde(default)]
    pub provider: String,
    pub workspace: String,
    pub repo: String,
    pub number: u32,
    pub task: String,
    /// For `endpoint`: where to send requests.
    pub base_url: Option<String>,
    /// For `anthropic` and `endpoint`: the workspace's key.
    pub api_key: Option<String>,
    /// `x-api-key` or `authorization`.
    pub auth_header: Option<String>,
    /// For an endpoint behind an authenticated Cloudflare AI Gateway: the
    /// gateway's own token, sent as `cf-aig-authorization`.
    #[serde(default)]
    pub gateway_token: Option<String>,
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
    /// Made by g1t for Datadog and webhooks, and shown once. For a model
    /// endpoint behind an authenticated Cloudflare AI Gateway, the gateway's
    /// token.
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

/// `references`: every outside reference in `text` that one of the
/// workspace's connections answers for, fetched. Returns `Vec<ContextItem>`.
/// For g1t's own agents, about work in that workspace.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReferencesArgs {
    pub workspace: String,
    pub text: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `import`: opens an issue from a ticket. Returns `Outcome<Imported>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub reference: String,
    /// Put a g1t agent on it.
    #[serde(default)]
    pub assign: bool,
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

/// `open_model_session`: where one run's model requests go, by the
/// workspace's routes. Returns `Outcome<ModelSession>`: a failure, with the
/// reason to show, when the route goes nowhere it can use.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenModelSessionArgs {
    pub workspace: String,
    pub repo: RepoPath,
    pub number: u32,
    pub task: String,
    /// Whether g1t's hosted models are open to the workspace. The runner
    /// decides that; this service only follows the routes.
    #[serde(default = "yes")]
    pub hosted_open: bool,
}

/// `routes`: a workspace's model routes, one per kind of work that has its
/// own. Returns `Outcome<Vec<ModelRoute>>`. Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct RoutesArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `set_routes`: replaces a workspace's model routes. A kind of work left
/// out follows `default`; with no `default`, g1t's hosted models where they
/// are open. Returns `Outcome<Vec<ModelRoute>>`. Owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetRoutesArgs {
    pub actor: User,
    pub workspace: String,
    pub routes: Vec<ModelRoute>,
}

/// `model_upstream`: what a model session's token stands for, or null when
/// it is unknown or expired. Returns `Option<ModelUpstream>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ModelUpstreamArgs {
    pub token: String,
}

/// `model_provider`: the workspace's own model connection, if it has one.
/// Returns `Option<Connection>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ModelProviderArgs {
    pub workspace: String,
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
    fn model_providers_say_how_to_reach_them() {
        for spec in PROVIDERS.iter().filter(|spec| spec.kind == ProviderKind::Models) {
            assert!(spec.api == "anthropic" || spec.api == "openai", "{}", spec.name);
            assert!(!spec.auth_header.is_empty(), "{}", spec.name);
            assert!(spec.base_url.is_empty() || spec.base_url.starts_with("https://"), "{}", spec.name);
        }
    }
}
