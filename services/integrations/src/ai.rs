//! A workspace's AI providers, and Ask g1t answering with one of them. Not
//! integrations: they have their own table (`ai_providers`), their own
//! route of what Ask answers with (`ai_routes`) and their own methods. See
//! `g1t_contracts::ai`.
//!
//! Keys are sealed with the service's key, bound to the provider's id, and
//! never returned. A provider's key is checked when it is saved and on
//! every test, which also learns the models it offers.

use g1t_contracts::ai::*;
use g1t_contracts::identity::{AskToken, CreateAskTokenArgs, Profile, RevokeAskTokenArgs, SlugArgs, UsernameArgs, Workspace};
use g1t_contracts::integrations::Tested;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{PullDetail, ViewArgs, WorkItemDetail, WorkItemViewArgs};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::{args, now_ms, reply};
use serde::Deserialize;
use serde_json::Value;
use worker::{Headers, Method, Response, Result};

use crate::{Integrations, Secrets, ask, ask_loop, ask_tools, auto, fail, http, https, local_day, models, optional};
use g1t_secrets as crypto;

/// The methods this module answers.
pub const METHODS: &[&str] =
    &["ai_list", "ai_add", "ai_update", "ai_remove", "ai_test", "ask_settings", "set_ask_settings", "ask", "ai_brief"];

