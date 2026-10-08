//! What a personal access token reaches, and the rules a workspace sets for
//! the tokens that reach it. See `g1t_contracts::tokens`.
//!
//! **Classic tokens** reach whatever their owner can, narrowed by their
//! scopes. **Fine-grained tokens** (migration 0034) name one resource owner
//! (their owner's own account, or one workspace), all, selected or only
//! public repositories of it, and a level for each permission, stored as
//! the scopes those give. Migration 0023 had retired a token's reach in
//! favour of classic tokens only; the owner chose GitHub's model instead,
//! with both kinds side by side.
//!
//! Each time a token is used, [`Identity::apply_reach`] cuts the person it
//! resolves to down to what it reaches: a fine-grained token keeps only its
//! resource owner's membership and grants (none while it waits for
//! approval), and any personal token loses the workspaces whose rules keep
//! it out (a kind they do not allow, a lifetime past their limit, or an
//! owner revoking it there). Services then decide as for anyone, and
//! `access::granted` holds a fine-grained token to its repositories.
//!
//! **Approval.** A fine-grained token naming a workspace that asks for
//! approval starts pending, unless its owner is an owner there. The
//! workspace's owners hear of it in their inbox (`token.approval_requested`)
//! and approve or deny it; its owner hears back
//! (`token.approval_reviewed`). Changing a token's repositories or
//! permissions asks again.

use std::collections::{BTreeMap, HashMap, HashSet};

use g1t_contracts::audit::Surface;
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::fine_grained::{self, Access, MAX_LIFETIME_DAYS};
use g1t_contracts::identity::{AccessToken, CreatedAccessToken};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::scopes::{FineGrainedReach, RepositorySelection, scopes_text};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::tokens::*;
use g1t_contracts::{FailureCode, Outcome, Role, User, Viewer};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::security::is_person;
use crate::tokens::{Grant, Owner};

const FINE_GRAINED: &str = "fine_grained";
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
    kind: Option<String>,
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
    fn fine_grained(&self) -> bool {
        self.kind.as_deref() == Some(FINE_GRAINED)
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
    kind: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    admin: Option<f64>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    repository_selection: Option<String>,
    #[serde(default)]
    permissions: Option<String>,
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
        info.kind = if self.kind.as_deref() == Some(FINE_GRAINED) {
            TokenKind::FineGrained
        } else if self.workspace_id.is_some() {
            TokenKind::Workspace
        } else {
            TokenKind::Classic
        };
        if info.kind == TokenKind::FineGrained {
            info.fine_grained = Some(FineGrainedDetails {
                workspace: self.owner_workspace.clone(),
                repository_selection: self.repository_selection.as_deref().and_then(RepositorySelection::parse).unwrap_or_default(),
                repositories: Vec::new(),
                permissions: stored_permissions(self.permissions.as_deref()),
                status: TokenStatus::parse(self.status.as_deref().unwrap_or("active")),
                review_reason: self.review_reason.clone(),
            });
        }
    }
}

/// A `permissions` column read back.
fn stored_permissions(text: Option<&str>) -> BTreeMap<String, Access> {
    text.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
}

/// A workspace whose rules apply to a token, as read for it.
#[derive(Clone, Debug, Default, Deserialize)]
struct RuleRow {
    id: String,
    slug: String,
    #[serde(default)]
    allow_classic: Option<f64>,
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
            allow_classic: flag(self.allow_classic, true),
            allow_fine_grained: flag(self.allow_fine_grained, true),
            require_approval: flag(self.require_approval, true),
            max_lifetime_days: self.max_lifetime_days.filter(|days| *days >= 1.0).map(|days| days as u32),
            forbid_no_expiry: flag(self.forbid_no_expiry, false),
            updated_by: self.updated_by.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// Why a token does not reach a workspace, as its owners are told; `None`
/// when it does. `fine_grained` is whether the token is one aimed at this
/// workspace, with `status`.
pub(crate) fn blocked_by(
    policy: &TokenPolicy,
    fine_grained: bool,
    status: TokenStatus,
    revoked: bool,
    created_ms: u64,
    expires_ms: Option<u64>,
) -> Option<&'static str> {
    if revoked || status == TokenStatus::Revoked {
        return Some("revoked");
    }
    if fine_grained {
        match status {
            TokenStatus::Pending => return Some("pending approval"),
            TokenStatus::Denied => return Some("denied"),
            _ => {}
        }
        if !policy.allow_fine_grained {
            return Some("fine-grained tokens not allowed");
        }
    } else if !policy.allow_classic {
        return Some("classic tokens not allowed");
    }
    if !policy.lifetime_allowed(created_ms, expires_ms) {
        return Some(if expires_ms.is_none() { "never expires" } else { "lasts too long" });
    }
    None
}

