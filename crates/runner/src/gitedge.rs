//! The git edge: one repository's well-packed mirror, served by real git.
//!
//! Cloudflare Artifacts, where a repository lives, answers clones with
//! barely deltified packs. A git edge is a Container started for one
//! repository (`MODE=gitedge`, by the runner Worker's `GitEdge` Durable
//! Object, the only thing that reaches it): it keeps a bare mirror of the
//! repository, fetched from Artifacts and repacked by git, and answers
//! upload-pack (clones and fetches) with `git http-backend`. Pushes still
//! go to Artifacts, which stays the source of truth; the repos service
//! asks the edge to catch up after each one, and answers from Artifacts
//! itself whenever the edge is cold, behind or failing.
//!
//! The HTTP API, on `GITEDGE_PORT` (8080 by default):
//!
//! - `POST /sync` with `{"remote", "token", "version", "head"}`: answered
//!   `202` at once. One background worker syncs at a time; a sync asked
//!   for while one runs is remembered, the latest replacing any other, and
//!   runs after it. A sync fetches every ref from `remote` with `token`,
//!   points `HEAD` at `head` and repacks (`-f`, recomputing every delta,
//!   after the first fetch; reusing them once there are more than
//!   `MAX_PACKS` packs after a later one). Only when all of that succeeded
//!   is the mirror at `version`. A sync that fails leaves the version as
//!   it was, unless it failed after the refs had changed (the repack
//!   failed): those are no longer the old version's, so the mirror is then
//!   at none until a sync succeeds.
//! - `GET /state`: `{"version": 17 | null, "syncing": bool}`.
//! - `GET /snapshot`: the packed mirror as a tar, with its version in
//!   `x-g1t-edge-version`; `PUT /snapshot` unpacks one into an edge that
//!   has no mirror yet. A container loses its disk when it sleeps; the
//!   Durable Object keeps the snapshot in R2 and restores it on the next
//!   start, so a cold edge fetches only what is new instead of everything.
//! - `GET /git/info/refs?service=git-upload-pack` and
//!   `POST /git/git-upload-pack`, with the version the caller expects in
//!   `x-g1t-edge-version`: `409` with `x-g1t-edge: behind` unless the
//!   mirror is at exactly that version (and no sync is changing its refs),
//!   or when a fetch wants an object or ref the mirror does not have (the
//!   version asked for can trail the repository's for a moment); else
//!   `git http-backend`'s answer, streamed both ways.
//! - Anything else, receive-pack included: `403`.
//!
//! The Artifacts token is given to git in its environment, never on a
//! command line, and never logged: errors are redacted before they are.
//!
//! Configuration comes from the environment:
//!
//! - `GITEDGE_PORT`: the port to listen on (0 picks one, which is logged).
//! - `GITEDGE_DIR`: where the mirror is kept (`/home/runner/gitedge`).

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::checks::redact;

const DEFAULT_PORT: &str = "8080";
const DEFAULT_DIR: &str = "/home/runner/gitedge";
/// The mirror's directory under `GITEDGE_DIR`: one repository a Container.
const MIRROR: &str = "repo.git";
/// Written into the mirror once a sync has repacked it with `-f`, so a
/// first sync that failed half way is repacked in full by the next one.
const PACKED_MARKER: &str = "g1t-edge-packed";
/// The header a git request carries the version it expects in.
const VERSION_HEADER: &str = "x-g1t-edge-version";
/// The header a refusal says why in (`behind`).
const EDGE_HEADER: &str = "x-g1t-edge";
/// After a sync that was not the first, more packs than this are repacked
/// into one.
const MAX_PACKS: usize = 8;
/// A fetch slower than this many bytes a second for `LOW_SPEED_SECONDS` is
/// given up, so a stalled fetch does not hold the worker for hours.
const LOW_SPEED_BYTES: &str = "1000";
const LOW_SPEED_SECONDS: &str = "120";
/// The most a `/sync` body may be.
const MAX_SYNC_BODY: u64 = 64 * 1024;
/// How much of `git http-backend`'s output is held while the request's
/// body is still being sent to it: chunks of `CHUNK` bytes. Upload-pack
/// only says a little (acknowledgements) before it has read the whole
/// request, so this is never a pack.
const HELD_CHUNKS: usize = 64;
const CHUNK: usize = 64 * 1024;

/// A sync, as `POST /sync` asks for it. Not `Debug`: it holds the token.
#[derive(Deserialize)]
struct Sync {
    remote: String,
    token: String,
    version: u64,
    head: String,
}

