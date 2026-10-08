//! Git over HTTPS: the smart HTTP remote at `/<namespace>/<repo>.git`,
//! proxied to the git store with a short-lived token.

use std::cell::RefCell;
use std::rc::Rc;

use futures_util::StreamExt;
use g1t_contracts::identity::GitCredentialsArgs;
use g1t_contracts::repos::{GitAccess, GitService, RepoPath};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use worker::js_sys::Uint8Array;
use worker::wasm_bindgen::JsValue;
use worker::{Fetch, Fetcher, Headers, Method, Request, RequestInit, Response, Result, Url};

use crate::meters;
use crate::pack_limits::{PackSizer, Violation};
use crate::resilience::{self, Busy, Failure};

const ENDPOINTS: [&str; 3] = ["info/refs", "git-upload-pack", "git-receive-pack"];
const FORWARDED_HEADERS: [&str; 5] = [
    "accept",
    "content-encoding",
    "content-type",
    "git-protocol",
    "user-agent",
];

/// A git request, parsed from its URL.
pub struct GitRequest {
    pub path: RepoPath,
    pub endpoint: &'static str,
    pub service: GitService,
}

impl GitRequest {
    /// The same request for the repository of the same name under
    /// `namespace`: where a workspace alias leads.
    pub fn under(&self, namespace: &str) -> GitRequest {
        GitRequest {
            path: RepoPath {
                namespace: namespace.to_owned(),
                name: self.path.name.clone(),
            },
            endpoint: self.endpoint,
            service: self.service,
        }
    }
}

/// Parses `/<namespace>/<name>[.git]/<endpoint>`, or returns `None` if the
/// request is not git's.
pub fn parse(url: &Url) -> Option<GitRequest> {
    let path = url.path().strip_prefix('/')?;
    let endpoint = ENDPOINTS
        .into_iter()
        .find(|endpoint| path.ends_with(&format!("/{endpoint}")))?;
    let repo = &path[..path.len() - endpoint.len() - 1];
    let (namespace, name) = repo.split_once('/')?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    if namespace.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    let service = if endpoint == "info/refs" {
        url.query_pairs()
            .find(|(key, _)| key == "service")
            .map(|(_, value)| value.into_owned())?
    } else {
        endpoint.to_owned()
    };
    let service = match service.as_str() {
        "git-upload-pack" => GitService::UploadPack,
        "git-receive-pack" => GitService::ReceivePack,
        _ => return None,
    };
    Some(GitRequest {
        path: RepoPath {
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        },
        endpoint,
        service,
    })
}

