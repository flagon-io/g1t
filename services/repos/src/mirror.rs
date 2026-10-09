//! Copying every branch and tag from one git server to another: importing a
//! repository with a credential, keeping a mirror in step with the host it
//! mirrors, pushing a repository's refs out to a host it is mirrored to,
//! and moving chosen refs either way when a takeover is handed back (see
//! `g1t_contracts::mirrors`).
//!
//! Like landing (see `land.rs`), this speaks git's smart HTTP protocol and
//! relays the pack it receives unchanged. Both sides are asked for their
//! refs; the source is asked for one pack holding what the target lacks;
//! the target is sent one push that moves every ref that differs.
//!
//! Nothing a mirror held is lost silently: when catching up moves a branch
//! somewhere its old commit is not part of (a force-push or deletion on the
//! remote), the old commit is kept under `refs/g1t/replaced/`, for at
//! least [`REPLACED_KEPT_DAYS`] days.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use futures_util::StreamExt;
use worker::js_sys::Uint8Array;
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use g1t_contracts::repos::{
    GitAccess, MirrorApplied, MirrorApplyArgs, MirrorArgs, MirrorDirection, MirrorRefs, MirrorRefsArgs, Mirrored, RefMoved,
    Repo, SetMirrorArgs,
};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;

use crate::land::{push_ref, read_pkt_lines, unpack_sideband};
use crate::registry::store_key;
use crate::store::{GitRepo, GitStore, Scope};
use crate::{Repos, descends_from, import, not_found};

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
/// The most a pack may hold. A Worker holds it in memory while relaying it.
pub const MAX_PACK_BYTES: usize = 40 * 1024 * 1024;
/// How many of the target's commits are named to the source as already
/// had, so a sync only carries what is new.
const MAX_HAVES: usize = 256;
const USER_AGENT: &str = "git/2.45.0 (g1t mirror)";
/// Where a mirror keeps a commit the remote stopped pointing at.
pub const REPLACED_PREFIX: &str = "refs/g1t/replaced/";
/// How long a kept commit stays, at least.
pub const REPLACED_KEPT_DAYS: u64 = 30;
/// How far back a moved branch is searched for its old commit.
const REPLACED_HISTORY: u32 = 200;
/// A pack with no objects: for a push whose refs all name objects the
/// target already holds. The last 20 bytes are the SHA-1 of the first 12.
const EMPTY_PACK: [u8; 32] = [
    b'P', b'A', b'C', b'K', 0, 0, 0, 2, 0, 0, 0, 0, 0x02, 0x9d, 0x08, 0x82, 0x3b, 0xd8, 0xa8, 0xea,
    0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e, 0xd3, 0x1e,
];

/// One side of a copy: a repository's smart HTTP address and the
/// `authorization` header that opens it. The header is never logged.
pub struct Endpoint {
    pub url: String,
    pub authorization: String,
}

impl Endpoint {
    /// A g1t repository, with a credential from the git store.
    pub fn bearer(url: &str, token: &str) -> Self {
        Endpoint {
            url: url.trim_end_matches('/').to_owned(),
            authorization: format!("Bearer {token}"),
        }
    }

    /// A public repository anywhere, read with no credential: importing
    /// one copies every branch and tag, as with a credential.
    pub fn anonymous(url: &str) -> Self {
        Endpoint {
            url: url.trim_end_matches('/').to_owned(),
            authorization: String::new(),
        }
    }

    /// A GitHub repository, with an installation access token. GitHub takes
    /// one as the password of the user `x-access-token`. The token is used
    /// as given: its length and shape are GitHub's to change.
    pub fn github(url: &str, token: &str) -> Self {
        Self::basic(url, GITHUB_USER, token)
    }

    /// Any https git host, with a token sent as `username`'s password.
    pub fn basic(url: &str, username: &str, token: &str) -> Self {
        Endpoint {
            url: url.trim_end_matches('/').to_owned(),
            authorization: format!("Basic {}", base64(&format!("{username}:{token}"))),
        }
    }

    /// A remote named in a service's arguments: GitHub's user unless
    /// another is given.
    pub fn remote(url: &str, username: Option<&str>, token: &str) -> Self {
        Self::basic(url, username.filter(|name| !name.trim().is_empty()).unwrap_or(GITHUB_USER), token)
    }
}

const GITHUB_USER: &str = "x-access-token";

/// Why a copy did not happen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    /// The other host did not answer, or answered with a server error: it
    /// may be down.
    Unreachable(String),
    /// It answered, and refused or could not be used.
    Refused(String),
}

impl Problem {
    pub fn code(&self) -> FailureCode {
        match self {
            Problem::Unreachable(_) => FailureCode::Unavailable,
            Problem::Refused(_) => FailureCode::Conflict,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Problem::Unreachable(message) | Problem::Refused(message) => message,
        }
    }

