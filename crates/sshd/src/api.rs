//! Client for the g1t Worker's internal endpoints, which own all
//! authentication and authorization decisions.
//!
//! Neither endpoint exists yet. What they are to do:
//!
//! - `POST /_internal/ssh/user` with `{ fingerprint, used }` resolves the key
//!   through identity's `principal_for_ssh_key` (`used` once the client has
//!   proved it holds the private key, so only then is its last use
//!   recorded) and answers [`User`], or 404 for an unknown key.
//! - `POST /_internal/ssh/access` with `{ fingerprint, owner, repo, service }`
//!   resolves the key again, so a key deleted mid-session stops working,
//!   and asks repos' `git_access` with that principal: a deploy key reaches
//!   its one repository, and pushes only when it was given write access.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Who a key signs in as.
#[derive(Clone, Debug, Deserialize)]
pub struct User {
    /// `usr_…`, or for a deploy key its repository's workspace (`wsp_…`).
    pub id: String,
    pub username: String,
    /// Set for a deploy key: the one repository it reaches, `owner/name`.
    #[serde(default)]
    pub repo: Option<String>,
    /// The key's fingerprint, as it was looked up with.
    #[serde(skip)]
    pub fingerprint: String,
}

impl User {
    /// The name a greeting uses: the person, or a deploy key's repository.
    pub fn greeting_name(&self) -> &str {
        self.repo.as_deref().unwrap_or(&self.username)
    }
}

/// An Artifacts remote and a short-lived token scoped to one repo.
#[derive(Debug, Deserialize)]
pub struct Access {
    pub remote: String,
    pub token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Service {
    #[serde(rename = "git-upload-pack")]
    UploadPack,
    #[serde(rename = "git-receive-pack")]
    ReceivePack,
}

impl Service {
    pub fn as_str(self) -> &'static str {
        match self {
            Service::UploadPack => "git-upload-pack",
            Service::ReceivePack => "git-receive-pack",
        }
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

pub struct Api {
    base: String,
    secret: String,
    pub http: reqwest::Client,
}

impl Api {
    pub fn new(base: String, secret: String) -> Self {
        Self {
            base,
            secret,
            http: reqwest::Client::new(),
        }
    }

    /// Who the key with this SHA-256 fingerprint signs in as: the person
    /// who registered it, or a repository's deploy key. `used` once the
    /// client has proved it holds the private key.
    pub async fn user_for_key(&self, fingerprint: &str, used: bool) -> Result<Option<User>> {
        let response = self
            .http
            .post(format!("{}/_internal/ssh/user", self.base))
            .bearer_auth(&self.secret)
            .json(&serde_json::json!({ "fingerprint": fingerprint, "used": used }))
            .send()
            .await
            .context("key lookup failed")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let mut user: User = response.error_for_status()?.json().await?;
        user.fingerprint = fingerprint.to_owned();
        Ok(Some(user))
    }

    /// `Ok(Err(message))` is a refusal to show the user.
    pub async fn access(
        &self,
        user: &User,
        owner: &str,
        repo: &str,
        service: Service,
    ) -> Result<Result<Access, String>> {
        let response = self
            .http
            .post(format!("{}/_internal/ssh/access", self.base))
            .bearer_auth(&self.secret)
            .json(&serde_json::json!({
                "user_id": user.id,
                "fingerprint": user.fingerprint,
                "owner": owner,
                "repo": repo,
                "service": service,
            }))
            .send()
            .await
            .context("access check failed")?;
        if response.status().is_client_error() {
            let body: ErrorBody = response.json().await?;
            return Ok(Err(body.error));
        }
        Ok(Ok(response.error_for_status()?.json().await?))
    }
}
