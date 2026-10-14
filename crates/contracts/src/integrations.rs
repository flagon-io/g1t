//! The integrations service: a workspace's connections to systems outside
//! g1t, and everything that crosses between them.
//!
//! - **Alerts.** Sentry, Datadog or any signed webhook opens an issue in a
//!   repository, once per problem however often it fires.
//! - **Trackers.** A Jira or Linear key, such as `TECH-1234`, resolves to the
//!   ticket: people and their tools read it, people import it as an issue,
//!   and when the work lands the ticket is told.
//!
//! A workspace's AI providers and Ask g1t are kept by the same service but
//! are not integrations: see [`crate::ai`].
//!
//! Mirrors `packages/contracts/src/integrations.ts`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Which outside system a connection is to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
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
}

const fn other(provider: Provider, name: &'static str, label: &'static str, kind: ProviderKind) -> Spec {
    Spec { provider, name, label, kind }
}

/// Every provider, in the order people are shown them.
pub const PROVIDERS: [Spec; 5] = [
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

}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
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
    fn ai_providers_are_not_integrations() {
        assert_eq!(Provider::parse("anthropic"), None);
        assert!(Provider::all().any(|provider| provider == Provider::Sentry));
    }

    #[test]
    fn stored_configs_with_old_fields_parse() {
        let config: ConnectionConfig =
            serde_json::from_str(r#"{"repo":"acme/web","assign":true,"gatewayModels":["*"],"writeBack":false}"#).unwrap();
        assert_eq!(config.repo.as_deref(), Some("acme/web"));
        assert!(!config.write_back);
    }
}
