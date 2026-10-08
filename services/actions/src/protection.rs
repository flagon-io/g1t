//! Keeping runs safe: a repository's choices for its workflows (what a
//! job's token may do when its workflow says nothing, and which pull
//! requests' runs wait for approval), environments' protection rules, the
//! reviews of the jobs they hold, and approving a pull request's run.
//!
//! - A job that names an environment with rules is `pending` once its needs
//!   are done: until a reviewer approves it (when the environment has
//!   reviewers), its wait timer has run out (when it has one), and only on
//!   a ref the environment lets deploy. Its secrets are read when it
//!   starts, so the environment's are never handed out before then. One
//!   review approves every job of the run attempt that names the
//!   environment.
//! - A run of a pull request from outside the workspace may wait as
//!   `action_required` until someone with the Write role approves it, by
//!   the repository's approval policy.

use g1t_actions::filter::Pattern;
use g1t_actions::permissions::TokenDefault;
use g1t_contracts::access::{self, AccessSource, Capability, CollaboratorPermissionArgs, PermissionInfo};
use g1t_contracts::actions::{
    APPROVAL_POLICIES, ActionsSettings, ActionsSettingsArgs, SetWorkspaceActionsSettingsArgs, WorkspaceActionsSettings,
    WorkspaceActionsSettingsArgs, BranchPattern, DeleteEnvironmentArgs, Environment, EnvironmentReviewer,
    EnvironmentsArgs, MAX_ENVIRONMENT_REVIEWERS, MAX_WAIT_MINUTES, PendingDeployment, PendingDeploymentsArgs, ReviewDeploymentsArgs,
    RunActionArgs, RunApproval, SetActionsSettingsArgs, SetEnvironmentArgs, WorkflowRun,
};
use g1t_contracts::identity::AGENT_ID;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::Result;

use crate::plan::{JobRow, RunRow};
use crate::{Actions, check, fail, optional};

/// What the approval policy is when a repository chose none.
pub const DEFAULT_APPROVAL_POLICY: &str = "outside_contributors";

fn now() -> String {
    rfc3339(now_ms())
}

/// A repository's own choices (migrations 0006 and 0007); null is unchosen.
#[derive(Default, Deserialize)]
struct SettingsRow {
    default_permissions: Option<String>,
    approval_policy: Option<String>,
    can_approve_pulls: Option<u32>,
}

#[derive(Deserialize)]
struct WorkspaceRow {
    default_permissions: String,
    max_permissions: String,
    can_approve_pulls: u32,
}

/// What a workflow without `permissions:` gets: the repository's choice,
/// else `write` for a repository made before restricted tokens
/// (`grandfathered`), else its workspace's default; never more than the
/// workspace's maximum.
pub(crate) fn effective_default(chosen: Option<TokenDefault>, grandfathered: bool, workspace_default: TokenDefault, maximum: TokenDefault) -> TokenDefault {
    let wanted = chosen.unwrap_or(if grandfathered { TokenDefault::Permissive } else { workspace_default });
    if maximum == TokenDefault::Restricted { TokenDefault::Restricted } else { wanted }
}

/// The workspace's policy, or its defaults.
fn workspace_policy(row: Option<WorkspaceRow>) -> WorkspaceActionsSettings {
    match row {
        Some(row) => WorkspaceActionsSettings {
            default_permissions: row.default_permissions,
            max_permissions: row.max_permissions,
            can_approve_pull_requests: row.can_approve_pulls != 0,
        },
        None => WorkspaceActionsSettings {
            default_permissions: TokenDefault::Restricted.as_str().to_owned(),
            max_permissions: TokenDefault::Permissive.as_str().to_owned(),
            can_approve_pull_requests: false,
        },
    }
}

#[derive(Clone, Deserialize)]
struct EnvRow {
    name: String,
    reviewers: String,
    prevent_self_review: u32,
    wait_minutes: u32,
    branch_policy: String,
    branch_patterns: String,
    admins_bypass: u32,
    updated_at: String,
    updated_by: Option<String>,
}

impl EnvRow {
    fn view(&self) -> Environment {
        Environment {
            name: self.name.clone(),
            reviewers: serde_json::from_str(&self.reviewers).unwrap_or_default(),
            prevent_self_review: self.prevent_self_review != 0,
            wait_minutes: self.wait_minutes,
            branch_policy: self.branch_policy.clone(),
            branch_patterns: serde_json::from_str(&self.branch_patterns).unwrap_or_default(),
            admins_bypass: self.admins_bypass != 0,
            protected: true,
            updated_at: Some(self.updated_at.clone()),
            updated_by: self.updated_by.clone(),
        }
    }
}

/// An environment no rules hold.
fn unprotected(name: &str) -> Environment {
    Environment {
        name: name.to_owned(),
        reviewers: Vec::new(),
        prevent_self_review: false,
        wait_minutes: 0,
        branch_policy: "all".to_owned(),
        branch_patterns: Vec::new(),
        admins_bypass: true,
        protected: false,
        updated_at: None,
        updated_by: None,
    }
}

#[derive(Clone, Deserialize)]
struct GateRow {
    environment: String,
    state: String,
    needs_review: u32,
    wait_until: Option<String>,
    reviewed_by: Option<String>,
    comment: Option<String>,
    reviewed_at: Option<String>,
}

/// An environment's name as rules and secrets keep it: lowercase, up to 40
/// letters, digits, `-` and `_`.
pub(crate) fn environment_name(name: &str) -> std::result::Result<String, String> {
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.len() > 40 || !lower.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("`{}` is not an environment's name: up to 40 letters, digits, - and _.", name.trim()));
    }
    Ok(lower)
}

/// Whether `git_ref` may deploy to an environment by its `policy`.
/// `protected` says whether the branch is protected, for `protected`.
pub(crate) fn branch_allowed(policy: &str, patterns: &[BranchPattern], git_ref: &str, protected: bool, environment: &str) -> std::result::Result<(), String> {
    let (kind, name) = match (git_ref.strip_prefix("refs/heads/"), git_ref.strip_prefix("refs/tags/")) {
        (Some(branch), _) => ("branch", branch),
        (_, Some(tag)) => ("tag", tag),
        _ => ("ref", git_ref),
    };
    match policy {
        "protected" if kind == "branch" && protected => Ok(()),
        "protected" => Err(format!("{environment} takes deployments from protected branches only, and `{name}` is not one.")),
        "selected" => {
            let allowed = patterns
                .iter()
                .filter(|pattern| pattern.kind == kind)
                .any(|pattern| Pattern::parse(&pattern.name).matches(name));
            if allowed {
                Ok(())
            } else {
                Err(format!("The {kind} `{name}` may not deploy to {environment}: its deployment rules list the branches and tags that may."))
            }
        }
        _ => Ok(()),
    }
}

/// How someone may decide on an environment's jobs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reviewer {
    /// One of its reviewers.
    Listed,
    /// An admin, past its rules, which also skips its wait timer.
    AdminBypass,
}