/// `{"contents": "write"}`, as stored.
fn permissions_column(permissions: &fine_grained::Permissions) -> String {
    serde_json::to_string(permissions).unwrap_or_else(|_| "{}".to_owned())
}

fn text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
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
    name: String,
    kind: Option<String>,
    owner_workspace_id: Option<String>,
    status: Option<String>,
}

impl Identity {
    /// Cuts `user`, resolved from the token `token_id`, down to what the
    /// token reaches. `personal` is whether it is a person's token (not a
    /// workspace's or a job's). See the module docs.
    pub(crate) async fn apply_reach(&self, user: &mut User, token_id: &str, personal: bool, facts: &Facts) -> Result<()> {
        let Some(access) = user.token.as_deref_mut() else {
            return Ok(());
        };
        if !personal {
            // A workspace's own token: Write on its repositories, or Admin
            // when an owner gave it that.
            access.admin = facts.admin.is_some_and(|admin| admin >= 1.0);
            return Ok(());
        }
        let fine = facts.fine_grained();
        // The workspaces it could reach, with their rules for it.
        let mut slugs: Vec<String> = user.workspaces.iter().map(|membership| membership.slug.clone()).collect();
        slugs.extend(user.grants.iter().map(|grant| grant.workspace.to_lowercase()));
        slugs.sort();
        slugs.dedup();
        if slugs.is_empty() && !fine {
            return Ok(());
        }
        let rules = self.rules_for(&slugs, token_id).await?;
        let (created, expires) = facts.lifetime();
        let status = TokenStatus::parse(facts.status.as_deref().unwrap_or("active"));
        let mut keep: HashSet<String> = HashSet::new();
        let mut owner_slug: Option<String> = None;
        for rule in &rules {
            if fine && facts.owner_workspace_id.as_deref() != Some(rule.id.as_str()) {
                continue;
            }
            if fine {
                owner_slug = Some(rule.slug.clone());
            }
            let revoked = rule.revoked.is_some_and(|revoked| revoked >= 1.0);
            if blocked_by(&rule.policy(), fine, status, revoked, created, expires).is_none() {
                keep.insert(rule.slug.clone());
            }
        }
        // Workspaces without a rules row: the defaults, which let a classic
        // token in, and a fine-grained one once it is active.
        for slug in &slugs {
            if rules.iter().any(|rule| &rule.slug == slug) {
                continue;
            }
            if !fine && blocked_by(&TokenPolicy::default(), false, status, false, created, expires).is_none() {
                keep.insert(slug.clone());
            }
        }
        user.workspaces.retain(|membership| keep.contains(&membership.slug));
        user.grants.retain(|grant| keep.contains(&grant.workspace.to_lowercase()));
        if fine {
            let selection = facts.repository_selection.as_deref().and_then(RepositorySelection::parse).unwrap_or_default();
            let reaches = owner_slug.as_ref().is_some_and(|slug| keep.contains(slug));
            let repo_ids = if reaches && selection == RepositorySelection::Selected { self.token_repo_ids(token_id).await? } else { Vec::new() };
            if let Some(access) = user.token.as_deref_mut() {
                access.fine_grained = Some(FineGrainedReach {
                    workspace: owner_slug,
                    // Until it reaches its workspace, public repositories only.
                    repositories: if reaches { selection } else { RepositorySelection::Public },
                    repo_ids,
                });
            }
        }
        Ok(())
    }

    /// The workspaces named by `slugs` that have rules, or that `token_id`
    /// was revoked in, with both. For a fine-grained token, its resource
    /// owner too, whatever its rules.
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

