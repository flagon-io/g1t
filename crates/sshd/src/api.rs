//! Client for the g1t Worker's internal endpoints, which own all
//! authentication and authorization decisions.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
pub struct User {
    pub id: u64,
    pub username: String,
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

    /// The user who registered the key with this SHA-256 fingerprint.
    pub async fn user_for_key(&self, fingerprint: &str) -> Result<Option<User>> {
        let response = self
            .http
            .post(format!("{}/_internal/ssh/user", self.base))
            .bearer_auth(&self.secret)
            .json(&serde_json::json!({ "fingerprint": fingerprint }))
            .send()
            .await
            .context("key lookup failed")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(response.error_for_status()?.json().await?))
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
