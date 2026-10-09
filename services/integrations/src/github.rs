//! g1t's GitHub App: the installations a workspace records, the
//! repositories brought across through them, and the app's webhook.
//!
//! A person installs the app on a GitHub account, and GitHub sends them
//! back to `g1t.sh/integrations/github/setup`. The site asks this service
//! to record the installation against a workspace, which it does only after
//! checking with the person's own GitHub user token (from identity) that
//! the installation is one they can see. Repositories are listed with that
//! same user token, so a person only ever sees what both they and the app
//! can reach.
//!
//! Git goes over HTTPS with an installation access token, which this
//! service gets by signing a JWT as the app (see `github_jwt.rs`) and keeps,
//! sealed, until five minutes before it expires. Tokens are opaque: no
//! length or format is assumed.
//!
//! A repository comes across one of three ways (`GithubMode`): imported
//! once; mirrored, so g1t keeps a standby copy that follows GitHub; or
//! pushed, so GitHub follows g1t. Either way g1t holds a full copy, and the
//! project built from it is hosted on g1t like any other. Mirrored and
//! pushed repositories are links in `remotes` (see `remotes.rs`), which
//! does everything after the import: following pushes, takeovers,
//! hand-backs, moving in.
//!
//! The webhook, `https://api.g1t.sh/hooks/github`, is checked against
//! GITHUB_APP_WEBHOOK_SECRET in constant time, de-duplicated by
//! `X-GitHub-Delivery`, answered with 202 at once and acted on afterwards,
//! as every inbound hook in this service is.

use std::collections::{HashMap, HashSet};

use g1t_contracts::access::{self, Capability};
use g1t_contracts::github::*;
use g1t_contracts::integrations::Received;
use g1t_contracts::mirrors::{MirrorActArgs, MirrorState, RepoMirror};
use g1t_contracts::repos::{CreateArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{Issue, IssueActionArgs, IssueReason, OpenIssueArgs};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, is_valid_repo_name};
use g1t_kit::{args, now_ms, reply};
use g1t_secrets::{self as crypto, Sealer};
use serde::Deserialize;
use serde_json::{Value, json};
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Fetcher, Method, Response, Result};

use crate::github_jwt;
use crate::http::{self, Answer};

const API: &str = "https://api.github.com";
/// An installation token is used until this close to its expiry.
const TOKEN_MARGIN_MS: u64 = 5 * 60 * 1000;
/// The most issues copied in one import, and per page asked of GitHub.
const MAX_ISSUES: usize = 200;
const PER_PAGE: u32 = 50;
/// How long a delivery id is remembered, to drop GitHub's retries.
const DELIVERY_DAYS: u64 = 7;

/// The app, as this g1t is configured. Only `configured()` ones are used.
pub struct AppConfig {
    pub app_id: String,
    pub slug: String,
    pub client_id: String,
    pub private_key: Option<String>,
    pub webhook_secret: Option<String>,
}

impl AppConfig {
    pub fn from_env(env: &Env) -> Self {
        let var = |name: &str| env.var(name).map(|v| v.to_string().trim().to_owned()).unwrap_or_default();
        let secret = |name: &str| {
            env.secret(name)
                .ok()
                .map(|value| value.to_string())
                .filter(|value| !value.trim().is_empty())
        };
        AppConfig {
            app_id: var("GITHUB_APP_ID"),
            slug: var("GITHUB_APP_SLUG"),
            client_id: var("GITHUB_APP_CLIENT_ID"),
            private_key: secret("GITHUB_APP_PRIVATE_KEY"),
            webhook_secret: secret("GITHUB_APP_WEBHOOK_SECRET"),
        }
    }

    pub fn configured(&self) -> bool {
        !self.slug.is_empty() && !self.issuer().is_empty() && self.private_key.is_some()
    }

    /// Who the app's JWTs say they are from: its client ID, as GitHub now
    /// recommends, or its app ID.
    pub fn issuer(&self) -> &str {
        if self.client_id.is_empty() { &self.app_id } else { &self.client_id }
    }

    pub fn install_url(&self) -> String {
        format!("https://github.com/apps/{}/installations/new", self.slug)
    }
}

// --- Pure parts, tested below ----------------------------------------------

/// Milliseconds since the epoch of an RFC 3339 UTC time such as GitHub's
/// `2026-10-05T12:00:00Z`.
pub fn parse_time(text: &str) -> Option<u64> {
    let text = text.trim().trim_end_matches('Z');
    let (date, time) = text.split_once('T')?;
    let mut date = date.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date.next()??, date.next()??, date.next()??);
    let mut time = time.splitn(3, ':');
    let hour: i64 = time.next()?.parse().ok()?;
    let minute: i64 = time.next()?.parse().ok()?;
    let second: f64 = time.next()?.split('+').next()?.parse().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let ms = ((days * 86_400 + hour * 3_600 + minute * 60) as f64 + second) * 1000.0;
    (ms >= 0.0).then_some(ms as u64)
}

/// A g1t repository name for a GitHub one.
pub fn repo_name(github_name: &str) -> String {
    let name: String = github_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    let name = name.trim_start_matches('.');
    name.strip_suffix(".git").unwrap_or(name).chars().take(100).collect()
}

/// Whether a webhook delivery was signed with the app's secret.
pub fn authentic(secret: &str, body: &str, headers: &HashMap<String, String>) -> bool {
    headers
        .get("x-hub-signature-256")
        .is_some_and(|signature| signature.trim().starts_with("sha256=") && crypto::signed(secret, body, signature))
}

/// Labels as g1t keeps them: lowercase, at most 40 characters, ten each.
pub fn labels_of(issue: &Value) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for label in issue["labels"].as_array().into_iter().flatten() {
        let name = label["name"].as_str().or(label.as_str()).unwrap_or_default().trim().to_lowercase();
        if !name.is_empty() && name.chars().count() <= 40 && !labels.contains(&name) {
            labels.push(name);
        }
    }
    labels.truncate(10);
    labels
}

