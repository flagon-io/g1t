//! Run credentials: a token per sandbox run, bound to the run, its
//! repository and what its kind of work needs, acting as an agent on
//! behalf of the person who started the work. See
//! `g1t_contracts::credentials` for the policy.

use g1t_contracts::credentials::{
    Acting, BindRunCredentialsArgs, CreateRunCredentialArgs, Principal, RevokeRunCredentialsArgs,
    RunBinding, intersect, operations_for,
};
use g1t_contracts::identity::{
    AGENT_ID, AGENT_NAME, AgentScope, CreateAccessTokenArgs, CreatedAccessToken,
};
use g1t_contracts::time::SQL_NOW;
use g1t_contracts::{PrincipalKind, User, Viewer};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;

/// No run outlives this, whatever its caller asks for.
const MAX_RUN_TTL_SECONDS: u64 = 6 * 60 * 60;
const MIN_RUN_TTL_SECONDS: u64 = 60;
/// More hashes than one sandbox ever holds.
const MAX_HASHES: usize = 8;

/// A SHA-256 in lowercase hex, as tokens are stored.
fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Identity {
    /// The composite identity behind an agent's token: the agent, acting
    /// for the person (or workspace) the token was made for, in the run's
    /// workspace only, and only while that person still belongs to it.
    pub(crate) async fn agent_principal(
        &self,
        credential_id: &str,
        user_id: Option<&str>,
        workspace_id: Option<&str>,
        scope: AgentScope,
    ) -> Result<Viewer> {
        let person = match (user_id, workspace_id) {
            (Some(id), _) => {
                self.find_user(
                    "SELECT id, username, email_verified_at IS NOT NULL AS verified
                     FROM users WHERE id = ?",
                    id,
                )
                .await?
            }
            (None, Some(id)) => self.workspace_principal(id).await?,
            (None, None) => None,
        };
        // The person is gone: so is everything that acted for them.
        let Some(person) = person else {
            return Ok(None);
        };
        let agent = scope
            .run
            .as_ref()
            .map(|run| run.agent.clone())
            .unwrap_or_else(|| AGENT_NAME.to_owned());
        Ok(Some(User {
            id: AGENT_ID.to_owned(),
            username: AGENT_NAME.to_owned(),
            kind: PrincipalKind::Agent,
            verified: person.verified,
            workspaces: intersect(&person.workspaces, &scope.repo.namespace),
            acting: Some(Box::new(Acting {
                credential_id: credential_id.to_owned(),
                agent,
                on_behalf_of: Principal {
                    id: person.id,
                    username: person.username,
                },
                scope,
            })),
            ..User::default()
        }))
    }

    pub async fn create_run_credential(
        &self,
        a: CreateRunCredentialArgs,
    ) -> Result<CreatedAccessToken> {
        let agent = a
            .agent
            .filter(|agent| !agent.trim().is_empty())
            .unwrap_or_else(|| AGENT_NAME.to_owned());
        let scope = AgentScope {
            repo: a.repo.clone(),
            operations: operations_for(a.kind, a.usage)
                .into_iter()
                .map(str::to_owned)
                .collect(),
            run: Some(RunBinding {
                kind: a.kind,
                usage: a.usage,
                run_id: None,
                number: a.number,
                agent: agent.clone(),
                read: a.read,
                push: a.push,
            }),
        };
        let created = self
            .create_access_token(CreateAccessTokenArgs {
                user: a.on_behalf_of,
                name: format!(
                    "{agent}: {} run in {}/{}{}",
                    a.kind.as_str(),
                    a.repo.namespace,
                    a.repo.name,
                    a.number.map(|n| format!("#{n}")).unwrap_or_default()
                ),
                ttl_seconds: Some(
                    a.ttl_seconds
                        .clamp(MIN_RUN_TTL_SECONDS, MAX_RUN_TTL_SECONDS),
                ),
            })
            .await?;
        self.db
            .prepare("UPDATE access_tokens SET agent_scope = ? WHERE id = ?")
            .bind(&[
                serde_json::to_string(&scope)?.into(),
                created.info.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(created)
    }

    /// Ties a sandbox's credentials to the agent run it recorded. A token
    /// already bound keeps its run.
    pub async fn bind_run_credentials(&self, a: BindRunCredentialsArgs) -> Result<bool> {
        let hashes: Vec<&String> = a
            .token_hashes
            .iter()
            .filter(|hash| is_hash(hash))
            .take(MAX_HASHES)
            .collect();
        if hashes.is_empty() || a.run_id.trim().is_empty() {
            return Ok(false);
        }
        let marks = vec!["?"; hashes.len()].join(", ");
        let mut values: Vec<JsValue> = vec![a.run_id.as_str().into(), a.run_id.as_str().into()];
        values.extend(hashes.iter().map(|hash| JsValue::from(hash.as_str())));
        self.db
            .prepare(format!(
                "UPDATE access_tokens
                 SET run_id = ?, agent_scope = json_set(agent_scope, '$.run.runId', ?)
                 WHERE token_hash IN ({marks}) AND run_id IS NULL
                   AND json_extract(agent_scope, '$.run') IS NOT NULL"
            ))
            .bind(&values)?
            .run()
            .await?;
        Ok(true)
    }

    /// Ends a sandbox's credentials: they stop working at once. Only run
    /// credentials are touched.
    pub async fn revoke_run_credentials(&self, a: RevokeRunCredentialsArgs) -> Result<bool> {
        let hashes: Vec<&String> = a
            .token_hashes
            .iter()
            .filter(|hash| is_hash(hash))
            .take(MAX_HASHES)
            .collect();
        let mut conditions = Vec::new();
        let mut values: Vec<JsValue> = Vec::new();
        if !hashes.is_empty() {
            conditions.push(format!(
                "token_hash IN ({})",
                vec!["?"; hashes.len()].join(", ")
            ));
            values.extend(hashes.iter().map(|hash| JsValue::from(hash.as_str())));
        }
        if let Some(run_id) = a.run_id.as_deref().filter(|id| !id.trim().is_empty()) {
            conditions.push("run_id = ?".to_owned());
            values.push(run_id.into());
        }
        if conditions.is_empty() {
            return Ok(false);
        }
        self.db
            .prepare(format!(
                "UPDATE access_tokens SET expires_at = {SQL_NOW}
                 WHERE ({}) AND json_extract(agent_scope, '$.run') IS NOT NULL
                   AND (expires_at IS NULL OR expires_at > {SQL_NOW})",
                conditions.join(" OR ")
            ))
            .bind(&values)?
            .run()
            .await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::is_hash;

    #[test]
    fn only_hashes_are_taken() {
        assert!(is_hash(&"a1".repeat(32)));
        assert!(!is_hash(&"A1".repeat(32)));
        assert!(!is_hash("g1t_0123"));
        assert!(!is_hash(&"0".repeat(63)));
    }
}
