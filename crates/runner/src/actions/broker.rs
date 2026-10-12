//! Brokered secrets on a self-hosted runner. A brokered secret's value
//! never reaches the computer a job runs on: the job has a stand-in
//! (`g1tsec_…`) in its place, and g1t fills the value in on the job's
//! requests to the secret's hosts. On g1t's own machines every request
//! leaves through g1t; here, this harness sends the ones that need it
//! there itself.
//!
//! The job's spec lists its stand-ins and their hosts (`brokered`; never a
//! value), and its steps get `HTTPS_PROXY` pointing at a proxy this
//! harness runs on 127.0.0.1 for the job's life:
//!
//! - **A connection to any other host** is a plain tunnel: the proxy never
//!   sees inside it.
//! - **A connection to a brokered host** is opened with a certificate made
//!   for that host by a certificate authority made for this job alone,
//!   which the steps' tools are pointed at (`SSL_CERT_FILE` and the
//!   others, as g1t's own sandboxes set them), and which can sign for the
//!   brokered hosts only (a name constraint). Its key is never written
//!   down. Each request on it that carries one of the job's stand-ins is
//!   passed to g1t, `POST /actions/jobs/{job}/broker` with the job's token
//!   (services/runner broker-relay.ts), which fills the value in, sends
//!   it, and answers with what came back, the value swapped back for its
//!   stand-in. A request without a stand-in goes straight to the host.
//!
//! So the harness, the job and the computer only ever hold stand-ins. Not
//! on Windows yet, whose tools trust the system's certificate store rather
//! than these variables; there, as with a harness from before this, the
//! stand-in goes as it is and the job's log says it will not be filled in.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use serde_json::{Value, json};

use super::report::Api;

/// How a stand-in starts (`STAND_IN_PREFIX` in g1t's contracts).
pub(crate) const STAND_IN_PREFIX: &str = "g1tsec_";
/// The largest request body passed to g1t, as broker-relay.ts takes it.
pub(crate) const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// The longest request head read.
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// How long a connection may sit idle before the proxy lets it go.
const IDLE: Duration = Duration::from_secs(5 * 60);
/// How long one request passed to g1t may take, its answer included.
const RELAY_TIME: Duration = Duration::from_secs(10 * 60);
const CONNECT_TIME: Duration = Duration::from_secs(30);
/// The most connections open through the proxy at once.
const MAX_CONNECTIONS: usize = 256;
/// The request to make, and the answer, as broker-relay.ts names them.
const REQUEST_HEADER: &str = "x-g1t-broker-request";
const ANSWER_HEADER: &str = "x-g1t-broker-response";
/// Headers about one connection rather than the request, which are not
/// passed on either way.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];
/// The variables the job's tools read their trusted certificates from,
/// pointed at the system's bundle with this job's authority added, as g1t's
/// own sandboxes set them (services/runner egress.ts, docker/oci.rs).
/// `NODE_EXTRA_CA_CERTS` takes the authority alone.
const BUNDLE_VARIABLES: &[&str] = &["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "PIP_CERT", "GIT_SSL_CAINFO", "CARGO_HTTP_CAINFO"];
/// Where a system keeps its bundle of trusted certificates: Debian and
/// Ubuntu, Fedora and RHEL, Alpine and macOS, openSUSE.
const SYSTEM_BUNDLES: &[&str] =
    &["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem", "/etc/ssl/ca-bundle.pem"];

/// A stand-in the job was given, with its secret's key and hosts.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StandIn {
    pub(crate) stand_in: String,
    pub(crate) name: String,
    pub(crate) hosts: Vec<String>,
}

/// The job's stand-ins, from its spec's `brokered`: none from a g1t that
/// does not broker for this runner.
pub(crate) fn stand_ins(spec: &Value) -> Vec<StandIn> {
    let Some(entries) = spec.get("brokered").and_then(Value::as_array) else { return Vec::new() };
    entries
        .iter()
        .filter_map(|entry| {
            let stand_in = entry.get("stand_in").or_else(|| entry.get("standIn"))?.as_str()?;
            let hosts: Vec<String> = entry.get("hosts")?.as_array()?.iter().filter_map(Value::as_str).map(str::to_owned).collect();
            (stand_in.starts_with(STAND_IN_PREFIX) && !hosts.is_empty()).then(|| StandIn {
                stand_in: stand_in.to_owned(),
                name: entry.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                hosts,
            })
        })
        .collect()
}

/// Whether this harness can broker its job's requests: on Linux or macOS,
/// and when the computer has no proxy of its own set for HTTPS, which this
/// one would have to chain to.
pub(crate) fn possible(env: impl Fn(&str) -> Option<String>) -> bool {
    cfg!(unix) && ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].iter().all(|name| !matches!(env(name), Some(value) if !value.trim().is_empty()))
}

/// A host as a list names it: lowercase, without its port or a final dot.
pub(crate) fn normalize_host(host: &str) -> String {
    let name = host.trim().to_ascii_lowercase();
    if name.starts_with('[') {
        return name.find(']').map_or(name.clone(), |end| name[..=end].to_owned());
    }
    let name = name.split(':').next().unwrap_or_default();
    name.trim_end_matches('.').to_owned()
}

/// Whether `host` is on the list, as g1t reads a brokered secret's hosts
/// (services/runner egress.ts `allows`): `example.com` is that host alone,
/// `*.example.com` its subdomains at any depth but not itself.
pub(crate) fn allows(patterns: &[String], host: &str) -> bool {
    let name = normalize_host(host);
    !name.is_empty()
        && patterns.iter().any(|raw| {
            let pattern = raw.trim().to_ascii_lowercase();
            match pattern.strip_prefix('*') {
                Some(suffix) if suffix.starts_with('.') => name.len() > suffix.len() && name.ends_with(suffix),
                _ => pattern == name,
            }
        })
}

