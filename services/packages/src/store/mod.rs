//! Where packages' files are kept: the `BlobStore` port, with R2 behind it
//! on Cloudflare and any S3-compatible storage (MinIO in the compose file)
//! when self-hosted. BLOB_STORE chooses: `r2` (the default) or `s3`.
//!
//! Files are content-addressed: a blob stored whole is at
//! `blobs/sha256/<hex>`, and one that came in parts at the key its upload
//! started with, which the `blobs` table records. Large uploads go up as
//! multipart parts of one size, as R2 requires (every part but the last
//! the same size), however the client cut its chunks.

mod r2;
mod s3;

use serde::{Deserialize, Serialize};
use worker::{Env, Response, ResponseBody, Result};

use crate::range::Wanted;

pub use r2::R2Store;
pub use s3::S3Store;

/// One part of a multipart upload, as completing it needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub number: u16,
    pub etag: String,
}

/// An object read back.
pub struct Got {
    /// The whole object's size, whatever range was read.
    pub size: u64,
    pub body: ResponseBody,
}

impl Got {
    pub async fn bytes(self) -> Result<Vec<u8>> {
        match self.body {
            ResponseBody::Empty => Ok(Vec::new()),
            ResponseBody::Body(bytes) => Ok(bytes),
            stream => Response::from_body(stream)?.bytes().await,
        }
    }
}

/// What the registry needs of storage.
pub trait BlobStore {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()>;
    /// The object, or the part of it `range` asks for.
    async fn get(&self, key: &str, range: Option<Wanted>) -> Result<Option<Got>>;
    /// The object's size, if it is there.
    async fn head(&self, key: &str) -> Result<Option<u64>>;
    async fn delete(&self, key: &str) -> Result<()>;
    /// Starts a multipart upload to `key`, and says its id.
    async fn create_multipart(&self, key: &str) -> Result<String>;
    async fn upload_part(&self, key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part>;
    async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()>;
    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()>;
    /// A URL that downloads the object for `expires` seconds without
    /// passing through this Worker, when the store can sign one.
    fn presign_get(&self, key: &str, expires: u32, now_ms: u64) -> Option<String>;

    /// The whole object, read into memory: for small ones only.
    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match self.get(key, None).await? {
            Some(got) => Ok(Some(got.bytes().await?)),
            None => Ok(None),
        }
    }
}

/// The store this installation is configured with.
pub enum Store {
    R2(R2Store),
    S3(S3Store),
}

impl Store {
    pub fn from_env(env: &Env) -> Result<Store> {
        let kind = env.var("BLOB_STORE").map(|v| v.to_string()).unwrap_or_default();
        if kind == "s3" {
            return Ok(Store::S3(S3Store::from_env(env)?));
        }
        Ok(Store::R2(R2Store::from_env(env)?))
    }
}

impl BlobStore for Store {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        match self {
            Store::R2(s) => s.put(key, bytes).await,
            Store::S3(s) => s.put(key, bytes).await,
        }
    }

    async fn get(&self, key: &str, range: Option<Wanted>) -> Result<Option<Got>> {
        match self {
            Store::R2(s) => s.get(key, range).await,
            Store::S3(s) => s.get(key, range).await,
        }
    }

    async fn head(&self, key: &str) -> Result<Option<u64>> {
        match self {
            Store::R2(s) => s.head(key).await,
            Store::S3(s) => s.head(key).await,
        }
    }

    async fn delete(&self, key: &str) -> Result<()> {
        match self {
            Store::R2(s) => s.delete(key).await,
            Store::S3(s) => s.delete(key).await,
        }
    }

    async fn create_multipart(&self, key: &str) -> Result<String> {
        match self {
            Store::R2(s) => s.create_multipart(key).await,
            Store::S3(s) => s.create_multipart(key).await,
        }
    }

    async fn upload_part(&self, key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part> {
        match self {
            Store::R2(s) => s.upload_part(key, upload_id, number, bytes).await,
            Store::S3(s) => s.upload_part(key, upload_id, number, bytes).await,
        }
    }

    async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()> {
        match self {
            Store::R2(s) => s.complete_multipart(key, upload_id, parts).await,
            Store::S3(s) => s.complete_multipart(key, upload_id, parts).await,
        }
    }

    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()> {
        match self {
            Store::R2(s) => s.abort_multipart(key, upload_id).await,
            Store::S3(s) => s.abort_multipart(key, upload_id).await,
        }
    }

    fn presign_get(&self, key: &str, expires: u32, now_ms: u64) -> Option<String> {
        match self {
            Store::R2(s) => s.presign_get(key, expires, now_ms),
            Store::S3(s) => s.presign_get(key, expires, now_ms),
        }
    }
}

/// A configuration variable, or the empty string.
pub(crate) fn var(env: &Env, name: &str) -> String {
    env.var(name)
        .map(|v| v.to_string())
        .or_else(|_| env.secret(name).map(|v| v.to_string()))
        .unwrap_or_default()
}
