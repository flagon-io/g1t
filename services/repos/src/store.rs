//! The storage that actually holds git repositories.
//!
//! The service depends on the [`GitStore`] and [`GitRepo`] ports;
//! [`ArtifactsStore`] is the adapter for Cloudflare Artifacts.

use g1t_contracts::repos::{Branch, Commit, EntryKind, GitAccess, Signature, TreeEntry};
use g1t_contracts::time::rfc3339;
use g1t_kit::js;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use worker::js_sys::{Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Env, Result};

/// How long a credential handed to git stays valid.
const TOKEN_TTL_SECONDS: u32 = 300;
/// The same, in milliseconds.
pub const CREDENTIAL_LIFE_MS: u64 = TOKEN_TTL_SECONDS as u64 * 1000;
/// How long a credential is reused for, so that every one used has at
/// least two minutes left. Credentials never leave this service: g1t has
/// already decided who may do what before one is used.
const TOKEN_REUSE_MS: u64 = 180_000;

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
    async fn create(
        &self,
        key: &str,
        description: Option<&str>,
        default_branch: &str,
    ) -> Result<()>;
    async fn open(&self, key: &str) -> Result<Self::Repo>;
    /// A credential for `key` made a moment ago, if the store keeps one.
    async fn kept_access(&self, _key: &str, _scope: Scope) -> Option<(GitAccess, Kept)> {
        None
    }
    /// A new credential for `key`, which the store may keep for next time.
    async fn mint_access(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        self.open(key).await?.access(scope).await
    }
    /// A remote URL and credential for git itself, for the repository at
    /// `key`. A store may hand out one it made a moment ago.
    async fn access(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        match self.kept_access(key, scope).await {
            Some((access, _)) => Ok(access),
            None => self.mint_access(key, scope).await,
        }
    }
    /// Stops handing out the credentials it keeps for `key`: the store
    /// turned one down, or the repository is gone.
    async fn forget_access(&self, _key: &str) {}
    /// Removes a repository and everything in it, for good. Succeeds if it
    /// is already gone.
    async fn delete(&self, key: &str) -> Result<()>;
}

/// One open repository.
#[allow(async_fn_in_trait)]
pub trait GitRepo {
    /// A remote URL and short-lived credential for git itself.
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
    /// Makes a copy-on-write copy of this repository under `target_key`.
    async fn fork(&self, target_key: &str) -> Result<()>;
}

pub struct ArtifactsStore {
    binding: JsValue,
    /// Where isolates share the credentials they make; see shared.rs.
    shared: Option<Rc<crate::shared::Shared>>,
}

