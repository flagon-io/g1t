//! Making and changing access tokens, what each one reaches, and the rules
//! a workspace sets for the personal tokens that reach it. See
//! `g1t_contracts::tokens`.
//!
//! There is one kind of token. Its **permissions** are a level for each
//! resource, stored as scopes (the highest of each resource), which every
//! check reads. Its **reach** is where they apply: a person's token is made
//! for every workspace its owner belongs to, for one workspace (all,
//! selected or none of its private repositories), or for no workspace (its
//! owner's account and public repositories only); a workspace's token for
//! its own workspace, all of its repositories or the ones selected.
//!
//! Migration 0041 made the tokens of both earlier kinds this one: classic
//! tokens became tokens for every workspace, with the permissions their
//! scopes already were; tokens with a resource owner became tokens for that
//! workspace (or for no workspace), keeping their scopes.
//!
//! Each time a token is used, [`Identity::apply_reach`] cuts the person it
//! resolves to down to what it reaches: a token made for one workspace
//! keeps only that membership and its grants (none while it waits for
//! approval), a token made for no workspace keeps none, and a token made
//! for every workspace loses those whose rules keep it out (not allowing
//! such tokens, a lifetime past their limit, or an owner revoking it
//! there). Services then decide as for anyone, and `access::granted` holds
//! a token to its selected repositories.
//!
//! **Approval.** A token made for a workspace that asks for approval
//! starts pending, unless its owner is an owner there. The workspace's
//! owners hear of it in their inbox (`token.approval_requested`) and
//! approve or deny it; its owner hears back (`token.approval_reviewed`).
//! Changing its repositories or permissions asks again.

use std::collections::{HashMap, HashSet};

use g1t_contracts::audit::Surface;
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::identity::{AccessToken, CreatedAccessToken};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::scopes::{RepositorySelection, Scope, TokenReach, permissions_of, resolve_permissions, scopes_text};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::tokens::*;
use g1t_contracts::{FailureCode, Outcome, Role, User, Viewer};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::security::is_person;
use crate::tokens::{Grant, MAX_TOKENS_PER_WORKSPACE, Owner};

const DAY_SECONDS: u64 = 86_400;

/// What a token row says about its reach, read with it when it is used.
/// Numbers arrive from D1 as floats.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct Facts {
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    owner_workspace_id: Option<String>,
    #[serde(default)]
    repository_selection: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    admin: Option<f64>,
}

impl Facts {
    fn selection(&self) -> RepositorySelection {
        self.repository_selection.as_deref().and_then(RepositorySelection::parse).unwrap_or_default()
    }

    /// Made for one workspace.
    fn made_for_one(&self) -> bool {
        self.owner_workspace_id.is_some()
    }

    /// Made for no workspace: its owner's account and public repositories.
    fn account_only(&self) -> bool {
        self.owner_workspace_id.is_none() && self.selection() == RepositorySelection::Public
    }

    fn lifetime(&self) -> (u64, Option<u64>) {
        let created = self.created_at.as_deref().and_then(parse_rfc3339).unwrap_or(0);
        (created, self.expires_at.as_deref().and_then(parse_rfc3339))
    }
}

/// What a listed token's row adds, for showing it.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct TokenRowMore {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    admin: Option<f64>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    repository_selection: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    review_reason: Option<String>,
    #[serde(default)]
    owner_workspace: Option<String>,
}

impl TokenRowMore {
    /// Fills in what it adds to a token's details. Selected repositories
    /// are named later, by [`Identity::name_repositories`].
    pub(crate) fn describe(&self, info: &mut AccessToken) {
        info.description = self.description.clone();
        info.admin = self.admin.is_some_and(|admin| admin >= 1.0);
        info.workspace_owned = self.workspace_id.is_some();
        info.workspace = self.owner_workspace.clone();
        info.repository_selection = self.repository_selection.as_deref().and_then(RepositorySelection::parse).unwrap_or_default();
        info.status = TokenStatus::parse(self.status.as_deref().unwrap_or("active"));
        info.review_reason = self.review_reason.clone();
    }
}

/// A workspace whose rules apply to a token, as read for it.
#[derive(Clone, Debug, Default, Deserialize)]
struct RuleRow {
    id: String,
    slug: String,
    /// Stored as `allow_classic`: tokens made for every workspace.
    #[serde(default)]
    allow_classic: Option<f64>,
    /// Stored as `allow_fine_grained`: tokens made for this one.
    #[serde(default)]
    allow_fine_grained: Option<f64>,
    #[serde(default)]
    require_approval: Option<f64>,
    #[serde(default)]
    max_lifetime_days: Option<f64>,
    #[serde(default)]
    forbid_no_expiry: Option<f64>,
    #[serde(default)]
    updated_by: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    /// 1 when an owner revoked this token here.
    #[serde(default)]
    revoked: Option<f64>,
}

