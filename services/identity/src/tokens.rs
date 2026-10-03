//! Access tokens: the `g1t_…` secrets used by git, the API and the MCP
//! server.
//!
//! There is one implementation and two kinds of owner. A personal token
//! acts as the person who made it. A workspace's token belongs to the
//! workspace and acts as it, so automation needs no account of its own and
//! keeps working when the member who set it up leaves.

use g1t_contracts::identity::*;
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
const MAX_TOKENS_PER_WORKSPACE: usize = 50;
const WORKSPACE_ID_PREFIX: &str = "wsp_";

const TOKEN_COLUMNS: &str = "access_tokens.id, access_tokens.name, access_tokens.created_at,
  access_tokens.last_used_at, users.username AS created_by";

/// Who a new token belongs to.
enum Owner<'a> {
    User(&'a str),
    Workspace {
        id: &'a str,
        created_by: Option<&'a str>,
    },
}

#[derive(Deserialize)]
struct TokenRow {
    id: String,
    name: String,
    created_at: String,
    last_used_at: Option<String>,
    created_by: Option<String>,
}

impl From<TokenRow> for AccessToken {
    fn from(row: TokenRow) -> Self {
        AccessToken {
            id: row.id,
            name: row.name,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            created_by: row.created_by,
        }
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
}

#[derive(Deserialize)]
struct WorkspaceRef {
    id: String,
    slug: String,
}

fn text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

impl Identity {
    pub async fn user_for_access_token(&self, token: &str) -> Result<Viewer> {
        if !token.starts_with(TOKEN_PREFIX) {
            return Ok(None);
        }
        let Some(presented) = self
            .db
            .prepare(format!(
                "SELECT id, user_id, workspace_id, last_used_at, agent_scope FROM access_tokens
                 WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > {SQL_NOW})"
            ))
            .bind(&[crypto::sha256_hex(token).into()])?
            .first::<Presented>(None)
            .await?
        else {
            return Ok(None);
        };
        // An agent's token: g1t-agent, a member of its repository's
        // workspace, and only for what its scope lists.
        if let Some(scope) = presented
            .agent_scope
            .as_deref()
            .and_then(|scope| serde_json::from_str::<AgentScope>(scope).ok())
        {
            return Ok(Some(User {
                id: AGENT_ID.to_owned(),
                username: AGENT_NAME.to_owned(),
                kind: PrincipalKind::Agent,
                verified: true,
                workspaces: vec![Membership {
                    slug: scope.repo.namespace,
                    role: Role::Member,
                }],
            }));
        }
        let viewer = match (&presented.user_id, &presented.workspace_id) {
            (Some(user_id), _) => {
                self.find_user(
                    "SELECT id, username, email_verified_at IS NOT NULL AS verified
                     FROM users WHERE id = ?",
                    user_id,
                )
                .await?
            }
            (None, Some(workspace_id)) => self.workspace_principal(workspace_id).await?,
            (None, None) => None,
        };
        if viewer.is_some() {
            self.note_use(&presented).await?;
        }
        Ok(viewer)
    }

    /// A workspace as the actor behind one of its own tokens. It can do
    /// what a member can, in that workspace only.
    async fn workspace_principal(&self, workspace_id: &str) -> Result<Viewer> {
        let workspace = self
            .db
            .prepare("SELECT id, slug FROM workspaces WHERE id = ?")
            .bind(&[workspace_id.into()])?
            .first::<WorkspaceRef>(None)
            .await?;
        Ok(workspace.map(|workspace| User {
            id: workspace.id,
            username: workspace.slug.clone(),
            kind: PrincipalKind::Workspace,
            verified: true,
            workspaces: vec![Membership {
                slug: workspace.slug,
                role: Role::Member,
            }],
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

    async fn mint(
        &self,
        owner: Owner<'_>,
        name: &str,
        ttl_seconds: Option<u64>,
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
        let info = AccessToken {
            id: new_id("tok", now),
            name,
            created_at: rfc3339(now),
            last_used_at: None,
            created_by: None,
        };
        self.db
            .prepare(
                "INSERT INTO access_tokens
                   (id, user_id, workspace_id, created_by, name, token_hash, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                info.id.as_str().into(),
                text(user_id),
                text(workspace_id),
                text(created_by),
                info.name.as_str().into(),
                crypto::sha256_hex(&token).into(),
                info.created_at.as_str().into(),
                ttl_seconds.map_or(JsValue::NULL, |ttl| rfc3339(now + ttl * 1000).into()),
            ])?
            .run()
            .await?;
        Ok(CreatedAccessToken { token, info })
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
        self.mint(owner, &a.name, a.ttl_seconds).await
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
        self.tokens_where("access_tokens.user_id = ?", &a.user.id)
            .await
    }

    /// Tokens that do not expire: the ones a person made on purpose, rather
    /// than those issued to an application or a hosted agent.
    async fn tokens_where(&self, owner: &str, id: &str) -> Result<Vec<AccessToken>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT {TOKEN_COLUMNS} FROM access_tokens
                 LEFT JOIN users ON users.id = access_tokens.created_by
                 WHERE {owner} AND access_tokens.expires_at IS NULL
                 ORDER BY access_tokens.id"
            ))
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<TokenRow>()?;
        Ok(rows.into_iter().map(AccessToken::from).collect())
    }

    pub async fn list_workspace_tokens(
        &self,
        a: WorkspaceTokensArgs,
    ) -> Result<Outcome<Vec<AccessToken>>> {
        let slug = a.slug.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&slug)) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only members can see a workspace's access tokens.",
            ));
        }
        let Some(workspace) = self.get_workspace(SlugArgs { slug }).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        Ok(Outcome::Ok(
            self.tokens_where("access_tokens.workspace_id = ?", &workspace.id)
                .await?,
        ))
    }

    /// The workspace's id, if `actor` is a person who owns it.
    async fn owned_workspace(&self, actor: &User, slug: &str) -> Result<Outcome<String>> {
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

    pub async fn create_workspace_token(
        &self,
        a: CreateWorkspaceTokenArgs,
    ) -> Result<Outcome<CreatedAccessToken>> {
        let workspace_id = match self.owned_workspace(&a.actor, &a.slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if a.name.trim().is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Name the token after what will use it.",
            ));
        }
        let existing = self
            .tokens_where("access_tokens.workspace_id = ?", &workspace_id)
            .await?;
        if existing.len() >= MAX_TOKENS_PER_WORKSPACE {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This workspace has the maximum number of access tokens. Delete one first.",
            ));
        }
        let mut created = self
            .mint(
                Owner::Workspace {
                    id: &workspace_id,
                    created_by: Some(&a.actor.id),
                },
                &a.name,
                None,
            )
            .await?;
        created.info.created_by = Some(a.actor.username);
        Ok(Outcome::Ok(created))
    }

    pub async fn remove_workspace_token(
        &self,
        a: RemoveWorkspaceTokenArgs,
    ) -> Result<Outcome<bool>> {
        let workspace_id = match self.owned_workspace(&a.actor, &a.slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        self.db
            .prepare("DELETE FROM access_tokens WHERE id = ? AND workspace_id = ?")
            .bind(&[a.id.into(), workspace_id.into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }
}
