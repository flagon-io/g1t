//! The toolkit's credentials: a job's runtime token, the signed tokens of
//! the blob URLs the toolkit uploads to and downloads from, and the claims
//! of a job's OIDC token.
//!
//! - The runtime token (`ACTIONS_RUNTIME_TOKEN`) is a JSON Web Token, as
//!   the toolkit expects: `@actions/artifact` reads the run and job from
//!   its `scp` claim. It is signed (HS256) with the hash of the job's own
//!   token as the key, so it is checked against the job's row without a
//!   secret of its own, stops working when the job ends, and never lets
//!   its holder read the job's spec or report for it.
//! - A blob token is a payload and its HMAC under a key derived from
//!   `ACTIONS_KEY`: which entry, which R2 upload (for an upload), and until
//!   when. The API serves `/actions/toolkit/blobs/{token}` with it.
//! - OIDC claims follow GitHub's, so cloud providers' trust policies read
//!   them the same way. The API adds `iss`, `aud`, `jti` and the times,
//!   and signs.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use g1t_actions::events::RunInfo;
use g1t_contracts::actions::{BlobArgs, BlobGrant, BlobPart, BlobSignArgs, RuntimeAuthArgs, RuntimeJob};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use g1t_secrets::{hmac_sha256_hex, same, sha256_hex};
use serde::Deserialize;
use serde_json::{Value, json};
use worker::Result;

use crate::plan::{JobRow, RunRow};
use crate::{Actions, check, fail};

/// How long a blob token for an upload is good: as long as an unfinished
/// upload is kept (cache.rs).
pub(crate) const UPLOAD_SECONDS: u64 = 6 * 60 * 60;
/// How long a blob token for a download is good: long enough to start one.
pub(crate) const DOWNLOAD_SECONDS: u64 = 60 * 60;
/// How long a download link the API redirects a person to is good.
pub(crate) const LINK_SECONDS: u64 = 10 * 60;

fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_json(part: &str) -> Option<Value> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).ok()?).ok()
}

/// HMAC-SHA256 of `body` under `key`, base64url.
fn mac(key: &str, body: &str) -> String {
    encode(&hex::decode(hmac_sha256_hex(key, body)).unwrap_or_default())
}

// ── The runtime token ───────────────────────────────────────────────────────

/// The scopes the toolkit reads: `Actions.Results:{run}:{job}` names the
/// run and job to `@actions/artifact`.
pub(crate) fn scopes(run: &str, job: &str) -> String {
    format!("Actions.GenericRead:00000000-0000-0000-0000-000000000000 Actions.UploadArtifacts:{run}:{job} Actions.Results:{run}:{job}")
}