impl RuleRow {
    fn policy(&self) -> TokenPolicy {
        let flag = |value: Option<f64>, default: bool| value.map_or(default, |value| value >= 1.0);
        TokenPolicy {
            allow_tokens_for_all_workspaces: flag(self.allow_classic, true),
            allow_tokens_for_this_workspace: flag(self.allow_fine_grained, true),
            require_approval: flag(self.require_approval, true),
            max_lifetime_days: self.max_lifetime_days.filter(|days| *days >= 1.0).map(|days| days as u32),
            forbid_no_expiry: flag(self.forbid_no_expiry, false),
            updated_by: self.updated_by.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// Why a token does not reach a workspace, as its owners are told; `None`
/// when it does. `this_workspace` is whether the token is made for this
/// workspace alone, with `status`.
pub(crate) fn blocked_by(
    policy: &TokenPolicy,
    this_workspace: bool,
    status: TokenStatus,
    revoked: bool,
    created_ms: u64,
    expires_ms: Option<u64>,
) -> Option<&'static str> {
    if revoked || status == TokenStatus::Revoked {
        return Some("revoked");
    }
    if this_workspace {
        match status {
            TokenStatus::Pending => return Some("pending approval"),
            TokenStatus::Denied => return Some("denied"),
            _ => {}
        }
        if !policy.allow_tokens_for_this_workspace {
            return Some("tokens made for this workspace not allowed");
        }
    } else if !policy.allow_tokens_for_all_workspaces {
        return Some("tokens for all workspaces not allowed");
    }
    if !policy.lifetime_allowed(created_ms, expires_ms) {
        return Some(if expires_ms.is_none() { "never expires" } else { "lasts too long" });
    }
    None
}

fn text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// A description as kept: trimmed, at most 500 characters, none if empty.
fn tidy(text: Option<&str>) -> Option<String> {
    text.map(str::trim).filter(|text| !text.is_empty()).map(|text| text.chars().take(500).collect())
}

/// `token.approval_requested` and `token.approval_reviewed`: told in the
/// inbox of the people named in `notify`, with a link (events' inbox.rs).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenNotice<'a> {
    workspace: &'a str,
    token_id: &'a str,
    token_name: &'a str,
    notify: Vec<String>,
    title: String,
    body: String,
    link: String,
}

#[derive(Deserialize)]
struct Owned {
    id: String,
    user_id: Option<String>,
    workspace_id: Option<String>,
    name: String,
    owner_workspace_id: Option<String>,
    status: Option<String>,
}

impl Identity {
    /// Cuts `user`, resolved from the token `token_id`, down to what the
    /// token reaches. `personal` is whether it is a person's token (not a
    /// workspace's or a job's). See the module docs.
    pub(crate) async fn apply_reach(&self, user: &mut User, token_id: &str, personal: bool, facts: &Facts) -> Result<()> {
        if user.token.is_none() {
            return Ok(());
        }
        if !personal {
            // A workspace's own token: Write on its repositories, or Admin
            // when it holds Repositories: admin; the selected ones only
            // when it has a selection.
            let selected = facts.selection() == RepositorySelection::Selected;
            let repo_ids = if selected { self.token_repo_ids(token_id).await? } else { Vec::new() };
            let slug = user.username.clone();
            if let Some(access) = user.token.as_deref_mut() {
                access.admin = facts.admin.is_some_and(|admin| admin >= 1.0);
                if selected {
                    access.reach = Some(TokenReach { workspace: Some(slug), repositories: RepositorySelection::Selected, repo_ids });
                }
            }
            return Ok(());
        }
        if facts.account_only() {
            user.workspaces.clear();
            user.grants.clear();
            if let Some(access) = user.token.as_deref_mut() {
                access.reach = Some(TokenReach { workspace: None, repositories: RepositorySelection::Public, repo_ids: Vec::new() });
            }
            return Ok(());
        }
        let one = facts.made_for_one();
        // The workspaces it could reach, with their rules for it.
        let mut slugs: Vec<String> = user.workspaces.iter().map(|membership| membership.slug.clone()).collect();
        slugs.extend(user.grants.iter().map(|grant| grant.workspace.to_lowercase()));
        slugs.sort();
        slugs.dedup();
        if slugs.is_empty() && !one {
            return Ok(());
        }
        let rules = self.rules_for(&slugs, token_id).await?;
        let (created, expires) = facts.lifetime();
        let status = TokenStatus::parse(facts.status.as_deref().unwrap_or("active"));
        let mut keep: HashSet<String> = HashSet::new();
        let mut made_for: Option<String> = None;
        for rule in &rules {
            if one && facts.owner_workspace_id.as_deref() != Some(rule.id.as_str()) {
                continue;
            }
            if one {
                made_for = Some(rule.slug.clone());
            }
            let revoked = rule.revoked.is_some_and(|revoked| revoked >= 1.0);
            if blocked_by(&rule.policy(), one, status, revoked, created, expires).is_none() {
                keep.insert(rule.slug.clone());
            }
        }
        // Workspaces without a rules row: the defaults, which let in a
        // token for every workspace, and one made for them once active.
        for slug in &slugs {
            if rules.iter().any(|rule| &rule.slug == slug) {
                continue;
            }
            if !one && blocked_by(&TokenPolicy::default(), false, status, false, created, expires).is_none() {
                keep.insert(slug.clone());
            }
        }
        user.workspaces.retain(|membership| keep.contains(&membership.slug));
        user.grants.retain(|grant| keep.contains(&grant.workspace.to_lowercase()));
        if one {
            let selection = facts.selection();
            let reaches = made_for.as_ref().is_some_and(|slug| keep.contains(slug));
            let repo_ids = if reaches && selection == RepositorySelection::Selected { self.token_repo_ids(token_id).await? } else { Vec::new() };
            if let Some(access) = user.token.as_deref_mut() {
                access.reach = Some(TokenReach {
                    workspace: made_for,
                    // Until it reaches its workspace, public repositories only.
                    repositories: if reaches { selection } else { RepositorySelection::Public },
                    repo_ids,
                });
            }
        }
        Ok(())
    }

    /// The workspaces named by `slugs` that have rules, or that `token_id`
    /// was revoked in, with both. For a token made for one workspace, that
    /// workspace too, whatever its rules.
    async fn rules_for(&self, slugs: &[String], token_id: &str) -> Result<Vec<RuleRow>> {
        let mut binds: Vec<JsValue> = vec![token_id.into()];
        binds.extend(slugs.iter().map(|slug| JsValue::from(slug.as_str())));
        let marks = vec!["?"; slugs.len()].join(", ");
        let in_slugs = if slugs.is_empty() { "0".to_owned() } else { format!("w.slug IN ({marks})") };
        let sql = format!(
            "SELECT w.id, w.slug, p.allow_classic, p.allow_fine_grained, p.require_approval, p.max_lifetime_days,
               p.forbid_no_expiry, p.updated_by, p.updated_at,
               (SELECT 1 FROM token_workspace_revocations r WHERE r.token_id = ?1 AND r.workspace_id = w.id) AS revoked
             FROM workspaces w LEFT JOIN token_policies p ON p.workspace_id = w.id
             WHERE w.deleted_at IS NULL
               AND (({in_slugs}) AND (p.workspace_id IS NOT NULL
                     OR EXISTS (SELECT 1 FROM token_workspace_revocations r WHERE r.token_id = ?1 AND r.workspace_id = w.id))
                 OR w.id = (SELECT owner_workspace_id FROM access_tokens WHERE id = ?1))"
        );
        self.db.prepare(sql).bind(&binds)?.all().await?.results::<RuleRow>()
    }

    async fn token_repo_ids(&self, token_id: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            repo_id: String,
        }
        Ok(self
            .db
            .prepare("SELECT repo_id FROM token_repositories WHERE token_id = ? ORDER BY repo_id")
            .bind(&[token_id.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.repo_id)
            .collect())
    }