impl ArtifactsStore {
    pub fn new(env: &Env, shared: Option<Rc<crate::shared::Shared>>) -> Result<Self> {
        Ok(Self {
            binding: js::binding(env, "ARTIFACTS")?,
            shared,
        })
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
/// repository, and the scope.
fn shared_key(key: &str, scope: Scope) -> String {
    format!("cred:{key}:{}", scope.as_str())
}

/// A shared credential, if it was made less than [`TOKEN_REUSE_MS`] before
/// `now`; with when it was made.
fn shared_credential(bytes: &[u8], now: u64) -> Option<(GitAccess, u64)> {
    let kept: SharedCredential = serde_json::from_slice(bytes).ok()?;
    (now.saturating_sub(kept.made) < TOKEN_REUSE_MS).then_some((
        GitAccess {
            remote: kept.remote,
            token: kept.token,
        },
        kept.made,
    ))
}

/// Credentials made in the last few minutes, by repository and scope.
/// Making one is a round trip to the store on every git request; reusing
/// it saves that, and the store's lookup of the repository with it.
#[derive(Default)]
pub struct Credentials {
    kept: HashMap<(String, Scope), (GitAccess, u64)>,
}

impl Credentials {
    /// One made for `key` and `scope` less than [`TOKEN_REUSE_MS`] before `now`.
    pub fn get(&self, key: &str, scope: Scope, now: u64) -> Option<GitAccess> {
        self.kept
            .get(&(key.to_owned(), scope))
            .filter(|(_, made)| now.saturating_sub(*made) < TOKEN_REUSE_MS)
            .map(|(access, _)| access.clone())
    }

    pub fn keep(&mut self, key: &str, scope: Scope, access: GitAccess, now: u64) {
        // Expired ones go first, so the map stays as small as the isolate's
        // recent repositories.
        self.kept
            .retain(|_, (_, made)| now.saturating_sub(*made) < TOKEN_REUSE_MS);
        self.kept.insert((key.to_owned(), scope), (access, now));
    }

    pub fn forget(&mut self, key: &str) {
        self.kept.retain(|(kept, _), _| kept != key);
    }
}

thread_local! {
    static CREDENTIALS: RefCell<Credentials> = RefCell::new(Credentials::default());
}

impl GitStore for ArtifactsStore {
    type Repo = ArtifactsRepo;

    /// One kept in this isolate, else one another isolate shared. A shared
    /// one is kept here only for the rest of its own reuse window.
    async fn kept_access(&self, key: &str, scope: Scope) -> Option<(GitAccess, Kept)> {
        let now = g1t_kit::now_ms();
        if let Some(access) = CREDENTIALS.with(|kept| kept.borrow().get(key, scope, now)) {
            return Some((access, Kept::Isolate));
        }
        let bytes = self.shared.as_ref()?.get(&shared_key(key, scope)).await?;
        let (access, made) = shared_credential(&bytes, now)?;
        CREDENTIALS.with(|kept| kept.borrow_mut().keep(key, scope, access.clone(), made));
        Some((access, Kept::Shared))
    }

    /// Made by the store, then kept here and shared with other isolates.
    async fn mint_access(&self, key: &str, scope: Scope) -> Result<GitAccess> {
        let now = g1t_kit::now_ms();
        let access = self.open(key).await?.access(scope).await?;
        CREDENTIALS.with(|kept| kept.borrow_mut().keep(key, scope, access.clone(), now));
        if let Some(shared) = &self.shared {
            let value = SharedCredential {
                remote: access.remote.clone(),
                token: access.token.clone(),
                made: now,
            };
            if let Ok(bytes) = serde_json::to_vec(&value) {
                shared
                    .put(&shared_key(key, scope), &bytes, TOKEN_REUSE_MS / 1000)
                    .await;
            }
        }
        Ok(access)
    }

    async fn forget_access(&self, key: &str) {
        CREDENTIALS.with(|kept| kept.borrow_mut().forget(key));
        if let Some(shared) = &self.shared {
            futures_util::future::join(
                shared.delete(&shared_key(key, Scope::Read)),
                shared.delete(&shared_key(key, Scope::Write)),
            )
            .await;
        }
    }

    async fn create(
        &self,
        key: &str,
        description: Option<&str>,
        default_branch: &str,
    ) -> Result<()> {
        let options = js::to_js(&serde_json::json!({
            "description": description,
            "setDefaultBranch": default_branch,
        }))?;
        match js::call(&self.binding, "create", &[key.into(), options]).await {
            // Left behind by an earlier failed attempt; adopt it.
            Err(thrown) if !thrown.is("ALREADY_EXISTS") => Err(thrown.into()),
            _ => Ok(()),
        }
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.forget_access(key).await;
        match js::call(&self.binding, "delete", &[key.into()]).await {
            // Gone already: an earlier purge got this far.
            Err(thrown) if !thrown.is("NOT_FOUND") => Err(thrown.into()),
            _ => Ok(()),
        }
    }

    async fn open(&self, key: &str) -> Result<ArtifactsRepo> {
        Ok(ArtifactsRepo {
            handle: js::call(&self.binding, "get", &[key.into()]).await?,
            key: key.to_owned(),
        })
    }
}

/// A handle to one Artifacts repository. It is an RPC stub, so it is
/// released when dropped.
pub struct ArtifactsRepo {
    handle: JsValue,
    /// The repository's store key, which scopes its cached objects.
    key: String,
}

/// Where cached git objects live. Trees and blobs are named by their
/// content, so a cached one is never stale; each is kept under its own
/// repository's key, so a repository only ever finds its own objects.
const OBJECT_CACHE: &str = "https://objects.g1t.internal/";
/// Blobs larger than this are not cached.
const MAX_CACHED_BLOB: usize = 1024 * 1024;
const OBJECT_MAX_AGE: &str = "public, max-age=31536000, immutable";

/// Whether a ref is a full commit hash (SHA-1 or SHA-256), whose history
/// can be kept for good.
pub fn is_commit_hash(git_ref: &str) -> bool {
    (git_ref.len() == 40 || git_ref.len() == 64) && git_ref.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl ArtifactsRepo {
    fn cache_url(&self, kind: &str, hash: &str) -> String {
        format!("{OBJECT_CACHE}{}/{kind}/{hash}", self.key)
    }

    async fn cached(&self, kind: &str, hash: &str) -> Option<Vec<u8>> {
        let mut response = worker::Cache::default()
            .get(self.cache_url(kind, hash), false)
            .await
            .ok()??;
        response.bytes().await.ok()
    }

    /// Keeps an object for next time. A failure only costs a later read.
    async fn keep(&self, kind: &str, hash: &str, bytes: Vec<u8>) {
        let Ok(mut response) = worker::Response::from_bytes(bytes) else {
            return;
        };
        let _ = response.headers_mut().set("cache-control", OBJECT_MAX_AGE);
        let _ = worker::Cache::default()
            .put(self.cache_url(kind, hash), response)
            .await;
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
    async fn access(&self, scope: Scope) -> Result<GitAccess> {
        let scope = scope.as_str();
        // Two round trips to the store, at once.
        let (info, token) = futures_util::future::join(
            js::call(&self.handle, "info", &[]),
            js::call(
                &self.handle,
                "createToken",
                &[scope.into(), TOKEN_TTL_SECONDS.into()],
            ),
        )
        .await;
        let info: RawInfo = js::from_js(&info?)?;
        let token: RawToken = js::from_js(&token?)?;
        Ok(GitAccess {
            remote: info.remote,
            token: token.plaintext,
        })
    }

    async fn branches(&self) -> Result<Vec<Branch>> {
        crate::refs::branches(&self.access(Scope::Read).await?).await
    }

    async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
        // History from a commit never changes, so a log asked for by hash is
        // kept like an object: walking it is a read per commit.
        let by_hash = is_commit_hash(git_ref);
        let key = format!("{git_ref}-{limit}");
        if by_hash
            && let Some(bytes) = self.cached("log", &key).await
            && let Ok(commits) = serde_json::from_slice::<Vec<Commit>>(&bytes)
        {
            return Ok(commits);
        }
        let options = js::to_js(&serde_json::json!({ "ref": git_ref, "limit": limit }))?;
        let raw: Vec<RawCommit> =
            js::from_js(&js::call(&self.handle, "log", &[options]).await?)?;
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
        // An unknown hash logs nothing; that is not kept, in case it arrives.
        if by_hash
            && !commits.is_empty()
            && let Ok(bytes) = serde_json::to_vec(&commits)
        {
            self.keep("log", &key, bytes).await;
        }
        Ok(commits)
    }

    async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
        let commit: Option<RawCommit> =
            js::from_js(&js::call(&self.handle, "readCommit", &[commit_hash.into()]).await?)?;
        Ok(commit.map(|commit| commit.parents))
    }

    async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
        if let Some(bytes) = self.cached("tree", tree_hash).await
            && let Ok(entries) = serde_json::from_slice::<Vec<TreeEntry>>(&bytes) {
                return Ok(Some(entries));
            }
        let entries: Option<Vec<RawEntry>> =
            js::from_js(&js::call(&self.handle, "readTree", &[tree_hash.into()]).await?)?;
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
            && let Ok(bytes) = serde_json::to_vec(entries) {
                self.keep("tree", tree_hash, bytes).await;
            }
        Ok(entries)
    }

    async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
        if let Some(bytes) = self.cached("blob", blob_hash).await {
            return Ok(Some(bytes));
        }
        let bytes = blob_bytes(js::call(&self.handle, "readBlob", &[blob_hash.into()]).await?).await?;
        if let Some(bytes) = bytes.as_ref().filter(|bytes| bytes.len() <= MAX_CACHED_BLOB) {
            self.keep("blob", blob_hash, bytes.clone()).await;
        }
        Ok(bytes)
    }

