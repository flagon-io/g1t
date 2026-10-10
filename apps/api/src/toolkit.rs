//! The services GitHub's Actions toolkit calls from inside a job, so that
//! actions built on `@actions/cache` and `@actions/artifact` (such as
//! `actions/setup-node` with `cache:`, or `Swatinem/rust-cache`) work on
//! g1t unchanged. A job is told where they are in its variables
//! (`ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL`,
//! `ACTIONS_CACHE_SERVICE_V2`; see `runtime_variables`).
//!
//! - Twirp, at `/twirp/github.actions.results.api.v1.CacheService/…` and
//!   `…ArtifactService/…`: the cache's newer protocol (`CreateCacheEntry`,
//!   `FinalizeCacheEntryUpload`, `GetCacheEntryDownloadURL`) and the
//!   artifacts' (`CreateArtifact`, `FinalizeArtifact`, `ListArtifacts`,
//!   `GetSignedArtifactURL`, `DeleteArtifact`). JSON, the toolkit's field
//!   names; the cache's methods also in protobuf (`application/protobuf`),
//!   which other clients of the protocol send (sccache, through OpenDAL).
//! - The cache's older protocol, at `{ACTIONS_CACHE_URL}_apis/artifactcache/…`,
//!   which the toolkit's client uses whenever the server it runs against is
//!   not github.com: on g1t, that is the one it uses, and sccache's too.
//!   Its entries are sent in 32 MB chunks, or in one chunk of any size.
//! - Blobs, at `/actions/toolkit/blobs/{token}`: the signed links those
//!   hand out. Downloads are a GET, of the whole blob or of one byte range
//!   (`Range`), as the toolkit's client fetches large entries in segments.
//!   Uploads speak the part of Azure Blob Storage's protocol the toolkit's
//!   client uses (Put Blob, Put Block, Put Block List), mapped onto an R2
//!   multipart upload: a block's id ends in its index, which is its part's
//!   number. An upload link carries a query, as an Azure SAS link does,
//!   which clients that sign their requests with it need.
//!
//! Every call carries the job's runtime token; the actions service checks
//! it and keeps the entries (cache.rs, run_artifacts.rs, runtime.rs there).

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use g1t_contracts::actions::{
    ARTIFACT_MAX_BYTES, Artifact, ArtifactBlob, ArtifactCommitArgs, ArtifactReservation, ArtifactReserveArgs, BlobArgs, BlobGrant, BlobPart,
    BlobSignArgs, CACHE_MAX_ENTRY_BYTES, CACHE_PART_BYTES, CacheCommitArgs, CacheCommitted, CacheHit, CacheLookupArgs, CacheReservation,
    CacheReserveArgs, CacheUploadArgs, JobArtifactsArgs,
};
use g1t_contracts::{Failure, FailureCode, Outcome};
use serde_json::{Map, Value, json};
use worker::{Bucket, Env, Request, Response, Result, UploadedPart};

use crate::run_artifacts::blob_url;
use crate::operations::Services;

/// The Twirp services, by name.
pub const CACHE_SERVICE: &str = "github.actions.results.api.v1.CacheService";
pub const ARTIFACT_SERVICE: &str = "github.actions.results.api.v1.ArtifactService";
/// Where the cache's older protocol is: `ACTIONS_CACHE_URL`.
pub const CACHE_PATH: &str = "/actions/toolkit/";
/// The largest single block or blob a request may carry.
const MAX_BLOCK_BYTES: u64 = 256 * 1024 * 1024;

/// The bearer token of a request.
pub fn bearer(request: &Request) -> String {
    request
        .headers()
        .get("authorization")
        .ok()
        .flatten()
        .and_then(|h| h.split_once(' ').map(|(_, t)| t.trim().to_owned()))
        .unwrap_or_default()
}

fn claims(token: &str) -> Option<Value> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?).ok()
}

/// The job a runtime token names, unchecked: the actions service checks it.
pub fn runtime_job(token: &str) -> Option<String> {
    claims(token)?["job"].as_str().map(str::to_owned)
}

/// The variables a job gets for the toolkit: its runtime token and where
/// the services are, and where to ask for an OIDC token when it may.
pub fn runtime_variables(api: &str, token: &str, id_token: bool) -> Map<String, Value> {
    let mut vars = Map::new();
    let mut set = |k: &str, v: String| {
        vars.insert(k.to_owned(), Value::String(v));
    };
    set("ACTIONS_RUNTIME_TOKEN", token.to_owned());
    set("ACTIONS_RESULTS_URL", format!("{api}/"));
    set("ACTIONS_CACHE_URL", format!("{api}{CACHE_PATH}"));
    set("ACTIONS_CACHE_SERVICE_V2", "True".to_owned());
    if id_token {
        set("ACTIONS_ID_TOKEN_REQUEST_URL", format!("{}/token?api-version=2.0", crate::oidc::issuer(api)));
        set("ACTIONS_ID_TOKEN_REQUEST_TOKEN", token.to_owned());
    }
    vars
}

// ── Twirp ───────────────────────────────────────────────────────────────────

/// Twirp's binary encoding.
const PROTOBUF: &str = "application/protobuf";

/// Whether a request's `Content-Type` is Twirp's protobuf encoding.
fn is_protobuf(content_type: &str) -> bool {
    let kind = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    kind == PROTOBUF || kind == "application/x-protobuf"
}

/// The cache service's messages in protobuf, read into and written from the
/// JSON the handlers use (`results/api/v1/cache.proto`, field numbers as
/// there). Only what the cache's three methods carry: strings, a repeated
/// string, an int64 and a bool. `metadata` (field 1 of each request) is
/// skipped: the runtime token says whose cache it is.
mod proto {
    use serde_json::{Map, Value};

    #[derive(Clone, Copy)]
    enum Kind {
        Text,
        Texts,
        Int,
        Bool,
    }