    /// A workspace's rules for tokens, by slug: the defaults when it has
    /// none. `None` when there is no such workspace.
    async fn policy_of(&self, slug: &str) -> Result<Option<(String, TokenPolicy)>> {
        let row = self
            .db
            .prepare(
                "SELECT w.id, w.slug, p.allow_classic, p.allow_fine_grained, p.require_approval, p.max_lifetime_days,
                   p.forbid_no_expiry, p.updated_by, p.updated_at, NULL AS revoked
                 FROM workspaces w LEFT JOIN token_policies p ON p.workspace_id = w.id
                 WHERE w.slug = ? AND w.deleted_at IS NULL",
            )
            .bind(&[slug.to_lowercase().into()])?
            .first::<RuleRow>(None)
            .await?;
        Ok(row.map(|row| (row.id.clone(), row.policy())))
    }

    // --- Making and changing tokens --------------------------------------------

    /// Repositories as asked for (`owner/name`, or a name in `slug`), as
    /// the person can see them: their ids, or why one cannot be chosen.
    async fn chosen_repositories(&self, user: &User, slug: &str, names: &[String]) -> Result<std::result::Result<Vec<String>, String>> {
        if names.is_empty() {
            return Ok(Err("Choose at least one repository, or all repositories.".to_owned()));
        }
        if names.len() > MAX_SELECTED_REPOSITORIES {
            return Ok(Err(format!("A token can reach at most {MAX_SELECTED_REPOSITORIES} selected repositories.")));
        }
        let mut ids = Vec::new();
        for name in names {
            let name = name.trim().trim_start_matches('/');
            let (namespace, repo) = name.split_once('/').unwrap_or((slug, name));
            if !namespace.eq_ignore_ascii_case(slug) {
                return Ok(Err(format!("{name} is not a repository of {slug}, the workspace the token is made for.")));
            }
            let path = RepoPath { namespace: slug.to_owned(), name: repo.to_owned() };
            match self.repo_for(&path, &Some(user.clone())).await? {
                Some(found) => ids.push(found.id),
                None => return Ok(Err(format!("There is no repository {slug}/{repo} that you can see."))),
            }
        }
        ids.sort();
        ids.dedup();
        Ok(Ok(ids))
    }

    /// Whether `user` owns the workspace `slug`.
    fn owns(user: &User, slug: &str) -> bool {
        user.role_in(&slug.to_lowercase()) == Some(Role::Owner)
    }

