//! Artifacts of workflow runs: which there are, kept here, while the API
//! keeps their bytes in R2 (the ACTIONS_CACHE bucket, under `a/`).
//!
//! - A name is one artifact in a run. Uploading a name the run has is
//!   refused unless the upload says `overwrite`, which replaces it.
//! - One artifact is at most `ARTIFACT_MAX_BYTES`, and a run's artifacts at
//!   most `RUN_ARTIFACTS_MAX_BYTES` together.
//! - Each is kept for its `retention-days`, or the repository's setting
//!   when it gives none, and never longer than that setting (1 to 90 days,
//!   14 unless changed). The hourly sweep deletes what has expired, and
//!   uploads left unfinished.
//! - Ids are numbers, as GitHub's are.
//!
//! A sandbox reaches these with its job's token or its runtime token
//! (runtime.rs); people through the API and the run's page.

use g1t_contracts::access::Capability;
use g1t_contracts::actions::{
    ARTIFACT_MAX_BYTES, ARTIFACT_RETENTION_DEFAULT_DAYS, ARTIFACT_RETENTION_MAX_DAYS, Artifact, ArtifactArgs, ArtifactBlob, ArtifactCommitArgs,
    ArtifactList, ArtifactReservation, ArtifactReserveArgs, ArtifactRetention, ArtifactRetentionArgs, ArtifactsArgs, DeleteArtifactArgs,
    JobArtifactsArgs, RUN_ARTIFACTS_MAX_BYTES,
};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::runtime::{DOWNLOAD_SECONDS, LINK_SECONDS};
use crate::{Actions, check, fail};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// An upload not finished after this long is given up.
const PENDING_MS: u64 = 6 * 60 * 60 * 1000;
const COLUMNS: &str = "artifacts.*, runs.git_ref AS git_ref, runs.sha AS sha";

#[derive(Debug, Deserialize)]
struct Row {
    id: f64,
    repo_id: String,
    run_id: String,
    job_id: String,
    name: String,
    object: String,
    format: String,
    size: f64,
    digest: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
    expires_at: String,
    #[serde(default)]
    git_ref: Option<String>,
    #[serde(default)]
    sha: Option<String>,
}

impl Row {
    fn view(&self) -> Artifact {
        Artifact {
            id: self.id as u64,
            name: self.name.clone(),
            size: self.size as u64,
            digest: self.digest.clone(),
            format: self.format.clone(),
            run_id: self.run_id.clone(),
            job_id: self.job_id.clone(),
            repo_id: self.repo_id.clone(),
            expired: self.status == "expired",
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            expires_at: self.expires_at.clone(),
            head_branch: self.git_ref.as_deref().map(|r| r.strip_prefix("refs/heads/").unwrap_or(r).to_owned()),
            head_sha: self.sha.clone(),
        }
    }
}

/// GitHub's rule for an artifact's name: 1 to 256 characters, none of
/// `" : < > | * ? \ /` or line breaks.
pub(crate) fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 256 && !name.chars().any(|c| matches!(c, '"' | ':' | '<' | '>' | '|' | '*' | '?' | '\\' | '/' | '\r' | '\n'))
}

/// The days an artifact is kept: what it asked for (as days, or as a time
/// to expire), else the repository's `setting`, and never more than the
/// setting.
pub(crate) fn retention(asked_days: u32, asked_until_ms: Option<u64>, setting: u32, now: u64) -> u32 {
    let setting = setting.clamp(1, ARTIFACT_RETENTION_MAX_DAYS);
    let days = match asked_until_ms {
        _ if asked_days > 0 => asked_days,
        Some(until) if until > now => (until - now).div_ceil(DAY_MS) as u32,
        _ => setting,
    };
    days.clamp(1, setting)
}

/// Where an artifact is in R2: under its repository, by its id. The API's
/// blobs.rs names it the same way.
pub(crate) fn object_of(repo_id: &str, id: u64) -> String {
    format!("a/{repo_id}/{id}")
}

fn number(id: u64) -> JsValue {
    JsValue::from_f64(id as f64)
}