/// What the edge knows about its mirror.
#[derive(Default)]
struct State {
    /// The version the mirror is at, once a sync has fully succeeded.
    version: Option<u64>,
    /// Whether a sync is running or waiting.
    syncing: bool,
    /// Whether a running sync may be changing the mirror's refs: no git
    /// request is answered meanwhile, whatever version it expects.
    changing: bool,
    /// The sync to run next, the latest asked for.
    next: Option<Sync>,
}

struct Edge {
    /// Where the mirror is kept: `GIT_PROJECT_ROOT`.
    root: PathBuf,
    state: Mutex<State>,
    wake: Condvar,
    /// Held while the mirror's files change or are read whole: a sync, a
    /// snapshot being made, one being restored. Never two at once.
    disk: Mutex<()>,
}

impl Edge {
    fn mirror(&self) -> PathBuf {
        self.root.join(MIRROR)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Runs git in `dir` with `env` added to its environment, and returns its
/// trimmed output, failing on a non-zero exit with what it said.
fn git_with(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .envs(env.iter().copied())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .context("could not run git")?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.iter().find(|arg| !arg.starts_with('-') && !arg.contains('=')).unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Every ref of the mirror and what `HEAD` points at, to tell whether a
/// sync changed them.
fn refs_of(mirror: &Path) -> BTreeMap<String, String> {
    let mut refs: BTreeMap<String, String> = git_with(mirror, &["for-each-ref", "--format=%(refname) %(objectname)"], &[])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(name, hash)| (name.to_owned(), hash.to_owned()))
        .collect();
    if let Ok(head) = git_with(mirror, &["symbolic-ref", "--quiet", "HEAD"], &[]) {
        refs.insert("HEAD".to_owned(), head);
    }
    refs
}

/// How many refs differ between two listings: added, moved or gone.
pub(crate) fn changed_refs(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> usize {
    let moved = after.iter().filter(|(name, hash)| before.get(*name) != Some(hash)).count();
    let gone = before.keys().filter(|name| !after.contains_key(*name)).count();
    moved + gone
}

/// The mirror's packs: how many, and their bytes.
fn packs_of(mirror: &Path) -> (usize, u64) {
    std::fs::read_dir(mirror.join("objects/pack"))
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "pack"))
                .filter_map(|entry| entry.metadata().ok())
                .fold((0, 0), |(count, bytes), meta| (count + 1, bytes + meta.len()))
        })
        .unwrap_or((0, 0))
}

/// Megabytes, for the log.
fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

/// Why a sync request cannot be run, or None.
fn invalid(sync: &Sync) -> Option<&'static str> {
    if sync.remote.is_empty() || sync.remote.starts_with('-') {
        return Some("remote must be a repository's URL");
    }
    if !sync.head.starts_with("refs/") || sync.head.contains("..") || sync.head.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some("head must be a ref under refs/");
    }
    None
}

/// Makes the mirror, when there is none: a bare repository configured to
/// be served and never pushed to.
fn init(mirror: &Path, root: &Path) -> Result<()> {
    if mirror.join("HEAD").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(root).context("could not make the mirror's directory")?;
    let path = mirror.to_str().context("the mirror's path is not text")?;
    git_with(root, &["init", "--bare", "--quiet", path], &[])?;
    for (key, value) in [
        // Never repacked behind the sync's back.
        ("gc.auto", "0"),
        // Never pushed to over HTTP (the server refuses receive-pack too).
        ("http.receivepack", "false"),
        ("uploadpack.allowFilter", "true"),
        ("uploadpack.allowReachableSHA1InWant", "true"),
        ("pack.useBitmaps", "true"),
        ("repack.writeBitmaps", "true"),
        // Every fetch is kept as a pack, never exploded into loose objects
        // nothing would ever pack again, so `MAX_PACKS` counts them all.
        ("fetch.unpackLimit", "1"),
        ("transfer.unpackLimit", "1"),
    ] {
        git_with(mirror, &["config", key, value], &[])?;
    }
    Ok(())
}

/// What a sync did, for the log.
struct Synced {
    refs_changed: usize,
    repack: &'static str,
}

/// Why a sync failed, and whether it had changed the mirror's refs by then.
struct Failed {
    error: anyhow::Error,
    changed: bool,
}

/// Fetches, points `HEAD` and repacks. `changing` is called just before
/// the mirror's refs may change.
fn sync(edge: &Edge, job: &Sync, changing: impl FnOnce()) -> std::result::Result<Synced, Failed> {
    let mirror = edge.mirror();
    init(&mirror, &edge.root).map_err(|error| Failed { error, changed: false })?;
    let before = refs_of(&mirror);
    changing();
    fetch_and_pack(&mirror, job, &before).map_err(|error| Failed { changed: refs_of(&mirror) != before, error })
}