    fn map(self, wrap: impl Fn(&str) -> String) -> Self {
        match self {
            Problem::Unreachable(message) => Problem::Unreachable(wrap(&message)),
            Problem::Refused(message) => Problem::Refused(wrap(&message)),
        }
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

/// What an answer's status says about the host: a server error, a timeout
/// or a rate limit means it may be down; anything else, that it answered.
pub fn problem_for_status(status: u16, what: impl Into<String>) -> Problem {
    if status >= 500 || status == 408 || status == 429 {
        Problem::Unreachable(what.into())
    } else {
        Problem::Refused(what.into())
    }
}

/// What a copy changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Copied {
    /// Refs created or moved, each with where it was and where it is now.
    pub updated: Vec<(String, Option<String>, String)>,
    pub deleted: Vec<String>,
    /// What each deleted ref pointed at.
    pub deleted_from: BTreeMap<String, String>,
    /// The branch the source's HEAD names, when it said.
    pub head: Option<String>,
}

/// Which refs a copy moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prune {
    /// Refs the source no longer has are deleted from the target: the
    /// target is a mirror of the source.
    Yes,
    /// Refs only the target has are left alone: pushing out to a host that
    /// may have branches of its own.
    No,
}

fn base64(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> shift) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn pkt_line(payload: &str) -> Vec<u8> {
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

/// A ref advertisement: branch and tag refs by name, and the branch HEAD
/// points to when the server said.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Advertised {
    pub refs: BTreeMap<String, String>,
    pub head: Option<String>,
}

impl Advertised {
    /// The branch to make a copy's default: the one HEAD names, else
    /// `main`, else the first branch. `None` for a repository with none.
    pub fn default_branch(&self) -> Option<String> {
        let branches: Vec<&str> = self.refs.keys().filter_map(|name| name.strip_prefix("refs/heads/")).collect();
        self.head
            .clone()
            .filter(|head| branches.contains(&head.as_str()))
            .or_else(|| branches.iter().find(|name| **name == "main").map(|name| name.to_string()))
            .or_else(|| branches.first().map(|name| name.to_string()))
    }
}

/// Asks a source for its refs before anything is made from it, so an
/// address or credential that does not work leaves nothing behind.
pub async fn probe(source: &Endpoint) -> Result<std::result::Result<Advertised, String>> {
    Ok(advertise(source, "git-upload-pack").await?.map_err(|problem| problem.to_string()))
}

/// Reads `info/refs`. Peeled tags (`^{}`) and the placeholder an empty
/// repository sends are skipped; only branches and tags are kept.
pub fn parse_advertisement(bytes: &[u8]) -> Advertised {
    let (lines, _) = read_pkt_lines(bytes);
    let mut advertised = Advertised::default();
    for line in lines {
        let mut parts = line.splitn(2, |byte| *byte == 0);
        let Some(reference) = parts.next().and_then(|bytes| std::str::from_utf8(bytes).ok()) else {
            continue;
        };
        if let Some(capabilities) = parts.next().and_then(|bytes| std::str::from_utf8(bytes).ok()) {
            advertised.head = capabilities
                .split(' ')
                .find_map(|capability| capability.trim().strip_prefix("symref=HEAD:refs/heads/"))
                .map(str::to_owned)
                .or(advertised.head);
        }
        let Some((hash, name)) = reference.trim_end().split_once(' ') else {
            continue;
        };
        let kept = (name.starts_with("refs/heads/") || name.starts_with("refs/tags/")) && !name.ends_with("^{}");
        if kept && hash.len() == 40 && hash != ZERO_ID {
            advertised.refs.insert(name.to_owned(), hash.to_owned());
        }
    }
    advertised
}

/// One ref command for a push: `(name, old, new)`, `new` the zero id to
/// delete.
pub type Command = (String, Option<String>, String);

/// What has to change on `target` so its refs match `source`'s.
pub fn plan(source: &Advertised, target: &Advertised, prune: Prune) -> Vec<Command> {
    let mut commands = Vec::new();
    for (name, hash) in &source.refs {
        let old = target.refs.get(name);
        if old != Some(hash) {
            commands.push((name.clone(), old.cloned(), hash.clone()));
        }
    }
    if prune == Prune::Yes {
        for (name, hash) in &target.refs {
            if !source.refs.contains_key(name) {
                commands.push((name.clone(), Some(hash.clone()), ZERO_ID.to_owned()));
            }
        }
    }
    commands
}

/// The body of an upload-pack request for `wants`, naming `haves`.
pub fn upload_request(wants: &[String], haves: &[String]) -> Vec<u8> {
    let mut body = Vec::new();
    for (index, want) in wants.iter().enumerate() {
        // Capabilities ride on the first want only.
        let line = if index == 0 { format!("want {want} side-band-64k\n") } else { format!("want {want}\n") };
        body.extend(pkt_line(&line));
    }
    body.extend_from_slice(b"0000");
    for have in haves.iter().take(MAX_HAVES) {
        body.extend(pkt_line(&format!("have {have}\n")));
    }
    body.extend(pkt_line("done\n"));
    body
}