/// Whether `username` (in `teams`, an admin or not) may approve or reject
/// the environment's jobs in a run `started_by` began.
pub(crate) fn may_review(
    environment: &Environment,
    username: &str,
    teams: &[String],
    admin: bool,
    started_by: Option<&str>,
) -> std::result::Result<Reviewer, String> {
    let listed = environment.reviewers.iter().any(|reviewer| match reviewer.kind.as_str() {
        "team" => teams.iter().any(|team| team.eq_ignore_ascii_case(&reviewer.name)),
        _ => reviewer.name.eq_ignore_ascii_case(username),
    });
    let started = started_by.is_some_and(|by| by.eq_ignore_ascii_case(username));
    if listed && !(environment.prevent_self_review && started) {
        return Ok(Reviewer::Listed);
    }
    if admin && environment.admins_bypass {
        return Ok(Reviewer::AdminBypass);
    }
    Err(if listed {
        format!("You started this run, and {} does not let whoever started a run approve its deployments.", environment.name)
    } else if environment.reviewers.is_empty() {
        format!("{} has no reviewers: its jobs wait for its timer. Only an admin can start them sooner.", environment.name)
    } else {
        format!("You are not one of {}'s reviewers.", environment.name)
    })
}

/// Whether a gate lets its jobs start at `now`.
pub(crate) fn gate_open(state: &str, needs_review: bool, wait_until: Option<&str>, now: &str) -> bool {
    state != "rejected" && (!needs_review || state == "approved") && wait_until.is_none_or(|until| until <= now)
}

/// Why a pull request's run waits for approval, if it does, by `policy`:
/// `member` of the workspace, whether they `can_push`, and whether this is
/// their `first_time` (no pull request of theirs merged here).
pub(crate) fn approval_reason(policy: &str, member: bool, can_push: bool, first_time: bool) -> Option<&'static str> {
    if member {
        return None;
    }
    match policy {
        "all_external_contributors" => Some("is not a member of the workspace"),
        "first_time_contributors" => first_time.then_some("has not had a pull request merged here yet"),
        _ if !can_push => Some("cannot push to the repository"),
        _ => first_time.then_some("has not had a pull request merged here yet"),
    }
}

/// What a job waits for at its environment, in words.
fn held_reason(environment: &str, needs_review: bool, wait_until: Option<&str>) -> String {
    match (needs_review, wait_until) {
        (true, Some(until)) => format!("Waiting for a review to deploy to {environment}, and for its wait timer, until {until}."),
        (true, None) => format!("Waiting for a review to deploy to {environment}."),
        (false, Some(until)) => format!("Waiting for {environment}'s wait timer, until {until}."),
        (false, None) => format!("Waiting to deploy to {environment}."),
    }
}

/// What an environment's rules say about a job that names it.
pub(crate) enum Gate {
    /// No rules hold it: it starts.
    Open,
    /// It waits, for this.
    Held(String),
    /// It may not deploy there.
    Refused(String),
}

impl Actions {
    // --- The repository's and workspace's choices -------------------------------

    async fn repo_choices(&self, repo_id: &str) -> Result<SettingsRow> {
        Ok(self
            .db
            .prepare("SELECT default_permissions, approval_policy, can_approve_pulls FROM repo_settings WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<SettingsRow>(None)
            .await?
            .unwrap_or_default())
    }

    /// A workspace's policy for its repositories' tokens, or the defaults.
    pub(crate) async fn workspace_settings(&self, workspace: &str) -> Result<WorkspaceActionsSettings> {
        let row = self
            .db
            .prepare("SELECT default_permissions, max_permissions, can_approve_pulls FROM workspace_actions_settings WHERE namespace = ?")
            .bind(&[workspace.to_lowercase().into()])?
            .first::<WorkspaceRow>(None)
            .await?;
        Ok(workspace_policy(row))
    }

    /// Whether `repo` was made before restricted tokens began, and so keeps
    /// read and write until someone chooses otherwise.
    async fn grandfathered(&self, repo: &Repo) -> Result<bool> {
        #[derive(Deserialize)]
        struct Since {
            value: String,
        }
        let since = self
            .db
            .prepare("SELECT value FROM actions_meta WHERE key = 'restricted_since'")
            .first::<Since>(None)
            .await?;
        Ok(since.is_some_and(|since| !repo.created_at.is_empty() && repo.created_at.as_str() < since.value.as_str()))
    }

    /// A repository's settings as they hold, its workspace's taken in.
    pub(crate) async fn repo_settings(&self, repo: &Repo) -> Result<ActionsSettings> {
        let row = self.repo_choices(&repo.id).await?;
        let workspace = self.workspace_settings(&repo.namespace).await?;
        let chosen = row.default_permissions.as_deref().and_then(TokenDefault::parse);
        let default = effective_default(
            chosen,
            self.grandfathered(repo).await?,
            TokenDefault::parse(&workspace.default_permissions).unwrap_or_default(),
            TokenDefault::parse(&workspace.max_permissions).unwrap_or(TokenDefault::Permissive),
        );
        Ok(ActionsSettings {
            default_permissions: default.as_str().to_owned(),
            default_chosen: chosen.is_some(),
            max_permissions: workspace.max_permissions.clone(),
            approval_policy: row.approval_policy.unwrap_or_else(|| DEFAULT_APPROVAL_POLICY.to_owned()),
            can_approve_pull_requests: workspace.can_approve_pull_requests && row.can_approve_pulls == Some(1),
            workspace_allows_pull_requests: workspace.can_approve_pull_requests,
        })
    }

    /// What a workflow without `permissions:` gets in the repository, and
    /// whether its jobs may open and approve pull requests.
    pub(crate) async fn token_policy(&self, repo_id: &str) -> Result<(TokenDefault, bool)> {
        let Some((repo, _)) = self.repo_by_id(repo_id).await? else {
            return Ok((TokenDefault::Restricted, false));
        };
        let settings = self.repo_settings(&repo).await?;
        Ok((TokenDefault::parse(&settings.default_permissions).unwrap_or_default(), settings.can_approve_pull_requests))
    }

    /// The approval policy of a repository.
    pub(crate) async fn approval_policy(&self, repo_id: &str) -> Result<String> {
        Ok(self.repo_choices(repo_id).await?.approval_policy.unwrap_or_else(|| DEFAULT_APPROVAL_POLICY.to_owned()))
    }

    pub async fn actions_settings(&self, a: ActionsSettingsArgs) -> Result<Outcome<ActionsSettings>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        Ok(Outcome::Ok(self.repo_settings(&repo).await?))
    }

