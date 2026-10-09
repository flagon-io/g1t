//! Artifacts and the cache of GitHub Actions jobs, as g1t's own runner
//! reaches them. (Actions built on GitHub's toolkit reach the same entries
//! through toolkit.rs.)
//!
//! Artifacts are kept in R2 (ACTIONS_CACHE, under `a/`), uploaded in
//! parts; the actions service lists them and decides names, sizes and how
//! long each is kept (services/actions/src/artifacts.rs). Artifacts older
//! runners kept in Workers KV are still listed and found there until KV
//! expires them. Cache entries are kept in R2 too, up to 2 GB each,
//! uploaded in parts; the actions service decides what is found, what
//! fits and what is evicted (services/actions/src/cache.rs).
//!
//! A sandbox reaches these with its job's token:
//!
//! - `GET /actions/jobs/{job}/artifacts[?run_id=]`: its run's (or another run's)
//! - `POST .../artifacts/uploads?name=&size=&retention_days=&overwrite=&format=`:
//!   `{ id, upload, part_bytes, retention_days, expires_at }`
//! - `PUT .../artifacts/uploads/{id}/{part}?upload=`, `POST …/complete` with
//!   `{ size, parts, digest }`, `DELETE .../artifacts/uploads/{id}?upload=`
//! - `GET .../artifacts/{id}/download[?run_id=]`, `DELETE .../artifacts/{id}`
//! - `PUT|GET .../artifacts/{name}`: a whole artifact by name (older runners)
//! - `GET .../cache?key=&restore=`: the entry, streamed, its key in `x-g1t-key`
//! - `POST .../cache/uploads?key=&size=`: `{ id, upload, part_bytes }`
//! - `PUT .../cache/uploads/{id}/{part}?upload=`: one part, `{ part, etag }`
//! - `POST .../cache/uploads/{id}/complete?upload=` with `{ size, parts }`
//! - `DELETE .../cache/uploads/{id}?upload=`: gives the upload up
//! - `PUT .../cache?key=`: a whole entry of at most 60 MB at once (older runners)
//!
//! People download an artifact through the REST API (artifacts.rs), or by
//! name at `/repos/{owner}/{repo}/actions/runs/{run}/artifacts/{name}`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::kv::KvStore;
use worker::{Bucket, Env, Request, Response, Result, UploadedPart, Url};

use g1t_contracts::actions::{
    ARTIFACT_PART_BYTES, Artifact, ArtifactArgs, ArtifactBlob, ArtifactCommitArgs, ArtifactReservation, ArtifactReserveArgs, CACHE_PART_BYTES,
    CacheAbortArgs, CacheCommitArgs, CacheCommitted, CacheHit, CacheLookupArgs, CacheReservation, CacheReserveArgs, JobArtifactsArgs,
};
use g1t_contracts::{FailureCode, Outcome};

use crate::operations::Services;

/// The largest artifact or cache entry an older runner sends at once,
/// held in a Worker's memory.
const MAX_BYTES: usize = 60 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Meta {
    size: usize,
    chunks: usize,
    /// Milliseconds since the epoch, to find the newest cache entry.
    at: u64,
    /// The name or key it was saved under.
    name: String,
}

/// Artifacts older runners kept in KV expire 14 days after they were made,
/// and none has been made there since artifacts moved to R2 on 2026-10-08:
/// from 2026-10-22T00:00Z every one is gone, and KV is not asked (a list is
/// the dearest thing KV does). Delete the KV artifact code after that date,
/// with its twin in apps/web/app/lib/artifacts.server.ts.
const LEGACY_KV_UNTIL_MS: u64 = 1_792_627_200_000;

/// Whether artifacts kept in KV may still be there at `now`.
fn legacy_kv(now: u64) -> bool {
    now < LEGACY_KV_UNTIL_MS
}

fn store(env: &Env) -> Result<KvStore> {
    env.kv("BLOBS")
}

