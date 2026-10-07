//! Packs for fresh clones, kept for the next clone of the same commit.
//!
//! An upload-pack request that wants objects and has none (`have` lines)
//! is a clone: a new checkout, or a sandbox's shallow `deepen 1` clone of
//! a pull request's head. The git store builds the same pack for it every
//! time, which takes seconds and is an operation. The answer is kept in a
//! bucket ([`PackStore`]: R2's `GIT_PACKS` on Cloudflare, or any
//! S3-compatible store, as [`STORAGE`] says) under the
//! repository's id, the version of its refs (`refs_version`, see
//! registry.rs and refs_cache.rs) and a hash of the request with what does
//! not change the answer taken out ([`normalize`]): the client's `agent`,
//! its session id, and the order of its lines. A change to the refs moves
//! the version, so a pack is never served across one; old ones are left for
//! the bucket's lifecycle rule to delete.
//!
//! On a miss the store's answer goes to git as it arrives and, at the same
//! time, to the bucket ([`Tee`] and [`fill`]): never held whole. Packs over
//! [`MAX_PACK_BYTES`] pass through. What is kept is only ever a whole pack:
//! a small one is written in one `put` once it has all arrived, a larger
//! one in multipart parts that become an object only when the last has
//! been checked ([`PackCheck`]); a fill cut short is aborted and leaves
//! nothing to serve.
//!
//! Only ever served after the request was authorized, like any answer from
//! the store: a private repository's packs are read only by whoever may
//! read it. Without a bucket (no `GIT_PACKS` binding, and PACK_STORE not
//! `s3`) nothing is kept and every clone goes to the store, as before.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use futures_util::{Stream, StreamExt};
use g1t_contracts::repos::GitService;
use g1t_blobstore::{BlobStore, Config, Part, Store};
use worker::{Env, Headers, Response, ResponseBody, Result};

use crate::git_http::GitRequest;

/// An error worth seeing in the Worker's logs; on stderr in tests, where
/// there is no console to call.
macro_rules! log {
    ($($arg:tt)*) => {{
        #[cfg(target_arch = "wasm32")]
        worker::console_error!($($arg)*);
        #[cfg(not(target_arch = "wasm32"))]
        eprintln!($($arg)*);
    }};
}

/// The meters (meters.rs): a clone answered from the bucket, and one the
/// store was asked for. Neither is an operation unless `operation_mapping`
/// says so; by default they are not.
pub const HIT: &str = "pack_cache.hit";
pub const MISS: &str = "pack_cache.miss";

/// Packs larger than this pass through without being kept.
pub const MAX_PACK_BYTES: u64 = 200 * 1024 * 1024;
/// Requests larger than this (a great many wants) are not kept.
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// A multipart part: R2's smallest, so a fill holds as little as it can.
/// Every part but the last is this size, as R2 requires.
const PART_BYTES: usize = 5 * 1024 * 1024;
/// What may wait between git's stream and the bucket. A bucket slower than
/// git ends the fill rather than holding more.
const MAX_QUEUED_BYTES: usize = 5 * 1024 * 1024;
/// Fills at once in one isolate; more clones pass through.
const MAX_FILLS: usize = 2;
pub const CONTENT_TYPE: &str = "application/x-git-upload-pack-result";

/// Where packs are kept. A small port over what a fill and a hit need; its
/// adapter, [`Packs`], puts any [`BlobStore`] behind it.
#[allow(async_fn_in_trait)]
pub trait PackStore {
    /// The object's size and body, if it is there.
    async fn get(&self, key: &str) -> Result<Option<(u64, ResponseBody)>>;
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()>;
    /// Starts a multipart upload to `key`; its id.
    async fn begin(&self, key: &str) -> Result<String>;
    /// Uploads part `number` (from 1); its etag.
    async fn part(&self, key: &str, upload: &str, number: u16, bytes: Vec<u8>) -> Result<String>;
    /// Makes the object from the parts, which until now nobody can read.
    async fn complete(&self, key: &str, upload: &str, parts: Vec<(u16, String)>) -> Result<()>;
    async fn abort(&self, key: &str, upload: &str) -> Result<()>;
}

/// Where packs are kept, by the names of the service's bindings and
/// variables: the `GIT_PACKS` R2 bucket on Cloudflare or, when PACK_STORE
/// is `s3`, the bucket PACK_S3_BUCKET names on the installation's
/// S3-compatible store (`g1t-git-packs` on RustFS in the self-host compose
/// file). On either an object exists only once it is whole: a `put` makes
/// it in one write, and a multipart upload is nothing anyone can read
/// until it is completed.
pub const STORAGE: Config = Config {
    kind: "PACK_STORE",
    binding: "GIT_PACKS",
    r2_signer: None,
    s3_bucket: "PACK_S3_BUCKET",
    s3_public_endpoint: None,
};

/// The adapter: packs as objects in a [`BlobStore`].
pub struct Packs<B: BlobStore = Store> {
    store: B,
}

impl Packs<Store> {
    /// `None` when this installation keeps no packs: no `GIT_PACKS`
    /// binding, and PACK_STORE is not `s3`. Every clone then goes to the
    /// git store.
    pub fn from_env(env: &Env) -> Option<Packs<Store>> {
        match Store::from_env(env, &STORAGE) {
            Ok(store) => Some(Packs { store }),
            Err(error) => {
                // No R2 binding is the cache turned off; an S3 store asked
                // for and not configured is worth saying.
                if g1t_blobstore::var(env, STORAGE.kind) == "s3" {
                    log!("pack cache is off: {error}");
                }
                None
            }
        }
    }
}

