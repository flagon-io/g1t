//! Artifacts and the cache of GitHub Actions jobs, kept in Workers KV in
//! chunks, with KV's own expiry: artifacts for 14 days with their run,
//! cache entries for 7 days with their repository.
//!
//! A sandbox reaches these with its job's token, at
//! `/actions/jobs/{job}/artifacts[/{name}]` and `/actions/jobs/{job}/cache`.
//! People download an artifact at
//! `/repos/{owner}/{repo}/actions/runs/{run}/artifacts/{name}`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::kv::KvStore;
use worker::{Env, Request, Response, Result};

use g1t_contracts::{FailureCode, Outcome};

use crate::operations::Services;

/// KV's largest value is 25 MiB; chunks stay under it.
const CHUNK: usize = 20 * 1024 * 1024;
/// The largest artifact or cache entry, kept within a Worker's memory.
const MAX_BYTES: usize = 60 * 1024 * 1024;
const ARTIFACT_TTL: u64 = 14 * 24 * 60 * 60;
const CACHE_TTL: u64 = 7 * 24 * 60 * 60;

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
        (_, "cache") => {
            let key = query(&request, "key").unwrap_or_default();
            if key.is_empty() || key.len() > 400 {
                return error(400, "A cache key is 1 to 400 characters.");
            }
            if method == "PUT" {
                let base = format!("c/{repo}/{key}");
                // A key is written once, as on GitHub.
                if kv.get(&base).text().await?.is_some() {
                    return crate::reply(&json!({ "saved": false, "reason": "That key is already cached." }));
                }
                let bytes = request.bytes().await?;
                if bytes.len() > MAX_BYTES {
                    return error(413, "Cache entries are at most 60 MB.");
                }
                put(&kv, &base, &key, &bytes, CACHE_TTL).await?;
                return crate::reply(&json!({ "saved": true }));
            }
            // The exact key, else the newest entry under each restore key.
            let exact = format!("c/{repo}/{key}");
            if let Some(bytes) = get(&kv, &exact).await? {
                let mut response = Response::from_bytes(bytes)?;
                response.headers_mut().set("x-g1t-key", &key)?;
                return Ok(response);
            }
            for prefix in query(&request, "restore").unwrap_or_default().lines().map(str::trim).filter(|p| !p.is_empty()) {
                if let Some((base, meta)) = list(&kv, &format!("c/{repo}/{prefix}")).await?.into_iter().next()
                    && let Some(bytes) = get(&kv, &base).await?
                {
                    let mut response = Response::from_bytes(bytes)?;
                    response.headers_mut().set("x-g1t-key", &meta.name)?;
                    return Ok(response);
                }
            }
            error(404, "Nothing cached under those keys.")
        }
        _ => error(404, "No such endpoint."),
    }
}

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
