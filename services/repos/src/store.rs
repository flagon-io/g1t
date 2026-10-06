//! The storage that actually holds git repositories.
//!
//! The service depends on the [`GitStore`] and [`GitRepo`] ports;
//! [`ArtifactsStore`] is the adapter for Cloudflare Artifacts.
//!
//! Every call on the binding goes through [`invoke`]: it is counted
//! (meters.rs), timed for the store's health, refused at once while its
//! namespace's breaker is open, and tried again after a failure that may
//! pass when it only reads (resilience.rs). Repositories may live in
//! several namespaces (shards.rs).

use g1t_contracts::repos::{Branch, Commit, EntryKind, GitAccess, Signature, TreeEntry};
use g1t_contracts::time::rfc3339;
use g1t_kit::js::{self, Thrown};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use worker::js_sys::{Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Env, Result};

use crate::meters::{self, Outcome};
use crate::resilience::{self, Admit, Busy, Failure};
use crate::shards;

/// Credentials that never leave this service: g1t has already decided who
/// may do what before one is used. They live an hour and are used for 50
/// minutes, so each one used has at least ten minutes left.
const INTERNAL_TTL_SECONDS: u32 = 3_600;
const INTERNAL_REUSE_MS: u64 = 50 * 60 * 1000;
/// Credentials handed out (`git_access`, to sandboxes): five minutes, used
/// for three, so whoever gets one has at least two.
const HANDOUT_TTL_SECONDS: u32 = 300;
const HANDOUT_REUSE_MS: u64 = 180_000;
/// How long a handed-out credential stays valid, in milliseconds.
pub const CREDENTIAL_LIFE_MS: u64 = HANDOUT_TTL_SECONDS as u64 * 1000;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Scope {
    Read,
    Write,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Write => "write",
        }
    }
}

/// Who a credential is for.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Use {
    /// This service, talking to the store itself.
    Internal,
    /// Someone outside it, through `git_access`.
    Handout,
}

impl Use {
    pub fn ttl_seconds(self) -> u32 {
        match self {
            Use::Internal => INTERNAL_TTL_SECONDS,
            Use::Handout => HANDOUT_TTL_SECONDS,
        }
    }

    pub fn reuse_ms(self) -> u64 {
        match self {
            Use::Internal => INTERNAL_REUSE_MS,
            Use::Handout => HANDOUT_REUSE_MS,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Use::Internal => "internal",
            Use::Handout => "handout",
        }
    }
}

/// Where a credential handed out came from, for `Server-Timing`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kept {
    /// This isolate made it, or had it from another, a moment ago.
    Isolate,
    /// Another isolate made it and shared it.
    Shared,
}

impl Kept {
    pub fn as_str(self) -> &'static str {
        match self {
            Kept::Isolate => "isolate",
            Kept::Shared => "shared",
        }
    }
}

/// A place repositories live. `key` is the store's own name for a repo.
#[allow(async_fn_in_trait)]
pub trait GitStore {
    type Repo: GitRepo;

    /// Creates an empty repository. Succeeds if it already exists.
    async fn create(&self, key: &str, description: Option<&str>, default_branch: &str) -> Result<()>;
    async fn open(&self, key: &str) -> Result<Self::Repo>;
    /// A credential for `key` made a moment ago, if the store keeps one.
    async fn kept_access(&self, _key: &str, _scope: Scope) -> Option<(GitAccess, Kept)> {
        None
    }
    /// A new credential for `key`, which the store may keep for next time.
    async fn mint_access(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        self.open(key).await?.access(scope).await
    }
    /// A remote URL and credential for this service's own use. A store may
    /// hand out one it made a moment ago.
    async fn access(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        match self.kept_access(key, scope).await {
            Some((access, _)) => Ok(access),
            None => self.mint_access(key, scope).await,
        }
    }
    /// A short-lived credential for someone outside this service.
    async fn handout(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        self.access(key, scope).await
    }
    /// Stops handing out the credentials it keeps for `key`: the store
    /// turned one down, or the repository is gone.
    async fn forget_access(&self, _key: &str) {}
    /// Removes a repository and everything in it, for good. Succeeds if it
    /// is already gone.
    async fn delete(&self, key: &str) -> Result<()>;
    /// The namespaces new repositories may be placed in (shards.rs).
    fn namespaces(&self) -> Vec<String> {
        vec![shards::DEFAULT_NAMESPACE.to_owned()]
    }
    /// The namespace bound as the default.
    fn default_namespace(&self) -> String {
        shards::DEFAULT_NAMESPACE.to_owned()
    }
}

/// One open repository.
#[allow(async_fn_in_trait)]
pub trait GitRepo {
    /// A remote URL and credential for git itself, for this service.
    async fn access(&self, scope: Scope) -> Result<GitAccess>;
    /// Every branch and the commit it points to.
    async fn branches(&self) -> Result<Vec<Branch>>;
    /// Newest first along the first-parent chain; empty for an unknown ref.
    async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>>;
    /// The parents of a commit, or `None` if the commit does not exist.
    async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>>;
    async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>>;
    async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>>;
    /// `None` when the ref or path does not resolve to a file.
    async fn read_file(&self, git_ref: &str, path: &str) -> Result<Option<Vec<u8>>>;
    /// Makes a copy of this repository under `target_key`, in the same
    /// namespace.
    async fn fork(&self, target_key: &str) -> Result<()>;
    /// The version of the repository's refs (registry.rs `RefsState`),
    /// when answers about branches may be kept under it (R9). Reads by
    /// branch name are then kept until the version moves.
    fn at_refs_version(&mut self, _version: Option<u64>) {}
}