/// Answers one of [`METHODS`].
pub async fn route(service: &Integrations, method: &str, body: Value) -> Result<Response> {
    match method {
        "ai_list" => reply(&service.ai_list(args(body)?).await?),
        "ai_add" => reply(&service.ai_add(args(body)?).await?),
        "ai_update" => reply(&service.ai_update(args(body)?).await?),
        "ai_remove" => reply(&service.ai_remove(args(body)?).await?),
        "ai_test" => reply(&service.ai_test(args(body)?).await?),
        "ask_settings" => reply(&service.ask_settings(args(body)?).await?),
        "set_ask_settings" => reply(&service.set_ask_settings(args(body)?).await?),
        "ask" => service.ask(args(body)?).await,
        "ai_brief" => reply(&service.ai_brief(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Tokens a brief's model may spend thinking before it answers, beyond
/// the answer's own length. Current models think by default (Claude Haiku
/// 5.5 among them, at effort `medium`) and count it against `max_tokens`:
/// held to the answer's length alone, they used all of it thinking and
/// answered nothing, so session titles and the plan's suggestions came back
/// empty. Turning thinking off is refused by some (Claude Opus 5.5, Claude
/// Sonnet 5.5), so the room is given instead; callers keep only a short
/// answer whatever comes back.
const BRIEF_THINKING_ROOM: u32 = 2_048;

/// The `max_tokens` a brief asking for an answer of `asked` tokens sends.
fn brief_room(asked: u32) -> u32 {
    asked.clamp(1, MAX_BRIEF_TOKENS) + BRIEF_THINKING_ROOM
}

const NO_SUCH: &str = "No such AI provider.";
const NO_SEALER: &str = "AI providers are not set up on this g1t: it has no key to keep secrets with.";

/// A row of `ai_providers`.
#[derive(Deserialize)]
pub(crate) struct AiRow {
    pub(crate) id: String,
    pub(crate) workspace: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    pub(crate) config: String,
    pub(crate) secrets: Option<String>,
    pub(crate) secret_hint: Option<String>,
    pub(crate) created_by: String,
    pub(crate) created_at: String,
    pub(crate) last_used_at: Option<String>,
    pub(crate) last_error: Option<String>,
    pub(crate) models: Option<String>,
}

impl AiRow {
    pub(crate) fn provider(&self) -> AiProvider {
        AiProvider::parse(&self.provider).unwrap_or(AiProvider::OpenaiEndpoint)
    }

    pub(crate) fn config(&self) -> AiConfig {
        serde_json::from_str(&self.config).unwrap_or_default()
    }

    /// The models it offered when last checked.
    pub(crate) fn models(&self) -> Vec<String> {
        self.models.as_deref().and_then(|models| serde_json::from_str(models).ok()).unwrap_or_default()
    }
}

fn to_ai(row: &AiRow) -> AiConnection {
    let provider = row.provider();
    AiConnection {
        id: row.id.clone(),
        workspace: row.workspace.clone(),
        provider,
        group: provider.group(),
        name: row.name.clone(),
        config: row.config(),
        secret_hint: row.secret_hint.clone(),
        created_by: row.created_by.clone(),
        created_at: row.created_at.clone(),
        last_used_at: row.last_used_at.clone(),
        last_error: row.last_error.clone(),
        models: row.models(),
    }
}

/// Only an owner, as a person, changes a workspace's AI.
fn owner_only<T>(actor: &User, workspace: &str) -> Option<Outcome<T>> {
    (actor.role_in(workspace) != Some(Role::Owner) || actor.kind != PrincipalKind::User)
        .then(|| fail(FailureCode::Forbidden, "Only an owner of the workspace can manage its AI providers."))
}

/// A Console workspace's id from the id itself or any Console address in
/// that workspace (`…/workspaces/<id>/…`).
fn console_workspace(given: &str) -> Option<String> {
    let id = match given.split_once("/workspaces/") {
        Some((_, rest)) => rest.split(['/', '?', '#']).next().unwrap_or_default(),
        None => given,
    };
    let valid = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then(|| id.to_owned())
}

/// Checks an AI provider's settings, tidying them. The message says what
/// to fix.
fn check_config(provider: AiProvider, config: &mut AiConfig, secret: Option<&str>) -> std::result::Result<(), String> {
    if let Some(value) = &mut config.base_url {
        *value = value.trim().trim_end_matches('/').to_owned();
        if !https(value) {
            return Err("Addresses must start with https://.".to_owned());
        }
    }
    for value in [&mut config.model, &mut config.auth_header] {
        *value = value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned);
    }
    config.console_workspace = match config.console_workspace.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(given) if provider == AiProvider::Anthropic => Some(console_workspace(given).ok_or_else(|| {
            "Give the Console workspace's id, such as wrkspc_01AbC…, or paste an address from that workspace in the Console.".to_owned()
        })?),
        _ => None,
    };
    let needs = |present: bool, what: &str| if present { Ok(()) } else { Err(what.to_owned()) };
    match provider {
        AiProvider::AzureOpenai => {
            needs(config.base_url.is_some(), "Give your Azure OpenAI resource's endpoint, such as https://acme.openai.azure.com.")?;
            needs(config.model.is_some(), "Give the name of the deployment to use.")?;
            needs(secret.is_some(), "Paste the resource's key.")
        }
        AiProvider::AnthropicEndpoint | AiProvider::OpenaiEndpoint => {
            needs(config.base_url.is_some(), "Give the endpoint's address.")?;
            if let Some(header) = &config.auth_header
                && header != "x-api-key"
                && header != "authorization"
            {
                return Err("Send the key as x-api-key or authorization.".to_owned());
            }
            Ok(())
        }
        // Every other AI provider is at a known address and needs only a key.
        _ => needs(secret.is_some(), &format!("Paste your {} API key.", provider.label())),
    }
}

impl Integrations {
    pub(crate) fn ai_secret(&self, row: &AiRow) -> Option<String> {
        let (Some(sealer), Some(sealed)) = (&self.sealer, &row.secrets) else {
            return None;
        };
        sealer.open(sealed, &row.id).and_then(|plain| serde_json::from_str::<Secrets>(&plain).ok()).and_then(|secrets| secrets.secret)
    }

    fn ai_seal(&self, id: &str, secret: Option<&str>) -> Option<String> {
        let sealer = self.sealer.as_ref()?;
        let secrets = Secrets { secret: Some(secret?.to_owned()), signing_secret: None };
        Some(sealer.seal(&serde_json::to_string(&secrets).unwrap_or_default(), id))
    }

    pub(crate) async fn ai_row(&self, id: &str) -> Result<Option<AiRow>> {
        self.db.prepare("SELECT * FROM ai_providers WHERE id = ?").bind(&[id.into()])?.first::<AiRow>(None).await
    }

    pub(crate) async fn ai_rows(&self, workspace: &str) -> Result<Vec<AiRow>> {
        self.db
            .prepare("SELECT * FROM ai_providers WHERE workspace = ? ORDER BY id")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<AiRow>()
    }

    /// The AI provider, if it is in `workspace`.
    pub(crate) async fn ai_row_in(&self, workspace: &str, id: &str) -> Result<Option<AiRow>> {
        Ok(self.ai_row(id).await?.filter(|row| row.workspace == workspace))
    }

    /// Notes that talking to a provider worked, or what went wrong.
    pub(crate) async fn ai_note(&self, id: &str, problem: Option<&str>) -> Result<()> {
        let now = rfc3339(now_ms());
        match problem {
            None => self
                .db
                .prepare("UPDATE ai_providers SET last_used_at = ?, last_error = NULL WHERE id = ?")
                .bind(&[now.into(), id.into()])?,
            Some(problem) => self
                .db
                .prepare("UPDATE ai_providers SET last_error = ? WHERE id = ?")
                .bind(&[format!("{now}: {problem}").into(), id.into()])?,
        }
        .run()
        .await?;
        Ok(())
    }

    /// Keeps what a check found: the models it offers, or what went wrong.
    async fn ai_checked(&self, id: &str, checked: &std::result::Result<(String, Vec<String>), String>) -> Result<()> {
        if let Ok((_, models)) = checked
            && !models.is_empty()
        {
            self.db
                .prepare("UPDATE ai_providers SET models = ? WHERE id = ?")
                .bind(&[serde_json::to_string(models)?.into(), id.into()])?
                .run()
                .await?;
        }
        self.ai_note(id, checked.as_ref().err().map(String::as_str)).await
    }

    // --- The workspace's AI providers -------------------------------------------

    async fn ai_list(&self, a: ListAiArgs) -> Result<Outcome<Vec<AiConnection>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(fail(FailureCode::Forbidden, "Only members can see a workspace's AI providers."));
        }
        Ok(Outcome::Ok(self.ai_rows(&workspace).await?.iter().map(to_ai).collect()))
    }

    async fn ai_add(&self, a: AddAiArgs) -> Result<Outcome<AiConnection>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        if self.sealer.is_none() {
            return Ok(fail(FailureCode::Conflict, NO_SEALER));
        }
        let provider = a.provider;
        let tidy = |value: Option<String>| value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let secret = tidy(a.secret);
        let mut config = a.config;
        if let Err(problem) = check_config(provider, &mut config, secret.as_deref()) {
            return Ok(fail(FailureCode::Invalid, problem));
        }
        let now = now_ms();
        let id = new_id("aip", now);
        let name = tidy(a.name).unwrap_or_else(|| provider.label().to_owned());
        self.db
            .prepare(
                "INSERT INTO ai_providers
                   (id, workspace, provider, name, config, secrets, secret_hint, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                workspace.as_str().into(),
                provider.name().into(),
                name.chars().take(80).collect::<String>().into(),
                serde_json::to_string(&config)?.into(),
                optional(self.ai_seal(&id, secret.as_deref()).as_deref()),
                optional(secret.as_deref().map(crypto::hint).as_deref()),
                a.actor.username.as_str().into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        // Checked at once, which also learns its models.
        let checked = models::test(provider, &config, secret.as_deref()).await?;
        self.ai_checked(&id, &checked).await?;
        let Some(row) = self.ai_row(&id).await? else {
            return Ok(fail(FailureCode::NotFound, "The AI provider was not saved."));
        };
        Ok(Outcome::Ok(to_ai(&row)))
    }

    async fn ai_update(&self, a: UpdateAiArgs) -> Result<Outcome<AiConnection>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        let Some(row) = self.ai_row_in(&workspace, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, NO_SUCH));
        };
        let tidy = |value: Option<String>| value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let secret = tidy(a.secret).or_else(|| self.ai_secret(&row));
        let mut config = a.config.unwrap_or_else(|| row.config());
        if let Err(problem) = check_config(row.provider(), &mut config, secret.as_deref()) {
            return Ok(fail(FailureCode::Invalid, problem));
        }
        let name = tidy(a.name).unwrap_or(row.name.clone());
        self.db
            .prepare("UPDATE ai_providers SET name = ?, config = ?, secrets = ?, secret_hint = ?, last_error = NULL WHERE id = ?")
            .bind(&[
                name.chars().take(80).collect::<String>().into(),
                serde_json::to_string(&config)?.into(),
                optional(self.ai_seal(&row.id, secret.as_deref()).as_deref()),
                optional(secret.as_deref().map(crypto::hint).as_deref()),
                row.id.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(row) = self.ai_row(&row.id).await? else {
            return Ok(fail(FailureCode::NotFound, NO_SUCH));
        };
        Ok(Outcome::Ok(to_ai(&row)))
    }

    async fn ai_remove(&self, a: AiConnectionArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        let Some(row) = self.ai_row_in(&workspace, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, NO_SUCH));
        };
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM ai_providers WHERE id = ?").bind(&[row.id.as_str().into()])?,
                // Ask stops answering with it.
                self.db.prepare("DELETE FROM ai_routes WHERE provider_id = ?").bind(&[row.id.as_str().into()])?,
                self.db.prepare("DELETE FROM managed_agents WHERE connection_id = ?").bind(&[row.id.as_str().into()])?,
            ])
            .await?;
        Ok(Outcome::Ok(true))
    }

    async fn ai_test(&self, a: AiConnectionArgs) -> Result<Outcome<Tested>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        let Some(row) = self.ai_row_in(&workspace, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, NO_SUCH));
        };
        let checked = models::test(row.provider(), &row.config(), self.ai_secret(&row).as_deref()).await?;
        self.ai_checked(&row.id, &checked).await?;
        Ok(Outcome::Ok(match checked {
            Ok((message, _)) => Tested { ok: true, message },
            Err(message) => Tested { ok: false, message },
        }))
    }

    // --- Ask g1t -------------------------------------------------------------------

    /// What Ask answers with: the owner's choice, kept as the workspace's
    /// `ask` route, and the AI provider it names.
    pub(crate) async fn ask_setup(&self, workspace: &str) -> Result<(AskSetup, Option<AiRow>)> {
        #[derive(Deserialize)]
        struct Route {
            provider_id: Option<String>,
            model: Option<String>,
            #[serde(default)]
            auto: u32,
        }
        let route = self
            .db
            .prepare("SELECT provider_id, model, auto FROM ai_routes WHERE workspace = ? AND task = ?")
            .bind(&[workspace.into(), ASK_TASK.into()])?
            .first::<Route>(None)
            .await?;
        let Some(id) = route.as_ref().and_then(|route| route.provider_id.clone()) else {
            return Ok((
                AskSetup { problem: Some("No AI provider is chosen for Ask in this workspace yet.".to_owned()), ..AskSetup::default() },
                None,
            ));
        };
        let Some(row) = self.ai_row_in(workspace, &id).await? else {
            return Ok((
                AskSetup { problem: Some("The AI provider chosen for Ask was removed. Choose another.".to_owned()), ..AskSetup::default() },
                None,
            ));
        };
        let auto = route.as_ref().is_some_and(|route| route.auto == 1);
        // With Auto, a model is named only when the provider offers just
        // its own: an endpoint that lists none, or an Azure deployment.
        let model = if auto {
            auto_models(&row).is_empty().then(|| row.config().model).flatten()
        } else {
            route.and_then(|route| route.model).or_else(|| row.config().model)
        }
        .filter(|model| !model.trim().is_empty());
        let problem = if auto && model.is_none() && auto_models(&row).is_empty() {
            Some(format!("{} has listed no models for Auto to choose from. Test it to list them, or choose a model for Ask.", row.name))
        } else if !auto && model.is_none() {
            Some("No model is chosen for Ask.".to_owned())
        } else if self.sealer.is_none() {
            Some(NO_SEALER.to_owned())
        } else if !row.provider().own_address() && self.ai_secret(&row).is_none() {
            Some(format!("The key for {} cannot be read. Replace it.", row.name))
        } else {
            None
        };
        Ok((
            AskSetup {
                provider_id: Some(row.id.clone()),
                provider_name: Some(row.name.clone()),
                provider: Some(row.provider()),
                model,
                auto,
                problem,
            },
            Some(row),
        ))
    }

    pub(crate) async fn ask_settings(&self, a: AskSettingsArgs) -> Result<Outcome<AskSetup>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(fail(FailureCode::Forbidden, "Only members can use Ask in a workspace."));
        }
        Ok(Outcome::Ok(self.ask_setup(&workspace).await?.0))
    }

    pub(crate) async fn set_ask_settings(&self, a: SetAskSettingsArgs) -> Result<Outcome<AskSetup>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        let Some(id) = a.provider_id.map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()) else {
            self.db
                .prepare("DELETE FROM ai_routes WHERE workspace = ? AND task = ?")
                .bind(&[workspace.as_str().into(), ASK_TASK.into()])?
                .run()
                .await?;
            return Ok(Outcome::Ok(self.ask_setup(&workspace).await?.0));
        };
        let Some(row) = self.ai_row_in(&workspace, &id).await? else {
            return Ok(fail(FailureCode::NotFound, NO_SUCH));
        };
        let connection = to_ai(&row);
        let auto = chose_auto(a.model.as_deref());
        let model = if auto {
            None
        } else {
            match ask_model(&connection, a.model.as_deref()) {
                Ok(model) => model,
                Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
            }
        };
        self.db
            .prepare(
                "INSERT INTO ai_routes (workspace, task, provider_id, model, auto) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (workspace, task) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, auto = excluded.auto",
            )
            .bind(&[workspace.as_str().into(), ASK_TASK.into(), row.id.as_str().into(), optional(model.as_deref()), u32::from(auto).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.ask_setup(&workspace).await?.0))
    }

    /// The work item or pull request the person is looking at, as they may
    /// see it. Nothing when there is none or they cannot.
    pub(crate) async fn ask_facts(&self, actor: &User, page: &AskPage) -> Result<Vec<ask::Fact>> {
        let state = |value: Value| value.as_str().unwrap_or_default().to_owned();
        let mut facts = Vec::new();
        let workspace = page.repo.as_ref().map(|repo| repo.namespace.to_lowercase()).or_else(|| page.workspace.clone());
        if let (Some(number), Some(workspace)) = (page.item, workspace) {
            let view = WorkItemViewArgs { workspace, number, viewer: Some(actor.clone()) };
            let found: Outcome<WorkItemDetail> = g1t_kit::call(&self.work, "get_work_item", &view).await?;
            if let Outcome::Ok(detail) = found {
                facts.push(ask::Fact {
                    kind: "work item",
                    number,
                    state: state(serde_json::to_value(detail.item.state)?),
                    title: detail.item.title,
                    body: http::shorten(&detail.item.body, ASK_FACT_CHARS),
                });
            }
        }
        let Some(repo) = &page.repo else {
            return Ok(facts);
        };
        let view = |number: u32| ViewArgs { repo: repo.clone(), number, viewer: Some(actor.clone()), after_seq: 0 };
        if let Some(number) = page.pull {
            let found: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view(number)).await?;
            if let Outcome::Ok(detail) = found {
                facts.push(ask::Fact {
                    kind: "pull request",
                    number,
                    state: state(serde_json::to_value(detail.pull.status)?),
                    body: http::shorten(detail.pull.body.as_deref().unwrap_or_default(), ASK_FACT_CHARS),
                    title: detail.pull.title,
                });
            }
        }
        Ok(facts)
    }

    /// One answer, streamed: see [`AskArgs`] and ask_loop.rs.
    ///
    /// Before the provider is asked, identity makes the answer's read-only
    /// credential for the person asking, and g1t's MCP server lists the
    /// tools it may use. Without them the answer still comes, from the page
    /// alone, and says so.
    pub(crate) async fn ask(&self, a: AskArgs) -> Result<Response> {
        let started = now_ms();
        let workspace = a.workspace.to_lowercase();
        if !a.actor.is_member(&workspace) {
            return ask_refusal("Only members can use Ask in this workspace.");
        }
        let messages = match ask::conversation(a.messages) {
            Ok(messages) => messages,
            Err(problem) => return ask_refusal(&problem),
        };
        let (setup, row) = self.ask_setup(&workspace).await?;
        let (Some(row), None) = (row, setup.problem.clone()) else {
            return ask_refusal(setup.problem.as_deref().unwrap_or("Ask is not set up in this workspace."));
        };
        // Auto picks for this question; otherwise the model chosen.
        let model = if setup.auto {
            auto::choose(&auto_models(&row), row.config().model.as_deref(), auto::need(&messages))
        } else {
            setup.model.clone()
        };
        let Some(model) = model else {
            return ask_refusal("No model is chosen for Ask.");
        };
        let provider = row.provider();
        let config = row.config();
        let key = self.ai_secret(&row);
        let (named, facts, credential, profile) = futures_util::future::join4(
            g1t_kit::call::<_, Option<Workspace>>(&self.identity, "get_workspace", &SlugArgs { slug: workspace.clone() }),
            self.ask_facts(&a.actor, &a.page),
            g1t_kit::call::<_, Outcome<AskToken>>(
                &self.identity,
                "create_ask_token",
                &CreateAskTokenArgs { actor: a.actor.clone(), workspace: workspace.clone() },
            ),
            // Their time zone, for what "today" means to them.
            g1t_kit::call::<_, Option<Profile>>(&self.identity, "profile", &UsernameArgs { username: a.actor.username.clone() }),
        )
        .await;
        let name = named.ok().flatten().map(|found| found.name).unwrap_or_default();
        // Without what the page is about, the answer can still come.
        let facts = facts.unwrap_or_default();
        let credential = match credential {
            Ok(Outcome::Ok(credential)) => Some(credential),
            Ok(Outcome::Fail(refused)) => {
                worker::console_error!("ask: no credential for the tools: {}", refused.message);
                None
            }
            Err(error) => {
                worker::console_error!("ask: no credential for the tools: {error}");
                None
            }
        };
        let mcp = credential.as_ref().map(|credential| ask_tools::Mcp { url: self.mcp_url.clone(), token: credential.token.clone() });
        let listed = match &mcp {
            Some(mcp) => mcp.list().await.unwrap_or_else(|problem| {
                worker::console_error!("ask: g1t's tools could not be listed: {problem}");
                Vec::new()
            }),
            None => Vec::new(),
        };
        let toolbox = ask_tools::Toolbox::new(listed, ask_tools::native());
        let now = rfc3339(started);
        let today: String = now.chars().take(10).collect();
        let now: String = format!("{}Z", now.chars().take(19).collect::<String>());
        // Their profile's zone first, else the one their browser sent.
        let zone = profile
            .ok()
            .flatten()
            .and_then(|profile| profile.timezone)
            .or_else(|| a.page.time_zone.clone())
            .filter(|zone| !zone.trim().is_empty() && zone.len() <= 64);
        let day = zone.as_deref().and_then(|zone| local_day::today(zone, started));
        let day_started = day.as_ref().map(local_day::started_at);
        let local = match (&zone, &day, &day_started) {
            (Some(zone), Some(day), Some(started)) => Some((zone.as_str(), day.date.as_str(), started.as_str())),
            _ => None,
        };
        let username = a.actor.display_username.clone().unwrap_or_else(|| a.actor.username.clone());
        let system = ask::system_prompt(&ask::Context {
            slug: &workspace,
            name: &name,
            username: &username,
            site: &self.site_url,
            today: &today,
            now: &now,
            page: &a.page,
            facts: &facts,
            tools: !toolbox.is_empty(),
            local,
        });
        let mut answering = ask_loop::Answering::new(
            provider,
            config,
            key,
            model.clone(),
            system,
            messages,
            ASK_MAX_OUTPUT_TOKENS,
            toolbox,
            mcp,
            self.site_url.clone(),
            self.identity.clone(),
            credential.map(|credential| credential.id),
            started,
        );
        // The first round is asked here, so a provider that refuses is a
        // refusal with its reason, and the provider notes it.
        let built = match answering.request() {
            Ok(built) => built,
            Err(problem) => return self.ask_refused(answering, &problem).await,
        };
        let headers: Vec<(&str, &str)> = built.headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
        let mut response = match http::open(Method::Post, &built.url, &headers, Some(built.body)).await {
            Ok(response) => response,
            Err(error) => {
                let problem = format!("{} could not be reached: {error}", provider.label());
                self.ai_note(&row.id, Some(&problem)).await?;
                return self.ask_refused(answering, &problem).await;
            }
        };
        let status = response.status_code();
        if !(200..300).contains(&status) {
            let problem = ask_loop::refused_by(provider, status, response.text().await.unwrap_or_default());
            self.ai_note(&row.id, Some(&problem)).await?;
            return self.ask_refused(answering, &problem).await;
        }
        self.ai_note(&row.id, None).await?;
        let meta = ask::line(&AskEvent::Meta { provider, provider_label: provider.label().to_owned(), model, auto: setup.auto });
        answering.streaming(response.stream()?, meta);
        let lines = futures_util::stream::unfold(answering, |mut answering| async move {
            let line = answering.next().await?;
            Some((Ok::<Vec<u8>, worker::Error>(line.into_bytes()), answering))
        });
        let headers = Headers::new();
        headers.set("content-type", ASK_CONTENT_TYPE)?;
        headers.set("cache-control", "no-store")?;
        Ok(Response::from_stream(lines)?.with_headers(headers))
    }

    /// A short answer for g1t's own use (`AiBriefArgs`): the workspace's
    /// Ask provider, on its fast model when it lists one, without tools.
    /// None when the workspace has chosen none, or it cannot be used.
    pub(crate) async fn ai_brief(&self, a: AiBriefArgs) -> Result<Outcome<Option<String>>> {
        let workspace = a.workspace.to_lowercase();
        let (setup, row) = self.ask_setup(&workspace).await?;
        let (Some(row), None) = (row, setup.problem) else {
            return Ok(Outcome::Ok(None));
        };
        let model =
            if setup.auto { auto::choose(&auto_models(&row), row.config().model.as_deref(), auto::Need::Quick) } else { setup.model };
        let Some(model) = model else {
            return Ok(Outcome::Ok(None));
        };
        let provider = row.provider();
        let config = row.config();
        let key = self.ai_secret(&row);
        let input: String = a.input.chars().take(MAX_BRIEF_INPUT_CHARS).collect();
        let messages = [AskMessage { role: AskRole::User, content: input }];
        let built = match ask::build(&ask::Request {
            provider,
            config: &config,
            key: key.as_deref(),
            model: &model,
            system: &a.system,
            messages: &messages,
            rounds: &[],
            tools: &[],
            answer_now: false,
            max_tokens: brief_room(a.max_tokens),
        }) {
            Ok(built) => built,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let headers: Vec<(&str, &str)> = built.headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
        let mut response = match http::open(Method::Post, &built.url, &headers, Some(built.body)).await {
            Ok(response) => response,
            Err(error) => return Ok(fail(FailureCode::Unavailable, format!("{} could not be reached: {error}", provider.label()))),
        };
        let status = response.status_code();
        if !(200..300).contains(&status) {
            let problem = ask_loop::refused_by(provider, status, response.text().await.unwrap_or_default());
            self.ai_note(&row.id, Some(&problem)).await?;
            return Ok(fail(FailureCode::Unavailable, problem));
        }
        let bytes = response.bytes().await?;
        let mut round = ask::Round::new(provider, false);
        round.feed(&bytes);
        round.end();
        if let Some(problem) = round.error() {
            return Ok(fail(FailureCode::Unavailable, problem.to_owned()));
        }
        let text = round.text().trim().to_owned();
        Ok(Outcome::Ok((!text.is_empty()).then_some(text)))
    }

    /// An answer that never started: its credential ends now.
    pub(crate) async fn ask_refused(&self, mut answering: ask_loop::Answering, problem: &str) -> Result<Response> {
        if let Some(id) = answering.credential.take() {
            let _: Result<bool> = g1t_kit::call(&self.identity, "revoke_ask_token", &RevokeAskTokenArgs { id }).await;
        }
        ask_refusal(problem)
    }
}

