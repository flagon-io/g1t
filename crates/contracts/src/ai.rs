//! A workspace's AI: the AI providers it keeps keys for, and what Ask g1t
//! answers with. Kept by the integrations service (`src/ai.rs`), but not an
//! integration: integrations connect outside products, from a directory
//! others will publish to; a workspace's AI is one of its own settings, at
//! `/:workspace/-/ai`.
//!
//! - **AI providers.** A frontier lab or a model platform at a known
//!   address, or a model the workspace hosts itself behind an Anthropic- or
//!   OpenAI-compatible endpoint. Owners add, test, change and remove them;
//!   keys are sealed and never returned.
//! - **Ask g1t.** A conversation with g1t from the top bar and with @g1t in
//!   Chat, answered by the provider and model an owner chose, on the
//!   workspace's own key. g1t hosts no model for it and bills nothing for
//!   it; the key never leaves the service.
//!
//! Mirrors `packages/contracts/src/ai.ts`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Which AI provider a workspace's key is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    // Frontier labs.
    Anthropic,
    Openai,
    /// Through Gemini's OpenAI-compatible endpoint.
    Gemini,
    Xai,
    Mistral,
    Deepseek,
    // Model platforms: many labs' models, or a deployment of your own.
    /// A deployment on the workspace's own Azure OpenAI resource.
    AzureOpenai,
    Openrouter,
    Groq,
    Together,
    Fireworks,
    Cerebras,
    // Self-hosted, or the workspace's own gateway.
    /// Any endpoint that speaks Anthropic's Messages API: the workspace's
    /// own gateway, LiteLLM, a proxy in front of Bedrock or Vertex, or a
    /// self-hosted model.
    AnthropicEndpoint,
    /// Any endpoint that speaks OpenAI's Chat Completions API: vLLM,
    /// Ollama behind a tunnel, LiteLLM, a gateway.
    OpenaiEndpoint,
}

/// Where an AI provider's models come from, as people choose them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiGroup {
    /// A lab's own API.
    Labs,
    /// A platform serving many labs' models.
    Platforms,
    /// A model the workspace hosts, or its own gateway.
    SelfHosted,
}

/// What g1t knows about an AI provider.
pub struct AiSpec {
    pub provider: AiProvider,
    pub name: &'static str,
    pub label: &'static str,
    pub group: AiGroup,
    /// The API it speaks: `anthropic` or `openai`.
    pub api: &'static str,
    /// Where its API is, with the version for OpenAI's API and without it
    /// for Anthropic's. Empty when the workspace gives its own.
    pub base_url: &'static str,
    /// The header the key goes in; `authorization` means `Bearer <key>`.
    pub auth_header: &'static str,
}

const fn spec(
    provider: AiProvider,
    name: &'static str,
    label: &'static str,
    group: AiGroup,
    api: &'static str,
    base_url: &'static str,
    auth_header: &'static str,
) -> AiSpec {
    AiSpec { provider, name, label, group, api, base_url, auth_header }
}

use AiGroup::{Labs, Platforms, SelfHosted};