    pub async fn create_token(&self, a: CreateTokenArgs) -> Result<Outcome<CreatedAccessToken>> {
        if !is_person(&a.actor) || a.actor.token.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person, signed in on g1t.sh, can make an access token."));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address before making a token."));
        }
        if a.name.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the token after what will use it."));
        }
        if a.ttl_seconds.is_some_and(|ttl| !(DAY_SECONDS..=u64::from(MAX_LIFETIME_DAYS) * DAY_SECONDS).contains(&ttl)) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A token lasts between 1 and {MAX_LIFETIME_DAYS} days, or does not expire."),
            ));
        }
        match a.owner.as_deref().map(|slug| slug.trim().to_lowercase()).filter(|slug| !slug.is_empty()) {
            Some(slug) => self.create_workspace_owned(&a, &slug).await,
            None => self.create_personal(&a).await,
        }
    }

    /// A workspace's own token, made by an owner.
    async fn create_workspace_owned(&self, a: &CreateTokenArgs, slug: &str) -> Result<Outcome<CreatedAccessToken>> {
        let workspace_id = match self.owned_workspace(&a.actor, slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let scopes = match resolve_permissions(&a.permissions, false) {
            Ok(scopes) => scopes,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        if scopes.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give the token at least one permission."));
        }
        let selection = a.repository_selection;
        if selection == RepositorySelection::Public {
            return Ok(Outcome::fail(FailureCode::Invalid, "A workspace's token reaches all of its repositories, or the ones you select."));
        }
        if self.tokens_where("access_tokens.workspace_id = ?", &workspace_id).await?.len() >= MAX_TOKENS_PER_WORKSPACE {
            return Ok(Outcome::fail(FailureCode::Conflict, "This workspace has the maximum number of access tokens. Delete one first."));
        }
        let repo_ids = if selection == RepositorySelection::Selected {
            match self.chosen_repositories(&a.actor, slug, &a.repositories).await? {
                Ok(ids) => ids,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            }
        } else {
            Vec::new()
        };
        // Repositories: admin makes it an admin of the workspace's
        // repositories; without it, it has Write, as a member does.
        let admin = scopes.contains(&Scope::RepoAdmin);
        let grant = Grant { scopes: Some(scopes) };
        let mut created = self.mint(Owner::Workspace { id: &workspace_id, created_by: Some(&a.actor.id) }, &a.name, a.ttl_seconds, &grant, true).await?;
        let description = tidy(a.description.as_deref());
        let mut statements = vec![self
            .db
            .prepare("UPDATE access_tokens SET repository_selection = ?, description = ?, admin = ? WHERE id = ?")
            .bind(&[
                selection.as_str().into(),
                text(description.as_deref()),
                JsValue::from(u8::from(admin)),
                created.info.id.as_str().into(),
            ])?];
        statements.extend(self.repository_rows(&created.info.id, &repo_ids)?);
        self.db.batch(statements).await?;
        created.info.created_by = Some(a.actor.username.clone());
        created.info.description = description;
        created.info.admin = admin;
        created.info.repository_selection = selection;
        created.info.repositories = qualified_all(Some(slug), &repo_ids, &a.repositories);
        self.audit_workspace(
            &a.actor,
            "workspace_token.created",
            slug,
            Surface::Web,
            format!("Created workspace access token {}{}", created.info.name, if admin { " with Repositories: admin" } else { "" }),
        )
        .await;
        Ok(Outcome::Ok(created))
    }

    /// A person's own token.
    async fn create_personal(&self, a: &CreateTokenArgs) -> Result<Outcome<CreatedAccessToken>> {
        let scopes = match resolve_permissions(&a.permissions, true) {
            Ok(scopes) => scopes,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        if scopes.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give the token at least one permission."));
        }
        let slug = a.workspace.as_deref().map(|slug| slug.trim().to_lowercase()).filter(|slug| !slug.is_empty());
        let selection = a.repository_selection;
        let mut status = TokenStatus::Active;
        let mut workspace_id = None;
        let mut repo_ids = Vec::new();
        match &slug {
            Some(slug) => {
                if !a.actor.is_member(slug) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, format!("You can only make a token for a workspace you belong to, and {slug} is not one.")));
                }
                let Some((id, policy)) = self.policy_of(slug).await? else {
                    return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
                };
                if let Some(refusal) = policy.refusal(slug, true, a.ttl_seconds) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, refusal));
                }
                if policy.require_approval && !Self::owns(&a.actor, slug) {
                    status = TokenStatus::Pending;
                }
                if selection == RepositorySelection::Selected {
                    repo_ids = match self.chosen_repositories(&a.actor, slug, &a.repositories).await? {
                        Ok(ids) => ids,
                        Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
                    };
                }
                workspace_id = Some(id);
            }
            None if selection == RepositorySelection::Selected => {
                return Ok(Outcome::fail(FailureCode::Invalid, "Choose the workspace whose repositories the token reaches."));
            }
            None => {}
        }
        let grant = Grant { scopes: Some(scopes) };
        let mut created = self.mint(Owner::User(&a.actor.id), &a.name, a.ttl_seconds, &grant, true).await?;
        let description = tidy(a.description.as_deref());
        let mut statements = vec![self
            .db
            .prepare("UPDATE access_tokens SET owner_workspace_id = ?, repository_selection = ?, description = ?, status = ? WHERE id = ?")
            .bind(&[
                text(workspace_id.as_deref()),
                selection.as_str().into(),
                text(description.as_deref()),
                status.as_str().into(),
                created.info.id.as_str().into(),
            ])?];
        statements.extend(self.repository_rows(&created.info.id, &repo_ids)?);
        self.db.batch(statements).await?;
        created.info.description = description;
        created.info.workspace = slug.clone();
        created.info.repository_selection = selection;
        created.info.repositories = qualified_all(slug.as_deref(), &repo_ids, &a.repositories);
        created.info.status = status;
        // In the person's security log and their workspaces' audit logs.
        self.log_security(&a.actor.id, "token_created", Some(&created.info.name), None).await;
        self.audit_account(&a.actor, "token.created", &format!("Created access token {}", created.info.name)).await;
        if let (Some(slug), TokenStatus::Pending) = (&slug, status) {
            self.ask_owners(&a.actor, slug, &created.info).await?;
        }
        Ok(Outcome::Ok(created))
    }

    /// Statements that set a token's selected repositories.
    fn repository_rows(&self, token_id: &str, repo_ids: &[String]) -> Result<Vec<worker::D1PreparedStatement>> {
        repo_ids
            .iter()
            .map(|repo_id| {
                self.db
                    .prepare("INSERT OR IGNORE INTO token_repositories (token_id, repo_id) VALUES (?, ?)")
                    .bind(&[token_id.into(), repo_id.as_str().into()])
            })
            .collect()
    }

    pub async fn update_token(&self, a: UpdateTokenArgs) -> Result<Outcome<AccessToken>> {
        if !is_person(&a.actor) || a.actor.token.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person, signed in on g1t.sh, can change an access token."));
        }
        let owner_slug = a.owner.as_deref().map(|slug| slug.trim().to_lowercase()).filter(|slug| !slug.is_empty());
        let found = self.owned_token(&a.id).await?;
        let found = match (&owner_slug, found) {
            (Some(slug), Some(token)) => {
                let workspace_id = match self.owned_workspace(&a.actor, slug).await? {
                    Outcome::Ok(id) => id,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                if token.workspace_id.as_deref() != Some(workspace_id.as_str()) {
                    return Ok(Outcome::fail(FailureCode::NotFound, "No such token."));
                }
                token
            }
            (None, Some(token)) if token.user_id.as_deref() == Some(a.actor.id.as_str()) => token,
            _ => return Ok(Outcome::fail(FailureCode::NotFound, "No such token.")),
        };
        let personal = found.user_id.is_some();
        // The workspace a personal token is made for; for a workspace's
        // token, its own. Its repositories are chosen there.
        let made_for = match &found.owner_workspace_id {
            Some(id) => self.slug_of(id).await?,
            None => None,
        };
        let repo_workspace = if personal { made_for.clone() } else { owner_slug.clone() };
        let mut sets: Vec<(&str, JsValue)> = Vec::new();
        if let Some(name) = a.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            sets.push(("name", name.chars().take(100).collect::<String>().into()));
        }
        if let Some(description) = &a.description {
            sets.push(("description", text(tidy(Some(description)).as_deref())));
        }
        let mut widened = false;
        if let Some(asked) = &a.permissions {
            let scopes = match resolve_permissions(asked, personal) {
                Ok(scopes) => scopes,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            if scopes.is_empty() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the token at least one permission."));
            }
            if !personal {
                sets.push(("admin", JsValue::from(u8::from(scopes.contains(&Scope::RepoAdmin)))));
            }
            sets.push(("scopes", scopes_text(&scopes).into()));
            widened = true;
        }
        if let Some(selection) = a.repository_selection {
            if selection == RepositorySelection::Selected && repo_workspace.is_none() {
                return Ok(Outcome::fail(FailureCode::Invalid, "This token is not made for one workspace, so it cannot select repositories."));
            }
            if selection == RepositorySelection::Public && !personal {
                return Ok(Outcome::fail(FailureCode::Invalid, "A workspace's token reaches all of its repositories, or the ones you select."));
            }
            sets.push(("repository_selection", selection.as_str().into()));
            widened = true;
        }
        let mut repo_ids: Option<Vec<String>> = None;
        if let Some(slug) = &repo_workspace {
            let selection = a.repository_selection;
            let selected = selection == Some(RepositorySelection::Selected) || (selection.is_none() && a.repositories.is_some());
            if selected {
                let names = a.repositories.clone().unwrap_or_default();
                repo_ids = Some(match self.chosen_repositories(&a.actor, slug, &names).await? {
                    Ok(ids) => ids,
                    Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
                });
                widened = true;
            } else if selection.is_some() {
                repo_ids = Some(Vec::new());
            }
        }
        // Asking for more, of a workspace that approves tokens, asks again.
        let mut ask = false;
        if widened && personal && let Some(slug) = &made_for {
            let policy = self.policy_of(slug).await?.map(|(_, policy)| policy).unwrap_or_default();
            if policy.require_approval && !Self::owns(&a.actor, slug) && found.status.as_deref() != Some("revoked") {
                sets.push(("status", TokenStatus::Pending.as_str().into()));
                ask = true;
            }
        }
        let mut statements = Vec::new();
        if !sets.is_empty() {
            let assignments: Vec<String> = sets.iter().map(|(column, _)| format!("{column} = ?")).collect();
            let mut binds: Vec<JsValue> = sets.into_iter().map(|(_, value)| value).collect();
            binds.push(a.id.as_str().into());
            statements.push(self.db.prepare(format!("UPDATE access_tokens SET {} WHERE id = ?", assignments.join(", "))).bind(&binds)?);
        }
        if let Some(ids) = &repo_ids {
            statements.push(self.db.prepare("DELETE FROM token_repositories WHERE token_id = ?").bind(&[a.id.as_str().into()])?);
            statements.extend(self.repository_rows(&a.id, ids)?);
        }
        if !statements.is_empty() {
            self.db.batch(statements).await?;
        }
        let Some(mut info) = self.token_info(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such token."));
        };
        self.name_repositories(std::slice::from_mut(&mut info), &Some(a.actor.clone())).await?;
        if widened {
            if personal {
                self.log_security(&a.actor.id, "token_rescoped", Some(&info.name), None).await;
                self.audit_account(&a.actor, "token.rescoped", &format!("Changed the permissions of access token {}", info.name)).await;
            } else if let Some(slug) = &owner_slug {
                self.audit_workspace(
                    &a.actor,
                    "workspace_token.changed",
                    slug,
                    Surface::Web,
                    format!("Changed the permissions of workspace access token {}", info.name),
                )
                .await;
            }
        }
        if ask && let Some(slug) = &made_for {
            self.ask_owners(&a.actor, slug, &info).await?;
        }
        Ok(Outcome::Ok(info))
    }

    /// A token a person or workspace made on purpose, by id: never an
    /// agent's or a workflow job's.
    async fn owned_token(&self, id: &str) -> Result<Option<Owned>> {
        self.db
            .prepare(
                "SELECT id, user_id, workspace_id, name, owner_workspace_id, status FROM access_tokens
                 WHERE id = ? AND agent_scope IS NULL AND job_id IS NULL",
            )
            .bind(&[id.into()])?
            .first::<Owned>(None)
            .await
    }

    async fn slug_of(&self, workspace_id: &str) -> Result<Option<String>> {
        self.db
            .prepare("SELECT slug FROM workspaces WHERE id = ? AND deleted_at IS NULL")
            .bind(&[workspace_id.into()])?
            .first::<String>(Some("slug"))
            .await
    }

    /// One token's details, as listings show them.
    async fn token_info(&self, id: &str) -> Result<Option<AccessToken>> {
        let row = self
            .db
            .prepare(format!(
                "SELECT {} FROM access_tokens LEFT JOIN users ON users.id = access_tokens.created_by WHERE access_tokens.id = ?",
                crate::tokens::TOKEN_COLUMNS
            ))
            .bind(&[id.into()])?
            .first::<crate::tokens::TokenRow>(None)
            .await?;
        Ok(row.map(Identity::info))
    }

    /// Names the selected repositories of tokens, as `viewer` can see them.
    pub(crate) async fn name_repositories(&self, tokens: &mut [AccessToken], viewer: &Viewer) -> Result<()> {
        let selected: Vec<String> = tokens
            .iter()
            .filter(|token| token.repository_selection == RepositorySelection::Selected)
            .map(|token| token.id.clone())
            .collect();
        if selected.is_empty() {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct Row {
            token_id: String,
            repo_id: String,
        }
        let marks = vec!["?"; selected.len()].join(", ");
        let binds: Vec<JsValue> = selected.iter().map(|id| JsValue::from(id.as_str())).collect();
        let rows = self
            .db
            .prepare(format!("SELECT token_id, repo_id FROM token_repositories WHERE token_id IN ({marks})"))
            .bind(&binds)?
            .all()
            .await?
            .results::<Row>()?;
        let ids: Vec<String> = rows.iter().map(|row| row.repo_id.clone()).collect::<HashSet<_>>().into_iter().collect();
        let readable: Vec<g1t_contracts::repos::Repo> = if ids.is_empty() {
            Vec::new()
        } else {
            g1t_kit::call(&self.env.service("REPOS")?, "readable", &g1t_contracts::repos::ReadableArgs { ids, viewer: viewer.clone() }).await?
        };
        let names: HashMap<&str, String> = readable.iter().map(|repo| (repo.id.as_str(), format!("{}/{}", repo.namespace, repo.name))).collect();
        for token in tokens.iter_mut().filter(|token| token.repository_selection == RepositorySelection::Selected) {
            token.repositories = rows
                .iter()
                .filter(|row| row.token_id == token.id)
                .filter_map(|row| names.get(row.repo_id.as_str()).cloned())
                .collect();
            token.repositories.sort();
        }
        Ok(())
    }

    // --- A workspace's rules ----------------------------------------------------

    pub async fn get_token_policy(&self, a: GetTokenPolicyArgs) -> Result<Outcome<TokenPolicy>> {
        let slug = a.slug.to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&slug)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can see a workspace's rules for tokens."));
        }
        Ok(match self.policy_of(&slug).await? {
            Some((_, policy)) => Outcome::Ok(policy),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    /// The workspace's id, if `actor` is a person who owns it.
    async fn owner_of(&self, actor: &User, slug: &str) -> Result<Outcome<String>> {
        let slug = slug.to_lowercase();
        if !is_person(actor) || !Self::owns(actor, &slug) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner of the workspace can manage its personal access tokens."));
        }
        Ok(match self.policy_of(&slug).await? {
            Some((id, _)) => Outcome::Ok(id),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    pub async fn set_token_policy(&self, a: SetTokenPolicyArgs) -> Result<Outcome<TokenPolicy>> {
        let slug = a.slug.to_lowercase();
        let workspace_id = match self.owner_of(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let current = self.policy_of(&slug).await?.map(|(_, policy)| policy).unwrap_or_default();
        if a.max_lifetime_days.is_some_and(|days| days > 3650) {
            return Ok(Outcome::fail(FailureCode::Invalid, "The longest lifetime a workspace can set is 3650 days; leave it empty for no limit."));
        }
        let policy = TokenPolicy {
            allow_tokens_for_all_workspaces: a.allow_tokens_for_all_workspaces.unwrap_or(current.allow_tokens_for_all_workspaces),
            allow_tokens_for_this_workspace: a.allow_tokens_for_this_workspace.unwrap_or(current.allow_tokens_for_this_workspace),
            require_approval: a.require_approval.unwrap_or(current.require_approval),
            max_lifetime_days: match a.max_lifetime_days {
                Some(0) => None,
                Some(days) => Some(days),
                None => current.max_lifetime_days,
            },
            forbid_no_expiry: a.forbid_no_expiry.unwrap_or(current.forbid_no_expiry),
            updated_by: Some(a.actor.username.clone()),
            updated_at: Some(rfc3339(now_ms())),
        };
        self.db
            .prepare(
                "INSERT INTO token_policies (workspace_id, allow_classic, allow_fine_grained, require_approval, max_lifetime_days,
                   forbid_no_expiry, updated_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT (workspace_id) DO UPDATE SET allow_classic = ?2, allow_fine_grained = ?3, require_approval = ?4,
                   max_lifetime_days = ?5, forbid_no_expiry = ?6, updated_by = ?7, updated_at = ?8",
            )
            .bind(&[
                workspace_id.as_str().into(),
                JsValue::from(u8::from(policy.allow_tokens_for_all_workspaces)),
                JsValue::from(u8::from(policy.allow_tokens_for_this_workspace)),
                JsValue::from(u8::from(policy.require_approval)),
                policy.max_lifetime_days.map_or(JsValue::NULL, JsValue::from),
                JsValue::from(u8::from(policy.forbid_no_expiry)),
                a.actor.username.as_str().into(),
                text(policy.updated_at.as_deref()),
            ])?
            .run()
            .await?;
        self.audit_workspace(&a.actor, "token.policy_changed", &slug, a.surface.unwrap_or(Surface::Web), describe_policy(&policy)).await;
        Ok(Outcome::Ok(policy))
    }

    // --- Members' tokens ------------------------------------------------------

    pub async fn list_member_tokens(&self, a: ListMemberTokensArgs) -> Result<Outcome<Vec<MemberToken>>> {
        let slug = a.slug.to_lowercase();
        let workspace_id = match self.owner_of(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let policy = self.policy_of(&slug).await?.map(|(_, policy)| policy).unwrap_or_default();
        #[derive(Deserialize)]
        struct Row {
            owner: String,
            #[serde(default)]
            revoked: Option<f64>,
            #[serde(flatten)]
            token: crate::tokens::TokenRow,
        }
        // Tokens made for the workspace, and the tokens for every workspace
        // of its members and outside collaborators, that have not expired.
        let rows = self
            .db
            .prepare(format!(
                "SELECT owners.username AS owner,
                   (SELECT 1 FROM token_workspace_revocations r WHERE r.token_id = access_tokens.id AND r.workspace_id = ?1) AS revoked,
                   {}
                 FROM access_tokens
                 JOIN users owners ON owners.id = access_tokens.user_id
                 LEFT JOIN users ON users.id = access_tokens.created_by
                 WHERE access_tokens.agent_scope IS NULL AND access_tokens.workspace_id IS NULL
                   AND (access_tokens.expires_at IS NULL OR access_tokens.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                   AND (
                     access_tokens.owner_workspace_id = ?1
                     OR (access_tokens.owner_workspace_id IS NULL AND COALESCE(access_tokens.repository_selection, 'all') <> 'public'
                       AND (access_tokens.expires_at IS NULL OR access_tokens.listed = 1)
                       AND (access_tokens.user_id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?1)
                         OR access_tokens.user_id IN (SELECT principal_id FROM repo_grants WHERE workspace_id = ?1 AND principal_kind = 'user')))
                   )
                 ORDER BY access_tokens.id DESC
                 LIMIT 500",
                crate::tokens::TOKEN_COLUMNS
            ))
            .bind(&[workspace_id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut listed: Vec<MemberToken> = Vec::new();
        let mut infos: Vec<AccessToken> = Vec::new();
        let mut owners: Vec<(String, bool)> = Vec::new();
        for row in rows {
            owners.push((row.owner, row.revoked.is_some_and(|revoked| revoked >= 1.0)));
            infos.push(Identity::info(row.token));
        }
        self.name_repositories(&mut infos, &Some(a.actor.clone())).await?;
        for ((owner, revoked), token) in owners.into_iter().zip(infos) {
            if a.status.is_some_and(|wanted| wanted != token.status) {
                continue;
            }
            let created = parse_rfc3339(&token.created_at).unwrap_or(0);
            let expires = token.expires_at.as_deref().and_then(parse_rfc3339);
            let blocked = blocked_by(&policy, token.workspace.is_some(), token.status, revoked, created, expires);
            listed.push(MemberToken { owner, token, reaches: blocked.is_none(), blocked_by: blocked.map(str::to_owned) });
        }
        Ok(Outcome::Ok(listed))
    }

    /// One member token, as `list_member_tokens` shows it.
    async fn member_token(&self, actor: &User, slug: &str, id: &str) -> Result<Option<MemberToken>> {
        let listed = self.list_member_tokens(ListMemberTokensArgs { actor: actor.clone(), slug: slug.to_owned(), status: None }).await?;
        Ok(match listed {
            Outcome::Ok(tokens) => tokens.into_iter().find(|member| member.token.id == id),
            Outcome::Fail(_) => None,
        })
    }

    pub async fn review_token_request(&self, a: ReviewTokenRequestArgs) -> Result<Outcome<MemberToken>> {
        let slug = a.slug.to_lowercase();
        let workspace_id = match self.owner_of(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(found) = self.owned_token(&a.id).await?.filter(|token| token.owner_workspace_id.as_deref() == Some(workspace_id.as_str())) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no such token request in this workspace."));
        };
        if found.status.as_deref() != Some("pending") {
            return Ok(Outcome::fail(FailureCode::Conflict, "This token is not waiting for approval."));
        }
        let status = if a.approve { TokenStatus::Active } else { TokenStatus::Denied };
        let reason = tidy(a.reason.as_deref());
        self.db
            .prepare("UPDATE access_tokens SET status = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ? WHERE id = ? AND status = 'pending'")
            .bind(&[
                status.as_str().into(),
                a.actor.id.as_str().into(),
                rfc3339(now_ms()).into(),
                text(reason.as_deref()),
                a.id.as_str().into(),
            ])?
            .run()
            .await?;
        let owner = match &found.user_id {
            Some(id) => self.usernames_of(std::slice::from_ref(id)).await?.into_iter().next(),
            None => None,
        };
        let verdict = if a.approve { "approved" } else { "denied" };
        self.audit_workspace(
            &a.actor,
            if a.approve { "token.approved" } else { "token.denied" },
            &slug,
            a.surface.unwrap_or(Surface::Web),
            format!(
                "{} the access token {} of {}{}",
                if a.approve { "Approved" } else { "Denied" },
                found.name,
                owner.as_deref().unwrap_or("a former member"),
                reason.as_deref().map(|reason| format!(": {reason}")).unwrap_or_default()
            ),
        )
        .await;
        if let Some(owner) = &owner {
            self.notify(
                "token.approval_reviewed",
                &a.actor,
                TokenNotice {
                    workspace: &slug,
                    token_id: &found.id,
                    token_name: &found.name,
                    notify: vec![owner.clone()],
                    title: format!("Your token {} was {verdict} for {slug}", found.name),
                    body: reason.clone().unwrap_or_else(|| {
                        if a.approve { "It now reaches the workspace.".to_owned() } else { "It reaches public repositories only.".to_owned() }
                    }),
                    link: format!("/settings/tokens/{}", found.id),
                },
            )
            .await;
        }
        Ok(match self.member_token(&a.actor, &slug, &a.id).await? {
            Some(member) => Outcome::Ok(member),
            None => Outcome::fail(FailureCode::NotFound, "There is no such token request in this workspace."),
        })
    }

    pub async fn revoke_member_token(&self, a: RevokeMemberTokenArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.to_lowercase();
        let workspace_id = match self.owner_of(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(member) = self.member_token(&a.actor, &slug, &a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No token of a member reaches this workspace with that id."));
        };
        let reason = tidy(a.reason.as_deref());
        let now = rfc3339(now_ms());
        let made_for_it = member.token.workspace.is_some();
        if made_for_it {
            self.db
                .prepare("UPDATE access_tokens SET status = 'revoked', reviewed_by = ?, reviewed_at = ?, review_reason = ? WHERE id = ? AND owner_workspace_id = ?")
                .bind(&[a.actor.id.as_str().into(), now.as_str().into(), text(reason.as_deref()), a.id.as_str().into(), workspace_id.as_str().into()])?
                .run()
                .await?;
        } else {
            self.db
                .prepare(
                    "INSERT INTO token_workspace_revocations (token_id, workspace_id, revoked_by, revoked_at, reason) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (token_id, workspace_id) DO NOTHING",
                )
                .bind(&[a.id.as_str().into(), workspace_id.as_str().into(), a.actor.id.as_str().into(), now.as_str().into(), text(reason.as_deref())])?
                .run()
                .await?;
        }
        self.audit_workspace(
            &a.actor,
            "token.revoked",
            &slug,
            a.surface.unwrap_or(Surface::Web),
            format!(
                "Revoked {}'s access token {} in {slug}{}",
                member.owner,
                member.token.name,
                reason.as_deref().map(|reason| format!(": {reason}")).unwrap_or_default()
            ),
        )
        .await;
        self.notify(
            "token.approval_reviewed",
            &a.actor,
            TokenNotice {
                workspace: &slug,
                token_id: &a.id,
                token_name: &member.token.name,
                notify: vec![member.owner.clone()],
                title: format!("Your token {} was revoked for {slug}", member.token.name),
                body: reason.unwrap_or_else(|| "An owner of the workspace revoked it there.".to_owned()),
                link: format!("/settings/tokens/{}", a.id),
            },
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    // --- Telling people -------------------------------------------------------

    /// Tells the workspace's owners that `requester`'s token waits for them.
    async fn ask_owners(&self, requester: &User, slug: &str, token: &AccessToken) -> Result<()> {
        #[derive(Deserialize)]
        struct Row {
            username: String,
        }
        let owners: Vec<String> = self
            .db
            .prepare(
                "SELECT users.username FROM workspace_members
                 JOIN workspaces ON workspaces.id = workspace_members.workspace_id
                 JOIN users ON users.id = workspace_members.user_id
                 WHERE workspaces.slug = ? AND workspace_members.role = 'owner'",
            )
            .bind(&[slug.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.username)
            .collect();
        self.audit_workspace(requester, "token.approval_requested", slug, Surface::Web, format!("Asked for approval of the access token {}", token.name)).await;
        if owners.is_empty() {
            return Ok(());
        }
        let permissions = token.permissions.iter().map(|(name, level)| format!("{name}: {level}")).collect::<Vec<_>>().join(", ");
        self.notify(
            "token.approval_requested",
            requester,
            TokenNotice {
                workspace: slug,
                token_id: &token.id,
                token_name: &token.name,
                notify: owners,
                title: format!("{} asks to use an access token in {slug}", requester.username),
                body: format!("{}: {permissions}", token.name),
                link: format!("/{slug}/-/personal-access-tokens"),
            },
        )
        .await;
        Ok(())
    }

    async fn notify(&self, kind: &'static str, actor: &User, notice: TokenNotice<'_>) {
        let Ok(events) = self.env.service("EVENTS") else {
            return;
        };
        let publish = Publish {
            events: vec![NewEvent { kind, source: "identity", repo_id: None, actor: Some(actor.id.clone()), data: notice }],
        };
        if let Err(error) = g1t_kit::call::<_, serde_json::Value>(&events, "publish", &publish).await {
            worker::console_error!("{kind} not published: {error}");
        }
    }

    async fn usernames_of(&self, ids: &[String]) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            username: String,
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let binds: Vec<JsValue> = ids.iter().map(|id| JsValue::from(id.as_str())).collect();
        Ok(self
            .db
            .prepare(format!("SELECT username FROM users WHERE id IN ({marks})"))
            .bind(&binds)?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.username)
            .collect())
    }
}

/// `owner/name` for a repository asked for by name in `slug`.
fn qualified(slug: Option<&str>, name: &str) -> String {
    let name = name.trim().trim_start_matches('/');
    match (name.contains('/'), slug) {
        (false, Some(slug)) => format!("{slug}/{name}"),
        _ => name.to_lowercase(),
    }
}

/// The repositories a new token selected, by name, when it selected any.
fn qualified_all(slug: Option<&str>, repo_ids: &[String], names: &[String]) -> Vec<String> {
    if repo_ids.is_empty() {
        return Vec::new();
    }
    let mut names: Vec<String> = names.iter().map(|name| qualified(slug, name)).collect();
    names.sort();
    names.dedup();
    names
}

/// The policy in a sentence, for the audit log.
fn describe_policy(policy: &TokenPolicy) -> String {
    let yes = |on: bool| if on { "allowed" } else { "not allowed" };
    format!(
        "Tokens for all of a member's workspaces {}; tokens made for this workspace {}{}; lifetime {}{}",
        yes(policy.allow_tokens_for_all_workspaces),
        yes(policy.allow_tokens_for_this_workspace),
        if policy.require_approval { ", with approval" } else { ", without approval" },
        policy.max_lifetime_days.map_or_else(|| "unlimited".to_owned(), |days| format!("at most {days} days")),
        if policy.forbid_no_expiry { "; tokens must expire" } else { "" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const DAY: u64 = 86_400_000;

    #[test]
    fn tokens_for_every_workspace_follow_the_workspace_rules() {
        let open = TokenPolicy::default();
        assert_eq!(blocked_by(&open, false, TokenStatus::Active, false, 0, None), None);
        let closed = TokenPolicy { allow_tokens_for_all_workspaces: false, ..TokenPolicy::default() };
        assert_eq!(blocked_by(&closed, false, TokenStatus::Active, false, 0, Some(DAY)), Some("tokens for all workspaces not allowed"));
        let capped = TokenPolicy { max_lifetime_days: Some(30), ..TokenPolicy::default() };
        assert_eq!(blocked_by(&capped, false, TokenStatus::Active, false, 0, Some(90 * DAY)), Some("lasts too long"));
        assert_eq!(blocked_by(&capped, false, TokenStatus::Active, false, 0, None), Some("never expires"));
        assert_eq!(blocked_by(&capped, false, TokenStatus::Active, false, 0, Some(7 * DAY)), None);
        assert_eq!(blocked_by(&open, false, TokenStatus::Active, true, 0, None), Some("revoked"));
    }

    #[test]
    fn tokens_made_for_a_workspace_reach_it_once_active_and_allowed() {
        let open = TokenPolicy::default();
        assert_eq!(blocked_by(&open, true, TokenStatus::Pending, false, 0, Some(DAY)), Some("pending approval"));
        assert_eq!(blocked_by(&open, true, TokenStatus::Denied, false, 0, Some(DAY)), Some("denied"));
        assert_eq!(blocked_by(&open, true, TokenStatus::Revoked, false, 0, Some(DAY)), Some("revoked"));
        assert_eq!(blocked_by(&open, true, TokenStatus::Active, false, 0, Some(DAY)), None);
        let closed = TokenPolicy { allow_tokens_for_this_workspace: false, ..TokenPolicy::default() };
        assert_eq!(blocked_by(&closed, true, TokenStatus::Active, false, 0, Some(DAY)), Some("tokens made for this workspace not allowed"));
        // Keeping out tokens for every workspace does not touch these.
        let no_broad = TokenPolicy { allow_tokens_for_all_workspaces: false, ..TokenPolicy::default() };
        assert_eq!(blocked_by(&no_broad, true, TokenStatus::Active, false, 0, Some(DAY)), None);
    }

    #[test]
    fn rules_rows_read_with_defaults() {
        let row = RuleRow { id: "wsp_1".into(), slug: "acme".into(), ..RuleRow::default() };
        assert_eq!(row.policy(), TokenPolicy::default());
        let set = RuleRow { allow_classic: Some(0.0), require_approval: Some(0.0), max_lifetime_days: Some(90.0), forbid_no_expiry: Some(1.0), ..row };
        let policy = set.policy();
        assert!(!policy.allow_tokens_for_all_workspaces && policy.allow_tokens_for_this_workspace && !policy.require_approval && policy.forbid_no_expiry);
        assert_eq!(policy.max_lifetime_days, Some(90));
    }

    #[test]
    fn a_listed_row_describes_its_reach() {
        let more = TokenRowMore {
            repository_selection: Some("selected".into()),
            status: Some("pending".into()),
            owner_workspace: Some("acme".into()),
            ..TokenRowMore::default()
        };
        let mut info = AccessToken::default();
        more.describe(&mut info);
        assert_eq!(info.workspace.as_deref(), Some("acme"));
        assert_eq!(info.repository_selection, RepositorySelection::Selected);
        assert_eq!(info.status, TokenStatus::Pending);
        assert!(!info.workspace_owned);
        // A row from before reaches (null) reads as every workspace, active.
        let mut classic = AccessToken::default();
        TokenRowMore::default().describe(&mut classic);
        assert_eq!((classic.workspace.as_deref(), classic.repository_selection, classic.status), (None, RepositorySelection::All, TokenStatus::Active));
        let mut workspace = AccessToken::default();
        TokenRowMore { workspace_id: Some("wsp_1".into()), admin: Some(1.0), ..TokenRowMore::default() }.describe(&mut workspace);
        assert!(workspace.workspace_owned && workspace.admin);
    }

    #[test]
    fn a_rows_reach_is_read_from_its_columns() {
        let broad = Facts::default();
        assert!(!broad.made_for_one() && !broad.account_only());
        let account = Facts { repository_selection: Some("public".into()), ..Facts::default() };
        assert!(account.account_only());
        let one = Facts { owner_workspace_id: Some("wsp_1".into()), repository_selection: Some("public".into()), ..Facts::default() };
        assert!(one.made_for_one() && !one.account_only(), "public in a workspace is that workspace's settings, no private repositories");
    }

    #[test]
    fn repositories_are_named_in_the_workspace() {
        assert_eq!(qualified(Some("acme"), "web"), "acme/web");
        assert_eq!(qualified(Some("acme"), "Acme/Web"), "acme/web");
        assert_eq!(qualified_all(Some("acme"), &["rep_1".into()], &["web".into(), "acme/web".into()]), vec!["acme/web".to_owned()]);
        assert!(qualified_all(Some("acme"), &[], &["web".into()]).is_empty());
        assert!(describe_policy(&TokenPolicy::default()).contains("with approval"));
    }

    /// Migration 0041 writes full access out as every permission: the
    /// same lists the code makes.
    #[test]
    fn the_migration_sets_full_access_out_as_every_permission() {
        use g1t_contracts::scopes::{ResourceGroup, everything};
        let sql = include_str!("../migrations/0041_one_kind_of_token.sql");
        assert!(sql.contains(&format!("SET scopes = '{}'", scopes_text(&everything()))));
        let workspace: Vec<Scope> = everything().into_iter().filter(|scope| scope.resource().group() != ResourceGroup::Account).collect();
        assert!(sql.contains(&format!("SET scopes = '{}'", scopes_text(&workspace))));
        let write: Vec<Scope> = workspace
            .iter()
            .map(|scope| match scope {
                Scope::RepoAdmin => Scope::RepoWrite,
                Scope::AccessAdmin => Scope::AccessRead,
                other => *other,
            })
            .collect();
        assert!(sql.contains(&format!("SET scopes = '{}'", scopes_text(&write))));
    }

    #[test]
    fn permissions_are_stored_as_the_scopes_every_check_reads() {
        let asked: BTreeMap<String, String> = [("code".to_owned(), "read".to_owned()), ("repo".to_owned(), "read".to_owned())].into();
        let scopes = resolve_permissions(&asked, true).unwrap();
        assert_eq!(scopes_text(&scopes), "repo:read code:read");
        assert_eq!(permissions_of(&scopes), asked);
    }
}