    async fn read_file(&self, git_ref: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let args = js::to_js(&serde_json::json!({ "ref": git_ref, "path": path }))?;
        blob_bytes(js::call(&self.handle, "readFile", &[args]).await?).await
    }

    async fn fork(&self, target_key: &str) -> Result<()> {
        let options = js::to_js(&serde_json::json!({ "defaultBranchOnly": true }))?;
        match js::call(&self.handle, "fork", &[target_key.into(), options]).await {
            Err(thrown) if !thrown.is("ALREADY_EXISTS") => Err(thrown.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Credentials, GitAccess, Scope, SharedCredential, TOKEN_REUSE_MS, shared_credential, shared_key};

    fn access(token: &str) -> GitAccess {
        GitAccess {
            remote: "https://store.example/acme--rocket.git".to_owned(),
            token: token.to_owned(),
        }
    }

    #[test]
    fn a_credential_is_reused_only_while_it_has_time_left() {
        let mut kept = Credentials::default();
        kept.keep("acme--rocket", Scope::Read, access("r1"), 1_000);
        assert_eq!(kept.get("acme--rocket", Scope::Read, 1_000).unwrap().token, "r1");
        assert_eq!(
            kept.get("acme--rocket", Scope::Read, 1_000 + TOKEN_REUSE_MS - 1).unwrap().token,
            "r1"
        );
        assert!(kept.get("acme--rocket", Scope::Read, 1_000 + TOKEN_REUSE_MS).is_none());
    }

    #[test]
    fn a_credential_is_kept_for_its_own_repository_and_scope() {
        let mut kept = Credentials::default();
        kept.keep("acme--rocket", Scope::Read, access("r1"), 1_000);
        // A read credential never stands in for a write one.
        assert!(kept.get("acme--rocket", Scope::Write, 1_000).is_none());
        assert!(kept.get("acme--booster", Scope::Read, 1_000).is_none());
        kept.keep("acme--rocket", Scope::Write, access("w1"), 1_000);
        assert_eq!(kept.get("acme--rocket", Scope::Write, 1_000).unwrap().token, "w1");
        assert_eq!(kept.get("acme--rocket", Scope::Read, 1_000).unwrap().token, "r1");
    }

    #[test]
    fn a_shared_credential_is_reused_only_in_its_own_window() {
        let value = serde_json::to_vec(&SharedCredential {
            remote: "https://store.example/acme--rocket.git".to_owned(),
            token: "r1".to_owned(),
            made: 10_000,
        })
        .unwrap();
        let (access, made) = shared_credential(&value, 10_000 + TOKEN_REUSE_MS - 1).unwrap();
        assert_eq!(access.token, "r1");
        // Kept here only for what is left of its window, not a new one.
        assert_eq!(made, 10_000);
        assert!(shared_credential(&value, 10_000 + TOKEN_REUSE_MS).is_none());
        // Anything else is a miss.
        assert!(shared_credential(b"not json", 10_000).is_none());
        // Each repository and scope has its own key.
        assert_eq!(shared_key("acme--rocket", Scope::Read), "cred:acme--rocket:read");
        assert_ne!(shared_key("acme--rocket", Scope::Read), shared_key("acme--rocket", Scope::Write));
    }

    #[test]
    fn a_shared_credential_kept_here_expires_with_the_original() {
        let mut kept = Credentials::default();
        // Made at 1_000 elsewhere, found here at 100_000.
        kept.keep("acme--rocket", Scope::Read, access("r1"), 1_000);
        assert!(kept.get("acme--rocket", Scope::Read, 100_000).is_some());
        assert!(kept.get("acme--rocket", Scope::Read, 1_000 + TOKEN_REUSE_MS).is_none());
    }

    #[test]
    fn a_turned_down_credential_is_forgotten_and_old_ones_are_dropped() {
        let mut kept = Credentials::default();
        kept.keep("acme--rocket", Scope::Read, access("r1"), 1_000);
        kept.keep("acme--rocket", Scope::Write, access("w1"), 1_000);
        kept.keep("acme--booster", Scope::Read, access("b1"), 1_000);
        kept.forget("acme--rocket");
        assert!(kept.get("acme--rocket", Scope::Read, 1_000).is_none());
        assert!(kept.get("acme--rocket", Scope::Write, 1_000).is_none());
        assert!(kept.get("acme--booster", Scope::Read, 1_000).is_some());
        // Keeping another later drops the expired one from the map.
        kept.keep("acme--other", Scope::Read, access("o1"), 1_000 + TOKEN_REUSE_MS);
        assert_eq!(kept.kept.len(), 1);
    }
}

#[cfg(test)]
mod log_cache_tests {
    use super::is_commit_hash;

    #[test]
    fn only_full_lowercase_hashes_are_kept() {
        assert!(is_commit_hash(&"a".repeat(40)));
        assert!(is_commit_hash(&"0123456789abcdef".repeat(4)));
        assert!(!is_commit_hash("main"));
        assert!(!is_commit_hash(&"A".repeat(40)));
        assert!(!is_commit_hash(&"a".repeat(39)));
    }
}