/// The route that holds the workspace's choice for Ask g1t.
const ASK_TASK: &str = "ask";
/// How much of a work item's or pull request's description Ask is given.
const ASK_FACT_CHARS: usize = 6_000;
const ASK_CONTENT_TYPE: &str = "application/x-ndjson; charset=utf-8";

/// The model Ask uses on `connection`: the one chosen, else the
/// provider's own (an Azure deployment). One the provider listed when it
/// was last checked, where it lists them and it is not an Azure deployment.
fn ask_model(connection: &AiConnection, chosen: Option<&str>) -> std::result::Result<Option<String>, String> {
    let chosen = chosen.map(str::trim).filter(|model| !model.is_empty());
    let Some(model) = chosen.map(str::to_owned).or_else(|| connection.config.model.clone()) else {
        return Err("Choose a model for Ask.".to_owned());
    };
    if model.chars().count() > 200 {
        return Err("That model's name is too long.".to_owned());
    }
    let checks_list = connection.provider != AiProvider::AzureOpenai && !connection.models.is_empty();
    if chosen.is_some() && checks_list && !connection.models.iter().any(|offered| offered == &model) {
        return Err(format!("{} does not offer {model}. Test it to list its models again.", connection.name));
    }
    Ok(Some(model))
}

/// Whether a choice of model for Ask is Auto: [`ASK_AUTO_MODEL`], in any case.
fn chose_auto(chosen: Option<&str>) -> bool {
    chosen.is_some_and(|model| model.trim().eq_ignore_ascii_case(ASK_AUTO_MODEL))
}