/// The body of a receive-pack request: the commands, then the pack when
/// anything but deletions is sent.
pub fn receive_request(commands: &[Command], pack: Option<Vec<u8>>) -> Vec<u8> {
    let deletes = commands.iter().any(|(_, _, new)| new == ZERO_ID);
    let capabilities = if deletes { "report-status delete-refs" } else { "report-status" };
    let mut body = Vec::new();
    for (index, (name, old, new)) in commands.iter().enumerate() {
        let old = old.as_deref().unwrap_or(ZERO_ID);
        let line = if index == 0 { format!("{old} {new} {name}\0 {capabilities}\n") } else { format!("{old} {new} {name}\n") };
        body.extend(pkt_line(&line));
    }
    body.extend_from_slice(b"0000");
    if commands.iter().any(|(_, _, new)| new != ZERO_ID) {
        body.extend(pack.unwrap_or_else(|| EMPTY_PACK.to_vec()));
    }
    body
}

/// Which commands a receive-pack report says were refused, with why.
pub fn refused(report: &[u8], commands: &[Command]) -> Vec<String> {
    let (lines, _) = read_pkt_lines(report);
    let lines: Vec<String> = lines
        .into_iter()
        .map(|line| {
            // A report may come inside side-band channel 1.
            let line = if line.first() == Some(&1) { &line[1..] } else { line };
            String::from_utf8_lossy(line).trim_end().to_owned()
        })
        .collect();
    let mut problems: Vec<String> = lines
        .iter()
        .filter(|line| line.starts_with("unpack ") && *line != "unpack ok")
        .cloned()
        .collect();
    for (name, _, _) in commands {
        if !lines.iter().any(|line| *line == format!("ok {name}")) {
            let reason = lines
                .iter()
                .find_map(|line| line.strip_prefix(&format!("ng {name} ")))
                .unwrap_or("not reported");
            problems.push(format!("{name}: {reason}"));
        }
    }
    problems
}

