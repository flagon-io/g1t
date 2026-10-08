//! OAuth 2.1 authorization for applications, such as MCP clients, that sign
//! a person in through their browser: authorization code with PKCE, and
//! rotating refresh tokens.
//!
//! This service issues and redeems codes and tokens. Who the client is and
//! where it may be redirected is decided by the callers: the site, which
//! shows the consent page, and the API, which serves the token endpoint.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::scopes::FULL_ACCESS;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use worker::wasm_bindgen::JsValue;
use g1t_kit::now_ms;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::Result;

use crate::tokens::{Grant, stored_scopes};
use crate::{Identity, crypto};

const CODE_TTL_SECONDS: u64 = 5 * 60;
const ACCESS_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const REFRESH_TTL_SECONDS: u64 = 180 * 24 * 60 * 60;
const REFRESH_PREFIX: &str = "g1r_";

#[derive(Deserialize)]
struct CodeRow {
    user_id: String,
    client_id: String,
    client_name: String,
    redirect_uri: String,
    code_challenge: String,
    scopes: Option<String>,
}

#[derive(Deserialize)]
struct GrantRow {
    id: String,
    user_id: String,
    client_id: String,
    client_name: String,
    access_token_id: Option<String>,
    scopes: Option<String>,
}

#[derive(Deserialize)]
struct GrantListRow {
    id: String,
    client_name: String,
    created_at: String,
    last_used_at: String,
    scopes: Option<String>,
}

fn text(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// Whether `verifier` is the secret behind an S256 `challenge` (RFC 7636).
fn pkce_matches(verifier: &str, challenge: &str) -> bool {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) == challenge
}

fn invalid_grant<T>(message: &str) -> Outcome<T> {
    Outcome::fail(FailureCode::Invalid, message)
}

fn grant(row: GrantListRow) -> OAuthGrant {
    let (scopes, legacy) = stored_scopes(row.scopes.as_deref());
    OAuthGrant {
        id: row.id,
        client_name: row.client_name,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        scopes,
        legacy,
    }
}

impl Identity {
    /// Records that `user` approved the client and returns the one-time
    /// code the client exchanges for tokens.
    pub async fn oauth_authorize(&self, a: OAuthAuthorizeArgs) -> Result<OAuthCode> {
        let code = crypto::random_hex(32);
        // What the person granted, carried through the code to the grant.
        let grant = Grant::asked(&a.scopes);
        self.db
            .prepare(format!(
                "INSERT INTO oauth_codes
                   (id, user_id, client_id, client_name, redirect_uri, code_challenge, expires_at,
                    scopes)
                 VALUES (?, ?, ?, ?, ?, ?, {}, ?)",
                sql_after(CODE_TTL_SECONDS)
            ))
            .bind(&[
                crypto::sha256_hex(&code).into(),
                a.user.id.into(),
                a.client_id.into(),
                a.client_name.into(),
                a.redirect_uri.into(),
                a.code_challenge.into(),
                grant.scopes_column().into(),
            ])?
            .run()
            .await?;
        Ok(OAuthCode { code })
    }

