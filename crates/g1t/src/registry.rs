//! The registry side of a push: the token, blobs in chunks, the manifest.
//!
//! Every blob is checked with `HEAD` first and skipped when the registry
//! has it. Otherwise it is uploaded in chunks, each its own `PATCH` under
//! the 100 MB a request may carry, then closed with `PUT ?digest=`. A
//! `429` or `5xx` is retried after a wait (the `Retry-After` when there is
//! one), and an interrupted upload continues from the offset the registry
//! says it holds; one the registry let go is started again.

use crate::chunk;
use crate::credentials::Credentials;
use crate::image::{Blob, Source};
use base64::Engine as _;
use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

/// How many times a request is tried before the push gives up.
const ATTEMPTS: u32 = 6;
/// How many times one blob's upload may start over.
const RESTARTS: u32 = 3;

pub struct Registry {
    agent: ureq::Agent,
    base: String,
    host: String,
    name: String,
    credentials: Credentials,
    token: Option<String>,
}

/// A registry's answer, whatever its status.
pub struct Reply {
    pub status: u16,
    location: Option<String>,
    range: Option<String>,
    digest: Option<String>,
    retry_after: Option<u64>,
    challenge: Option<String>,
    body: String,
}

pub enum Outcome {
    Exists,
    Uploaded { chunks: u64 },
}

enum Failed {
    /// The registry no longer has the upload: start the blob again.
    Restart(String),
    Fatal(String),
}

type Result<T> = std::result::Result<T, String>;