impl Actions {
    /// How long the repository keeps artifacts.
    pub(crate) async fn retention_setting(&self, repo_id: &str) -> Result<u32> {
        #[derive(Deserialize)]
        struct Setting {
            artifact_retention_days: f64,
        }
        let setting = self
            .db
            .prepare("SELECT artifact_retention_days FROM repo_settings WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<Setting>(None)
            .await?;
        Ok(setting.map_or(ARTIFACT_RETENTION_DEFAULT_DAYS, |s| s.artifact_retention_days as u32))
    }

    async fn artifact_rows(&self, filter: &str, values: &[JsValue]) -> Result<Vec<Row>> {
        self.db
            .prepare(format!("SELECT {COLUMNS} FROM artifacts JOIN runs ON runs.id = artifacts.run_id WHERE {filter}"))
            .bind(values)?
            .all()
            .await?
            .results::<Row>()
    }

    /// The bytes a run's artifacts hold, `except` one.
    async fn run_bytes(&self, run: &str, except: u64) -> Result<u64> {
        #[derive(Deserialize)]
        struct Sum {
            bytes: Option<f64>,
        }
        let sum = self
            .db
            .prepare("SELECT SUM(size) AS bytes FROM artifacts WHERE run_id = ? AND status <> 'expired' AND id <> ?")
            .bind(&[run.into(), number(except)])?
            .first::<Sum>(None)
            .await?;
        Ok(sum.and_then(|s| s.bytes).unwrap_or(0.0) as u64)
    }

    /// Deletes artifacts' objects, then their rows. Objects that cannot be
    /// deleted now are left to the sweep, their rows marked expired.
    async fn forget_artifacts(&self, rows: &[(u64, String)]) -> Result<()> {
        for (id, _) in rows {
            self.db
                .prepare("UPDATE artifacts SET status = 'expired', updated_at = ? WHERE id = ?")
                .bind(&[rfc3339(now_ms()).into(), number(*id)])?
                .run()
                .await?;
        }
        let Some(bucket) = &self.cache else { return Ok(()) };
        for chunk in rows.chunks(100) {
            if let Err(error) = bucket.delete_multiple(chunk.iter().map(|(_, object)| object.as_str()).collect()).await {
                worker::console_error!("actions: artifact objects not deleted: {error}");
                return Ok(());
            }
            for (id, _) in chunk {
                self.db.prepare("DELETE FROM artifacts WHERE id = ?").bind(&[number(*id)])?.run().await?;
            }
        }
        Ok(())
    }

    /// `artifact_reserve`.
    pub async fn artifact_reserve(&self, a: ArtifactReserveArgs) -> Result<Outcome<ArtifactReservation>> {
        let job = check!(self.job_for_credential(&a.job, &a.token).await?);
        if !valid_name(&a.name) {
            return Ok(fail(
                FailureCode::Invalid,
                format!("`{}` is not an artifact name: 1 to 256 characters, none of \" : < > | * ? \\ / or line breaks.", a.name),
            ));
        }
        if a.size > ARTIFACT_MAX_BYTES {
            return Ok(fail(
                FailureCode::Invalid,
                format!("It is {} MB; an artifact is at most {} MB.", a.size / 1_048_576, ARTIFACT_MAX_BYTES / 1_048_576),
            ));
        }
        let held = self.run_bytes(&job.run_id, 0).await?;
        if held + a.size > RUN_ARTIFACTS_MAX_BYTES {
            return Ok(fail(
                FailureCode::Invalid,
                format!("A run's artifacts are at most {} MB together, and this run's hold {} MB.", RUN_ARTIFACTS_MAX_BYTES / 1_048_576, held / 1_048_576),
            ));
        }
        let existing = self
            .artifact_rows("artifacts.run_id = ? AND artifacts.name = ? AND artifacts.status <> 'expired'", &[job.run_id.as_str().into(), a.name.as_str().into()])
            .await?;
        if !existing.is_empty() {
            if !a.overwrite {
                return Ok(fail(
                    FailureCode::Conflict,
                    format!("This run already has an artifact named {}. Give the upload another name, or `overwrite: true` to replace it.", a.name),
                ));
            }
            let replaced: Vec<(u64, String)> = existing.iter().map(|row| (row.id as u64, row.object.clone())).collect();
            self.forget_artifacts(&replaced).await?;
        }
        let now = now_ms();
        let setting = self.retention_setting(&job.repo_id).await?;
        let days = retention(a.retention_days, a.expires_at.as_deref().and_then(parse_rfc3339), setting, now);
        let expires_at = rfc3339(now + u64::from(days) * DAY_MS);
        let format = match a.format.as_deref() {
            Some("tgz") => "tgz",
            _ => "zip",
        };
        // Named by its id once it has one (`object_of` in the API's blobs.rs);
        // until then, by a placeholder no other row has.
        let placeholder = format!("a/{}/{}", job.repo_id, new_id("art", now));
        let at = rfc3339(now);
        #[derive(Deserialize)]
        struct Inserted {
            id: f64,
        }
        let inserted = self
            .db
            .prepare(
                "INSERT INTO artifacts (repo_id, namespace, run_id, job_id, name, object, format, size, status, created_at, updated_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9, ?10)
                 ON CONFLICT DO NOTHING
                 RETURNING id",
            )
            .bind(&[
                job.repo_id.as_str().into(),
                job.namespace.as_str().into(),
                job.run_id.as_str().into(),
                job.id.as_str().into(),
                a.name.as_str().into(),
                placeholder.as_str().into(),
                format.into(),
                (a.size as f64).into(),
                at.as_str().into(),
                expires_at.as_str().into(),
            ])?
            .first::<Inserted>(None)
            .await?;
        let Some(inserted) = inserted else {
            return Ok(fail(FailureCode::Conflict, format!("Another job of this run is uploading an artifact named {}.", a.name)));
        };
        let id = inserted.id as u64;
        let object = object_of(&job.repo_id, id);
        self.db.prepare("UPDATE artifacts SET object = ? WHERE id = ?").bind(&[object.as_str().into(), number(id)])?.run().await?;
        Ok(Outcome::Ok(ArtifactReservation { id, object, retention_days: days, expires_at }))
    }

    /// The pending artifact of a job's run named by id or name.
    async fn pending_artifact(&self, run: &str, id: Option<u64>, name: Option<&str>) -> Result<Option<Row>> {
        let rows = match (id, name) {
            (Some(id), _) => self.artifact_rows("artifacts.id = ? AND artifacts.run_id = ? AND artifacts.status = 'pending'", &[number(id), run.into()]).await?,
            (None, Some(name)) => {
                self.artifact_rows("artifacts.name = ? AND artifacts.run_id = ? AND artifacts.status = 'pending'", &[name.into(), run.into()]).await?
            }
            (None, None) => Vec::new(),
        };
        Ok(rows.into_iter().next())
    }

    /// `artifact_commit`.
    pub async fn artifact_commit(&self, a: ArtifactCommitArgs) -> Result<Outcome<Artifact>> {
        let job = check!(self.job_for_credential(&a.job, &a.token).await?);
        let Some(row) = self.pending_artifact(&job.run_id, a.id, a.name.as_deref()).await? else {
            return Ok(fail(FailureCode::NotFound, "No upload of that artifact is in progress."));
        };
        let id = row.id as u64;
        // 0: the size it was measured at as it was stored (the toolkit's
        // uploads), rather than one the job says.
        let size = if a.size > 0 { a.size } else { row.size as u64 };
        let held = self.run_bytes(&job.run_id, id).await?;
        let refused = if size > ARTIFACT_MAX_BYTES {
            Some(format!("It is {} MB; an artifact is at most {} MB.", size / 1_048_576, ARTIFACT_MAX_BYTES / 1_048_576))
        } else if held + size > RUN_ARTIFACTS_MAX_BYTES {
            Some(format!("A run's artifacts are at most {} MB together, and this run's hold {} MB.", RUN_ARTIFACTS_MAX_BYTES / 1_048_576, held / 1_048_576))
        } else {
            None
        };
        if let Some(message) = refused {
            self.forget_artifacts(&[(id, row.object.clone())]).await?;
            return Ok(fail(FailureCode::Invalid, message));
        }
        let digest = a.digest.filter(|d| d.starts_with("sha256:") && d.len() == 71);
        self.db
            .prepare("UPDATE artifacts SET status = 'ready', size = ?, digest = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
            .bind(&[(size as f64).into(), crate::optional(digest.as_deref()), rfc3339(now_ms()).into(), number(id)])?
            .run()
            .await?;
        let rows = self.artifact_rows("artifacts.id = ?", &[number(id)]).await?;
        Ok(rows.first().map_or_else(|| fail(FailureCode::NotFound, "No such artifact."), |row| Outcome::Ok(row.view())))
    }

    /// `artifact_abort`.
    pub async fn artifact_abort(&self, a: JobArtifactsArgs) -> Result<Outcome<bool>> {
        let job = check!(self.job_for_credential(&a.job, &a.token).await?);
        if let Some(row) = self.pending_artifact(&job.run_id, a.id, a.name.as_deref()).await? {
            self.forget_artifacts(&[(row.id as u64, row.object)]).await?;
        }
        Ok(Outcome::Ok(true))
    }

    /// The ready artifacts of `run`, which must be in the job's repository.
    async fn readable_by_job(&self, a: &JobArtifactsArgs) -> Result<Outcome<(crate::plan::JobRow, Vec<Row>)>> {
        let job = check!(self.job_for_credential(&a.job, &a.token).await?);
        // An id names one artifact of the repository, whichever run made it.
        if let (Some(id), None) = (a.id, a.run_id.as_deref().filter(|r| !r.is_empty())) {
            let rows = self
                .artifact_rows("artifacts.id = ? AND artifacts.repo_id = ? AND artifacts.status = 'ready'", &[number(id), job.repo_id.as_str().into()])
                .await?;
            return Ok(Outcome::Ok((job, rows)));
        }
        let run = a.run_id.clone().filter(|r| !r.is_empty()).unwrap_or_else(|| job.run_id.clone());
        let mut rows = self
            .artifact_rows("artifacts.run_id = ? AND artifacts.repo_id = ? AND artifacts.status = 'ready' ORDER BY artifacts.id", &[run.as_str().into(), job.repo_id.as_str().into()])
            .await?;
        if rows.is_empty() && run != job.run_id {
            let found = self.run_row(&run).await?;
            if found.is_none_or(|found| found.repo_id != job.repo_id) {
                return Ok(fail(FailureCode::NotFound, format!("This repository has no run {run}.")));
            }
        }
        if let Some(name) = &a.name {
            rows.retain(|row| &row.name == name);
        }
        if let Some(id) = a.id {
            rows.retain(|row| row.id as u64 == id);
        }
        Ok(Outcome::Ok((job, rows)))
    }

    /// `job_artifacts`.
    pub async fn job_artifacts(&self, a: JobArtifactsArgs) -> Result<Outcome<Vec<Artifact>>> {
        let (_, rows) = check!(self.readable_by_job(&a).await?);
        Ok(Outcome::Ok(rows.iter().map(Row::view).collect()))
    }

    fn blob_of(&self, row: &Row, seconds: u64) -> Outcome<ArtifactBlob> {
        match self.download_token("artifact", &(row.id as u64).to_string(), &row.object, seconds) {
            Some(blob) => Outcome::Ok(ArtifactBlob { artifact: row.view(), object: row.object.clone(), blob }),
            // Without a key there are no download links; the API streams
            // the object itself for those who need only its name.
            None => Outcome::Ok(ArtifactBlob { artifact: row.view(), object: row.object.clone(), blob: String::new() }),
        }
    }

    /// `job_artifact`.
    pub async fn job_artifact(&self, a: JobArtifactsArgs) -> Result<Outcome<ArtifactBlob>> {
        let (_, rows) = check!(self.readable_by_job(&a).await?);
        Ok(match rows.last() {
            Some(row) => self.blob_of(row, DOWNLOAD_SECONDS),
            None => fail(FailureCode::NotFound, "No such artifact, or it has expired."),
        })
    }

    /// `job_delete_artifact`.
    pub async fn job_delete_artifact(&self, a: JobArtifactsArgs) -> Result<Outcome<Artifact>> {
        let job = check!(self.job_for_credential(&a.job, &a.token).await?);
        let own = JobArtifactsArgs { run_id: Some(job.run_id.clone()), ..a };
        let (_, rows) = check!(self.readable_by_job(&own).await?);
        let Some(row) = rows.last() else {
            return Ok(fail(FailureCode::NotFound, "This run has no such artifact."));
        };
        self.forget_artifacts(&[(row.id as u64, row.object.clone())]).await?;
        let mut gone = row.view();
        gone.expired = true;
        Ok(Outcome::Ok(gone))
    }

    /// `artifacts`.
    pub async fn artifacts(&self, a: ArtifactsArgs) -> Result<Outcome<ArtifactList>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        let mut filter = "artifacts.repo_id = ? AND artifacts.status = 'ready'".to_owned();
        let mut values: Vec<JsValue> = vec![repo.id.as_str().into()];
        if let Some(run) = a.run.as_deref().filter(|r| !r.is_empty()) {
            if self.run_in(&a.repo, run).await?.into_result().is_err() {
                return Ok(fail(FailureCode::NotFound, "No such run."));
            }
            filter.push_str(" AND artifacts.run_id = ?");
            values.push(run.into());
        }
        if let Some(name) = a.name.as_deref().filter(|n| !n.is_empty()) {
            filter.push_str(" AND artifacts.name = ?");
            values.push(name.into());
        }
        let rows = self.artifact_rows(&format!("{filter} ORDER BY artifacts.id DESC"), &values).await?;
        let per_page = a.per_page.unwrap_or(30).clamp(1, 100) as usize;
        let page = a.page.unwrap_or(1).max(1) as usize;
        Ok(Outcome::Ok(ArtifactList {
            total_count: rows.len() as u64,
            artifacts: rows.iter().skip((page - 1) * per_page).take(per_page).map(Row::view).collect(),
        }))
    }

    /// One ready artifact of a repository the viewer can see.
    async fn visible_artifact(&self, a: &ArtifactArgs) -> Result<Outcome<Row>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        let rows = match (a.id, a.run.as_deref(), a.name.as_deref()) {
            (Some(id), _, _) => self.artifact_rows("artifacts.id = ? AND artifacts.repo_id = ? AND artifacts.status = 'ready'", &[number(id), repo.id.as_str().into()]).await?,
            (None, Some(run), Some(name)) => {
                self.artifact_rows(
                    "artifacts.run_id = ? AND artifacts.name = ? AND artifacts.repo_id = ? AND artifacts.status = 'ready'",
                    &[run.into(), name.into(), repo.id.as_str().into()],
                )
                .await?
            }
            _ => return Ok(fail(FailureCode::Invalid, "Name the artifact by its id, or by its run and name.")),
        };
        Ok(rows.into_iter().next().map_or_else(|| fail(FailureCode::NotFound, "No such artifact, or it has expired."), Outcome::Ok))
    }