/// A header's value as a stand-in may sit in it: Basic credentials decoded.
fn readable(value: &str) -> Option<String> {
    let (scheme, rest) = value.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    String::from_utf8(BASE64.decode(rest.trim()).ok()?).ok()
}

/// Whether a request carries one of the job's stand-ins: in its target, a
/// header, or Basic credentials, as broker.ts finds them.
pub(crate) fn carries(target: &str, headers: &[(String, String)], stand_ins: &[StandIn]) -> bool {
    stand_ins.iter().any(|known| {
        target.contains(&known.stand_in)
            || headers.iter().any(|(_, value)| value.contains(&known.stand_in) || readable(value).is_some_and(|decoded| decoded.contains(&known.stand_in)))
    })
}

fn hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP.iter().any(|hop| hop.eq_ignore_ascii_case(name))
}

// --- HTTP/1.1, as much as the proxy reads ----------------------------------

/// A request's line and headers.
#[derive(Debug, PartialEq)]
pub(crate) struct Head {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) version: String,
    pub(crate) headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// Whether the client wants the connection closed after this request.
    fn closes(&self) -> bool {
        match self.header("connection") {
            Some(value) => value.split(',').any(|token| token.trim().eq_ignore_ascii_case("close")),
            None => self.version.eq_ignore_ascii_case("HTTP/1.0"),
        }
    }
}

/// The error a body past [`MAX_BODY_BYTES`] reads as.
#[derive(Debug)]
struct TooLarge;

impl std::fmt::Display for TooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the request's body is larger than {} MB", MAX_BODY_BYTES / 1024 / 1024)
    }
}

impl std::error::Error for TooLarge {}

fn too_large(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<TooLarge>())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// One line, at most `limit` bytes, without its line ending; None at the end.
fn read_line(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    let read = reader.take(limit as u64 + 1).read_until(b'\n', &mut line)?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() > limit {
        return Err(invalid("a line of the request is too long"));
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    Ok(Some(String::from_utf8_lossy(&line).into_owned()))
}

/// A request's head, or None where the connection ends between requests.
pub(crate) fn read_head(reader: &mut impl BufRead) -> io::Result<Option<Head>> {
    let mut lines: Vec<String> = Vec::new();
    let mut total = 0;
    loop {
        let Some(line) = read_line(reader, MAX_HEAD_BYTES)? else {
            return if lines.is_empty() { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        };
        total += line.len() + 2;
        if total > MAX_HEAD_BYTES {
            return Err(invalid("the request's head is too long"));
        }
        if line.is_empty() {
            // Blank lines before a request are allowed, and skipped.
            if lines.is_empty() {
                continue;
            }
            break;
        }
        lines.push(line);
    }
    let mut parts = lines[0].split_whitespace();
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid("the request line does not read"));
    };
    let headers = lines[1..]
        .iter()
        .map(|line| line.split_once(':').map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned())).ok_or_else(|| invalid("a header does not read")))
        .collect::<io::Result<Vec<_>>>()?;
    Ok(Some(Head { method: method.to_owned(), target: target.to_owned(), version: version.to_owned(), headers }))
}

/// A request's body, by its length or in chunks, at most [`MAX_BODY_BYTES`].
pub(crate) fn read_body(reader: &mut impl BufRead, head: &Head) -> io::Result<Vec<u8>> {
    if head.header("transfer-encoding").is_some_and(|te| te.to_ascii_lowercase().contains("chunked")) {
        let mut body = Vec::new();
        loop {
            let line = read_line(reader, 1024)?.ok_or(io::ErrorKind::UnexpectedEof)?;
            let size = usize::from_str_radix(line.split(';').next().unwrap_or_default().trim(), 16).map_err(|_| invalid("a chunk's size does not read"))?;
            if size == 0 {
                // Trailers, which go no further, up to the blank line.
                while !read_line(reader, MAX_HEAD_BYTES)?.ok_or(io::ErrorKind::UnexpectedEof)?.is_empty() {}
                return Ok(body);
            }
            if body.len() + size > MAX_BODY_BYTES {
                return Err(io::Error::other(TooLarge));
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..])?;
            read_line(reader, 2)?;
        }
    }
    let length = match head.header("content-length") {
        Some(value) => value.trim().parse::<usize>().map_err(|_| invalid("the content length does not read"))?,
        None => 0,
    };
    if length > MAX_BODY_BYTES {
        return Err(io::Error::other(TooLarge));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(body)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Content Too Large",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Status",
    }
}

/// A short answer of the proxy's own, in plain text.
fn write_plain(out: &mut impl Write, status: u16, message: &str) -> io::Result<()> {
    let body = format!("g1t: {message}\n");
    write!(
        out,
        "HTTP/1.1 {status} {}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nx-g1t-broker: refused\r\n\r\n{body}",
        reason(status),
        body.len()
    )?;
    out.flush()
}

// --- g1t's side --------------------------------------------------------------

/// What g1t answered a request passed to it.
pub(crate) enum Answer {
    /// The host's answer, scrubbed: its status, headers and body.
    Relayed { status: u16, headers: Vec<(String, String)>, body: Box<dyn Read + Send> },
    /// g1t's own refusal, or that it could not be reached.
    Refused { status: u16, message: String },
}

/// Passes requests to g1t's broker with the job's token.
#[derive(Clone)]
pub(crate) struct Relay {
    url: String,
    token: String,
    agent: ureq::Agent,
}

impl Relay {
    /// For the job `api` is for, with its current token (taken after the
    /// spec was fetched, so the one it started with is already spent).
    pub(crate) fn new(api: &Api) -> Relay {
        Relay {
            url: format!("{}/actions/jobs/{}/broker", api.base, api.job),
            token: api.token.clone(),
            // Never a redirect: g1t answers itself.
            agent: ureq::AgentBuilder::new().redirects(0).timeout(RELAY_TIME).build(),
        }
    }