/// The opening of an imported issue's body: where it came from and who
/// wrote it, by their g1t name when their GitHub account is linked.
pub fn imported_header(issue: &Value, full_name: &str, g1t_name: Option<&str>) -> String {
    let login = issue["user"]["login"].as_str().unwrap_or("ghost");
    let author = match g1t_name {
        Some(name) => format!("@{name} (@{login} on GitHub)"),
        None => format!("[@{login}](https://github.com/{login}) on GitHub"),
    };
    let date = issue["created_at"].as_str().unwrap_or_default().get(..10).unwrap_or_default();
    let mut header = format!(
        "> Imported from GitHub: [{full_name}#{}]({}), opened by {author}{}.",
        issue["number"],
        issue["html_url"].as_str().unwrap_or_default(),
        if date.is_empty() { String::new() } else { format!(" on {date}") },
    );
    if let Some(milestone) = issue["milestone"]["title"].as_str() {
        header.push_str(&format!("\n> Milestone: {milestone}"));
    }
    header
}

// --- The service --------------------------------------------------------------

#[derive(Deserialize)]
struct InstallationRow {
    id: u64,
    workspace: String,
    account: String,
    account_type: String,
    repository_selection: String,
    settings_url: String,
    suspended_at: Option<String>,
    created_at: String,
}

impl From<InstallationRow> for GithubInstallation {
    fn from(row: InstallationRow) -> Self {
        GithubInstallation {
            id: row.id,
            workspace: row.workspace,
            account: row.account,
            account_type: row.account_type,
            repository_selection: row.repository_selection,
            suspended: row.suspended_at.is_some(),
            settings_url: row.settings_url,
            created_at: row.created_at,
        }
    }
}

#[derive(Deserialize)]
struct LinkRow {
    repo_id: String,
    repo: String,
    installation_id: u64,
    github_repo_id: u64,
    full_name: String,
    mode: String,
    synced_at: Option<String>,
    last_error: Option<String>,
    issues_imported: u32,
}

impl From<LinkRow> for GithubRepoLink {
    fn from(row: LinkRow) -> Self {
        GithubRepoLink {
            repo_id: row.repo_id,
            repo: row.repo,
            installation_id: row.installation_id,
            github_repo_id: row.github_repo_id,
            full_name: row.full_name,
            mode: GithubMode::parse(&row.mode),
            synced_at: row.synced_at,
            last_error: row.last_error,
            issues_imported: row.issues_imported,
        }
    }
}

/// Issues to copy after an import has answered.
pub struct IssueJob {
    actor: User,
    repo: RepoPath,
    repo_id: String,
    full_name: String,
    installation_id: u64,
}

pub struct GithubApp {
    db: D1Database,
    sealer: Option<Sealer>,
    identity: Fetcher,
    work: Fetcher,
    repos: Fetcher,
    config: AppConfig,
}

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// Why `actor` may not do `capability` to a linked repository, if they may
/// not. Without its visibility at hand, it is taken as private: whoever has
/// no role on it is told it is not found, as for a private one, and the
/// roles that act on it are never had through being public anyway.
fn refused<T>(actor: &User, row: &LinkRow, capability: Capability) -> Option<Outcome<T>> {
    let namespace = row.repo.split('/').next().unwrap_or_default();
    let target = access::RepoRef { id: &row.repo_id, namespace, private: true };
    match access::check(Some(actor), target, capability) {
        Ok(()) => None,
        Err(access::Denied::NotFound) => Some(fail(FailureCode::NotFound, "Repository not found.")),
        Err(access::Denied::Forbidden) => Some(fail(FailureCode::Forbidden, access::needs(capability, &row.repo))),
    }
}

fn null_or(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, Into::into)
}

fn number(value: u64) -> JsValue {
    (value as f64).into()
}

const NOT_SET_UP: &str = "GitHub is not set up on this g1t.";