    /// Redeems an authorization code. A code works once, only for the client
    /// and redirect it was issued to, and only with the PKCE verifier.
    pub async fn oauth_exchange(&self, a: OAuthExchangeArgs) -> Result<Outcome<OAuthTokens>> {
        let id = crypto::sha256_hex(&a.code);
        let row = self
            .db
            .prepare(format!(
                "DELETE FROM oauth_codes WHERE id = ? AND expires_at > {SQL_NOW}
                 RETURNING user_id, client_id, client_name, redirect_uri, code_challenge, scopes"
            ))
            .bind(&[id.into()])?
            .first::<CodeRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(invalid_grant(
                "That code is not valid, has expired, or was already used.",
            ));
        };
        if row.client_id != a.client_id || row.redirect_uri != a.redirect_uri {
            return Ok(invalid_grant("That code was issued to a different client."));
        }
        if !pkce_matches(&a.code_verifier, &row.code_challenge) {
            return Ok(invalid_grant("The code verifier does not match."));
        }
        let now = now_ms();
        let grant_id = new_id("oag", now);
        self.db
            .prepare(
                "INSERT INTO oauth_grants
                   (id, user_id, client_id, client_name, created_at, last_used_at, scopes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                grant_id.as_str().into(),
                row.user_id.as_str().into(),
                row.client_id.into(),
                row.client_name.as_str().into(),
                rfc3339(now).into(),
                rfc3339(now).into(),
                text(row.scopes.as_deref()),
            ])?
            .run()
            .await?;
        self.log_security(&row.user_id, "oauth_grant_created", Some(&row.client_name), None).await;
        if let Some(person) = self
            .find_public_user("SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ?", &row.user_id)
            .await?
        {
            self.audit_account(&person, "oauth_grant.created", &format!("Authorized the application {}", row.client_name)).await;
        }
        Ok(Outcome::Ok(
            self.issue_oauth_tokens(
                &grant_id,
                &row.user_id,
                &row.client_name,
                row.scopes.as_deref(),
            )
            .await?,
        ))
    }

    /// Trades a refresh token for new tokens. The refresh token and the
    /// access token issued with it stop working.
    pub async fn oauth_refresh(&self, a: OAuthRefreshArgs) -> Result<Outcome<OAuthTokens>> {
        let row = self
            .db
            .prepare(format!(
                "SELECT id, user_id, client_id, client_name, access_token_id, scopes
                 FROM oauth_grants
                 WHERE refresh_hash = ? AND expires_at > {SQL_NOW}"
            ))
            .bind(&[crypto::sha256_hex(&a.refresh_token).into()])?
            .first::<GrantRow>(None)
            .await?;
        let Some(row) = row.filter(|row| row.client_id == a.client_id) else {
            return Ok(invalid_grant(
                "That refresh token is not valid or has expired. Sign in again.",
            ));
        };
        if let Some(previous) = &row.access_token_id {
            self.db
                .prepare("DELETE FROM access_tokens WHERE id = ?")
                .bind(&[previous.as_str().into()])?
                .run()
                .await?;
        }
        // A refreshed token keeps what the grant allows now.
        Ok(Outcome::Ok(
            self.issue_oauth_tokens(
                &row.id,
                &row.user_id,
                &row.client_name,
                row.scopes.as_deref(),
            )
            .await?,
        ))
    }

    /// A new access token and refresh token for a grant.
    /// `scopes` is the grant's column: a grant made before scopes (null)
    /// keeps full access.
    async fn issue_oauth_tokens(
        &self,
        grant_id: &str,
        user_id: &str,
        client_name: &str,
        scopes: Option<&str>,
    ) -> Result<OAuthTokens> {
        let (scopes, _) = stored_scopes(scopes);
        let access = self
            .create_access_token(CreateAccessTokenArgs {
                user: User {
                    id: user_id.to_owned(),
                    ..User::default()
                },
                name: client_name.to_owned(),
                ttl_seconds: Some(ACCESS_TTL_SECONDS),
                scopes: scopes.clone(),
                listed: false,
            })
            .await?;
        let refresh_token = format!("{REFRESH_PREFIX}{}", crypto::random_hex(32));
        self.db
            .prepare(format!(
                "UPDATE oauth_grants
                 SET refresh_hash = ?, access_token_id = ?, last_used_at = {SQL_NOW},
                     expires_at = {}
                 WHERE id = ?",
                sql_after(REFRESH_TTL_SECONDS)
            ))
            .bind(&[
                crypto::sha256_hex(&refresh_token).into(),
                access.info.id.into(),
                grant_id.into(),
            ])?
            .run()
            .await?;
        Ok(OAuthTokens {
            access_token: access.token,
            refresh_token,
            expires_in: ACCESS_TTL_SECONDS,
            scope: Some(scopes.map_or_else(|| FULL_ACCESS.to_owned(), |scopes| scopes.join(" "))),
        })
    }

    /// Applications the user has signed in to, most recently used first.
    pub async fn list_oauth_grants(&self, a: UserArgs) -> Result<Vec<OAuthGrant>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT id, client_name, created_at, last_used_at, scopes FROM oauth_grants
                 WHERE user_id = ? AND expires_at > {SQL_NOW} ORDER BY last_used_at DESC"
            ))
            .bind(&[a.user.id.into()])?
            .all()
            .await?
            .results::<GrantListRow>()?;
        Ok(rows.into_iter().map(grant).collect())
    }

    /// Changes what an application may do: its current access token at
    /// once, and every token it is given from now on.
    pub async fn update_oauth_grant(&self, a: UpdateOAuthGrantArgs) -> Result<Outcome<OAuthGrant>> {
        let scopes = Grant::asked(&a.scopes).scopes_column();
        let row = self
            .db
            .prepare(format!(
                "UPDATE oauth_grants SET scopes = ?
                 WHERE id = ? AND user_id = ? AND expires_at > {SQL_NOW}
                 RETURNING id, client_name, created_at, last_used_at, scopes"
            ))
            .bind(&[
                scopes.as_str().into(),
                a.id.as_str().into(),
                a.user.id.as_str().into(),
            ])?
            .first::<GrantListRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such application."));
        };
        self.db
            .prepare(
                "UPDATE access_tokens SET scopes = ?
                 WHERE id = (SELECT access_token_id FROM oauth_grants WHERE id = ?)",
            )
            .bind(&[scopes.as_str().into(), a.id.as_str().into()])?
            .run()
            .await?;
        self.log_security(&a.user.id, "oauth_grant_rescoped", Some(&row.client_name), None).await;
        self.audit_account(&a.user, "oauth_grant.rescoped", &format!("Changed what the application {} may do", row.client_name)).await;
        Ok(Outcome::Ok(grant(row)))
    }

    /// Signs an application out: its refresh token and access token stop
    /// working.
    pub async fn revoke_oauth_grant(&self, a: RemoveArgs) -> Result<()> {
        let client: Option<String> = self
            .db
            .prepare("SELECT client_name FROM oauth_grants WHERE id = ? AND user_id = ?")
            .bind(&[a.id.as_str().into(), a.user.id.as_str().into()])?
            .first(Some("client_name"))
            .await?;
        if let Some(client) = &client {
            self.log_security(&a.user.id, "oauth_grant_revoked", Some(client), None).await;
            self.audit_account(&a.user, "oauth_grant.revoked", &format!("Revoked the application {client}")).await;
        }
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "DELETE FROM access_tokens WHERE id =
                           (SELECT access_token_id FROM oauth_grants WHERE id = ? AND user_id = ?)",
                    )
                    .bind(&[a.id.as_str().into(), a.user.id.as_str().into()])?,
                self.db
                    .prepare("DELETE FROM oauth_grants WHERE id = ? AND user_id = ?")
                    .bind(&[a.id.as_str().into(), a.user.id.as_str().into()])?,
            ])
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::pkce_matches;

    #[test]
    fn pkce_verifier_matches_its_challenge() {
        // The example from RFC 7636, appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(pkce_matches(verifier, challenge));
        assert!(!pkce_matches("something else", challenge));
    }
}
