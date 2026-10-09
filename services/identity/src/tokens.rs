//! Access tokens: the `g1t_…` secrets used by git, the API and the MCP
//! server.
//!
//! There is one kind of token and two kinds of owner. A personal token
//! acts as the person who made it. A workspace's token belongs to the
//! workspace and acts as it, so automation needs no account of its own and
//! keeps working when the member who set it up leaves. Either is made and
//! changed with permissions and a reach (token_reach.rs); this file mints,
//! resolves, lists and deletes them.

use g1t_contracts::identity::*;
use g1t_contracts::scopes::{FULL_ACCESS, JobToken, Scope, TokenAccess, everything, parse_scopes, permissions_of, scopes_text};
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, Role, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Identity, crypto};

pub const TOKEN_PREFIX: &str = "g1t_";
/// How stale a token's last-used time may get before it is written again.
const LAST_USED_RESOLUTION_MS: u64 = 5 * 60 * 1000;
pub(crate) const MAX_TOKENS_PER_WORKSPACE: usize = 50;
const WORKSPACE_ID_PREFIX: &str = "wsp_";

pub(crate) const TOKEN_COLUMNS: &str = "access_tokens.id, access_tokens.name, access_tokens.created_at,
  access_tokens.last_used_at, users.username AS created_by, access_tokens.scopes,
  access_tokens.expires_at, access_tokens.description, access_tokens.admin,
  access_tokens.workspace_id, access_tokens.repository_selection,
  access_tokens.status, access_tokens.review_reason, access_tokens.website,
  (SELECT slug FROM workspaces WHERE workspaces.id = access_tokens.owner_workspace_id) AS owner_workspace";

/// Who a new token belongs to.
pub(crate) enum Owner<'a> {
    User(&'a str),
    Workspace {
        id: &'a str,
        created_by: Option<&'a str>,
    },
}

#[derive(Deserialize)]
pub(crate) struct TokenRow {
    id: String,
    name: String,
    created_at: String,
    last_used_at: Option<String>,
    created_by: Option<String>,
    scopes: Option<String>,
    expires_at: Option<String>,
    /// Its reach, status, description and a workspace token's Admin
    /// (migration 0034; see token_reach.rs).
    #[serde(flatten)]
    pub(crate) more: crate::token_reach::TokenRowMore,
}

/// What a token or grant may do, as it is to be stored. A token reaches
/// whatever its owner can; only its scopes narrow that.
///
/// The `resources` columns (migration 0022) held a limit to some
/// workspaces or repositories. That limit was retired (migration 0023);
/// the columns stay, since D1 cannot drop them in place, and nothing
/// reads or writes them.
#[derive(Clone, Debug, Default)]
pub(crate) struct Grant {
    /// Null: full access.
    pub scopes: Option<Vec<Scope>>,
}

impl Grant {
    /// From what a caller asked for: unknown scopes are left out.
    pub(crate) fn asked(scopes: &Option<Vec<String>>) -> Self {
        Grant {
            scopes: scopes.as_ref().map(|scopes| parse_scopes(&scopes.join(" "))),
        }
    }

    /// The `scopes` column: `*` for full access.
    pub(crate) fn scopes_column(&self) -> String {
        match &self.scopes {
            None => FULL_ACCESS.to_owned(),
            Some(scopes) => scopes_text(scopes),
        }
    }
}

/// A `scopes` column read back: the scopes (null for full access), and
/// whether it is a legacy row, made before scopes.
pub(crate) fn stored_scopes(column: Option<&str>) -> (Option<Vec<String>>, bool) {
    match column {
        None => (None, true),
        Some(FULL_ACCESS) => (None, false),
        Some(text) => (
            Some(parse_scopes(text).iter().map(|scope| scope.as_str().to_owned()).collect()),
            false,
        ),
    }
}