async fn get(kv: &KvStore, base: &str) -> Result<Option<Vec<u8>>> {
    let Some(meta) = kv.get(base).json::<Meta>().await? else { return Ok(None) };
    let mut out = Vec::with_capacity(meta.size);
    for index in 0..meta.chunks {
        match kv.get(&format!("{base}#{index}")).bytes().await? {
            Some(bytes) => out.extend_from_slice(&bytes),
            // A chunk that expired first: the whole entry is gone.
            None => return Ok(None),
        }
    }
    Ok(Some(out))
}

/// The metadata of every entry under a prefix, newest first.
async fn list(kv: &KvStore, prefix: &str) -> Result<Vec<(String, Meta)>> {
    let mut found = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut listing = kv.list().prefix(prefix.to_owned());
        if let Some(cursor) = cursor.take() {
            listing = listing.cursor(cursor);
        }
        let page = listing.execute().await?;
        for key in page.keys {
            if key.name.contains('#') {
                continue;
            }
            if let Some(meta) = key.metadata.and_then(|m| serde_json::from_value::<Meta>(m).ok()) {
                found.push((key.name, meta));
            }
        }
        if page.list_complete || page.cursor.is_none() {
            break;
        }
        cursor = page.cursor;
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.1.at));
    Ok(found)
}