impl GithubApp {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(GithubApp {
            db: env.d1("DB")?,
            sealer: env.secret("INTEGRATIONS_KEY").ok().and_then(|key| Sealer::new(&key.to_string())),
            identity: env.service("IDENTITY")?,
            work: env.service("WORK")?,
            repos: env.service("REPOS")?,
            config: AppConfig::from_env(env),
        })
    }

    /// GitHub's REST API, with an installation or user token.
    pub(crate) async fn api(&self, method: Method, path: &str, token: &str, body: Option<Value>) -> Result<Answer> {
        self.github(method, path, token, body).await
    }

    async fn github(&self, method: Method, path: &str, token: &str, body: Option<Value>) -> Result<Answer> {
        let authorization = format!("Bearer {token}");
        let url = if path.starts_with("https://") { path.to_owned() } else { format!("{API}{path}") };
        http::send(
            method,
            &url,
            &[
                ("authorization", &authorization),
                ("accept", "application/vnd.github+json"),
                ("x-github-api-version", "2022-11-28"),
            ],
            body.map(|body| body.to_string()),
        )
        .await
    }

    /// The person's GitHub user token, from identity.
    async fn user_token(&self, user: &User) -> Result<Outcome<String>> {
        g1t_kit::call(&self.identity, "github_user_token", &GithubUserTokenArgs { user_id: user.id.clone() }).await
    }

    /// An installation access token, from the cache or fresh from GitHub.
    pub(crate) async fn installation_token(&self, installation_id: u64) -> Result<std::result::Result<String, String>> {
        #[derive(Deserialize)]
        struct Cached {
            token: String,
            expires_ms: f64,
        }
        let bound = format!("ghi:{installation_id}");
        let now = now_ms();
        let cached = self
            .db
            .prepare("SELECT token, expires_ms FROM github_tokens WHERE installation_id = ?")
            .bind(&[number(installation_id)])?
            .first::<Cached>(None)
            .await?;
        if let (Some(cached), Some(sealer)) = (cached, &self.sealer)
            && cached.expires_ms as u64 > now + TOKEN_MARGIN_MS
            && let Some(token) = sealer.open(&cached.token, &bound)
        {
            return Ok(Ok(token));
        }
        let Some(key) = self.config.private_key.as_deref().filter(|_| self.config.configured()) else {
            return Ok(Err(NOT_SET_UP.to_owned()));
        };
        let jwt = github_jwt::app_jwt(self.config.issuer(), key, now / 1000).await?;
        let answer = self
            .github(Method::Post, &format!("/app/installations/{installation_id}/access_tokens"), &jwt, None)
            .await?;
        if !answer.ok() {
            return Ok(Err(answer.problem("GitHub")));
        }
        let body = answer.json();
        let Some(token) = body["token"].as_str().filter(|token| !token.is_empty()).map(str::to_owned) else {
            return Ok(Err("GitHub sent no installation token.".to_owned()));
        };
        // GitHub's tokens last an hour; trust its own expiry when it says.
        let expires = body["expires_at"].as_str().and_then(parse_time).unwrap_or(now + 60 * 60 * 1000);
        if let Some(sealer) = &self.sealer {
            self.db
                .prepare(
                    "INSERT INTO github_tokens (installation_id, token, expires_ms) VALUES (?1, ?2, ?3)
                     ON CONFLICT (installation_id) DO UPDATE SET token = excluded.token, expires_ms = excluded.expires_ms",
                )
                .bind(&[number(installation_id), sealer.seal(&token, &bound).into(), (expires as f64).into()])?
                .run()
                .await?;
        }
        Ok(Ok(token))
    }

    async fn installation(&self, workspace: &str, id: u64) -> Result<Option<InstallationRow>> {
        self.db
            .prepare("SELECT * FROM github_installations WHERE workspace = ? AND id = ?")
            .bind(&[workspace.into(), number(id)])?
            .first::<InstallationRow>(None)
            .await
    }

    async fn link(&self, repo_id: &str) -> Result<Option<LinkRow>> {
        self.db
            .prepare("SELECT * FROM github_repos WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<LinkRow>(None)
            .await
    }

    async fn note(&self, repo_id: &str, problem: Option<&str>) -> Result<()> {
        let sql = if problem.is_some() {
            "UPDATE github_repos SET last_error = ?2 WHERE repo_id = ?1"
        } else {
            "UPDATE github_repos SET last_error = ?2, synced_at = ?3 WHERE repo_id = ?1"
        };
        let statement = self.db.prepare(sql);
        let statement = if problem.is_some() {
            statement.bind(&[repo_id.into(), null_or(problem)])?
        } else {
            statement.bind(&[repo_id.into(), JsValue::NULL, rfc3339(now_ms()).into()])?
        };
        statement.run().await?;
        Ok(())
    }

    pub async fn status(&self, a: GithubStatusArgs) -> Result<Outcome<GithubAppStatus>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_member(&workspace) {
            return Ok(fail(FailureCode::Forbidden, "Only members of the workspace can see its GitHub installations."));
        }
        if !self.config.configured() {
            return Ok(Outcome::Ok(GithubAppStatus::default()));
        }
        let account: GithubAccountView =
            g1t_kit::call(&self.identity, "github_account", &json!({ "user": a.viewer })).await?;
        let installations = self
            .db
            .prepare("SELECT * FROM github_installations WHERE workspace = ? ORDER BY account")
            .bind(&[workspace.as_str().into()])?
            .all()
            .await?
            .results::<InstallationRow>()?;
        Ok(Outcome::Ok(GithubAppStatus {
            configured: true,
            install_url: Some(self.config.install_url()),
            linked: account.account.is_some_and(|account| account.authorized),
            installations: installations.into_iter().map(Into::into).collect(),
        }))
    }

    fn owner_only<T>(actor: &User, workspace: &str) -> Option<Outcome<T>> {
        (actor.role_in(workspace) != Some(Role::Owner) || actor.kind != PrincipalKind::User).then(|| {
            fail(FailureCode::Forbidden, "Only an owner of the workspace can add or remove GitHub accounts.")
        })
    }

    /// Records an installation against a workspace, once the person's own
    /// GitHub token shows it is one they can see.
    pub async fn add_installation(&self, a: GithubInstallationArgs) -> Result<Outcome<GithubInstallation>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = Self::owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        if !self.config.configured() {
            return Ok(fail(FailureCode::NotFound, NOT_SET_UP));
        }
        let token = match self.user_token(&a.actor).await? {
            Outcome::Ok(token) => token,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let mut found = None;
        for page in 1..=5 {
            let answer = self
                .github(Method::Get, &format!("/user/installations?per_page=100&page={page}"), &token, None)
                .await?;
            if !answer.ok() {
                return Ok(fail(FailureCode::Conflict, answer.problem("GitHub")));
            }
            let body = answer.json();
            let listed = body["installations"].as_array().cloned().unwrap_or_default();
            found = listed.iter().find(|item| item["id"].as_u64() == Some(a.installation_id)).cloned();
            if found.is_some() || listed.len() < 100 {
                break;
            }
        }
        let Some(item) = found else {
            return Ok(fail(
                FailureCode::Forbidden,
                "Your GitHub account cannot see that installation. Install the app from your own GitHub account or an organization you manage.",
            ));
        };
        let now = rfc3339(now_ms());
        let row = InstallationRow {
            id: a.installation_id,
            workspace: workspace.clone(),
            account: item["account"]["login"].as_str().unwrap_or_default().to_owned(),
            account_type: item["account"]["type"].as_str().or(item["target_type"].as_str()).unwrap_or("User").to_owned(),
            repository_selection: item["repository_selection"].as_str().unwrap_or("selected").to_owned(),
            settings_url: item["html_url"].as_str().unwrap_or("https://github.com/settings/installations").to_owned(),
            suspended_at: item["suspended_at"].as_str().map(str::to_owned),
            created_at: now,
        };
        self.db
            .prepare(
                "INSERT INTO github_installations
                   (id, workspace, account, account_type, repository_selection, settings_url, suspended_at, added_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT (id, workspace) DO UPDATE SET account = excluded.account,
                   repository_selection = excluded.repository_selection, settings_url = excluded.settings_url,
                   suspended_at = excluded.suspended_at",
            )
            .bind(&[
                number(row.id),
                row.workspace.as_str().into(),
                row.account.as_str().into(),
                row.account_type.as_str().into(),
                row.repository_selection.as_str().into(),
                row.settings_url.as_str().into(),
                null_or(row.suspended_at.as_deref()),
                a.actor.id.as_str().into(),
                row.created_at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(row.into()))
    }

    /// Forgets an installation in a workspace; its mirrors stop. The app
    /// stays installed on GitHub until it is uninstalled there.
    pub async fn remove_installation(&self, a: GithubInstallationArgs, mirrors: Option<&crate::remotes::Mirrors>) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = Self::owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        self.db
            .prepare("DELETE FROM github_installations WHERE workspace = ? AND id = ?")
            .bind(&[workspace.as_str().into(), number(a.installation_id)])?
            .run()
            .await?;
        self.db
            .prepare("UPDATE github_repos SET mode = 'import' WHERE workspace = ? AND installation_id = ?")
            .bind(&[workspace.as_str().into(), number(a.installation_id)])?
            .run()
            .await?;
        if let Some(mirrors) = mirrors {
            let rows = self
                .db
                .prepare("SELECT id FROM remotes WHERE provider = 'github' AND workspace = ? AND connection_id = ?")
                .bind(&[workspace.as_str().into(), a.installation_id.to_string().into()])?
                .all()
                .await?
                .results::<Value>()?;
            for id in rows.iter().filter_map(|row| row["id"].as_str()) {
                mirrors.link_gone(id, "lost its GitHub account in this workspace").await?;
            }
        }
        Ok(Outcome::Ok(true))
    }

    pub async fn repositories(&self, a: GithubRepositoriesArgs) -> Result<Outcome<GithubRepositories>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.is_member(&workspace) {
            return Ok(fail(FailureCode::Forbidden, "Only members of the workspace can bring repositories into it."));
        }
        if self.installation(&workspace, a.installation_id).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "That GitHub account is not connected to this workspace."));
        }
        let token = match self.user_token(&a.actor).await? {
            Outcome::Ok(token) => token,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let page = a.page.unwrap_or(1).max(1);
        let answer = self
            .github(
                Method::Get,
                &format!("/user/installations/{}/repositories?per_page={PER_PAGE}&page={page}", a.installation_id),
                &token,
                None,
            )
            .await?;
        if !answer.ok() {
            return Ok(fail(FailureCode::Conflict, answer.problem("GitHub")));
        }
        let body = answer.json();
        let listed = body["repositories"].as_array().cloned().unwrap_or_default();
        let ids: Vec<u64> = listed.iter().filter_map(|repo| repo["id"].as_u64()).collect();
        let mut linked = HashMap::new();
        if !ids.is_empty() {
            #[derive(Deserialize)]
            struct Linked {
                github_repo_id: u64,
                repo: String,
            }
            let marks = vec!["?"; ids.len()].join(", ");
            let mut bind = vec![JsValue::from(workspace.as_str())];
            bind.extend(ids.iter().map(|id| number(*id)));
            let rows = self
                .db
                .prepare(format!(
                    "SELECT github_repo_id, repo FROM github_repos WHERE workspace = ? AND github_repo_id IN ({marks})"
                ))
                .bind(&bind)?
                .all()
                .await?
                .results::<Linked>()?;
            linked = rows.into_iter().map(|row| (row.github_repo_id, row.repo)).collect();
        }
        Ok(Outcome::Ok(GithubRepositories {
            repositories: listed
                .iter()
                .filter_map(|repo| {
                    let id = repo["id"].as_u64()?;
                    Some(GithubRepository {
                        id,
                        full_name: repo["full_name"].as_str()?.to_owned(),
                        name: repo["name"].as_str()?.to_owned(),
                        private: repo["private"].as_bool().unwrap_or(true),
                        description: repo["description"].as_str().map(str::to_owned),
                        default_branch: repo["default_branch"].as_str().unwrap_or("main").to_owned(),
                        linked_to: linked.get(&id).cloned(),
                    })
                })
                .collect(),
            total: body["total_count"].as_u64().unwrap_or(listed.len() as u64) as u32,
            page,
            per_page: PER_PAGE,
        }))
    }

    /// Brings one GitHub repository across. Returns the issues still to
    /// copy, which the caller does after answering.
    pub async fn import(&self, a: GithubImportArgs) -> Result<(Outcome<GithubRepoLink>, Option<IssueJob>)> {
        let workspace = a.workspace.to_lowercase();
        let refuse = |code, message: &str| Ok((fail(code, message), None));
        if !a.actor.is_member(&workspace) {
            return refuse(FailureCode::Forbidden, "Only members of the workspace can bring repositories into it.");
        }
        if self.installation(&workspace, a.installation_id).await?.is_none() {
            return refuse(FailureCode::NotFound, "That GitHub account is not connected to this workspace.");
        }
        let user_token = match self.user_token(&a.actor).await? {
            Outcome::Ok(token) => token,
            Outcome::Fail(failure) => return Ok((Outcome::Fail(failure), None)),
        };
        // Read with the person's token: only a repository both they and the
        // installation can reach answers.
        let answer = self
            .github(Method::Get, &format!("/repositories/{}", a.github_repo_id), &user_token, None)
            .await?;
        if !answer.ok() {
            return refuse(FailureCode::NotFound, "That GitHub repository is not one you and the app can both reach.");
        }
        let github = answer.json();
        let (Some(full_name), Some(clone_url)) = (github["full_name"].as_str(), github["clone_url"].as_str()) else {
            return refuse(FailureCode::Conflict, "GitHub did not describe the repository.");
        };
        let name = a
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_lowercase)
            .unwrap_or_else(|| repo_name(github["name"].as_str().unwrap_or_default()));
        if !is_valid_repo_name(&name) {
            return refuse(FailureCode::Invalid, "Use letters, digits, dots, hyphens and underscores only.");
        }
        let token = match self.installation_token(a.installation_id).await? {
            Ok(token) => token,
            Err(reason) => return refuse(FailureCode::Conflict, &reason),
        };
        let created: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "create",
            &CreateArgs {
                owner: a.actor.clone(),
                namespace: workspace.clone(),
                name,
                description: github["description"].as_str().map(|text| text.chars().take(200).collect()),
                is_private: a.private.unwrap_or_else(|| github["private"].as_bool().unwrap_or(true)),
                import_url: Some(clone_url.to_owned()),
                import_token: Some(token),
                // A mirror is read-only from the start.
                mirror: (a.mode == GithubMode::Mirror).then(|| RepoMirror {
                    state: MirrorState::Standby,
                    remote: format!("github.com/{full_name}"),
                    url: format!("https://github.com/{full_name}"),
                    since: rfc3339(now_ms()),
                    warm: false,
                    github_workflows: true,
                    hold_deploys: true,
                }),
            },
        )
        .await?;
        let repo = match created {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok((Outcome::Fail(failure), None)),
        };
        let path = format!("{}/{}", repo.namespace, repo.name);
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO github_repos
                   (repo_id, workspace, repo, installation_id, github_repo_id, full_name, mode, synced_at, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?8)",
            )
            .bind(&[
                repo.id.as_str().into(),
                workspace.as_str().into(),
                path.as_str().into(),
                number(a.installation_id),
                number(a.github_repo_id),
                full_name.into(),
                a.mode.as_str().into(),
                now.as_str().into(),
                a.actor.id.as_str().into(),
            ])?
            .run()
            .await?;
        if a.mode != GithubMode::Import {
            let (role, state) = if a.mode == GithubMode::Mirror { ("leader", "standby") } else { ("follower", "following") };
            self.db
                .prepare(
                    "INSERT INTO remotes
                       (id, repo_id, workspace, repo, provider, role, name, url, clone_url, external_id, connection_id,
                        state, state_since, state_by, settings, recorded, synced_at, created_by, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'github', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, '{}', 1, ?12, ?14, ?12)",
                )
                .bind(&[
                    g1t_contracts::new_id("rmt", now_ms()).into(),
                    repo.id.as_str().into(),
                    workspace.as_str().into(),
                    path.as_str().into(),
                    role.into(),
                    format!("github.com/{full_name}").into(),
                    format!("https://github.com/{full_name}").into(),
                    format!("https://github.com/{full_name}.git").into(),
                    a.github_repo_id.to_string().into(),
                    a.installation_id.to_string().into(),
                    state.into(),
                    now.as_str().into(),
                    a.actor.username.as_str().into(),
                    a.actor.id.as_str().into(),
                ])?
                .run()
                .await?;
        }
        let job = a.issues.then(|| IssueJob {
            actor: a.actor.clone(),
            repo: RepoPath {
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
            },
            repo_id: repo.id.clone(),
            full_name: full_name.to_owned(),
            installation_id: a.installation_id,
        });
        let link = self.link(&repo.id).await?.map(GithubRepoLink::from);
        Ok((link.map_or_else(|| fail(FailureCode::NotFound, "The link was not kept."), Outcome::Ok), job))
    }

    /// Copies a repository's issues, oldest first, with their labels,
    /// milestone and state. Pull requests are left: their branches came
    /// with the git data.
    pub async fn copy_issues(&self, job: IssueJob) -> Result<()> {
        let token = match self.installation_token(job.installation_id).await? {
            Ok(token) => token,
            Err(reason) => return self.note(&job.repo_id, Some(&format!("Issues were not copied: {reason}"))).await,
        };
        let mut issues: Vec<Value> = Vec::new();
        let mut more = false;
        for page in 1..=4 {
            let answer = self
                .github(
                    Method::Get,
                    &format!("/repos/{}/issues?state=all&sort=created&direction=asc&per_page=100&page={page}", job.full_name),
                    &token,
                    None,
                )
                .await?;
            if !answer.ok() {
                return self.note(&job.repo_id, Some(&format!("Issues were not copied: {}", answer.problem("GitHub")))).await;
            }
            let listed = answer.json().as_array().cloned().unwrap_or_default();
            let full = listed.len() == 100;
            issues.extend(listed.into_iter().filter(|issue| issue.get("pull_request").is_none()));
            if issues.len() >= MAX_ISSUES {
                more = issues.len() > MAX_ISSUES || full;
                issues.truncate(MAX_ISSUES);
                break;
            }
            if !full {
                break;
            }
        }
        let authors: HashSet<u64> = issues.iter().filter_map(|issue| issue["user"]["id"].as_u64()).collect();
        let names: HashMap<String, String> = g1t_kit::call(
            &self.identity,
            "github_usernames",
            &GithubUsernamesArgs {
                github_ids: authors.into_iter().collect(),
            },
        )
        .await
        .unwrap_or_default();
        let mut copied = 0u32;
        for issue in &issues {
            let g1t_name = issue["user"]["id"].as_u64().and_then(|id| names.get(&id.to_string())).map(String::as_str);
            let mut body = imported_header(issue, &job.full_name, g1t_name);
            if let Some(text) = issue["body"].as_str().filter(|text| !text.trim().is_empty()) {
                body.push_str("\n\n");
                body.push_str(&http::shorten(text.trim(), 60_000));
            }
            let opened: Outcome<Issue> = g1t_kit::call(
                &self.work,
                "open_issue",
                &OpenIssueArgs {
                    actor: job.actor.clone(),
                    repo: job.repo.clone(),
                    title: issue["title"].as_str().unwrap_or("Untitled").chars().take(200).collect(),
                    body,
                    labels: labels_of(issue),
                    checks: Vec::new(),
                    milestone: None,
                },
            )
            .await?;
            let Outcome::Ok(opened) = opened else { continue };
            if issue["state"].as_str() == Some("closed") {
                let reason = if issue["state_reason"].as_str() == Some("not_planned") {
                    IssueReason::NotPlanned
                } else {
                    IssueReason::Completed
                };
                let _: Outcome<Value> = g1t_kit::call(
                    &self.work,
                    "close_issue",
                    &IssueActionArgs {
                        actor: job.actor.clone(),
                        repo: job.repo.clone(),
                        number: opened.number,
                        reason: Some(reason),
                    },
                )
                .await?;
            }
            copied += 1;
        }
        self.db
            .prepare("UPDATE github_repos SET issues_imported = ? WHERE repo_id = ?")
            .bind(&[copied.into(), job.repo_id.as_str().into()])?
            .run()
            .await?;
        if more {
            self.note(&job.repo_id, Some(&format!("Copied the first {MAX_ISSUES} issues; the rest stay on GitHub.")))
                .await?;
        }
        Ok(())
    }

    pub async fn link_for(&self, a: GithubLinkArgs) -> Result<Option<GithubRepoLink>> {
        let Some(row) = self.link(&a.repo_id).await? else { return Ok(None) };
        // What the repository is now is the remote's to say.
        let role = self
            .db
            .prepare("SELECT role FROM remotes WHERE repo_id = ? AND provider = 'github' AND external_id = ?")
            .bind(&[a.repo_id.as_str().into(), row.github_repo_id.to_string().into()])?
            .first::<String>(Some("role"))
            .await?;
        let mut link: GithubRepoLink = row.into();
        link.mode = match role.as_deref() {
            Some("leader") => GithubMode::Mirror,
            Some("follower") => GithubMode::Push,
            _ => GithubMode::Import,
        };
        Ok(Some(link))
    }

    /// Stops a link to GitHub: the g1t repository keeps what it has and is
    /// its own. Refused during a takeover (see `remotes.rs`).
    pub async fn unlink_repo(&self, a: GithubUnlinkRepoArgs, env: &Env) -> Result<Outcome<bool>> {
        let Some(row) = self.link(&a.repo_id).await? else {
            return Ok(Outcome::Ok(false));
        };
        if let Some(refused) = refused(&a.actor, &row, Capability::ManageIntegrations) {
            return Ok(refused);
        }
        let ids = self
            .db
            .prepare("SELECT id FROM remotes WHERE repo_id = ? AND provider = 'github'")
            .bind(&[a.repo_id.as_str().into()])?
            .all()
            .await?
            .results::<Value>()?;
        let mirrors = crate::remotes::Mirrors::new(env)?;
        for id in ids.iter().filter_map(|row| row["id"].as_str()) {
            let removed = mirrors
                .remove(g1t_contracts::mirrors::MirrorRemoveArgs { actor: a.actor.clone(), remote_id: id.to_owned() })
                .await?;
            if let Outcome::Fail(failure) = removed {
                return Ok(Outcome::Fail(failure));
            }
        }
        self.db
            .prepare("UPDATE github_repos SET mode = 'import' WHERE repo_id = ?")
            .bind(&[a.repo_id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    pub async fn sync_now(&self, a: GithubUnlinkRepoArgs, env: &Env) -> Result<Outcome<GithubRepoLink>> {
        if self.link(&a.repo_id).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "This repository is not linked to GitHub."));
        }
        let synced = crate::remotes::Mirrors::new(env)?
            .sync_now(MirrorActArgs { actor: a.actor.clone(), repo_id: a.repo_id.clone() })
            .await?;
        if let Outcome::Fail(failure) = synced {
            return Ok(Outcome::Fail(failure));
        }
        Ok(self
            .link_for(GithubLinkArgs { repo_id: a.repo_id.clone() })
            .await?
            .map_or_else(|| fail(FailureCode::NotFound, "Gone."), Outcome::Ok))
    }

    // --- The webhook -----------------------------------------------------------

    /// Checks and records a delivery. What it asks for is done by
    /// `process`, after the answer has gone.
    pub async fn receive(&self, a: &GithubReceiveArgs) -> Result<(Received, Option<(String, Value)>)> {
        let answer = |status: u16, message: &str| Received {
            status,
            message: message.to_owned(),
        };
        let Some(secret) = self.config.webhook_secret.as_deref() else {
            return Ok((answer(404, "GitHub is not set up on this g1t."), None));
        };
        if !authentic(secret, &a.body, &a.headers) {
            return Ok((answer(401, "The request was not signed with the app's webhook secret."), None));
        }
        let event = a.headers.get("x-github-event").cloned().unwrap_or_default();
        let Some(delivery) = a.headers.get("x-github-delivery").filter(|id| !id.is_empty() && id.len() <= 100) else {
            return Ok((answer(400, "No X-GitHub-Delivery."), None));
        };
        let now = now_ms();
        let fresh = self
            .db
            .prepare("INSERT OR IGNORE INTO github_deliveries (id, event, received_ms) VALUES (?, ?, ?) RETURNING id")
            .bind(&[delivery.as_str().into(), event.as_str().into(), (now as f64).into()])?
            .first::<Value>(None)
            .await?;
        if fresh.is_none() {
            return Ok((answer(200, "Already received."), None));
        }
        let Ok(payload) = serde_json::from_str::<Value>(&a.body) else {
            return Ok((answer(400, "The body is not JSON."), None));
        };
        Ok((answer(202, "Received."), Some((event, payload))))
    }

    pub async fn process(&self, event: &str, payload: &Value, mirrors: Option<&crate::remotes::Mirrors>) -> Result<()> {
        let action = payload["action"].as_str().unwrap_or_default();
        let installation = payload["installation"]["id"].as_u64();
        match (event, action) {
            ("installation", "deleted") | ("installation", "suspend") | ("installation", "unsuspend") => {
                let Some(id) = installation else { return Ok(()) };
                match action {
                    "deleted" => self.installation_gone(id, "The GitHub App was uninstalled from this account.", mirrors).await?,
                    "suspend" => {
                        self.db
                            .prepare("UPDATE github_installations SET suspended_at = ? WHERE id = ?")
                            .bind(&[rfc3339(now_ms()).into(), number(id)])?
                            .run()
                            .await?;
                    }
                    _ => {
                        self.db
                            .prepare("UPDATE github_installations SET suspended_at = NULL WHERE id = ?")
                            .bind(&[number(id)])?
                            .run()
                            .await?;
                    }
                }
            }
            ("installation_repositories", _) => {
                let Some(id) = installation else { return Ok(()) };
                if let Some(selection) = payload["repository_selection"].as_str() {
                    self.db
                        .prepare("UPDATE github_installations SET repository_selection = ? WHERE id = ?")
                        .bind(&[selection.into(), number(id)])?
                        .run()
                        .await?;
                }
                for removed in payload["repositories_removed"].as_array().into_iter().flatten() {
                    if let Some(repo) = removed["id"].as_u64() {
                        self.mark_github_repo(repo, "GitHub no longer lets the app see this repository: add it back to the installation to keep it in step.")
                            .await?;
                    }
                }
            }
            ("push", _) => {
                if let Some(mirrors) = mirrors {
                    mirrors.on_github_push(payload).await?;
                }
            }
            ("repository", "renamed") | ("repository", "transferred") => {
                let (Some(repo), Some(full_name)) = (payload["repository"]["id"].as_u64(), payload["repository"]["full_name"].as_str()) else {
                    return Ok(());
                };
                self.db
                    .prepare("UPDATE github_repos SET full_name = ? WHERE github_repo_id = ?")
                    .bind(&[full_name.into(), number(repo)])?
                    .run()
                    .await?;
                self.db
                    .prepare(
                        "UPDATE remotes SET name = ?1, url = ?2, clone_url = ?3, recorded = 0
                         WHERE provider = 'github' AND external_id = ?4",
                    )
                    .bind(&[
                        format!("github.com/{full_name}").into(),
                        format!("https://github.com/{full_name}").into(),
                        format!("https://github.com/{full_name}.git").into(),
                        repo.to_string().into(),
                    ])?
                    .run()
                    .await?;
            }
            ("repository", "deleted") => {
                if let Some(repo) = payload["repository"]["id"].as_u64() {
                    self.mark_github_repo(repo, "The repository was deleted on GitHub. The copy on g1t is kept.").await?;
                    self.links_gone("external_id", &repo.to_string(), "was deleted on GitHub", mirrors).await?;
                    self.db
                        .prepare("UPDATE github_repos SET mode = 'import' WHERE github_repo_id = ?")
                        .bind(&[number(repo)])?
                        .run()
                        .await?;
                }
            }
            ("github_app_authorization", "revoked") => {
                if let Some(github_id) = payload["sender"]["id"].as_u64() {
                    let _: u32 = g1t_kit::call(&self.identity, "github_revoked", &GithubRevokedArgs { github_id }).await?;
                }
            }
            ("meta", "deleted") => {
                let ids = self
                    .db
                    .prepare("SELECT DISTINCT id FROM github_installations")
                    .all()
                    .await?
                    .results::<Value>()?;
                for row in ids {
                    if let Some(id) = row["id"].as_u64() {
                        self.installation_gone(id, "g1t's GitHub App was deleted.", mirrors).await?;
                    }
                }
            }
            _ => {}
        }
        // Delivery ids are kept a week, long enough for GitHub's retries.
        self.db
            .prepare("DELETE FROM github_deliveries WHERE received_ms < ?")
            .bind(&[((now_ms().saturating_sub(DELIVERY_DAYS * 86_400_000)) as f64).into()])?
            .run()
            .await?;
        Ok(())
    }

    /// The remotes GitHub no longer lets g1t reach: a mirror standing by
    /// becomes an ordinary repository with what it has (it can no longer
    /// follow), a follower stops; a takeover keeps going and is told why.
    async fn links_gone(&self, column: &str, value: &str, why: &str, mirrors: Option<&crate::remotes::Mirrors>) -> Result<()> {
        let Some(mirrors) = mirrors else { return Ok(()) };
        let column = if column == "connection_id" { "connection_id" } else { "external_id" };
        let rows = self
            .db
            .prepare(format!("SELECT id FROM remotes WHERE provider = 'github' AND {column} = ?"))
            .bind(&[value.into()])?
            .all()
            .await?
            .results::<Value>()?;
        for id in rows.iter().filter_map(|row| row["id"].as_str()) {
            mirrors.link_gone(id, why).await?;
        }
        Ok(())
    }

    async fn installation_gone(&self, id: u64, why: &str, mirrors: Option<&crate::remotes::Mirrors>) -> Result<()> {
        self.links_gone("connection_id", &id.to_string(), "lost its GitHub App installation", mirrors).await?;
        self.db.prepare("DELETE FROM github_installations WHERE id = ?").bind(&[number(id)])?.run().await?;
        self.db.prepare("DELETE FROM github_tokens WHERE installation_id = ?").bind(&[number(id)])?.run().await?;
        self.db
            .prepare("UPDATE github_repos SET mode = 'import', last_error = ? WHERE installation_id = ? AND mode != 'import'")
            .bind(&[why.into(), number(id)])?
            .run()
            .await?;
        Ok(())
    }

    async fn mark_github_repo(&self, github_repo_id: u64, why: &str) -> Result<()> {
        self.db
            .prepare("UPDATE github_repos SET last_error = ? WHERE github_repo_id = ? AND mode != 'import'")
            .bind(&[why.into(), number(github_repo_id)])?
            .run()
            .await?;
        Ok(())
    }
}