fn request(method: Method, url: &str, endpoint: &Endpoint, body: Option<(&str, Vec<u8>)>) -> Result<Request> {
    // Requests to g1t's own store are metered (meters.rs); GitHub's are not.
    if endpoint.authorization.starts_with("Bearer ") {
        let sent = body.as_ref().map_or(0, |(_, body)| body.len() as u64);
        let meter = match body.as_ref().map(|(service, _)| *service) {
            Some("git-receive-pack") => "internal.git.receive_pack",
            Some(_) => "internal.git.fetch",
            None => "internal.git.info_refs",
        };
        crate::meters::record_remote(meter, &endpoint.url, sent, 0);
    }
    let headers = Headers::new();
    headers.set("user-agent", USER_AGENT)?;
    if !endpoint.authorization.is_empty() {
        headers.set("authorization", &endpoint.authorization)?;
    }
    let mut init = RequestInit::new();
    if let Some((service, body)) = body {
        headers.set("content-type", &format!("application/x-{service}-request"))?;
        headers.set("accept", &format!("application/x-{service}-result"))?;
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    init.with_method(method).with_headers(headers);
    Request::new_with_init(url, &init)
}

/// Asks a server for its refs, as the given service would see them.
async fn advertise(endpoint: &Endpoint, service: &str) -> Result<std::result::Result<Advertised, Problem>> {
    Ok(advertise_raw(endpoint, service).await?.map(|bytes| parse_advertisement(&bytes)))
}

/// `info/refs` as sent.
async fn advertise_raw(endpoint: &Endpoint, service: &str) -> Result<std::result::Result<Vec<u8>, Problem>> {
    let url = format!("{}/info/refs?service={service}", endpoint.url);
    let mut response = match Fetch::Request(request(Method::Get, &url, endpoint, None)?).send().await {
        Ok(response) => response,
        Err(_) => return Ok(Err(Problem::Unreachable("The repository could not be reached.".to_owned()))),
    };
    match response.status_code() {
        200 => Ok(Ok(response.bytes().await?)),
        401 | 403 => Ok(Err(Problem::Refused("The repository refused g1t's credential.".to_owned()))),
        404 => Ok(Err(Problem::Refused("The repository was not found, or g1t may not read it.".to_owned()))),
        status => Ok(Err(problem_for_status(status, format!("The repository answered {status}.")))),
    }
}

/// The kept commits in an advertisement: `refs/g1t/replaced/...` names
/// with what they point at.
pub fn replaced_refs(bytes: &[u8]) -> Vec<(String, String)> {
    let (lines, _) = read_pkt_lines(bytes);
    lines
        .into_iter()
        .filter_map(|line| {
            let line = std::str::from_utf8(line.split(|byte| *byte == 0).next()?).ok()?;
            let (hash, name) = line.trim_end().split_once(' ')?;
            (name.starts_with(REPLACED_PREFIX) && hash.len() == 40).then(|| (name.to_owned(), hash.to_owned()))
        })
        .collect()
}

/// The ref that keeps `old` when `name` stops pointing at it, stamped with
/// the time in milliseconds so expired ones are found from the name alone.
pub fn replaced_name(name: &str, now_ms: u64) -> String {
    format!("{REPLACED_PREFIX}{}/{now_ms}", name.trim_start_matches("refs/"))
}

/// The ref a kept commit was replaced on: `refs/heads/main` for
/// `refs/g1t/replaced/heads/main/<ms>`.
pub fn replaced_from(kept: &str) -> Option<String> {
    let rest = kept.strip_prefix(REPLACED_PREFIX)?;
    let (name, _) = rest.rsplit_once('/')?;
    Some(format!("refs/{name}"))
}

/// Whether a kept commit's ref is older than [`REPLACED_KEPT_DAYS`].
pub fn replaced_expired(name: &str, now_ms: u64) -> bool {
    name.rsplit('/')
        .next()
        .and_then(|stamp| stamp.parse::<u64>().ok())
        .is_some_and(|stamp| now_ms.saturating_sub(stamp) > REPLACED_KEPT_DAYS * 86_400_000)
}

/// Fetches one pack holding `wants`, reading in pieces so that one too
/// large is noticed before it is all held.
async fn fetch_pack(source: &Endpoint, wants: &[String], haves: &[String]) -> Result<std::result::Result<Vec<u8>, Problem>> {
    let body = upload_request(wants, haves);
    let url = format!("{}/git-upload-pack", source.url);
    let Ok(mut response) = Fetch::Request(request(Method::Post, &url, source, Some(("git-upload-pack", body)))?)
        .send()
        .await
    else {
        return Ok(Err(Problem::Unreachable("The repository stopped answering while sending.".to_owned())));
    };
    if response.status_code() != 200 {
        let status = response.status_code();
        return Ok(Err(problem_for_status(status, format!("The source refused to send the repository ({status})."))));
    }
    let mut received = Vec::new();
    let mut stream = response.stream()?;
    while let Some(chunk) = stream.next().await {
        received.extend_from_slice(&chunk?);
        if received.len() > MAX_PACK_BYTES {
            return Ok(Err(Problem::Refused(format!(
                "The change is larger than {} MB, the most g1t copies at once. Push it with git instead.",
                MAX_PACK_BYTES / 1024 / 1024
            ))));
        }
    }
    Ok(unpack_sideband(&received).map_err(|_| Problem::Refused("The source did not send a usable pack.".to_owned())))
}

/// Makes `target`'s branches and tags match `source`'s. With
/// `Prune::No`, refs only the target has are kept. `Err` in the inner
/// result is a reason to show a person.
pub async fn copy(source: &Endpoint, target: &Endpoint, prune: Prune) -> Result<std::result::Result<Copied, Problem>> {
    let theirs = match advertise(source, "git-upload-pack").await? {
        Ok(refs) => refs,
        Err(problem) => return Ok(Err(problem)),
    };
    let ours = match advertise(target, "git-receive-pack").await? {
        Ok(refs) => refs,
        Err(problem) => return Ok(Err(problem.map(|reason| format!("Writing the copy failed: {reason}")))),
    };
    let commands = plan(&theirs, &ours, prune);
    let mut copied = Copied {
        head: theirs.head.clone(),
        ..Copied::default()
    };
    if commands.is_empty() {
        return Ok(Ok(copied));
    }
    let results = match transfer(source, target, &ours, &commands).await? {
        Ok(results) => results,
        Err(problem) => return Ok(Err(problem)),
    };
    let problems: Vec<String> = results
        .iter()
        .filter_map(|(name, problem)| problem.as_ref().map(|problem| format!("{name}: {problem}")))
        .collect();
    if !problems.is_empty() {
        return Ok(Err(Problem::Refused(format!("Some refs were not updated: {}", problems.join("; ")))));
    }
    for (name, old, new) in commands {
        if new == ZERO_ID {
            if let Some(old) = old {
                copied.deleted_from.insert(name.clone(), old);
            }
            copied.deleted.push(name);
        } else {
            copied.updated.push((name, old, new));
        }
    }
    Ok(Ok(copied))
}

/// Sends `commands` to `target` in one push, with a pack from `source`
/// holding what the target lacks (`held`: what its refs already name).
/// Each command comes back with why it was refused, if it was.
async fn transfer(
    source: &Endpoint,
    target: &Endpoint,
    held: &Advertised,
    commands: &[Command],
) -> Result<std::result::Result<Vec<(String, Option<String>)>, Problem>> {
    let have: HashSet<&String> = held.refs.values().collect();
    let mut wants: Vec<String> = commands
        .iter()
        .map(|(_, _, new)| new)
        .filter(|new| *new != ZERO_ID && !have.contains(new))
        .cloned()
        .collect();
    wants.sort();
    wants.dedup();
    let pack = if wants.is_empty() {
        None
    } else {
        let haves: Vec<String> = held.refs.values().cloned().collect::<HashSet<_>>().into_iter().collect();
        match fetch_pack(source, &wants, &haves).await? {
            Ok(pack) => Some(pack),
            Err(problem) => return Ok(Err(problem)),
        }
    };
    let body = receive_request(commands, pack);
    let url = format!("{}/git-receive-pack", target.url);
    let Ok(mut response) = Fetch::Request(request(Method::Post, &url, target, Some(("git-receive-pack", body)))?)
        .send()
        .await
    else {
        return Ok(Err(Problem::Unreachable("The repository stopped answering while receiving.".to_owned())));
    };
    let report = response.bytes().await?;
    if response.status_code() != 200 {
        let status = response.status_code();
        return Ok(Err(problem_for_status(status, format!("The push was refused ({status})."))));
    }
    Ok(Ok(outcomes(&report, commands)))
}

/// Each command with why it was refused, if the report says it was.
pub fn outcomes(report: &[u8], commands: &[Command]) -> Vec<(String, Option<String>)> {
    let refused = refused(report, commands);
    commands
        .iter()
        .map(|(name, _, _)| {
            let prefix = format!("{name}: ");
            (name.clone(), refused.iter().find_map(|line| line.strip_prefix(&prefix).map(str::to_owned)))
        })
        .collect()
}

/// The pushes an import announces, one for each ref it made: the default
/// branch first (what follows a repository, such as its Composer package,
/// starts from it), then the other branches, then the tags.
pub fn import_pushes(updated: &[(String, Option<String>, String)], default_branch: &str) -> Vec<(String, String)> {
    let default = format!("refs/heads/{default_branch}");
    let rank = |name: &str| {
        if name == default {
            0
        } else if name.starts_with("refs/heads/") {
            1
        } else {
            2
        }
    };
    let mut pushes: Vec<(String, String)> = updated
        .iter()
        .filter(|(name, _, new)| (name.starts_with("refs/heads/") || name.starts_with("refs/tags/")) && new != ZERO_ID)
        .map(|(name, _, new)| (name.clone(), new.clone()))
        .collect();
    pushes.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then_with(|| a.0.cmp(&b.0)));
    pushes
}