    /// A message's fields: number, JSON name, kind.
    type Fields = &'static [(u64, &'static str, Kind)];

    fn request_fields(method: &str) -> Option<Fields> {
        Some(match method {
            "CreateCacheEntry" => &[(2, "key", Kind::Text), (3, "version", Kind::Text)],
            "FinalizeCacheEntryUpload" => &[(2, "key", Kind::Text), (3, "size_bytes", Kind::Int), (4, "version", Kind::Text)],
            "GetCacheEntryDownloadURL" => &[(2, "key", Kind::Text), (3, "restore_keys", Kind::Texts), (4, "version", Kind::Text)],
            _ => return None,
        })
    }

    fn response_fields(method: &str) -> Fields {
        match method {
            "CreateCacheEntry" => &[(1, "ok", Kind::Bool), (2, "signed_upload_url", Kind::Text), (3, "message", Kind::Text)],
            "FinalizeCacheEntryUpload" => &[(1, "ok", Kind::Bool), (2, "entry_id", Kind::Int), (3, "message", Kind::Text)],
            "GetCacheEntryDownloadURL" => &[(1, "ok", Kind::Bool), (2, "signed_download_url", Kind::Text), (3, "matched_key", Kind::Text)],
            _ => &[],
        }
    }

    fn varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *bytes.get(*at)?;
            *at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    fn put_varint(out: &mut Vec<u8>, mut value: u64) {
        while value >= 0x80 {
            out.push((value as u8 & 0x7f) | 0x80);
            value >>= 7;
        }
        out.push(value as u8);
    }

    /// A request of `method` as JSON, or None when it is not one.
    pub fn request(method: &str, bytes: &[u8]) -> Option<Value> {
        let fields = request_fields(method)?;
        let mut out = Map::new();
        let mut at = 0;
        while at < bytes.len() {
            let tag = varint(bytes, &mut at)?;
            let (number, wire) = (tag >> 3, tag & 7);
            let known = fields.iter().find(|(n, _, _)| *n == number);
            match wire {
                0 => {
                    let value = varint(bytes, &mut at)?;
                    if let Some((_, name, Kind::Int)) = known {
                        // An int64 is sent as its two's complement.
                        out.insert((*name).to_owned(), Value::String((value as i64).to_string()));
                    }
                }
                2 => {
                    let length = usize::try_from(varint(bytes, &mut at)?).ok()?;
                    let end = at.checked_add(length).filter(|end| *end <= bytes.len())?;
                    let raw = &bytes[at..end];
                    at = end;
                    match known {
                        Some((_, name, Kind::Text)) => {
                            out.insert((*name).to_owned(), Value::String(String::from_utf8(raw.to_vec()).ok()?));
                        }
                        Some((_, name, Kind::Texts)) => {
                            let text = Value::String(String::from_utf8(raw.to_vec()).ok()?);
                            match out.entry((*name).to_owned()).or_insert_with(|| Value::Array(Vec::new())) {
                                Value::Array(list) => list.push(text),
                                _ => return None,
                            }
                        }
                        _ => {}
                    }
                }
                1 => at = at.checked_add(8).filter(|end| *end <= bytes.len())?,
                5 => at = at.checked_add(4).filter(|end| *end <= bytes.len())?,
                _ => return None,
            }
        }
        Some(Value::Object(out))
    }

    /// A response of `method` from its JSON. Defaults are left out, as
    /// proto3 does.
    pub fn response(method: &str, value: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        for (number, name, kind) in response_fields(method) {
            let field = &value[*name];
            match kind {
                Kind::Bool if field.as_bool() == Some(true) => {
                    put_varint(&mut out, number << 3);
                    put_varint(&mut out, 1);
                }
                Kind::Int => {
                    let n = field.as_i64().or_else(|| field.as_str().and_then(|s| s.parse().ok())).unwrap_or(0);
                    if n != 0 {
                        put_varint(&mut out, number << 3);
                        put_varint(&mut out, n as u64);
                    }
                }
                Kind::Text => {
                    let text = field.as_str().unwrap_or_default();
                    if !text.is_empty() {
                        put_varint(&mut out, (number << 3) | 2);
                        put_varint(&mut out, text.len() as u64);
                        out.extend_from_slice(text.as_bytes());
                    }
                }
                _ => {}
            }
        }
        out
    }
}

/// A Twirp error: its code and message, at the status Twirp gives it.
fn twirp_error(code: &str, message: &str) -> Result<Response> {
    let status = match code {
        "unauthenticated" => 401,
        "permission_denied" => 403,
        "not_found" => 404,
        "already_exists" => 409,
        "invalid_argument" | "malformed" => 400,
        "bad_route" => 404,
        "failed_precondition" => 412,
        "resource_exhausted" => 429,
        _ => 500,
    };
    Ok(Response::from_json(&json!({ "code": code, "msg": message }))?.with_status(status))
}

fn twirp_failure(failure: &Failure) -> Result<Response> {
    let code = match failure.code {
        FailureCode::Unauthenticated => "unauthenticated",
        FailureCode::Forbidden => "permission_denied",
        FailureCode::NotFound => "not_found",
        FailureCode::Conflict => "already_exists",
        FailureCode::Invalid => "invalid_argument",
        _ => "failed_precondition",
    };
    twirp_error(code, &failure.message)
}

/// A field in the toolkit's spelling (`snake_case`), or its JSON name.
fn field<'a>(body: &'a Value, name: &str) -> &'a Value {
    if !body[name].is_null() {
        return &body[name];
    }
    let camel: String = name.split('_').enumerate().map(|(i, p)| if i == 0 { p.to_owned() } else { p[..1].to_uppercase() + &p[1..] }).collect();
    &body[camel]
}

fn text(body: &Value, name: &str) -> String {
    match field(body, name) {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        // A wrapper written as an object, `{ "value": … }`.
        Value::Object(o) => o.get("value").map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).unwrap_or_default(),
        _ => String::new(),
    }
}

fn number(body: &Value, name: &str) -> Option<u64> {
    text(body, name).trim().parse().ok()
}

/// The run and job a runtime token names, which a request's backend ids
/// must match.
fn backend_ids(token: &str) -> (String, String) {
    let c = claims(token).unwrap_or_default();
    (c["run"].as_str().unwrap_or_default().to_owned(), c["job"].as_str().unwrap_or_default().to_owned())
}

/// What the toolkit's artifact client lists.
fn listed(artifact: &Artifact) -> Value {
    json!({
        "workflow_run_backend_id": artifact.run_id,
        "workflow_job_run_backend_id": artifact.job_id,
        "database_id": artifact.id.to_string(),
        "name": artifact.name,
        "size": artifact.size.to_string(),
        "created_at": artifact.created_at,
        "digest": artifact.digest,
    })
}

/// The Azure Storage version g1t's blob links answer as.
const AZURE_VERSION: &str = "2024-11-04";

/// An upload link: the blob's, with a query as an Azure SAS link has one.
/// A client that treats it as a container, a blob and a SAS token (OpenDAL,
/// which sccache uses) refuses a link without one; the token in the path
/// is what g1t checks.
pub fn upload_url(api: &str, blob: &str) -> String {
    format!("{}?sv={AZURE_VERSION}", blob_url(api, blob))
}

/// Starts an R2 upload for an entry the service reserved, and the signed
/// link the toolkit sends it to.
async fn start_upload(bucket: &Bucket, services: &Services, job: &str, token: &str, kind: &str, id: &str, object: &str) -> Result<Outcome<String>> {
    let upload = bucket.create_multipart_upload(object).execute().await?;
    let upload = upload.upload_id().await;
    let signed: Outcome<String> = g1t_kit::call(
        &services.actions,
        "blob_sign",
        &BlobSignArgs { job: job.to_owned(), token: token.to_owned(), kind: kind.to_owned(), id: id.to_owned(), upload },
    )
    .await?;
    Ok(match signed {
        Outcome::Ok(blob) => Outcome::Ok(upload_url(&services.addresses.api, &blob)),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    })
}

/// `POST /twirp/{service}/{method}`. A failure inside is logged and
/// answered as Twirp's `internal`, with its cause.
pub async fn twirp(request: Request, env: &Env, services: &Services, service: &str, method: &str) -> Result<Response> {
    match twirp_inner(request, env, services, service, method).await {
        Ok(response) => Ok(response),
        Err(error) => twirp_error("internal", &failed(&format!("POST /twirp/{service}/{method}"), &error)),
    }
}