fn fetch_and_pack(mirror: &Path, job: &Sync, before: &BTreeMap<String, String>) -> Result<Synced> {
    let first = !mirror.join(PACKED_MARKER).exists();
    // The token goes in git's environment, as configuration, never in its
    // arguments, where `ps` and an error message would show it.
    let authorization = format!("Authorization: Bearer {}", job.token);
    let env: Vec<(&str, &str)> = if job.token.is_empty() {
        vec![("GIT_CONFIG_COUNT", "0")]
    } else {
        vec![("GIT_CONFIG_COUNT", "1"), ("GIT_CONFIG_KEY_0", "http.extraHeader"), ("GIT_CONFIG_VALUE_0", authorization.as_str())]
    };
    git_with(
        mirror,
        &[
            "-c",
            &format!("http.lowSpeedLimit={LOW_SPEED_BYTES}"),
            "-c",
            &format!("http.lowSpeedTime={LOW_SPEED_SECONDS}"),
            "fetch",
            "--quiet",
            "--atomic",
            "--prune",
            "--no-write-fetch-head",
            "--no-auto-gc",
            &job.remote,
            "+refs/*:refs/*",
        ],
        &env,
    )
    .context("could not fetch the repository")?;
    git_with(mirror, &["symbolic-ref", "HEAD", &job.head], &[]).context("could not point HEAD at the default branch")?;
    let refs_changed = changed_refs(before, &refs_of(mirror));
    crate::abuse::touch();
    let repack = if first {
        // Artifacts' deltas are poor: every one is recomputed.
        git_with(mirror, &["repack", "-a", "-d", "-f", "-q", "--write-bitmap-index"], &[]).context("could not repack the mirror")?;
        std::fs::write(mirror.join(PACKED_MARKER), "").context("could not mark the mirror packed")?;
        "repacked in full"
    } else if packs_of(mirror).0 > MAX_PACKS {
        git_with(mirror, &["repack", "-a", "-d", "-q", "--write-bitmap-index"], &[]).context("could not repack the mirror")?;
        "repacked"
    } else {
        "not repacked"
    };
    Ok(Synced { refs_changed, repack })
}

/// The background worker: runs the syncs asked for, one at a time, the
/// latest asked for next.
fn work(edge: Arc<Edge>) {
    loop {
        let job = {
            let mut state = edge.state();
            loop {
                if let Some(job) = state.next.take() {
                    break job;
                }
                state.syncing = false;
                state = edge.wake.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        crate::abuse::touch();
        let disk = edge.disk.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let started = Instant::now();
        let result = sync(&edge, &job, || edge.state().changing = true);
        drop(disk);
        let elapsed = started.elapsed().as_millis();
        let (packs, bytes) = packs_of(&edge.mirror());
        let mut state = edge.state();
        match result {
            Ok(synced) => {
                state.version = Some(job.version);
                eprintln!(
                    "g1t-runner: gitedge: synced to version {} in {elapsed} ms: {} refs changed, {}, {packs} packs, {}",
                    job.version,
                    synced.refs_changed,
                    synced.repack,
                    megabytes(bytes)
                );
            }
            Err(failed) => {
                // A sync that failed after it changed the refs leaves the
                // mirror at no version it could name.
                if failed.changed {
                    state.version = None;
                }
                // On one line, as every sync is logged.
                let said = redact(&format!("{:#}", failed.error), std::slice::from_ref(&job.token));
                let said = said.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ");
                let kept = state.version.map_or_else(|| "none".to_owned(), |version| version.to_string());
                eprintln!(
                    "g1t-runner: gitedge: the sync to version {} failed after {elapsed} ms, the mirror is at version {kept}: {said}",
                    job.version
                );
            }
        }
        state.changing = false;
    }
}

/// A request's header, by name in any case.
fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers().iter().find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|header| header.value.as_str())
}

fn respond<R: Read>(request: Request, response: Response<R>) {
    if let Err(error) = request.respond(response) {
        eprintln!("g1t-runner: gitedge: could not answer: {error}");
    }
}

/// Whether an `info/refs` query asks for upload-pack, and nothing else.
pub(crate) fn is_upload_pack(query: &str) -> bool {
    let services: Vec<&str> = query.split('&').filter(|pair| pair.starts_with("service=")).collect();
    services == ["service=git-upload-pack"]
}