    /// `artifact`.
    pub async fn artifact(&self, a: ArtifactArgs) -> Result<Outcome<Artifact>> {
        let row = check!(self.visible_artifact(&a).await?);
        Ok(Outcome::Ok(row.view()))
    }

    /// `artifact_download`.
    pub async fn artifact_download(&self, a: ArtifactArgs) -> Result<Outcome<ArtifactBlob>> {
        let row = check!(self.visible_artifact(&a).await?);
        Ok(self.blob_of(&row, LINK_SECONDS))
    }

    /// `delete_artifact`.
    pub async fn delete_artifact(&self, a: DeleteArtifactArgs) -> Result<Outcome<Artifact>> {
        let repo = check!(self.may(&a.actor, &a.repo, Capability::Run).await?);
        let rows = self.artifact_rows("artifacts.id = ? AND artifacts.repo_id = ? AND artifacts.status <> 'expired'", &[number(a.id), repo.id.as_str().into()]).await?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(fail(FailureCode::NotFound, "No such artifact, or it has expired."));
        };
        self.forget_artifacts(&[(row.id as u64, row.object.clone())]).await?;
        let mut gone = row.view();
        gone.expired = true;
        Ok(Outcome::Ok(gone))
    }

    /// `artifact_retention`.
    pub async fn artifact_retention(&self, a: ArtifactRetentionArgs) -> Result<Outcome<ArtifactRetention>> {
        let repo = match a.days {
            Some(days) => {
                let Some(actor) = a.viewer.clone() else {
                    return Ok(fail(FailureCode::Unauthenticated, "Sign in to change how long artifacts are kept."));
                };
                let repo = check!(self.may(&actor, &a.repo, Capability::ManageSettings).await?);
                if !(1..=ARTIFACT_RETENTION_MAX_DAYS).contains(&days) {
                    return Ok(fail(FailureCode::Invalid, format!("Artifacts are kept for 1 to {ARTIFACT_RETENTION_MAX_DAYS} days.")));
                }
                self.db
                    .prepare(
                        "INSERT INTO repo_settings (repo_id, artifact_retention_days, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (repo_id) DO UPDATE SET artifact_retention_days = ?2, updated_at = ?3, updated_by = ?4",
                    )
                    .bind(&[repo.id.as_str().into(), f64::from(days).into(), rfc3339(now_ms()).into(), actor.id.as_str().into()])?
                    .run()
                    .await?;
                repo
            }
            None => match self.visible_repo(&a.repo, &a.viewer).await? {
                Some(repo) => repo,
                None => return Ok(fail(FailureCode::NotFound, "There is no such repository.")),
            },
        };
        Ok(Outcome::Ok(ArtifactRetention { days: self.retention_setting(&repo.id).await?, maximum_allowed_days: ARTIFACT_RETENTION_MAX_DAYS }))
    }

    /// Hourly: artifacts past their time, and uploads left unfinished,
    /// with their objects.
    pub(crate) async fn sweep_artifacts(&self, now: u64) -> Result<()> {
        let at = rfc3339(now);
        self.db
            .prepare("UPDATE artifacts SET status = 'expired', updated_at = ?1 WHERE (status = 'ready' AND expires_at < ?1) OR (status = 'pending' AND created_at < ?2)")
            .bind(&[at.as_str().into(), rfc3339(now.saturating_sub(PENDING_MS)).into()])?
            .run()
            .await?;
        #[derive(Deserialize)]
        struct Gone {
            id: f64,
            object: String,
        }
        let gone = self.db.prepare("SELECT id, object FROM artifacts WHERE status = 'expired' LIMIT 500").all().await?.results::<Gone>()?;
        let gone: Vec<(u64, String)> = gone.into_iter().map(|g| (g.id as u64, g.object)).collect();
        self.forget_artifacts(&gone).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_github_s_rule() {
        for good in ["dist", "coverage report", "build (linux, 22)", "my-app_1.0", "résumé"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "  ", "a/b", "a\\b", "a:b", "a*", "what?", "a\"b", "<x>", "a|b", "a\nb", &"x".repeat(257)] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn retention_is_what_was_asked_up_to_the_setting() {
        let now = 1_000 * DAY_MS;
        // Nothing asked: the repository's setting.
        assert_eq!(retention(0, None, 14, now), 14);
        assert_eq!(retention(0, None, 90, now), 90);
        // Asked for fewer days, or more than the setting allows.
        assert_eq!(retention(3, None, 14, now), 3);
        assert_eq!(retention(30, None, 14, now), 14);
        // The toolkit says when to expire it instead: rounded up to days.
        assert_eq!(retention(0, Some(now + 5 * DAY_MS), 30, now), 5);
        assert_eq!(retention(0, Some(now + 5 * DAY_MS - 1000), 30, now), 5);
        assert_eq!(retention(0, Some(now - 1), 30, now), 30);
        // A setting out of range is held to 1 to 90 days.
        assert_eq!(retention(0, None, 0, now), 1);
        assert_eq!(retention(200, None, 400, now), 90);
    }
}