/// The owner of a token being used.
#[derive(Deserialize)]
struct Presented {
    id: String,
    user_id: Option<String>,
    workspace_id: Option<String>,
    last_used_at: Option<String>,
    /// Set on an agent's token: what it may do, as JSON `AgentScope`.
    agent_scope: Option<String>,
    scopes: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Set on a workflow job's token (job_tokens.rs): its repository, job
    /// and run.
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    job_run_id: Option<String>,
    #[serde(default)]
    job_pulls: Option<u32>,
    /// 1 when its owner let it use the website (migration 0043).
    #[serde(default)]
    website: Option<f64>,
    /// The workspace it is made for, its repositories and status, a
    /// workspace token's Admin, and when it was made and expires, for the
    /// rules of the workspaces it reaches (token_reach.rs).
    #[serde(flatten)]
    facts: crate::token_reach::Facts,
}

#[derive(Deserialize)]
struct WorkspaceRef {
    id: String,
    slug: String,
}

fn text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// Whether a token being used may be used on the website as its owner: one
/// a person made and turned that on for, never a workspace's, a job's or an
/// agent's (apps/web, app/lib/website-token.ts).
fn website_allowed(presented: &Presented) -> bool {
    presented.website.is_some_and(|on| on >= 1.0)
        && presented.user_id.is_some()
        && presented.workspace_id.is_none()
        && presented.job_id.is_none()
        && presented.agent_scope.is_none()
}