/// Every AI provider, in the order people are shown them.
pub const AI_PROVIDERS: [AiSpec; 14] = [
    spec(AiProvider::Anthropic, "anthropic", "Anthropic", Labs, "anthropic", "https://api.anthropic.com", "x-api-key"),
    spec(AiProvider::Openai, "openai", "OpenAI", Labs, "openai", "https://api.openai.com/v1", "authorization"),
    spec(AiProvider::Gemini, "gemini", "Google Gemini", Labs, "openai", "https://generativelanguage.googleapis.com/v1beta/openai", "authorization"),
    spec(AiProvider::Xai, "xai", "xAI", Labs, "openai", "https://api.x.ai/v1", "authorization"),
    spec(AiProvider::Mistral, "mistral", "Mistral", Labs, "openai", "https://api.mistral.ai/v1", "authorization"),
    spec(AiProvider::Deepseek, "deepseek", "DeepSeek", Labs, "openai", "https://api.deepseek.com/v1", "authorization"),
    spec(AiProvider::AzureOpenai, "azure_openai", "Azure OpenAI", Platforms, "openai", "", "api-key"),
    spec(AiProvider::Openrouter, "openrouter", "OpenRouter", Platforms, "openai", "https://openrouter.ai/api/v1", "authorization"),
    spec(AiProvider::Groq, "groq", "Groq", Platforms, "openai", "https://api.groq.com/openai/v1", "authorization"),
    spec(AiProvider::Together, "together", "Together AI", Platforms, "openai", "https://api.together.xyz/v1", "authorization"),
    spec(AiProvider::Fireworks, "fireworks", "Fireworks AI", Platforms, "openai", "https://api.fireworks.ai/inference/v1", "authorization"),
    spec(AiProvider::Cerebras, "cerebras", "Cerebras", Platforms, "openai", "https://api.cerebras.ai/v1", "authorization"),
    spec(AiProvider::AnthropicEndpoint, "anthropic_endpoint", "Anthropic-compatible endpoint", SelfHosted, "anthropic", "", "x-api-key"),
    spec(AiProvider::OpenaiEndpoint, "openai_endpoint", "OpenAI-compatible endpoint", SelfHosted, "openai", "", "authorization"),
];

impl AiProvider {
    pub fn spec(self) -> &'static AiSpec {
        AI_PROVIDERS
            .iter()
            .find(|spec| spec.provider == self)
            .expect("every AI provider is in the catalogue")
    }

    pub fn all() -> impl Iterator<Item = AiProvider> {
        AI_PROVIDERS.iter().map(|spec| spec.provider)
    }

    pub fn name(self) -> &'static str {
        self.spec().name
    }

    pub fn parse(name: &str) -> Option<AiProvider> {
        AI_PROVIDERS.iter().find(|spec| spec.name == name).map(|spec| spec.provider)
    }

    /// What people call it.
    pub fn label(self) -> &'static str {
        self.spec().label
    }

    pub fn group(self) -> AiGroup {
        self.spec().group
    }

    /// The API it speaks: `anthropic` or `openai`.
    pub fn api(self) -> &'static str {
        self.spec().api
    }

    /// Whether the workspace gives the address, rather than g1t knowing it.
    pub fn own_address(self) -> bool {
        self.spec().base_url.is_empty()
    }
}

/// An AI provider's settings: everything but its key.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// For an endpoint or an Azure OpenAI resource: its address over
    /// `https://`. An Anthropic-compatible one without `/v1`, an
    /// OpenAI-compatible one up to and including the version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// For an endpoint: send the key as `x-api-key` or as
    /// `authorization: Bearer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_header: Option<String>,
    /// The model the team uses on it; for Azure OpenAI, the deployment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// For Anthropic: the Console workspace the key belongs to, as its
    /// Console address names it (`wrkspc_…`), so links to the sessions it
    /// starts open there. Without it, the account's Default workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub console_workspace: Option<String>,
}

/// One of a workspace's AI providers, as any member sees it. Its key is
/// never shown after it is saved; `secretHint` tells keys apart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnection {
    pub id: String,
    pub workspace: String,
    pub provider: AiProvider,
    pub group: AiGroup,
    pub name: String,
    pub config: AiConfig,
    /// The last four characters of the saved key, such as `…3f9a`.
    pub secret_hint: Option<String>,
    pub created_by: String,
    /// RFC 3339.
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// The last thing that went wrong talking to it, until it next works.
    pub last_error: Option<String>,
    /// The models it offered when last checked.
    #[serde(default)]
    pub models: Vec<String>,
}

// --- Methods -----------------------------------------------------------------

/// `ai_list`. Returns `Outcome<Vec<AiConnection>>`. Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListAiArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `ai_add`. Returns `Outcome<AiConnection>`, after checking the key.
/// Owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddAiArgs {
    pub actor: User,
    pub workspace: String,
    pub provider: AiProvider,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub config: AiConfig,
    /// Its API key. Optional for an endpoint that needs none.
    #[serde(default)]
    pub secret: Option<String>,
}