impl Registry {
    pub fn new(base: String, host: String, name: String, credentials: Credentials) -> Registry {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(30))
            .timeout_read(Duration::from_secs(300))
            .user_agent(concat!("g1t/", env!("CARGO_PKG_VERSION")))
            .try_proxy_from_env(true)
            .build();
        Registry {
            agent,
            base,
            host,
            name,
            credentials,
            token: None,
        }
    }

    /// Trades the g1t token for a registry token that may pull and push
    /// this image, at the token endpoint the registry names.
    pub fn sign_in(&mut self) -> Result<()> {
        let ping = self.raw("GET", &format!("{}/v2/", self.base), &[], None, false)?;
        let (realm, service) = ping
            .challenge
            .as_deref()
            .and_then(parse_challenge)
            .unwrap_or_else(|| (format!("{}/v2/token", self.base), self.host.clone()));
        let url = format!(
            "{realm}?service={service}&scope=repository:{}:pull,push",
            self.name
        );
        let basic = base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            self.credentials.username, self.credentials.secret
        ));
        let authorization = format!("Basic {basic}");
        let mut reply = None;
        for attempt in 0..ATTEMPTS {
            match self.raw(
                "GET",
                &url,
                &[("authorization", &authorization)],
                None,
                false,
            ) {
                Ok(r) if retry_wait(&r, attempt).is_none() => {
                    reply = Some(r);
                    break;
                }
                Ok(r) => wait(retry_wait(&r, attempt)),
                Err(error) if attempt + 1 == ATTEMPTS => return Err(error),
                Err(_) => wait(Some(backoff(attempt))),
            }
        }
        let reply = reply.ok_or_else(|| format!("{} did not answer the sign-in.", self.host))?;
        if reply.status != 200 {
            return Err(format!(
                "{} refused the token: {}",
                self.host,
                explain(&reply)
            ));
        }
        let body: Value = serde_json::from_str(&reply.body).map_err(|_| {
            format!(
                "{} answered the sign-in with something that is not JSON.",
                self.host
            )
        })?;
        let token = body
            .get("token")
            .or_else(|| body.get("access_token"))
            .and_then(Value::as_str);
        self.token = Some(
            token
                .ok_or_else(|| format!("{} answered the sign-in without a token.", self.host))?
                .to_owned(),
        );
        Ok(())
    }

    /// One request, as it went. Transport failures are errors.
    fn raw(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
        bearer: bool,
    ) -> Result<Reply> {
        let mut request = self.agent.request(method, url);
        for (name, value) in headers {
            request = request.set(name, value);
        }
        if bearer && let Some(token) = &self.token {
            request = request.set("authorization", &format!("Bearer {token}"));
        }
        let result = match body {
            Some(bytes) => request.send_bytes(bytes),
            None => request.call(),
        };
        let response = match result {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(error)) => return Err(format!("{method} {url}: {error}")),
        };
        let header = |name: &str| response.header(name).map(str::to_owned);
        let mut reply = Reply {
            status: response.status(),
            location: header("location"),
            range: header("range"),
            digest: header("docker-content-digest"),
            retry_after: header("retry-after").and_then(|s| s.trim().parse().ok()),
            challenge: header("www-authenticate"),
            body: String::new(),
        };
        if method != "HEAD" {
            let mut body = String::new();
            let _ = response
                .into_reader()
                .take(1 << 20)
                .read_to_string(&mut body);
            reply.body = body;
        }
        Ok(reply)
    }

    /// One request with the registry token, signing in again once if the
    /// token has run out.
    fn send(
        &mut self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Reply> {
        let reply = self.raw(method, url, headers, body, true)?;
        if reply.status == 401 {
            self.sign_in()?;
            return self.raw(method, url, headers, body, true);
        }
        Ok(reply)
    }

    /// A request that may be sent again as it is, tried until it gets an
    /// answer that is not a `429` or `5xx`.
    fn call(
        &mut self,
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Reply> {
        let mut last = String::new();
        for attempt in 0..ATTEMPTS {
            match self.send(method, url, headers, body) {
                Ok(reply) => match retry_wait(&reply, attempt) {
                    None => return Ok(reply),
                    Some(delay) => {
                        last = explain(&reply);
                        wait(Some(delay));
                    }
                },
                Err(error) => {
                    last = error;
                    wait(Some(backoff(attempt)));
                }
            }
        }
        Err(format!(
            "{method} {url} failed {ATTEMPTS} times; the last: {last}"
        ))
    }

    pub fn blob_exists(&mut self, digest: &str) -> Result<bool> {
        let url = format!("{}/v2/{}/blobs/{digest}", self.base, self.name);
        let reply = self.call("HEAD", &url, &[], None)?;
        match reply.status {
            200 => Ok(true),
            404 => Ok(false),
            _ => Err(format!("Could not check for {digest}: {}", explain(&reply))),
        }
    }

    /// Puts a blob in the registry unless it is there already.
    pub fn push_blob(&mut self, blob: &Blob, tar: &Path, chunk_size: u64) -> Result<Outcome> {
        if self.blob_exists(&blob.digest)? {
            return Ok(Outcome::Exists);
        }
        let mut restarts = 0;
        loop {
            match self.upload(blob, tar, chunk_size) {
                Ok(chunks) => return Ok(Outcome::Uploaded { chunks }),
                Err(Failed::Restart(reason)) if restarts < RESTARTS => {
                    restarts += 1;
                    eprintln!("    {reason}; starting this blob again");
                }
                Err(Failed::Restart(reason) | Failed::Fatal(reason)) => return Err(reason),
            }
        }
    }

    fn resolve(&self, location: Option<&str>, fallback: &str) -> String {
        match location {
            Some(l) if l.starts_with("http://") || l.starts_with("https://") => l.to_owned(),
            Some(l) if l.starts_with('/') => format!("{}{l}", self.base),
            Some(l) if !l.is_empty() => format!("{}/{l}", self.base),
            _ => fallback.to_owned(),
        }
    }

    /// Where an interrupted upload stands: the offset to continue from,
    /// or a restart when the registry let it go.
    fn upload_offset(&mut self, location: &mut String) -> std::result::Result<u64, Failed> {
        let reply = self
            .call("GET", location, &[], None)
            .map_err(Failed::Fatal)?;
        match reply.status {
            200 | 204 => {
                *location = self.resolve(reply.location.as_deref(), location);
                reply
                    .range
                    .as_deref()
                    .and_then(chunk::next_offset)
                    .ok_or_else(|| Failed::Restart("the upload's progress is unknown".to_owned()))
            }
            404 => Err(Failed::Restart("the registry let the upload go".to_owned())),
            _ => Err(Failed::Fatal(format!(
                "Could not check the upload: {}",
                explain(&reply)
            ))),
        }
    }

    fn upload(
        &mut self,
        blob: &Blob,
        tar: &Path,
        chunk_size: u64,
    ) -> std::result::Result<u64, Failed> {
        let start = format!("{}/v2/{}/blobs/uploads/", self.base, self.name);
        let reply = self
            .call("POST", &start, &[], Some(&[]))
            .map_err(Failed::Fatal)?;
        if reply.status != 202 {
            return Err(Failed::Fatal(format!(
                "Could not start an upload: {}",
                explain(&reply)
            )));
        }
        let mut location = self.resolve(reply.location.as_deref(), "");
        if location.is_empty() {
            return Err(Failed::Fatal(
                "The registry started an upload without saying where.".to_owned(),
            ));
        }
        let (mut source, base_offset) = open(blob, tar).map_err(Failed::Fatal)?;
        let total_chunks = chunk::count(blob.size, chunk_size);
        let mut offset = 0u64;
        let mut chunks = 0u64;
        let mut failures = 0u32;
        let mut buffer = Vec::new();
        while let Some(&(_, length)) = chunk::plan(blob.size, chunk_size, offset).first() {
            read_at(&mut source, base_offset + offset, length, &mut buffer)
                .map_err(Failed::Fatal)?;
            let range = chunk::content_range(offset, length);
            let headers = [
                ("content-type", "application/octet-stream"),
                ("content-range", range.as_str()),
            ];
            let sent = self.send("PATCH", &location.clone(), &headers, Some(&buffer));
            let retry = match &sent {
                Ok(reply) if reply.status == 202 => None,
                Ok(reply) => retry_wait(reply, failures),
                Err(_) => Some(backoff(failures)),
            };
            match sent {
                Ok(reply) if reply.status == 202 => {
                    location = self.resolve(reply.location.as_deref(), &location);
                    let next = reply
                        .range
                        .as_deref()
                        .and_then(chunk::next_offset)
                        .unwrap_or(offset + length);
                    if next > blob.size {
                        return Err(Failed::Fatal(format!(
                            "The registry says it holds {next} bytes of a {}-byte blob.",
                            blob.size
                        )));
                    }
                    offset = if next == 0 { offset + length } else { next };
                    chunks += 1;
                    failures = 0;
                    if total_chunks > 1 {
                        eprintln!(
                            "    chunk {}/{total_chunks}  {}  {}",
                            chunks.min(total_chunks),
                            chunk::human(length),
                            percent(offset, blob.size)
                        );
                    }
                }
                Ok(reply) if reply.status == 413 => {
                    return Err(Failed::Fatal(format!(
                        "A {} chunk was refused as too large ({}). Try a smaller --chunk-size.",
                        chunk::human(length),
                        explain(&reply)
                    )));
                }
                Ok(reply) if reply.status == 404 || reply.status == 416 => {
                    offset = self.upload_offset(&mut location)?;
                }
                Ok(reply) if retry.is_none() => {
                    return Err(Failed::Fatal(format!(
                        "A chunk was refused: {}",
                        explain(&reply)
                    )));
                }
                sent => {
                    failures += 1;
                    let why = match sent {
                        Ok(reply) => explain(&reply),
                        Err(error) => error,
                    };
                    if failures >= ATTEMPTS {
                        return Err(Failed::Fatal(format!(
                            "A chunk failed {ATTEMPTS} times; the last: {why}"
                        )));
                    }
                    eprintln!(
                        "    chunk at {} failed ({why}); trying again",
                        chunk::human(offset)
                    );
                    wait(retry);
                    offset = self.upload_offset(&mut location)?;
                }
            }
        }
        // Every byte is in: close the upload with its digest.
        let separator = if location.contains('?') { '&' } else { '?' };
        let finish = format!(
            "{location}{separator}digest={}",
            blob.digest.replace(':', "%3A")
        );
        let mut failures = 0u32;
        loop {
            let sent = self.send(
                "PUT",
                &finish,
                &[("content-type", "application/octet-stream")],
                Some(&[]),
            );
            let why = match sent {
                Ok(reply) if reply.status == 201 => return Ok(chunks.max(1)),
                Ok(reply) if reply.status != 404 && retry_wait(&reply, failures).is_none() => {
                    return Err(Failed::Fatal(format!(
                        "The registry did not take {}: {}",
                        blob.digest,
                        explain(&reply)
                    )));
                }
                Ok(reply) => explain(&reply),
                Err(error) => error,
            };
            failures += 1;
            if failures >= ATTEMPTS {
                return Err(Failed::Fatal(format!(
                    "Closing the upload failed {ATTEMPTS} times; the last: {why}"
                )));
            }
            wait(Some(backoff(failures)));
            // The close may have landed before the answer was lost.
            if self.blob_exists(&blob.digest).map_err(Failed::Fatal)? {
                return Ok(chunks.max(1));
            }
            if self.upload_offset(&mut location.clone())? != blob.size {
                return Err(Failed::Restart("the upload lost bytes".to_owned()));
            }
        }
    }

    /// Puts the manifest under the tag. Returns the registry's digest.
    pub fn push_manifest(
        &mut self,
        tag: &str,
        media_type: &str,
        manifest: &[u8],
    ) -> Result<String> {
        let url = format!("{}/v2/{}/manifests/{tag}", self.base, self.name);
        let reply = self.call("PUT", &url, &[("content-type", media_type)], Some(manifest))?;
        if reply.status != 201 && reply.status != 200 {
            return Err(format!(
                "The registry did not take the manifest: {}",
                explain(&reply)
            ));
        }
        Ok(reply.digest.unwrap_or_default())
    }
}

fn open(blob: &Blob, tar: &Path) -> Result<(File, u64)> {
    let (path, offset) = match &blob.source {
        Source::Tar { offset } => (tar, *offset),
        Source::File(path) => (path.as_path(), 0),
    };
    let file = File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    Ok((file, offset))
}

fn read_at(file: &mut File, offset: u64, length: u64, buffer: &mut Vec<u8>) -> Result<()> {
    buffer.resize(length as usize, 0);
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    file.read_exact(buffer)
        .map_err(|e| format!("Could not read the image: {e}"))
}

fn percent(done: u64, total: u64) -> String {
    format!(
        "{:.0}%",
        if total == 0 {
            100.0
        } else {
            done as f64 * 100.0 / total as f64
        }
    )
}

/// `Bearer realm="https://g1t.sh/v2/token",service="g1t.sh",scope="â€¦"`.
fn parse_challenge(header: &str) -> Option<(String, String)> {
    let rest = header
        .trim()
        .strip_prefix("Bearer ")
        .or_else(|| header.trim().strip_prefix("bearer "))?;
    let mut realm = None;
    let mut service = None;
    for part in rest.split(',') {
        let (key, value) = part.trim().split_once('=')?;
        let value = value.trim().trim_matches('"').to_owned();
        match key.trim() {
            "realm" => realm = Some(value),
            "service" => service = Some(value),
            _ => {}
        }
    }
    Some((realm?, service.unwrap_or_default()))
}

/// How long to wait before trying again, when the answer is worth
/// another try: `429` and `5xx`.
fn retry_wait(reply: &Reply, attempt: u32) -> Option<Duration> {
    if reply.status != 429 && reply.status < 500 {
        return None;
    }
    Some(match reply.retry_after {
        Some(seconds) => Duration::from_secs(seconds.min(300)),
        None => backoff(attempt),
    })
}

/// 1s, 2s, 4s â€¦ at most 30s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.min(5)).min(30))
}