/// The status in a CGI `Status:` header's value (`403 Forbidden`).
pub(crate) fn cgi_status(value: &str) -> Option<u16> {
    value.split_whitespace().next()?.parse().ok().filter(|status| (100..600).contains(status))
}

/// Answers one request, and logs it.
fn handle(edge: &Edge, request: Request) {
    let started = Instant::now();
    let method = request.method().clone();
    let url = request.url().to_owned();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let (endpoint, status, bytes) = match (&method, path) {
        (Method::Get, "/state") => {
            let body = {
                let state = edge.state();
                json!({ "version": state.version, "syncing": state.syncing }).to_string()
            };
            let content_type = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("a valid header");
            // Polled, so not logged.
            respond(request, Response::from_string(body).with_header(content_type));
            return;
        }
        (Method::Post, "/sync") => ("sync", ask_sync(edge, request), 0),
        (Method::Get, "/snapshot") => {
            let (status, bytes) = snapshot(edge, request);
            ("snapshot", status, bytes)
        }
        (Method::Put, "/snapshot") => ("restore", restore(edge, request), 0),
        (Method::Get, "/git/info/refs") if is_upload_pack(query) => {
            let (status, bytes) = serve_git(edge, request, "info/refs", query);
            ("info/refs", status, bytes)
        }
        (Method::Post, "/git/git-upload-pack") => {
            let (status, bytes) = serve_git(edge, request, "git-upload-pack", query);
            ("git-upload-pack", status, bytes)
        }
        // receive-pack, and anything else.
        _ => {
            respond(request, Response::empty(403));
            (path, 403, 0)
        }
    };
    eprintln!("g1t-runner: gitedge: {method} {endpoint} {status}, {bytes} bytes, {} ms", started.elapsed().as_millis());
}

/// `POST /sync`: remembers the sync for the worker, and answers `202`.
fn ask_sync(edge: &Edge, mut request: Request) -> u16 {
    let mut body = Vec::new();
    if request.as_reader().take(MAX_SYNC_BODY + 1).read_to_end(&mut body).is_err() {
        respond(request, Response::empty(400));
        return 400;
    }
    if body.len() as u64 > MAX_SYNC_BODY {
        respond(request, Response::empty(413));
        return 413;
    }
    // serde's message could quote the body, token and all: only where it
    // went wrong is said.
    let job: Sync = match serde_json::from_slice(&body) {
        Ok(job) => job,
        Err(error) => {
            let said = format!("the sync could not be read (line {}, column {})", error.line(), error.column());
            respond(request, Response::from_string(said).with_status_code(400));
            return 400;
        }
    };
    if let Some(said) = invalid(&job) {
        respond(request, Response::from_string(said).with_status_code(400));
        return 400;
    }
    {
        let mut state = edge.state();
        state.next = Some(job);
        state.syncing = true;
    }
    edge.wake.notify_one();
    respond(request, Response::empty(202));
    202
}

/// Snapshots made at once, each named apart (`snapshot-<n>.tar`).
static SNAPSHOTS: AtomicU64 = AtomicU64::new(0);

/// `GET /snapshot`: the mirror as a tar of its directory, for the Durable
/// Object to keep in R2 (services/runner gitedge.ts) and restore when a
/// container starts cold, with the version the mirror is at in
/// `x-g1t-edge-version`. Only of a mirror a sync has packed and left at a
/// version (`409` otherwise). The tar is made into a file while the disk
/// is held, so no sync changes the mirror half way through it, then sent
/// with its length, as R2 wants it.
fn snapshot(edge: &Edge, request: Request) -> (u16, u64) {
    let name = format!("snapshot-{}.tar", SNAPSHOTS.fetch_add(1, Ordering::Relaxed));
    let file = edge.root.join(&name);
    let made = {
        let _disk = edge.disk.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let version = {
            let state = edge.state();
            if state.changing { None } else { state.version }
        };
        match version.filter(|_| edge.mirror().join(PACKED_MARKER).exists()) {
            None => None,
            Some(version) => Some((
                version,
                Command::new("tar").current_dir(&edge.root).args(["-cf", &name, MIRROR]).stdin(Stdio::null()).output(),
            )),
        }
    };
    let version = match made {
        None => {
            respond(request, Response::empty(409));
            return (409, 0);
        }
        Some((version, Ok(output))) if output.status.success() => version,
        Some((_, made)) => {
            let said = made.map_or_else(|error| error.to_string(), |output| String::from_utf8_lossy(&output.stderr).trim().to_owned());
            eprintln!("g1t-runner: gitedge: could not make a snapshot: {said}");
            let _ = std::fs::remove_file(&file);
            respond(request, Response::empty(500));
            return (500, 0);
        }
    };
    let opened = std::fs::File::open(&file).and_then(|opened| opened.metadata().map(|meta| (opened, meta.len())));
    let (status, bytes) = match opened {
        Ok((opened, bytes)) => {
            let at = Header::from_bytes(VERSION_HEADER.as_bytes(), version.to_string().as_bytes()).expect("a valid header");
            // With its length, never chunked (tiny_http chunks what is
            // larger than 32 KB unless told), as R2 needs the length.
            respond(request, Response::from_file(opened).with_header(at).with_chunked_threshold(usize::MAX));
            (200, bytes)
        }
        Err(error) => {
            eprintln!("g1t-runner: gitedge: could not read the snapshot: {error}");
            respond(request, Response::empty(500));
            (500, 0)
        }
    };
    let _ = std::fs::remove_file(&file);
    (status, bytes)
}