    /// Passes one request to g1t: the token in a header, never the URL.
    pub(crate) fn send(&self, method: &str, url: &str, headers: &[(String, String)], body: &[u8]) -> Answer {
        let wanted = json!({ "method": method, "url": url, "headers": headers.iter().map(|(n, v)| [n, v]).collect::<Vec<_>>() });
        let sent = self
            .agent
            .post(&self.url)
            .set("authorization", &format!("Bearer {}", self.token))
            .set(REQUEST_HEADER, &BASE64.encode(wanted.to_string()))
            .set("content-type", "application/octet-stream")
            .send_bytes(body);
        match sent {
            Ok(response) => {
                let answer = response
                    .header(ANSWER_HEADER)
                    .and_then(|header| BASE64.decode(header.trim()).ok())
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let Some(answer) = answer else {
                    return Answer::Refused { status: 502, message: "g1t's answer did not read.".into() };
                };
                let status = answer["status"].as_u64().and_then(|s| u16::try_from(s).ok()).filter(|s| (100..600).contains(s)).unwrap_or(502);
                let headers = answer["headers"]
                    .as_array()
                    .map(|pairs| {
                        pairs
                            .iter()
                            .filter_map(|pair| Some((pair.get(0)?.as_str()?.to_owned(), pair.get(1)?.as_str()?.to_owned())))
                            .collect()
                    })
                    .unwrap_or_default();
                Answer::Relayed { status, headers, body: Box::new(response.into_reader()) }
            }
            Err(ureq::Error::Status(status, response)) => {
                let message = response
                    .into_json::<Value>()
                    .ok()
                    .and_then(|body| body["error"]["message"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| format!("g1t's broker answered {status}."));
                // A refusal of g1t's is the job's to see; anything else
                // (g1t's own trouble, a spent token) is a bad gateway.
                let status = if matches!(status, 403 | 413) { status } else { 502 };
                Answer::Refused { status, message }
            }
            Err(error) => Answer::Refused { status: 502, message: format!("g1t's broker could not be reached: {error}") },
        }
    }
}

/// Writes g1t's answer to the client, its body in chunks.
fn write_answer(out: &mut impl Write, method: &str, answer: Answer) -> io::Result<()> {
    let (status, headers, mut body) = match answer {
        Answer::Refused { status, message } => return write_plain(out, status, &message),
        Answer::Relayed { status, headers, body } => (status, headers, body),
    };
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (name, value) in headers.iter().filter(|(name, _)| !hop_by_hop(name)) {
        // A header may not break the answer's framing.
        if !name.contains(['\r', '\n', ':']) && !value.contains(['\r', '\n']) {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    let bodiless = method.eq_ignore_ascii_case("HEAD") || status < 200 || status == 204 || status == 304;
    if bodiless {
        head.push_str("\r\n");
        out.write_all(head.as_bytes())?;
        return out.flush();
    }
    head.push_str("transfer-encoding: chunked\r\n\r\n");
    out.write_all(head.as_bytes())?;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = body.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        write!(out, "{read:x}\r\n")?;
        out.write_all(&buffer[..read])?;
        out.write_all(b"\r\n")?;
    }
    out.write_all(b"0\r\n\r\n")?;
    out.flush()
}

// --- Certificates --------------------------------------------------------------

/// The job's own certificate authority, and the certificates it made.
pub(crate) struct Authority {
    cert: rcgen::Certificate,
    key: rcgen::KeyPair,
    valid: (time::OffsetDateTime, time::OffsetDateTime),
    /// Each host's TLS configuration, made once.
    servers: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

impl Authority {
    /// A new authority that can sign for `hosts` alone, good for
    /// `valid_for` (the job's time, and a margin).
    pub(crate) fn new(hosts: &[String], valid_for: Duration) -> Result<Authority> {
        use rcgen::{BasicConstraints, CertificateParams, DistinguishedName, DnType, GeneralSubtree, IsCa, KeyPair, KeyUsagePurpose, NameConstraints};
        let now = time::OffsetDateTime::now_utc();
        let valid = (now - time::Duration::days(1), now + time::Duration::try_from(valid_for).unwrap_or(time::Duration::days(2)) + time::Duration::days(1));
        let key = KeyPair::generate().context("could not make a key")?;
        let mut params = CertificateParams::default();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "g1t brokered secrets for one job");
        name.push(DnType::OrganizationName, "g1t");
        params.distinguished_name = name;
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        (params.not_before, params.not_after) = valid;
        // It can sign for the brokered hosts and nothing else, so even its
        // key in other hands opens no other connection.
        let mut permitted: Vec<GeneralSubtree> = hosts
            .iter()
            .map(|host| host.trim().trim_start_matches("*.").to_ascii_lowercase())
            .filter(|host| !host.is_empty() && host.parse::<std::net::IpAddr>().is_err())
            .map(GeneralSubtree::DnsName)
            .collect();
        permitted.dedup();
        params.name_constraints = Some(NameConstraints { permitted_subtrees: permitted, excluded_subtrees: Vec::new() });
        let cert = params.self_signed(&key).context("could not make the job's certificate authority")?;
        Ok(Authority { cert, key, valid, servers: Mutex::new(HashMap::new()) })
    }

    /// The authority's certificate, which the job's tools trust.
    pub(crate) fn pem(&self) -> String {
        self.cert.pem()
    }

    #[cfg(test)]
    pub(crate) fn der(&self) -> CertificateDer<'static> {
        self.cert.der().clone()
    }

    /// The TLS configuration that answers as `host`.
    fn server(&self, host: &str) -> Result<Arc<ServerConfig>> {
        let mut servers = self.servers.lock().map_err(|_| anyhow!("the certificates' lock is poisoned"))?;
        if let Some(config) = servers.get(host) {
            return Ok(config.clone());
        }
        use rcgen::{CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose};
        let key = KeyPair::generate()?;
        let mut params = CertificateParams::new(vec![host.to_owned()])?;
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, host);
        params.distinguished_name = name;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        (params.not_before, params.not_after) = self.valid;
        let cert = params.signed_by(&key, &self.cert, &self.key)?;
        let private: PrivateKeyDer<'static> = PrivatePkcs8KeyDer::from(key.serialize_der()).into();
        let mut config = ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(vec![cert.der().clone(), self.cert.der().clone()], private)?;
        // HTTP/1.1, which is all the proxy reads.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = Arc::new(config);
        servers.insert(host.to_owned(), config.clone());
        Ok(config)
    }
}

