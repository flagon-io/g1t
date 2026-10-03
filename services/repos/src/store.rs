//! The storage that actually holds git repositories.
//!
//! The service depends on the [`GitStore`] and [`GitRepo`] ports;
//! [`ArtifactsStore`] is the adapter for Cloudflare Artifacts.

use g1t_contracts::repos::{Branch, Commit, EntryKind, GitAccess, Signature, TreeEntry};
use g1t_contracts::time::rfc3339;
use g1t_kit::js;
use serde::Deserialize;
use worker::js_sys::{Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Env, Result};

/// How long a credential handed to git stays valid.
const TOKEN_TTL_SECONDS: u32 = 300;

#[derive(Clone, Copy)]
pub enum Scope {
    Read,
    Write,
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
}

impl ArtifactsStore {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(Self {
            binding: js::binding(env, "ARTIFACTS")?,
        })
    }
}

impl GitStore for ArtifactsStore {
    type Repo = ArtifactsRepo;

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
        let scope = match scope {
            Scope::Read => "read",
            Scope::Write => "write",
        };
        let info: RawInfo = js::from_js(&js::call(&self.handle, "info", &[]).await?)?;
        let token: RawToken = js::from_js(
            &js::call(
                &self.handle,
                "createToken",
                &[scope.into(), TOKEN_TTL_SECONDS.into()],
            )
            .await?,
        )?;
        Ok(GitAccess {
            remote: info.remote,
            token: token.plaintext,
        })
    }

    async fn branches(&self) -> Result<Vec<Branch>> {
        crate::refs::branches(&self.access(Scope::Read).await?).await
    }

    async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
        let options = js::to_js(&serde_json::json!({ "ref": git_ref, "limit": limit }))?;
        let commits: Vec<RawCommit> =
            js::from_js(&js::call(&self.handle, "log", &[options]).await?)?;
        Ok(commits
            .into_iter()
            .map(|commit| Commit {
                hash: commit.hash,
                tree_hash: commit.tree_hash,
                message: commit.message,
                author: commit.author,
                parents: commit.parents,
                authored_at: rfc3339(commit.authored_at * 1000),
            })
            .collect())
    }

    async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
        let commit: Option<RawCommit> =
            js::from_js(&js::call(&self.handle, "readCommit", &[commit_hash.into()]).await?)?;
        Ok(commit.map(|commit| commit.parents))
    }

    async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
        if let Some(bytes) = self.cached("tree", tree_hash).await {
            if let Ok(entries) = serde_json::from_slice::<Vec<TreeEntry>>(&bytes) {
                return Ok(Some(entries));
            }
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
        if let Some(entries) = &entries {
            if let Ok(bytes) = serde_json::to_vec(entries) {
                self.keep("tree", tree_hash, bytes).await;
            }
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