impl<B: BlobStore> PackStore for Packs<B> {
    async fn get(&self, key: &str) -> Result<Option<(u64, ResponseBody)>> {
        Ok(self.store.get(key, None).await?.map(|got| (got.size, got.body)))
    }

    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.store.put(key, bytes).await
    }

    async fn begin(&self, key: &str) -> Result<String> {
        self.store.create_multipart(key).await
    }

    async fn part(&self, key: &str, upload: &str, number: u16, bytes: Vec<u8>) -> Result<String> {
        Ok(self.store.upload_part(key, upload, number, bytes).await?.etag)
    }

    async fn complete(&self, key: &str, upload: &str, parts: Vec<(u16, String)>) -> Result<()> {
        let parts: Vec<Part> = parts.into_iter().map(|(number, etag)| Part { number, etag }).collect();
        self.store.complete_multipart(key, upload, &parts).await
    }

    async fn abort(&self, key: &str, upload: &str) -> Result<()> {
        self.store.abort_multipart(key, upload).await
    }
}

/// The pkt-line payloads of `body`, with flush (`0000`) and delimiter
/// (`0001`) packets as `None`; `None` if it is not one whole pkt-line
/// stream.
fn lines(body: &[u8]) -> Option<Vec<Option<&[u8]>>> {
    let mut out = Vec::new();
    let mut position = 0;
    while position < body.len() {
        let header = body.get(position..position + 4)?;
        let length = usize::from_str_radix(std::str::from_utf8(header).ok()?, 16).ok()?;
        match length {
            0 | 1 => {
                out.push(None);
                position += 4;
            }
            2 | 3 => return None,
            _ => {
                let payload = body.get(position + 4..position + length)?;
                out.push(Some(payload.strip_suffix(b"\n").unwrap_or(payload)));
                position += length;
            }
        }
    }
    Some(out)
}

/// Capabilities that say who is asking, not what: left out of the key.
fn says_who(capability: &str) -> bool {
    capability.starts_with("agent=") || capability.starts_with("session-id=")
}

/// A fetch request in a form that is the same for every request whose
/// answer is the same, or `None` if its answer is not kept: anything but a
/// fetch of objects, one that sends `have`s (negotiation: what the client
/// has decides the pack) or `shallow`s (it has commits already), one with
/// no wants, or one that is not a whole request. `protocol` is the
/// `Git-Protocol` version (refs_cache::protocol).
pub fn normalize(protocol: u8, body: &[u8]) -> Option<String> {
    if body.len() > MAX_REQUEST_BYTES {
        return None;
    }
    let lines = lines(body)?;
    if protocol == 2 { normalize_v2(&lines) } else { normalize_v0(&lines) }
}

/// Protocol v2: `command=fetch`, capabilities, a delimiter, then the
/// arguments and a flush. Neither section's order matters.
fn normalize_v2(lines: &[Option<&[u8]>]) -> Option<String> {
    let text = |line: &[u8]| std::str::from_utf8(line).ok().map(str::to_owned);
    let mut lines = lines.iter();
    if *lines.next()? != Some(b"command=fetch".as_slice()) {
        return None;
    }
    let mut capabilities = BTreeSet::new();
    let mut arguments = BTreeSet::new();
    let mut in_arguments = false;
    let mut ended = false;
    for line in lines.by_ref() {
        match line {
            None if !in_arguments => in_arguments = true,
            None => {
                ended = true;
                break;
            }
            Some(line) => {
                let line = text(line)?;
                if !in_arguments {
                    if !says_who(&line) {
                        capabilities.insert(line);
                    }
                } else if line.starts_with("have ") || line.starts_with("shallow ") {
                    return None;
                } else {
                    arguments.insert(line);
                }
            }
        }
    }
    // A flush ends the request, and nothing follows it.
    if !ended || lines.next().is_some() {
        return None;
    }
    if !arguments.iter().any(|line| line.starts_with("want ") || line.starts_with("want-ref ")) {
        return None;
    }
    let capabilities = capabilities.into_iter().collect::<Vec<_>>().join("\n");
    let arguments = arguments.into_iter().collect::<Vec<_>>().join("\n");
    Some(format!("v2\n{capabilities}\n--\n{arguments}"))
}

/// Protocol v0 and v1: wants (the first with the capabilities after its
/// object id), `shallow`, `deepen`, `filter` lines, a flush, then `done`.
fn normalize_v0(lines: &[Option<&[u8]>]) -> Option<String> {
    let mut capabilities = BTreeSet::new();
    let mut requests = BTreeSet::new();
    let mut lines = lines.iter();
    let mut flushed = false;
    for line in lines.by_ref() {
        let Some(line) = line else {
            flushed = true;
            break;
        };
        let line = std::str::from_utf8(line).ok()?;
        if let Some(rest) = line.strip_prefix("want ") {
            let (oid, rest) = rest.split_once(' ').unwrap_or((rest, ""));
            capabilities.extend(rest.split(' ').filter(|c| !c.is_empty() && !says_who(c)).map(str::to_owned));
            requests.insert(format!("want {oid}"));
        } else if line.starts_with("shallow ") || line.starts_with("have ") {
            return None;
        } else {
            requests.insert(line.to_owned());
        }
    }
    // Then only `done`: a `have` is negotiation, and without `done` the
    // answer is not a pack.
    if !flushed || lines.as_slice() != [Some(b"done".as_slice())] {
        return None;
    }
    if !requests.iter().any(|line| line.starts_with("want ")) {
        return None;
    }
    let capabilities = capabilities.into_iter().collect::<Vec<_>>().join(" ");
    let requests = requests.into_iter().collect::<Vec<_>>().join("\n");
    Some(format!("v0\n{capabilities}\n--\n{requests}\ndone"))
}

/// The normalized request, if `git`'s answer may be kept: a POST to
/// upload-pack with a body read whole and not compressed, that
/// [`normalize`] accepts.
pub fn cacheable(git: &GitRequest, get: bool, protocol: u8, encoding: Option<&str>, body: Option<&[u8]>) -> Option<String> {
    if git.service != GitService::UploadPack || git.endpoint != "git-upload-pack" || get {
        return None;
    }
    if encoding.is_some_and(|encoding| !encoding.trim().is_empty() && !encoding.trim().eq_ignore_ascii_case("identity")) {
        return None;
    }
    normalize(protocol, body?)
}

/// Where one pack is kept: by repository, refs version and request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key(String);