/// How the proxy reaches a brokered host for a request without a stand-in:
/// the system's trusted certificates, or the ones rustls ships without them.
fn client_config(bundle: Option<&Path>) -> Result<Arc<ClientConfig>> {
    let mut roots = RootCertStore::empty();
    if let Some(bundle) = bundle
        && let Ok(found) = CertificateDer::pem_file_iter(bundle)
    {
        roots.add_parsable_certificates(found.filter_map(std::result::Result::ok));
    }
    if roots.is_empty() {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    let mut config = ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions()?.with_root_certificates(roots).with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

// --- The proxy -----------------------------------------------------------------

/// What every connection shares.
struct Shared {
    stand_ins: Vec<StandIn>,
    relay: Relay,
    authority: Authority,
    client: Arc<ClientConfig>,
    open: AtomicUsize,
}

impl Shared {
    fn brokered(&self, host: &str) -> bool {
        self.stand_ins.iter().any(|known| allows(&known.hosts, host))
    }
}

/// A connection with bytes already read from it put back in front.
struct Prefixed<S> {
    prefix: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S: Read> Read for Prefixed<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.at < self.prefix.len() {
            let n = buf.len().min(self.prefix.len() - self.at);
            buf[..n].copy_from_slice(&self.prefix[self.at..self.at + n]);
            self.at += n;
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

impl<S: Write> Write for Prefixed<S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// `host:port` of a `CONNECT`, the port 443 when it names none.
fn authority_of(target: &str) -> Option<(String, u16)> {
    let (host, port) = match target.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') => (host, port.parse().ok()?),
        _ => (target, 443),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (!host.is_empty()).then(|| (host.to_owned(), port))
}

fn connect(host: &str, port: u16) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, format!("{host} has no address"));
    for address in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&address, CONNECT_TIME) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Copies both ways until either side is done.
fn tunnel(client: TcpStream, prefix: Vec<u8>, upstream: TcpStream) -> io::Result<()> {
    let (mut client_in, mut upstream_out) = (client.try_clone()?, upstream.try_clone()?);
    upstream_out.write_all(&prefix)?;
    let up = std::thread::spawn(move || {
        let _ = io::copy(&mut client_in, &mut upstream_out);
        let _ = upstream_out.shutdown(Shutdown::Write);
    });
    let (mut upstream_in, mut client_out) = (upstream, client);
    let _ = io::copy(&mut upstream_in, &mut client_out);
    let _ = client_out.shutdown(Shutdown::Write);
    let _ = up.join();
    Ok(())
}

/// One connection to the proxy.
fn handle(stream: TcpStream, shared: &Shared) -> io::Result<()> {
    stream.set_read_timeout(Some(IDLE))?;
    stream.set_write_timeout(Some(IDLE))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let Some(head) = read_head(&mut reader)? else { return Ok(()) };
    let mut stream = stream;
    if !head.method.eq_ignore_ascii_case("CONNECT") {
        // Plain HTTP is never filled in, so it is not offered here: the
        // steps' HTTP_PROXY is left as the computer has it.
        return write_plain(&mut stream, 405, "this proxy takes HTTPS (CONNECT) only.");
    }
    let Some((host, port)) = authority_of(&head.target) else {
        return write_plain(&mut stream, 400, "the CONNECT target does not read.");
    };
    let prefix = reader.buffer().to_vec();
    if !shared.brokered(&host) {
        let upstream = match connect(&host, port) {
            Ok(upstream) => upstream,
            Err(error) => return write_plain(&mut stream, 502, &format!("{host} could not be reached: {error}")),
        };
        stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
        return tunnel(stream, prefix, upstream);
    }
    let config = match shared.authority.server(&normalize_host(&host)) {
        Ok(config) => config,
        Err(error) => return write_plain(&mut stream, 502, &format!("no certificate for {host}: {error}")),
    };
    stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?;
    let connection = ServerConnection::new(config).map_err(io::Error::other)?;
    let tls = StreamOwned::new(connection, Prefixed { prefix, at: 0, inner: stream });
    serve(tls, &host, port, shared)
}

/// The requests on a brokered host's connection, one after another.
fn serve<S: Read + Write>(tls: S, host: &str, port: u16, shared: &Shared) -> io::Result<()> {
    let mut reader = BufReader::new(tls);
    loop {
        let Some(head) = read_head(&mut reader)? else { return Ok(()) };
        if head.header("expect").is_some_and(|expect| expect.eq_ignore_ascii_case("100-continue")) {
            reader.get_mut().write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
            reader.get_mut().flush()?;
        }
        let body = match read_body(&mut reader, &head) {
            Ok(body) => body,
            Err(error) if too_large(&error) => return write_plain(reader.get_mut(), 413, &error.to_string()),
            Err(error) => return Err(error),
        };
        if !carries(&head.target, &head.headers, &shared.stand_ins) {
            // Nothing of g1t's to fill in: straight to the host, and the
            // client opens a new connection for its next request.
            return direct(reader.get_mut(), &head, &body, host, port, &shared.client);
        }
        let url = url_of(host, port, &head.target);
        let headers: Vec<(String, String)> = head.headers.iter().filter(|(name, _)| !hop_by_hop(name) && !name.eq_ignore_ascii_case("host")).cloned().collect();
        let answer = shared.relay.send(&head.method, &url, &headers, &body);
        write_answer(reader.get_mut(), &head.method, answer)?;
        if head.closes() {
            return Ok(());
        }
    }
}

/// The URL a request on a tunnel to `host:port` is for. A target written
/// in full names its path only: the tunnel's host is the one the client
/// asked for and the certificate was made for.
fn url_of(host: &str, port: u16, target: &str) -> String {
    let path = match target.split_once("://") {
        Some((_, rest)) => rest.find('/').map_or("/", |at| &rest[at..]),
        None if target.starts_with('/') => target,
        None => "/",
    };
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_owned() };
    if port == 443 { format!("https://{host}{path}") } else { format!("https://{host}:{port}{path}") }
}

/// Sends a request without a stand-in to its host as it came, over a
/// connection of its own that closes after the answer.
fn direct(client: &mut impl Write, head: &Head, body: &[u8], host: &str, port: u16, config: &Arc<ClientConfig>) -> io::Result<()> {
    let name = match ServerName::try_from(host.to_owned()) {
        Ok(name) => name,
        Err(_) => return write_plain(client, 400, &format!("{host} is not a host name")),
    };
    let upstream = match connect(host, port) {
        Ok(upstream) => upstream,
        Err(error) => return write_plain(client, 502, &format!("{host} could not be reached: {error}")),
    };
    upstream.set_read_timeout(Some(IDLE))?;
    let connection = ClientConnection::new(config.clone(), name).map_err(io::Error::other)?;
    let mut tls = StreamOwned::new(connection, upstream);
    let mut request = format!("{} {} HTTP/1.1\r\n", head.method, head.target);
    for (name, value) in head.headers.iter().filter(|(name, _)| !hop_by_hop(name)) {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() || !matches!(head.method.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS" | "DELETE") {
        request.push_str(&format!("content-length: {}\r\n", body.len()));
    }
    request.push_str("connection: close\r\n\r\n");
    tls.write_all(request.as_bytes())?;
    tls.write_all(body)?;
    tls.flush()?;
    match io::copy(&mut tls, client) {
        // A host that closes without saying so has still answered.
        Err(error) if error.kind() != io::ErrorKind::UnexpectedEof => return Err(error),
        _ => {}
    }
    client.flush()
}

/// The proxy, running.
pub(crate) struct Proxy {
    pub(crate) port: u16,
}

fn listen(shared: Shared) -> Result<Proxy> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).context("could not listen on 127.0.0.1")?;
    let port = listener.local_addr()?.port();
    let shared = Arc::new(shared);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if shared.open.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                continue;
            }
            shared.open.fetch_add(1, Ordering::SeqCst);
            let shared = shared.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &shared);
                shared.open.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Ok(Proxy { port })
}

