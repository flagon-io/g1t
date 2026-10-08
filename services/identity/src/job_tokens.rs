//! Workflow jobs' tokens: `G1T_TOKEN` (and `GITHUB_TOKEN`, its alias) for
//! one job of a g1t Actions run. Each acts as the repository's workspace,
//! reaches that repository only, holds the scopes the job's `permissions:`
//! give it, and ends when the job does. See migration 0030.

use g1t_contracts::identity::{CreateJobTokenArgs, CreatedAccessToken, RevokeJobTokensArgs};
use g1t_contracts::time::SQL_NOW;
use worker::Result;

use crate::Identity;
use crate::tokens::Grant;

/// No job runs longer than a day, whatever its caller asks for.
const MAX_JOB_TTL_SECONDS: u64 = 24 * 60 * 60 + 600;

impl Identity {
    pub async fn create_job_token(&self, a: CreateJobTokenArgs) -> Result<CreatedAccessToken> {
        let created = self
            .mint_for_workspace(
                &a.workspace.id,
                &a.name,
                a.ttl_seconds.clamp(60, MAX_JOB_TTL_SECONDS),
                &Grant::asked(&Some(a.scopes.clone())),
            )
            .await?;
        self.db
            .prepare("UPDATE access_tokens SET repo = ?, job_id = ?, job_run_id = ?, job_pulls = ? WHERE id = ?")
            .bind(&[
                format!("{}/{}", a.repo.namespace, a.repo.name).to_lowercase().into(),
                a.job_id.as_str().into(),
                a.run_id.as_str().into(),
                u32::from(a.pull_requests).into(),
                created.info.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(created)
    }

    /// Ends a job's tokens: they stop working at once.
    pub async fn revoke_job_tokens(&self, a: RevokeJobTokensArgs) -> Result<bool> {
        if a.job_id.trim().is_empty() {
            return Ok(false);
        }
        self.db
            .prepare(format!(
                "UPDATE access_tokens SET expires_at = {SQL_NOW}
                 WHERE job_id = ? AND (expires_at IS NULL OR expires_at > {SQL_NOW})"
            ))
            .bind(&[a.job_id.as_str().into()])?
            .run()
            .await?;
        Ok(true)
    }
}