impl Identity {
    pub async fn user_for_access_token(&self, token: &str) -> Result<Viewer> {
        if !token.starts_with(TOKEN_PREFIX) {
            return Ok(None);
        }
        let Some(presented) = self
            .db
            .prepare(format!(
                "SELECT id, user_id, workspace_id, last_used_at, agent_scope, scopes, name,
                   repo, job_id, job_run_id, job_pulls, created_at, expires_at,
                   owner_workspace_id, repository_selection, status, admin, website
                 FROM access_tokens
                 WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > {SQL_NOW})"
            ))
            .bind(&[crypto::sha256_hex(token).into()])?
            .first::<Presented>(None)
            .await?
        else {
            return Ok(None);
        };
        // An agent's token: g1t on behalf of the person it was made
        // for, in its repository's workspace while they belong to it, and
        // only for what its scope lists. See run_credentials.rs.
        if let Some(scope) = presented
            .agent_scope
            .as_deref()
            .and_then(|scope| serde_json::from_str::<AgentScope>(scope).ok())
        {
            return self
                .agent_principal(
                    &presented.id,
                    presented.user_id.as_deref(),
                    presented.workspace_id.as_deref(),
                    scope,
                )
                .await;
        }
        let mut viewer = match (&presented.user_id, &presented.workspace_id) {
            (Some(user_id), _) => {
                self.find_user(
                    "SELECT id, username, display_username, email_verified_at IS NOT NULL AS verified, avatar
                     FROM users WHERE id = ? AND deleted_at IS NULL",
                    user_id,
                )
                .await?
            }
            (None, Some(workspace_id)) => self.workspace_principal(workspace_id).await?,
            (None, None) => None,
        };
        if let Some(user) = viewer.as_mut() {
            self.note_use(&presented).await?;
            let (scopes, legacy) = stored_scopes(presented.scopes.as_deref());
            user.token = Some(Box::new(TokenAccess {
                token_id: presented.id.clone(),
                scopes,
                legacy,
                name: presented.name.clone(),
                repo: presented.repo.clone(),
                job: match (&presented.job_id, &presented.job_run_id) {
                    (Some(job_id), Some(run_id)) => Some(JobToken {
                        run_id: run_id.clone(),
                        job_id: job_id.clone(),
                        pull_requests: presented.job_pulls == Some(1),
                    }),
                    _ => None,
                },
                website: website_allowed(&presented),
                ..TokenAccess::default()
            }));
            // What it reaches: the workspace it is made for and its
            // repositories, the workspaces whose rules let it in, a
            // workspace token's role.
            self.apply_reach(user, &presented.id, presented.user_id.is_some(), &presented.facts).await?;
        }
        Ok(viewer)
    }

    pub(crate) fn info(row: TokenRow) -> AccessToken {
        let (scopes, legacy) = stored_scopes(row.scopes.as_deref());
        let held: Vec<Scope> = scopes.as_ref().map_or_else(everything, |scopes| scopes.iter().filter_map(|scope| Scope::parse(scope)).collect());
        let mut info = AccessToken {
            id: row.id,
            name: row.name,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            created_by: row.created_by,
            scopes,
            legacy,
            expires_at: row.expires_at,
            permissions: permissions_of(&held),
            ..AccessToken::default()
        };
        row.more.describe(&mut info);
        info
    }

    /// A workspace as the actor behind one of its own tokens. It can do
    /// what a member can, in that workspace only.
    pub(crate) async fn workspace_principal(&self, workspace_id: &str) -> Result<Viewer> {
        let workspace = self
            .db
            // A deleted workspace's tokens are refused until it is restored.
            .prepare("SELECT id, slug FROM workspaces WHERE id = ? AND deleted_at IS NULL")
            .bind(&[workspace_id.into()])?
            .first::<WorkspaceRef>(None)
            .await?;
        Ok(workspace.map(|workspace| User {
            id: workspace.id,
            username: workspace.slug.clone(),
            kind: PrincipalKind::Workspace,
            verified: true,
            workspaces: vec![Membership::member(workspace.slug)],
            ..User::default()
        }))
    }

    async fn note_use(&self, presented: &Presented) -> Result<()> {
        let now = now_ms();
        let stale = rfc3339(now.saturating_sub(LAST_USED_RESOLUTION_MS));
        if presented
            .last_used_at
            .as_deref()
            .is_some_and(|at| at >= stale.as_str())
        {
            return Ok(());
        }
        self.db
            .prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?")
            .bind(&[rfc3339(now).into(), presented.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    pub(crate) async fn mint(
        &self,
        owner: Owner<'_>,
        name: &str,
        ttl_seconds: Option<u64>,
        grant: &Grant,
        listed: bool,
    ) -> Result<CreatedAccessToken> {
        let token = format!("{TOKEN_PREFIX}{}", crypto::random_hex(20));
        let now = now_ms();
        let name: String = match name.trim() {
            "" => "Access token".to_owned(),
            name => name.chars().take(100).collect(),
        };
        let (user_id, workspace_id, created_by) = match owner {
            Owner::User(id) => (Some(id), None, Some(id)),
            Owner::Workspace { id, created_by } => (None, Some(id), created_by),
        };
        let expires_at = ttl_seconds.map(|ttl| rfc3339(now + ttl * 1000));
        let info = AccessToken {
            id: new_id("tok", now),
            name,
            created_at: rfc3339(now),
            last_used_at: None,
            created_by: None,
            scopes: grant
                .scopes
                .as_ref()
                .map(|scopes| scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
            legacy: false,
            expires_at: expires_at.clone(),
            permissions: permissions_of(&grant.scopes.clone().unwrap_or_else(everything)),
            workspace_owned: workspace_id.is_some(),
            ..AccessToken::default()
        };
        self.db
            .prepare(
                "INSERT INTO access_tokens
                   (id, user_id, workspace_id, created_by, name, token_hash, created_at, expires_at,
                    scopes, listed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                info.id.as_str().into(),
                text(user_id),
                text(workspace_id),
                text(created_by),
                info.name.as_str().into(),
                crypto::sha256_hex(&token).into(),
                info.created_at.as_str().into(),
                text(expires_at.as_deref()),
                grant.scopes_column().into(),
                JsValue::from(u8::from(listed)),
            ])?
            .run()
            .await?;
        Ok(CreatedAccessToken { token, info })
    }

    /// A workspace's own token that expires and is never listed: what a
    /// workflow job's token is minted as (job_tokens.rs).
    pub(crate) async fn mint_for_workspace(
        &self,
        workspace_id: &str,
        name: &str,
        ttl_seconds: u64,
        grant: &Grant,
    ) -> Result<CreatedAccessToken> {
        self.mint(
            Owner::Workspace {
                id: workspace_id,
                created_by: None,
            },
            name,
            Some(ttl_seconds),
            grant,
            false,
        )
        .await
    }

    pub async fn create_access_token(
        &self,
        a: CreateAccessTokenArgs,
    ) -> Result<CreatedAccessToken> {
        // Told apart by the id, which says what it names, since callers pass
        // on actors that other services stored as an id and a name.
        let owner = if a.user.id.starts_with(WORKSPACE_ID_PREFIX) {
            Owner::Workspace {
                id: &a.user.id,
                created_by: None,
            }
        } else {
            Owner::User(&a.user.id)
        };
        let created = self.mint(owner, &a.name, a.ttl_seconds, &Grant::asked(&a.scopes), a.listed).await?;
        // A person's lasting token: in their security log and their
        // workspaces' audit logs. Short-lived ones (agents' runs, OAuth
        // access tokens) are recorded where they are made.
        if a.ttl_seconds.is_none() && !a.user.id.starts_with(WORKSPACE_ID_PREFIX) && !a.user.username.is_empty() {
            self.log_security(&a.user.id, "token_created", Some(&created.info.name), None).await;
            self.audit_account(&a.user, "token.created", &format!("Created access token {}", created.info.name)).await;
        }
        Ok(created)
    }

    /// `remove_access_token`: deletes one of a person's own tokens.
    pub async fn remove_access_token(&self, a: RemoveArgs) -> Result<()> {
        let name: Option<String> = self
            .db
            .prepare("DELETE FROM access_tokens WHERE id = ? AND user_id = ? RETURNING name")
            .bind(&[a.id.as_str().into(), a.user.id.as_str().into()])?
            .first(Some("name"))
            .await?;
        if let Some(name) = name {
            self.log_security(&a.user.id, "token_deleted", Some(&name), None).await;
            self.audit_account(&a.user, "token.deleted", &format!("Deleted access token {name}")).await;
        }
        Ok(())
    }

    /// A token for a g1t agent working for `on_behalf_of`, which can do
    /// only what `scope` lists. It is recorded as theirs, so it is listed and
    /// can be deleted with their other tokens.
    pub async fn create_agent_token(&self, a: CreateAgentTokenArgs) -> Result<CreatedAccessToken> {
        let created = self
            .mint(
                Owner::User(&a.on_behalf_of.id),
                &format!("g1t agent in {}/{}", a.scope.repo.namespace, a.scope.repo.name),
                Some(a.ttl_seconds),
                &Grant::default(),
                false,
            )
            .await?;
        self.db
            .prepare("UPDATE access_tokens SET agent_scope = ? WHERE id = ?")
            .bind(&[
                serde_json::to_string(&a.scope)?.into(),
                created.info.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(created)
    }

    /// What an agent's token may do, or `None` for any other token.
    pub async fn agent_scope(&self, a: TokenArgs) -> Result<Option<AgentScope>> {
        let scope: Option<Option<String>> = self
            .db
            .prepare(format!(
                "SELECT agent_scope FROM access_tokens
                 WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > {SQL_NOW})"
            ))
            .bind(&[crypto::sha256_hex(&a.token).into()])?
            .first::<Option<String>>(Some("agent_scope"))
            .await?;
        Ok(scope
            .flatten()
            .and_then(|scope| serde_json::from_str(&scope).ok()))
    }

    pub async fn list_access_tokens(&self, a: UserArgs) -> Result<Vec<AccessToken>> {
        let mut tokens = self.tokens_where("access_tokens.user_id = ?", &a.user.id).await?;
        // Its selected repositories, by name.
        self.name_repositories(&mut tokens, &Some(a.user)).await?;
        Ok(tokens)
    }

    /// The tokens a person or workspace made on purpose: those that do not
    /// expire, and those made with an expiry from settings, rather than
    /// those issued to an application or a hosted agent.
    pub(crate) async fn tokens_where(&self, owner: &str, id: &str) -> Result<Vec<AccessToken>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT {TOKEN_COLUMNS} FROM access_tokens
                 LEFT JOIN users ON users.id = access_tokens.created_by
                 WHERE {owner} AND (access_tokens.expires_at IS NULL OR access_tokens.listed = 1)
                   AND access_tokens.agent_scope IS NULL
                 ORDER BY access_tokens.id"
            ))
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<TokenRow>()?;
        Ok(rows.into_iter().map(Self::info).collect())
    }

    pub async fn list_workspace_tokens(
        &self,
        a: WorkspaceTokensArgs,
    ) -> Result<Outcome<Vec<AccessToken>>> {
        let slug = a.slug.to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&slug)) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only members can see a workspace's access tokens.",
            ));
        }
        let Some(workspace) = self.get_workspace(SlugArgs { slug }).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let mut tokens = self.tokens_where("access_tokens.workspace_id = ?", &workspace.id).await?;
        self.name_repositories(&mut tokens, &a.viewer).await?;
        Ok(Outcome::Ok(tokens))
    }

    /// The workspace's id, if `actor` is a person who owns it.
    pub(crate) async fn owned_workspace(&self, actor: &User, slug: &str) -> Result<Outcome<String>> {
        let slug = slug.to_lowercase();
        if actor.kind != PrincipalKind::User || actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can manage a workspace's access tokens.",
            ));
        }
        Ok(match self.get_workspace(SlugArgs { slug }).await? {
            Some(workspace) => Outcome::Ok(workspace.id),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    pub async fn remove_workspace_token(
        &self,
        a: RemoveWorkspaceTokenArgs,
    ) -> Result<Outcome<bool>> {
        let workspace_id = match self.owned_workspace(&a.actor, &a.slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let name: Option<String> = self
            .db
            .prepare("DELETE FROM access_tokens WHERE id = ? AND workspace_id = ? RETURNING name")
            .bind(&[a.id.into(), workspace_id.into()])?
            .first(Some("name"))
            .await?;
        if let Some(name) = name {
            self.audit_workspace(
                &a.actor,
                "workspace_token.deleted",
                &a.slug.to_lowercase(),
                g1t_contracts::audit::Surface::Web,
                format!("Deleted workspace access token {name}"),
            )
            .await;
        }
        Ok(Outcome::Ok(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_without_scopes_is_legacy_full_access() {
        assert_eq!(stored_scopes(None), (None, true));
        assert_eq!(stored_scopes(Some("*")), (None, false));
        assert_eq!(
            stored_scopes(Some("issues:write repo:read nonsense")),
            (Some(vec!["repo:read".to_owned(), "issues:write".to_owned()]), false)
        );
    }

    #[test]
    fn scopes_are_stored_as_text() {
        let grant = Grant::asked(&Some(vec!["issues:read".to_owned(), "bogus".to_owned()]));
        assert_eq!(grant.scopes_column(), "issues:read");
        assert_eq!(Grant::asked(&None).scopes_column(), "*");
        assert_eq!(Grant::asked(&Some(vec![])).scopes_column(), "");
    }

    #[test]
    fn only_a_persons_own_token_with_it_turned_on_uses_the_website() {
        let row = |extra: serde_json::Value| {
            let mut value = serde_json::json!({ "id": "tok_1", "user_id": "usr_1", "workspace_id": null, "last_used_at": null, "agent_scope": null, "scopes": "*", "website": 1.0 });
            for (key, field) in extra.as_object().unwrap() {
                value[key] = field.clone();
            }
            serde_json::from_value::<Presented>(value).unwrap()
        };
        assert!(website_allowed(&row(serde_json::json!({}))));
        assert!(!website_allowed(&row(serde_json::json!({ "website": 0.0 }))));
        assert!(!website_allowed(&row(serde_json::json!({ "website": null }))));
        // A workspace's token, a job's token and an agent's never do.
        assert!(!website_allowed(&row(serde_json::json!({ "user_id": null, "workspace_id": "wsp_1" }))));
        assert!(!website_allowed(&row(serde_json::json!({ "job_id": "job_1" }))));
        assert!(!website_allowed(&row(serde_json::json!({ "agent_scope": "{}" }))));
    }
}