/// `ai_update`: only the fields given change. Returns
/// `Outcome<AiConnection>`. Owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateAiArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub config: Option<AiConfig>,
    /// A new key, replacing the old one.
    #[serde(default)]
    pub secret: Option<String>,
}

/// `ai_remove` and `ai_test`. `ai_remove` returns `Outcome<bool>`;
/// `ai_test` returns `Outcome<integrations::Tested>`. Owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct AiConnectionArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
}

// --- Ask g1t -----------------------------------------------------------------

/// The most messages one ask sends: the conversation's latest turns.
pub const ASK_MAX_MESSAGES: usize = 40;
/// The longest one message may be, in characters.
pub const ASK_MAX_MESSAGE_CHARS: usize = 16_000;
/// The longest a whole conversation may be, in characters.
pub const ASK_MAX_TOTAL_CHARS: usize = 64_000;
/// The most tokens one answer may run to.
pub const ASK_MAX_OUTPUT_TOKENS: u32 = 4_096;

/// The model name that means Auto in [`SetAskSettingsArgs`]: Ask picks one
/// of the provider's models for each question.
pub const ASK_AUTO_MODEL: &str = "auto";

/// What Ask g1t answers with in a workspace: the AI provider and model an
/// owner chose, or why it cannot answer yet.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AskSetup {
    /// The workspace's AI provider Ask answers with: an [`AiConnection`]'s id.
    pub provider_id: Option<String>,
    /// Its name, as its owner named it.
    pub provider_name: Option<String>,
    pub provider: Option<AiProvider>,
    /// The model chosen. With `auto`, none, or the provider's own model
    /// when it lists none (an endpoint's, an Azure deployment).
    pub model: Option<String>,
    /// Auto: each question goes to the provider's model that suits it (a
    /// fast one for a lookup, a stronger one for a question that needs
    /// several reads or reasoning). The default.
    #[serde(default)]
    pub auto: bool,
    /// Why Ask cannot answer, in words for the person asking. `None` when
    /// it can.
    pub problem: Option<String>,
}

/// `ai_brief`: a short answer from the AI provider a workspace chose for
/// Ask, on its fast model, for g1t's own use (a session's title). Only
/// services ask it, over their bindings. Returns `Outcome<Option<String>>`:
/// none when the workspace has no provider chosen, a failure when the
/// provider was asked and could not answer.
#[derive(Debug, Serialize, Deserialize)]
pub struct AiBriefArgs {
    pub workspace: String,
    pub system: String,
    /// What to answer about, already bounded by the caller (at most
    /// [`MAX_BRIEF_INPUT_CHARS`] are sent).
    pub input: String,
    /// At most [`MAX_BRIEF_TOKENS`].
    pub max_tokens: u32,
}

/// The most of an [`AiBriefArgs`] input sent to the provider.
pub const MAX_BRIEF_INPUT_CHARS: usize = 6_000;
/// The longest answer an [`AiBriefArgs`] may ask for.
pub const MAX_BRIEF_TOKENS: u32 = 200;

/// `ask_settings`: what Ask answers with. Returns `Outcome<AskSetup>`.
/// Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct AskSettingsArgs {
    pub workspace: String,
    pub viewer: Viewer,
}

/// `set_ask_settings`: chooses the AI provider and model Ask answers with;
/// no `provider_id` turns Ask off. Returns `Outcome<AskSetup>`. Owners
/// only.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetAskSettingsArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    /// One of the models the provider offers, or [`ASK_AUTO_MODEL`] for
    /// Auto; its own model (an Azure deployment) when not given.
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
    /// The page's path, such as `/acme/-/work/12`.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// The workspace of a page that is not a repository's, such as a work
    /// item's. With `repo`, the repository's.
    #[serde(default)]
    pub workspace: Option<String>,
    /// A work item, by number in the workspace.
    #[serde(default)]
    pub item: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
    /// The browser's IANA time zone, such as `America/Denver`: what
    /// "today" means when their profile names none.
    #[serde(default)]
    pub time_zone: Option<String>,
}