    pub async fn set_actions_settings(&self, a: SetActionsSettingsArgs) -> Result<Outcome<ActionsSettings>> {
        if let Some(refused) = refuse_job_token(&a.actor) {
            return Ok(refused);
        }
        let repo = check!(self.may(&a.actor, &a.repo, Capability::ManageIntegrations).await?);
        let mut row = self.repo_choices(&repo.id).await?;
        let workspace = self.workspace_settings(&repo.namespace).await?;
        if let Some(default) = a.default_permissions.as_deref().map(str::trim) {
            row.default_permissions = match default {
                "inherit" | "" => None,
                other => match TokenDefault::parse(other) {
                    Some(TokenDefault::Permissive) if workspace.max_permissions == "read" => {
                        return Ok(fail(
                            FailureCode::Forbidden,
                            format!("{} holds its repositories' tokens to read-only: an owner can change that in the workspace's Actions settings.", repo.namespace),
                        ));
                    }
                    Some(parsed) => Some(parsed.as_str().to_owned()),
                    None => return Ok(fail(FailureCode::Invalid, "default_permissions is read, write or inherit.")),
                },
            };
        }
        if let Some(policy) = &a.approval_policy {
            let policy = policy.trim();
            if !APPROVAL_POLICIES.contains(&policy) {
                return Ok(fail(FailureCode::Invalid, format!("approval_policy is one of {}.", APPROVAL_POLICIES.join(", "))));
            }
            row.approval_policy = Some(policy.to_owned());
        }
        if let Some(allow) = a.can_approve_pull_requests {
            if allow && !workspace.can_approve_pull_requests {
                return Ok(fail(
                    FailureCode::Forbidden,
                    format!("{} does not let its repositories' jobs open or approve pull requests: an owner can allow it in the workspace's Actions settings.", repo.namespace),
                ));
            }
            row.can_approve_pulls = Some(u32::from(allow));
        }
        // 0006's artifact retention is kept, or its default for a new row.
        self.db
            .prepare(
                "INSERT INTO repo_settings (repo_id, artifact_retention_days, default_permissions, approval_policy, can_approve_pulls, updated_at, updated_by)
                 VALUES (?1, ?7, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (repo_id) DO UPDATE SET default_permissions = ?2, approval_policy = ?3, can_approve_pulls = ?4,
                   updated_at = ?5, updated_by = ?6",
            )
            .bind(&[
                repo.id.as_str().into(),
                optional(row.default_permissions.as_deref()),
                optional(row.approval_policy.as_deref()),
                row.can_approve_pulls.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                now().into(),
                a.actor.username.as_str().into(),
                g1t_contracts::actions::ARTIFACT_RETENTION_DEFAULT_DAYS.into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.repo_settings(&repo).await?))
    }

    pub async fn workspace_actions_settings(&self, a: WorkspaceActionsSettingsArgs) -> Result<Outcome<WorkspaceActionsSettings>> {
        let workspace = a.workspace.trim().to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(fail(FailureCode::NotFound, "There is no such workspace."));
        }
        Ok(Outcome::Ok(self.workspace_settings(&workspace).await?))
    }

    pub async fn set_workspace_actions_settings(&self, a: SetWorkspaceActionsSettingsArgs) -> Result<Outcome<WorkspaceActionsSettings>> {
        if let Some(refused) = refuse_job_token(&a.actor) {
            return Ok(refused);
        }
        let workspace = a.workspace.trim().to_lowercase();
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&workspace) != Some(g1t_contracts::Role::Owner) {
            return Ok(fail(FailureCode::Forbidden, format!("Only an owner of {workspace} can change its Actions settings.")));
        }
        let mut settings = self.workspace_settings(&workspace).await?;
        let level = |text: &str, field: &str| -> std::result::Result<String, String> {
            TokenDefault::parse(text.trim()).map(|parsed| parsed.as_str().to_owned()).ok_or_else(|| format!("{field} is read or write."))
        };
        if let Some(text) = &a.default_permissions {
            match level(text, "default_permissions") {
                Ok(parsed) => settings.default_permissions = parsed,
                Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
            }
        }
        if let Some(text) = &a.max_permissions {
            match level(text, "max_permissions") {
                Ok(parsed) => settings.max_permissions = parsed,
                Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
            }
        }
        if settings.max_permissions == "read" {
            settings.default_permissions = "read".to_owned();
        }
        if let Some(allow) = a.can_approve_pull_requests {
            settings.can_approve_pull_requests = allow;
        }
        self.db
            .prepare(
                "INSERT INTO workspace_actions_settings (namespace, default_permissions, max_permissions, can_approve_pulls, updated_at, updated_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (namespace) DO UPDATE SET default_permissions = ?2, max_permissions = ?3, can_approve_pulls = ?4,
                   updated_at = ?5, updated_by = ?6",
            )
            .bind(&[
                workspace.as_str().into(),
                settings.default_permissions.as_str().into(),
                settings.max_permissions.as_str().into(),
                u32::from(settings.can_approve_pull_requests).into(),
                now().into(),
                a.actor.username.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(settings))
    }

    // --- Environments -------------------------------------------------------------

    async fn environment_row(&self, repo_id: &str, name: &str) -> Result<Option<EnvRow>> {
        self.db
            .prepare("SELECT * FROM environments WHERE repo_id = ? AND name = ?")
            .bind(&[repo_id.into(), name.to_ascii_lowercase().into()])?
            .first::<EnvRow>(None)
            .await
    }

    /// An environment and its rules; one without rules if it has none.
    pub(crate) async fn environment_rules(&self, repo_id: &str, name: &str) -> Result<Environment> {
        Ok(match self.environment_row(repo_id, name).await? {
            Some(row) => row.view(),
            None => unprotected(&name.to_ascii_lowercase()),
        })
    }