/// The proxy for `stand_ins`, and the variables the job's steps get:
/// `HTTPS_PROXY` and the trusted-certificate files, written to `folder`.
/// `env` is the steps' own environment, whose certificate files are kept
/// in what they are pointed at.
pub(crate) fn start(stand_ins: Vec<StandIn>, relay: Relay, folder: &Path, env: &BTreeMap<String, String>, valid_for: Duration) -> Result<(Proxy, Vec<(String, String)>)> {
    let hosts: Vec<String> = stand_ins.iter().flat_map(|known| known.hosts.iter().cloned()).collect();
    let authority = Authority::new(&hosts, valid_for)?;
    std::fs::create_dir_all(folder).context("could not make the certificates' folder")?;
    let pem = authority.pem();
    let system = system_bundle(env);
    let client = client_config(system.as_deref())?;
    let proxy = listen(Shared { stand_ins, relay, authority, client, open: AtomicUsize::new(0) })?;
    let mut vars = trust_variables(folder, &pem, env, system.as_deref())?;
    let address = format!("http://127.0.0.1:{}", proxy.port);
    vars.push(("HTTPS_PROXY".into(), address.clone()));
    vars.push(("https_proxy".into(), address));
    // Node's own fetch and https take a proxy from these only when asked.
    vars.push(("NODE_USE_ENV_PROXY".into(), "1".into()));
    // Loopback never goes through it, unless the steps already say what doesn't.
    if !env.contains_key("NO_PROXY") && !env.contains_key("no_proxy") {
        vars.push(("NO_PROXY".into(), "localhost,127.0.0.1,::1".into()));
        vars.push(("no_proxy".into(), "localhost,127.0.0.1,::1".into()));
    }
    Ok((proxy, vars))
}

/// The bundle of certificates the steps trust today: `SSL_CERT_FILE`, or
/// the system's.
fn system_bundle(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env.get("SSL_CERT_FILE").map(PathBuf::from).into_iter().chain(SYSTEM_BUNDLES.iter().map(PathBuf::from)).find(|path| path.is_file())
}