/// How long each step of a git request took, sent back to git as a
/// `Server-Timing` header so that a slow clone shows where its time went.
/// Step names and whole milliseconds only. The Workers clock moves only
/// while a request waits on something, so each step is the time spent
/// waiting on the database, another service or the git store. A note
/// says how a step went without a duration: `refs;desc=hit-colo`.
pub struct Timing {
    started: u64,
    last: u64,
    steps: Vec<(&'static str, u64)>,
    notes: Vec<(&'static str, &'static str)>,
}

impl Timing {
    pub fn start() -> Self {
        let now = g1t_kit::now_ms();
        Self {
            started: now,
            last: now,
            steps: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Says how `name` went: where an answer or a credential came from.
    pub fn note(&mut self, name: &'static str, description: &'static str) {
        self.notes.push((name, description));
    }

    /// Ends a step, named `step`, that began when the last one ended.
    pub fn mark(&mut self, step: &'static str) {
        let now = g1t_kit::now_ms();
        self.steps.push((step, now.saturating_sub(self.last)));
        self.last = now;
    }

    /// `response`, with how long each step took.
    pub fn apply(&self, response: Response) -> Result<Response> {
        let total = g1t_kit::now_ms().saturating_sub(self.started);
        let headers = response.headers().clone();
        headers.set("server-timing", &server_timing(&self.steps, &self.notes, total))?;
        Ok(response.with_headers(headers))
    }
}

/// A `Server-Timing` value: each step with its duration, the notes, then
/// the total.
fn server_timing(steps: &[(&str, u64)], notes: &[(&str, &str)], total: u64) -> String {
    steps
        .iter()
        .map(|(step, ms)| format!("{step};dur={ms}"))
        .chain(notes.iter().map(|(name, description)| format!("{name};desc={description}")))
        .chain(std::iter::once(format!("total;dur={total}")))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The user named by an HTTP Basic `Authorization` header, as git sends it.
pub async fn viewer(request: &Request, identity: &Fetcher) -> Result<Viewer> {
    let Some(header) = request.headers().get("authorization")? else {
        return Ok(None);
    };
    let Some((scheme, encoded)) = header.split_once(' ') else {
        return Ok(None);
    };
    if !scheme.eq_ignore_ascii_case("basic") {
        return Ok(None);
    }
    let Some(decoded) = decode_base64(encoded.trim()) else {
        return Ok(None);
    };
    let Some((username, secret)) = decoded.split_once(':') else {
        return Ok(None);
    };
    g1t_kit::call(
        identity,
        "user_for_git_credentials",
        &GitCredentialsArgs {
            username: username.to_owned(),
            secret: secret.to_owned(),
        },
    )
    .await
}

/// Standard base64 to a UTF-8 string, or `None` if either step fails.
fn decode_base64(input: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in input.bytes().filter(|byte| *byte != b'=') {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    String::from_utf8(bytes).ok()
}

/// The response for a refused git request. Anonymous callers are asked to
/// authenticate, which is what makes git prompt for credentials.
pub fn refuse<T>(outcome: Outcome<T>) -> Result<Response> {
    let Outcome::Fail(failure) = outcome else {
        return Response::error("Not found", 404);
    };
    let mut response = Response::error(failure.message, failure.code.http_status())?;
    if failure.code == FailureCode::Unauthenticated {
        response
            .headers_mut()
            .set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

/// `url` with its first path segment, the workspace, replaced by `slug`.
pub fn with_namespace(url: &Url, slug: &str) -> Option<String> {
    let rest = url.path().strip_prefix('/')?.split_once('/')?.1;
    let mut moved = url.clone();
    moved.set_path(&format!("/{slug}/{rest}"));
    Some(moved.to_string())
}

/// Where a git request for a renamed workspace's old address should go
/// now, if its first segment is an old slug that still redirects.
pub async fn renamed(url: &Url, identity: &Fetcher) -> Result<Option<String>> {
    let Some(old) = url.path().strip_prefix('/').and_then(|path| path.split('/').next()) else {
        return Ok(None);
    };
    let current: Option<String> = g1t_kit::call(
        identity,
        "resolve_slug",
        &g1t_contracts::identity::SlugArgs {
            slug: old.to_owned(),
        },
    )
    .await?;
    Ok(current.and_then(|slug| with_namespace(url, &slug)))
}

/// The request under the workspace its first segment is an alias of
/// (identity's aliases.rs: `g1t` for `flagon-io`), if it is one. Answered
/// in place rather than redirected: a push does not follow a redirect.
pub async fn aliased(git: &GitRequest, identity: &Fetcher) -> Result<Option<GitRequest>> {
    let slug: Option<String> = g1t_kit::call(
        identity,
        "resolve_alias",
        &g1t_contracts::identity::SlugArgs {
            slug: git.path.namespace.clone(),
        },
    )
    .await?;
    Ok(slug.map(|slug| git.under(&slug)))
}

/// `url` with its repository, the first two path segments, replaced by
/// `to`: where a request for a transferred repository's old path goes.
/// Keeps whether the old address ended in `.git`.
pub fn transferred(url: &Url, to: &RepoPath) -> Option<String> {
    let path = url.path().strip_prefix('/')?;
    let mut segments = path.splitn(3, '/');
    let (_, name, rest) = (segments.next()?, segments.next()?, segments.next()?);
    let suffix = if name.ends_with(".git") { ".git" } else { "" };
    let mut moved = url.clone();
    moved.set_path(&format!("/{}/{}{suffix}/{rest}", to.namespace, to.name));
    Some(moved.to_string())
}

/// A permanent redirect: 301 for git's first request for refs, which it
/// follows and then uses the new address for the rest; 308 for the
/// others, so a POST stays a POST.
pub fn moved(location: &str, get: bool) -> Result<Response> {
    let mut response = Response::empty()?.with_status(if get { 301 } else { 308 });
    response.headers_mut().set("location", location)?;
    Ok(response)
}

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
const HEADS: &str = "refs/heads/";
const TAGS: &str = "refs/tags/";

/// One ref a push asks to change.
struct Command {
    old: String,
    new: String,
    name: String,
}

/// The commands at the start of a receive-pack request, and the
/// capabilities the client sent with the first of them.
fn commands(body: &[u8]) -> (Vec<Command>, String) {
    let mut commands = Vec::new();
    let mut capabilities = String::new();
    let mut position = 0;
    // Commands are pkt-lines; a flush packet ends them and the pack follows.
    while let Some(length) = body
        .get(position..position + 4)
        .and_then(|hex| std::str::from_utf8(hex).ok())
        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
    {
        if length < 4 || position + length > body.len() {
            break;
        }
        let line = &body[position + 4..position + length];
        position += length;
        // `<old> <new> <ref>`, and on the first command a NUL then capabilities.
        let mut halves = line.splitn(2, |byte| *byte == 0);
        let command = halves.next().unwrap_or_default();
        if let Some(rest) = halves.next() {
            capabilities = String::from_utf8_lossy(rest).trim().to_owned();
        }
        let Ok(command) = std::str::from_utf8(command) else {
            continue;
        };
        let mut parts = command.trim_end().splitn(3, ' ');
        if let (Some(old), Some(new), Some(name)) = (parts.next(), parts.next(), parts.next()) {
            commands.push(Command {
                old: old.to_owned(),
                new: new.to_owned(),
                name: name.to_owned(),
            });
        }
    }
    (commands, capabilities)
}

/// The bytes of the pack a receive-pack request carries: everything after
/// the flush packet that ends its commands. Zero for a push that only
/// deletes refs.
pub(crate) fn pack_bytes(body: &[u8]) -> u64 {
    let mut position = 0;
    while let Some(length) = body
        .get(position..position + 4)
        .and_then(|hex| std::str::from_utf8(hex).ok())
        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
    {
        if length == 0 {
            return (body.len() - position - 4) as u64;
        }
        if length < 4 || position + length > body.len() {
            break;
        }
        position += length;
    }
    0
}

fn pkt_line(payload: &[u8]) -> Vec<u8> {
    let mut line = format!("{:04x}", payload.len() + 4).into_bytes();
    line.extend_from_slice(payload);
    line
}

/// What git is told when a push would change a protected branch: every ref
/// in it is declined, with the reason against the protected one, so that
/// git prints it beside the branch. `None` if the push leaves the branch
/// alone, or creates it in a repository that does not have it yet.
fn refusal(body: &[u8], protected: &str) -> Option<Vec<u8>> {
    let (commands, capabilities) = commands(body);
    let reference = format!("{HEADS}{protected}");
    if !commands
        .iter()
        .any(|command| command.name == reference && command.old != ZERO_ID)
    {
        return None;
    }
    let mut report = pkt_line(b"unpack ok\n");
    for command in &commands {
        let reason = if command.name == reference {
            format!("{protected} is protected: push a branch and open a pull request")
        } else {
            format!("not pushed, because the same push would change {protected}")
        };
        report.extend(pkt_line(
            format!("ng {} {reason}\n", command.name).as_bytes(),
        ));
    }
    report.extend_from_slice(b"0000");
    Some(framed(report, &capabilities, &[]))
}

/// A report-status as git expects it: inside channel 1 when the client
/// asked for side-band, after `messages` on channel 2, which git prints as
/// `remote:` lines. Without side-band the messages cannot be shown.
fn framed(report: Vec<u8>, capabilities: &str, messages: &[String]) -> Vec<u8> {
    let sideband = capabilities
        .split(' ')
        .any(|capability| capability.starts_with("side-band"));
    if !sideband {
        return report;
    }
    let mut body = Vec::new();
    for message in messages {
        let mut packet = vec![2u8];
        packet.extend_from_slice(message.as_bytes());
        packet.push(b'\n');
        body.extend(pkt_line(&packet));
    }
    // side-band (not -64k) packets carry at most 1000 bytes.
    for chunk in report.chunks(990) {
        let mut packet = vec![1u8];
        packet.extend_from_slice(chunk);
        body.extend(pkt_line(&packet));
    }
    body.extend_from_slice(b"0000");
    body
}

/// Declines every ref in a push with `reason`, explaining why in
/// `messages`: what push protection answers when a push adds a secret.
pub fn declined(body: &[u8], reason: &str, messages: &[String]) -> Result<Response> {
    let (commands, capabilities) = commands(body);
    let mut report = pkt_line(b"unpack ok\n");
    for command in &commands {
        report.extend(pkt_line(format!("ng {} {reason}\n", command.name).as_bytes()));
    }
    report.extend_from_slice(b"0000");
    let headers = Headers::new();
    headers.set("content-type", "application/x-git-receive-pack-result")?;
    headers.set("cache-control", "no-cache")?;
    Ok(Response::from_bytes(framed(report, &capabilities, messages))?.with_headers(headers))
}

/// A branch or tag a push asks to move.
#[derive(Debug, PartialEq, Eq)]
pub struct Pushed {
    /// The full ref: `refs/heads/main`, `refs/tags/v1`.
    pub git_ref: String,
    /// Where it pointed before; `None` for a new ref.
    pub before: Option<String>,
    pub after: String,
}

impl Pushed {
    pub fn branch(&self) -> Option<&str> {
        self.git_ref.strip_prefix(HEADS)
    }
}

/// The branches and tags a push asks to move, read from the commands at the
/// start of a receive-pack request. Deletions and other refs are left out.
fn pushed_branches(body: &[u8]) -> Vec<Pushed> {
    commands(body)
        .0
        .into_iter()
        .filter(|command| command.new != ZERO_ID)
        .filter(|command| command.name.starts_with(HEADS) || command.name.starts_with(TAGS))
        .map(|Command { old, new, name }| Pushed {
            git_ref: name,
            before: (old != ZERO_ID).then_some(old),
            after: new,
        })
        .collect()
}

/// The git store's answer, and what the request asked it to change.
pub struct Forwarded {
    pub response: Response,
    /// For a push: the branches and tags it asks to move, and the commits
    /// to move them to. Whether each moved is for the caller to confirm.
    pub pushed: Vec<Pushed>,
    /// For a push: the size of the pack it sent, for the storage meter.
    pub pack_bytes: u64,
    /// The bytes sent to the store.
    pub sent: u64,
    /// Whether the answer is the store's own (not g1t's, for a store that
    /// was busy).
    pub from_store: bool,
    /// For a push: whether it was too large to scan for secrets first and
    /// was streamed to the store unscanned (`LargePushes::Unscanned`). Its
    /// `git.push` events say so, and security scans it after it lands.
    pub unscanned: bool,
}

/// What became of a git request.
pub enum Push {
    Forwarded(Forwarded),
    /// A push to a protected branch, answered here without reaching the store.
    Refused(Response),
    /// A push that adds a secret nobody allowed, answered the same way.
    Blocked(Response),
    /// A push the store could not hold: an object or the repository too
    /// large, or too large to check. With the reason, for the audit log.
    Declined(Response, String),
}

/// What a push may bring, checked as it arrives (pack_limits.rs).
#[derive(Clone, Copy, Debug)]
pub struct PushLimits {
    /// The largest object the store holds.
    pub max_object: u64,
    /// What the repository holds now, as g1t counts it.
    pub held: u64,
    /// The most a repository may hold.
    pub repo_limit: u64,
    /// The largest push that is read whole and scanned for secrets.
    pub scan_cap: usize,
    /// What happens to a larger one.
    pub large: LargePushes,
}

impl Default for PushLimits {
    fn default() -> Self {
        PushLimits {
            max_object: crate::pack_limits::MAX_OBJECT_BYTES,
            held: 0,
            repo_limit: crate::pack_limits::DEFAULT_REPO_LIMIT_BYTES,
            scan_cap: crate::secret_scan::MAX_SCANNED_PUSH,
            large: LargePushes::Refuse,
        }
    }
}

/// What happens to a push larger than [`PushLimits::scan_cap`]: set by
/// `LARGE_PUSHES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LargePushes {
    /// Declined (the default): push protection cannot read it, so it does
    /// not let it in.
    Refuse,
    /// Streamed to the store without a scan for secrets; the size limits are
    /// still checked as it passes.
    Unscanned,
}

impl LargePushes {
    pub fn from_var(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("unscanned") => LargePushes::Unscanned,
            _ => LargePushes::Refuse,
        }
    }
}

/// A push the store could not hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SizeViolation {
    Object { size: u64 },
    Repository { held: u64, incoming: u64, limit: u64 },
    Unscannable { size: u64, cap: usize },
}

/// Why a push is declined for its size, as git shows it: the `ng` reason,
/// and the lines printed as `remote:`.
pub fn size_refusal(violation: &SizeViolation) -> (String, Vec<String>) {
    use crate::pack_limits::{MAX_OBJECT_BYTES, PLATFORM_BODY_LIMIT_BYTES, megabytes};
    match violation {
        SizeViolation::Object { size } => (
            format!("a file of {} is over the {} limit", megabytes(*size), megabytes(MAX_OBJECT_BYTES)),
            vec![
                format!("g1t stores files of up to {} each; this push has one of {}.", megabytes(MAX_OBJECT_BYTES), megabytes(*size)),
                "Take it out of the commits (git rm --cached, then amend or rebase), and keep large".to_owned(),
                "files elsewhere: https://docs.g1t.sh/guides/git/#size-limits. Nothing was pushed.".to_owned(),
            ],
        ),
        SizeViolation::Repository { held, incoming, limit } => (
            "the repository would be over its size limit".to_owned(),
            vec![
                format!(
                    "This repository holds about {} and the push adds {}, past the {} a repository may hold.",
                    megabytes(*held),
                    megabytes(*incoming),
                    megabytes(*limit)
                ),
                "Delete what you no longer need, or split it: https://docs.g1t.sh/guides/git/#size-limits.".to_owned(),
                "Nothing was pushed.".to_owned(),
            ],
        ),
        SizeViolation::Unscannable { size, cap } => (
            "the push is too large to check for secrets".to_owned(),
            vec![
                format!(
                    "g1t checks every push for secrets and reads up to {} at once; this one is {}.",
                    megabytes(*cap as u64),
                    megabytes(*size)
                ),
                "Push in parts, oldest commits first, then push as usual:".to_owned(),
                "  git rev-list --reverse HEAD | awk 'NR % 500 == 0' | xargs -I{} git push origin {}:refs/heads/main".to_owned(),
                format!("A push over {} is refused by the network before it reaches g1t (HTTP 413).", megabytes(PLATFORM_BODY_LIMIT_BYTES)),
                "See https://docs.g1t.sh/guides/git/#size-limits. Nothing was pushed.".to_owned(),
            ],
        ),
    }
}

/// Feeds the next chunk of a push to the size check; the first violation.
fn check_size(sizer: &mut Option<PackSizer>, chunk: &[u8], limits: &PushLimits) -> Option<SizeViolation> {
    let walker = sizer.as_mut()?;
    match walker.feed(chunk) {
        Ok(()) => {}
        Err(Violation::ObjectTooLarge { size }) => return Some(SizeViolation::Object { size }),
        Err(Violation::Malformed(why)) => {
            // Not for g1t to judge: the store will say.
            worker::console_error!("push not checked for size: {why}");
            *sizer = None;
            return None;
        }
    }
    let incoming = walker.pack_bytes();
    crate::pack_limits::over_repo_limit(limits.held, incoming, limits.repo_limit).then_some(SizeViolation::Repository {
        held: limits.held,
        incoming,
        limit: limits.repo_limit,
    })
}

/// A request body that streams from `stream`, for `fetch`.
pub(crate) fn stream_body<S>(stream: S) -> Result<JsValue>
where
    S: futures_util::TryStream + 'static,
    S::Ok: Into<Vec<u8>>,
    S::Error: Into<worker::Error>,
{
    let response: worker::web_sys::Response = Response::from_stream(stream)?.into();
    Ok(response.body().map_or(JsValue::NULL, Into::into))
}

/// What git is told when the store is busy: 429 or 503, with when to try
/// again (resilience.rs).
pub fn busy_response(busy: Busy) -> Result<Response> {
    let response = Response::error(busy.message(), busy.status())?;
    response.headers().set("retry-after", &busy.retry_after.to_string())?;
    Ok(response)
}

/// The rest of a request's body, read and thrown away so that git hears
/// the answer; how many bytes it was.
async fn drain(stream: &mut worker::ByteStream) -> Result<u64> {
    let mut size = 0;
    while let Some(chunk) = stream.next().await {
        size += chunk?.len() as u64;
    }
    Ok(size)
}

/// One packet of a pkt-line stream: data, or a flush (`0000`), delimiter
/// (`0001`) or response-end (`0002`) packet, kept as its four bytes.
#[derive(Debug, PartialEq, Eq)]
enum Packet {
    Data(Vec<u8>),
    Special([u8; 4]),
}

/// The packets in `bytes`, or `None` if it is not a whole pkt-line stream.
fn packets(bytes: &[u8]) -> Option<Vec<Packet>> {
    let mut out = Vec::new();
    let mut position = 0;
    while position < bytes.len() {
        let header = bytes.get(position..position + 4)?;
        let length = usize::from_str_radix(std::str::from_utf8(header).ok()?, 16).ok()?;
        if length < 4 {
            out.push(Packet::Special(header.try_into().ok()?));
            position += 4;
            continue;
        }
        out.push(Packet::Data(bytes.get(position + 4..position + length)?.to_vec()));
        position += length;
    }
    Some(out)
}

fn encode(packets: &[Packet]) -> Vec<u8> {
    let mut out = Vec::new();
    for packet in packets {
        match packet {
            Packet::Data(data) => out.extend(pkt_line(data)),
            Packet::Special(bytes) => out.extend_from_slice(bytes),
        }
    }
    out
}

/// A ref advertisement (`info/refs` for upload-pack) or a protocol v2
/// `ls-refs` answer with `HEAD` pointing at `branch`, the repository's
/// default branch as g1t keeps it, so a clone checks it out. The git store
/// holds the HEAD it was created with; g1t can change the default branch
/// since. `None` when there is nothing to change: no `HEAD` line, `HEAD`
/// already names `branch`, or `branch` is not advertised.
pub fn with_head(body: &[u8], branch: &str) -> Option<Vec<u8>> {
    let mut packets = packets(body)?;
    let target = format!("{HEADS}{branch}");
    let oid = packets.iter().find_map(|packet| {
        let Packet::Data(data) = packet else { return None };
        let line = data.split(|byte| *byte == 0).next()?;
        let line = std::str::from_utf8(line).ok()?.trim_end();
        let (oid, name) = line.split_once(' ')?;
        // v2 lines may carry attributes after the name.
        let name = name.split(' ').next()?;
        (name == target).then(|| oid.to_owned())
    })?;
    let mut changed = false;
    for packet in &mut packets {
        let Packet::Data(data) = packet else { continue };
        let text = String::from_utf8_lossy(data).into_owned();
        let Some((_, rest)) = text.split_once(' ') else { continue };
        if !(rest.starts_with("HEAD\0") || rest.starts_with("HEAD\n") || rest.starts_with("HEAD ") || rest == "HEAD") {
            continue;
        }
        let mut line = format!("{oid} {rest}");
        // v0: `symref=HEAD:refs/heads/<old>` among the capabilities.
        // v2: `symref-target:refs/heads/<old>` after the name.
        for marker in ["symref=HEAD:", "symref-target:"] {
            if let Some(at) = line.find(marker) {
                let start = at + marker.len();
                let end = line[start..]
                    .find([' ', '\n', '\0'])
                    .map_or(line.len(), |offset| start + offset);
                line.replace_range(start..end, &target);
            }
        }
        changed = line != text;
        if changed {
            *data = line.into_bytes();
        }
        break;
    }
    changed.then(|| encode(&packets))
}

/// Whether a request to the git store is one whose answer names `HEAD`:
/// the ref advertisement for a fetch, or a protocol v2 `ls-refs`.
fn names_head(git: &GitRequest, body: Option<&[u8]>) -> bool {
    if git.service != GitService::UploadPack {
        return false;
    }
    match body {
        None => git.endpoint == "info/refs",
        Some(body) => {
            git.endpoint == "git-upload-pack"
                && body.windows(b"command=ls-refs".len()).any(|window| window == b"command=ls-refs")
        }
    }
}

/// Whether a request is a protocol v2 `fetch` still negotiating: it sends
/// `have` lines and no `done`, so the answer may be acknowledgments only.
fn negotiating(body: &[u8]) -> bool {
    let Some(packets) = packets(body) else { return false };
    let lines: Vec<&[u8]> = packets
        .iter()
        .filter_map(|packet| match packet {
            Packet::Data(data) => Some(data.strip_suffix(b"\n").unwrap_or(data)),
            Packet::Special(_) => None,
        })
        .collect();
    lines.contains(&b"command=fetch".as_slice())
        && lines.iter().any(|line| line.starts_with(b"have "))
        && !lines.contains(&b"done".as_slice())
}

/// What to do with the start of a store's answer to a negotiating fetch.
#[derive(Debug, PartialEq, Eq)]
enum Acknowledged {
    /// Not enough of it yet to tell.
    NeedMore,
    /// Send it on as it is.
    Whole,
    /// Acknowledgments without `ready`, followed by more sections: the
    /// store's answer to keep is these first bytes, ended by a flush.
    CutAt(usize),
}

/// How much of the answer to keep. The git store answers a fetch whose
/// `have`s it does not know with `acknowledgments`, `NAK`, then a pack
/// anyway; git refuses that ("expected no other sections to be sent after
/// no 'ready'"), since a server that is not ready must end the response
/// there and let the client negotiate again. Lines may be `sideband-all`
/// framed (band 1, `\x01`).
fn acknowledged(head: &[u8]) -> Acknowledged {
    let mut position = 0;
    let mut first = true;
    loop {
        let Some(header) = head.get(position..position + 4) else { return Acknowledged::NeedMore };
        let Some(length) = std::str::from_utf8(header).ok().and_then(|hex| usize::from_str_radix(hex, 16).ok()) else {
            return Acknowledged::Whole;
        };
        if length < 4 {
            // The acknowledgments section's end: a delimiter means more
            // sections follow, which only `ready` allows.
            return match (first, header) {
                (false, b"0001") => Acknowledged::CutAt(position),
                _ => Acknowledged::Whole,
            };
        }
        let Some(payload) = head.get(position + 4..position + length) else { return Acknowledged::NeedMore };
        let line = payload.strip_prefix(b"\x01").unwrap_or(payload);
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        if first && line != b"acknowledgments" {
            return Acknowledged::Whole;
        }
        if line == b"ready" {
            return Acknowledged::Whole;
        }
        first = false;
        position += length;
    }
}

/// The answer to a negotiating fetch, with the sections the store sent
/// after acknowledgments without `ready` left off (see [`acknowledged`]).
/// Reads only the start of the answer; the rest streams through.
async fn without_early_pack(mut response: Response) -> Result<Response> {
    const LOOK: usize = 64 * 1024;
    let headers = response.headers().clone();
    headers.delete("content-length")?;
    let mut stream = response.stream()?;
    let mut head = Vec::new();
    loop {
        match acknowledged(&head) {
            Acknowledged::CutAt(at) => {
                head.truncate(at);
                // A flush ends the acknowledgments and the answer. No
                // response-end packet: git's HTTP transport adds its own
                // and refuses one from the server.
                head.extend_from_slice(b"0000");
                return Ok(Response::from_bytes(head)?.with_headers(headers));
            }
            Acknowledged::Whole => break,
            Acknowledged::NeedMore if head.len() >= LOOK => break,
            Acknowledged::NeedMore => match stream.next().await {
                Some(chunk) => head.extend_from_slice(&chunk?),
                None => break,
            },
        }
    }
    let rest = futures_util::stream::once(async move { Ok::<Vec<u8>, worker::Error>(head) }).chain(stream);
    Ok(Response::from_stream(rest)?.with_headers(headers))
}

/// Sends the request on to the git store and returns its response as is,
/// unless it is a push that would change the `protected` branch, one the
/// store could not hold (`limits`, pack_limits.rs), or one that `scan`
/// (push protection) answers itself. A fetch's ref listing has its `HEAD`
/// pointed at `default_branch` (see [`with_head`]). A POST's body is
/// `read` when the caller has read it already.
///
/// A push is read as it arrives: up to `limits.scan_cap` is kept, to be
/// scanned and sent on whole; past it, the push is declined, or streamed
/// to the store unscanned (`LargePushes`), never held. Reads the store
/// fails for a moment (429, 5xx) are tried again with backoff; a push never
/// is. A store still busy after that is answered 429 or 503 with
/// `Retry-After`.
#[allow(clippy::too_many_arguments)]
pub async fn forward(
    mut request: Request,
    read: Option<Vec<u8>>,
    git: &GitRequest,
    access: &GitAccess,
    protected: Option<&str>,
    default_branch: Option<&str>,
    limits: PushLimits,
    scan: impl AsyncFnOnce(&[u8]) -> Result<Option<Response>>,
) -> Result<Push> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {}", access.token))?;
    for name in FORWARDED_HEADERS {
        if let Some(value) = request.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    let query = request.url()?.query().map(|query| format!("?{query}")).unwrap_or_default();
    let url = format!("{}/{}{query}", access.remote, git.endpoint);
    let method = request.method();
    // Its own health and breaker: the fallback store's apart from Artifacts'.
    let namespace = crate::store::health_namespace(&access.remote);

    if method == Method::Post && git.endpoint == "git-receive-pack" {
        return push(request, &url, headers, protected, limits, scan, &namespace).await;
    }

    // A read: the ref advertisement, `ls-refs`, or a fetch of objects.
    let body = match (&method, read) {
        (Method::Post, Some(body)) => Some(body),
        (Method::Post, None) => Some(request.bytes().await?),
        _ => None,
    };
    let lists_head = match &body {
        None => method == Method::Get && names_head(git, None),
        Some(body) => names_head(git, Some(body)),
    };
    let sent = body.as_ref().map_or(0, |body| body.len() as u64);
    let mut attempt = 0;
    let mut response = loop {
        let mut init = RequestInit::new();
        init.with_method(method.clone()).with_headers(headers.clone());
        if let Some(body) = &body {
            init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
        }
        let started = g1t_kit::now_ms();
        let answered = Fetch::Request(Request::new_with_init(&url, &init)?).send().await;
        let ms = g1t_kit::now_ms().saturating_sub(started);
        let failure = match &answered {
            Ok(response) => resilience::classify_status(response.status_code()),
            Err(_) => Some(Failure::Transient),
        };
        let outcome = match failure {
            None => meters::Outcome::Ok,
            Some(Failure::RateLimited) => meters::Outcome::RateLimited,
            Some(_) => meters::Outcome::Failed,
        };
        meters::record_health(&namespace, outcome, ms);
        match (answered, failure) {
            (Ok(response), None) => break response,
            (answered, Some(failure)) if resilience::retry(failure, attempt) => {
                drop(answered);
                let wait = resilience::backoff_ms(failure, attempt, worker::js_sys::Math::random());
                worker::Delay::from(std::time::Duration::from_millis(wait)).await;
                attempt += 1;
            }
            (_, Some(failure)) => {
                let busy = Busy { rate_limited: failure == Failure::RateLimited, retry_after: 5, read_only: false };
                return Ok(Push::Forwarded(Forwarded {
                    response: busy_response(busy)?,
                    pushed: Vec::new(),
                    pack_bytes: 0,
                    sent,
                    from_store: false,
                    unscanned: false,
                }));
            }
            (Err(error), None) => return Err(error),
        }
    };
    if let (true, Some(branch)) = (lists_head, default_branch)
        && response.status_code() == 200
    {
        let headers = response.headers().clone();
        headers.delete("content-length")?;
        let body = response.bytes().await?;
        let body = with_head(&body, branch).unwrap_or(body);
        response = Response::from_bytes(body)?.with_headers(headers);
    }
    if git.endpoint == "git-upload-pack"
        && response.status_code() == 200
        && body.as_deref().is_some_and(negotiating)
    {
        response = without_early_pack(response).await?;
    }
    Ok(Push::Forwarded(Forwarded {
        response,
        pushed: Vec::new(),
        pack_bytes: 0,
        sent,
        from_store: true,
        unscanned: false,
    }))
}

/// A receive-pack request; see [`forward`].
#[allow(clippy::too_many_arguments)]
async fn push(
    mut request: Request,
    url: &str,
    headers: Headers,
    protected: Option<&str>,
    limits: PushLimits,
    scan: impl AsyncFnOnce(&[u8]) -> Result<Option<Response>>,
    namespace: &str,
) -> Result<Push> {
    let mut stream = request.stream()?;
    let mut head: Vec<u8> = Vec::new();
    let mut sizer = Some(PackSizer::new(limits.max_object));
    let mut violation = None;
    let mut ended = false;
    while head.len() <= limits.scan_cap {
        match stream.next().await {
            Some(chunk) => {
                let chunk = chunk?;
                if violation.is_none() {
                    violation = check_size(&mut sizer, &chunk, &limits);
                }
                head.extend_from_slice(&chunk);
            }
            None => {
                ended = true;
                break;
            }
        }
    }
    let report_headers = || -> Result<Headers> {
        let headers = Headers::new();
        headers.set("content-type", "application/x-git-receive-pack-result")?;
        headers.set("cache-control", "no-cache")?;
        Ok(headers)
    };
    if let Some(report) = protected.and_then(|branch| refusal(&head, branch)) {
        if !ended {
            drain(&mut stream).await?;
        }
        return Ok(Push::Refused(Response::from_bytes(report)?.with_headers(report_headers()?)));
    }
    if !ended && limits.large == LargePushes::Refuse && violation.is_none() {
        let size = head.len() as u64 + drain(&mut stream).await?;
        violation = Some(SizeViolation::Unscannable { size, cap: limits.scan_cap });
        ended = true;
    }
    if let Some(violation) = violation {
        if !ended {
            drain(&mut stream).await?;
        }
        let (reason, messages) = size_refusal(&violation);
        return Ok(Push::Declined(declined(&head, &reason, &messages)?, reason));
    }
    let pushed = pushed_branches(&head);
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers);
    let started = g1t_kit::now_ms();
    let (answered, pack_bytes, sent, unscanned) = if ended {
        if let Some(response) = scan(&head).await? {
            return Ok(Push::Blocked(response));
        }
        let pack = pack_bytes(&head);
        let sent = head.len() as u64;
        init.with_body(Some(Uint8Array::from(head.as_slice()).into()));
        drop(head);
        (Fetch::Request(Request::new_with_init(url, &init)?).send().await, pack, sent, false)
    } else {
        // Larger than can be scanned, and let through unscanned: streamed,
        // with the size limits checked as it passes. A violation ends the
        // stream before the pack does, so the store refuses it whole.
        worker::console_warn!("a push of more than {} bytes goes to the store unscanned", limits.scan_cap);
        let commands = head.iter().take(64 * 1024).copied().collect::<Vec<u8>>();
        let found: Rc<RefCell<Option<SizeViolation>>> = Rc::default();
        let walked = Rc::new(RefCell::new((sizer, 0u64)));
        let rest = {
            let found = found.clone();
            let walked = walked.clone();
            stream.map(move |chunk| {
                let chunk = chunk?;
                let mut walked = walked.borrow_mut();
                walked.1 += chunk.len() as u64;
                if let Some(violation) = check_size(&mut walked.0, &chunk, &limits) {
                    *found.borrow_mut() = Some(violation);
                    return Err(worker::Error::RustError("push over the size limit".into()));
                }
                Ok(chunk)
            })
        };
        let first = head.len() as u64;
        let body = futures_util::stream::once(async move { Ok::<Vec<u8>, worker::Error>(head) }).chain(rest);
        init.with_body(Some(stream_body(body)?));
        let answered = Fetch::Request(Request::new_with_init(url, &init)?).send().await;
        if let Some(violation) = found.borrow_mut().take() {
            let (reason, messages) = size_refusal(&violation);
            return Ok(Push::Declined(declined(&commands, &reason, &messages)?, reason));
        }
        let walked = walked.borrow();
        let pack = walked.0.as_ref().map_or_else(|| pack_bytes(&commands), PackSizer::pack_bytes);
        (answered, pack, first + walked.1, true)
    };
    let ms = g1t_kit::now_ms().saturating_sub(started);
    let failure = match &answered {
        Ok(response) => resilience::classify_status(response.status_code()),
        Err(_) => Some(Failure::Transient),
    };
    meters::record_health(
        namespace,
        match failure {
            None => meters::Outcome::Ok,
            Some(Failure::RateLimited) => meters::Outcome::RateLimited,
            Some(_) => meters::Outcome::Failed,
        },
        ms,
    );
    // A push is never tried again: the store may have taken it.
    let response = match (answered, failure) {
        (Ok(response), None) => response,
        (Ok(response), Some(Failure::RateLimited)) => {
            drop(response);
            busy_response(Busy { rate_limited: true, retry_after: 5, read_only: false })?
        }
        (Ok(response), Some(_)) => response,
        (Err(error), _) => {
            worker::console_error!("a push did not reach the store: {error}");
            busy_response(Busy { rate_limited: false, retry_after: 5, read_only: false })?
        }
    };
    Ok(Push::Forwarded(Forwarded {
        response,
        pushed,
        pack_bytes,
        sent,
        from_store: true,
        unscanned,
    }))
}

#[cfg(test)]
mod tests {
    use super::{Acknowledged, GitService, Pushed, RepoPath, Url, ZERO_ID, acknowledged, framed, negotiating, pack_bytes, parse, pushed_branches, refusal, server_timing, transferred, with_head, with_namespace};

    #[test]
    fn server_timing_names_each_step_and_the_total() {
        assert_eq!(
            server_timing(&[("repo", 12), ("token", 0), ("store", 140)], &[], 153),
            "repo;dur=12, token;dur=0, store;dur=140, total;dur=153"
        );
        assert_eq!(server_timing(&[], &[], 3), "total;dur=3");
        assert_eq!(
            server_timing(&[("repo", 1), ("cache", 2)], &[("refs", "hit-colo")], 4),
            "repo;dur=1, cache;dur=2, refs;desc=hit-colo, total;dur=4"
        );
    }

    #[test]
    fn a_renamed_repository_redirects_to_its_new_name() {
        // A rename keeps the old path in the same table as a transfer, so
        // the old remote is sent to the new name the same way.
        let to = RepoPath {
            namespace: "acme".into(),
            name: "booster".into(),
        };
        let url = Url::parse("https://g1t.sh/acme/rocket.git/info/refs?service=git-upload-pack").unwrap();
        assert_eq!(
            transferred(&url, &to).as_deref(),
            Some("https://g1t.sh/acme/booster.git/info/refs?service=git-upload-pack")
        );
    }

    #[test]
    fn head_follows_the_default_branch_in_a_v0_advertisement() {
        let main = "1111111111111111111111111111111111111111";
        let trunk = "2222222222222222222222222222222222222222";
        let body = [
            pkt("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt(&format!("{main} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2\n")),
            pkt(&format!("{main} refs/heads/main\n")),
            pkt(&format!("{trunk} refs/heads/trunk\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let changed = String::from_utf8(with_head(&body, "trunk").unwrap()).unwrap();
        assert!(changed.contains(&format!("{trunk} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n")));
        assert!(changed.contains(&format!("{main} refs/heads/main\n")));
        assert!(changed.starts_with("001e# service=git-upload-pack\n0000"));
        // Already right, or a branch it does not have: left alone.
        assert!(with_head(&body, "main").is_none());
        assert!(with_head(&body, "gone").is_none());
    }

    #[test]
    fn head_follows_the_default_branch_in_a_v2_listing() {
        let main = "1111111111111111111111111111111111111111";
        let trunk = "2222222222222222222222222222222222222222";
        let body = [
            pkt(&format!("{main} HEAD symref-target:refs/heads/main\n")),
            pkt(&format!("{main} refs/heads/main\n")),
            pkt(&format!("{trunk} refs/heads/trunk\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let changed = String::from_utf8(with_head(&body, "trunk").unwrap()).unwrap();
        assert!(changed.starts_with(&String::from_utf8(pkt(&format!("{trunk} HEAD symref-target:refs/heads/trunk\n"))).unwrap()));
        assert!(changed.ends_with("0000"));
        // Without symrefs asked for, only the commit changes.
        let plain = [pkt(&format!("{main} HEAD\n")), pkt(&format!("{trunk} refs/heads/trunk\n")), b"0000".to_vec()].concat();
        let changed = String::from_utf8(with_head(&plain, "trunk").unwrap()).unwrap();
        assert!(changed.starts_with(&format!("0032{trunk} HEAD\n")));
    }

    #[test]
    fn a_push_is_measured_by_the_pack_after_its_commands() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let pack = b"PACK\0\0\0\x02\0\0\0\0rest-of-pack";
        let body = [
            pkt(&format!("{old} {new} refs/heads/main\0 report-status\n")),
            b"0000".to_vec(),
            pack.to_vec(),
        ]
        .concat();
        assert_eq!(pack_bytes(&body), pack.len() as u64);
        // Only deletions: no pack.
        let body = [pkt(&format!("{old} {ZERO_ID} refs/heads/gone\n")), b"0000".to_vec()].concat();
        assert_eq!(pack_bytes(&body), 0);
        assert_eq!(pack_bytes(b"garbage"), 0);
    }

    #[test]
    fn a_transferred_repository_keeps_the_rest_of_the_address() {
        let to = RepoPath {
            namespace: "flagon-io".into(),
            name: "g1t".into(),
        };
        let url = Url::parse("https://g1t.sh/syntaqx/g1t.git/info/refs?service=git-receive-pack").unwrap();
        assert_eq!(
            transferred(&url, &to).as_deref(),
            Some("https://g1t.sh/flagon-io/g1t.git/info/refs?service=git-receive-pack")
        );
        let url = Url::parse("https://g1t.sh/syntaqx/g1t/git-upload-pack").unwrap();
        assert_eq!(
            transferred(&url, &to).as_deref(),
            Some("https://g1t.sh/flagon-io/g1t/git-upload-pack")
        );
    }

    #[test]
    fn an_alias_is_answered_as_its_workspaces_repository() {
        for (address, service) in [
            ("https://g1t.sh/g1t/g1t.git/info/refs?service=git-upload-pack", GitService::UploadPack),
            ("https://g1t.sh/g1t/g1t.git/git-receive-pack", GitService::ReceivePack),
            ("https://g1t.sh/g1t/g1t/git-upload-pack", GitService::UploadPack),
        ] {
            let git = parse(&Url::parse(address).unwrap()).unwrap();
            assert_eq!(git.path.namespace, "g1t", "{address}");
            let canonical = git.under("flagon-io");
            assert_eq!(
                canonical.path,
                RepoPath {
                    namespace: "flagon-io".into(),
                    name: "g1t".into(),
                },
                "{address}"
            );
            assert_eq!(canonical.service, service);
            assert_eq!(canonical.endpoint, git.endpoint);
        }
    }

    #[test]
    fn a_renamed_workspace_keeps_the_rest_of_the_address() {
        let url = worker::Url::parse(
            "https://g1t.sh/acme/rocket.git/info/refs?service=git-upload-pack",
        )
        .unwrap();
        assert_eq!(
            with_namespace(&url, "acme-inc").as_deref(),
            Some("https://g1t.sh/acme-inc/rocket.git/info/refs?service=git-upload-pack")
        );
        let bare = worker::Url::parse("https://g1t.sh/acme").unwrap();
        assert_eq!(with_namespace(&bare, "acme-inc"), None);
    }

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    fn joined(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn a_fetch_with_haves_and_no_done_is_negotiating() {
        let request = |lines: &[&str]| {
            let mut body = joined(&[&pkt("command=fetch\n"), &pkt("object-format=sha1\n"), b"0001"]);
            for line in lines {
                body.extend(pkt(&format!("{line}\n")));
            }
            body.extend(b"0000");
            body
        };
        let want = "want 8407eba58b925619274d012258c2b474a5dbf012";
        let have = "have 55cd670a89a80df4fa9d9f0244c44fbd2ed1db8b";
        assert!(negotiating(&request(&["deepen 1", want, have])));
        assert!(!negotiating(&request(&[want, have, "done"])));
        assert!(!negotiating(&request(&[want, "done"])));
        let ls_refs = joined(&[&pkt("command=ls-refs\n"), b"0001", &pkt("have nothing\n"), b"0000"]);
        assert!(!negotiating(&ls_refs));
    }

    #[test]
    fn acknowledgments_without_ready_end_the_answer() {
        // What the store sent a shallow fetch whose only `have` it did not
        // know, sideband-all framed: a NAK, then a pack anyway.
        let answer = joined(&[
            &pkt("\x01acknowledgments\n"),
            &pkt("\x01NAK\n"),
            b"0001",
            &pkt("\x01shallow-info\n"),
            &pkt("\x01shallow 8407eba58b925619274d012258c2b474a5dbf012\n"),
            b"0001",
            &pkt("\x01packfile\n"),
        ]);
        let cut = joined(&[&pkt("\x01acknowledgments\n"), &pkt("\x01NAK\n")]).len();
        assert_eq!(acknowledged(&answer), Acknowledged::CutAt(cut));
        // Not yet at the section's end.
        assert_eq!(acknowledged(&answer[..cut - 2]), Acknowledged::NeedMore);
        assert_eq!(acknowledged(&answer[..cut]), Acknowledged::NeedMore);
        // Without sideband framing too.
        let plain = joined(&[&pkt("acknowledgments\n"), &pkt("ACK abc\n"), b"0001", &pkt("packfile\n")]);
        assert!(matches!(acknowledged(&plain), Acknowledged::CutAt(_)));
    }

    #[test]
    fn a_ready_store_or_a_plain_pack_streams_through() {
        let ready = joined(&[
            &pkt("\x01acknowledgments\n"),
            &pkt("\x01ACK bab14ff1b6d9c4918100098009747d776759a967\n"),
            &pkt("\x01ready\n"),
            b"0001",
            &pkt("\x01packfile\n"),
        ]);
        assert_eq!(acknowledged(&ready), Acknowledged::Whole);
        // Acknowledgments only, ended by a flush: already right.
        let only = joined(&[&pkt("acknowledgments\n"), &pkt("NAK\n"), b"0000"]);
        assert_eq!(acknowledged(&only), Acknowledged::Whole);
        let pack = joined(&[&pkt("\x01packfile\n"), b"0000"]);
        assert_eq!(acknowledged(&pack), Acknowledged::Whole);
        assert_eq!(acknowledged(b"00"), Acknowledged::NeedMore);
    }

    #[test]
    fn pushed_branches_are_read_from_the_commands() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let body = [
            pkt(&format!(
                "{old} {new} refs/heads/main\0 report-status side-band-64k\n"
            )),
            pkt(&format!("{ZERO_ID} {new} refs/heads/feature/x\n")),
            pkt(&format!("{old} {ZERO_ID} refs/heads/gone\n")),
            pkt(&format!("{ZERO_ID} {new} refs/tags/v1\n")),
            b"0000".to_vec(),
            b"PACK\0\0\0\x02\0\0\0\0".to_vec(),
        ]
        .concat();
        assert_eq!(
            pushed_branches(&body),
            [
                Pushed {
                    git_ref: "refs/heads/main".to_owned(),
                    before: Some(old.to_owned()),
                    after: new.to_owned()
                },
                Pushed {
                    git_ref: "refs/heads/feature/x".to_owned(),
                    before: None,
                    after: new.to_owned()
                },
                Pushed {
                    git_ref: "refs/tags/v1".to_owned(),
                    before: None,
                    after: new.to_owned()
                },
            ]
        );
    }

    #[test]
    fn a_push_to_a_protected_branch_is_declined_with_the_reason() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let body = [
            pkt(&format!("{old} {new} refs/heads/main\0 report-status\n")),
            pkt(&format!("{ZERO_ID} {new} refs/heads/feature\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let report = String::from_utf8(refusal(&body, "main").unwrap()).unwrap();
        assert!(report.starts_with("000eunpack ok\n"));
        assert!(report.contains("ng refs/heads/main main is protected"));
        assert!(report.contains("ng refs/heads/feature not pushed"));
        assert!(report.ends_with("0000"));
    }

    #[test]
    fn the_report_is_framed_for_a_client_that_asked_for_side_band() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let body = [
            pkt(&format!(
                "{old} {ZERO_ID} refs/heads/main\0 report-status side-band-64k\n"
            )),
            b"0000".to_vec(),
        ]
        .concat();
        let report = refusal(&body, "main").unwrap();
        // A length, then channel 1, then the report itself.
        assert_eq!(report[4], 1);
        assert_eq!(&report[5..18], b"000eunpack ok");
        assert!(report.ends_with(b"00000000"));
    }

    #[test]
    fn other_branches_and_a_first_push_are_let_through() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let feature = [
            pkt(&format!("{old} {new} refs/heads/feature\0 report-status\n")),
            b"0000".to_vec(),
        ]
        .concat();
        assert!(refusal(&feature, "main").is_none());
        // An empty repository has to be able to receive its first commits.
        let first = [
            pkt(&format!(
                "{ZERO_ID} {new} refs/heads/main\0 report-status\n"
            )),
            b"0000".to_vec(),
        ]
        .concat();
        assert!(refusal(&first, "main").is_none());
    }

    #[test]
    fn a_blocked_push_explains_itself_on_the_progress_channel() {
        let report = b"000eunpack ok\n0000".to_vec();
        let messages = vec!["g1t found a secret in this push, so nothing was pushed.".to_owned()];
        let body = framed(report.clone(), "report-status side-band-64k", &messages);
        // Channel 2 first, which git prints as `remote:` lines.
        assert_eq!(body[4], 2);
        assert!(String::from_utf8_lossy(&body).contains("so nothing was pushed.\n"));
        let at = body.windows(5).position(|w| w == b"000eu").unwrap();
        assert_eq!(body[at - 1], 1);
        assert!(body.ends_with(b"0000"));
        // A client without side-band gets the bare report.
        assert_eq!(framed(report.clone(), "report-status", &messages), report);
    }

    #[test]
    fn a_fetch_request_names_no_branches() {
        assert!(
            pushed_branches(b"0032want c71546fcd893ef8b0f57388b65e620d759705dda\n0000").is_empty()
        );
    }
}