/// `ask`: one answer, streamed as newline-delimited JSON [`AskEvent`]s:
/// `meta` first, then `text` as it comes and a `tool` line as each step
/// starts and ends, then `sources` and `done`, or `error` at any point.
/// Members only. The conversation alternates, starting and ending with the
/// person; its turns are text only, since the steps of an answer live in
/// that answer alone.
///
/// The provider reads g1t with the MCP server's own tools, as the person
/// asking, on a read-only credential identity makes for the answer
/// (`create_ask_token`), so it sees what they may see and changes nothing.
#[derive(Debug, Serialize, Deserialize)]
pub struct AskArgs {
    pub actor: User,
    pub workspace: String,
    pub messages: Vec<AskMessage>,
    #[serde(default)]
    pub page: AskPage,
}

/// The most rounds of tool calls one answer takes before it must answer
/// with what it has.
pub const ASK_MAX_TOOL_ROUNDS: usize = 10;
/// The most tool calls one answer makes, across its rounds.
pub const ASK_MAX_TOOL_CALLS: usize = 30;
/// The most characters of one tool's result the model is given; more is
/// trimmed, long texts and lists first, with a note saying so.
pub const ASK_MAX_TOOL_RESULT_CHARS: usize = 16_000;
/// The most characters of tool results one answer gives the model in all.
pub const ASK_MAX_TOOL_TOTAL_CHARS: usize = 120_000;
/// How long one answer may spend calling tools, in seconds. After it, the
/// model answers with what it has.
pub const ASK_MAX_TOOL_SECONDS: u64 = 120;
/// The most sources one answer lists.
pub const ASK_MAX_SOURCES: usize = 12;

/// Where a step of an answer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskToolStatus {
    /// Started; its result has not come.
    Running,
    Done,
    /// The tool answered with a refusal or an error: `summary` says what.
    Failed,
    /// Ask did not run it: it is not something Ask does (it only reads, and
    /// hands work off), or the answer had used its tool calls.
    Refused,
}

/// A page on g1t an answer drew on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AskSource {
    pub title: String,
    /// An absolute address on the site, such as
    /// `https://g1t.sh/acme/web/pull/7`.
    pub url: String,
    /// Whether the answer links to it, rather than only having read it.
    pub cited: bool,
}

