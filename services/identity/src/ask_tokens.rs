//! Ask g1t's credentials: one per answer, so Ask reads g1t through the MCP
//! server as the person asking, with exactly their access, and only reads.
//! See `g1t_contracts::identity::CreateAskTokenArgs` for the policy, and
//! migration 0048.

use g1t_contracts::identity::{
    ASK_TOKEN_NAME, ASK_TOKEN_PURPOSE, ASK_TOKEN_TTL_SECONDS, AskToken, CreateAskTokenArgs, RevokeAskTokenArgs,
    ask_token_scopes,
};
use g1t_contracts::scopes::RepositorySelection;
use g1t_contracts::time::SQL_NOW;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind};
use worker::Result;

use crate::Identity;
use crate::tokens::{Grant, Owner};

/// What an Ask credential may hold.
pub(crate) fn ask_grant() -> Grant {
    Grant { scopes: Some(ask_token_scopes()) }
}

impl Identity {
    pub async fn create_ask_token(&self, a: CreateAskTokenArgs) -> Result<Outcome<AskToken>> {
        let slug = a.workspace.trim().to_lowercase();
        // A person, never a workspace's, a job's or a run's credential.
        if a.actor.kind != PrincipalKind::User || a.actor.acting.is_some() || a.actor.id.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person can ask g1t."));
        }
        if !a.actor.is_member(&slug) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can use Ask in this workspace."));
        }
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let created = self
            .mint(Owner::User(&a.actor.id), ASK_TOKEN_NAME, Some(ASK_TOKEN_TTL_SECONDS), &ask_grant(), false)
            .await?;
        // Made for the workspace alone, active, and marked as Ask's.
        self.db
            .prepare(
                "UPDATE access_tokens SET owner_workspace_id = ?, repository_selection = ?, status = 'active', purpose = ?
                 WHERE id = ?",
            )
            .bind(&[
                workspace_id.as_str().into(),
                RepositorySelection::All.as_str().into(),
                ASK_TOKEN_PURPOSE.into(),
                created.info.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(AskToken { token: created.token, id: created.info.id }))
    }

    /// Ends an Ask credential: it stops working at once.
    pub async fn revoke_ask_token(&self, a: RevokeAskTokenArgs) -> Result<bool> {
        if a.id.trim().is_empty() {
            return Ok(false);
        }
        self.db
            .prepare(format!(
                "UPDATE access_tokens SET expires_at = {SQL_NOW}
                 WHERE id = ? AND purpose = ? AND (expires_at IS NULL OR expires_at > {SQL_NOW})"
            ))
            .bind(&[a.id.as_str().into(), ASK_TOKEN_PURPOSE.into()])?
            .run()
            .await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Level, Scope, TokenAccess};

    #[test]
    fn an_ask_credential_only_reads() {
        let scopes = ask_grant().scopes.expect("never full access");
        assert!(!scopes.is_empty());
        assert!(scopes.iter().all(|scope| scope.level() == Level::Read), "{scopes:?}");
        // What a token holding them is let do, as the API decides it.
        let access = TokenAccess {
            token_id: "tok_ask".into(),
            scopes: Some(scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
            ..TokenAccess::default()
        };
        assert!(access.allows(Scope::PullRequestsRead));
        assert!(access.allows(Scope::RepoRead));
        assert!(!access.allows(Scope::PullRequestsWrite));
        assert!(!access.allows(Scope::WorkWrite));
        assert!(!access.allows(Scope::CodeWrite));
        // A person's conversations are never in it.
        assert!(!access.allows(Scope::ChatRead));
    }
}