/// `PUT /snapshot`, with the version it was made at in
/// `x-g1t-edge-version`: a snapshot of this repository's mirror (`GET
/// /snapshot`) unpacked as the mirror of an edge that has none, which is
/// then at that version, so the sync asked for next fetches only what is
/// newer instead of the whole repository. Only ever into an empty edge
/// that no sync has been asked of (`409` otherwise); a snapshot that does
/// not unpack into a packed bare repository is refused (`422`) and leaves
/// nothing behind.
fn restore(edge: &Edge, mut request: Request) -> u16 {
    let Some(version) = header(&request, VERSION_HEADER).and_then(|value| value.trim().parse::<u64>().ok()) else {
        respond(request, Response::from_string("x-g1t-edge-version says the snapshot's version").with_status_code(400));
        return 400;
    };
    let _disk = edge.disk.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mirror = edge.mirror();
    {
        let state = edge.state();
        if state.syncing || state.version.is_some() || mirror.join("HEAD").exists() {
            respond(request, Response::empty(409));
            return 409;
        }
    }
    let unpacked = std::fs::create_dir_all(&edge.root).map_err(anyhow::Error::from).and_then(|()| {
        let mut tar = Command::new("tar")
            .current_dir(&edge.root)
            .args(["-xf", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .context("could not run tar")?;
        let mut stdin = tar.stdin.take().expect("piped");
        let copied = io::copy(request.as_reader(), &mut stdin);
        drop(stdin);
        let output = tar.wait_with_output()?;
        copied.context("could not read the snapshot")?;
        if !output.status.success() {
            bail!("tar failed: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
        if !mirror.join(PACKED_MARKER).exists() || git_with(&mirror, &["rev-parse", "--is-bare-repository"], &[])? != "true" {
            bail!("it is not a packed mirror");
        }
        Ok(())
    });
    if let Err(error) = unpacked {
        eprintln!("g1t-runner: gitedge: the snapshot at version {version} was not restored: {error:#}");
        let _ = std::fs::remove_dir_all(&mirror);
        respond(request, Response::empty(422));
        return 422;
    }
    let (packs, bytes) = packs_of(&mirror);
    edge.state().version = Some(version);
    eprintln!("g1t-runner: gitedge: restored a snapshot at version {version}: {packs} packs, {}", megabytes(bytes));
    respond(request, Response::empty(204));
    204
}

/// The body of `git http-backend`'s answer, in the chunks its stdout is
/// read in, `HELD_CHUNKS` of them at most in memory.
struct Chunks {
    from: Receiver<Vec<u8>>,
    chunk: Vec<u8>,
    at: usize,
}

impl Read for Chunks {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.at == self.chunk.len() {
            match self.from.recv() {
                Ok(chunk) => {
                    self.chunk = chunk;
                    self.at = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let read = buf.len().min(self.chunk.len() - self.at);
        buf[..read].copy_from_slice(&self.chunk[self.at..self.at + read]);
        self.at += read;
        Ok(read)
    }
}

/// Reads `from` in chunks into `to` until it ends, or nobody reads them
/// any more (the client went away), which closes `from`.
fn pump(mut from: impl Read, to: SyncSender<Vec<u8>>) {
    let mut buffer = vec![0u8; CHUNK];
    loop {
        match from.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if to.send(buffer[..read].to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

/// Counts what is read through it.
struct Counted<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.count.fetch_add(read as u64, Ordering::Relaxed);
        Ok(read)
    }
}

/// `info/refs` and `git-upload-pack`: `409` unless the mirror is at the
/// version asked for, else `git http-backend`'s answer. Returns the status
/// and the body's bytes.
fn serve_git(edge: &Edge, request: Request, endpoint: &str, query: &str) -> (u16, u64) {
    crate::abuse::touch();
    let expected = header(&request, VERSION_HEADER).and_then(|value| value.trim().parse::<u64>().ok());
    let current = {
        let state = edge.state();
        if state.changing { None } else { state.version }
    };
    let behind = |request: Request| {
        let behind = Header::from_bytes(EDGE_HEADER.as_bytes(), &b"behind"[..]).expect("a valid header");
        respond(request, Response::empty(409).with_header(behind));
        (409, 0)
    };
    if expected.is_none() || expected != current {
        return behind(request);
    }
    // A fetch is answered only when the mirror has every object and ref it
    // wants. The version the repos service asks for is the one it has in
    // hand, which can trail the repository's for a moment after a merge (an
    // isolate's copy, a read replica): the mirror is then at that older
    // version too, without the new commit, and upload-pack would die on the
    // want (git says `expected 'packfile'`). Behind, the fetch goes to
    // Artifacts, and the edge is told to catch up.
    let mut request = request;
    let body = if endpoint == "git-upload-pack" {
        match read_fetch(&mut request) {
            Some(body) => {
                if let Some(missing) = missing_wants(&edge.mirror(), &body, header(&request, "content-encoding")) {
                    eprintln!("g1t-runner: gitedge: behind its version: the mirror has no {missing}");
                    return behind(request);
                }
                Some(body)
            }
            // Too large, or cut short: the store answers it.
            None => return behind(request),
        }
    } else {
        None
    };
    match backend(edge, request, endpoint, query, body) {
        Ok(served) => served,
        Err(error) => {
            eprintln!("g1t-runner: gitedge: git http-backend failed: {error:#}");
            (500, 0)
        }
    }
}

/// The most a fetch's request may be for the edge to read it and check its
/// wants. Haves make a fetch's request grow; past this, the store answers.
const MAX_FETCH_BODY: u64 = 16 * 1024 * 1024;

/// A fetch's request body, read whole (as sent: gzip stays gzip), or None
/// when it is larger than `MAX_FETCH_BODY` or cannot be read.
fn read_fetch(request: &mut Request) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    request.as_reader().take(MAX_FETCH_BODY + 1).read_to_end(&mut body).ok()?;
    (body.len() as u64 <= MAX_FETCH_BODY).then_some(body)
}

/// The objects (`want <oid>`) and refs (`want-ref <ref>`) a fetch's request
/// wants, in protocol v0 or v2, from its pkt-lines. `encoding` is the
/// request's Content-Encoding: git compresses a large request with gzip.
pub(crate) fn wants(body: &[u8], encoding: Option<&str>) -> Option<(Vec<String>, Vec<String>)> {
    let decoded;
    let body = if encoding.is_some_and(|encoding| encoding.trim().eq_ignore_ascii_case("gzip") || encoding.trim().eq_ignore_ascii_case("x-gzip")) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(body).take(4 * MAX_FETCH_BODY).read_to_end(&mut out).ok()?;
        decoded = out;
        decoded.as_slice()
    } else {
        body
    };
    let (mut objects, mut refs) = (Vec::new(), Vec::new());
    let mut at = 0;
    while at + 4 <= body.len() {
        let length = usize::from_str_radix(std::str::from_utf8(&body[at..at + 4]).ok()?, 16).ok()?;
        // Flush, delimiter and response-end packets carry nothing.
        if length < 4 {
            at += 4;
            continue;
        }
        let line = std::str::from_utf8(body.get(at + 4..at + length)?).ok()?.trim_end_matches('\n');
        at += length;
        if let Some(rest) = line.strip_prefix("want-ref ") {
            refs.push(rest.trim().to_owned());
        } else if let Some(rest) = line.strip_prefix("want ") {
            // In v0 the first want carries the capabilities after its id.
            objects.push(rest.split_whitespace().next()?.to_owned());
        }
    }
    Some((objects, refs))
}

/// What the mirror lacks of what a fetch wants (`a1b2c3…` or `refs/…`), or
/// None when it has all of it. A request that cannot be read is answered
/// by upload-pack, which says why.
fn missing_wants(mirror: &Path, body: &[u8], encoding: Option<&str>) -> Option<String> {
    let (objects, refs) = wants(body, encoding)?;
    if !objects.is_empty() {
        let checked = Command::new("git")
            .current_dir(mirror)
            .args(["cat-file", "--batch-check=%(objectname)"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .and_then(|mut child| {
                let mut stdin = child.stdin.take().expect("piped");
                // Written from a thread, so a long list cannot fill both pipes.
                let list = objects.join("\n") + "\n";
                let writer = std::thread::spawn(move || io::Write::write_all(&mut stdin, list.as_bytes()));
                let output = child.wait_with_output()?;
                let _ = writer.join();
                Ok(output)
            });
        match checked {
            Ok(output) => {
                if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().find(|line| line.ends_with(" missing")) {
                    return Some(line.trim_end_matches(" missing").to_owned());
                }
            }
            Err(error) => return Some(format!("way to check what it has ({error})")),
        }
    }
    refs.into_iter().find(|name| git_with(mirror, &["show-ref", "--verify", "--quiet", name], &[]).is_err())
}

/// Runs `git http-backend` as CGI for one request: its body (`body`, when
/// it was read already to check its wants) is passed to the backend while
/// the backend's answer is read, and the answer streamed back with the CGI
/// headers as HTTP headers. No pack is ever held whole.
fn backend(edge: &Edge, mut request: Request, endpoint: &str, query: &str, body: Option<Vec<u8>>) -> Result<(u16, u64)> {
    let post = *request.method() == Method::Post;
    let mut command = Command::new("git");
    command.arg("http-backend").current_dir(&edge.root);
    // Nothing of this process's git settings reaches the backend.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(&key);
        }
    }
    command
        // Without REMOTE_USER, http-backend never runs receive-pack.
        .env_remove("REMOTE_USER")
        .env("GIT_PROJECT_ROOT", &edge.root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("GATEWAY_INTERFACE", "CGI/1.1")
        .env("SERVER_PROTOCOL", "HTTP/1.1")
        .env("REQUEST_METHOD", if post { "POST" } else { "GET" })
        .env("PATH_INFO", format!("/{MIRROR}/{endpoint}"))
        .env("QUERY_STRING", query);
    for (name, variable) in [("content-type", "CONTENT_TYPE"), ("git-protocol", "GIT_PROTOCOL"), ("content-encoding", "HTTP_CONTENT_ENCODING")] {
        if let Some(value) = header(&request, name) {
            command.env(variable, value);
        }
    }
    if let Some(length) = body.as_ref().map(Vec::len).or_else(|| request.body_length()) {
        command.env("CONTENT_LENGTH", length.to_string());
    }
    if let Some(address) = request.remote_addr() {
        command.env("REMOTE_ADDR", address.ip().to_string());
    }
    let spawned = command
        .stdin(if post { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            respond(request, Response::empty(500));
            bail!("could not run it: {error}");
        }
    };
    let stderr = child.stderr.take().expect("piped");
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            eprintln!("g1t-runner: gitedge: http-backend: {line}");
        }
    });
    let stdout = child.stdout.take().expect("piped");
    let (to, from) = sync_channel(HELD_CHUNKS);
    std::thread::spawn(move || pump(stdout, to));
    if let Some(mut stdin) = child.stdin.take() {
        // The backend may stop reading early (a bad request): what it
        // answers is still read below.
        let passed = match &body {
            Some(body) => io::Write::write_all(&mut stdin, body),
            None => io::copy(request.as_reader(), &mut stdin).map(|_| ()),
        };
        if let Err(error) = passed
            && error.kind() != io::ErrorKind::BrokenPipe
        {
            eprintln!("g1t-runner: gitedge: could not pass the request's body on: {error}");
        }
        drop(stdin);
    }
    let mut out = BufReader::new(Chunks { from, chunk: Vec::new(), at: 0 });
    let mut status = 200;
    let mut length = None;
    let mut headers = Vec::new();
    loop {
        let mut line = Vec::new();
        if out.read_until(b'\n', &mut line).unwrap_or(0) == 0 {
            // It ended before its headers did.
            respond(request, Response::empty(502));
            let _ = child.wait();
            bail!("it gave no answer");
        }
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim(), value.trim());
        match name.to_ascii_lowercase().as_str() {
            "status" => status = cgi_status(value).unwrap_or(500),
            "content-length" => length = value.parse::<usize>().ok(),
            // Framing is the server's own.
            "transfer-encoding" | "connection" => {}
            _ => {
                if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
                    headers.push(header);
                }
            }
        }
    }
    let count = Arc::new(AtomicU64::new(0));
    let body = Counted { inner: out, count: count.clone() };
    respond(request, Response::new(StatusCode(status), headers, body, length, None));
    let exit = child.wait()?;
    if !exit.success() {
        eprintln!("g1t-runner: gitedge: git http-backend exited with {exit}");
    }
    Ok((status, count.load(Ordering::Relaxed)))
}

pub fn main() -> i32 {
    let port = std::env::var("GITEDGE_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_owned());
    let root = PathBuf::from(std::env::var("GITEDGE_DIR").unwrap_or_else(|_| DEFAULT_DIR.to_owned()));
    let server = match Server::http(format!("0.0.0.0:{port}")) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("g1t-runner: gitedge: could not listen on port {port}: {error}");
            return 1;
        }
    };
    let listening = server.server_addr().to_ip().map_or_else(|| format!("port {port}"), |address| address.to_string());
    eprintln!("g1t-runner: gitedge: listening on {listening}, the mirror in {}", root.join(MIRROR).display());
    let edge = Arc::new(Edge { root, state: Mutex::new(State::default()), wake: Condvar::new(), disk: Mutex::new(()) });
    let worker = edge.clone();
    std::thread::spawn(move || work(worker));
    for request in server.incoming_requests() {
        let edge = edge.clone();
        std::thread::spawn(move || handle(&edge, request));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(name, hash)| ((*name).to_owned(), (*hash).to_owned())).collect()
    }

    #[test]
    fn refs_added_moved_and_gone_are_counted() {
        let before = refs(&[("refs/heads/main", "a"), ("refs/tags/v1", "b"), ("HEAD", "refs/heads/main")]);
        let after = refs(&[("refs/heads/main", "c"), ("refs/heads/new", "d"), ("HEAD", "refs/heads/main")]);
        assert_eq!(changed_refs(&before, &after), 3);
        assert_eq!(changed_refs(&before, &before), 0);
    }

    #[test]
    fn only_upload_pack_is_asked_for() {
        assert!(is_upload_pack("service=git-upload-pack"));
        assert!(!is_upload_pack("service=git-receive-pack"));
        assert!(!is_upload_pack("service=git-upload-pack&service=git-receive-pack"));
        assert!(!is_upload_pack(""));
    }

    #[test]
    fn a_cgi_status_is_read() {
        assert_eq!(cgi_status("403 Forbidden"), Some(403));
        assert_eq!(cgi_status("200"), Some(200));
        assert_eq!(cgi_status("nope"), None);
        assert_eq!(cgi_status("999 Whatever"), None);
    }

    fn pkt(line: &str) -> String {
        format!("{:04x}{line}", line.len() + 4)
    }

    #[test]
    fn a_fetch_says_what_it_wants() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        // Protocol v2: capabilities, a delimiter, the arguments.
        let v2 = [pkt("command=fetch
"), pkt("object-format=sha1
"), "0001".to_owned(), pkt("thin-pack
"), pkt("deepen 1
"), pkt(&format!("want {a}
")), pkt("want-ref refs/heads/main
"), pkt(&format!("have {b}
")), pkt("done
"), "0000".to_owned()].concat();
        assert_eq!(wants(v2.as_bytes(), None), Some((vec![a.clone()], vec!["refs/heads/main".to_owned()])));
        // Protocol v0: the first want carries the capabilities.
        let v0 = [pkt(&format!("want {a} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=git/2.39.5
")), pkt(&format!("want {b}
")), "0000".to_owned(), pkt("done
")].concat();
        assert_eq!(wants(v0.as_bytes(), None), Some((vec![a.clone(), b.clone()], vec![])));
        // Gzipped, as git sends a large request.
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gzip, v2.as_bytes()).unwrap();
        assert_eq!(wants(&gzip.finish().unwrap(), Some("gzip")).map(|(objects, _)| objects), Some(vec![a]));
        // Not pkt-lines.
        assert_eq!(wants(b"zzzz", None), None);
    }

    #[test]
    fn a_sync_needs_a_remote_and_a_ref() {
        let sync = |remote: &str, head: &str| Sync { remote: remote.to_owned(), token: String::new(), version: 1, head: head.to_owned() };
        assert_eq!(invalid(&sync("https://example.com/r.git", "refs/heads/main")), None);
        assert!(invalid(&sync("--upload-pack=evil", "refs/heads/main")).is_some());
        assert!(invalid(&sync("", "refs/heads/main")).is_some());
        assert!(invalid(&sync("https://example.com/r.git", "main")).is_some());
        assert!(invalid(&sync("https://example.com/r.git", "refs/heads/../x")).is_some());
    }
}

