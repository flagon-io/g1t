//! Durable cleanup, committed in the same transaction as identity deletion.
//! Each target is idempotent: a timeout after success may call it again.
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{D1PreparedStatement, Result};

use crate::Identity;

#[derive(Deserialize, Serialize)]
pub(crate) struct PurgeJob {
    subject_id: String,
    kind: String,
    target: String,
    payload: String,
    created_at: String,
    completed_at: Option<String>,
    attempts: u32,
    retry_at: String,
    last_error: Option<String>,
}

impl Identity {
    pub(crate) fn purge_job_statements(&self, kind: &str, id: &str, payload: Value) -> Result<Vec<D1PreparedStatement>> {
        let now = rfc3339(now_ms());
        let payload = payload.to_string();
        ["AVATAR", "CHAT", "NOTIFY", "ARTIFACTS", "EVENTS"]
            .into_iter()
            .map(|target| {
                self.db.prepare(include_str!("purge_job.sql")).bind(&[
                    id.into(),
                    kind.into(),
                    target.into(),
                    payload.as_str().into(),
                    now.as_str().into(),
                ])
            })
            .collect()
    }

    pub(crate) async fn run_purge_jobs(&self) -> Result<()> {
        let jobs = self
            .db
            .prepare("SELECT * FROM purge_jobs WHERE completed_at IS NULL AND retry_at <= ? ORDER BY retry_at LIMIT 25")
            .bind(&[rfc3339(now_ms()).into()])?
            .all()
            .await?
            .results::<PurgeJob>()?;
        for job in jobs {
            let result = self.run_purge_job(&job).await;
            // Do not persist remote response bodies: they may contain personal data or secrets.
            let now = rfc3339(now_ms());
            if matches!(result, Ok(true)) {
                self.db.prepare("UPDATE purge_jobs SET completed_at = ?3, attempts = attempts + 1, last_error = NULL, payload = '{}' WHERE subject_id = ?1 AND target = ?2 AND completed_at IS NULL")
                    .bind(&[job.subject_id.as_str().into(), job.target.as_str().into(), now.as_str().into()])?.run().await?;
            } else if matches!(result, Ok(false)) {
                self.db.prepare("UPDATE purge_jobs SET attempts = attempts + 1, retry_at = ?3, last_error = NULL WHERE subject_id = ?1 AND target = ?2 AND completed_at IS NULL")
                    .bind(&[job.subject_id.as_str().into(), job.target.as_str().into(), rfc3339(now_ms() + 900_000).into()])?.run().await?;
            } else {
                let retry = rfc3339(now_ms() + 900_000 * (1_u64 << job.attempts.min(6)));
                self.db.prepare("UPDATE purge_jobs SET attempts = attempts + 1, retry_at = ?3, last_error = 'Cleanup failed; retry pending' WHERE subject_id = ?1 AND target = ?2 AND completed_at IS NULL")
                    .bind(&[job.subject_id.as_str().into(), job.target.as_str().into(), retry.into()])?.run().await?;
                worker::console_error!("purge target {} failed for {}; retry pending", job.target, job.subject_id);
            }
        }
        Ok(())
    }

    async fn run_purge_job(&self, job: &PurgeJob) -> Result<bool> {
        let payload: Value = serde_json::from_str(&job.payload)?;
        if job.target == "AVATAR" {
            self.forget_avatar(payload.get("avatar").and_then(Value::as_str).map(str::to_owned)).await?;
            return Ok(true);
        }
        let service = self.env.service(&job.target)?;
        if job.target == "EVENTS" {
            let (kind, data) = if job.kind == "user" {
                ("user.deleted", json!({"userId": job.subject_id, "username": payload["username"]}))
            } else {
                ("workspace.deleted", json!({"workspaceId": job.subject_id, "slug": payload["slug"]}))
            };
            let _: Value = g1t_kit::call(
                &service,
                "publish",
                &Publish { events: vec![NewEvent { kind, source: "identity", repo_id: None, actor: None, data }] },
            )
            .await?;
        } else {
            let result: Value = g1t_kit::call(
                &service,
                "purge_personal_data",
                &json!({
                    "kind": job.kind, "id": job.subject_id, "username": payload["username"], "slug": payload["slug"],
                    "old_slugs": payload["old_slugs"], "members": payload["members"],
                }),
            )
            .await?;
            if result.get("pending") == Some(&Value::Bool(true)) {
                return Ok(false);
            }
            if result.get("ok") != Some(&Value::Bool(true)) {
                return Err(worker::Error::RustError("Cleanup did not confirm success".into()));
            }
        }
        Ok(true)
    }

    pub(crate) async fn pending_purge_jobs(&self) -> Result<Vec<PurgeJob>> {
        self.db.prepare("SELECT subject_id, kind, target, '{}' AS payload, created_at, completed_at, attempts, retry_at, last_error FROM purge_jobs WHERE completed_at IS NULL ORDER BY created_at LIMIT 500")
            .all().await?.results()
    }
}