/// Answers the GitHub methods; `None` for any other.
pub async fn route(method: &str, body: &Value, env: &Env, ctx: &Context) -> Option<Result<Response>> {
    if !method.starts_with("github_") {
        return None;
    }
    Some(handle(method, body.clone(), env, ctx).await)
}

async fn handle(method: &str, body: Value, env: &Env, ctx: &Context) -> Result<Response> {
    let app = GithubApp::new(env)?;
    match method {
        "github_status" => reply(&app.status(args(body)?).await?),
        "github_add_installation" => reply(&app.add_installation(args(body)?).await?),
        "github_remove_installation" => {
            let mirrors = crate::remotes::Mirrors::new(env).ok();
            reply(&app.remove_installation(args(body)?, mirrors.as_ref()).await?)
        }
        "github_repositories" => reply(&app.repositories(args(body)?).await?),
        "github_import" => {
            let (outcome, job) = app.import(args(body)?).await?;
            if let Some(job) = job {
                let env = env.clone();
                ctx.wait_until(async move {
                    let Ok(app) = GithubApp::new(&env) else { return };
                    if let Err(error) = app.copy_issues(job).await {
                        worker::console_error!("github: copying issues failed: {error}");
                    }
                });
            }
            reply(&outcome)
        }
        "github_link" => reply(&app.link_for(args(body)?).await?),
        "github_unlink_repo" => reply(&app.unlink_repo(args(body)?, env).await?),
        "github_sync" => reply(&app.sync_now(args(body)?, env).await?),
        "github_receive" => {
            let received: GithubReceiveArgs = args(body)?;
            let (answer, work) = app.receive(&received).await?;
            if let Some((event, payload)) = work {
                let env = env.clone();
                ctx.wait_until(async move {
                    let Ok(app) = GithubApp::new(&env) else { return };
                    let mirrors = crate::remotes::Mirrors::new(&env).ok();
                    if let Err(error) = app.process(&event, &payload, mirrors.as_ref()).await {
                        worker::console_error!("github: acting on a {event} delivery failed: {error}");
                    }
                });
            }
            reply(&answer)
        }
        _ => Response::error("Unknown method", 404),
    }
}