impl Key {
    pub fn new(repo_id: &str, refs_version: u64, normalized: &str) -> Key {
        Key(format!("packs/{repo_id}/{refs_version}/{}", g1t_secrets::sha256_hex(normalized)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A kept pack.
pub struct Kept {
    pub size: u64,
    pub body: ResponseBody,
}

impl Kept {
    /// The answer git gets, as the store would give it.
    pub fn response(self) -> Result<Response> {
        let headers = Headers::new();
        headers.set("content-type", CONTENT_TYPE)?;
        headers.set("cache-control", "no-cache")?;
        Ok(Response::from_body(self.body)?.with_headers(headers))
    }
}

/// The pack kept under `key`. A failure to read is a miss.
pub async fn get<S: PackStore>(store: &S, key: &Key) -> Option<Kept> {
    match store.get(key.as_str()).await {
        Ok(found) => found.map(|(size, body)| Kept { size, body }),
        Err(error) => {
            log!("pack cache not read: {error}");
            None
        }
    }
}

/// Checks, as it streams past, that an upload-pack answer is one whole
/// pack: every packet well formed, a pack in side-band channel 1, no
/// error (`ERR`, or channel 3), and a flush at the end.
#[derive(Debug, Default)]
pub struct PackCheck {
    header: Vec<u8>,
    /// Payload bytes still to come in the current packet.
    remaining: usize,
    /// The first bytes of the current packet's payload, until judged.
    start: Vec<u8>,
    judged: bool,
    saw_pack: bool,
    failed: bool,
    last_flush: bool,
}

/// How much of a packet's start says what it is: `\x01PACK`.
const START: usize = 5;

impl PackCheck {
    pub fn feed(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() && !self.failed {
            if self.remaining == 0 {
                let take = (4 - self.header.len()).min(bytes.len());
                self.header.extend_from_slice(&bytes[..take]);
                bytes = &bytes[take..];
                if self.header.len() < 4 {
                    return;
                }
                let length = std::str::from_utf8(&self.header).ok().and_then(|hex| usize::from_str_radix(hex, 16).ok());
                self.header.clear();
                self.last_flush = length == Some(0);
                match length {
                    None | Some(3) => self.failed = true,
                    Some(0..=2 | 4) => {}
                    Some(length) => {
                        self.remaining = length - 4;
                        self.start.clear();
                        self.judged = false;
                    }
                }
                continue;
            }
            let take = self.remaining.min(bytes.len());
            if !self.judged {
                let room = (START - self.start.len()).min(take);
                self.start.extend_from_slice(&bytes[..room]);
            }
            self.remaining -= take;
            bytes = &bytes[take..];
            if !self.judged && (self.start.len() >= START || self.remaining == 0) {
                self.judge();
            }
        }
    }

    /// Looks at the start of a packet, once.
    fn judge(&mut self) {
        self.judged = true;
        let start = self.start.as_slice();
        if start.first() == Some(&3) || start.starts_with(b"ERR ") || start.starts_with(b"\x01ERR ") {
            self.failed = true;
        }
        if start.starts_with(b"\x01PACK") {
            self.saw_pack = true;
        }
    }

    pub fn failed(&self) -> bool {
        self.failed
    }

    pub fn complete(&self) -> bool {
        !self.failed && self.saw_pack && self.last_flush && self.remaining == 0 && self.header.is_empty()
    }
}

/// What passes from git's stream to the fill.
#[derive(Debug, PartialEq, Eq)]
enum Piece {
    Bytes(Vec<u8>),
    /// The store's answer ended as it should.
    End,
}

/// The queue between a [`Tee`] and its [`fill`]. Closed without an
/// [`Piece::End`], the fill is abandoned.
#[derive(Default)]
struct Pipe {
    pieces: VecDeque<Piece>,
    queued: usize,
    closed: bool,
    waker: Option<Waker>,
}

type SharedPipe = Rc<RefCell<Pipe>>;

impl Pipe {
    fn close(pipe: &SharedPipe) {
        let mut pipe = pipe.borrow_mut();
        pipe.closed = true;
        if let Some(waker) = pipe.waker.take() {
            waker.wake();
        }
    }
}

/// The receiving end of a [`Pipe`], as a stream.
struct Drain(SharedPipe);

impl Stream for Drain {
    type Item = Piece;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Piece>> {
        let mut pipe = self.0.borrow_mut();
        if let Some(piece) = pipe.pieces.pop_front() {
            if let Piece::Bytes(bytes) = &piece {
                pipe.queued -= bytes.len();
            }
            return Poll::Ready(Some(piece));
        }
        if pipe.closed {
            return Poll::Ready(None);
        }
        pipe.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

type ByteChunks = Pin<Box<dyn Stream<Item = Result<Vec<u8>>>>>;

/// The store's answer on its way to git, copied to a fill while one is
/// wanted, and measured. The fill is let go, and the answer streams on, if
/// the pack grows past [`MAX_PACK_BYTES`] or the bucket falls behind.
pub struct Tee {
    inner: ByteChunks,
    pipe: Option<SharedPipe>,
    seen: u64,
    done: bool,
    /// Told the bytes that went to git, once, however the stream ends.
    on_end: Option<Box<dyn FnOnce(u64)>>,
}

impl Tee {
    fn new(inner: ByteChunks, pipe: Option<SharedPipe>, on_end: Box<dyn FnOnce(u64)>) -> Tee {
        Tee { inner, pipe, seen: 0, done: false, on_end: Some(on_end) }
    }

    fn let_go(&mut self) {
        if let Some(pipe) = self.pipe.take() {
            Pipe::close(&pipe);
        }
    }

    fn ended(&mut self) {
        self.done = true;
        if let Some(pipe) = self.pipe.take() {
            let mut held = pipe.borrow_mut();
            held.pieces.push_back(Piece::End);
            drop(held);
            Pipe::close(&pipe);
        }
        if let Some(on_end) = self.on_end.take() {
            on_end(self.seen);
        }
    }
}

impl Stream for Tee {
    type Item = Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.seen += chunk.len() as u64;
                if self.seen > MAX_PACK_BYTES {
                    self.let_go();
                }
                if let Some(pipe) = &self.pipe {
                    let mut held = pipe.borrow_mut();
                    if held.queued + chunk.len() > MAX_QUEUED_BYTES {
                        drop(held);
                        self.let_go();
                    } else {
                        held.queued += chunk.len();
                        held.pieces.push_back(Piece::Bytes(chunk.clone()));
                        if let Some(waker) = held.waker.take() {
                            waker.wake();
                        }
                    }
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.let_go();
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                if !self.done {
                    self.ended();
                }
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for Tee {
    fn drop(&mut self) {
        // Git went away, or the answer failed, before it ended: whatever the
        // fill has is not a whole pack.
        self.let_go();
        if let Some(on_end) = self.on_end.take() {
            on_end(self.seen);
        }
    }
}

/// How a fill went.
#[derive(Debug, PartialEq, Eq)]
pub enum Filled {
    Kept { bytes: u64 },
    /// Let go: too large, the bucket behind, or the answer cut short.
    Abandoned,
    /// Not a whole pack (an error the store sent as a 200).
    NotAPack,
    /// The bucket refused a write.
    Failed,
}

/// Writes what comes down the pipe to `key`, and only a whole pack: in one
/// put when it is small, in parts otherwise, completed only once the last
/// part has arrived and the pack has been checked. Anything else is
/// aborted, and nothing is left to be read.
async fn fill<S: PackStore>(store: &S, key: &str, mut pieces: impl Stream<Item = Piece> + Unpin) -> Filled {
    let mut check = PackCheck::default();
    let mut buffer: Vec<u8> = Vec::new();
    let mut upload: Option<(String, Vec<(u16, String)>)> = None;
    let mut total = 0u64;
    let outcome = 'pieces: loop {
        match pieces.next().await {
            Some(Piece::Bytes(bytes)) => {
                check.feed(&bytes);
                if check.failed() {
                    break Filled::NotAPack;
                }
                total += bytes.len() as u64;
                buffer.extend_from_slice(&bytes);
                // Strictly more than a part, so the last part is never empty.
                while buffer.len() > PART_BYTES {
                    let rest = buffer.split_off(PART_BYTES);
                    let part = std::mem::replace(&mut buffer, rest);
                    if upload.is_none() {
                        match store.begin(key).await {
                            Ok(id) => upload = Some((id, Vec::new())),
                            Err(error) => {
                                log!("pack cache upload not started: {error}");
                                break 'pieces Filled::Failed;
                            }
                        }
                    }
                    let Some((id, parts)) = upload.as_mut() else { break 'pieces Filled::Failed };
                    let number = parts.len() as u16 + 1;
                    match store.part(key, id, number, part).await {
                        Ok(etag) => parts.push((number, etag)),
                        Err(error) => {
                            log!("pack cache part not uploaded: {error}");
                            break 'pieces Filled::Failed;
                        }
                    }
                }
            }
            Some(Piece::End) if check.complete() => {
                let last = std::mem::take(&mut buffer);
                let finished = match upload.take() {
                    None => store.put(key, last).await,
                    Some((id, mut parts)) => {
                        let number = parts.len() as u16 + 1;
                        let done = match store.part(key, &id, number, last).await {
                            Ok(etag) => {
                                parts.push((number, etag));
                                store.complete(key, &id, parts).await
                            }
                            Err(error) => Err(error),
                        };
                        if done.is_err() {
                            let _ = store.abort(key, &id).await;
                        }
                        done
                    }
                };
                break match finished {
                    Ok(()) => Filled::Kept { bytes: total },
                    Err(error) => {
                        log!("pack not kept: {error}");
                        Filled::Failed
                    }
                };
            }
            Some(Piece::End) => break Filled::NotAPack,
            None => break Filled::Abandoned,
        }
    };
    if let Some((id, _)) = upload {
        // Never completed: an upload nobody can read, aborted now, or by
        // the bucket's lifecycle rule should this fail too.
        let _ = store.abort(key, &id).await;
    }
    outcome
}

thread_local! {
    /// Keys being filled in this isolate: one fill each, at most [`MAX_FILLS`].
    static FILLING: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// Holds a key's place among the fills, until dropped.
struct Filling(String);

impl Filling {
    fn take(key: &str) -> Option<Filling> {
        FILLING.with(|filling| {
            let mut filling = filling.borrow_mut();
            (filling.len() < MAX_FILLS && filling.insert(key.to_owned())).then(|| Filling(key.to_owned()))
        })
    }
}

impl Drop for Filling {
    fn drop(&mut self) {
        FILLING.with(|filling| filling.borrow_mut().remove(&self.0));
    }
}

/// Whether `response`, the store's answer to a cacheable request, may be
/// kept: a 200 of the right type, not known to be too large.
pub fn keepable(response: &Response) -> bool {
    let headers = response.headers();
    let typed = headers
        .get("content-type")
        .ok()
        .flatten()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(CONTENT_TYPE));
    let length = headers.get("content-length").ok().flatten().and_then(|value| value.parse::<u64>().ok());
    response.status_code() == 200 && typed && length.is_none_or(|length| length <= MAX_PACK_BYTES)
}

/// A fill under way, for `ctx.wait_until`.
pub type Fill = Pin<Box<dyn std::future::Future<Output = Filled>>>;

/// The store's answer, streamed to git and, when it may be kept, at once
/// to `store` under `key`; the fill to wait on, if there is one. `on_end`
/// is told the bytes that went to git.
pub fn tee<S: PackStore + 'static>(
    mut response: Response,
    store: Rc<S>,
    key: &Key,
    on_end: Box<dyn FnOnce(u64)>,
) -> Result<(Response, Option<Fill>)> {
    let place = keepable(&response).then(|| Filling::take(key.as_str())).flatten();
    let status = response.status_code();
    let headers = response.headers().clone();
    headers.delete("content-length")?;
    let inner: ByteChunks = Box::pin(response.stream()?);
    let pipe = place.as_ref().map(|_| SharedPipe::default());
    let tee = Tee::new(inner, pipe.clone(), on_end);
    let filling = match (place, pipe) {
        (Some(place), Some(pipe)) => {
            let key = key.as_str().to_owned();
            let future: Fill = Box::pin(async move {
                let _place = place;
                fill(store.as_ref(), &key, Drain(pipe)).await
            });
            Some(future)
        }
        _ => None,
    };
    Ok((Response::from_stream(tee)?.with_headers(headers).with_status(status), filling))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::future::Future;

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    fn pkt_bytes(payload: &[u8]) -> Vec<u8> {
        let mut out = format!("{:04x}", payload.len() + 4).into_bytes();
        out.extend_from_slice(payload);
        out
    }

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";

    fn v2(capabilities: &[&str], arguments: &[&str]) -> Vec<u8> {
        let mut body = pkt("command=fetch\n");
        for line in capabilities {
            body.extend(pkt(&format!("{line}\n")));
        }
        body.extend(b"0001");
        for line in arguments {
            body.extend(pkt(&format!("{line}\n")));
        }
        body.extend(b"0000");
        body
    }

    fn v0(lines: &[&str], after: &[&str]) -> Vec<u8> {
        let mut body = Vec::new();
        for line in lines {
            body.extend(pkt(&format!("{line}\n")));
        }
        body.extend(b"0000");
        for line in after {
            body.extend(pkt(&format!("{line}\n")));
        }
        body
    }

    #[test]
    fn a_v2_clone_is_the_same_whatever_the_order_or_the_agent() {
        let one = v2(
            &["agent=git/2.45.0", "object-format=sha1"],
            &["thin-pack", "ofs-delta", "deepen 1", &format!("want {A}"), &format!("want {B}"), "filter blob:none", "done"],
        );
        let two = v2(
            &["object-format=sha1", "agent=git/2.47.1", "session-id=abc"],
            &["done", "filter blob:none", &format!("want {B}"), "deepen 1", "ofs-delta", &format!("want {A}"), "thin-pack", &format!("want {A}")],
        );
        let first = normalize(2, &one).unwrap();
        assert_eq!(first, normalize(2, &two).unwrap());
        assert!(!first.contains("agent="));
        // Each of deepen, filter and the wants changes the answer.
        let deeper = v2(&["object-format=sha1"], &["thin-pack", "ofs-delta", "deepen 2", &format!("want {A}"), &format!("want {B}"), "filter blob:none", "done"]);
        let unfiltered = v2(&["object-format=sha1"], &["thin-pack", "ofs-delta", "deepen 1", &format!("want {A}"), &format!("want {B}"), "done"]);
        let fewer = v2(&["object-format=sha1"], &["thin-pack", "ofs-delta", "deepen 1", &format!("want {A}"), "filter blob:none", "done"]);
        for other in [deeper, unfiltered, fewer] {
            assert_ne!(normalize(2, &other).unwrap(), first);
        }
        // Progress is part of the answer.
        let quiet = v2(&["object-format=sha1"], &["no-progress", "thin-pack", "ofs-delta", "deepen 1", &format!("want {A}"), &format!("want {B}"), "filter blob:none", "done"]);
        assert_ne!(normalize(2, &quiet).unwrap(), first);
    }

    #[test]
    fn a_v0_clone_is_the_same_whatever_the_order_or_the_agent() {
        let one = v0(
            &[&format!("want {A} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=git/2.45.0"), &format!("want {B}"), "deepen 1", "filter blob:none"],
            &["done"],
        );
        let two = v0(
            &[&format!("want {B} ofs-delta thin-pack side-band-64k multi_ack_detailed agent=git/2.47.1"), "filter blob:none", "deepen 1", &format!("want {A}")],
            &["done"],
        );
        let first = normalize(0, &one).unwrap();
        assert_eq!(first, normalize(1, &two).unwrap());
        assert!(!first.contains("agent="));
        let deeper = v0(&[&format!("want {A} side-band-64k"), &format!("want {B}"), "deepen 3"], &["done"]);
        let shallow = v0(&[&format!("want {A} side-band-64k"), &format!("want {B}"), "deepen 1"], &["done"]);
        assert_ne!(normalize(0, &deeper), normalize(0, &shallow));
        // The same request read as v2 is not a v2 fetch.
        assert_eq!(normalize(2, &one), None);
    }

    #[test]
    fn a_request_with_haves_is_never_kept() {
        let v2_have = v2(&["object-format=sha1"], &[&format!("want {A}"), &format!("have {B}"), "done"]);
        assert_eq!(normalize(2, &v2_have), None);
        let v2_negotiating = v2(&["object-format=sha1"], &[&format!("want {A}"), &format!("have {B}")]);
        assert_eq!(normalize(2, &v2_negotiating), None);
        let v0_have = v0(&[&format!("want {A} side-band-64k")], &[&format!("have {B}"), "done"]);
        assert_eq!(normalize(0, &v0_have), None);
        let v0_more = v0(&[&format!("want {A} side-band-64k")], &[&format!("have {B}")]);
        assert_eq!(normalize(0, &v0_more), None);
        // A shallow clone deepened: the client has commits already.
        let deepened = v2(&["object-format=sha1"], &[&format!("want {A}"), &format!("shallow {B}"), "deepen 5", "done"]);
        assert_eq!(normalize(2, &deepened), None);
    }

    #[test]
    fn only_whole_fetches_with_wants_are_kept() {
        let ls_refs = [pkt("command=ls-refs\n"), b"0001".to_vec(), pkt("peel\n"), b"0000".to_vec()].concat();
        assert_eq!(normalize(2, &ls_refs), None);
        let no_wants = v2(&["object-format=sha1"], &["done"]);
        assert_eq!(normalize(2, &no_wants), None);
        let clone = v2(&["object-format=sha1"], &[&format!("want {A}"), "done"]);
        assert!(normalize(2, &clone).is_some());
        assert_eq!(normalize(2, &clone[..clone.len() - 2]), None);
        let mut trailing = clone.clone();
        trailing.extend(pkt("done\n"));
        assert_eq!(normalize(2, &trailing), None);
        // v0 without `done` is not answered with a pack.
        assert_eq!(normalize(0, &v0(&[&format!("want {A} side-band-64k")], &[])), None);
        assert_eq!(normalize(0, b"\x1f\x8b\x08\x00gzip"), None);
    }

    fn git(endpoint: &'static str, service: GitService) -> GitRequest {
        GitRequest {
            path: g1t_contracts::repos::RepoPath { namespace: "acme".into(), name: "rocket".into() },
            endpoint,
            service,
        }
    }

    #[test]
    fn the_cacheable_decision() {
        let clone = v2(&["object-format=sha1"], &[&format!("want {A}"), "deepen 1", "done"]);
        let fetch = git("git-upload-pack", GitService::UploadPack);
        assert!(cacheable(&fetch, false, 2, None, Some(&clone)).is_some());
        assert!(cacheable(&fetch, false, 2, Some("identity"), Some(&clone)).is_some());
        assert_eq!(cacheable(&fetch, false, 2, Some("gzip"), Some(&clone)), None);
        assert_eq!(cacheable(&fetch, true, 2, None, Some(&clone)), None);
        assert_eq!(cacheable(&fetch, false, 2, None, None), None);
        assert_eq!(cacheable(&git("info/refs", GitService::UploadPack), false, 2, None, Some(&clone)), None);
        assert_eq!(cacheable(&git("git-receive-pack", GitService::ReceivePack), false, 2, None, Some(&clone)), None);
        // A key moves with the refs version, and differs by repository.
        let normalized = cacheable(&fetch, false, 2, None, Some(&clone)).unwrap();
        assert_ne!(Key::new("r1", 4, &normalized), Key::new("r1", 5, &normalized));
        assert_ne!(Key::new("r1", 4, &normalized), Key::new("r2", 4, &normalized));
        assert_eq!(Key::new("r1", 4, &normalized), Key::new("r1", 4, &normalized));
        assert!(Key::new("r1", 4, &normalized).as_str().starts_with("packs/r1/4/"));
    }

    /// A v2 answer: shallow-info, then the pack in channel 1, progress in 2.
    fn answer(pack: &[u8]) -> Vec<u8> {
        let mut out = [pkt("shallow-info\n"), pkt(&format!("shallow {A}\n")), b"0001".to_vec(), pkt("packfile\n")].concat();
        out.extend(pkt_bytes(b"\x02Enumerating objects: 3, done.\n"));
        let mut data = b"PACK\0\0\0\x02\0\0\0\x03".to_vec();
        data.extend_from_slice(pack);
        for chunk in data.chunks(1000) {
            let mut packet = vec![1u8];
            packet.extend_from_slice(chunk);
            out.extend(pkt_bytes(&packet));
        }
        out.extend(b"0000");
        out
    }

    #[test]
    fn a_whole_pack_passes_the_check_in_any_chunks() {
        let body = answer(&[7u8; 5000]);
        for size in [1, 3, 4, 7, 64, 1000, body.len()] {
            let mut check = PackCheck::default();
            for chunk in body.chunks(size) {
                check.feed(chunk);
            }
            assert!(check.complete(), "chunks of {size}");
        }
        // v0: NAK, then the pack in channel 1.
        let v0 = [pkt("NAK\n"), pkt_bytes(b"\x01PACK\0\0\0\x02\0\0\0\x01xyz"), b"0000".to_vec()].concat();
        let mut check = PackCheck::default();
        check.feed(&v0);
        assert!(check.complete());
    }

    #[test]
    fn a_cut_short_or_failed_answer_is_not_a_pack() {
        let body = answer(&[7u8; 5000]);
        let mut check = PackCheck::default();
        check.feed(&body[..body.len() - 4]);
        assert!(!check.complete());
        let mut check = PackCheck::default();
        check.feed(&body[..body.len() - 100]);
        assert!(!check.complete());
        let failed = [pkt("packfile\n"), pkt_bytes(b"\x03fatal: out of memory\n"), b"0000".to_vec()].concat();
        let mut check = PackCheck::default();
        check.feed(&failed);
        assert!(check.failed() && !check.complete());
        let err = [pkt("ERR upload-pack: not our ref\n"), b"0000".to_vec()].concat();
        let mut check = PackCheck::default();
        check.feed(&err);
        assert!(!check.complete());
        let no_pack = [pkt("acknowledgments\n"), pkt("NAK\n"), b"0000".to_vec()].concat();
        let mut check = PackCheck::default();
        check.feed(&no_pack);
        assert!(!check.complete());
        let mut check = PackCheck::default();
        check.feed(b"zzzz");
        assert!(check.failed());
    }

    /// Kept objects, and multipart uploads in progress.
    #[derive(Default)]
    struct Memory {
        objects: RefCell<HashMap<String, Vec<u8>>>,
        uploads: RefCell<HashMap<String, Vec<Vec<u8>>>>,
        aborted: Cell<u32>,
        fail_parts_after: Option<u16>,
    }

    impl PackStore for Memory {
        async fn get(&self, key: &str) -> Result<Option<(u64, ResponseBody)>> {
            Ok(self.objects.borrow().get(key).map(|bytes| (bytes.len() as u64, ResponseBody::Body(bytes.clone()))))
        }
        async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
            self.objects.borrow_mut().insert(key.to_owned(), bytes);
            Ok(())
        }
        async fn begin(&self, key: &str) -> Result<String> {
            let id = format!("upload-{key}");
            self.uploads.borrow_mut().insert(id.clone(), Vec::new());
            Ok(id)
        }
        async fn part(&self, _key: &str, upload: &str, number: u16, bytes: Vec<u8>) -> Result<String> {
            if self.fail_parts_after.is_some_and(|after| number > after) {
                return Err(worker::Error::RustError("part refused".into()));
            }
            let mut uploads = self.uploads.borrow_mut();
            let parts = uploads.get_mut(upload).unwrap();
            assert_eq!(parts.len() + 1, number as usize);
            parts.push(bytes);
            Ok(format!("etag-{number}"))
        }
        async fn complete(&self, key: &str, upload: &str, parts: Vec<(u16, String)>) -> Result<()> {
            let uploaded = self.uploads.borrow_mut().remove(upload).unwrap();
            assert_eq!(parts.len(), uploaded.len());
            for (index, part) in uploaded.iter().enumerate() {
                if index + 1 < uploaded.len() {
                    assert_eq!(part.len(), PART_BYTES, "every part but the last is the same size");
                }
                assert!(!part.is_empty());
            }
            self.objects.borrow_mut().insert(key.to_owned(), uploaded.concat());
            Ok(())
        }
        async fn abort(&self, _key: &str, upload: &str) -> Result<()> {
            self.uploads.borrow_mut().remove(upload);
            self.aborted.set(self.aborted.get() + 1);
            Ok(())
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
                return output;
            }
        }
    }

    /// Streams `body` through a tee in `chunk`-sized pieces, as git would
    /// read it, stopping after `read` chunks if given; then runs the fill.
    fn run<S: PackStore>(store: &S, body: &[u8], chunk: usize, read: Option<usize>, error_at: Option<usize>) -> (Vec<u8>, Filled, u64) {
        let mut chunks: Vec<Result<Vec<u8>>> = body.chunks(chunk).map(|c| Ok(c.to_vec())).collect();
        if let Some(at) = error_at {
            chunks.truncate(at);
            chunks.push(Err(worker::Error::RustError("store went away".into())));
        }
        let pipe = SharedPipe::default();
        let measured = Rc::new(Cell::new(None));
        let told = measured.clone();
        let mut tee = Tee::new(Box::pin(futures_util::stream::iter(chunks)), Some(pipe.clone()), Box::new(move |bytes| told.set(Some(bytes))));
        // Git reads, and the fill keeps up, a piece at a time.
        let mut got = Vec::new();
        let mut drain = Drain(pipe);
        let mut kept = Vec::new();
        let mut taken = 0;
        loop {
            if read.is_some_and(|read| taken >= read) {
                break;
            }
            match block_on(tee.next()) {
                Some(Ok(bytes)) => got.extend(bytes),
                Some(Err(_)) | None => break,
            }
            taken += 1;
            while let Poll::Ready(Some(piece)) = Pin::new(&mut drain).poll_next(&mut Context::from_waker(Waker::noop())) {
                kept.push(piece);
            }
        }
        drop(tee);
        while let Poll::Ready(Some(piece)) = Pin::new(&mut drain).poll_next(&mut Context::from_waker(Waker::noop())) {
            kept.push(piece);
        }
        let filled = block_on(fill(store, "packs/r/1/k", futures_util::stream::iter(kept)));
        (got, filled, measured.get().unwrap())
    }

    #[test]
    fn a_small_pack_is_kept_whole_once_it_has_all_arrived() {
        let store = Memory::default();
        let body = answer(&[9u8; 20_000]);
        let (got, filled, measured) = run(&store, &body, 4096, None, None);
        assert_eq!(got, body);
        assert_eq!(measured, body.len() as u64);
        assert_eq!(filled, Filled::Kept { bytes: body.len() as u64 });
        assert_eq!(store.objects.borrow().get("packs/r/1/k"), Some(&body));
    }

    #[test]
    fn a_large_pack_goes_up_in_equal_parts() {
        let store = Memory::default();
        // Just over two parts, in chunks that do not divide a part.
        let body = answer(&vec![5u8; 2 * PART_BYTES + 10_000]);
        let (got, filled, _) = run(&store, &body, 64 * 1024 + 3, None, None);
        assert_eq!(got, body);
        assert_eq!(filled, Filled::Kept { bytes: body.len() as u64 });
        assert_eq!(store.objects.borrow().get("packs/r/1/k"), Some(&body));
        assert!(store.uploads.borrow().is_empty());
    }

    #[test]
    fn a_fill_cut_short_leaves_nothing_to_serve() {
        // Git went away after a few chunks.
        let store = Memory::default();
        let body = answer(&vec![5u8; 2 * PART_BYTES]);
        let (_, filled, measured) = run(&store, &body, 64 * 1024, Some(90), None);
        assert_eq!(filled, Filled::Abandoned);
        assert_eq!(measured, 90 * 64 * 1024);
        assert!(store.objects.borrow().is_empty());
        assert!(store.uploads.borrow().is_empty());
        assert_eq!(store.aborted.get(), 1);
        // The store's answer failed partway.
        let store = Memory::default();
        let (_, filled, _) = run(&store, &body, 64 * 1024, None, Some(10));
        assert_eq!(filled, Filled::Abandoned);
        assert!(store.objects.borrow().is_empty());
        // A part the bucket refused.
        let store = Memory { fail_parts_after: Some(0), ..Memory::default() };
        let (got, filled, _) = run(&store, &body, 64 * 1024, None, None);
        assert_eq!(got, body, "git has its answer whatever the bucket does");
        assert_ne!(filled, Filled::Kept { bytes: body.len() as u64 });
        assert!(store.objects.borrow().is_empty());
        // An answer that is not a pack.
        let store = Memory::default();
        let error = [pkt("ERR not our ref\n"), b"0000".to_vec()].concat();
        let (_, filled, _) = run(&store, &error, 4096, None, None);
        assert_eq!(filled, Filled::NotAPack);
        assert!(store.objects.borrow().is_empty());
    }

    /// A blob store as S3 and R2 behave: an object can be read only once
    /// it was put whole or its multipart upload was completed.
    #[derive(Default)]
    struct Blobs {
        objects: RefCell<HashMap<String, Vec<u8>>>,
        uploads: RefCell<HashMap<String, (String, Vec<(u16, Vec<u8>)>)>>,
        /// Whether, at each part, the key could already be read.
        readable_mid_upload: Cell<bool>,
    }

    impl BlobStore for Blobs {
        async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
            self.objects.borrow_mut().insert(key.to_owned(), bytes);
            Ok(())
        }
        async fn get(&self, key: &str, _range: Option<g1t_blobstore::Wanted>) -> Result<Option<g1t_blobstore::Got>> {
            Ok(self.objects.borrow().get(key).map(|bytes| g1t_blobstore::Got {
                size: bytes.len() as u64,
                body: ResponseBody::Body(bytes.clone()),
            }))
        }
        async fn head(&self, key: &str) -> Result<Option<u64>> {
            Ok(self.objects.borrow().get(key).map(|bytes| bytes.len() as u64))
        }
        async fn delete(&self, key: &str) -> Result<()> {
            self.objects.borrow_mut().remove(key);
            Ok(())
        }
        async fn create_multipart(&self, key: &str) -> Result<String> {
            let id = format!("upload-{}", self.uploads.borrow().len());
            self.uploads.borrow_mut().insert(id.clone(), (key.to_owned(), Vec::new()));
            Ok(id)
        }
        async fn upload_part(&self, key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part> {
            if self.objects.borrow().contains_key(key) {
                self.readable_mid_upload.set(true);
            }
            let mut uploads = self.uploads.borrow_mut();
            let (_, parts) = uploads.get_mut(upload_id).unwrap();
            parts.push((number, bytes));
            Ok(Part { number, etag: format!("\"etag-{number}\"") })
        }
        async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()> {
            let (for_key, uploaded) = self.uploads.borrow_mut().remove(upload_id).unwrap();
            assert_eq!(for_key, key);
            let numbers: Vec<u16> = parts.iter().map(|part| part.number).collect();
            assert_eq!(numbers, uploaded.iter().map(|(number, _)| *number).collect::<Vec<_>>());
            assert!(parts.iter().all(|part| part.etag == format!("\"etag-{}\"", part.number)));
            let whole: Vec<u8> = uploaded.into_iter().flat_map(|(_, bytes)| bytes).collect();
            self.objects.borrow_mut().insert(key.to_owned(), whole);
            Ok(())
        }
        async fn abort_multipart(&self, _key: &str, upload_id: &str) -> Result<()> {
            self.uploads.borrow_mut().remove(upload_id);
            Ok(())
        }
        fn presign_get(&self, _key: &str, _expires: u32, _now_ms: u64) -> Option<String> {
            None
        }
    }

    #[test]
    fn the_blob_store_adapter_keeps_only_whole_packs() {
        // A large pack through the adapter: parts, then one object.
        let packs = Packs { store: Blobs::default() };
        let body = answer(&vec![3u8; 2 * PART_BYTES + 777]);
        let (got, filled, _) = run(&packs, &body, 64 * 1024 + 1, None, None);
        assert_eq!(got, body);
        assert_eq!(filled, Filled::Kept { bytes: body.len() as u64 });
        assert!(!packs.store.readable_mid_upload.get(), "nothing to read until the upload is completed");
        assert!(packs.store.uploads.borrow().is_empty());
        let (size, kept) = block_on(packs.get("packs/r/1/k")).unwrap().unwrap();
        assert_eq!(size, body.len() as u64);
        assert!(matches!(kept, ResponseBody::Body(bytes) if bytes == body));
        // Cut short: the upload is aborted and the key stays empty.
        let packs = Packs { store: Blobs::default() };
        let (_, filled, _) = run(&packs, &body, 64 * 1024, Some(100), None);
        assert_eq!(filled, Filled::Abandoned);
        assert!(packs.store.objects.borrow().is_empty());
        assert!(packs.store.uploads.borrow().is_empty());
        assert!(block_on(packs.get("packs/r/1/k")).unwrap().is_none());
        // A small one is one put.
        let packs = Packs { store: Blobs::default() };
        let small = answer(&[1u8; 3000]);
        let (_, filled, _) = run(&packs, &small, 512, None, None);
        assert_eq!(filled, Filled::Kept { bytes: small.len() as u64 });
        assert_eq!(packs.store.objects.borrow().get("packs/r/1/k"), Some(&small));
    }

    #[test]
    fn the_store_is_chosen_like_backups() {
        assert_eq!(STORAGE.kind, "PACK_STORE");
        assert_eq!(STORAGE.binding, "GIT_PACKS");
        assert_eq!(STORAGE.s3_bucket, "PACK_S3_BUCKET");
        assert_ne!(STORAGE.s3_bucket, crate::backups::STORAGE.s3_bucket, "packs and backups never share a bucket");
    }

    #[test]
    fn a_pack_past_the_cap_streams_through_unkept() {
        // The cap itself is 200 MB; the tee lets go of a slow bucket the
        // same way, which is quicker to show: nothing drains the pipe.
        let pipe = SharedPipe::default();
        let chunks: Vec<Result<Vec<u8>>> = (0..200).map(|_| Ok(vec![1u8; 64 * 1024])).collect();
        let mut tee = Tee::new(Box::pin(futures_util::stream::iter(chunks)), Some(pipe.clone()), Box::new(|_| {}));
        let mut sent = 0;
        while let Some(Ok(bytes)) = block_on(tee.next()) {
            sent += bytes.len();
        }
        assert_eq!(sent, 200 * 64 * 1024);
        let pipe = pipe.borrow();
        assert!(pipe.closed);
        assert!(pipe.queued <= MAX_QUEUED_BYTES);
        assert!(!pipe.pieces.contains(&Piece::End), "a fill let go never hears the end");
    }

    #[test]
    fn the_meters_are_not_operations() {
        let mapping = crate::meters::Mapping::defaults();
        for meter in [HIT, MISS] {
            assert_eq!(mapping.billable(meter), 0.0);
            assert_eq!(mapping.cost(meter), 0.0);
        }
    }

    #[test]
    fn fills_are_one_per_key_and_few_at_once() {
        let first = Filling::take("a").unwrap();
        assert!(Filling::take("a").is_none());
        let second = Filling::take("b").unwrap();
        assert!(Filling::take("c").is_none());
        drop(first);
        assert!(Filling::take("c").is_some());
        drop(second);
    }
}
