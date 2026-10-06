//! Access tokens: the `g1t_…` secrets used by git, the API and the MCP
//! server.
//!
//! There is one implementation and two kinds of owner. A personal token
//! acts as the person who made it. A workspace's token belongs to the
//! workspace and acts as it, so automation needs no account of its own and
//! keeps working when the member who set it up leaves.

use g1t_contracts::identity::*;
use g1t_contracts::scopes::{FULL_ACCESS, Scope, TokenAccess, parse_scopes, scopes_text};
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
  access_tokens.last_used_at, users.username AS created_by, access_tokens.scopes,
  access_tokens.expires_at";

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
    scopes: Option<String>,
    expires_at: Option<String>,
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
                "SELECT id, user_id, workspace_id, last_used_at, agent_scope, scopes
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
                    "SELECT id, username, email_verified_at IS NOT NULL AS verified
                     FROM users WHERE id = ?",
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
            }));
        }
        Ok(viewer)
    }

    fn info(row: TokenRow) -> AccessToken {
        let (scopes, legacy) = stored_scopes(row.scopes.as_deref());
        AccessToken {
            id: row.id,
            name: row.name,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            created_by: row.created_by,
            scopes,
            legacy,
            expires_at: row.expires_at,
        }
    }

    /// A workspace as the actor behind one of its own tokens. It can do
    /// what a member can, in that workspace only.
    pub(crate) async fn workspace_principal(&self, workspace_id: &str) -> Result<Viewer> {
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

    async fn mint(
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
        self.mint(owner, &a.name, a.ttl_seconds, &Grant::asked(&a.scopes), a.listed).await
    }

    /// Changes what one of a person's own tokens may do.
    pub async fn update_access_token(&self, a: UpdateAccessTokenArgs) -> Result<Outcome<AccessToken>> {
        let grant = Grant::asked(&a.scopes);
        let found: Option<String> = self
            .db
            .prepare(
                "UPDATE access_tokens SET scopes = ?
                 WHERE id = ? AND user_id = ? AND agent_scope IS NULL
                 RETURNING id",
            )
            .bind(&[
                grant.scopes_column().into(),
                a.id.as_str().into(),
                a.user.id.as_str().into(),
            ])?
            .first(Some("id"))
            .await?;
        if found.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such token."));
        }
        let row = self
            .db
            .prepare(format!(
                "SELECT {TOKEN_COLUMNS} FROM access_tokens
                 LEFT JOIN users ON users.id = access_tokens.created_by
                 WHERE access_tokens.id = ?"
            ))
            .bind(&[a.id.into()])?
            .first::<TokenRow>(None)
            .await?;
        match row {
            Some(row) => Ok(Outcome::Ok(Self::info(row))),
            None => Ok(Outcome::fail(FailureCode::NotFound, "No such token.")),
        }
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
        self.tokens_where("access_tokens.user_id = ?", &a.user.id)
            .await
    }

    /// The tokens a person or workspace made on purpose: those that do not
    /// expire, and those made with an expiry from settings, rather than
    /// those issued to an application or a hosted agent.
    async fn tokens_where(&self, owner: &str, id: &str) -> Result<Vec<AccessToken>> {
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
        // A workspace's token reaches that workspace only: it acts as the
        // workspace (see `workspace_principal`), narrowed by its scopes.
        let grant = Grant::asked(&a.scopes);
        let mut created = self
            .mint(
                Owner::Workspace {
                    id: &workspace_id,
                    created_by: Some(&a.actor.id),
                },
                &a.name,
                a.ttl_seconds,
                &grant,
                true,
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
}