/// The models Auto chooses among on a provider: those it listed, except
/// on Azure, whose requests name the owner's deployment, not a model.
fn auto_models(row: &AiRow) -> Vec<String> {
    if row.provider() == AiProvider::AzureOpenai { Vec::new() } else { row.models() }
}

/// An `ask` that cannot be answered: one `error` line.
fn ask_refusal(message: &str) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", ASK_CONTENT_TYPE)?;
    headers.set("cache-control", "no-store")?;
    Ok(Response::ok(ask::line(&AskEvent::Error { message: message.to_owned() }))?.with_headers(headers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_brief_leaves_its_model_room_to_think_before_it_answers() {
        assert_eq!(brief_room(40), 40 + BRIEF_THINKING_ROOM);
        // Never more answer than a brief may ask for, never none.
        assert_eq!(brief_room(10_000), MAX_BRIEF_TOKENS + BRIEF_THINKING_ROOM);
        assert_eq!(brief_room(0), 1 + BRIEF_THINKING_ROOM);
    }

    #[test]
    fn an_ai_provider_needs_its_key_and_its_address_when_it_has_no_known_one() {
        let key = Some("sk-test");
        let none = None;
        let mut config = AiConfig::default();
        assert!(check_config(AiProvider::Anthropic, &mut config, key).is_ok());
        assert_eq!(check_config(AiProvider::Openai, &mut AiConfig::default(), none).unwrap_err(), "Paste your OpenAI API key.");
        // Your own endpoint needs its address, over https, and a known header.
        assert!(check_config(AiProvider::OpenaiEndpoint, &mut AiConfig::default(), none).is_err());
        let mut endpoint = AiConfig { base_url: Some(" https://llm.acme.dev/v1/ ".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::OpenaiEndpoint, &mut endpoint, none).is_ok());
        assert_eq!(endpoint.base_url.as_deref(), Some("https://llm.acme.dev/v1"));
        let mut plain = AiConfig { base_url: Some("http://llm.acme.dev".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::AnthropicEndpoint, &mut plain, key).is_err());
        let mut header =
            AiConfig { base_url: Some("https://llm.acme.dev".into()), auth_header: Some("x-token".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::AnthropicEndpoint, &mut header, key).is_err());
        // Azure needs its resource and deployment as well as the key.
        let mut azure = AiConfig { base_url: Some("https://acme.openai.azure.com".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::AzureOpenai, &mut azure, key).is_err());
        azure.model = Some("gpt-5".into());
        assert!(check_config(AiProvider::AzureOpenai, &mut azure, key).is_ok());
    }

    #[test]
    fn an_anthropic_providers_console_workspace_is_its_id_from_an_address_or_itself() {
        let key = Some("sk-test");
        let mut pasted = AiConfig {
            console_workspace: Some(" https://platform.claude.com/workspaces/wrkspc_01AbC/sessions/sesn_1?event=e ".into()),
            ..AiConfig::default()
        };
        assert!(check_config(AiProvider::Anthropic, &mut pasted, key).is_ok());
        assert_eq!(pasted.console_workspace.as_deref(), Some("wrkspc_01AbC"));
        let mut bare = AiConfig { console_workspace: Some("wrkspc_01AbC".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::Anthropic, &mut bare, key).is_ok());
        assert_eq!(bare.console_workspace.as_deref(), Some("wrkspc_01AbC"));
        let mut empty = AiConfig { console_workspace: Some("  ".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::Anthropic, &mut empty, key).is_ok());
        assert_eq!(empty.console_workspace, None);
        let mut wrong = AiConfig { console_workspace: Some("not a workspace".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::Anthropic, &mut wrong, key).is_err());
        // Only Anthropic's Console has workspaces to link to.
        let mut other = AiConfig { console_workspace: Some("wrkspc_01AbC".into()), ..AiConfig::default() };
        assert!(check_config(AiProvider::Openai, &mut other, key).is_ok());
        assert_eq!(other.console_workspace, None);
    }

    fn connection(provider: AiProvider, model: Option<&str>, models: &[&str]) -> AiConnection {
        AiConnection {
            id: "con_1".into(),
            workspace: "acme".into(),
            provider,
            group: provider.group(),
            name: "Team key".into(),
            config: AiConfig { model: model.map(str::to_owned), ..AiConfig::default() },
            secret_hint: None,
            created_by: "ana".into(),
            created_at: "2026-10-12T00:00:00Z".into(),
            last_used_at: None,
            last_error: None,
            models: models.iter().map(|model| (*model).to_owned()).collect(),
        }
    }

    #[test]
    fn asks_model_is_one_the_provider_offers_or_its_own() {
        let listed = connection(AiProvider::Openai, None, &["gpt-5", "gpt-5-mini"]);
        assert_eq!(ask_model(&listed, Some(" gpt-5 ")).unwrap().as_deref(), Some("gpt-5"));
        assert!(ask_model(&listed, Some("gpt-4")).unwrap_err().contains("does not offer gpt-4"));
        assert_eq!(ask_model(&listed, None).unwrap_err(), "Choose a model for Ask.");
        // The provider's own model when none is chosen.
        let own = connection(AiProvider::Anthropic, Some("claude-x"), &[]);
        assert_eq!(ask_model(&own, Some("")).unwrap().as_deref(), Some("claude-x"));
        // An endpoint that lists nothing takes what the owner writes.
        let open = connection(AiProvider::OpenaiEndpoint, None, &[]);
        assert_eq!(ask_model(&open, Some("qwen3-coder")).unwrap().as_deref(), Some("qwen3-coder"));
        // Azure lists base models, not deployments: its deployment stands.
        let azure = connection(AiProvider::AzureOpenai, Some("prod-gpt"), &["gpt-5"]);
        assert_eq!(ask_model(&azure, Some("prod-gpt")).unwrap().as_deref(), Some("prod-gpt"));
        assert!(ask_model(&own, Some(&"m".repeat(201))).is_err());
    }

    fn row(provider: AiProvider, model: Option<&str>, models: &[&str]) -> AiRow {
        AiRow {
            id: "con_1".into(),
            workspace: "acme".into(),
            provider: provider.name().into(),
            name: "Team key".into(),
            config: serde_json::to_string(&AiConfig { model: model.map(str::to_owned), ..AiConfig::default() }).unwrap(),
            secrets: None,
            secret_hint: None,
            created_by: "ana".into(),
            created_at: "2026-10-12T00:00:00Z".into(),
            last_used_at: None,
            last_error: None,
            models: Some(serde_json::to_string(models).unwrap()),
        }
    }

    #[test]
    fn auto_is_chosen_by_name_and_picks_among_what_the_provider_lists() {
        assert!(chose_auto(Some("auto")) && chose_auto(Some(" Auto ")));
        assert!(!chose_auto(Some("claude-haiku-5-5")) && !chose_auto(None) && !chose_auto(Some("")));
        let anthropic = row(AiProvider::Anthropic, None, &["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
        let models = auto_models(&anthropic);
        let simple = [AskMessage { role: AskRole::User, content: "Who is assigned to #12?".into() }];
        let shipped = [AskMessage { role: AskRole::User, content: "What shipped today?".into() }];
        assert_eq!(auto::choose(&models, None, auto::need(&simple)).as_deref(), Some("claude-haiku-5-5"));
        assert_eq!(auto::choose(&models, None, auto::need(&shipped)).as_deref(), Some("claude-sonnet-5-5"));
        // Azure names a deployment, never a listed model: Auto uses it.
        let azure = row(AiProvider::AzureOpenai, Some("prod-gpt"), &["gpt-5", "gpt-5-mini"]);
        assert!(auto_models(&azure).is_empty());
        assert_eq!(auto::choose(&auto_models(&azure), azure.config().model.as_deref(), auto::need(&simple)).as_deref(), Some("prod-gpt"));
    }
}