/// A job's runtime token, good for `ttl` seconds from `now` (seconds).
/// `token_hash` is the hash of the job's own token, as its row keeps it.
pub(crate) fn runtime_token(job: &str, run: &str, token_hash: &str, now: u64, ttl: u64) -> String {
    let header = encode(br#"{"typ":"JWT","alg":"HS256"}"#);
    let claims = json!({
        "iss": "g1t",
        "sub": job,
        "job": job,
        "run": run,
        "scp": scopes(run, job),
        "iat": now,
        "nbf": now.saturating_sub(60),
        "exp": now + ttl,
    });
    let claims = encode(claims.to_string().as_bytes());
    let signed = format!("{header}.{claims}");
    let signature = mac(token_hash, &signed);
    format!("{signed}.{signature}")
}

/// The job a runtime token says it is, unchecked: the API reads it to know
/// which job to ask about.
pub fn runtime_job(token: &str) -> Option<String> {
    let claims = decode_json(token.split('.').nth(1)?)?;
    claims["job"].as_str().map(str::to_owned)
}

/// Whether `token` is a good runtime token for `job`, whose own token
/// hashes to `token_hash`, at `now` (seconds).
pub(crate) fn runtime_valid(token: &str, job: &str, token_hash: &str, now: u64) -> bool {
    let mut parts = token.split('.');
    let (Some(header), Some(claims), Some(signature), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if !same(&mac(token_hash, &format!("{header}.{claims}")), signature) {
        return false;
    }
    let Some(claims) = decode_json(claims) else { return false };
    claims["job"].as_str() == Some(job) && claims["exp"].as_u64().is_some_and(|exp| exp > now)
}

/// Whether `token` looks like a runtime token rather than a job's own
/// (which is hex).
pub(crate) fn is_runtime(token: &str) -> bool {
    token.matches('.').count() == 2
}

// ── Blob tokens ─────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, serde::Serialize, Deserialize)]
pub(crate) struct BlobClaims {
    /// `cache` or `artifact`.
    pub k: String,
    /// The entry's id.
    pub i: String,
    /// Its object in R2.
    pub o: String,
    /// The R2 upload, for an upload.
    #[serde(default)]
    pub u: Option<String>,
    /// Good until, seconds since the epoch.
    pub e: u64,
}

/// The key blob tokens are signed with, from the service's own key.
pub(crate) fn blob_key(actions_key: &str) -> String {
    hmac_sha256_hex(actions_key, "g1t actions blob tokens v1")
}

pub(crate) fn sign_blob(key: &str, claims: &BlobClaims) -> String {
    let payload = encode(serde_json::to_string(claims).unwrap_or_default().as_bytes());
    let signature = mac(key, &payload);
    format!("{payload}.{signature}")
}

/// What a blob token grants, if it is signed with `key` and good at `now`.
pub(crate) fn open_blob(key: &str, token: &str, now: u64) -> Option<BlobClaims> {
    let (payload, signature) = token.split_once('.')?;
    if !same(&mac(key, payload), signature) {
        return None;
    }
    let claims: BlobClaims = serde_json::from_value(decode_json(payload)?).ok()?;
    (claims.e > now).then_some(claims)
}

// ── OIDC ────────────────────────────────────────────────────────────────────

/// Whether a job may have an OIDC token: when its permissions, or its
/// workflow's when it has none of its own, give `id-token: write`
/// (`write-all` included). Nothing given gives no OIDC token, as GitHub's
/// default token permissions do not include it.
///
/// This reads only the `id-token` key. When `permissions:` as a whole is
/// read elsewhere, this is the one place to plug that in.
pub(crate) fn id_token_permitted(workflow: &Value, job: &Value) -> bool {
    let permissions = match job.get("permissions") {
        Some(own) => own,
        None => match workflow.get("permissions") {
            Some(theirs) => theirs,
            None => return false,
        },
    };
    match permissions {
        Value::String(all) => all.trim() == "write-all",
        Value::Object(each) => each.get("id-token").and_then(Value::as_str).is_some_and(|level| level.trim() == "write"),
        _ => false,
    }
}

/// A job's `environment:` name, when it names one plainly.
pub(crate) fn environment_name(job: &Value) -> Option<String> {
    match job.get("environment") {
        Some(Value::String(name)) if !name.contains("${{") && !name.trim().is_empty() => Some(name.trim().to_owned()),
        Some(Value::Object(env)) => env.get("name").and_then(Value::as_str).filter(|n| !n.contains("${{") && !n.trim().is_empty()).map(|n| n.trim().to_owned()),
        _ => None,
    }
}

/// GitHub's subject: by environment, else for a pull request, else by ref.
pub fn subject(repository: &str, environment: Option<&str>, event: &str, git_ref: &str) -> String {
    if let Some(environment) = environment {
        return format!("repo:{repository}:environment:{environment}");
    }
    if event == "pull_request" || event == "pull_request_target" {
        return format!("repo:{repository}:pull_request");
    }
    format!("repo:{repository}:ref:{git_ref}")
}

/// What an OIDC token says about a job, besides who issued it, for whom
/// and when.
pub(crate) struct ClaimFacts<'a> {
    pub info: &'a RunInfo,
    pub environment: Option<&'a str>,
    /// The workflow that defines the job: a called workflow's own path.
    pub job_workflow_path: &'a str,
    pub private: bool,
    pub owner_id: &'a str,
    pub self_hosted: bool,
}

pub(crate) fn claims(facts: &ClaimFacts) -> Value {
    let info = facts.info;
    let owner = info.repository.split('/').next().unwrap_or_default();
    let workflow_ref = format!("{}/{}@{}", info.repository, info.workflow_path, info.git_ref);
    let job_workflow_ref = format!("{}/{}@{}", info.repository, facts.job_workflow_path, info.git_ref);
    let mut claims = json!({
        "sub": subject(&info.repository, facts.environment, &info.event_name, &info.git_ref),
        "ref": info.git_ref,
        "sha": info.sha,
        "repository": info.repository,
        "repository_owner": owner,
        "repository_owner_id": facts.owner_id,
        "repository_id": info.repository_id,
        "repository_visibility": if facts.private { "private" } else { "public" },
        "run_id": info.run_id,
        "run_number": info.run_number.to_string(),
        "run_attempt": info.run_attempt.to_string(),
        "actor": info.actor,
        "actor_id": info.actor_id,
        "workflow": info.workflow,
        "workflow_ref": workflow_ref,
        "workflow_sha": info.sha,
        "job_workflow_ref": job_workflow_ref,
        "job_workflow_sha": info.sha,
        "head_ref": info.head_ref.clone().unwrap_or_default(),
        "base_ref": info.base_ref.clone().unwrap_or_default(),
        "event_name": info.event_name,
        "ref_type": info.ref_type(),
        "ref_protected": (info.ref_name() == info.default_branch).to_string(),
        "runner_environment": if facts.self_hosted { "self-hosted" } else { "github-hosted" },
    });
    if let Some(environment) = facts.environment {
        claims["environment"] = json!(environment);
    }
    claims
}

impl Actions {
    /// The running job a runtime token is for.
    pub(crate) async fn job_for_runtime(&self, job: &str, token: &str) -> Result<Outcome<JobRow>> {
        let row = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[job.into()])?.first::<JobRow>(None).await?;
        Ok(match row {
            Some(row)
                if row.status == "in_progress"
                    && row.token_hash.as_deref().is_some_and(|hash| runtime_valid(token, job, hash, now_ms() / 1000)) =>
            {
                Outcome::Ok(row)
            }
            _ => fail(FailureCode::Unauthenticated, "That job is not running, or the token is not its."),
        })
    }

    /// The running job a sandbox's credential is for: its job's own token,
    /// or its runtime token. Only for the cache and artifacts: a runtime
    /// token never reads a job's spec or reports for it.
    pub(crate) async fn job_for_credential(&self, job: &str, token: &str) -> Result<Outcome<JobRow>> {
        if is_runtime(token) {
            return self.job_for_runtime(job, token).await;
        }
        let row = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[job.into()])?.first::<JobRow>(None).await?;
        Ok(match row {
            Some(row) if row.status == "in_progress" && row.token_hash.as_deref().is_some_and(|hash| same(hash, &sha256_hex(token))) => Outcome::Ok(row),
            _ => fail(FailureCode::Unauthenticated, "That job is not running, or the token is not its."),
        })
    }

    /// `runtime_auth`.
    pub async fn runtime_auth(&self, a: RuntimeAuthArgs) -> Result<Outcome<RuntimeJob>> {
        let job = check!(self.job_for_runtime(&a.job, &a.token).await?);
        let Some(run) = self.run_row(&job.run_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such run."));
        };
        Ok(Outcome::Ok(RuntimeJob { job: job.id, run: job.run_id, repo_id: job.repo_id, namespace: job.namespace, repository: run.repo }))
    }

    /// `oidc_claims`.
    pub async fn oidc_claims(&self, a: RuntimeAuthArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_runtime(&a.job, &a.token).await?);
        let Some(run) = self.run_row(&job.run_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such run."));
        };
        let Some(permitted) = self.oidc_permitted(&run, &job) else {
            return Ok(fail(FailureCode::Forbidden, "The workflow no longer reads."));
        };
        if !permitted.0 {
            return Ok(fail(
                FailureCode::Forbidden,
                "This job has no OIDC token: give it `permissions: id-token: write` (a run of a pull request from outside the repository never has one).",
            ));
        }
        let (repo, _) = match self.repo_by_id(&run.repo_id).await? {
            Some(found) => found,
            None => return Ok(fail(FailureCode::NotFound, "There is no such repository.")),
        };
        let info = run.info();
        let facts = ClaimFacts {
            info: &info,
            environment: permitted.1.as_deref(),
            job_workflow_path: &permitted.2,
            private: repo.is_private,
            owner_id: &repo.owner_id,
            self_hosted: job.runner_id.is_some(),
        };
        Ok(Outcome::Ok(claims(&facts)))
    }

    /// Whether a job may have an OIDC token, its environment, and the path
    /// of the workflow that defines it. A called workflow's job needs both
    /// its own permissions and its caller's to allow it, as on GitHub. A
    /// run that is not trusted (a pull request from outside) never may.
    /// `None` when the workflow no longer reads.
    fn oidc_permitted(&self, run: &RunRow, job: &JobRow) -> Option<(bool, Option<String>, String)> {
        let caller = g1t_actions::workflow::parse(&run.source).ok()?;
        let trusted = run.trusted != 0;
        match job.callee() {
            Some((called, spec, call)) => {
                let parent = call["parent"].as_str().unwrap_or_default();
                let caller_allows = caller.jobs.iter().find(|j| j.id == parent).is_none_or(|j| id_token_permitted(&caller.raw, &j.raw));
                let path = call["path"].as_str().unwrap_or(&run.path).to_owned();
                Some((trusted && caller_allows && id_token_permitted(&called.raw, &spec.raw), environment_name(&spec.raw), path))
            }
            None => {
                let spec = caller.jobs.iter().find(|j| j.id == job.key)?;
                Some((trusted && id_token_permitted(&caller.raw, &spec.raw), environment_name(&spec.raw), run.path.clone()))
            }
        }
    }

    /// Whether a job may have an OIDC token, for its spec.
    pub(crate) fn oidc_allowed(&self, run: &RunRow, job: &JobRow) -> bool {
        self.oidc_permitted(run, job).is_some_and(|p| p.0)
    }

    fn blob_signing_key(&self) -> Option<String> {
        self.blob_key.clone()
    }

    /// `blob_sign`.
    pub async fn blob_sign(&self, a: BlobSignArgs) -> Result<Outcome<String>> {
        let job = check!(self.job_for_credential(&a.job, &a.token).await?);
        let Some(key) = self.blob_signing_key() else {
            return Ok(fail(FailureCode::Invalid, "The toolkit's storage is not set up here: the actions service has no ACTIONS_KEY."));
        };
        let object = match a.kind.as_str() {
            "cache" => {
                #[derive(Deserialize)]
                struct Row {
                    object: String,
                }
                let row = self
                    .db
                    .prepare("UPDATE cache_entries SET upload = ? WHERE id = ? AND repo_id = ? AND status = 'pending' RETURNING object")
                    .bind(&[a.upload.as_str().into(), a.id.as_str().into(), job.repo_id.as_str().into()])?
                    .first::<Row>(None)
                    .await?;
                row.map(|r| r.object)
            }
            "artifact" => {
                #[derive(Deserialize)]
                struct Row {
                    object: String,
                }
                let id: f64 = a.id.parse().unwrap_or(-1.0);
                self.db
                    .prepare("SELECT object FROM artifacts WHERE id = ? AND run_id = ? AND status = 'pending'")
                    .bind(&[id.into(), job.run_id.as_str().into()])?
                    .first::<Row>(None)
                    .await?
                    .map(|r| r.object)
            }
            _ => None,
        };
        let Some(object) = object else {
            return Ok(fail(FailureCode::NotFound, "No upload of that is in progress."));
        };
        let claims = BlobClaims { k: a.kind, i: a.id, o: object, u: Some(a.upload), e: now_ms() / 1000 + UPLOAD_SECONDS };
        Ok(Outcome::Ok(sign_blob(&key, &claims)))
    }

    /// An upload token for an entry whose R2 upload has been started.
    pub(crate) fn upload_token(&self, kind: &str, id: &str, object: &str, upload: &str) -> Option<String> {
        let key = self.blob_signing_key()?;
        let claims = BlobClaims { k: kind.to_owned(), i: id.to_owned(), o: object.to_owned(), u: Some(upload.to_owned()), e: now_ms() / 1000 + UPLOAD_SECONDS };
        Some(sign_blob(&key, &claims))
    }

    /// A download token for an entry, good for `seconds`.
    pub(crate) fn download_token(&self, kind: &str, id: &str, object: &str, seconds: u64) -> Option<String> {
        let key = self.blob_signing_key()?;
        Some(sign_blob(&key, &BlobClaims { k: kind.to_owned(), i: id.to_owned(), o: object.to_owned(), u: None, e: now_ms() / 1000 + seconds }))
    }

    fn opened(&self, token: &str) -> Option<BlobClaims> {
        open_blob(&self.blob_signing_key()?, token, now_ms() / 1000)
    }

    /// `blob_open`.
    pub async fn blob_open(&self, a: BlobArgs) -> Result<Outcome<BlobGrant>> {
        let Some(claims) = self.opened(&a.blob) else {
            return Ok(fail(FailureCode::Unauthenticated, "That link has expired or is not one of g1t's."));
        };
        // A download needs its entry still there; an upload, still pending.
        let wanted = if claims.u.is_some() { "pending" } else { "ready" };
        let (exists, filename, content_type) = match claims.k.as_str() {
            "cache" => {
                let row = self
                    .db
                    .prepare("SELECT id FROM cache_entries WHERE id = ? AND object = ? AND status = ?")
                    .bind(&[claims.i.as_str().into(), claims.o.as_str().into(), wanted.into()])?
                    .first::<Value>(None)
                    .await?;
                (row.is_some(), None, Some("application/octet-stream".to_owned()))
            }
            _ => {
                #[derive(Deserialize)]
                struct Row {
                    name: String,
                    format: String,
                }
                let id: f64 = claims.i.parse().unwrap_or(-1.0);
                let row = self
                    .db
                    .prepare("SELECT name, format FROM artifacts WHERE id = ? AND object = ? AND status = ?")
                    .bind(&[id.into(), claims.o.as_str().into(), wanted.into()])?
                    .first::<Row>(None)
                    .await?;
                match row {
                    Some(row) => {
                        let (extension, kind) = if row.format == "tgz" { ("tar.gz", "application/gzip") } else { ("zip", "application/zip") };
                        (true, Some(format!("{}.{extension}", row.name)), Some(kind.to_owned()))
                    }
                    None => (false, None, None),
                }
            }
        };
        if !exists {
            return Ok(fail(FailureCode::NotFound, "That is gone: it expired, was deleted, or its upload finished."));
        }
        Ok(Outcome::Ok(BlobGrant { kind: claims.k, id: claims.i, object: claims.o, upload: claims.u, filename, content_type }))
    }

    /// `blob_part`.
    pub async fn blob_part(&self, a: BlobArgs) -> Result<Outcome<bool>> {
        let Some(BlobClaims { u: Some(upload), .. }) = self.opened(&a.blob) else {
            return Ok(fail(FailureCode::Unauthenticated, "That link has expired or is not an upload."));
        };
        self.db
            .prepare(
                "INSERT INTO blob_parts (upload, part, etag, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (upload, part) DO UPDATE SET etag = ?3, size = ?4, created_at = ?5",
            )
            .bind(&[upload.as_str().into(), f64::from(a.part).into(), a.etag.as_str().into(), (a.size as f64).into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// `blob_parts`.
    pub async fn blob_parts(&self, a: BlobArgs) -> Result<Outcome<Vec<BlobPart>>> {
        let Some(BlobClaims { u: Some(upload), .. }) = self.opened(&a.blob) else {
            return Ok(fail(FailureCode::Unauthenticated, "That link has expired or is not an upload."));
        };
        #[derive(Deserialize)]
        struct Row {
            part: f64,
            etag: String,
            size: f64,
        }
        let rows = self
            .db
            .prepare("SELECT part, etag, size FROM blob_parts WHERE upload = ? ORDER BY part")
            .bind(&[upload.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(Outcome::Ok(rows.into_iter().map(|r| BlobPart { part: r.part as u32, etag: r.etag, size: r.size as u64 }).collect()))
    }

    /// `blob_done`: the upload is complete at `size` bytes, as R2 measured
    /// it, which is the size its entry is committed at.
    pub async fn blob_done(&self, a: BlobArgs) -> Result<Outcome<bool>> {
        let Some(BlobClaims { k, i, u: Some(upload), .. }) = self.opened(&a.blob) else {
            return Ok(Outcome::Ok(false));
        };
        self.db.prepare("DELETE FROM blob_parts WHERE upload = ?").bind(&[upload.as_str().into()])?.run().await?;
        let size = (a.size as f64).into();
        if k == "cache" {
            self.db
                .prepare("UPDATE cache_entries SET size = ? WHERE id = ? AND status = 'pending'")
                .bind(&[size, i.as_str().into()])?
                .run()
                .await?;
        } else {
            self.db
                .prepare("UPDATE artifacts SET size = ? WHERE id = ? AND status = 'pending'")
                .bind(&[size, i.parse::<f64>().unwrap_or(-1.0).into()])?
                .run()
                .await?;
        }
        Ok(Outcome::Ok(true))
    }

    /// Hourly: parts of uploads abandoned long ago.
    pub(crate) async fn sweep_blob_parts(&self, now: u64) -> Result<()> {
        self.db
            .prepare("DELETE FROM blob_parts WHERE created_at < ?")
            .bind(&[rfc3339(now.saturating_sub(UPLOAD_SECONDS * 1000 * 2)).into()])?
            .run()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    #[test]
    fn a_runtime_token_is_a_jwt_the_toolkit_reads() {
        let token = runtime_token("job_1", "run_1", HASH, 1_700_000_000, 3600);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header = decode_json(parts[0]).unwrap();
        assert_eq!(header["alg"], "HS256");
        let claims = decode_json(parts[1]).unwrap();
        // @actions/artifact finds the run and job in the `Actions.Results`
        // scope: three parts split on `:`.
        let results = claims["scp"].as_str().unwrap().split(' ').find(|s| s.starts_with("Actions.Results:")).unwrap();
        assert_eq!(results.split(':').collect::<Vec<_>>(), ["Actions.Results", "run_1", "job_1"]);
        assert_eq!(runtime_job(&token).as_deref(), Some("job_1"));
        assert!(is_runtime(&token) && !is_runtime(HASH));
    }

    #[test]
    fn a_runtime_token_is_checked_against_its_job() {
        let token = runtime_token("job_1", "run_1", HASH, 1_700_000_000, 3600);
        assert!(runtime_valid(&token, "job_1", HASH, 1_700_000_100));
        // Another job, another job's key, too late.
        assert!(!runtime_valid(&token, "job_2", HASH, 1_700_000_100));
        assert!(!runtime_valid(&token, "job_1", &"0".repeat(64), 1_700_000_100));
        assert!(!runtime_valid(&token, "job_1", HASH, 1_700_003_601));
        // Claims changed without the key.
        let parts: Vec<&str> = token.split('.').collect();
        let forged = encode(json!({ "job": "job_1", "run": "run_9", "exp": 9_999_999_999u64 }).to_string().as_bytes());
        assert!(!runtime_valid(&format!("{}.{forged}.{}", parts[0], parts[2]), "job_1", HASH, 1_700_000_100));
        assert!(!runtime_valid("a.b", "job_1", HASH, 0));
    }

    #[test]
    fn blob_tokens_are_signed_and_expire() {
        let key = blob_key("00".repeat(32).as_str());
        let claims = BlobClaims { k: "artifact".into(), i: "12".into(), o: "a/repo_1/12".into(), u: Some("up".into()), e: 1_000 };
        let token = sign_blob(&key, &claims);
        assert_eq!(open_blob(&key, &token, 999), Some(claims));
        assert_eq!(open_blob(&key, &token, 1_000), None);
        assert_eq!(open_blob(&blob_key("11".repeat(32).as_str()), &token, 999), None);
        let (payload, _) = token.split_once('.').unwrap();
        assert_eq!(open_blob(&key, &format!("{payload}.AAAA"), 999), None);
    }

    #[test]
    fn id_token_needs_write_in_the_job_or_else_the_workflow() {
        let wf = |p: Value| json!({ "permissions": p });
        let none = json!({});
        assert!(!id_token_permitted(&none, &none));
        assert!(id_token_permitted(&wf(json!({ "id-token": "write", "contents": "read" })), &none));
        assert!(!id_token_permitted(&wf(json!({ "id-token": "read" })), &none));
        assert!(id_token_permitted(&wf(json!("write-all")), &none));
        assert!(!id_token_permitted(&wf(json!("read-all")), &none));
        // The job's own permissions replace the workflow's entirely.
        assert!(!id_token_permitted(&wf(json!({ "id-token": "write" })), &json!({ "permissions": { "contents": "read" } })));
        assert!(id_token_permitted(&wf(json!({})), &json!({ "permissions": { "id-token": "write" } })));
        assert!(!id_token_permitted(&none, &json!({ "permissions": {} })));
    }

    #[test]
    fn subjects_are_github_s() {
        assert_eq!(subject("acme/web", None, "push", "refs/heads/main"), "repo:acme/web:ref:refs/heads/main");
        assert_eq!(subject("acme/web", None, "push", "refs/tags/v1"), "repo:acme/web:ref:refs/tags/v1");
        assert_eq!(subject("acme/web", Some("prod"), "push", "refs/heads/main"), "repo:acme/web:environment:prod");
        assert_eq!(subject("acme/web", None, "pull_request", "refs/pull/3/merge"), "repo:acme/web:pull_request");
        assert_eq!(subject("acme/web", None, "pull_request_target", "refs/heads/main"), "repo:acme/web:pull_request");
        // An environment wins over a pull request, as on GitHub.
        assert_eq!(subject("acme/web", Some("preview"), "pull_request", "refs/pull/3/merge"), "repo:acme/web:environment:preview");
    }

    #[test]
    fn environments_are_named_plainly_or_not_at_all() {
        assert_eq!(environment_name(&json!({ "environment": "production" })).as_deref(), Some("production"));
        assert_eq!(environment_name(&json!({ "environment": { "name": "staging", "url": "x" } })).as_deref(), Some("staging"));
        assert_eq!(environment_name(&json!({ "environment": "${{ inputs.env }}" })), None);
        assert_eq!(environment_name(&json!({})), None);
    }

    #[test]
    fn claims_carry_what_trust_policies_read() {
        let info = RunInfo {
            repository: "acme/web".into(),
            repository_id: "repo_1".into(),
            default_branch: "main".into(),
            event_name: "push".into(),
            git_ref: "refs/heads/main".into(),
            sha: "abc".into(),
            actor: "ada".into(),
            actor_id: "usr_1".into(),
            run_id: "run_1".into(),
            run_number: 7,
            run_attempt: 2,
            workflow: "Deploy".into(),
            workflow_path: ".g1t/workflows/deploy.yml".into(),
            ..RunInfo::default()
        };
        let facts = ClaimFacts {
            info: &info,
            environment: Some("production"),
            job_workflow_path: ".g1t/workflows/release.yml",
            private: true,
            owner_id: "ws_1",
            self_hosted: false,
        };
        let c = claims(&facts);
        assert_eq!(c["sub"], "repo:acme/web:environment:production");
        assert_eq!(c["environment"], "production");
        assert_eq!(c["repository_owner"], "acme");
        assert_eq!(c["repository_owner_id"], "ws_1");
        assert_eq!(c["repository_visibility"], "private");
        assert_eq!(c["run_number"], "7");
        assert_eq!(c["run_attempt"], "2");
        assert_eq!(c["workflow_ref"], "acme/web/.g1t/workflows/deploy.yml@refs/heads/main");
        assert_eq!(c["job_workflow_ref"], "acme/web/.g1t/workflows/release.yml@refs/heads/main");
        assert_eq!(c["ref_type"], "branch");
        assert_eq!(c["ref_protected"], "true");
        assert_eq!(c["runner_environment"], "github-hosted");
        for absent in ["iss", "aud", "exp", "iat", "jti"] {
            assert!(c.get(absent).is_none(), "{absent} is the API's to add");
        }
    }
}