thread_local! {
    /// The namespace bound to `ARTIFACTS`, for keys that name none.
    static DEFAULT_NS: RefCell<String> = RefCell::new(shards::DEFAULT_NAMESPACE.to_owned());
    /// Where each namespace's remotes start: `https://<account>.artifacts.cloudflare.net/git/<namespace>/`.
    static REMOTE_PREFIX: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// The namespace and name a store key stands for.
pub fn locate(key: &str) -> (String, String) {
    let (namespace, name) = shards::split(key);
    let namespace = namespace.map_or_else(|| DEFAULT_NS.with(|ns| ns.borrow().clone()), str::to_owned);
    (namespace, name.to_owned())
}

/// The store key a git remote is for, from its last two path segments.
pub fn key_from_remote(remote: &str) -> Option<String> {
    let path = remote.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (rest, name) = path.rsplit_once('/')?;
    let namespace = rest.rsplit('/').next()?;
    let default = DEFAULT_NS.with(|ns| ns.borrow().clone());
    Some(shards::compose(Some(namespace), name, &default))
}

/// Where a namespace's remotes start, learned from one remote the store
/// gave for `name`.
fn learn_prefix(remote: &str, name: &str) -> Option<String> {
    remote.strip_suffix(&format!("{name}.git")).filter(|prefix| prefix.ends_with('/')).map(str::to_owned)
}

/// A repository's remote, from where its namespace's remotes start.
fn remote_from(prefix: &str, name: &str) -> String {
    format!("{prefix}{name}.git")
}

struct Namespace {
    name: String,
    binding: JsValue,
}

pub struct ArtifactsStore {
    namespaces: Rc<Vec<Namespace>>,
    /// Where isolates share the credentials they make; see shared.rs.
    shared: Option<Rc<crate::shared::Shared>>,
}

impl ArtifactsStore {
    pub fn new(env: &Env, shared: Option<Rc<crate::shared::Shared>>) -> Result<Self> {
        let config = env.var("ARTIFACTS_NAMESPACES").ok().map(|value| value.to_string());
        let mut namespaces = Vec::new();
        for (binding, name) in shards::bindings(config.as_deref()) {
            match js::binding(env, &binding) {
                Ok(value) => namespaces.push(Namespace { name, binding: value }),
                // The default binding is required; the others are optional.
                Err(error) if binding == shards::DEFAULT_BINDING => return Err(error),
                Err(_) => worker::console_error!("ARTIFACTS_NAMESPACES names {binding}, which is not bound"),
            }
        }
        if let Some(default) = namespaces.first() {
            DEFAULT_NS.with(|ns| ns.borrow_mut().clone_from(&default.name));
        }
        // Optional: where remotes start, `https://<account>.artifacts.cloudflare.net/git`,
        // so the first credential an isolate makes needs no `info()` either.
        if let Ok(base) = env.var("ARTIFACTS_REMOTE_BASE") {
            let base = base.to_string().trim_end_matches('/').to_owned();
            if base.starts_with("https://") {
                REMOTE_PREFIX.with(|prefixes| {
                    let mut prefixes = prefixes.borrow_mut();
                    for namespace in &namespaces {
                        prefixes.entry(namespace.name.clone()).or_insert_with(|| format!("{base}/{}/", namespace.name));
                    }
                });
            }
        }
        Ok(Self { namespaces: Rc::new(namespaces), shared })
    }

    fn binding(&self, namespace: &str) -> Result<&JsValue> {
        self.namespaces
            .iter()
            .find(|candidate| candidate.name == namespace)
            .map(|found| &found.binding)
            .ok_or_else(|| worker::Error::RustError(format!("git store namespace {namespace} is not bound")))
    }
}

/// A failed call on the binding.
pub struct StoreError {
    pub thrown: Thrown,
    pub busy: Option<Busy>,
}

impl StoreError {
    pub fn is(&self, code: &str) -> bool {
        self.thrown.is(code)
    }
}

impl From<StoreError> for worker::Error {
    fn from(error: StoreError) -> Self {
        match error.busy {
            Some(busy) => busy.error(&error.thrown.to_string()),
            None => error.thrown.into(),
        }
    }
}

/// The meter for a binding method: `binding.create_token`.
fn meter_of(method: &str) -> String {
    let mut out = String::from("binding.");
    for c in method.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Seconds a caller is told to wait when the store is busy.
const BUSY_RETRY_AFTER: u64 = 5;

/// Calls `target[method](...args)` on namespace `namespace`'s binding, for
/// the repository at `key`. `retry`: whether a failure that may pass is
/// tried again (reads and credentials only).
async fn invoke(
    namespace: &str,
    key: &str,
    target: &JsValue,
    method: &str,
    args: &[JsValue],
    retry: bool,
) -> std::result::Result<JsValue, StoreError> {
    let meter = meter_of(method);
    let mut attempt = 0;
    loop {
        let now = g1t_kit::now_ms();
        let admit = resilience::with_breaker(namespace, |breaker| breaker.admit(now));
        if let Admit::Wait(ms) = admit {
            meters::record_health(namespace, Outcome::Rejected, 0);
            return Err(StoreError {
                thrown: Thrown { code: None, message: format!("{method} not asked: the git store has been failing") },
                busy: Some(Busy { rate_limited: false, retry_after: resilience::seconds(ms).max(BUSY_RETRY_AFTER) }),
            });
        }
        meters::record(&meter, key, 0, 0);
        let called = js::call(target, method, args).await;
        let ms = g1t_kit::now_ms().saturating_sub(now);
        match called {
            Ok(value) => {
                resilience::with_breaker(namespace, |breaker| breaker.succeeded());
                meters::record_health(namespace, Outcome::Ok, ms);
                return Ok(value);
            }
            Err(thrown) => {
                let failure = resilience::classify(thrown.code.as_deref(), &thrown.message);
                if failure == Failure::Permanent {
                    // An answer (NOT_FOUND, ALREADY_EXISTS): the store is up.
                    resilience::with_breaker(namespace, |breaker| breaker.succeeded());
                    meters::record_health(namespace, Outcome::Ok, ms);
                    return Err(StoreError { thrown, busy: None });
                }
                if retry && resilience::retry(failure, attempt) {
                    let wait = resilience::backoff_ms(failure, attempt, worker::js_sys::Math::random());
                    worker::Delay::from(std::time::Duration::from_millis(wait)).await;
                    attempt += 1;
                    continue;
                }
                resilience::with_breaker(namespace, |breaker| breaker.failed(failure, g1t_kit::now_ms()));
                let outcome = if failure == Failure::RateLimited { Outcome::RateLimited } else { Outcome::Failed };
                meters::record_health(namespace, outcome, ms);
                worker::console_error!("git store {namespace}: {method} for {key} failed: {thrown}");
                return Err(StoreError {
                    thrown,
                    busy: Some(Busy { rate_limited: failure == Failure::RateLimited, retry_after: BUSY_RETRY_AFTER }),
                });
            }
        }
    }
}

/// A credential as isolates share it, sealed (see shared.rs): with when it
/// was made, so that one shared is reused no longer than one kept here.
#[derive(Serialize, Deserialize)]
struct SharedCredential {
    remote: String,
    token: String,
    made: u64,
}

/// The shared cache's key for a credential: the store's key for the
/// repository, the scope, and who it is for. (`cred2`: credentials kept
/// before their lives differed by use are not read.)
fn shared_key(key: &str, scope: Scope, using: Use) -> String {
    format!("cred2:{key}:{}:{}", scope.as_str(), using.as_str())
}

/// A shared credential, if it was made less than its reuse window before
/// `now`; with when it was made.
fn shared_credential(bytes: &[u8], now: u64, using: Use) -> Option<(GitAccess, u64)> {
    let kept: SharedCredential = serde_json::from_slice(bytes).ok()?;
    (now.saturating_sub(kept.made) < using.reuse_ms()).then_some((
        GitAccess {
            remote: kept.remote,
            token: kept.token,
        },
        kept.made,
    ))
}

/// Credentials made a while ago, by repository, scope and use. Making one
/// is a round trip to the store; reusing it saves that, and the store's
/// lookup of the repository with it.
#[derive(Default)]
pub struct Credentials {
    kept: HashMap<(String, Scope, Use), (GitAccess, u64)>,
}

impl Credentials {
    /// One made for `key`, `scope` and `using` within its reuse window of `now`.
    pub fn get(&self, key: &str, scope: Scope, using: Use, now: u64) -> Option<GitAccess> {
        self.kept
            .get(&(key.to_owned(), scope, using))
            .filter(|(_, made)| now.saturating_sub(*made) < using.reuse_ms())
            .map(|(access, _)| access.clone())
    }

    pub fn keep(&mut self, key: &str, scope: Scope, using: Use, access: GitAccess, made: u64, now: u64) {
        // Expired ones go first, so the map stays as small as the isolate's
        // recent repositories.
        self.kept
            .retain(|(_, _, kept_use), (_, at)| now.saturating_sub(*at) < kept_use.reuse_ms());
        self.kept.insert((key.to_owned(), scope, using), (access, made));
    }

    pub fn forget(&mut self, key: &str) {
        self.kept.retain(|(kept, _, _), _| kept != key);
    }
}

thread_local! {
    static CREDENTIALS: RefCell<Credentials> = RefCell::new(Credentials::default());
}

/// A credential kept in this isolate, else one another isolate shared.
async fn kept(shared: Option<&crate::shared::Shared>, key: &str, scope: Scope, using: Use) -> Option<(GitAccess, Kept)> {
    let now = g1t_kit::now_ms();
    if let Some(access) = CREDENTIALS.with(|kept| kept.borrow().get(key, scope, using, now)) {
        return Some((access, Kept::Isolate));
    }
    let bytes = shared?.get(&shared_key(key, scope, using)).await?;
    let (access, made) = shared_credential(&bytes, now, using)?;
    CREDENTIALS.with(|kept| kept.borrow_mut().keep(key, scope, using, access.clone(), made, now));
    Some((access, Kept::Shared))
}

/// Keeps a credential just made here, and shares it.
async fn keep(shared: Option<&crate::shared::Shared>, key: &str, scope: Scope, using: Use, access: &GitAccess) {
    let now = g1t_kit::now_ms();
    CREDENTIALS.with(|kept| kept.borrow_mut().keep(key, scope, using, access.clone(), now, now));
    if let Some(shared) = shared {
        let value = SharedCredential {
            remote: access.remote.clone(),
            token: access.token.clone(),
            made: now,
        };
        if let Ok(bytes) = serde_json::to_vec(&value) {
            shared.put(&shared_key(key, scope, using), &bytes, using.reuse_ms() / 1000).await;
        }
    }
}

impl GitStore for ArtifactsStore {
    type Repo = ArtifactsRepo;

    async fn kept_access(&self, key: &str, scope: Scope) -> Option<(GitAccess, Kept)> {
        kept(self.shared.as_deref(), key, scope, Use::Internal).await
    }

    async fn mint_access(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        let repo = self.open(key).await?;
        let access = repo.mint(scope, Use::Internal).await?;
        keep(self.shared.as_deref(), key, scope, Use::Internal, &access).await;
        Ok(access)
    }

    async fn handout(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        if let Some((access, _)) = kept(self.shared.as_deref(), key, scope, Use::Handout).await {
            return Ok(access);
        }
        let access = self.open(key).await?.mint(scope, Use::Handout).await?;
        keep(self.shared.as_deref(), key, scope, Use::Handout, &access).await;
        Ok(access)
    }

    async fn forget_access(&self, key: &str) {
        CREDENTIALS.with(|kept| kept.borrow_mut().forget(key));
        if let Some(shared) = &self.shared {
            let keys: Vec<String> = [Scope::Read, Scope::Write]
                .into_iter()
                .flat_map(|scope| [Use::Internal, Use::Handout].map(|using| shared_key(key, scope, using)))
                .collect();
            futures_util::future::join_all(keys.iter().map(|shared_key| shared.delete(shared_key))).await;
        }
    }

    async fn create(&self, key: &str, description: Option<&str>, default_branch: &str) -> Result<()> {
        let (namespace, name) = locate(key);
        let options = js::to_js(&serde_json::json!({
            "description": description,
            "setDefaultBranch": default_branch,
        }))?;
        match invoke(&namespace, key, self.binding(&namespace)?, "create", &[name.as_str().into(), options], true).await {
            // Left behind by an earlier failed attempt; adopt it.
            Err(failed) if !failed.is("ALREADY_EXISTS") => Err(failed.into()),
            _ => Ok(()),
        }
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.forget_access(key).await;
        let (namespace, name) = locate(key);
        match invoke(&namespace, key, self.binding(&namespace)?, "delete", &[name.as_str().into()], true).await {
            // Gone already: an earlier purge got this far.
            Err(failed) if !failed.is("NOT_FOUND") => Err(failed.into()),
            _ => Ok(()),
        }
    }

    async fn open(&self, key: &str) -> Result<ArtifactsRepo> {
        let (namespace, name) = locate(key);
        let handle = invoke(&namespace, key, self.binding(&namespace)?, "get", &[name.as_str().into()], true).await?;
        Ok(ArtifactsRepo {
            handle,
            key: key.to_owned(),
            name,
            namespace,
            shared: self.shared.clone(),
            refs_version: None,
        })
    }

    fn namespaces(&self) -> Vec<String> {
        self.namespaces.iter().map(|namespace| namespace.name.clone()).collect()
    }

    fn default_namespace(&self) -> String {
        DEFAULT_NS.with(|ns| ns.borrow().clone())
    }
}

/// A handle to one Artifacts repository. It is an RPC stub, so it is
/// released when dropped.
pub struct ArtifactsRepo {
    handle: JsValue,
    /// The repository's store key, which scopes its cached objects.
    key: String,
    /// Its name in its namespace.
    name: String,
    namespace: String,
    shared: Option<Rc<crate::shared::Shared>>,
    /// See [`GitRepo::at_refs_version`].
    refs_version: Option<u64>,
}

/// Where cached git objects live. Trees and blobs are named by their
/// content, so a cached one is never stale; each is kept under its own
/// repository's key, so a repository only ever finds its own objects.
const OBJECT_CACHE: &str = "https://objects.g1t.internal/";
/// Blobs and files larger than this are not cached.
const MAX_CACHED_BLOB: usize = 1024 * 1024;
const OBJECT_MAX_AGE: &str = "public, max-age=31536000, immutable";
/// Answers kept under a refs version: until the version moves, and no
/// longer than this, which bounds how stale one can be should a change
/// ever fail to move it.
const VERSIONED_MAX_AGE: &str = "public, max-age=300";

/// Whether a ref is a full commit hash (SHA-1 or SHA-256), whose history
/// can be kept for good.
pub fn is_commit_hash(git_ref: &str) -> bool {
    (git_ref.len() == 40 || git_ref.len() == 64) && git_ref.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Where a read is kept: under the object it names for good, under the
/// refs version for a name that can move, or nowhere.
#[derive(Debug, PartialEq, Eq)]
pub enum CacheKey {
    Forever(String),
    Versioned(String),
}

/// The cache key for `log(git_ref, limit)`.
pub fn log_key(git_ref: &str, limit: u32, version: Option<u64>) -> Option<CacheKey> {
    if is_commit_hash(git_ref) {
        return Some(CacheKey::Forever(format!("log/{git_ref}-{limit}")));
    }
    version.map(|version| CacheKey::Versioned(format!("vlog/{version}/{}-{limit}", g1t_secrets::sha256_hex(git_ref))))
}

/// The cache key for `read_file(git_ref, path)`.
pub fn file_key(git_ref: &str, path: &str, version: Option<u64>) -> Option<CacheKey> {
    let path = g1t_secrets::sha256_hex(path);
    if is_commit_hash(git_ref) {
        return Some(CacheKey::Forever(format!("file/{git_ref}/{path}")));
    }
    version.map(|version| CacheKey::Versioned(format!("vfile/{version}/{}/{path}", g1t_secrets::sha256_hex(git_ref))))
}

/// The cache key for the branch list.
pub fn branches_key(version: Option<u64>) -> Option<CacheKey> {
    version.map(|version| CacheKey::Versioned(format!("branches/{version}")))
}

impl ArtifactsRepo {
    fn cache_url(&self, path: &str) -> String {
        format!("{OBJECT_CACHE}{}/{path}", self.key)
    }

    async fn cached_at(&self, path: &str) -> Option<Vec<u8>> {
        let mut response = worker::Cache::default().get(self.cache_url(path), false).await.ok()??;
        response.bytes().await.ok()
    }

    async fn cached(&self, kind: &str, hash: &str) -> Option<Vec<u8>> {
        self.cached_at(&format!("{kind}/{hash}")).await
    }

    async fn keep_at(&self, path: &str, bytes: Vec<u8>, max_age: &str) {
        let Ok(mut response) = worker::Response::from_bytes(bytes) else {
            return;
        };
        let _ = response.headers_mut().set("cache-control", max_age);
        let _ = worker::Cache::default().put(self.cache_url(path), response).await;
    }

    /// Keeps an object for next time. A failure only costs a later read.
    async fn keep(&self, kind: &str, hash: &str, bytes: Vec<u8>) {
        self.keep_at(&format!("{kind}/{hash}"), bytes, OBJECT_MAX_AGE).await;
    }

    async fn get_key(&self, key: &CacheKey) -> Option<Vec<u8>> {
        match key {
            CacheKey::Forever(path) | CacheKey::Versioned(path) => self.cached_at(path).await,
        }
    }

    async fn put_key(&self, key: &CacheKey, bytes: Vec<u8>) {
        match key {
            CacheKey::Forever(path) => self.keep_at(path, bytes, OBJECT_MAX_AGE).await,
            CacheKey::Versioned(path) => self.keep_at(path, bytes, VERSIONED_MAX_AGE).await,
        }
    }

    async fn call(&self, method: &str, args: &[JsValue], retry: bool) -> std::result::Result<JsValue, StoreError> {
        invoke(&self.namespace, &self.key, &self.handle, method, args, retry).await
    }

    /// A new credential from the store. Its remote is worked out from the
    /// key once this isolate knows where the namespace's remotes start;
    /// until then the store is asked (`info()`) alongside the token.
    pub async fn mint(&self, scope: Scope, using: Use) -> Result<GitAccess> {
        let args = [scope.as_str().into(), using.ttl_seconds().into()];
        let prefix = REMOTE_PREFIX.with(|prefixes| prefixes.borrow().get(&self.namespace).cloned());
        if let Some(prefix) = prefix {
            let token: RawToken = js::from_js(&self.call("createToken", &args, true).await?)?;
            return Ok(GitAccess { remote: remote_from(&prefix, &self.name), token: token.plaintext });
        }
        let (info, token) = futures_util::future::join(self.call("info", &[], true), self.call("createToken", &args, true)).await;
        let info: RawInfo = js::from_js(&info?)?;
        let token: RawToken = js::from_js(&token?)?;
        match learn_prefix(&info.remote, &self.name) {
            Some(prefix) => REMOTE_PREFIX.with(|prefixes| {
                prefixes.borrow_mut().insert(self.namespace.clone(), prefix);
            }),
            None => worker::console_error!("the git store's remote {} does not end in {}.git", info.remote, self.name),
        }
        Ok(GitAccess { remote: info.remote, token: token.plaintext })
    }
}

impl Drop for ArtifactsRepo {
    fn drop(&mut self) {
        let symbol = js::get(&worker::js_sys::global(), "Symbol");
        let dispose = js::get(&symbol, "dispose");
        if let Ok(function) = Reflect::get(&self.handle, &dispose)
            .and_then(|value| value.dyn_into::<worker::js_sys::Function>())
        {
            let _ = function.call0(&self.handle);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommit {
    hash: String,
    tree_hash: String,
    message: String,
    author: Signature,
    parents: Vec<String>,
    /// Seconds since the epoch.
    authored_at: u64,
}

#[derive(Deserialize)]
struct RawEntry {
    name: String,
    hash: String,
    #[serde(rename = "type")]
    kind: EntryKind,
}

#[derive(Deserialize)]
struct RawInfo {
    remote: String,
}

#[derive(Deserialize)]
struct RawToken {
    plaintext: String,
}

/// The bytes of a `Blob`, or `None` for null.
async fn blob_bytes(blob: JsValue) -> Result<Option<Vec<u8>>> {
    if blob.is_null() || blob.is_undefined() {
        return Ok(None);
    }
    let buffer = js::call(&blob, "arrayBuffer", &[]).await?;
    Ok(Some(Uint8Array::new(&buffer).to_vec()))
}

impl GitRepo for ArtifactsRepo {
    /// One made a while ago, here or in another isolate, else a new one.
    async fn access(&self, scope: Scope) -> Result<GitAccess> {
        if let Some((access, _)) = kept(self.shared.as_deref(), &self.key, scope, Use::Internal).await {
            return Ok(access);
        }
        let access = self.mint(scope, Use::Internal).await?;
        keep(self.shared.as_deref(), &self.key, scope, Use::Internal, &access).await;
        Ok(access)
    }

    async fn branches(&self) -> Result<Vec<Branch>> {
        let key = branches_key(self.refs_version);
        if let Some(key) = &key
            && let Some(bytes) = self.get_key(key).await
            && let Ok(branches) = serde_json::from_slice::<Vec<Branch>>(&bytes)
        {
            return Ok(branches);
        }
        let branches = crate::refs::branches(&self.access(Scope::Read).await?).await?;
        if let (Some(key), Ok(bytes)) = (&key, serde_json::to_vec(&branches)) {
            self.put_key(key, bytes).await;
        }
        Ok(branches)
    }

    async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
        // History from a commit never changes, so a log asked for by hash is
        // kept like an object: walking it is a read per commit. One asked
        // for by a branch's name is kept until the branch can have moved.
        let key = log_key(git_ref, limit, self.refs_version);
        if let Some(key) = &key
            && let Some(bytes) = self.get_key(key).await
            && let Ok(commits) = serde_json::from_slice::<Vec<Commit>>(&bytes)
        {
            return Ok(commits);
        }
        let options = js::to_js(&serde_json::json!({ "ref": git_ref, "limit": limit }))?;
        let raw: Vec<RawCommit> = js::from_js(&self.call("log", &[options], true).await?)?;
        let commits: Vec<Commit> = raw
            .into_iter()
            .map(|commit| Commit {
                hash: commit.hash,
                tree_hash: commit.tree_hash,
                message: commit.message,
                author: commit.author,
                parents: commit.parents,
                authored_at: rfc3339(commit.authored_at * 1000),
            })
            .collect();
        // An unknown ref logs nothing; that is not kept, in case it arrives.
        if !commits.is_empty()
            && let Ok(bytes) = serde_json::to_vec(&commits)
        {
            if let Some(key) = &key {
                self.put_key(key, bytes.clone()).await;
            }
            // The same history, by the commit the name led to.
            if !is_commit_hash(git_ref)
                && let Some(CacheKey::Forever(path)) = log_key(&commits[0].hash, limit, None)
            {
                self.keep_at(&path, bytes, OBJECT_MAX_AGE).await;
            }
        }
        Ok(commits)
    }

    async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
        // A commit never changes.
        if let Some(bytes) = self.cached("commit", commit_hash).await
            && let Ok(parents) = serde_json::from_slice::<Vec<String>>(&bytes)
        {
            return Ok(Some(parents));
        }
        let commit: Option<RawCommit> = js::from_js(&self.call("readCommit", &[commit_hash.into()], true).await?)?;
        let parents = commit.map(|commit| commit.parents);
        if let Some(parents) = &parents
            && let Ok(bytes) = serde_json::to_vec(parents)
        {
            self.keep("commit", commit_hash, bytes).await;
        }
        Ok(parents)
    }

    async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
        if let Some(bytes) = self.cached("tree", tree_hash).await
            && let Ok(entries) = serde_json::from_slice::<Vec<TreeEntry>>(&bytes)
        {
            return Ok(Some(entries));
        }
        let entries: Option<Vec<RawEntry>> = js::from_js(&self.call("readTree", &[tree_hash.into()], true).await?)?;
        let entries: Option<Vec<TreeEntry>> = entries.map(|entries| {
            entries
                .into_iter()
                .map(|entry| TreeEntry {
                    name: entry.name,
                    hash: entry.hash,
                    kind: entry.kind,
                })
                .collect()
        });
        if let Some(entries) = &entries
            && let Ok(bytes) = serde_json::to_vec(entries)
        {
            self.keep("tree", tree_hash, bytes).await;
        }
        Ok(entries)
    }

    async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
        if let Some(bytes) = self.cached("blob", blob_hash).await {
            return Ok(Some(bytes));
        }
        let bytes = blob_bytes(self.call("readBlob", &[blob_hash.into()], true).await?).await?;
        if let Some(bytes) = &bytes {
            meters::record_bytes("binding.read_blob", &self.key, 0, bytes.len() as u64);
        }
        if let Some(bytes) = bytes.as_ref().filter(|bytes| bytes.len() <= MAX_CACHED_BLOB) {
            self.keep("blob", blob_hash, bytes.clone()).await;
        }
        Ok(bytes)
    }

    async fn read_file(&self, git_ref: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let key = file_key(git_ref, path, self.refs_version);
        if let Some(key) = &key
            && let Some(bytes) = self.get_key(key).await
        {
            return Ok(Some(bytes));
        }
        let args = js::to_js(&serde_json::json!({ "ref": git_ref, "path": path }))?;
        let bytes = blob_bytes(self.call("readFile", &[args], true).await?).await?;
        if let Some(bytes) = &bytes {
            meters::record_bytes("binding.read_file", &self.key, 0, bytes.len() as u64);
        }
        if let (Some(key), Some(bytes)) = (&key, bytes.as_ref().filter(|bytes| bytes.len() <= MAX_CACHED_BLOB)) {
            self.put_key(key, bytes.clone()).await;
        }
        Ok(bytes)
    }

    async fn fork(&self, target_key: &str) -> Result<()> {
        let (namespace, name) = locate(target_key);
        if namespace != self.namespace {
            return Err(worker::Error::RustError(format!(
                "a fork stays in its repository's namespace: {target_key} is not in {}",
                self.namespace
            )));
        }
        let options = js::to_js(&serde_json::json!({ "defaultBranchOnly": true }))?;
        match self.call("fork", &[name.as_str().into(), options], false).await {
            Err(failed) if !failed.is("ALREADY_EXISTS") => Err(failed.into()),
            _ => Ok(()),
        }
    }

    fn at_refs_version(&mut self, version: Option<u64>) {
        self.refs_version = version;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(token: &str) -> GitAccess {
        GitAccess {
            remote: "https://store.example/acme--rocket.git".to_owned(),
            token: token.to_owned(),
        }
    }

    #[test]
    fn internal_credentials_live_an_hour_and_are_reused_for_fifty_minutes() {
        assert_eq!(Use::Internal.ttl_seconds(), 3_600);
        assert_eq!(Use::Internal.reuse_ms(), 50 * 60 * 1000);
        // Handed out: five minutes, reused three, so at least two are left.
        assert_eq!(Use::Handout.ttl_seconds(), 300);
        assert_eq!(Use::Handout.reuse_ms(), 180_000);
        assert_eq!(CREDENTIAL_LIFE_MS, 300_000);
        for using in [Use::Internal, Use::Handout] {
            assert!(u64::from(using.ttl_seconds()) * 1000 - using.reuse_ms() >= 120_000);
        }
    }

    #[test]
    fn a_credential_is_reused_only_while_it_has_time_left() {
        let mut kept = Credentials::default();
        kept.keep("acme--rocket", Scope::Read, Use::Internal, access("r1"), 1_000, 1_000);
        assert_eq!(kept.get("acme--rocket", Scope::Read, Use::Internal, 1_000).unwrap().token, "r1");
        let last = 1_000 + INTERNAL_REUSE_MS - 1;
        assert_eq!(kept.get("acme--rocket", Scope::Read, Use::Internal, last).unwrap().token, "r1");
        assert!(kept.get("acme--rocket", Scope::Read, Use::Internal, last + 1).is_none());
    }

    #[test]
    fn a_credential_is_kept_for_its_own_repository_scope_and_use() {
        let mut kept = Credentials::default();
        kept.keep("acme--rocket", Scope::Read, Use::Internal, access("r1"), 1_000, 1_000);
        // A read credential never stands in for a write one.
        assert!(kept.get("acme--rocket", Scope::Write, Use::Internal, 1_000).is_none());
        assert!(kept.get("acme--booster", Scope::Read, Use::Internal, 1_000).is_none());
        // An hour-long credential is never handed out.
        assert!(kept.get("acme--rocket", Scope::Read, Use::Handout, 1_000).is_none());
        kept.keep("acme--rocket", Scope::Read, Use::Handout, access("h1"), 1_000, 1_000);
        assert_eq!(kept.get("acme--rocket", Scope::Read, Use::Handout, 1_000).unwrap().token, "h1");
        assert!(kept.get("acme--rocket", Scope::Read, Use::Handout, 1_000 + HANDOUT_REUSE_MS).is_none());
        assert!(kept.get("acme--rocket", Scope::Read, Use::Internal, 1_000 + HANDOUT_REUSE_MS).is_some());
    }

    #[test]
    fn a_shared_credential_is_reused_only_in_its_own_window() {
        let value = serde_json::to_vec(&SharedCredential {
            remote: "https://store.example/acme--rocket.git".to_owned(),
            token: "r1".to_owned(),
            made: 10_000,
        })
        .unwrap();
        let (access, made) = shared_credential(&value, 10_000 + INTERNAL_REUSE_MS - 1, Use::Internal).unwrap();
        assert_eq!(access.token, "r1");
        // Kept here only for what is left of its window, not a new one.
        assert_eq!(made, 10_000);
        assert!(shared_credential(&value, 10_000 + INTERNAL_REUSE_MS, Use::Internal).is_none());
        assert!(shared_credential(&value, 10_000 + HANDOUT_REUSE_MS, Use::Handout).is_none());
        assert!(shared_credential(b"not json", 10_000, Use::Internal).is_none());
        // Each repository, scope and use has its own key, and none is read
        // from before uses differed.
        assert_eq!(shared_key("acme--rocket", Scope::Read, Use::Internal), "cred2:acme--rocket:read:internal");
        assert_ne!(shared_key("acme--rocket", Scope::Read, Use::Internal), shared_key("acme--rocket", Scope::Write, Use::Internal));
        assert_ne!(shared_key("acme--rocket", Scope::Read, Use::Internal), shared_key("acme--rocket", Scope::Read, Use::Handout));
    }

    #[test]
    fn a_shared_credential_kept_here_expires_with_the_original() {
        let mut kept = Credentials::default();
        // Made at 1_000 elsewhere, found here at 100_000.
        kept.keep("acme--rocket", Scope::Read, Use::Internal, access("r1"), 1_000, 100_000);
        assert!(kept.get("acme--rocket", Scope::Read, Use::Internal, 100_000).is_some());
        assert!(kept.get("acme--rocket", Scope::Read, Use::Internal, 1_000 + INTERNAL_REUSE_MS).is_none());
    }

    #[test]
    fn a_turned_down_credential_is_forgotten_and_old_ones_are_dropped() {
        let mut kept = Credentials::default();
        kept.keep("acme--rocket", Scope::Read, Use::Internal, access("r1"), 1_000, 1_000);
        kept.keep("acme--rocket", Scope::Write, Use::Handout, access("w1"), 1_000, 1_000);
        kept.keep("acme--booster", Scope::Read, Use::Internal, access("b1"), 1_000, 1_000);
        kept.forget("acme--rocket");
        assert!(kept.get("acme--rocket", Scope::Read, Use::Internal, 1_000).is_none());
        assert!(kept.get("acme--rocket", Scope::Write, Use::Handout, 1_000).is_none());
        assert!(kept.get("acme--booster", Scope::Read, Use::Internal, 1_000).is_some());
        // Keeping another later drops the expired one from the map.
        let later = 1_000 + INTERNAL_REUSE_MS;
        kept.keep("acme--other", Scope::Read, Use::Internal, access("o1"), later, later);
        assert_eq!(kept.kept.len(), 1);
    }

    #[test]
    fn a_remote_is_worked_out_from_where_its_namespace_starts() {
        // As https://developers.cloudflare.com/artifacts/api/git-protocol/ documents.
        let remote = "https://1e6f2cffa3f445920836e8ebe446bb58.artifacts.cloudflare.net/git/g1t/acme--rocket.git";
        let prefix = learn_prefix(remote, "acme--rocket").unwrap();
        assert_eq!(prefix, "https://1e6f2cffa3f445920836e8ebe446bb58.artifacts.cloudflare.net/git/g1t/");
        assert_eq!(remote_from(&prefix, "pulls--pul_1"), prefix.clone() + "pulls--pul_1.git");
        assert_eq!(remote_from(&prefix, "acme--rocket"), remote);
        // A remote that does not end in the name teaches nothing.
        assert_eq!(learn_prefix(remote, "rocket"), None);
        assert_eq!(learn_prefix("https://x/acme--rocket", "acme--rocket"), None);
        // And back: a remote names its key.
        assert_eq!(key_from_remote(remote).as_deref(), Some("acme--rocket"));
        assert_eq!(
            key_from_remote("https://a.artifacts.cloudflare.net/git/g1t-us-1/acme--rocket.git").as_deref(),
            Some("g1t-us-1/acme--rocket")
        );
        assert_eq!(locate("g1t-us-1/acme--rocket"), ("g1t-us-1".to_owned(), "acme--rocket".to_owned()));
        assert_eq!(locate("acme--rocket"), ("g1t".to_owned(), "acme--rocket".to_owned()));
    }

    #[test]
    fn binding_methods_have_snake_case_meters() {
        assert_eq!(meter_of("createToken"), "binding.create_token");
        assert_eq!(meter_of("readBlob"), "binding.read_blob");
        assert_eq!(meter_of("get"), "binding.get");
    }

    #[test]
    fn reads_by_name_are_kept_under_the_refs_version_and_by_hash_for_good() {
        let hash = "a".repeat(40);
        assert_eq!(log_key(&hash, 1, Some(3)), Some(CacheKey::Forever(format!("log/{hash}-1"))));
        assert_eq!(log_key(&hash, 1, None), Some(CacheKey::Forever(format!("log/{hash}-1"))));
        // A branch is kept only when the version is known.
        assert_eq!(log_key("main", 1, None), None);
        let v3 = log_key("main", 1, Some(3)).unwrap();
        assert!(matches!(&v3, CacheKey::Versioned(path) if path.starts_with("vlog/3/")));
        // A push moves the version and leaves the old answer behind.
        assert_ne!(Some(v3), log_key("main", 1, Some(4)));
        assert_ne!(log_key("main", 1, Some(3)), log_key("main", 50, Some(3)));
        assert_ne!(log_key("main", 1, Some(3)), log_key("dev", 1, Some(3)));
        // Odd branch names make a usable address.
        assert!(matches!(log_key("fix/#1 %20", 1, Some(3)), Some(CacheKey::Versioned(path)) if !path.contains('#') && !path.contains(' ')));
        assert_eq!(branches_key(None), None);
        assert_ne!(branches_key(Some(1)), branches_key(Some(2)));
        assert!(matches!(file_key(&hash, "src/main.rs", None), Some(CacheKey::Forever(_))));
        assert_eq!(file_key("main", "src/main.rs", None), None);
        assert_ne!(file_key("main", "a", Some(1)), file_key("main", "b", Some(1)));
        assert_ne!(file_key("main", "a", Some(1)), file_key("main", "a", Some(2)));
    }

    #[test]
    fn only_full_lowercase_hashes_are_kept() {
        assert!(is_commit_hash(&"a".repeat(40)));
        assert!(is_commit_hash(&"0123456789abcdef".repeat(4)));
        assert!(!is_commit_hash("main"));
        assert!(!is_commit_hash(&"A".repeat(40)));
        assert!(!is_commit_hash(&"a".repeat(39)));
    }
}