/// The trusted-certificate variables: each pointed at what it pointed at
/// before (or the system's bundle) with the job's authority added, written
/// once per source. Without a bundle to add to, only `NODE_EXTRA_CA_CERTS`,
/// which adds to Node's own.
fn trust_variables(folder: &Path, pem: &str, env: &BTreeMap<String, String>, system: Option<&Path>) -> Result<Vec<(String, String)>> {
    let mut written: HashMap<PathBuf, PathBuf> = HashMap::new();
    let mut vars = Vec::new();
    let mut add_to = |source: &Path, name: &str| -> Result<String> {
        if let Some(out) = written.get(source) {
            return Ok(out.display().to_string());
        }
        let mut combined = std::fs::read(source).with_context(|| format!("could not read {}", source.display()))?;
        if !combined.ends_with(b"\n") && !combined.is_empty() {
            combined.push(b'\n');
        }
        combined.extend_from_slice(pem.as_bytes());
        let out = folder.join(format!("{}-{}.pem", written.len() + 1, name.to_ascii_lowercase()));
        std::fs::write(&out, combined)?;
        written.insert(source.to_owned(), out.clone());
        Ok(out.display().to_string())
    };
    for name in BUNDLE_VARIABLES {
        let own = env.get(*name).map(PathBuf::from).filter(|path| path.is_file());
        if let Some(source) = own.as_deref().or(system) {
            vars.push(((*name).to_owned(), add_to(source, name)?));
        }
    }
    let authority = folder.join("g1t-broker-ca.pem");
    std::fs::write(&authority, pem)?;
    let node = match env.get("NODE_EXTRA_CA_CERTS").map(PathBuf::from).filter(|path| path.is_file()) {
        Some(own) => add_to(&own, "NODE_EXTRA_CA_CERTS")?,
        None => authority.display().to_string(),
    };
    vars.push(("NODE_EXTRA_CA_CERTS".into(), node));
    Ok(vars)
}