fn wait(delay: Option<Duration>) {
    if let Some(delay) = delay {
        std::thread::sleep(delay);
    }
}

/// An error reply for people: the registry's own code and message when it
/// sent them, the status otherwise.
fn explain(reply: &Reply) -> String {
    if let Ok(body) = serde_json::from_str::<Value>(&reply.body)
        && let Some(error) = body
            .get("errors")
            .and_then(Value::as_array)
            .and_then(|e| e.first())
    {
        let code = error.get("code").and_then(Value::as_str).unwrap_or("ERROR");
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        return format!("{code}: {message} ({})", reply.status);
    }
    let text = reply.body.trim();
    if text.is_empty() || text.starts_with('<') {
        format!("HTTP {}", reply.status)
    } else {
        format!(
            "HTTP {}: {}",
            reply.status,
            text.chars().take(200).collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, retry_after: Option<u64>, body: &str) -> Reply {
        Reply {
            status,
            location: None,
            range: None,
            digest: None,
            retry_after,
            challenge: None,
            body: body.to_owned(),
        }
    }

    #[test]
    fn challenges_name_the_token_endpoint() {
        let header = r#"Bearer realm="https://g1t.sh/v2/token",service="g1t.sh",scope="repository:acme/web:pull""#;
        assert_eq!(
            parse_challenge(header),
            Some(("https://g1t.sh/v2/token".into(), "g1t.sh".into()))
        );
        assert_eq!(parse_challenge("Basic realm=\"x\""), None);
    }

    #[test]
    fn only_429_and_5xx_are_tried_again() {
        assert_eq!(
            retry_wait(&reply(429, Some(7), ""), 0),
            Some(Duration::from_secs(7))
        );
        assert_eq!(
            retry_wait(&reply(503, None, ""), 2),
            Some(Duration::from_secs(4))
        );
        assert_eq!(retry_wait(&reply(400, None, ""), 0), None);
        assert_eq!(retry_wait(&reply(413, None, ""), 0), None);
    }

    #[test]
    fn backoff_doubles_up_to_30s() {
        let waits: Vec<u64> = (0..8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn errors_read_as_the_registry_wrote_them() {
        let body = r#"{"errors":[{"code":"DENIED","message":"Pushing needs Write."}]}"#;
        assert_eq!(
            explain(&reply(403, None, body)),
            "DENIED: Pushing needs Write. (403)"
        );
        assert_eq!(
            explain(&reply(413, None, "<html>Too large</html>")),
            "HTTP 413"
        );
    }
}