/// One line of an `ask` answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AskEvent {
    /// Who is answering.
    /// `model` is the one answering; `auto` when Auto chose it.
    Meta {
        provider: AiProvider,
        provider_label: String,
        model: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        auto: bool,
    },
    /// The next piece of the answer.
    Text { text: String },
    /// A step taken to answer: one of g1t's tools, run as the person
    /// asking. Sent when it starts, `running`, and again with the same `id`
    /// when it ends, with what it found in `summary` and the page it was
    /// about in `link`.
    Tool {
        id: String,
        /// The tool, such as `pull_request`, and its `action`, such as `list`.
        name: String,
        action: Option<String>,
        /// What it does, for a person: "Read pull requests in acme/web".
        label: String,
        status: AskToolStatus,
        summary: Option<String>,
        link: Option<String>,
    },
    /// What the answer drew on, cited first. Sent once, before `done`.
    Sources { sources: Vec<AskSource> },
    /// Work Ask proposes to hand to a session in the person's own harness:
    /// on a work item (by number in `repo`'s workspace), or on a new one
    /// with `title` and `body`. Nothing has started; the person starts it,
    /// or copies the command, from the card the answer shows. `mode` is
    /// `plan`, `implement` or `review`.
    ///
    /// With `new_repository`, `repo` does not exist yet: the card creates
    /// it (`private` or public), turns on its deployments when `deploy`,
    /// then opens the work item and starts the session, which pushes the
    /// first version to the default branch, and so deploys it.
    Proposal {
        id: String,
        repo: String,
        item: Option<u64>,
        title: Option<String>,
        body: Option<String>,
        mode: String,
        instruction: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        new_repository: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        private: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        deploy: bool,
    },
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
    fn every_ai_provider_is_named_once_and_found_again() {
        let mut names: Vec<&str> = AI_PROVIDERS.iter().map(|spec| spec.name).collect();
        for provider in AiProvider::all() {
            assert_eq!(AiProvider::parse(provider.name()), Some(provider));
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), AI_PROVIDERS.len());
        // Integrations are not AI providers.
        assert_eq!(AiProvider::parse("sentry"), None);
    }

    #[test]
    fn ai_providers_say_how_to_reach_them() {
        for spec in &AI_PROVIDERS {
            assert!(spec.api == "anthropic" || spec.api == "openai", "{}", spec.name);
            assert!(!spec.auth_header.is_empty(), "{}", spec.name);
            assert!(spec.base_url.is_empty() || spec.base_url.starts_with("https://"), "{}", spec.name);
        }
        let stored: AiProvider = serde_json::from_str("\"openai_endpoint\"").unwrap();
        assert!(stored.own_address());
        assert_eq!(stored.group(), AiGroup::SelfHosted);
        assert!(!AiProvider::Anthropic.own_address());
        assert_eq!(serde_json::to_string(&AiGroup::SelfHosted).unwrap(), r#""self_hosted""#);
    }

    #[test]
    fn settings_kept_from_when_they_were_integrations_still_parse() {
        let config: AiConfig =
            serde_json::from_str(r#"{"writeBack":true,"keys":[],"baseUrl":"https://llm.acme.dev","model":"qwen3"}"#).unwrap();
        assert_eq!(config.base_url.as_deref(), Some("https://llm.acme.dev"));
        assert_eq!(config.model.as_deref(), Some("qwen3"));
    }

    #[test]
    fn ask_events_are_tagged_lines() {
        let line = serde_json::to_string(&AskEvent::Text { text: "Hi".into() }).unwrap();
        assert_eq!(line, r#"{"type":"text","text":"Hi"}"#);
        let meta: AskEvent =
            serde_json::from_str(r#"{"type":"meta","provider":"anthropic","provider_label":"Anthropic","model":"claude"}"#).unwrap();
        assert_eq!(
            meta,
            AskEvent::Meta { provider: AiProvider::Anthropic, provider_label: "Anthropic".into(), model: "claude".into(), auto: false }
        );
        // Auto says so; a chosen model's line is as it was.
        assert!(!serde_json::to_string(&meta).unwrap().contains("auto"));
        let auto = AskEvent::Meta { provider: AiProvider::Anthropic, provider_label: "Anthropic".into(), model: "claude".into(), auto: true };
        assert_eq!(
            serde_json::to_string(&auto).unwrap(),
            r#"{"type":"meta","provider":"anthropic","provider_label":"Anthropic","model":"claude","auto":true}"#
        );
        let page: AskPage = serde_json::from_str("{}").unwrap();
        assert_eq!(page, AskPage::default());
    }

    #[test]
    fn ask_steps_and_sources_are_snake_case_lines() {
        let step = AskEvent::Tool {
            id: "t1".into(),
            name: "pull_request".into(),
            action: Some("list".into()),
            label: "Read pull requests in acme/web".into(),
            status: AskToolStatus::Done,
            summary: Some("12 results".into()),
            link: Some("https://g1t.sh/acme/web/pulls".into()),
        };
        assert_eq!(
            serde_json::to_value(&step).unwrap(),
            serde_json::json!({
                "type": "tool", "id": "t1", "name": "pull_request", "action": "list",
                "label": "Read pull requests in acme/web", "status": "done",
                "summary": "12 results", "link": "https://g1t.sh/acme/web/pulls",
            })
        );
        let sources = AskEvent::Sources {
            sources: vec![AskSource { title: "Fix login".into(), url: "https://g1t.sh/acme/web/pull/7".into(), cited: true }],
        };
        let line = serde_json::to_string(&sources).unwrap();
        assert_eq!(line, r#"{"type":"sources","sources":[{"title":"Fix login","url":"https://g1t.sh/acme/web/pull/7","cited":true}]}"#);
        assert_eq!(serde_json::from_str::<AskEvent>(&line).unwrap(), sources);
        assert_eq!(serde_json::to_string(&AskToolStatus::Refused).unwrap(), r#""refused""#);
    }
}
