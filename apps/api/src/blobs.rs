//! Artifacts and the cache of GitHub Actions jobs.
//!
//! Artifacts are kept in Workers KV in chunks, with KV's own expiry: 14
//! days with their run. Cache entries are kept in R2 (ACTIONS_CACHE), up
//! to 2 GB each, uploaded in parts; the actions service lists them and
//! decides what is found, what fits and what is evicted
//! (services/actions/src/cache.rs). Entries saved in KV before the cache
//! moved are still found there until they expire.
//!
//! A sandbox reaches these with its job's token:
//!
//! - `GET /actions/jobs/{job}/artifacts`, `PUT|GET .../artifacts/{name}`
//! - `GET .../cache?key=&restore=`: the entry, streamed, its key in `x-g1t-key`
//! - `POST .../cache/uploads?key=&size=`: `{ id, upload, part_bytes }`
//! - `PUT .../cache/uploads/{id}/{part}?upload=`: one part, `{ part, etag }`
//! - `POST .../cache/uploads/{id}/complete?upload=` with `{ size, parts }`
//! - `DELETE .../cache/uploads/{id}?upload=`: gives the upload up
//! - `PUT .../cache?key=`: a whole entry of at most 60 MB at once (older runners)
//!
//! People download an artifact at
//! `/repos/{owner}/{repo}/actions/runs/{run}/artifacts/{name}`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::kv::KvStore;
use worker::{Bucket, Env, Request, Response, Result, UploadedPart};

use g1t_contracts::actions::{
    CACHE_PART_BYTES, CacheAbortArgs, CacheCommitArgs, CacheCommitted, CacheHit, CacheLookupArgs, CacheReservation, CacheReserveArgs,
};
use g1t_contracts::{FailureCode, Outcome};

use crate::operations::Services;

/// KV's largest value is 25 MiB; chunks stay under it.
const CHUNK: usize = 20 * 1024 * 1024;
/// The largest artifact or cache entry, kept within a Worker's memory.
const MAX_BYTES: usize = 60 * 1024 * 1024;
const ARTIFACT_TTL: u64 = 14 * 24 * 60 * 60;

#[derive(Serialize, Deserialize)]
struct Meta {
    size: usize,
    chunks: usize,
    /// Milliseconds since the epoch, to find the newest cache entry.
    at: u64,
    /// The name or key it was saved under.
    name: String,
}

fn store(env: &Env) -> Result<KvStore> {
    env.kv("BLOBS")
}

async fn put(kv: &KvStore, base: &str, name: &str, bytes: &[u8], ttl: u64) -> Result<()> {
    let chunks: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(CHUNK).collect() };
    for (index, chunk) in chunks.iter().enumerate() {
        kv.put_bytes(&format!("{base}#{index}"), chunk)?.expiration_ttl(ttl).execute().await?;
    }
    let meta = Meta { size: bytes.len(), chunks: chunks.len(), at: g1t_kit::now_ms(), name: name.to_owned() };
    // The metadata travels with the key in listings, so the newest entry
    // can be found without reading each.
    kv.put(base, serde_json::to_string(&meta)?)?
        .metadata(&meta)?
        .expiration_ttl(ttl)
        .execute()
        .await?;
    Ok(())
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

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
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
pub async fn for_job(mut request: Request, env: &Env, services: &Services, method: &str, rest: &str) -> Result<Response> {
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
        ("GET", "artifacts") => {
            let listed: Vec<Value> = list(&kv, &format!("a/{run}/"))
                .await?
                .into_iter()
                .map(|(_, meta)| json!({ "name": meta.name, "size": meta.size }))
                .collect();
            crate::reply(&listed)
        }
        (_, what) if what.starts_with("artifacts/") => {
            let name = decode(&what["artifacts/".len()..]);
            if !valid_name(&name) {
                return error(400, "That is not an artifact name.");
            }
            let base = format!("a/{run}/{name}");
            if method == "PUT" {
                let bytes = request.bytes().await?;
                if bytes.len() > MAX_BYTES {
                    return error(413, "Artifacts are at most 60 MB.");
                }
                put(&kv, &base, &name, &bytes, ARTIFACT_TTL).await?;
                return crate::reply(&json!({ "name": name, "size": bytes.len() }));
            }
            match get(&kv, &base).await? {
                Some(bytes) => Response::from_bytes(bytes),
                None => error(404, "No such artifact."),
            }
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
                &CacheLookupArgs { job: job.to_owned(), token: token.to_owned(), key: key.clone(), restore, version: version.clone() },
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
                &CacheReserveArgs { job: job.to_owned(), token: token.to_owned(), key, size: bytes.len() as u64, version: version.clone() },
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
                &CacheReserveArgs { job: job.to_owned(), token: token.to_owned(), key, size, version: version.clone() },
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

/// A run's artifacts, for its page.
pub async fn of_run(env: &Env, run: &str) -> Result<Vec<Value>> {
    Ok(list(&store(env)?, &format!("a/{run}/"))
        .await?
        .into_iter()
        .map(|(_, meta)| json!({ "name": meta.name, "size": meta.size, "at": meta.at }))
        .collect())
}