async fn twirp_inner(mut request: Request, env: &Env, services: &Services, service: &str, method: &str) -> Result<Response> {
    let token = bearer(&request);
    let Some(job) = runtime_job(&token) else {
        return twirp_error("unauthenticated", "Send the job's ACTIONS_RUNTIME_TOKEN as a bearer token.");
    };
    // Twirp clients send JSON or protobuf, and are answered in kind.
    let binary = is_protobuf(&request.headers().get("content-type")?.unwrap_or_default());
    let body: Value = if binary {
        match proto::request(method, &request.bytes().await.unwrap_or_default()) {
            Some(body) => body,
            None => return twirp_error("malformed", "That is not a protobuf message this method takes."),
        }
    } else {
        request.json().await.unwrap_or(Value::Null)
    };
    let answer = |value: Value| -> Result<Response> {
        if binary {
            let mut response = Response::from_bytes(proto::response(method, &value))?;
            response.headers_mut().set("content-type", PROTOBUF)?;
            Ok(response)
        } else {
            Response::from_json(&value)
        }
    };
    let bucket = env.bucket("ACTIONS_CACHE")?;
    let actions = &services.actions;
    let (run, own_job) = backend_ids(&token);
    // An artifact call names its run, and for an upload its job: the
    // token's.
    if service == ARTIFACT_SERVICE {
        let asked_run = text(&body, "workflow_run_backend_id");
        if !asked_run.is_empty() && asked_run != run {
            return twirp_error("permission_denied", "The runtime token is for another run.");
        }
        let asked_job = text(&body, "workflow_job_run_backend_id");
        if matches!(method, "CreateArtifact" | "FinalizeArtifact") && !asked_job.is_empty() && asked_job != own_job {
            return twirp_error("permission_denied", "The runtime token is for another job.");
        }
    }
    match (service, method) {
        (CACHE_SERVICE, "GetCacheEntryDownloadURL") => {
            let restore: Vec<String> = field(&body, "restore_keys").as_array().map(|k| k.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            let args = CacheLookupArgs { job, token, key: text(&body, "key"), restore, version: Some(text(&body, "version")) };
            let found: Outcome<Option<CacheHit>> = g1t_kit::call(actions, "cache_lookup", &args).await?;
            match found {
                Outcome::Ok(Some(CacheHit { key, blob: Some(blob), .. })) => {
                    answer(json!({ "ok": true, "signed_download_url": blob_url(&services.addresses.api, &blob), "matched_key": key }))
                }
                Outcome::Ok(_) => answer(json!({ "ok": false, "signed_download_url": "", "matched_key": "" })),
                Outcome::Fail(refused) => twirp_failure(&refused),
            }
        }
        (CACHE_SERVICE, "CreateCacheEntry") => {
            let args = CacheReserveArgs { job: job.clone(), token: token.clone(), key: text(&body, "key"), size: 0, version: Some(text(&body, "version")) };
            let reserved: Outcome<CacheReservation> = g1t_kit::call(actions, "cache_reserve", &args).await?;
            let reserved = match reserved {
                Outcome::Ok(reserved) => reserved,
                // A key already saved, or being saved by another job, to a
                // protobuf client (OpenDAL's) is Twirp's `already_exists`
                // (409), which it takes as "someone else has it": sccache
                // then still writes. An `ok: false` would read as a broken
                // cache, and sccache would only read from it.
                Outcome::Fail(refused) if binary && refused.code == FailureCode::Conflict => return twirp_failure(&refused),
                // The toolkit's client logs this ("another job may be
                // creating this cache") and goes on.
                Outcome::Fail(refused) => return answer(json!({ "ok": false, "signed_upload_url": "", "message": refused.message })),
            };
            match start_upload(&bucket, services, &job, &token, "cache", &reserved.id, &reserved.object).await? {
                Outcome::Ok(url) => answer(json!({ "ok": true, "signed_upload_url": url })),
                Outcome::Fail(refused) => answer(json!({ "ok": false, "signed_upload_url": "", "message": refused.message })),
            }
        }
        (CACHE_SERVICE, "FinalizeCacheEntryUpload") => {
            let args = CacheUploadArgs { job: job.clone(), token: token.clone(), number: None, key: Some(text(&body, "key")), version: Some(text(&body, "version")) };
            let pending: Outcome<CacheReservation> = g1t_kit::call(actions, "cache_upload", &args).await?;
            let pending = match pending {
                Outcome::Ok(pending) => pending,
                Outcome::Fail(refused) => return answer(json!({ "ok": false, "entry_id": "0", "message": refused.message })),
            };
            let Some(object) = bucket.head(&pending.object).await? else {
                return answer(json!({ "ok": false, "entry_id": "0", "message": "Nothing was uploaded for that entry." }));
            };
            match commit_cache(&bucket, services, &job, &token, &pending.id, object.size()).await? {
                Outcome::Ok(()) => answer(json!({ "ok": true, "entry_id": pending.number.to_string() })),
                Outcome::Fail(refused) => answer(json!({ "ok": false, "entry_id": "0", "message": refused.message })),
            }
        }
        (ARTIFACT_SERVICE, "CreateArtifact") => {
            let expires_at = Some(text(&body, "expires_at")).filter(|e| !e.is_empty());
            let args = ArtifactReserveArgs { job: job.clone(), token: token.clone(), name: text(&body, "name"), expires_at, ..ArtifactReserveArgs::default() };
            let reserved: Outcome<ArtifactReservation> = g1t_kit::call(actions, "artifact_reserve", &args).await?;
            let reserved = match reserved {
                Outcome::Ok(reserved) => reserved,
                Outcome::Fail(refused) => return twirp_failure(&refused),
            };
            match start_upload(&bucket, services, &job, &token, "artifact", &reserved.id.to_string(), &reserved.object).await? {
                Outcome::Ok(url) => Response::from_json(&json!({ "ok": true, "signed_upload_url": url })),
                Outcome::Fail(refused) => twirp_failure(&refused),
            }
        }
        (ARTIFACT_SERVICE, "FinalizeArtifact") => {
            let digest = Some(text(&body, "hash")).filter(|h| !h.is_empty());
            // The size it was measured at as it was stored, not the one it
            // says.
            let args = ArtifactCommitArgs { job, token, id: None, name: Some(text(&body, "name")), size: 0, digest };
            let done: Outcome<Artifact> = g1t_kit::call(actions, "artifact_commit", &args).await?;
            match done {
                Outcome::Ok(artifact) => Response::from_json(&json!({ "ok": true, "artifact_id": artifact.id.to_string() })),
                Outcome::Fail(refused) => twirp_failure(&refused),
            }
        }
        (ARTIFACT_SERVICE, "ListArtifacts") => {
            let name = Some(text(&body, "name_filter")).filter(|n| !n.is_empty());
            let id = number(&body, "id_filter");
            let args = JobArtifactsArgs { job, token, run_id: None, name, id };
            let found: Outcome<Vec<Artifact>> = g1t_kit::call(actions, "job_artifacts", &args).await?;
            match found {
                Outcome::Ok(found) => Response::from_json(&json!({ "artifacts": found.iter().map(listed).collect::<Vec<_>>() })),
                Outcome::Fail(refused) => twirp_failure(&refused),
            }
        }
        (ARTIFACT_SERVICE, "GetSignedArtifactURL") => {
            let args = JobArtifactsArgs { job, token, run_id: None, name: Some(text(&body, "name")), id: None };
            let found: Outcome<ArtifactBlob> = g1t_kit::call(actions, "job_artifact", &args).await?;
            match found {
                Outcome::Ok(found) if !found.blob.is_empty() => Response::from_json(&json!({ "signed_url": blob_url(&services.addresses.api, &found.blob) })),
                Outcome::Ok(_) => twirp_error("failed_precondition", "Download links are not set up on this installation."),
                Outcome::Fail(refused) => twirp_failure(&refused),
            }
        }
        (ARTIFACT_SERVICE, "DeleteArtifact") => {
            let args = JobArtifactsArgs { job, token, run_id: None, name: Some(text(&body, "name")), id: None };
            let done: Outcome<Artifact> = g1t_kit::call(actions, "job_delete_artifact", &args).await?;
            match done {
                Outcome::Ok(artifact) => Response::from_json(&json!({ "ok": true, "artifact_id": artifact.id.to_string() })),
                Outcome::Fail(refused) => twirp_failure(&refused),
            }
        }
        _ => twirp_error("bad_route", &format!("No method {method} on {service}.")),
    }
}

/// Marks an uploaded cache entry ready, and deletes what that evicted.
async fn commit_cache(bucket: &Bucket, services: &Services, job: &str, token: &str, id: &str, size: u64) -> Result<Outcome<()>> {
    let committed: Outcome<CacheCommitted> = g1t_kit::call(
        &services.actions,
        "cache_commit",
        &CacheCommitArgs { job: job.to_owned(), token: token.to_owned(), id: id.to_owned(), size },
    )
    .await?;
    Ok(match committed {
        Outcome::Ok(committed) => {
            if !committed.evicted.is_empty() {
                bucket.delete_multiple(committed.evicted.iter().map(String::as_str).collect()).await?;
            }
            Outcome::Ok(())
        }
        Outcome::Fail(refused) => Outcome::Fail(refused),
    })
}

// ── The cache's older protocol ──────────────────────────────────────────────

fn plain_error(status: u16, message: &str) -> Result<Response> {
    Ok(Response::from_json(&json!({ "message": message, "error": { "message": message } }))?.with_status(status))
}

fn query(request: &Request, name: &str) -> Option<String> {
    query_in(&request.url().ok()?, name)
}

fn query_in(url: &worker::Url, name: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// The part a chunk of the older protocol is, from its `Content-Range`:
/// chunks are `CACHE_PART_BYTES` apart, as the toolkit sends them. A first
/// chunk may be larger, up to `MAX_BLOCK_BYTES`: a client that sends an
/// entry in one request (sccache does) sends a single chunk from 0.
pub fn chunk_part(range: &str) -> Option<(u16, u64)> {
    let range = range.trim().strip_prefix("bytes ")?;
    let (span, _) = range.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    let (start, end): (u64, u64) = (start.trim().parse().ok()?, end.trim().parse().ok()?);
    if end < start {
        return None;
    }
    let length = end - start + 1;
    if start == 0 && length <= MAX_BLOCK_BYTES {
        return Some((1, length));
    }
    if start % CACHE_PART_BYTES != 0 || length > CACHE_PART_BYTES {
        return None;
    }
    Some(((start / CACHE_PART_BYTES + 1) as u16, length))
}

/// The bytes a download's `Range` header asks for, out of `size`: first and
/// last, inclusive. None to send the whole blob (no header, or one this
/// does not read, such as several ranges); `Some(None)` when the range is
/// past the end (416).
pub fn byte_range(header: &str, size: u64) -> Option<Option<(u64, u64)>> {
    let spec = header.trim().strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let (first, last) = (first.trim(), last.trim());
    let range = if first.is_empty() {
        // The last `n` bytes.
        let n: u64 = last.parse().ok()?;
        if n == 0 || size == 0 {
            return Some(None);
        }
        (size.saturating_sub(n), size - 1)
    } else {
        let first: u64 = first.parse().ok()?;
        let last: u64 = if last.is_empty() { u64::MAX } else { last.parse().ok()? };
        if last < first {
            return None;
        }
        if first >= size {
            return Some(None);
        }
        (first, last.min(size - 1))
    };
    Some(Some(range))
}

/// What a lookup of the older protocol answers: 200 with the entry, 204
/// for a miss (which the toolkit's client and sccache read as "not
/// cached"), or the refusal's status.
pub fn lookup_answer(found: Outcome<Option<CacheHit>>, version: &str, api: &str) -> (u16, Option<Value>) {
    match found {
        Outcome::Ok(Some(CacheHit { key, blob: Some(blob), created_at, .. })) => (
            200,
            Some(json!({
                "cacheKey": key,
                "cacheVersion": version,
                "scope": "",
                "creationTime": created_at,
                "archiveLocation": blob_url(api, &blob),
            })),
        ),
        // No entry, or one without a download link (no ACTIONS_KEY): a miss.
        Outcome::Ok(_) => (204, None),
        Outcome::Fail(refused) => (refused.code.http_status(), Some(json!({ "message": refused.message, "error": { "message": refused.message } }))),
    }
}

/// Logs a toolkit request that failed inside g1t, and says what to tell
/// its client: the cause, so a job's log shows more than a bare 500.
fn failed(route: &str, error: &worker::Error) -> String {
    worker::console_error!("toolkit: {route} failed: {error}");
    format!("g1t could not answer this: {error}")
}

/// `{ACTIONS_CACHE_URL}_apis/artifactcache/…`. `rest` is the path after it.
/// A failure inside is logged and answered as a 500 with its cause.
pub async fn cache_v1(request: Request, env: &Env, services: &Services, method: &str, rest: &str) -> Result<Response> {
    match cache_v1_inner(request, env, services, method, rest).await {
        Ok(response) => Ok(response),
        Err(error) => plain_error(500, &failed(&format!("{method} {CACHE_PATH}_apis/artifactcache/{rest}"), &error)),
    }
}

async fn cache_v1_inner(mut request: Request, env: &Env, services: &Services, method: &str, rest: &str) -> Result<Response> {
    let token = bearer(&request);
    let Some(job) = runtime_job(&token) else {
        return plain_error(401, "Send the job's ACTIONS_RUNTIME_TOKEN as a bearer token.");
    };
    let bucket = env.bucket("ACTIONS_CACHE")?;
    let actions = &services.actions;
    let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    match (method, parts.as_slice()) {
        ("GET", ["cache"]) => {
            let keys: Vec<String> = query(&request, "keys").unwrap_or_default().split(',').map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()).collect();
            let Some((key, restore)) = keys.split_first() else {
                return plain_error(400, "Give keys.");
            };
            let version = query(&request, "version").unwrap_or_default();
            let args = CacheLookupArgs { job, token, key: key.clone(), restore: restore.to_vec(), version: Some(version.clone()) };
            let found: Outcome<Option<CacheHit>> = g1t_kit::call(actions, "cache_lookup", &args).await?;
            match lookup_answer(found, &version, &services.addresses.api) {
                (status, Some(body)) => Ok(Response::from_json(&body)?.with_status(status)),
                (status, None) => Ok(Response::empty()?.with_status(status)),
            }
        }
        ("POST", ["caches"]) => {
            let body: Value = request.json().await.unwrap_or(Value::Null);
            let size = body["cacheSize"].as_u64().unwrap_or(0);
            let key = body["key"].as_str().unwrap_or_default().to_owned();
            let version = body["version"].as_str().unwrap_or_default().to_owned();
            let args = CacheReserveArgs { job: job.clone(), token: token.clone(), key, size, version: Some(version) };
            let reserved: Outcome<CacheReservation> = g1t_kit::call(actions, "cache_reserve", &args).await?;
            let reserved = match reserved {
                Outcome::Ok(reserved) => reserved,
                Outcome::Fail(refused) => return plain_error(refused.code.http_status(), &refused.message),
            };
            match start_upload(&bucket, services, &job, &token, "cache", &reserved.id, &reserved.object).await? {
                Outcome::Ok(_) => Ok(Response::from_json(&json!({ "cacheId": reserved.number }))?.with_status(201)),
                Outcome::Fail(refused) => plain_error(refused.code.http_status(), &refused.message),
            }
        }
        (_, ["caches", number]) => {
            let Ok(number) = number.parse::<u64>() else {
                return plain_error(404, "No such cache entry.");
            };
            let args = CacheUploadArgs { job: job.clone(), token: token.clone(), number: Some(number), key: None, version: None };
            let pending: Outcome<CacheReservation> = g1t_kit::call(actions, "cache_upload", &args).await?;
            let pending = match pending {
                Outcome::Ok(pending) => pending,
                Outcome::Fail(refused) => return plain_error(refused.code.http_status(), &refused.message),
            };
            let (Some(blob), Some(upload_id)) = (pending.blob.clone(), pending.upload.clone()) else {
                return plain_error(409, "That entry's upload was not started.");
            };
            match method {
                "PATCH" => {
                    let range = request.headers().get("content-range")?.unwrap_or_default();
                    let Some((part, length)) = chunk_part(&range) else {
                        return plain_error(400, &format!("Send the entry in chunks of {} MB, each with its Content-Range.", CACHE_PART_BYTES / 1_048_576));
                    };
                    let Some(body) = request.inner().body() else { return plain_error(400, "The chunk is empty.") };
                    let upload = bucket.resume_multipart_upload(&pending.object, &upload_id)?;
                    let uploaded = upload.upload_part(part, body).await?;
                    let recorded = BlobArgs { blob, part: u32::from(part), etag: uploaded.etag(), size: length };
                    let _: Outcome<bool> = g1t_kit::call(actions, "blob_part", &recorded).await?;
                    Ok(Response::empty()?.with_status(204))
                }
                "POST" => {
                    let parts: Outcome<Vec<BlobPart>> = g1t_kit::call(actions, "blob_parts", &BlobArgs { blob: blob.clone(), ..BlobArgs::default() }).await?;
                    let parts = match parts {
                        Outcome::Ok(parts) => parts,
                        Outcome::Fail(refused) => return plain_error(refused.code.http_status(), &refused.message),
                    };
                    let size = match finish(&bucket, &pending.object, &upload_id, &parts).await {
                        Ok(size) => size,
                        Err(problem) => return plain_error(400, &format!("The entry could not be completed: {problem}")),
                    };
                    let _: Outcome<bool> = g1t_kit::call(actions, "blob_done", &BlobArgs { blob, size, ..BlobArgs::default() }).await?;
                    match commit_cache(&bucket, services, &job, &token, &pending.id, size).await? {
                        Outcome::Ok(()) => Ok(Response::empty()?.with_status(204)),
                        Outcome::Fail(refused) => plain_error(refused.code.http_status(), &refused.message),
                    }
                }
                _ => plain_error(405, "PATCH a chunk, or POST to commit."),
            }
        }
        _ => plain_error(404, "No such endpoint."),
    }
}

/// Completes an R2 upload from its recorded parts, in order; the size it
/// came to. An upload with no parts is an empty object.
async fn finish(bucket: &Bucket, object: &str, upload_id: &str, parts: &[BlobPart]) -> std::result::Result<u64, String> {
    let upload = bucket.resume_multipart_upload(object, upload_id).map_err(|e| e.to_string())?;
    if parts.is_empty() {
        let _ = upload.abort().await;
        bucket.put(object, Vec::<u8>::new()).execute().await.map_err(|e| e.to_string())?;
        return Ok(0);
    }
    let done = upload
        .complete(parts.iter().map(|p| UploadedPart::new(p.part as u16, p.etag.clone())))
        .await
        .map_err(|e| e.to_string())?;
    Ok(done.size())
}

// ── Blobs ───────────────────────────────────────────────────────────────────

/// A block's index, from its id: the toolkit's client (Azure's SDK) makes
/// block ids as base64 of a prefix and the index padded with zeros.
pub fn block_index(id: &str) -> Option<u32> {
    let decoded = STANDARD.decode(id.trim()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let digits: String = text.chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// The block ids of a Put Block List body, in order.
pub fn block_list(xml: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = xml;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let Some(close) = rest.find('>') else { break };
        let tag = &rest[..close];
        rest = &rest[close + 1..];
        if matches!(tag, "Latest" | "Committed" | "Uncommitted") {
            let Some(end) = rest.find("</") else { break };
            ids.push(rest[..end].trim().to_owned());
            rest = &rest[end..];
        }
    }
    ids
}

/// The parts a block list names, as recorded: each block must have been
/// sent, as the part its index says, and they must run from the first.
pub fn parts_for(ids: &[String], recorded: &[BlobPart]) -> std::result::Result<Vec<BlobPart>, String> {
    let mut out = Vec::with_capacity(ids.len());
    for (position, id) in ids.iter().enumerate() {
        let index = block_index(id).ok_or_else(|| format!("The block id {id} does not end in its index."))?;
        let part = index + 1;
        if part as usize != position + 1 {
            return Err("The blocks must be listed in the order they were numbered.".to_owned());
        }
        let found = recorded.iter().find(|p| p.part == part).ok_or_else(|| format!("Block {id} was never sent."))?;
        out.push(found.clone());
    }
    Ok(out)
}

fn azure(status: u16) -> Result<Response> {
    let mut response = Response::empty()?.with_status(status);
    let headers = response.headers_mut();
    headers.set("x-ms-request-id", &g1t_contracts::new_id("req", g1t_kit::now_ms()))?;
    headers.set("x-ms-version", "2024-11-04")?;
    headers.set("x-ms-request-server-encrypted", "true")?;
    Ok(response)
}

fn azure_error(status: u16, code: &str, message: &str) -> Result<Response> {
    let body = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?><Error><Code>{code}</Code><Message>{message}</Message></Error>");
    let mut response = Response::ok(body)?.with_status(status);
    response.headers_mut().set("content-type", "application/xml")?;
    response.headers_mut().set("x-ms-error-code", code)?;
    Ok(response)
}

/// `/actions/toolkit/blobs/{token}`: GET or HEAD a download, PUT an upload.
/// A failure inside is logged and answered as Azure's `InternalError`.
pub async fn blob(request: Request, env: &Env, services: &Services, method: &str, token: &str) -> Result<Response> {
    match blob_inner(request, env, services, method, token).await {
        Ok(response) => Ok(response),
        // The token is a credential: the route is logged without it.
        Err(error) => azure_error(500, "InternalError", &failed(&format!("{method} /actions/toolkit/blobs/…"), &error)),
    }
}

async fn blob_inner(mut request: Request, env: &Env, services: &Services, method: &str, token: &str) -> Result<Response> {
    let opened: Outcome<BlobGrant> = g1t_kit::call(&services.actions, "blob_open", &BlobArgs { blob: token.to_owned(), ..BlobArgs::default() }).await?;
    let grant = match opened {
        Outcome::Ok(grant) => grant,
        Outcome::Fail(refused) => {
            let status = if refused.code == FailureCode::NotFound { 404 } else { 403 };
            return azure_error(status, if status == 404 { "BlobNotFound" } else { "AuthenticationFailed" }, &refused.message);
        }
    };
    let bucket = env.bucket("ACTIONS_CACHE")?;
    match (method, grant.upload.as_deref()) {
        ("GET" | "HEAD", None) => {
            let headers = |response: &mut Response, size: u64| -> Result<()> {
                let headers = response.headers_mut();
                headers.set("content-length", &size.to_string())?;
                headers.set("content-type", grant.content_type.as_deref().unwrap_or("application/octet-stream"))?;
                headers.set("x-ms-blob-type", "BlockBlob")?;
                headers.set("accept-ranges", "bytes")?;
                if let Some(name) = &grant.filename {
                    headers.set("content-disposition", &format!("attachment; filename=\"{}\"", name.replace('"', "")))?;
                }
                Ok(())
            };
            if method == "HEAD" {
                let Some(object) = bucket.head(&grant.object).await? else { return azure_error(404, "BlobNotFound", "It is gone.") };
                let mut response = Response::empty()?;
                headers(&mut response, object.size())?;
                return Ok(response);
            }
            // One byte range (`Range`, or Azure's `x-ms-range`): the
            // toolkit's client fetches a large entry in segments, side by
            // side, and writes each where its range says.
            let asked = match request.headers().get("x-ms-range")? {
                Some(range) => Some(range),
                None => request.headers().get("range")?,
            };
            if let Some(asked) = asked.filter(|r| !r.trim().is_empty()) {
                let Some(object) = bucket.head(&grant.object).await? else { return azure_error(404, "BlobNotFound", "It is gone.") };
                let size = object.size();
                match byte_range(&asked, size) {
                    Some(Some((first, last))) => {
                        let length = last - first + 1;
                        let Some(object) = bucket.get(&grant.object).range(worker::Range::OffsetWithLength { offset: first, length }).execute().await? else {
                            return azure_error(404, "BlobNotFound", "It is gone.");
                        };
                        let Some(body) = object.body() else { return azure_error(404, "BlobNotFound", "It is gone.") };
                        let mut response = Response::from_body(body.response_body()?)?.with_status(206);
                        headers(&mut response, length)?;
                        response.headers_mut().set("content-range", &format!("bytes {first}-{last}/{size}"))?;
                        return Ok(response);
                    }
                    Some(None) => {
                        let mut response = azure_error(416, "InvalidRange", "The range is past the end of the blob.")?;
                        response.headers_mut().set("content-range", &format!("bytes */{size}"))?;
                        return Ok(response);
                    }
                    // Not a range this reads: the whole blob.
                    None => {}
                }
            }
            let Some(object) = bucket.get(&grant.object).execute().await? else { return azure_error(404, "BlobNotFound", "It is gone.") };
            let size = object.size();
            let Some(body) = object.body() else { return azure_error(404, "BlobNotFound", "It is gone.") };
            let mut response = Response::from_body(body.response_body()?)?;
            headers(&mut response, size)?;
            Ok(response)
        }
        ("PUT", Some(upload_id)) => {
            let comp = query(&request, "comp").unwrap_or_default();
            let limit = if grant.kind == "cache" { CACHE_MAX_ENTRY_BYTES } else { ARTIFACT_MAX_BYTES };
            match comp.as_str() {
                // Put Block, or Put Blob: one part.
                "block" | "" => {
                    let part = if comp == "block" {
                        match query(&request, "blockid").as_deref().and_then(block_index) {
                            Some(index) if index < 10_000 => index + 1,
                            _ => return azure_error(400, "InvalidQueryParameterValue", "A block id ends in its index, from 0."),
                        }
                    } else {
                        1
                    };
                    let length = request.headers().get("content-length")?.and_then(|l| l.parse::<u64>().ok()).unwrap_or(0);
                    if length > MAX_BLOCK_BYTES || length > limit {
                        return azure_error(413, "RequestBodyTooLarge", "That block is larger than g1t takes at once.");
                    }
                    let upload = bucket.resume_multipart_upload(&grant.object, upload_id)?;
                    let uploaded = match request.inner().body() {
                        Some(body) if length > 0 => upload.upload_part(part as u16, body).await?,
                        _ => upload.upload_part(part as u16, Vec::<u8>::new()).await?,
                    };
                    let recorded = BlobArgs { blob: token.to_owned(), part, etag: uploaded.etag(), size: length };
                    let _: Outcome<bool> = g1t_kit::call(&services.actions, "blob_part", &recorded).await?;
                    if comp == "block" {
                        return azure(201);
                    }
                    // Put Blob is the whole thing: finish it now.
                    complete_blob(&bucket, services, token, &grant, upload_id, &[], limit, true).await
                }
                "blocklist" => {
                    let xml = request.text().await.unwrap_or_default();
                    let ids = block_list(&xml);
                    complete_blob(&bucket, services, token, &grant, upload_id, &ids, limit, false).await
                }
                _ => azure_error(400, "InvalidQueryParameterValue", "g1t takes Put Blob, Put Block and Put Block List."),
            }
        }
        _ => azure_error(405, "UnsupportedHttpVerb", "That link is not for this."),
    }
}

/// Finishes an upload from its parts: the blocks a list names, or the one
/// part of a Put Blob.
#[allow(clippy::too_many_arguments)]
async fn complete_blob(
    bucket: &Bucket,
    services: &Services,
    token: &str,
    grant: &BlobGrant,
    upload_id: &str,
    ids: &[String],
    limit: u64,
    whole: bool,
) -> Result<Response> {
    let recorded: Outcome<Vec<BlobPart>> = g1t_kit::call(&services.actions, "blob_parts", &BlobArgs { blob: token.to_owned(), ..BlobArgs::default() }).await?;
    let recorded = match recorded {
        Outcome::Ok(recorded) => recorded,
        Outcome::Fail(refused) => return azure_error(403, "AuthenticationFailed", &refused.message),
    };
    let parts = if whole {
        recorded.into_iter().filter(|p| p.part == 1).collect()
    } else {
        match parts_for(ids, &recorded) {
            Ok(parts) => parts,
            Err(problem) => return azure_error(400, "InvalidBlockList", &problem),
        }
    };
    let size = match finish(bucket, &grant.object, upload_id, &parts).await {
        Ok(size) => size,
        Err(problem) => return azure_error(400, "InvalidBlockList", &format!("The upload could not be completed: {problem}")),
    };
    if size > limit {
        bucket.delete(&grant.object).await?;
        return azure_error(413, "RequestBodyTooLarge", &format!("It is {} MB, more than g1t keeps ({} MB).", size / 1_048_576, limit / 1_048_576));
    }
    let _: Outcome<bool> = g1t_kit::call(&services.actions, "blob_done", &BlobArgs { blob: token.to_owned(), size, ..BlobArgs::default() }).await?;
    azure(201)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Azure's SDK sends as block ids: base64 of a 36-character uuid
    /// prefix and the index padded to 48 characters in all.
    fn azure_block_id(index: u32) -> String {
        let prefix = "4a2f0d2e-8a44-4f1b-9d55-6f1a2b3c4d5e";
        let padded = format!("{prefix}{index:0>width$}", width = 48 - prefix.len());
        STANDARD.encode(padded)
    }

    #[test]
    fn block_ids_give_their_index() {
        assert_eq!(block_index(&azure_block_id(0)), Some(0));
        assert_eq!(block_index(&azure_block_id(17)), Some(17));
        assert_eq!(block_index(&STANDARD.encode("no-digits")), None);
        assert_eq!(block_index("not base64!"), None);
    }

    #[test]
    fn a_block_list_is_read_in_order_and_matched_to_parts() {
        // As the SDK's commitBlockList sends it.
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><BlockList><Latest>{}</Latest><Latest>{}</Latest></BlockList>",
            azure_block_id(0),
            azure_block_id(1)
        );
        let ids = block_list(&xml);
        assert_eq!(ids, [azure_block_id(0), azure_block_id(1)]);
        // Sent out of order, as they are concurrently.
        let recorded = vec![
            BlobPart { part: 2, etag: "b".into(), size: 3 },
            BlobPart { part: 1, etag: "a".into(), size: 8 },
        ];
        let parts = parts_for(&ids, &recorded).unwrap();
        assert_eq!(parts.iter().map(|p| p.etag.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        // A block never sent, or listed out of order.
        assert!(parts_for(&[azure_block_id(0), azure_block_id(2)], &recorded).is_err());
        assert!(parts_for(&[azure_block_id(1), azure_block_id(0)], &recorded).is_err());
        assert!(block_list("<BlockList></BlockList>").is_empty());
    }

    #[test]
    fn older_protocol_chunks_are_parts() {
        let mb32 = CACHE_PART_BYTES;
        assert_eq!(chunk_part(&format!("bytes 0-{}/*", mb32 - 1)), Some((1, mb32)));
        assert_eq!(chunk_part(&format!("bytes {}-{}/*", mb32 * 2, mb32 * 2 + 99)), Some((3, 100)));
        // A whole entry in one chunk, as sccache (OpenDAL) sends it: its
        // check file is 13 bytes, a compiled crate can be well over 32 MB.
        assert_eq!(chunk_part("bytes 0-12/*"), Some((1, 13)));
        assert_eq!(chunk_part(&format!("bytes 0-{}/*", mb32)), Some((1, mb32 + 1)));
        assert_eq!(chunk_part(&format!("bytes 0-{}/*", MAX_BLOCK_BYTES - 1)), Some((1, MAX_BLOCK_BYTES)));
        // Not on a chunk's boundary, too long, backwards, or not a range.
        assert_eq!(chunk_part("bytes 5-10/*"), None);
        assert_eq!(chunk_part(&format!("bytes {mb32}-{}/*", mb32 * 2)), None);
        assert_eq!(chunk_part(&format!("bytes 0-{}/*", MAX_BLOCK_BYTES)), None);
        assert_eq!(chunk_part("bytes 10-5/*"), None);
        assert_eq!(chunk_part("0-10"), None);
    }

    #[test]
    fn downloads_read_one_byte_range() {
        // OpenDAL's stat: the first byte.
        assert_eq!(byte_range("bytes=0-0", 100), Some(Some((0, 0))));
        // The toolkit's segments, the last one cut at the end.
        assert_eq!(byte_range("bytes=0-49", 100), Some(Some((0, 49))));
        assert_eq!(byte_range("bytes=50-999", 100), Some(Some((50, 99))));
        assert_eq!(byte_range("bytes=90-", 100), Some(Some((90, 99))));
        assert_eq!(byte_range("bytes=-10", 100), Some(Some((90, 99))));
        assert_eq!(byte_range("bytes=-1000", 100), Some(Some((0, 99))));
        // Past the end: 416.
        assert_eq!(byte_range("bytes=100-200", 100), Some(None));
        assert_eq!(byte_range("bytes=0-0", 0), Some(None));
        assert_eq!(byte_range("bytes=-0", 100), Some(None));
        // Not read: the whole blob.
        assert_eq!(byte_range("bytes=0-1,5-6", 100), None);
        assert_eq!(byte_range("bytes=9-3", 100), None);
        assert_eq!(byte_range("items=0-1", 100), None);
        assert_eq!(byte_range("bytes=a-b", 100), None);
    }

    #[test]
    fn upload_links_carry_a_query_as_sas_links_do() {
        let url = upload_url("https://api.g1t.sh", "tok.sig");
        assert_eq!(url, "https://api.g1t.sh/actions/toolkit/blobs/tok.sig?sv=2024-11-04");
        // How OpenDAL reads a signed upload link: a container, a blob in
        // it, and a SAS query, all of which must be there.
        let rest = url.strip_prefix("https://api.g1t.sh/").unwrap();
        let (path, query) = rest.split_once('?').unwrap();
        let (container, blob) = path.split_once('/').unwrap();
        assert_eq!((container, blob, query), ("actions", "toolkit/blobs/tok.sig", "sv=2024-11-04"));
    }

    /// A protobuf length-delimited field, as prost writes it.
    fn pb_text(number: u8, text: &str) -> Vec<u8> {
        let mut out = vec![(number << 3) | 2, text.len() as u8];
        out.extend_from_slice(text.as_bytes());
        out
    }

    /// The requests sccache 0.18 sends (OpenDAL 0.58's `ghac` service, with
    /// prost): fields in number order, defaults left out, no metadata.
    #[test]
    fn twirp_reads_sccaches_protobuf_requests() {
        assert!(is_protobuf("application/protobuf"));
        assert!(is_protobuf("Application/Protobuf; charset=utf-8"));
        assert!(!is_protobuf("application/json"));
        assert!(!is_protobuf(""));

        let key = "sccache/f/c/b/fcb0a1d2e3";
        let version = "sccache-v0.18.0";
        let create = [pb_text(2, key), pb_text(3, version)].concat();
        let read = proto::request("CreateCacheEntry", &create).unwrap();
        assert_eq!((text(&read, "key"), text(&read, "version")), (key.to_owned(), version.to_owned()));

        // size_bytes is field 3, a varint: 300 is 0xac 0x02.
        let finalize = [pb_text(2, key), vec![0x18, 0xac, 0x02], pb_text(4, version)].concat();
        let read = proto::request("FinalizeCacheEntryUpload", &finalize).unwrap();
        assert_eq!(number(&read, "size_bytes"), Some(300));
        assert_eq!(text(&read, "version"), version);

        let lookup = [pb_text(2, key), pb_text(4, version)].concat();
        let read = proto::request("GetCacheEntryDownloadURL", &lookup).unwrap();
        assert_eq!(text(&read, "key"), key);
        assert!(field(&read, "restore_keys").is_null());
        // The toolkit's own lookup, with metadata (skipped) and restore keys.
        let metadata = vec![0x0a, 0x02, 0x08, 0x07];
        let with_restore = [metadata, pb_text(2, "k"), pb_text(3, "k-"), pb_text(3, "x-"), pb_text(4, "v")].concat();
        let read = proto::request("GetCacheEntryDownloadURL", &with_restore).unwrap();
        assert_eq!(field(&read, "restore_keys"), &json!(["k-", "x-"]));
        assert_eq!(text(&read, "version"), "v");

        // The same three, as prost 0.14 encodes them with OpenDAL's
        // generated types (the `ghac` crate, 0.3.0), byte for byte.
        let recorded = |hex: &str| -> Vec<u8> { (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect() };
        let prefix = "1218736363616368652f662f632f622f66636230613164326533";
        let suffix = "0f736363616368652d76302e31382e30";
        assert_eq!(recorded(&format!("{prefix}1a{suffix}")), create);
        assert_eq!(recorded(&format!("{prefix}18ac0222{suffix}")), finalize);
        assert_eq!(recorded(&format!("{prefix}22{suffix}")), lookup);

        // Cut short, or not a cache method.
        assert!(proto::request("CreateCacheEntry", &create[..create.len() - 1]).is_none());
        assert!(proto::request("CreateCacheEntry", &[0x12, 0xff]).is_none());
        assert!(proto::request("CreateArtifact", &create).is_none());
        assert_eq!(proto::request("CreateCacheEntry", &[]), Some(json!({})));
    }

    #[test]
    fn twirp_answers_in_protobuf_as_prost_reads_it() {
        let url = "https://api.g1t.sh/actions/toolkit/blobs/t?sv=2024-11-04";
        let created = proto::response("CreateCacheEntry", &json!({ "ok": true, "signed_upload_url": url }));
        assert_eq!(created, [vec![0x08, 0x01], pb_text(2, url)].concat());
        // Refused: ok false is the default, so only the message is sent.
        let refused = proto::response("CreateCacheEntry", &json!({ "ok": false, "signed_upload_url": "", "message": "no" }));
        assert_eq!(refused, pb_text(3, "no"));
        // entry_id is an int64, given as a string in JSON.
        let finalized = proto::response("FinalizeCacheEntryUpload", &json!({ "ok": true, "entry_id": "300" }));
        assert_eq!(finalized, vec![0x08, 0x01, 0x10, 0xac, 0x02]);
        let found = proto::response("GetCacheEntryDownloadURL", &json!({ "ok": true, "signed_download_url": "u", "matched_key": "k" }));
        assert_eq!(found, [vec![0x08, 0x01], pb_text(2, "u"), pb_text(3, "k")].concat());
        // A miss is an empty message: ok false.
        assert!(proto::response("GetCacheEntryDownloadURL", &json!({ "ok": false, "signed_download_url": "", "matched_key": "" })).is_empty());
    }

    /// The toolkit's requests, as `@actions/cache` 4 and `@actions/artifact`
    /// 2 send them (protobuf-ts, proto field names, no defaults).
    #[test]
    fn twirp_requests_read_in_the_toolkits_spelling() {
        let create_cache = json!({ "key": "node-cache-Linux-x64-npm-abc", "version": "a7f2c1e0" });
        assert_eq!(text(&create_cache, "key"), "node-cache-Linux-x64-npm-abc");
        let lookup = json!({ "key": "k", "restore_keys": ["k-", "x-"], "version": "v" });
        assert_eq!(field(&lookup, "restore_keys").as_array().unwrap().len(), 2);
        let finalize = json!({ "key": "k", "size_bytes": "1048576", "version": "v" });
        assert_eq!(number(&finalize, "size_bytes"), Some(1_048_576));
        let create_artifact = json!({
            "workflow_run_backend_id": "run_1",
            "workflow_job_run_backend_id": "job_1",
            "name": "dist",
            "expires_at": "2026-10-13T00:00:00Z",
            "version": 4
        });
        assert_eq!(text(&create_artifact, "workflow_job_run_backend_id"), "job_1");
        let list = json!({ "workflow_run_backend_id": "run_1", "workflow_job_run_backend_id": "job_1", "id_filter": "42", "name_filter": "dist" });
        assert_eq!(number(&list, "id_filter"), Some(42));
        assert_eq!(text(&list, "name_filter"), "dist");
        // A client writing JSON names instead reads the same.
        let camel = json!({ "workflowRunBackendId": "run_1", "sizeBytes": 3 });
        assert_eq!(text(&camel, "workflow_run_backend_id"), "run_1");
        assert_eq!(number(&camel, "size_bytes"), Some(3));
    }

    #[test]
    fn the_runtime_token_names_its_run_and_job() {
        let payload = URL_SAFE_NO_PAD.encode(json!({ "job": "job_1", "run": "run_1" }).to_string());
        let token = format!("h.{payload}.s");
        assert_eq!(runtime_job(&token).as_deref(), Some("job_1"));
        assert_eq!(backend_ids(&token), ("run_1".to_owned(), "job_1".to_owned()));
        assert_eq!(runtime_job("deadbeef"), None);
    }

    /// sccache 0.18's storage check, at server start: a lookup of
    /// `sccache/.sccache_check`. The actions service answers a miss with
    /// `Ok(None)`, `{"ok":true,"value":null}`, which was read back as a
    /// malformed outcome, and every lookup that missed was a 500
    /// ("Server startup failed: cache storage failed to read").
    #[test]
    fn sccaches_first_lookup_misses_with_a_204() {
        let url = worker::Url::parse(
            "https://api.g1t.sh/actions/toolkit/_apis/artifactcache/cache?keys=sccache/.sccache_check&version=sccache-v0.18.0",
        )
        .unwrap();
        assert_eq!(query_in(&url, "keys").as_deref(), Some("sccache/.sccache_check"));
        assert_eq!(query_in(&url, "version").as_deref(), Some("sccache-v0.18.0"));

        // As the actions service replies (`g1t_kit::reply`), and the API
        // reads it (`g1t_kit::call`).
        let wire = serde_json::to_string(&Outcome::<Option<CacheHit>>::Ok(None)).unwrap();
        assert_eq!(wire, r#"{"ok":true,"value":null}"#);
        let found: Outcome<Option<CacheHit>> = g1t_kit::read_answer("cache_lookup", &wire).unwrap();
        assert_eq!(lookup_answer(found, "sccache-v0.18.0", "https://api.g1t.sh"), (204, None));

        // Once saved, the same lookup is a hit with its download link.
        let hit = CacheHit {
            key: "sccache/.sccache_check".into(),
            object: "c/repo_1/cache_1".into(),
            size: 13,
            created_at: "2026-10-08T12:00:00.000Z".into(),
            blob: Some("tok.sig".into()),
        };
        let wire = serde_json::to_string(&Outcome::Ok(Some(hit))).unwrap();
        let found: Outcome<Option<CacheHit>> = g1t_kit::read_answer("cache_lookup", &wire).unwrap();
        let (status, body) = lookup_answer(found, "sccache-v0.18.0", "https://api.g1t.sh");
        let body = body.unwrap();
        assert_eq!(status, 200);
        assert_eq!(body["cacheKey"], "sccache/.sccache_check");
        assert_eq!(body["cacheVersion"], "sccache-v0.18.0");
        assert_eq!(body["archiveLocation"], "https://api.g1t.sh/actions/toolkit/blobs/tok.sig");

        // A refusal keeps its status and says why.
        let refused = Outcome::<Option<CacheHit>>::fail(FailureCode::Unauthenticated, "That job is not running.");
        let (status, body) = lookup_answer(refused, "v", "https://api.g1t.sh");
        assert_eq!((status, body.unwrap()["message"].as_str()), (401, Some("That job is not running.")));

        // An answer that does not read names its method and the cause.
        let unread = g1t_kit::read_answer::<Outcome<CacheHit>>("cache_lookup", r#"{"ok":true,"value":null}"#).unwrap_err();
        assert!(unread.to_string().contains("cache_lookup answered with what could not be read"), "{unread}");
    }

    #[test]
    fn a_job_is_told_where_the_toolkit_s_services_are() {
        let vars = runtime_variables("https://api.g1t.sh", "tok", false);
        // Twirp paths are resolved against the root of ACTIONS_RESULTS_URL.
        assert_eq!(vars["ACTIONS_RESULTS_URL"], "https://api.g1t.sh/");
        // The older protocol appends `_apis/artifactcache/…`.
        assert_eq!(vars["ACTIONS_CACHE_URL"], "https://api.g1t.sh/actions/toolkit/");
        assert_eq!(vars["ACTIONS_CACHE_SERVICE_V2"], "True");
        assert!(vars.get("ACTIONS_ID_TOKEN_REQUEST_URL").is_none());
        let vars = runtime_variables("https://api.g1t.sh", "tok", true);
        // core.getIDToken appends `&audience=…`.
        assert_eq!(vars["ACTIONS_ID_TOKEN_REQUEST_URL"], "https://api.g1t.sh/actions/oidc/token?api-version=2.0");
        assert_eq!(vars["ACTIONS_ID_TOKEN_REQUEST_TOKEN"], "tok");
    }

    #[test]
    fn artifacts_are_listed_as_the_toolkit_reads_them() {
        let artifact = Artifact {
            id: 7,
            name: "dist".into(),
            size: 10,
            digest: None,
            format: "zip".into(),
            run_id: "run_1".into(),
            job_id: "job_1".into(),
            repo_id: "repo_1".into(),
            expired: false,
            created_at: "2026-10-08T12:00:00.000Z".into(),
            updated_at: "2026-10-08T12:00:00.000Z".into(),
            expires_at: "2026-10-22T12:00:00.000Z".into(),
            head_branch: None,
            head_sha: None,
        };
        let shown = listed(&artifact);
        assert_eq!(shown["database_id"], "7");
        assert_eq!(shown["size"], "10");
        assert_eq!(shown["workflow_job_run_backend_id"], "job_1");
    }
}