fn error(status: u16, message: &str) -> Result<Response> {
    Ok(crate::reply(&json!({ "error": { "message": message } }))?.with_status(status))
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query(request: &Request, name: &str) -> Option<String> {
    let url = request.url().ok()?;
    url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
}

/// A sandbox storing or fetching an artifact or cache entry. `rest` is
/// the path after `/actions/jobs/`.
pub async fn for_job(request: Request, env: &Env, services: &Services, method: &str, rest: &str) -> Result<Response> {
    let (job, what) = rest.split_once('/').unwrap_or((rest, ""));
    let token = request
        .headers()
        .get("authorization")?
        .and_then(|h| h.strip_prefix("Bearer ").map(str::to_owned))
        .unwrap_or_default();
    let owner: Outcome<Value> = g1t_kit::call(&services.actions, "job_auth", &json!({ "job": job, "token": token })).await?;
    let owner = match owner {
        Outcome::Ok(owner) => owner,
        Outcome::Fail(_) => return error(401, "That job is not running, or the token is not its."),
    };
    let run = owner["run"].as_str().unwrap_or_default().to_owned();
    let repo = owner["repoId"].as_str().unwrap_or_default().to_owned();
    let kv = store(env)?;
    match (method, what) {
        (_, what) if what == "artifacts" || what.starts_with("artifacts/") => {
            let bucket = env.bucket("ACTIONS_CACHE")?;
            artifacts(request, &kv, &bucket, services, method, job, &token, &run, &repo, what).await
        }
        (_, what) if what == "cache" || what.starts_with("cache/") => {
            let bucket = env.bucket("ACTIONS_CACHE")?;
            cache(request, &bucket, services, method, job, &token, &repo, what).await
        }
        _ => error(404, "No such endpoint."),
    }
}

/// A part's number and the etag R2 gave it.
#[derive(Deserialize)]
struct Part {
    part: u16,
    etag: String,
}

#[derive(Deserialize)]
struct Complete {
    size: u64,
    parts: Vec<Part>,
}

/// An outcome of the actions service, or its failure as the reply it means.
fn refused<T>(outcome: Outcome<T>) -> std::result::Result<T, Result<Response>> {
    match outcome {
        Outcome::Ok(value) => Ok(value),
        Outcome::Fail(failure) => {
            let status = match failure.code {
                FailureCode::Unauthenticated => 401,
                FailureCode::NotFound => 404,
                FailureCode::Conflict => 409,
                FailureCode::Forbidden => 403,
                _ => 400,
            };
            Err(error(status, &failure.message))
        }
    }
}

/// The cache: restoring, uploading in parts, and the older whole upload.
#[allow(clippy::too_many_arguments)]
async fn cache(
    mut request: Request,
    bucket: &Bucket,
    services: &Services,
    method: &str,
    job: &str,
    token: &str,
    repo: &str,
    what: &str,
) -> Result<Response> {
    let parts: Vec<&str> = what.split('/').collect();
    let upload_id = query(&request, "upload").unwrap_or_default();
    // The hash of the entry's paths and compression; runners from before
    // it was sent send none.
    let version = query(&request, "version").unwrap_or_default();
    match (method, parts.as_slice()) {
        ("GET", ["cache"]) => {
            let key = query(&request, "key").unwrap_or_default();
            let restore: Vec<String> =
                query(&request, "restore").unwrap_or_default().lines().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect();
            let found: Outcome<Option<CacheHit>> = g1t_kit::call(
                &services.actions,
                "cache_lookup",
                &CacheLookupArgs { job: job.to_owned(), token: token.to_owned(), key: key.clone(), restore, version: Some(version.clone()).filter(|v| !v.is_empty()) },
            )
            .await?;
            let found = match refused(found) {
                Ok(found) => found,
                Err(reply) => return reply,
            };
            if let Some(hit) = found
                && let Some(object) = bucket.get(&hit.object).execute().await?
                && let Some(body) = object.body()
            {
                let mut response = Response::from_body(body.response_body()?)?;
                let headers = response.headers_mut();
                headers.set("x-g1t-key", &hit.key)?;
                headers.set("content-length", &object.size().to_string())?;
                headers.set("content-type", "application/octet-stream")?;
                return Ok(response);
            }
            // Entries kept in KV before the cache moved to R2 had no scope,
            // so they are never restored.
            error(404, "Nothing cached under those keys.")
        }
        // Older runners send a whole entry of at most 60 MB at once.
        ("PUT", ["cache"]) => {
            let key = query(&request, "key").unwrap_or_default();
            let bytes = request.bytes().await?;
            if bytes.len() > MAX_BYTES {
                return error(413, "An entry sent at once is at most 60 MB; newer runners upload it in parts.");
            }
            let reserved: Outcome<CacheReservation> = g1t_kit::call(
                &services.actions,
                "cache_reserve",
                &CacheReserveArgs { job: job.to_owned(), token: token.to_owned(), key, size: bytes.len() as u64, version: Some(version.clone()).filter(|v| !v.is_empty()) },
            )
            .await?;
            let reserved = match reserved {
                Outcome::Fail(failure) if failure.code == FailureCode::Conflict => {
                    return crate::reply(&json!({ "saved": false, "reason": failure.message }));
                }
                other => match refused(other) {
                    Ok(reserved) => reserved,
                    Err(reply) => return reply,
                },
            };
            let size = bytes.len() as u64;
            bucket.put(&reserved.object, bytes).execute().await?;
            commit(bucket, services, job, token, &reserved.id, size).await?;
            crate::reply(&json!({ "saved": true }))
        }
        ("POST", ["cache", "uploads"]) => {
            let key = query(&request, "key").unwrap_or_default();
            let size = query(&request, "size").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let reserved: Outcome<CacheReservation> = g1t_kit::call(
                &services.actions,
                "cache_reserve",
                &CacheReserveArgs { job: job.to_owned(), token: token.to_owned(), key, size, version: Some(version.clone()).filter(|v| !v.is_empty()) },
            )
            .await?;
            let reserved = match refused(reserved) {
                Ok(reserved) => reserved,
                Err(reply) => return reply,
            };
            let upload = bucket.create_multipart_upload(&reserved.object).execute().await?;
            crate::reply(&json!({ "id": reserved.id, "upload": upload.upload_id().await, "part_bytes": CACHE_PART_BYTES }))
        }
        ("PUT", ["cache", "uploads", id, part]) => {
            let part = part.parse::<u16>().unwrap_or(0);
            if part == 0 || upload_id.is_empty() {
                return error(400, "A part is numbered from 1, and names its upload.");
            }
            let length = request.headers().get("content-length")?.and_then(|l| l.parse::<u64>().ok()).unwrap_or(0);
            if length == 0 || length > CACHE_PART_BYTES {
                return error(413, &format!("A part is 1 to {} MB, with its length.", CACHE_PART_BYTES / 1_048_576));
            }
            // The body goes to R2 as it comes, never held whole here.
            let Some(body) = request.inner().body() else { return error(400, "The part is empty.") };
            let upload = bucket.resume_multipart_upload(object_of(repo, id), &upload_id)?;
            let uploaded = upload.upload_part(part, body).await?;
            crate::reply(&json!({ "part": uploaded.part_number(), "etag": uploaded.etag() }))
        }
        ("POST", ["cache", "uploads", id, "complete"]) => {
            let done: Complete = match request.json().await {
                Ok(done) => done,
                Err(_) => return error(400, "Send { size, parts: [{ part, etag }] }."),
            };
            let upload = bucket.resume_multipart_upload(object_of(repo, id), &upload_id)?;
            let mut parts = done.parts;
            parts.sort_by_key(|p| p.part);
            if let Err(problem) = upload.complete(parts.into_iter().map(|p| UploadedPart::new(p.part, p.etag))).await {
                let _ = abort(services, job, token, id).await;
                return error(400, &format!("The upload could not be completed: {problem}"));
            }
            commit(bucket, services, job, token, id, done.size).await?;
            crate::reply(&json!({ "saved": true }))
        }
        ("DELETE", ["cache", "uploads", id]) => {
            if let Ok(upload) = bucket.resume_multipart_upload(object_of(repo, id), &upload_id) {
                let _ = upload.abort().await;
            }
            abort(services, job, token, id).await?;
            crate::reply(&json!({ "aborted": true }))
        }
        _ => error(404, "No such endpoint."),
    }
}

/// Where an entry is in R2: under its repository, by its id, as the
/// actions service named it when it was reserved.
fn object_of(repo: &str, id: &str) -> String {
    format!("c/{repo}/{id}")
}

/// Where an artifact is in R2, as the actions service names it.
fn artifact_object(repo: &str, id: u64) -> String {
    format!("a/{repo}/{id}")
}

/// An artifact as a job's runner lists it.
fn for_runner(artifact: &Artifact) -> Value {
    json!({
        "id": artifact.id,
        "name": artifact.name,
        "size": artifact.size,
        "digest": artifact.digest,
        "format": artifact.format,
        "created_at": artifact.created_at,
        "expires_at": artifact.expires_at,
    })
}

/// An R2 object streamed back, with what it is.
async fn stream(bucket: &Bucket, object: &str, format: &str) -> Result<Response> {
    let Some(found) = bucket.get(object).execute().await? else { return error(404, "That artifact is gone: it expired or was deleted.") };
    let size = found.size();
    let Some(body) = found.body() else { return error(404, "That artifact is gone: it expired or was deleted.") };
    let mut response = Response::from_body(body.response_body()?)?;
    let headers = response.headers_mut();
    headers.set("content-length", &size.to_string())?;
    headers.set("content-type", if format == "tgz" { "application/gzip" } else { "application/zip" })?;
    headers.set("x-g1t-format", format)?;
    Ok(response)
}

/// A job's artifacts: listing its run's (or another run's of its
/// repository), uploading in parts, downloading, deleting; and the whole
/// uploads and downloads by name of older runners.
#[allow(clippy::too_many_arguments)]
async fn artifacts(
    mut request: Request,
    kv: &KvStore,
    bucket: &Bucket,
    services: &Services,
    method: &str,
    job: &str,
    token: &str,
    run: &str,
    repo: &str,
    what: &str,
) -> Result<Response> {
    let parts: Vec<&str> = what.split('/').collect();
    let upload_id = query(&request, "upload").unwrap_or_default();
    let credential = |id: Option<u64>, name: Option<String>, run_id: Option<String>| JobArtifactsArgs {
        job: job.to_owned(),
        token: token.to_owned(),
        run_id,
        name,
        id,
    };
    let actions = &services.actions;
    match (method, parts.as_slice()) {
        ("GET", ["artifacts"]) => {
            let run_id = query(&request, "run_id").filter(|r| !r.is_empty());
            let found: Outcome<Vec<Artifact>> = g1t_kit::call(actions, "job_artifacts", &credential(None, None, run_id.clone())).await?;
            match refused(found) {
                Ok(found) => {
                    let mut listed: Vec<Value> = found.iter().map(for_runner).collect();
                    // Artifacts older runners kept in KV, for the days they
                    // are still there.
                    let legacy_run = run_id.as_deref().unwrap_or(run);
                    if legacy_kv(g1t_kit::now_ms()) {
                        for (_, meta) in list(kv, &format!("a/{legacy_run}/")).await? {
                            if !listed.iter().any(|a| a["name"] == meta.name.as_str()) {
                                listed.push(json!({ "name": meta.name, "size": meta.size, "format": "tgz" }));
                            }
                        }
                    }
                    crate::reply(&listed)
                }
                Err(reply) => reply,
            }
        }
        ("POST", ["artifacts", "uploads"]) => {
            let flag = |name: &str| query(&request, name).is_some_and(|v| v == "true");
            let args = ArtifactReserveArgs {
                job: job.to_owned(),
                token: token.to_owned(),
                name: query(&request, "name").unwrap_or_default(),
                size: query(&request, "size").and_then(|s| s.parse().ok()).unwrap_or(0),
                retention_days: query(&request, "retention_days").and_then(|d| d.parse().ok()).unwrap_or(0),
                expires_at: None,
                overwrite: flag("overwrite"),
                format: query(&request, "format"),
            };
            let reserved: Outcome<ArtifactReservation> = g1t_kit::call(actions, "artifact_reserve", &args).await?;
            let reserved = match refused(reserved) {
                Ok(reserved) => reserved,
                Err(reply) => return reply,
            };
            let upload = bucket.create_multipart_upload(&reserved.object).execute().await?;
            crate::reply(&json!({
                "id": reserved.id,
                "upload": upload.upload_id().await,
                "part_bytes": ARTIFACT_PART_BYTES,
                "retention_days": reserved.retention_days,
                "expires_at": reserved.expires_at,
            }))
        }
        ("PUT", ["artifacts", "uploads", id, part]) => {
            let (Ok(id), Ok(part)) = (id.parse::<u64>(), part.parse::<u16>()) else {
                return error(400, "A part is numbered from 1, of an artifact named by its number.");
            };
            if part == 0 || upload_id.is_empty() {
                return error(400, "A part is numbered from 1, and names its upload.");
            }
            let length = request.headers().get("content-length")?.and_then(|l| l.parse::<u64>().ok()).unwrap_or(0);
            if length == 0 || length > ARTIFACT_PART_BYTES {
                return error(413, &format!("A part is 1 to {} MB, with its length.", ARTIFACT_PART_BYTES / 1_048_576));
            }
            let Some(body) = request.inner().body() else { return error(400, "The part is empty.") };
            let upload = bucket.resume_multipart_upload(artifact_object(repo, id), &upload_id)?;
            let uploaded = upload.upload_part(part, body).await?;
            crate::reply(&json!({ "part": uploaded.part_number(), "etag": uploaded.etag() }))
        }
        ("POST", ["artifacts", "uploads", id, "complete"]) => {
            let Ok(id) = id.parse::<u64>() else { return error(404, "No such upload.") };
            let done: Value = request.json().await.unwrap_or(Value::Null);
            let mut parts: Vec<Part> = serde_json::from_value(done["parts"].clone()).unwrap_or_default();
            if parts.is_empty() {
                return error(400, "Send { size, parts: [{ part, etag }], digest }.");
            }
            parts.sort_by_key(|p| p.part);
            let upload = bucket.resume_multipart_upload(artifact_object(repo, id), &upload_id)?;
            let object = match upload.complete(parts.into_iter().map(|p| UploadedPart::new(p.part, p.etag))).await {
                Ok(object) => object,
                Err(problem) => {
                    let _: Outcome<bool> = g1t_kit::call(actions, "artifact_abort", &credential(Some(id), None, None)).await?;
                    return error(400, &format!("The upload could not be completed: {problem}"));
                }
            };
            let args = ArtifactCommitArgs {
                job: job.to_owned(),
                token: token.to_owned(),
                id: Some(id),
                name: None,
                // What R2 holds, not what the runner says.
                size: object.size(),
                digest: done["digest"].as_str().map(str::to_owned),
            };
            let committed: Outcome<Artifact> = g1t_kit::call(actions, "artifact_commit", &args).await?;
            match refused(committed) {
                Ok(artifact) => crate::reply(&for_runner(&artifact)),
                Err(reply) => reply,
            }
        }
        ("DELETE", ["artifacts", "uploads", id]) => {
            let Ok(id) = id.parse::<u64>() else { return error(404, "No such upload.") };
            if let Ok(upload) = bucket.resume_multipart_upload(artifact_object(repo, id), &upload_id) {
                let _ = upload.abort().await;
            }
            let _: Outcome<bool> = g1t_kit::call(actions, "artifact_abort", &credential(Some(id), None, None)).await?;
            crate::reply(&json!({ "aborted": true }))
        }
        ("GET", ["artifacts", id, "download"]) => {
            let Ok(id) = id.parse::<u64>() else { return error(404, "No such artifact.") };
            // Any run of the job's repository: the service checks.
            let found: Outcome<ArtifactBlob> = g1t_kit::call(actions, "job_artifact", &credential(Some(id), None, query(&request, "run_id"))).await?;
            match found {
                Outcome::Ok(found) => stream(bucket, &found.object, &found.artifact.format).await,
                Outcome::Fail(failure) => error(failure.code.http_status(), &failure.message),
            }
        }
        ("DELETE", ["artifacts", id]) => {
            let Ok(id) = id.parse::<u64>() else { return error(404, "No such artifact.") };
            let done: Outcome<Artifact> = g1t_kit::call(actions, "job_delete_artifact", &credential(Some(id), None, None)).await?;
            match refused(done) {
                Ok(artifact) => crate::reply(&for_runner(&artifact)),
                Err(reply) => reply,
            }
        }
        // Older runners: a whole artifact of at most 60 MB, by name.
        ("PUT", ["artifacts", name]) => {
            let name = decode(name);
            let bytes = request.bytes().await?;
            if bytes.len() > MAX_BYTES {
                return error(413, "An artifact sent at once is at most 60 MB; newer runners upload it in parts.");
            }
            let args = ArtifactReserveArgs {
                job: job.to_owned(),
                token: token.to_owned(),
                name: name.clone(),
                size: bytes.len() as u64,
                format: Some("tgz".to_owned()),
                ..ArtifactReserveArgs::default()
            };
            let reserved: Outcome<ArtifactReservation> = g1t_kit::call(actions, "artifact_reserve", &args).await?;
            let reserved = match refused(reserved) {
                Ok(reserved) => reserved,
                Err(reply) => return reply,
            };
            let size = bytes.len() as u64;
            bucket.put(&reserved.object, bytes).execute().await?;
            let args = ArtifactCommitArgs { job: job.to_owned(), token: token.to_owned(), id: Some(reserved.id), name: None, size, digest: None };
            let committed: Outcome<Artifact> = g1t_kit::call(actions, "artifact_commit", &args).await?;
            match refused(committed) {
                Ok(_) => crate::reply(&json!({ "name": name, "size": size })),
                Err(reply) => reply,
            }
        }
        ("GET", ["artifacts", name]) => {
            let name = decode(name);
            let found: Outcome<ArtifactBlob> = g1t_kit::call(actions, "job_artifact", &credential(None, Some(name.clone()), None)).await?;
            match found {
                Outcome::Ok(found) => stream(bucket, &found.object, &found.artifact.format).await,
                // One an older runner kept in KV.
                Outcome::Fail(_) if legacy_kv(g1t_kit::now_ms()) => match get(kv, &format!("a/{run}/{name}")).await? {
                    Some(bytes) => Response::from_bytes(bytes),
                    None => error(404, "No such artifact."),
                },
                Outcome::Fail(_) => error(404, "No such artifact."),
            }
        }
        _ => error(404, "No such endpoint."),
    }
}

/// Marks an uploaded entry ready, and deletes what that evicted.
async fn commit(bucket: &Bucket, services: &Services, job: &str, token: &str, id: &str, size: u64) -> Result<()> {
    let committed: Outcome<CacheCommitted> = g1t_kit::call(
        &services.actions,
        "cache_commit",
        &CacheCommitArgs { job: job.to_owned(), token: token.to_owned(), id: id.to_owned(), size },
    )
    .await?;
    if let Outcome::Ok(committed) = committed
        && !committed.evicted.is_empty()
    {
        bucket.delete_multiple(committed.evicted.iter().map(String::as_str).collect()).await?;
    }
    Ok(())
}

async fn abort(services: &Services, job: &str, token: &str, id: &str) -> Result<()> {
    let _: Outcome<bool> = g1t_kit::call(
        &services.actions,
        "cache_abort",
        &CacheAbortArgs { job: job.to_owned(), token: token.to_owned(), id: id.to_owned() },
    )
    .await?;
    Ok(())
}

/// An entry saved in KV before the cache moved to R2, by key or restore key.
/// Someone who can see the run downloading one of its artifacts.
pub async fn download(env: &Env, services: &Services, viewer: &g1t_contracts::Viewer, owner: &str, repo: &str, run: &str, name: &str) -> Result<Response> {
    let seen: Outcome<Value> = g1t_kit::call(
        &services.actions,
        "run",
        &json!({ "repo": { "namespace": owner, "name": repo }, "viewer": viewer, "id": run }),
    )
    .await?;
    if let Outcome::Fail(refused) = seen {
        let status = if refused.code == FailureCode::NotFound { 404 } else { 403 };
        return error(status, &refused.message);
    }
    let name = decode(name);
    // Kept in R2: a redirect to a link signed for a few minutes.
    let args = ArtifactArgs {
        repo: g1t_contracts::repos::RepoPath { namespace: owner.to_owned(), name: repo.to_owned() },
        viewer: viewer.clone(),
        id: None,
        run: Some(run.to_owned()),
        name: Some(name.clone()),
    };
    let found: Outcome<ArtifactBlob> = g1t_kit::call(&services.actions, "artifact_download", &args).await?;
    if let Outcome::Ok(found) = found
        && !found.blob.is_empty()
    {
        return Response::redirect_with_status(Url::parse(&crate::artifacts::blob_url(&services.addresses.api, &found.blob))?, 302);
    }
    // Kept in KV by an older runner.
    if !legacy_kv(g1t_kit::now_ms()) {
        return error(404, "No such artifact, or it has expired.");
    }
    match get(&store(env)?, &format!("a/{run}/{name}")).await? {
        Some(bytes) => {
            let mut response = Response::from_bytes(bytes)?;
            let headers = response.headers_mut();
            headers.set("content-type", "application/gzip")?;
            headers.set("content-disposition", &format!("attachment; filename=\"{}.tar.gz\"", name.replace('"', "")))?;
            Ok(response)
        }
        None => error(404, "No such artifact, or it has expired."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kv_artifacts_are_not_asked_for_after_they_have_all_expired() {
        assert_eq!(g1t_contracts::time::rfc3339(LEGACY_KV_UNTIL_MS), "2026-10-22T00:00:00.000Z");
        assert!(legacy_kv(LEGACY_KV_UNTIL_MS - 1));
        assert!(!legacy_kv(LEGACY_KV_UNTIL_MS));
    }
}