/// Whether `event` should push its repository out to its followers, given
/// the repositories `pushed` out already for this batch: a sync sends every
/// ref, so a push of many refs, or many pushes in one batch, is one sync.
pub fn first_push_in_batch(pushed: &mut std::collections::HashSet<String>, event: &g1t_contracts::events::Event) -> bool {
    match event.repo_id.as_deref() {
        Some(repo_id) if event.kind == "git.push" => pushed.insert(repo_id.to_owned()),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_pushes_each_repository_out_once() {
        let event = |kind: &str, repo: &str| g1t_contracts::events::Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "repos".into(),
            time: "2026-10-08T00:00:00Z".into(),
            repo_id: Some(repo.into()),
            actor: None,
            data: serde_json::json!({}),
        };
        let mut pushed = std::collections::HashSet::new();
        assert!(first_push_in_batch(&mut pushed, &event("git.push", "rep_1")));
        assert!(!first_push_in_batch(&mut pushed, &event("git.push", "rep_1")));
        assert!(first_push_in_batch(&mut pushed, &event("git.push", "rep_2")));
        assert!(first_push_in_batch(&mut pushed, &event("issue.opened", "rep_1")));
    }

    #[test]
    fn times_are_read_as_github_writes_them() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2016-07-11T22:14:10Z"), Some(1_468_275_250_000));
        assert_eq!(parse_time("2024-02-29T12:00:00.5Z"), Some(1_709_208_000_500));
        assert_eq!(parse_time("not a time"), None);
    }

    #[test]
    fn names_follow_g1ts_rules() {
        assert_eq!(repo_name("Hello-World"), "hello-world");
        assert_eq!(repo_name(".github"), "github");
        assert_eq!(repo_name("site.git"), "site");
        assert!(is_valid_repo_name(&repo_name("My Repo_1.x")));
    }

    fn headers(signature: &str) -> HashMap<String, String> {
        HashMap::from([("x-hub-signature-256".to_owned(), signature.to_owned())])
    }

    #[test]
    fn webhooks_must_carry_the_apps_signature() {
        // GitHub's documented example: secret "It's a Secret to Everybody",
        // payload "Hello, World!".
        let secret = "It's a Secret to Everybody";
        let signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert!(authentic(secret, "Hello, World!", &headers(signature)));
        assert!(!authentic(secret, "Hello, World?", &headers(signature)));
        assert!(!authentic("another secret", "Hello, World!", &headers(signature)));
        // The bare hex form is not what GitHub sends; it is refused.
        assert!(!authentic(secret, "Hello, World!", &headers(signature.trim_start_matches("sha256="))));
        assert!(!authentic(secret, "Hello, World!", &HashMap::new()));
    }

    #[test]
    fn imported_issues_say_where_they_came_from() {
        let issue = json!({
            "number": 12,
            "html_url": "https://github.com/acme/site/issues/12",
            "user": { "login": "octocat", "id": 1 },
            "created_at": "2024-01-02T03:04:05Z",
            "milestone": { "title": "v1" },
            "labels": [{ "name": "Bug" }, { "name": "bug" }, { "name": "x".repeat(41) }, "Help Wanted"],
        });
        let linked = imported_header(&issue, "acme/site", Some("octo"));
        assert!(linked.contains("[acme/site#12](https://github.com/acme/site/issues/12)"));
        assert!(linked.contains("@octo (@octocat on GitHub)"));
        assert!(linked.contains("on 2024-01-02"));
        assert!(linked.contains("Milestone: v1"));
        assert!(imported_header(&issue, "acme/site", None).contains("[@octocat](https://github.com/octocat) on GitHub"));
        assert_eq!(labels_of(&issue), vec!["bug", "help wanted"]);
    }

    #[test]
    fn the_jwt_issuer_prefers_the_client_id() {
        let mut config = AppConfig {
            app_id: "5203641".to_owned(),
            slug: "g1t-sh".to_owned(),
            client_id: String::new(),
            private_key: Some("key".to_owned()),
            webhook_secret: None,
        };
        assert_eq!(config.issuer(), "5203641");
        config.client_id = "Iv23liZS94alfjIUn1eW".to_owned();
        assert_eq!(config.issuer(), "Iv23liZS94alfjIUn1eW");
        assert!(config.configured());
        assert_eq!(config.install_url(), "https://github.com/apps/g1t-sh/installations/new");
        config.private_key = None;
        assert!(!config.configured());
    }
}