    /// `environments`: every environment the repository's rules, secrets,
    /// workflows or jobs name; or with `name`, the one.
    pub async fn environments(&self, a: EnvironmentsArgs) -> Result<Outcome<Vec<Environment>>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        if let Some(name) = &a.name {
            let name = check!(environment_name(name).map_or_else(|problem| fail(FailureCode::Invalid, problem), Outcome::Ok));
            return Ok(Outcome::Ok(vec![self.environment_rules(&repo.id, &name).await?]));
        }
        let rows = self
            .db
            .prepare("SELECT * FROM environments WHERE repo_id = ? ORDER BY name")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<EnvRow>()?;
        let mut out: Vec<Environment> = rows.iter().map(EnvRow::view).collect();
        let mut named: Vec<String> = self.secret_environments(&repo.id).await?;
        #[derive(Deserialize)]
        struct Named {
            environment: String,
        }
        let used = self
            .db
            .prepare("SELECT DISTINCT environment FROM jobs WHERE repo_id = ? AND environment IS NOT NULL LIMIT 100")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<Named>()?;
        named.extend(used.into_iter().map(|n| n.environment));
        #[derive(Deserialize)]
        struct Source {
            source: String,
        }
        let sources = self
            .db
            .prepare("SELECT source FROM workflows WHERE repo_id = ? AND error IS NULL")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<Source>()?;
        for source in sources {
            let Ok(workflow) = g1t_actions::workflow::parse(&source.source) else { continue };
            for job in &workflow.jobs {
                let written = match job.raw.get("environment") {
                    Some(Value::String(name)) => Some(name.clone()),
                    Some(Value::Object(env)) => env.get("name").and_then(Value::as_str).map(str::to_owned),
                    _ => None,
                };
                if let Some(name) = written.filter(|name| !name.contains("${{")) {
                    named.push(name);
                }
            }
        }
        for name in named {
            if let Ok(name) = environment_name(&name)
                && !out.iter().any(|env| env.name == name)
            {
                out.push(unprotected(&name));
            }
        }
        out.sort_by(|a, b| b.protected.cmp(&a.protected).then(a.name.cmp(&b.name)));
        Ok(Outcome::Ok(out))
    }

    pub async fn set_environment(&self, a: SetEnvironmentArgs) -> Result<Outcome<Environment>> {
        if let Some(refused) = refuse_job_token(&a.actor) {
            return Ok(refused);
        }
        let repo = check!(self.may(&a.actor, &a.repo, Capability::ManageIntegrations).await?);
        let name = check!(environment_name(&a.name).map_or_else(|problem| fail(FailureCode::Invalid, problem), Outcome::Ok));
        let mut env = self.environment_rules(&repo.id, &name).await?;
        if let Some(reviewers) = a.reviewers {
            let reviewers = check!(self.valid_reviewers(&repo, reviewers).await?);
            env.reviewers = reviewers;
        }
        if let Some(flag) = a.prevent_self_review {
            env.prevent_self_review = flag;
        }
        if let Some(minutes) = a.wait_minutes {
            if minutes > MAX_WAIT_MINUTES {
                return Ok(fail(FailureCode::Invalid, format!("A wait timer is at most {MAX_WAIT_MINUTES} minutes (30 days).")));
            }
            env.wait_minutes = minutes;
        }
        if let Some(policy) = a.branch_policy {
            let policy = policy.trim().to_owned();
            if !["all", "protected", "selected"].contains(&policy.as_str()) {
                return Ok(fail(FailureCode::Invalid, "branch_policy is all, protected or selected."));
            }
            env.branch_policy = policy;
        }
        if let Some(patterns) = a.branch_patterns {
            let mut clean: Vec<BranchPattern> = Vec::new();
            for pattern in patterns {
                let name = pattern.name.trim().to_owned();
                let kind = pattern.kind.trim().to_ascii_lowercase();
                if name.is_empty() || name.len() > 255 {
                    return Ok(fail(FailureCode::Invalid, "A branch or tag pattern is 1 to 255 characters."));
                }
                if kind != "branch" && kind != "tag" {
                    return Ok(fail(FailureCode::Invalid, format!("`{name}`: a pattern's type is branch or tag.")));
                }
                if !clean.iter().any(|known| known.name == name && known.kind == kind) {
                    clean.push(BranchPattern { name, kind });
                }
            }
            if clean.len() > 50 {
                return Ok(fail(FailureCode::Invalid, "An environment lists at most 50 branch and tag patterns."));
            }
            env.branch_patterns = clean;
        }
        if let Some(flag) = a.admins_bypass {
            env.admins_bypass = flag;
        }
        let at = now();
        self.db
            .prepare(
                "INSERT INTO environments (repo_id, name, reviewers, prevent_self_review, wait_minutes, branch_policy, branch_patterns,
                   admins_bypass, created_at, updated_at, updated_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
                 ON CONFLICT (repo_id, name) DO UPDATE SET reviewers = ?3, prevent_self_review = ?4, wait_minutes = ?5,
                   branch_policy = ?6, branch_patterns = ?7, admins_bypass = ?8, updated_at = ?9, updated_by = ?10",
            )
            .bind(&[
                repo.id.as_str().into(),
                name.as_str().into(),
                serde_json::to_string(&env.reviewers)?.into(),
                u32::from(env.prevent_self_review).into(),
                env.wait_minutes.into(),
                env.branch_policy.as_str().into(),
                serde_json::to_string(&env.branch_patterns)?.into(),
                u32::from(env.admins_bypass).into(),
                at.as_str().into(),
                a.actor.username.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.environment_rules(&repo.id, &name).await?))
    }

    pub async fn delete_environment(&self, a: DeleteEnvironmentArgs) -> Result<Outcome<bool>> {
        if let Some(refused) = refuse_job_token(&a.actor) {
            return Ok(refused);
        }
        let repo = check!(self.may(&a.actor, &a.repo, Capability::ManageIntegrations).await?);
        let name = check!(environment_name(&a.name).map_or_else(|problem| fail(FailureCode::Invalid, problem), Outcome::Ok));
        let removed = self
            .db
            .prepare("DELETE FROM environments WHERE repo_id = ? AND name = ? RETURNING name")
            .bind(&[repo.id.as_str().into(), name.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if removed.is_none() {
            return Ok(fail(FailureCode::NotFound, format!("{name} has no protection rules.")));
        }
        Ok(Outcome::Ok(true))
    }

    /// Reviewers as given, checked: at most six, each a person with access
    /// to the repository or a team of its workspace.
    async fn valid_reviewers(&self, repo: &Repo, given: Vec<EnvironmentReviewer>) -> Result<Outcome<Vec<EnvironmentReviewer>>> {
        if given.len() > MAX_ENVIRONMENT_REVIEWERS {
            return Ok(fail(FailureCode::Invalid, format!("An environment has at most {MAX_ENVIRONMENT_REVIEWERS} reviewers.")));
        }
        let Some(ws) = self.workspace_actor(&repo.namespace).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such workspace."));
        };
        let mut out: Vec<EnvironmentReviewer> = Vec::new();
        for reviewer in given {
            let kind = reviewer.kind.trim().to_ascii_lowercase();
            let name = reviewer.name.trim().trim_start_matches('@').to_ascii_lowercase();
            match kind.as_str() {
                "user" => {
                    let permission: Outcome<PermissionInfo> = g1t_kit::call(
                        &self.identity,
                        "collaborator_permission",
                        &CollaboratorPermissionArgs {
                            viewer: Some(ws.clone()),
                            path: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                            username: name.clone(),
                        },
                    )
                    .await?;
                    if !permission.into_result().ok().is_some_and(|info| info.role.is_some()) {
                        return Ok(fail(FailureCode::Invalid, format!("{name} has no access to {}/{}, so cannot review.", repo.namespace, repo.name)));
                    }
                }
                "team" => {
                    let slug = name.rsplit('/').next().unwrap_or(&name).to_owned();
                    if self.team_people(&repo.namespace, &slug).await?.is_none() {
                        return Ok(fail(FailureCode::Invalid, format!("{} has no team called {slug}.", repo.namespace)));
                    }
                    if !out.iter().any(|known| known.kind == "team" && known.name == slug) {
                        out.push(EnvironmentReviewer { kind, name: slug });
                    }
                    continue;
                }
                _ => return Ok(fail(FailureCode::Invalid, "A reviewer's type is user or team.")),
            }
            if !out.iter().any(|known| known.kind == kind && known.name == name) {
                out.push(EnvironmentReviewer { kind, name });
            }
        }
        Ok(Outcome::Ok(out))
    }

    /// Everyone in a team of `workspace` and its child teams, by username;
    /// `None` when there is no such team.
    async fn team_people(&self, workspace: &str, slug: &str) -> Result<Option<Vec<String>>> {
        let resolved: Vec<Value> = g1t_kit::call(
            &self.identity,
            "resolve_teams",
            &json!({ "teams": [format!("{workspace}/{slug}")] }),
        )
        .await
        .unwrap_or_default();
        Ok(resolved.into_iter().next().map(|team| {
            ["members", "child_members"]
                .iter()
                .flat_map(|key| team[*key].as_array().cloned().unwrap_or_default())
                .filter_map(|person| person["username"].as_str().map(str::to_lowercase))
                .collect()
        }))
    }

    /// The teams of the environment's reviewers that `username` is in.
    async fn reviewer_teams(&self, workspace: &str, environment: &Environment, username: &str) -> Result<Vec<String>> {
        let mut teams = Vec::new();
        for reviewer in environment.reviewers.iter().filter(|r| r.kind == "team") {
            if self
                .team_people(workspace, &reviewer.name)
                .await?
                .is_some_and(|people| people.iter().any(|person| person.eq_ignore_ascii_case(username)))
            {
                teams.push(reviewer.name.clone());
            }
        }
        Ok(teams)
    }

    // --- Gates ---------------------------------------------------------------------

    /// What `environment`'s rules say about a job of `run` that names it,
    /// recording the run's gate there the first time one of its jobs
    /// reaches it.
    pub(crate) async fn gate(&self, run: &RunRow, environment: &str) -> Result<Gate> {
        let Ok(name) = environment_name(environment) else {
            return Ok(Gate::Open);
        };
        let Some(row) = self.environment_row(&run.repo_id, &name).await? else {
            return Ok(Gate::Open);
        };
        let env = row.view();
        // Which refs may deploy, before anything waits.
        let protected = if env.branch_policy == "protected" { self.branch_protected(run).await? } else { false };
        if let Err(problem) = branch_allowed(&env.branch_policy, &env.branch_patterns, &run.git_ref, protected, &name) {
            return Ok(Gate::Refused(problem));
        }
        let needs_review = !env.reviewers.is_empty();
        if !needs_review && env.wait_minutes == 0 {
            return Ok(Gate::Open);
        }
        let existing = self.gate_row(&run.id, run.attempt as u32, &name).await?;
        let gate = match existing {
            Some(gate) => gate,
            None => {
                let wait_until = (env.wait_minutes > 0).then(|| rfc3339(now_ms() + u64::from(env.wait_minutes) * 60_000));
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO environment_gates (run_id, attempt, environment, repo_id, state, needs_review, wait_until, created_at)
                         VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)",
                    )
                    .bind(&[
                        run.id.as_str().into(),
                        (run.attempt as u32).into(),
                        name.as_str().into(),
                        run.repo_id.as_str().into(),
                        u32::from(needs_review).into(),
                        optional(wait_until.as_deref()),
                        now().into(),
                    ])?
                    .run()
                    .await?;
                if needs_review {
                    self.ask_reviewers(run, &env).await;
                }
                match self.gate_row(&run.id, run.attempt as u32, &name).await? {
                    Some(gate) => gate,
                    None => return Ok(Gate::Held(held_reason(&name, needs_review, wait_until.as_deref()))),
                }
            }
        };
        if gate.state == "rejected" {
            let by = gate.reviewed_by.as_deref().unwrap_or("A reviewer");
            return Ok(Gate::Refused(format!("{by} rejected the deployment to {name}.")));
        }
        if gate_open(&gate.state, gate.needs_review != 0, gate.wait_until.as_deref(), &now()) {
            return Ok(Gate::Open);
        }
        let review_left = gate.needs_review != 0 && gate.state != "approved";
        Ok(Gate::Held(held_reason(&name, review_left, gate.wait_until.as_deref())))
    }

    async fn gate_row(&self, run_id: &str, attempt: u32, environment: &str) -> Result<Option<GateRow>> {
        self.db
            .prepare("SELECT * FROM environment_gates WHERE run_id = ? AND attempt = ? AND environment = ?")
            .bind(&[run_id.into(), attempt.into(), environment.into()])?
            .first::<GateRow>(None)
            .await
    }

    /// Whether the run's branch is protected: the default branch, or one an
    /// active rule holds.
    async fn branch_protected(&self, run: &RunRow) -> Result<bool> {
        let Some(branch) = run.git_ref.strip_prefix("refs/heads/") else { return Ok(false) };
        let path = crate::repo_path(&run.repo);
        let Some(ws) = self.workspace_actor(&path.namespace).await? else { return Ok(false) };
        let rules: Outcome<Value> = g1t_kit::call(
            &self.work,
            "effective_rules",
            &json!({ "viewer": ws, "repo": path, "name": branch, "target": "branch" }),
        )
        .await
        .unwrap_or_else(|_| Outcome::Ok(Value::Null));
        Ok(match rules {
            Outcome::Ok(rules) => {
                rules["default_branch"].as_bool() == Some(true)
                    || rules["rules"].as_array().is_some_and(|rules| rules.iter().any(|rule| rule["enforcement"] == "active"))
            }
            Outcome::Fail(_) => false,
        })
    }

    /// Tells an environment's reviewers that a run waits for them.
    async fn ask_reviewers(&self, run: &RunRow, env: &Environment) {
        let path = crate::repo_path(&run.repo);
        let mut people: Vec<String> = Vec::new();
        for reviewer in &env.reviewers {
            let names = match reviewer.kind.as_str() {
                "team" => self.team_people(&path.namespace, &reviewer.name).await.ok().flatten().unwrap_or_default(),
                _ => vec![reviewer.name.clone()],
            };
            for name in names {
                // Never whoever cannot approve their own run.
                let own = env.prevent_self_review && run.actor.as_deref().is_some_and(|by| by.eq_ignore_ascii_case(&name));
                if !own && !people.contains(&name) {
                    people.push(name);
                }
            }
        }
        if people.is_empty() {
            return;
        }
        let published: Result<()> = g1t_kit::call(
            &self.events,
            "publish",
            &g1t_contracts::events::Publish {
                events: vec![g1t_contracts::events::NewEvent {
                    kind: "deployment.review_requested",
                    source: "actions",
                    repo_id: Some(run.repo_id.clone()),
                    actor: run.actor_id.clone(),
                    data: json!({
                        "repoId": run.repo_id,
                        "runId": run.id,
                        "attempt": run.attempt,
                        "environment": env.name,
                        "workflow": run.name,
                        "title": run.title,
                        "number": run.number,
                        "notify": people,
                        "link": format!("/{}/actions/runs/{}", run.repo, run.id),
                    }),
                }],
            },
        )
        .await;
        if let Err(error) = published {
            worker::console_error!("actions: reviewers of {} not told for run {}: {error}", env.name, run.id);
        }
    }

    /// The environments holding a run's jobs this attempt, and whether
    /// `viewer` may decide on each.
    pub(crate) async fn pending_for(&self, run: &RunRow, viewer: &Viewer) -> Result<Vec<PendingDeployment>> {
        let gates = self
            .db
            .prepare("SELECT * FROM environment_gates WHERE run_id = ? AND attempt = ? ORDER BY environment")
            .bind(&[run.id.as_str().into(), (run.attempt as u32).into()])?
            .all()
            .await?
            .results::<GateRow>()?;
        if gates.is_empty() {
            return Ok(Vec::new());
        }
        let jobs = self.job_rows(&run.id).await?;
        let repo = self.visible_repo(&crate::repo_path(&run.repo), viewer).await?;
        let mut out = Vec::new();
        for gate in gates {
            let env = self.environment_rules(&run.repo_id, &gate.environment).await?;
            let held: Vec<&JobRow> = jobs.iter().filter(|job| job.environment.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(&gate.environment))).collect();
            let waiting = gate.state == "waiting" && held.iter().any(|job| job.status == "pending");
            let can_review = match (viewer, &repo, waiting) {
                (Some(user), Some(repo), true) if user.kind == PrincipalKind::User && user.token.as_ref().is_none_or(|t| t.job.is_none()) => {
                    let teams = self.reviewer_teams(&repo.namespace, &env, &user.username).await?;
                    let admin = access::can(Some(user), repo, Capability::Administer);
                    may_review(&env, &user.username, &teams, admin, run.actor.as_deref()).is_ok()
                }
                _ => false,
            };
            out.push(PendingDeployment {
                environment: gate.environment.clone(),
                state: gate.state.clone(),
                needs_review: gate.needs_review != 0,
                wait_until: gate.wait_until.clone(),
                reviewers: env.reviewers.clone(),
                jobs: held.iter().map(|job| job.name.clone()).collect(),
                can_review,
                reviewed_by: gate.reviewed_by.clone(),
                comment: gate.comment.clone(),
                reviewed_at: gate.reviewed_at.clone(),
            });
        }
        Ok(out)
    }

    pub async fn pending_deployments(&self, a: PendingDeploymentsArgs) -> Result<Outcome<Vec<PendingDeployment>>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        Ok(Outcome::Ok(self.pending_for(&run, &a.viewer).await?))
    }

    /// `review_deployments`: a reviewer approves or rejects the jobs an
    /// environment holds in a run.
    pub async fn review_deployments(&self, a: ReviewDeploymentsArgs) -> Result<Outcome<Vec<PendingDeployment>>> {
        if let Some(refused) = refuse_job_token(&a.actor) {
            return Ok(refused);
        }
        if a.actor.kind != PrincipalKind::User {
            return Ok(fail(FailureCode::Forbidden, "Only a person can review a deployment."));
        }
        let repo = check!(self.may(&a.actor, &a.repo, Capability::Read).await?);
        let approve = match a.state.trim() {
            "approved" | "approve" => true,
            "rejected" | "reject" => false,
            _ => return Ok(fail(FailureCode::Invalid, "state is approved or rejected.")),
        };
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        let wanted: Vec<String> = a.environments.iter().filter_map(|name| environment_name(name).ok()).collect();
        let pending = self.pending_for(&run, &Some(a.actor.clone())).await?;
        let waiting: Vec<&PendingDeployment> = pending
            .iter()
            .filter(|p| p.state == "waiting" && !p.jobs.is_empty())
            .filter(|p| wanted.is_empty() || wanted.contains(&p.environment))
            .collect();
        if waiting.is_empty() {
            return Ok(fail(FailureCode::Conflict, "No deployment of this run is waiting for review."));
        }
        let comment: Option<String> = a.comment.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(|c| c.chars().take(1000).collect());
        let admin = access::can(Some(&a.actor), &repo, Capability::Administer);
        let at = now();
        for pending in &waiting {
            let env = self.environment_rules(&run.repo_id, &pending.environment).await?;
            let teams = self.reviewer_teams(&repo.namespace, &env, &a.actor.username).await?;
            let how = match may_review(&env, &a.actor.username, &teams, admin, run.actor.as_deref()) {
                Ok(how) => how,
                Err(problem) => return Ok(fail(FailureCode::Forbidden, problem)),
            };
            let state = if approve { "approved" } else { "rejected" };
            // An admin's approval past the rules skips the wait timer too.
            let clear_wait = approve && how == Reviewer::AdminBypass;
            self.db
                .prepare(
                    "UPDATE environment_gates SET state = ?, reviewed_by = ?, comment = ?, reviewed_at = ?,
                       wait_until = CASE WHEN ? THEN NULL ELSE wait_until END
                     WHERE run_id = ? AND attempt = ? AND environment = ? AND state = 'waiting'",
                )
                .bind(&[
                    state.into(),
                    a.actor.username.as_str().into(),
                    optional(comment.as_deref()),
                    at.as_str().into(),
                    u32::from(clear_wait).into(),
                    run.id.as_str().into(),
                    (run.attempt as u32).into(),
                    pending.environment.as_str().into(),
                ])?
                .run()
                .await?;
            if !approve {
                let reason = match &comment {
                    Some(comment) => format!("{} rejected the deployment to {}: {comment}", a.actor.username, pending.environment),
                    None => format!("{} rejected the deployment to {}.", a.actor.username, pending.environment),
                };
                self.db
                    .prepare(
                        "UPDATE jobs SET status = 'completed', conclusion = 'failure', reason = ?, finished_at = ?
                         WHERE run_id = ? AND status = 'pending' AND lower(environment) = ?",
                    )
                    .bind(&[reason.into(), at.as_str().into(), run.id.as_str().into(), pending.environment.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        self.release_gates_of(&run).await?;
        self.advance(&run.id).await?;
        let run = self.run_row(&run.id).await?.unwrap_or(run);
        Ok(Outcome::Ok(self.pending_for(&run, &Some(a.actor.clone())).await?))
    }

    /// Queues a run's pending jobs whose environments now let them start.
    pub(crate) async fn release_gates_of(&self, run: &RunRow) -> Result<bool> {
        let jobs = self.job_rows(&run.id).await?;
        let at = now();
        let mut released = false;
        for job in jobs.iter().filter(|job| job.status == "pending") {
            let Some(environment) = job.environment.as_deref() else { continue };
            match self.gate(run, environment).await? {
                Gate::Open => {
                    // A self-hosted job waits for a runner again.
                    let reason = job
                        .labels
                        .as_deref()
                        .and_then(|labels| serde_json::from_str::<Vec<String>>(labels).ok())
                        .map(|stored| g1t_contracts::runners::waiting_reason(&g1t_contracts::runners::Wanted::from_stored(&stored)));
                    self.db
                        .prepare("UPDATE jobs SET status = 'queued', reason = ?, queued_at = ? WHERE id = ? AND status = 'pending'")
                        .bind(&[optional(reason.as_deref()), at.as_str().into(), job.id.as_str().into()])?
                        .run()
                        .await?;
                    released = true;
                }
                Gate::Held(reason) => {
                    if job.reason.as_deref() != Some(reason.as_str()) {
                        self.db
                            .prepare("UPDATE jobs SET reason = ? WHERE id = ? AND status = 'pending'")
                            .bind(&[reason.into(), job.id.as_str().into()])?
                            .run()
                            .await?;
                    }
                }
                Gate::Refused(reason) => {
                    self.db
                        .prepare("UPDATE jobs SET status = 'completed', conclusion = 'failure', reason = ?, finished_at = ? WHERE id = ? AND status = 'pending'")
                        .bind(&[reason.into(), at.as_str().into(), job.id.as_str().into()])?
                        .run()
                        .await?;
                    released = true;
                }
            }
        }
        Ok(released)
    }

    /// Every minute: runs whose jobs wait at an environment whose timer has
    /// run out, or whose review came in, move along.
    pub(crate) async fn release_gates(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Waiting {
            run_id: String,
        }
        let runs = self
            .db
            .prepare("SELECT DISTINCT run_id FROM jobs WHERE status = 'pending' LIMIT 100")
            .all()
            .await?
            .results::<Waiting>()?;
        for waiting in runs {
            let Some(run) = self.run_row(&waiting.run_id).await? else { continue };
            if self.release_gates_of(&run).await? {
                self.advance(&run.id).await?;
            }
        }
        Ok(())
    }

    // --- Approving runs of pull requests from outside --------------------------

    /// Why a pull request's run waits for approval, if it does: by the
    /// repository's policy, whoever the pull request is for (its owner).
    pub(crate) async fn approval_needed(&self, repo: &Repo, owner: &User, ws: &User) -> Result<Option<String>> {
        // g1t's own work, nobody asked for, is the workspace's.
        if owner.id == AGENT_ID || owner.kind == PrincipalKind::System {
            return Ok(None);
        }
        let policy = self.approval_policy(&repo.id).await?;
        let permission: Outcome<PermissionInfo> = g1t_kit::call(
            &self.identity,
            "collaborator_permission",
            &CollaboratorPermissionArgs {
                viewer: Some(ws.clone()),
                path: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                username: owner.username.clone(),
            },
        )
        .await?;
        let info = permission.into_result().ok();
        let member = owner.is_member(&repo.namespace.to_lowercase())
            || info.as_ref().is_some_and(|info| matches!(info.source, Some(AccessSource::Owner | AccessSource::Base | AccessSource::Team)));
        if member {
            return Ok(None);
        }
        let can_push = info.as_ref().and_then(|info| info.role).is_some_and(|role| access::allows(role, Capability::Push));
        let first_time = !self.has_merged(repo, owner, ws).await?;
        Ok(approval_reason(&policy, member, can_push, first_time).map(|why| format!("{} {why}, so someone with the Write role approves its runs first.", owner.username)))
    }

    /// Whether a pull request of `owner`'s has been merged into `repo`.
    async fn has_merged(&self, repo: &Repo, owner: &User, ws: &User) -> Result<bool> {
        let closed: Outcome<Vec<g1t_contracts::work::Pull>> = g1t_kit::call(
            &self.work,
            "list_pulls",
            &g1t_contracts::work::ListPullsArgs {
                repo: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                viewer: Some(ws.clone()),
                state: Some(g1t_contracts::work::State::Closed),
                label: None,
                milestone: None,
                base: None,
            },
        )
        .await
        .unwrap_or_else(|_| Outcome::Ok(Vec::new()));
        Ok(closed.into_result().unwrap_or_default().iter().any(|pull| pull.merged_at.is_some() && pull.owner().id == owner.id))
    }

    /// `approve_run`: someone with the Write role lets a pull request's run
    /// that waits for approval start.
    pub async fn approve_run(&self, a: RunActionArgs) -> Result<Outcome<WorkflowRun>> {
        if let Some(refused) = refuse_job_token(&a.actor) {
            return Ok(refused);
        }
        check!(self.may(&a.actor, &a.repo, Capability::Run).await?);
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        if run.status != "action_required" {
            return Ok(fail(FailureCode::Conflict, "This run is not waiting for approval."));
        }
        let mut approval = run.approval().unwrap_or(RunApproval { state: "required".into(), reason: String::new(), approved_by: None });
        approval.state = "approved".to_owned();
        approval.approved_by = Some(a.actor.username.clone());
        let started = self
            .db
            .prepare("UPDATE runs SET status = 'queued', approval = ?, approved_by = ? WHERE id = ? AND status = 'action_required' RETURNING id")
            .bind(&[serde_json::to_string(&approval)?.into(), a.actor.username.as_str().into(), run.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if started.is_none() {
            return Ok(fail(FailureCode::Conflict, "This run is not waiting for approval."));
        }
        if let Some(run) = self.run_row(&run.id).await? {
            self.enter_group(&run).await?;
        }
        self.run_summary(&run.id).await
    }
}

/// A workflow job's own token may not approve or change what keeps runs
/// safe: a workflow could otherwise let itself through.
fn refuse_job_token<T>(actor: &User) -> Option<Outcome<T>> {
    actor
        .token
        .as_ref()
        .is_some_and(|token| token.job.is_some())
        .then(|| fail(FailureCode::Forbidden, "A workflow job's token cannot approve runs or deployments, or change their rules."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(reviewers: &[(&str, &str)]) -> Environment {
        Environment {
            reviewers: reviewers.iter().map(|(kind, name)| EnvironmentReviewer { kind: (*kind).into(), name: (*name).into() }).collect(),
            ..unprotected("production")
        }
    }

    fn pattern(name: &str, kind: &str) -> BranchPattern {
        BranchPattern { name: name.into(), kind: kind.into() }
    }

    #[test]
    fn the_default_token_the_github_way() {
        use TokenDefault::{Permissive, Restricted};
        // A new repository takes its workspace's default: read-only unless it says.
        assert_eq!(effective_default(None, false, Restricted, Permissive), Restricted);
        assert_eq!(effective_default(None, false, Permissive, Permissive), Permissive);
        // One made before restricted tokens keeps read and write.
        assert_eq!(effective_default(None, true, Restricted, Permissive), Permissive);
        // A repository's own choice wins...
        assert_eq!(effective_default(Some(Restricted), true, Permissive, Permissive), Restricted);
        assert_eq!(effective_default(Some(Permissive), false, Restricted, Permissive), Permissive);
        // ...but never past the workspace's maximum.
        assert_eq!(effective_default(Some(Permissive), true, Permissive, Restricted), Restricted);
        assert_eq!(effective_default(None, true, Restricted, Restricted), Restricted);
        // A workspace without a row: new repositories read-only, writes allowed, no pull requests.
        let policy = workspace_policy(None);
        assert_eq!((policy.default_permissions.as_str(), policy.max_permissions.as_str()), ("read", "write"));
        assert!(!policy.can_approve_pull_requests);
    }

    #[test]
    fn which_refs_may_deploy() {
        assert!(branch_allowed("all", &[], "refs/pull/3/merge", false, "production").is_ok());
        assert!(branch_allowed("protected", &[], "refs/heads/main", true, "production").is_ok());
        assert!(branch_allowed("protected", &[], "refs/heads/feature", false, "production").unwrap_err().contains("protected branches only"));
        // A pull request's merge ref is never a protected branch.
        assert!(branch_allowed("protected", &[], "refs/pull/3/merge", true, "production").is_err());
        let selected = [pattern("main", "branch"), pattern("release/*", "branch"), pattern("v*", "tag")];
        assert!(branch_allowed("selected", &selected, "refs/heads/release/1.x", false, "production").is_ok());
        assert!(branch_allowed("selected", &selected, "refs/tags/v1.2.0", false, "production").is_ok());
        assert!(branch_allowed("selected", &selected, "refs/heads/feature", false, "production").is_err());
        // A tag pattern does not let a branch of that name through.
        assert!(branch_allowed("selected", &[pattern("v*", "tag")], "refs/heads/v2", false, "production").is_err());
        assert!(branch_allowed("selected", &[], "refs/heads/main", false, "production").is_err());
    }

    #[test]
    fn who_may_review() {
        let production = env(&[("user", "ada"), ("team", "deployers")]);
        assert_eq!(may_review(&production, "ada", &[], false, Some("bo")), Ok(Reviewer::Listed));
        assert_eq!(may_review(&production, "Ada", &[], false, None), Ok(Reviewer::Listed), "names compare without case");
        assert_eq!(may_review(&production, "cy", &["deployers".into()], false, None), Ok(Reviewer::Listed));
        assert!(may_review(&production, "cy", &[], false, None).unwrap_err().contains("not one of"));
        // An admin past the rules, unless the environment says no.
        assert_eq!(may_review(&production, "cy", &[], true, None), Ok(Reviewer::AdminBypass));
        let strict = Environment { admins_bypass: false, ..production.clone() };
        assert!(may_review(&strict, "cy", &[], true, None).is_err());
        // Whoever started the run, when self-review is off.
        let no_self = Environment { prevent_self_review: true, ..production.clone() };
        assert!(may_review(&no_self, "ada", &[], false, Some("ada")).unwrap_err().contains("You started this run"));
        assert_eq!(may_review(&no_self, "ada", &[], false, Some("bo")), Ok(Reviewer::Listed));
        assert_eq!(may_review(&no_self, "ada", &[], true, Some("ada")), Ok(Reviewer::AdminBypass));
        // Without reviewers there is nothing to review; an admin may start it.
        let timer = Environment { wait_minutes: 30, ..env(&[]) };
        assert!(may_review(&timer, "ada", &[], false, None).unwrap_err().contains("no reviewers"));
        assert_eq!(may_review(&timer, "ada", &[], true, None), Ok(Reviewer::AdminBypass));
    }

    #[test]
    fn a_gate_opens_on_review_and_time() {
        let now = "2026-10-08T12:00:00Z";
        assert!(!gate_open("waiting", true, None, now));
        assert!(gate_open("approved", true, None, now));
        assert!(!gate_open("approved", true, Some("2026-10-08T12:30:00Z"), now));
        assert!(gate_open("approved", true, Some("2026-10-08T11:30:00Z"), now));
        assert!(gate_open("waiting", false, Some("2026-10-08T11:59:00Z"), now));
        assert!(!gate_open("waiting", false, Some("2026-10-08T12:01:00Z"), now));
        assert!(!gate_open("rejected", false, None, now));
        assert_eq!(held_reason("production", true, None), "Waiting for a review to deploy to production.");
        assert!(held_reason("staging", false, Some("2026-10-08T12:30:00Z")).contains("wait timer"));
    }

    #[test]
    fn which_pull_requests_wait_for_approval() {
        // Members never wait.
        for policy in APPROVAL_POLICIES {
            assert_eq!(approval_reason(policy, true, true, true), None);
        }
        // The default: anyone who cannot push, and an outside collaborator's first.
        assert!(approval_reason("outside_contributors", false, false, false).is_some());
        assert!(approval_reason("outside_contributors", false, true, true).is_some());
        assert_eq!(approval_reason("outside_contributors", false, true, false), None);
        // First-time contributors only.
        assert!(approval_reason("first_time_contributors", false, false, true).is_some());
        assert_eq!(approval_reason("first_time_contributors", false, false, false), None);
        // Everyone outside the workspace.
        assert!(approval_reason("all_external_contributors", false, true, false).is_some());
    }

    #[test]
    fn a_jobs_permissions_are_g1t_scopes_and_outside_runs_read_only() {
        use g1t_actions::permissions::{Access, Permissions};
        use g1t_contracts::scopes::{Level, Scope, TokenAccess};
        for scope in Permissions::all(Access::Write).scopes() {
            assert!(Scope::parse(scope).is_some(), "{scope} is not a g1t scope");
        }
        let token = |permissions: &Permissions| TokenAccess {
            scopes: Some(permissions.scopes().into_iter().map(str::to_owned).collect()),
            repo: Some("acme/web".into()),
            ..TokenAccess::default()
        };
        // The default: it can clone, and nothing more.
        let restricted = token(&Permissions::default_for(TokenDefault::Restricted));
        assert!(restricted.allows(Scope::CodeRead));
        assert!(!restricted.allows(Scope::CodeWrite));
        assert!(!restricted.allows(Scope::IssuesWrite));
        // A pull request from outside reads, whatever it asks for.
        let outside = token(&Permissions::all(Access::Write).read_only());
        assert!(Scope::ALL.iter().filter(|scope| outside.allows(**scope)).all(|scope| scope.level() == Level::Read));
        // Never more than a repository's: no admin, no secrets, no agents.
        let everything = token(&Permissions::all(Access::Write));
        for never in [Scope::RepoAdmin, Scope::SecretsRead, Scope::AgentsRun, Scope::WorkspaceRead, Scope::RunnersRead] {
            assert!(!everything.allows(never), "{}", never.as_str());
        }
    }

    #[test]
    fn environment_names_are_checked() {
        assert_eq!(environment_name(" Production ").unwrap(), "production");
        assert!(environment_name("staging env").is_err());
        assert!(environment_name("").is_err());
        assert!(environment_name(&"a".repeat(41)).is_err());
    }

    #[test]
    fn a_job_token_cannot_let_itself_through() {
        let mut actor = User { id: "wsp_1".into(), username: "acme".into(), kind: PrincipalKind::Workspace, ..User::default() };
        assert!(refuse_job_token::<()>(&actor).is_none());
        actor.token = Some(Box::new(g1t_contracts::scopes::TokenAccess {
            job: Some(g1t_contracts::scopes::JobToken { run_id: "run_1".into(), job_id: "job_1".into(), pull_requests: false }),
            ..Default::default()
        }));
        assert!(refuse_job_token::<()>(&actor).is_some());
    }
}