impl<S: GitStore> Repos<S> {
    /// `mirror`: a mirror catching up with the host it mirrors, or a
    /// repository pushing its refs out to one. Each branch moved on g1t is
    /// announced as a push copied in, so what follows a mirror's state
    /// (workflows, deployments) can tell.
    pub(crate) async fn mirror(&self, a: MirrorArgs) -> Result<Outcome<Mirrored>> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(not_found());
        };
        let Some(url) = import::clean_url(&a.url) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not an https repository address."));
        };
        // Catching up writes: it waits for a move between namespaces (moves.rs).
        let repo = if a.direction == MirrorDirection::Pull {
            match self.unpaused(repo).await? {
                Ok(repo) => repo,
                Err((code, message)) => return Ok(Outcome::fail(code, message)),
            }
        } else {
            repo
        };
        let scope = match a.direction {
            MirrorDirection::Pull => Scope::Write,
            MirrorDirection::Push => Scope::Read,
        };
        let access = self.store.open(&store_key(&repo)).await?.access(scope).await?;
        let ours = Endpoint::bearer(&access.remote, &access.token);
        let theirs = Endpoint::remote(&url, a.username.as_deref(), &a.token);
        let copied = match a.direction {
            MirrorDirection::Pull => {
                let copied = copy(&theirs, &ours, Prune::Yes).await?;
                self.refs_moved(&repo.id).await;
                copied
            }
            MirrorDirection::Push => copy(&ours, &theirs, Prune::No).await?,
        };
        let copied = match copied {
            Ok(copied) => copied,
            Err(problem) => return Ok(Outcome::fail(problem.code(), problem.to_string())),
        };
        let mut replaced = Vec::new();
        if a.direction == MirrorDirection::Pull {
            let moved: Vec<(String, Option<String>, String)> = copied
                .updated
                .iter()
                .cloned()
                .chain(
                    copied
                        .deleted_from
                        .iter()
                        .map(|(name, old)| (name.clone(), Some(old.clone()), ZERO_ID.to_owned())),
                )
                .collect();
            replaced = self.keep_replaced(&repo, &access, &moved).await?;
            for (name, old, new) in &copied.updated {
                if name.starts_with("refs/heads/") {
                    self.publish_mirrored_push(&repo, name, old.as_deref(), new).await?;
                }
            }
        }
        Ok(Outcome::Ok(Mirrored {
            updated: copied.updated.into_iter().map(|(name, _, _)| name).collect(),
            deleted: copied.deleted,
            replaced,
        }))
    }

    /// Keeps each commit a pull stopped pointing at, when the ref's new
    /// commit does not contain it: a force-push or deletion on the remote.
    /// Returns the refs that keep them. Expired ones are let go at the same
    /// time.
    async fn keep_replaced(&self, repo: &Repo, access: &GitAccess, moved: &[(String, Option<String>, String)]) -> Result<Vec<String>> {
        let git = self.store.open(&store_key(repo)).await?;
        let now = now_ms();
        let mut kept = Vec::new();
        for (name, old, new) in moved {
            let Some(old) = old.as_deref() else { continue };
            let lost = if new == ZERO_ID || name.starts_with("refs/tags/") {
                true
            } else {
                match git.log(name, REPLACED_HISTORY).await {
                    Ok(history) => !descends_from(&git, &history, old).await.unwrap_or(true),
                    Err(_) => false,
                }
            };
            if !lost {
                continue;
            }
            let keep = replaced_name(name, now);
            if let Ok(Ok(())) = push_ref(access, &keep, None, old, Some(EMPTY_PACK.to_vec())).await {
                kept.push(keep);
            }
        }
        if !kept.is_empty() {
            let ours = Endpoint::bearer(&access.remote, &access.token);
            if let Ok(Ok(bytes)) = advertise_raw(&ours, "git-receive-pack").await {
                for (name, hash) in replaced_refs(&bytes).into_iter().filter(|(name, _)| replaced_expired(name, now)) {
                    let _ = push_ref(access, &name, Some(&hash), ZERO_ID, None).await;
                }
            }
            self.refs_moved(&repo.id).await;
        }
        Ok(kept)
    }

    /// `mirror_refs`: both sides' branches and tags.
    pub(crate) async fn mirror_refs(&self, a: MirrorRefsArgs) -> Result<Outcome<MirrorRefs>> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(not_found());
        };
        let access = self.store.open(&store_key(&repo)).await?.access(Scope::Read).await?;
        let ours = match advertise(&Endpoint::bearer(&access.remote, &access.token), "git-upload-pack").await? {
            Ok(ours) => ours,
            Err(problem) => return Ok(Outcome::fail(FailureCode::Conflict, problem.to_string())),
        };
        // No address: only g1t's side was asked for.
        if a.url.is_empty() {
            return Ok(Outcome::Ok(MirrorRefs { ours: ours.refs, theirs: None, unreachable: None }));
        }
        let Some(url) = import::clean_url(&a.url) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not an https repository address."));
        };
        let (theirs, unreachable) = match advertise(&Endpoint::remote(&url, a.username.as_deref(), &a.token), "git-upload-pack").await? {
            Ok(theirs) => (Some(theirs.refs), None),
            Err(Problem::Unreachable(reason)) => (None, Some(reason)),
            Err(problem) => return Ok(Outcome::fail(problem.code(), problem.to_string())),
        };
        Ok(Outcome::Ok(MirrorRefs {
            ours: ours.refs,
            theirs,
            unreachable,
        }))
    }

    /// `mirror_apply`: moves chosen refs either way, each only from the
    /// commit the caller saw. Pushes go out in one request, pulls come in
    /// in another.
    pub(crate) async fn mirror_apply(&self, a: MirrorApplyArgs) -> Result<Outcome<MirrorApplied>> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(not_found());
        };
        let Some(url) = import::clean_url(&a.url) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not an https repository address."));
        };
        let repo = match self.unpaused(repo).await? {
            Ok(repo) => repo,
            Err((code, message)) => return Ok(Outcome::fail(code, message)),
        };
        let access = self.store.open(&store_key(&repo)).await?.access(Scope::Write).await?;
        let ours = Endpoint::bearer(&access.remote, &access.token);
        let theirs = Endpoint::remote(&url, a.username.as_deref(), &a.token);
        let mut moved = Vec::new();
        for direction in [MirrorDirection::Push, MirrorDirection::Pull] {
            let moves: Vec<_> = a.moves.iter().filter(|m| m.direction == direction).collect();
            if moves.is_empty() {
                continue;
            }
            let commands: Vec<Command> = moves
                .iter()
                .map(|m| {
                    (
                        m.to.clone().unwrap_or_else(|| m.git_ref.clone()),
                        m.old.clone(),
                        m.new.clone().unwrap_or_else(|| ZERO_ID.to_owned()),
                    )
                })
                .collect();
            let (source, target) = match direction {
                MirrorDirection::Push => (&ours, &theirs),
                MirrorDirection::Pull => (&theirs, &ours),
            };
            let held = match advertise(target, "git-receive-pack").await? {
                Ok(held) => held,
                Err(problem) => return Ok(Outcome::fail(problem.code(), problem.to_string())),
            };
            let results = match transfer(source, target, &held, &commands).await? {
                Ok(results) => results,
                Err(problem) => return Ok(Outcome::fail(problem.code(), problem.to_string())),
            };
            let mut landed = Vec::new();
            for ((name, problem), command) in results.into_iter().zip(&commands) {
                if problem.is_none() {
                    landed.push(command.clone());
                }
                moved.push(RefMoved {
                    git_ref: name,
                    direction,
                    problem,
                    replaced: None,
                });
            }
            if direction == MirrorDirection::Pull && !landed.is_empty() {
                self.refs_moved(&repo.id).await;
                for keep in self.keep_replaced(&repo, &access, &landed).await? {
                    let from = replaced_from(&keep);
                    if let Some(entry) = moved
                        .iter_mut()
                        .find(|m| m.direction == direction && Some(&m.git_ref) == from.as_ref())
                    {
                        entry.replaced = Some(keep);
                    }
                }
                for (name, old, new) in &landed {
                    if name.starts_with("refs/heads/") && new != ZERO_ID {
                        self.publish_mirrored_push(&repo, name, old.as_deref(), new).await?;
                    }
                }
            }
        }
        Ok(Outcome::Ok(MirrorApplied { moved }))
    }

    /// `set_mirror`: what the integrations service decided about a
    /// repository's mirror, kept on its row.
    pub(crate) async fn set_mirror(&self, a: SetMirrorArgs) -> Result<Outcome<Repo>> {
        let Some(mut repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(not_found());
        };
        self.registry.set_mirror(&repo.id, a.mirror.as_ref()).await?;
        repo.mirror = a.mirror;
        Ok(Outcome::Ok(repo))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "c71546fcd893ef8b0f57388b65e620d759705dda";
    const B: &str = "4807077b296e6edbf410d55e72749d3e1170c291";
    const C: &str = "1111111111111111111111111111111111111111";

    fn advertised(refs: &[(&str, &str)]) -> Advertised {
        Advertised {
            refs: refs.iter().map(|(name, hash)| (name.to_string(), hash.to_string())).collect(),
            head: None,
        }
    }

    #[test]
    fn the_basic_header_carries_the_token_whole() {
        assert_eq!(base64("x-access-token:abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
        assert_eq!(base64("a"), "YQ==");
        assert_eq!(base64("ab"), "YWI=");
        // GitHub's stateless installation tokens run to hundreds of
        // characters; nothing here assumes a length.
        let token = format!("ghs_{}", "x".repeat(516));
        assert_eq!(token.len(), 520);
        let endpoint = Endpoint::github("https://github.com/o/r.git/", &token);
        assert_eq!(endpoint.url, "https://github.com/o/r.git");
        let encoded = endpoint.authorization.strip_prefix("Basic ").unwrap();
        assert_eq!(encoded, base64(&format!("x-access-token:{token}")));
        assert_eq!(encoded.len(), (15 + 520usize).div_ceil(3) * 4);
    }

    #[test]
    fn the_advertisement_keeps_branches_and_tags() {
        let bytes = [
            pkt_line("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt_line(&format!("{A} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/trunk agent=git/x\n")),
            pkt_line(&format!("{A} refs/heads/trunk\n")),
            pkt_line(&format!("{B} refs/tags/v1\n")),
            pkt_line(&format!("{A} refs/tags/v1^{{}}\n")),
            pkt_line(&format!("{C} refs/pull/1/head\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let parsed = parse_advertisement(&bytes);
        assert_eq!(parsed.head.as_deref(), Some("trunk"));
        assert_eq!(parsed, Advertised {
            refs: advertised(&[("refs/heads/trunk", A), ("refs/tags/v1", B)]).refs,
            head: Some("trunk".to_owned()),
        });
        assert_eq!(parsed.default_branch().as_deref(), Some("trunk"));
        assert_eq!(advertised(&[("refs/heads/a", A), ("refs/heads/main", A)]).default_branch().as_deref(), Some("main"));
        assert_eq!(advertised(&[("refs/tags/v1", A)]).default_branch(), None);
        let empty = [pkt_line(&format!("{ZERO_ID} capabilities^{{}}\0report-status\n")), b"0000".to_vec()].concat();
        assert!(parse_advertisement(&empty).refs.is_empty());
    }

    #[test]
    fn a_public_import_copies_every_branch_and_tag_annotated_ones_whole() {
        // An empty repository being filled from a public source: every
        // branch and tag is made, an annotated tag as its tag object (so it
        // stays annotated), and the source's pull request refs and peeled
        // lines are left out.
        let bytes = [
            pkt_line("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt_line(&format!("{A} HEAD\0multi_ack symref=HEAD:refs/heads/master\n")),
            pkt_line(&format!("{A} refs/heads/master\n")),
            pkt_line(&format!("{B} refs/heads/next\n")),
            pkt_line(&format!("{C} refs/pull/7/head\n")),
            pkt_line(&format!("{C} refs/tags/1.0.0\n")),
            pkt_line(&format!("{A} refs/tags/1.0.0^{{}}\n")),
            pkt_line(&format!("{B} refs/tags/2.0.0\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let source = parse_advertisement(&bytes);
        assert_eq!(source.default_branch().as_deref(), Some("master"), "HEAD stays the default branch");
        let commands = plan(&source, &Advertised::default(), Prune::Yes);
        let names: Vec<(&str, &str)> = commands.iter().map(|(name, _, new)| (name.as_str(), new.as_str())).collect();
        assert_eq!(
            names,
            [("refs/heads/master", A), ("refs/heads/next", B), ("refs/tags/1.0.0", C), ("refs/tags/2.0.0", B)]
        );
        let pushes = import_pushes(&commands, "master");
        let order: Vec<&str> = pushes.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(order, ["refs/heads/master", "refs/heads/next", "refs/tags/1.0.0", "refs/tags/2.0.0"]);
        let pushes = import_pushes(&commands, "next");
        assert_eq!(pushes[0].0, "refs/heads/next", "the default branch is announced first");
        assert_eq!(Endpoint::anonymous("https://github.com/php-fig/log.git/").url, "https://github.com/php-fig/log.git");
        assert!(Endpoint::anonymous("https://x").authorization.is_empty(), "no credential is sent");
    }

    #[test]
    fn a_mirror_prunes_and_a_push_out_does_not() {
        let source = advertised(&[("refs/heads/main", A), ("refs/tags/v1", B)]);
        let target = advertised(&[("refs/heads/main", B), ("refs/heads/old", C)]);
        assert_eq!(plan(&source, &target, Prune::Yes), vec![
            ("refs/heads/main".to_owned(), Some(B.to_owned()), A.to_owned()),
            ("refs/tags/v1".to_owned(), None, B.to_owned()),
            ("refs/heads/old".to_owned(), Some(C.to_owned()), ZERO_ID.to_owned()),
        ]);
        assert_eq!(plan(&source, &target, Prune::No).len(), 2);
        assert!(plan(&source, &source, Prune::Yes).is_empty());
    }

    #[test]
    fn a_push_of_known_objects_sends_an_empty_pack() {
        let commands = vec![("refs/tags/v1".to_owned(), None, A.to_owned())];
        let body = receive_request(&commands, None);
        assert!(body.ends_with(&EMPTY_PACK));
        let deletes = vec![("refs/heads/x".to_owned(), Some(A.to_owned()), ZERO_ID.to_owned())];
        let body = receive_request(&deletes, None);
        assert!(body.ends_with(b"0000"));
        assert!(String::from_utf8_lossy(&body).contains("delete-refs"));
    }

    #[test]
    fn wants_carry_capabilities_once() {
        let body = String::from_utf8(upload_request(&[A.to_owned(), B.to_owned()], &[C.to_owned()])).unwrap();
        assert_eq!(body.matches("side-band-64k").count(), 1);
        assert!(body.contains(&format!("want {B}\n")));
        assert!(body.contains(&format!("have {C}\n")));
        assert!(body.ends_with("0009done\n"));
    }

    #[test]
    fn replaced_commits_are_kept_by_name_and_time() {
        let kept = replaced_name("refs/heads/feature/x", 1_000);
        assert_eq!(kept, "refs/g1t/replaced/heads/feature/x/1000");
        assert_eq!(replaced_from(&kept).as_deref(), Some("refs/heads/feature/x"));
        assert!(!replaced_expired(&kept, 1_000 + REPLACED_KEPT_DAYS * 86_400_000));
        assert!(replaced_expired(&kept, 1_001 + REPLACED_KEPT_DAYS * 86_400_000));
        assert!(!replaced_expired("refs/g1t/replaced/heads/main/not-a-time", u64::MAX));
        let bytes = [
            pkt_line(&format!("{A} refs/heads/main\0report-status\n")),
            pkt_line(&format!("{B} {kept}\n")),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(replaced_refs(&bytes), vec![(kept.clone(), B.to_owned())]);
        assert!(parse_advertisement(&bytes).refs.get(&kept).is_none(), "kept commits are not branches");
    }

    #[test]
    fn a_server_error_means_the_host_may_be_down() {
        assert_eq!(problem_for_status(503, "x").code(), FailureCode::Unavailable);
        assert_eq!(problem_for_status(429, "x").code(), FailureCode::Unavailable);
        assert_eq!(problem_for_status(403, "x").code(), FailureCode::Conflict);
        let endpoint = Endpoint::remote("https://git.example/a.git", Some("chase"), "t");
        assert_eq!(endpoint.authorization, format!("Basic {}", base64("chase:t")));
        assert_eq!(Endpoint::remote("https://x", Some(" "), "t").authorization, Endpoint::github("https://x", "t").authorization);
    }

    #[test]
    fn each_command_comes_back_with_its_refusal() {
        let commands = vec![
            ("refs/heads/main".to_owned(), None, A.to_owned()),
            ("refs/heads/x".to_owned(), None, B.to_owned()),
        ];
        let report = [
            pkt_line("unpack ok\n"),
            pkt_line("ok refs/heads/main\n"),
            pkt_line("ng refs/heads/x protected branch hook declined\n"),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(outcomes(&report, &commands), vec![
            ("refs/heads/main".to_owned(), None),
            ("refs/heads/x".to_owned(), Some("protected branch hook declined".to_owned())),
        ]);
    }

    #[test]
    fn refusals_are_reported_by_ref() {
        let commands = vec![
            ("refs/heads/main".to_owned(), None, A.to_owned()),
            ("refs/heads/x".to_owned(), None, B.to_owned()),
        ];
        let report = [
            pkt_line("unpack ok\n"),
            pkt_line("ok refs/heads/main\n"),
            pkt_line("ng refs/heads/x protected branch\n"),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(refused(&report, &commands), vec!["refs/heads/x: protected branch".to_owned()]);
        let fine = [pkt_line("unpack ok\n"), pkt_line("ok refs/heads/main\n"), pkt_line("ok refs/heads/x\n")].concat();
        assert!(refused(&fine, &commands).is_empty());
    }
}