/// The names of the variables `start` sets, which a container a step
/// starts (a Docker action, a service) does not get: the proxy is on this
/// harness's own loopback, out of their reach.
pub(crate) fn names(vars: &[(String, String)]) -> impl Iterator<Item = String> + '_ {
    vars.iter().map(|(name, _)| name.clone())
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::sync::mpsc;

    use rustls::pki_types::ServerName;
    use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
    use serde_json::{Value, json};

    use super::*;

    const STAND_IN: &str = "g1tsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn npm() -> StandIn {
        StandIn { stand_in: STAND_IN.into(), name: "NPM_TOKEN".into(), hosts: vec!["registry.npmjs.org".into(), "*.example.com".into()] }
    }

    #[test]
    fn the_spec_gives_stand_ins_and_hosts() {
        let spec = json!({ "brokered": [
            { "stand_in": STAND_IN, "name": "NPM_TOKEN", "hosts": ["registry.npmjs.org", "*.example.com"] },
            { "stand_in": "not-a-stand-in", "name": "X", "hosts": ["x.example.com"] },
            { "stand_in": "g1tsec_b", "name": "NO_HOSTS", "hosts": [] },
        ] });
        assert_eq!(stand_ins(&spec), vec![npm()]);
        assert!(stand_ins(&json!({})).is_empty());
    }

    #[test]
    fn hosts_match_as_g1t_reads_them() {
        let hosts = npm().hosts;
        assert!(allows(&hosts, "registry.npmjs.org"));
        assert!(allows(&hosts, "Registry.NPMJS.org.:443"));
        assert!(allows(&hosts, "a.b.example.com"));
        assert!(!allows(&hosts, "example.com"), "a wildcard is not its own apex");
        assert!(!allows(&hosts, "evil-example.com"));
        assert!(!allows(&hosts, "registry.npmjs.org.evil.com"));
        assert_eq!(normalize_host("[::1]:443"), "[::1]");
        assert_eq!(authority_of("registry.npmjs.org:443"), Some(("registry.npmjs.org".into(), 443)));
        assert_eq!(authority_of("[::1]:8443"), Some(("::1".into(), 8443)));
        assert_eq!(authority_of("example.com"), Some(("example.com".into(), 443)));
        assert_eq!(url_of("registry.npmjs.org", 443, "/pkg?x=1"), "https://registry.npmjs.org/pkg?x=1");
        assert_eq!(url_of("localhost", 8443, "/"), "https://localhost:8443/");
        assert_eq!(url_of("::1", 443, "/a"), "https://[::1]/a");
        // A full URL inside the tunnel cannot send the request elsewhere.
        assert_eq!(url_of("registry.npmjs.org", 443, "https://evil.example/steal?t=1"), "https://registry.npmjs.org/steal?t=1");
    }

    #[test]
    fn stand_ins_are_found_in_the_target_headers_and_basic_credentials() {
        let known = [npm()];
        let header = |name: &str, value: &str| vec![(name.to_owned(), value.to_owned())];
        assert!(carries(&format!("/pkg?token={STAND_IN}"), &[], &known));
        assert!(carries("/pkg", &header("authorization", &format!("Bearer {STAND_IN}")), &known));
        let basic = format!("Basic {}", BASE64.encode(format!("me:{STAND_IN}")));
        assert!(carries("/pkg", &header("authorization", &basic), &known));
        assert!(!carries("/pkg", &header("authorization", "Bearer g1tsec_other"), &known));
    }

    #[test]
    fn only_unix_without_a_proxy_of_its_own_brokers() {
        assert_eq!(possible(|_| None), cfg!(unix));
        assert!(!possible(|name| (name == "HTTPS_PROXY").then(|| "http://corp:3128".into())));
        assert_eq!(possible(|name| (name == "https_proxy").then(String::new)), cfg!(unix));
    }

    #[test]
    fn heads_and_bodies_read_by_length_or_in_chunks_within_limits() {
        let mut input = BufReader::new(&b"\r\nPOST /a HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nT: 1\r\n\r\nGET /b HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi"[..]);
        let head = read_head(&mut input).unwrap().unwrap();
        assert_eq!((head.method.as_str(), head.target.as_str()), ("POST", "/a"));
        assert_eq!(read_body(&mut input, &head).unwrap(), b"abcde");
        let next = read_head(&mut input).unwrap().unwrap();
        assert_eq!(read_body(&mut input, &next).unwrap(), b"hi");
        assert!(read_head(&mut input).unwrap().is_none());

        let big = format!("PUT / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        let mut input = BufReader::new(big.as_bytes());
        let head = read_head(&mut input).unwrap().unwrap();
        assert!(too_large(&read_body(&mut input, &head).unwrap_err()));
        let long = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD_BYTES));
        assert!(read_head(&mut BufReader::new(long.as_bytes())).is_err());
        assert!(Head { method: "GET".into(), target: "/".into(), version: "HTTP/1.0".into(), headers: vec![] }.closes());
    }

    #[test]
    fn the_authority_signs_only_for_the_brokered_hosts_and_the_leaf_is_trusted() {
        let authority = Authority::new(&["localhost".into(), "*.example.com".into()], Duration::from_secs(3600)).unwrap();
        assert!(authority.pem().starts_with("-----BEGIN CERTIFICATE-----"));
        let config = authority.server("localhost").unwrap();
        assert!(Arc::ptr_eq(&config, &authority.server("localhost").unwrap()), "made once per host");

        // A handshake as `host`, with a client that trusts the authority.
        let handshake = |host: &str| -> Result<(), String> {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = authority.server(host).unwrap();
            let serving = std::thread::spawn(move || {
                let stream = listener.incoming().flatten().next().unwrap();
                let mut tls = StreamOwned::new(rustls::ServerConnection::new(server).unwrap(), stream);
                let _ = tls.write_all(b"x");
            });
            let mut roots = RootCertStore::empty();
            roots.add(authority.der()).unwrap();
            let config = ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
            let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let mut tls = StreamOwned::new(ClientConnection::new(Arc::new(config), ServerName::try_from(host.to_owned()).unwrap()).unwrap(), stream);
            let mut byte = [0; 1];
            let read = tls.read_exact(&mut byte).map_err(|error| error.to_string());
            let _ = serving.join();
            read
        };
        assert_eq!(handshake("localhost"), Ok(()));
        assert_eq!(handshake("a.example.com"), Ok(()));
        // Its key can sign for another host, but nothing that trusts it accepts that.
        let refused = handshake("bank.test").unwrap_err();
        assert!(refused.to_lowercase().contains("name"), "{refused}");
    }

    /// A stand-in for g1t's broker: answers each request with the body it
    /// was given, its status and headers in `x-g1t-broker-response`, and
    /// tells the test what it was asked.
    /// What the fake g1t heard: a request's headers and body.
    type Heard = mpsc::Receiver<(Vec<(String, String)>, Vec<u8>)>;

    fn fake_g1t(answer_status: u16) -> (String, Heard) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tell, heard) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let head = read_head(&mut reader).unwrap().unwrap();
                let body = read_body(&mut reader, &head).unwrap();
                tell.send((head.headers.clone(), body.clone())).unwrap();
                let answer = BASE64.encode(json!({ "status": answer_status, "headers": [["content-type", "text/plain"], ["x-from", "upstream"]] }).to_string());
                let mut stream = stream;
                let reply = format!("HTTP/1.1 200 OK\r\n{ANSWER_HEADER}: {answer}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len() + 4);
                stream.write_all(reply.as_bytes()).unwrap();
                stream.write_all(b"got ").unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (base, heard)
    }

    fn proxy_for(base: &str, stand_ins: Vec<StandIn>, client: Arc<ClientConfig>) -> (Proxy, Arc<ClientConfig>) {
        let api = Api { base: base.into(), job: "job_1".into(), token: "current-token".into() };
        let hosts: Vec<String> = stand_ins.iter().flat_map(|s| s.hosts.clone()).collect();
        let authority = Authority::new(&hosts, Duration::from_secs(3600)).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(authority.der()).unwrap();
        let trusting = ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
        let proxy = listen(Shared { stand_ins, relay: Relay::new(&api), authority, client, open: AtomicUsize::new(0) }).unwrap();
        (proxy, Arc::new(trusting))
    }

    /// Opens `host:port` through the proxy with CONNECT.
    fn through(proxy: &Proxy, target: &str) -> TcpStream {
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        write!(stream, "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("HTTP/1.1 200"), "{line}");
        reader.read_line(&mut line).unwrap();
        stream
    }

    fn read_all(mut reader: impl Read) -> String {
        let mut text = Vec::new();
        let _ = reader.read_to_end(&mut text);
        String::from_utf8_lossy(&text).into_owned()
    }

    #[test]
    fn a_request_with_a_stand_in_goes_to_g1t_and_its_answer_comes_back() {
        let (base, heard) = fake_g1t(201);
        let known = StandIn { stand_in: STAND_IN.into(), name: "NPM_TOKEN".into(), hosts: vec!["localhost".into()] };
        let (proxy, trusting) = proxy_for(&base, vec![known], client_config(None).unwrap());
        let stream = through(&proxy, "localhost:8443");
        let connection = ClientConnection::new(trusting, ServerName::try_from("localhost").unwrap()).unwrap();
        let mut tls = StreamOwned::new(connection, stream);
        write!(tls, "POST /publish?x=1 HTTP/1.1\r\nHost: localhost:8443\r\nAuthorization: Bearer {STAND_IN}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello").unwrap();
        let answer = read_all(&mut tls);
        assert!(answer.starts_with("HTTP/1.1 201 Created\r\n"), "{answer}");
        assert!(answer.contains("x-from: upstream\r\n") && answer.contains("transfer-encoding: chunked"), "{answer}");
        assert!(answer.contains("got hello"), "{answer}");

        let (headers, body) = heard.recv().unwrap();
        assert_eq!(body, b"hello");
        let header = |name: &str| headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        assert_eq!(header("authorization").as_deref(), Some("Bearer current-token"), "the job's token in a header");
        let wanted: Value = serde_json::from_slice(&BASE64.decode(header(REQUEST_HEADER).unwrap()).unwrap()).unwrap();
        assert_eq!(wanted["method"], "POST");
        assert_eq!(wanted["url"], "https://localhost:8443/publish?x=1");
        let sent: Vec<(String, String)> = serde_json::from_value(wanted["headers"].clone()).unwrap();
        assert!(sent.contains(&("Authorization".into(), format!("Bearer {STAND_IN}"))), "the stand-in, never a value: {sent:?}");
        assert!(!sent.iter().any(|(n, _)| n.eq_ignore_ascii_case("host") || n.eq_ignore_ascii_case("connection") || n.eq_ignore_ascii_case("content-length")));
    }

    #[test]
    fn g1t_s_refusal_reaches_the_client_as_it_said_it() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let head = read_head(&mut reader).unwrap().unwrap();
                read_body(&mut reader, &head).unwrap();
                let body = r#"{"error":{"code":"forbidden","message":"not for this host"}}"#;
                write!(stream, "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let api = Api { base, job: "job_1".into(), token: "t".into() };
        match Relay::new(&api).send("GET", "https://localhost/", &[], b"") {
            Answer::Refused { status, message } => assert_eq!((status, message.as_str()), (403, "not for this host")),
            Answer::Relayed { .. } => panic!("refused"),
        }
        // g1t out of reach: a bad gateway, saying so.
        let api = Api { base: "http://127.0.0.1:1".into(), job: "job_1".into(), token: "t".into() };
        assert!(matches!(Relay::new(&api).send("GET", "https://localhost/", &[], b""), Answer::Refused { status: 502, .. }));
    }

    #[test]
    fn other_hosts_are_tunnelled_untouched_and_plain_http_is_refused() {
        let echo = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in echo.incoming().flatten() {
                let mut buffer = [0; 5];
                stream.read_exact(&mut buffer).unwrap();
                stream.write_all(&buffer).unwrap();
            }
        });
        let (proxy, _) = proxy_for("http://127.0.0.1:1", vec![npm()], client_config(None).unwrap());
        let mut stream = through(&proxy, &format!("127.0.0.1:{port}"));
        stream.write_all(b"bytes").unwrap();
        let mut back = [0; 5];
        stream.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"bytes");

        let mut plain = TcpStream::connect(("127.0.0.1", proxy.port)).unwrap();
        plain.write_all(b"GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n").unwrap();
        assert!(read_all(plain).starts_with("HTTP/1.1 405"));
    }

    #[test]
    fn a_request_without_a_stand_in_goes_straight_to_the_host() {
        // The host: TLS with a certificate of its own authority.
        let host_ca = Authority::new(&["localhost".into()], Duration::from_secs(3600)).unwrap();
        let host_config = host_ca.server("localhost").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tell, heard) = mpsc::channel();
        std::thread::spawn(move || {
            let stream = listener.incoming().flatten().next().unwrap();
            let connection = rustls::ServerConnection::new(host_config).unwrap();
            let mut tls = BufReader::new(StreamOwned::new(connection, stream));
            let head = read_head(&mut tls).unwrap().unwrap();
            tell.send(head).unwrap();
            tls.get_mut().write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ndirect").unwrap();
            tls.get_mut().conn.send_close_notify();
            let _ = tls.get_mut().flush();
        });
        let mut roots = RootCertStore::empty();
        roots.add(host_ca.der()).unwrap();
        let upstream = Arc::new(ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth());
        let known = StandIn { stand_in: STAND_IN.into(), name: "NPM_TOKEN".into(), hosts: vec!["localhost".into()] };
        let (proxy, trusting) = proxy_for("http://127.0.0.1:1", vec![known], upstream);
        let stream = through(&proxy, &format!("localhost:{port}"));
        let connection = ClientConnection::new(trusting, ServerName::try_from("localhost").unwrap()).unwrap();
        let mut tls = StreamOwned::new(connection, stream);
        write!(tls, "GET /public HTTP/1.1\r\nHost: localhost\r\nAccept: */*\r\n\r\n").unwrap();
        let answer = read_all(&mut tls);
        assert!(answer.starts_with("HTTP/1.1 200 OK") && answer.ends_with("direct"), "{answer}");
        let head = heard.recv().unwrap();
        assert_eq!(head.target, "/public");
        assert_eq!(head.header("connection"), Some("close"));
    }

    #[test]
    fn the_steps_trust_the_authority_beside_what_they_trusted_before() {
        let folder = std::env::temp_dir().join(format!("g1t-broker-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let system = folder.join("system.pem");
        std::fs::write(&system, "SYSTEM\n").unwrap();
        let own = folder.join("own.pem");
        std::fs::write(&own, "OWN").unwrap();
        let env: BTreeMap<String, String> = [("REQUESTS_CA_BUNDLE".to_owned(), own.display().to_string())].into_iter().collect();
        let vars: BTreeMap<String, String> = trust_variables(&folder, "AUTHORITY\n", &env, Some(&system)).unwrap().into_iter().collect();
        assert_eq!(std::fs::read_to_string(&vars["SSL_CERT_FILE"]).unwrap(), "SYSTEM\nAUTHORITY\n");
        assert_eq!(vars["SSL_CERT_FILE"], vars["GIT_SSL_CAINFO"], "one file per source");
        assert_eq!(std::fs::read_to_string(&vars["REQUESTS_CA_BUNDLE"]).unwrap(), "OWN\nAUTHORITY\n");
        assert_eq!(std::fs::read_to_string(&vars["NODE_EXTRA_CA_CERTS"]).unwrap(), "AUTHORITY\n");
        // Without a bundle, Node's alone.
        let vars = trust_variables(&folder, "AUTHORITY\n", &BTreeMap::new(), None).unwrap();
        assert_eq!(vars.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["NODE_EXTRA_CA_CERTS"]);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