    // --- Fine-grained tokens --------------------------------------------------

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
                return Ok(Err(format!("{name} is not a repository of {slug}, the token's resource owner.")));
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

    pub async fn create_fine_grained_token(&self, a: CreateFineGrainedTokenArgs) -> Result<Outcome<CreatedAccessToken>> {
        if !is_person(&a.user) || a.user.token.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person, signed in on g1t.sh, can make a personal access token."));
        }
        if !a.user.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address before making a token."));
        }
        if a.name.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the token after what will use it."));
        }
        if a.ttl_seconds < DAY_SECONDS || a.ttl_seconds > u64::from(MAX_LIFETIME_DAYS) * DAY_SECONDS {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A fine-grained token lasts between 1 and {MAX_LIFETIME_DAYS} days."),
            ));
        }
        let slug = a.workspace.as_deref().map(|slug| slug.trim().to_lowercase()).filter(|slug| !slug.is_empty());
        let (permissions, scopes) = match fine_grained::resolve(&a.permissions, slug.is_some()) {
            Ok(resolved) => resolved,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        if permissions.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give the token at least one permission."));
        }
        let mut status = TokenStatus::Active;
        let mut workspace_id = None;
        let mut repo_ids = Vec::new();
        let selection = if slug.is_some() { a.repository_selection } else { RepositorySelection::Public };
        if let Some(slug) = &slug {
            if !a.user.is_member(slug) {
                return Ok(Outcome::fail(FailureCode::Forbidden, format!("You can only aim a token at a workspace you belong to, and {slug} is not one.")));
            }
            let Some((id, policy)) = self.policy_of(slug).await? else {
                return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
            };
            if let Some(refusal) = policy.refusal(slug, TokenKind::FineGrained, Some(a.ttl_seconds)) {
                return Ok(Outcome::fail(FailureCode::Forbidden, refusal));
            }
            if policy.require_approval && !Self::owns(&a.user, slug) {
                status = TokenStatus::Pending;
            }
            if selection == RepositorySelection::Selected {
                repo_ids = match self.chosen_repositories(&a.user, slug, &a.repositories).await? {
                    Ok(ids) => ids,
                    Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
                };
            }
            workspace_id = Some(id);
        }
        let grant = Grant { scopes: Some(scopes.clone()) };
        let mut created = self.mint(Owner::User(&a.user.id), &a.name, Some(a.ttl_seconds), &grant, true).await?;
        let description = a.description.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(|text| text.chars().take(500).collect::<String>());
        let mut statements = vec![self
            .db
            .prepare(
                "UPDATE access_tokens SET kind = ?, owner_workspace_id = ?, repository_selection = ?, permissions = ?,
                   description = ?, status = ?
                 WHERE id = ?",
            )
            .bind(&[
                FINE_GRAINED.into(),
                text(workspace_id.as_deref()),
                selection.as_str().into(),
                permissions_column(&permissions).into(),
                text(description.as_deref()),
                status.as_str().into(),
                created.info.id.as_str().into(),
            ])?];
        for repo_id in &repo_ids {
            statements.push(
                self.db
                    .prepare("INSERT OR IGNORE INTO token_repositories (token_id, repo_id) VALUES (?, ?)")
                    .bind(&[created.info.id.as_str().into(), repo_id.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
        created.info.kind = TokenKind::FineGrained;
        created.info.description = description;
        created.info.fine_grained = Some(FineGrainedDetails {
            workspace: slug.clone(),
            repository_selection: selection,
            repositories: if repo_ids.is_empty() { Vec::new() } else { a.repositories.iter().map(|name| qualified(slug.as_deref(), name)).collect() },
            permissions,
            status,
            review_reason: None,
        });
        if let (Some(slug), TokenStatus::Pending) = (&slug, status) {
            self.ask_owners(&a.user, slug, &created.info).await?;
        }
        Ok(Outcome::Ok(created))
    }

    pub async fn update_fine_grained_token(&self, a: UpdateFineGrainedTokenArgs) -> Result<Outcome<AccessToken>> {
        if !is_person(&a.user) || a.user.token.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only you, signed in on g1t.sh, can change your tokens."));
        }
        let Some(found) = self.owned_token(&a.id).await?.filter(|token| token.user_id.as_deref() == Some(a.user.id.as_str()) && token.kind.as_deref() == Some(FINE_GRAINED)) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such token."));
        };
        let slug = match &found.owner_workspace_id {
            Some(id) => self.slug_of(id).await?,
            None => None,
        };
        let mut sets: Vec<(&str, JsValue)> = Vec::new();
        if let Some(name) = a.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            sets.push(("name", name.chars().take(100).collect::<String>().into()));
        }
        if let Some(description) = &a.description {
            let description = description.trim();
            sets.push(("description", if description.is_empty() { JsValue::NULL } else { description.chars().take(500).collect::<String>().into() }));
        }
        let mut widened = false;
        if let Some(asked) = &a.permissions {
            let (permissions, scopes) = match fine_grained::resolve(asked, found.owner_workspace_id.is_some()) {
                Ok(resolved) => resolved,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            if permissions.is_empty() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the token at least one permission."));
            }
            sets.push(("permissions", permissions_column(&permissions).into()));
            sets.push(("scopes", scopes_text(&scopes).into()));
            widened = true;
        }
        let mut repo_ids: Option<Vec<String>> = None;
        if let Some(slug) = &slug {
            let selection = a.repository_selection;
            if let Some(selection) = selection {
                sets.push(("repository_selection", selection.as_str().into()));
                widened = true;
            }
            let selected = selection.unwrap_or_default() == RepositorySelection::Selected || (selection.is_none() && a.repositories.is_some());
            if selected {
                let names = a.repositories.clone().unwrap_or_default();
                repo_ids = Some(match self.chosen_repositories(&a.user, slug, &names).await? {
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
        if widened && let Some(slug) = &slug {
            let policy = self.policy_of(slug).await?.map(|(_, policy)| policy).unwrap_or_default();
            if policy.require_approval && !Self::owns(&a.user, slug) && found.status.as_deref() != Some("revoked") {
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
            for repo_id in ids {
                statements.push(
                    self.db
                        .prepare("INSERT OR IGNORE INTO token_repositories (token_id, repo_id) VALUES (?, ?)")
                        .bind(&[a.id.as_str().into(), repo_id.as_str().into()])?,
                );
            }
        }
        if !statements.is_empty() {
            self.db.batch(statements).await?;
        }
        let Some(mut info) = self.token_info(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such token."));
        };
        self.name_repositories(std::slice::from_mut(&mut info), &Some(a.user.clone())).await?;
        if ask && let Some(slug) = &slug {
            self.ask_owners(&a.user, slug, &info).await?;
        }
        Ok(Outcome::Ok(info))
    }

    async fn owned_token(&self, id: &str) -> Result<Option<Owned>> {
        self.db
            .prepare("SELECT id, user_id, name, kind, owner_workspace_id, status FROM access_tokens WHERE id = ? AND agent_scope IS NULL")
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

    /// Names the selected repositories of fine-grained tokens, as `viewer`
    /// can see them.
    pub(crate) async fn name_repositories(&self, tokens: &mut [AccessToken], viewer: &Viewer) -> Result<()> {
        let selected: Vec<String> = tokens
            .iter()
            .filter(|token| token.fine_grained.as_ref().is_some_and(|details| details.repository_selection == RepositorySelection::Selected))
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
        for token in tokens.iter_mut() {
            if let Some(details) = token.fine_grained.as_mut() {
                details.repositories = rows
                    .iter()
                    .filter(|row| row.token_id == token.id)
                    .filter_map(|row| names.get(row.repo_id.as_str()).cloned())
                    .collect();
                details.repositories.sort();
            }
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
            allow_classic: a.allow_classic.unwrap_or(current.allow_classic),
            allow_fine_grained: a.allow_fine_grained.unwrap_or(current.allow_fine_grained),
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
                JsValue::from(u8::from(policy.allow_classic)),
                JsValue::from(u8::from(policy.allow_fine_grained)),
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
        // Fine-grained tokens naming the workspace, and the classic tokens of
        // its members and outside collaborators that have not expired.
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
                     (access_tokens.kind = 'fine_grained' AND access_tokens.owner_workspace_id = ?1)
                     OR (access_tokens.kind IS NULL AND (access_tokens.expires_at IS NULL OR access_tokens.listed = 1)
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
            let fine = token.kind == TokenKind::FineGrained;
            let status = token.fine_grained.as_ref().map_or(TokenStatus::Active, |details| details.status);
            if a.status.is_some_and(|wanted| wanted != status) || a.kind.is_some_and(|kind| kind != token.kind) {
                continue;
            }
            let created = parse_rfc3339(&token.created_at).unwrap_or(0);
            let expires = token.expires_at.as_deref().and_then(parse_rfc3339);
            let blocked = blocked_by(&policy, fine, status, revoked, created, expires);
            listed.push(MemberToken { owner, token, reaches: blocked.is_none(), blocked_by: blocked.map(str::to_owned) });
        }
        Ok(Outcome::Ok(listed))
    }

    /// One member token, as `list_member_tokens` shows it.
    async fn member_token(&self, actor: &User, slug: &str, id: &str) -> Result<Option<MemberToken>> {
        let listed = self
            .list_member_tokens(ListMemberTokensArgs { actor: actor.clone(), slug: slug.to_owned(), status: None, kind: None })
            .await?;
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
        let reason = a.reason.as_deref().map(str::trim).filter(|reason| !reason.is_empty()).map(|reason| reason.chars().take(500).collect::<String>());
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
                "{} the fine-grained token {} of {}{}",
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
                    link: "/settings/tokens".to_owned(),
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
        let reason = a.reason.as_deref().map(str::trim).filter(|reason| !reason.is_empty()).map(|reason| reason.chars().take(500).collect::<String>());
        let now = rfc3339(now_ms());
        if member.token.kind == TokenKind::FineGrained {
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
                "Revoked {} {} token {} in {slug}{}",
                member.owner,
                if member.token.kind == TokenKind::FineGrained { "fine-grained" } else { "classic" },
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
                link: "/settings/tokens".to_owned(),
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
        self.audit_workspace(
            requester,
            "token.approval_requested",
            slug,
            Surface::Web,
            format!("Asked for approval of the fine-grained token {}", token.name),
        )
        .await;
        if owners.is_empty() {
            return Ok(());
        }
        let permissions = token
            .fine_grained
            .as_ref()
            .map(|details| details.permissions.iter().map(|(name, access)| format!("{name}: {}", access.as_str())).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        self.notify(
            "token.approval_requested",
            requester,
            TokenNotice {
                workspace: slug,
                token_id: &token.id,
                token_name: &token.name,
                notify: owners,
                title: format!("{} asks to use a fine-grained token in {slug}", requester.username),
                body: format!("{}: {permissions}", token.name),
                link: format!("/{slug}/-/settings/tokens"),
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

/// The policy in a sentence, for the audit log.
fn describe_policy(policy: &TokenPolicy) -> String {
    let yes = |on: bool| if on { "allowed" } else { "not allowed" };
    format!(
        "Classic tokens {}; fine-grained tokens {}{}; lifetime {}{}",
        yes(policy.allow_classic),
        yes(policy.allow_fine_grained),
        if policy.require_approval { ", with approval" } else { ", without approval" },
        policy.max_lifetime_days.map_or_else(|| "unlimited".to_owned(), |days| format!("at most {days} days")),
        if policy.forbid_no_expiry { "; tokens must expire" } else { "" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::Scope;

    const DAY: u64 = 86_400_000;

    #[test]
    fn classic_tokens_follow_the_workspace_rules() {
        let open = TokenPolicy::default();
        assert_eq!(blocked_by(&open, false, TokenStatus::Active, false, 0, None), None);
        let closed = TokenPolicy { allow_classic: false, ..TokenPolicy::default() };
        assert_eq!(blocked_by(&closed, false, TokenStatus::Active, false, 0, Some(DAY)), Some("classic tokens not allowed"));
        let capped = TokenPolicy { max_lifetime_days: Some(30), ..TokenPolicy::default() };
        assert_eq!(blocked_by(&capped, false, TokenStatus::Active, false, 0, Some(90 * DAY)), Some("lasts too long"));
        assert_eq!(blocked_by(&capped, false, TokenStatus::Active, false, 0, None), Some("never expires"));
        assert_eq!(blocked_by(&capped, false, TokenStatus::Active, false, 0, Some(7 * DAY)), None);
        assert_eq!(blocked_by(&open, false, TokenStatus::Active, true, 0, None), Some("revoked"));
    }

    #[test]
    fn fine_grained_tokens_reach_once_active_and_allowed() {
        let open = TokenPolicy::default();
        assert_eq!(blocked_by(&open, true, TokenStatus::Pending, false, 0, Some(DAY)), Some("pending approval"));
        assert_eq!(blocked_by(&open, true, TokenStatus::Denied, false, 0, Some(DAY)), Some("denied"));
        assert_eq!(blocked_by(&open, true, TokenStatus::Revoked, false, 0, Some(DAY)), Some("revoked"));
        assert_eq!(blocked_by(&open, true, TokenStatus::Active, false, 0, Some(DAY)), None);
        let closed = TokenPolicy { allow_fine_grained: false, ..TokenPolicy::default() };
        assert_eq!(blocked_by(&closed, true, TokenStatus::Active, false, 0, Some(DAY)), Some("fine-grained tokens not allowed"));
        // Classic tokens being off does not touch fine-grained ones.
        let no_classic = TokenPolicy { allow_classic: false, ..TokenPolicy::default() };
        assert_eq!(blocked_by(&no_classic, true, TokenStatus::Active, false, 0, Some(DAY)), None);
    }

    #[test]
    fn rules_rows_read_with_defaults() {
        let row = RuleRow { id: "wsp_1".into(), slug: "acme".into(), ..RuleRow::default() };
        assert_eq!(row.policy(), TokenPolicy::default());
        let set = RuleRow { allow_classic: Some(0.0), require_approval: Some(0.0), max_lifetime_days: Some(90.0), forbid_no_expiry: Some(1.0), ..row };
        let policy = set.policy();
        assert!(!policy.allow_classic && policy.allow_fine_grained && !policy.require_approval && policy.forbid_no_expiry);
        assert_eq!(policy.max_lifetime_days, Some(90));
    }

    #[test]
    fn a_listed_row_describes_a_fine_grained_token() {
        let more = TokenRowMore {
            kind: Some(FINE_GRAINED.into()),
            repository_selection: Some("selected".into()),
            permissions: Some(r#"{"contents":"write","metadata":"read"}"#.into()),
            status: Some("pending".into()),
            owner_workspace: Some("acme".into()),
            ..TokenRowMore::default()
        };
        let mut info = AccessToken::default();
        more.describe(&mut info);
        assert_eq!(info.kind, TokenKind::FineGrained);
        let details = info.fine_grained.unwrap();
        assert_eq!(details.workspace.as_deref(), Some("acme"));
        assert_eq!(details.repository_selection, RepositorySelection::Selected);
        assert_eq!(details.status, TokenStatus::Pending);
        assert_eq!(details.permissions.get("contents"), Some(&Access::Write));
        let mut workspace = AccessToken::default();
        TokenRowMore { workspace_id: Some("wsp_1".into()), admin: Some(1.0), ..TokenRowMore::default() }.describe(&mut workspace);
        assert_eq!(workspace.kind, TokenKind::Workspace);
        assert!(workspace.admin && workspace.fine_grained.is_none());
    }

    #[test]
    fn repositories_are_named_in_the_resource_owner() {
        assert_eq!(qualified(Some("acme"), "web"), "acme/web");
        assert_eq!(qualified(Some("acme"), "Acme/Web"), "acme/web");
        assert!(describe_policy(&TokenPolicy::default()).contains("with approval"));
    }

    #[test]
    fn scopes_are_kept_for_every_check() {
        let asked: BTreeMap<String, String> = [("contents".to_owned(), "read".to_owned())].into();
        let (_, scopes) = fine_grained::resolve(&asked, true).unwrap();
        assert_eq!(scopes_text(&scopes), "repo:read code:read");
        assert!(scopes.contains(&Scope::CodeRead));
    }
}
