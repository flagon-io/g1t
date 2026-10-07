//! Object storage behind one port, `BlobStore`: R2 on Cloudflare, and any
//! S3-compatible store (MinIO in the self-host compose file) elsewhere.
//!
//! Every service that keeps objects names its own [`Config`]: the variable
//! that chooses the store (`r2`, the default, or `s3`), the R2 bucket
//! binding, and the variable naming its S3 bucket. The S3 endpoint and its
//! credentials (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
//! S3_SECRET_ACCESS_KEY) are the installation's, shared by every service.
//!
//! Large objects go up as multipart parts of one size, as R2 requires
//! (every part but the last the same size).

mod r2;
mod s3;
pub mod sigv4;

use serde::{Deserialize, Serialize};
use worker::{Env, Response, ResponseBody, Result};

pub use r2::R2Store;
pub use s3::S3Store;

/// A part of an object a read asks for: `length` bytes from `offset`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Wanted {
    pub offset: u64,
    pub length: u64,
}

impl Wanted {
    /// `bytes <first>-<last>/<size>`.
    pub fn content_range(&self, size: u64) -> String {
        format!("bytes {}-{}/{size}", self.offset, self.offset + self.length - 1)
    }
}

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

/// What a service needs of storage.
#[allow(async_fn_in_trait)]
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

/// Where one service's objects are, by the names of its bindings and
/// variables.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// The variable that chooses the store: `r2` (or unset) or `s3`.
    pub kind: &'static str,
    /// The R2 bucket binding.
    pub binding: &'static str,
    /// The variables that let R2's S3 endpoint sign download URLs: access
    /// key id, secret, account id and bucket name. None: never signed.
    pub r2_signer: Option<[&'static str; 4]>,
    /// The variable naming the S3 bucket.
    pub s3_bucket: &'static str,
    /// The variable naming where clients reach the S3 store, for signed
    /// downloads. None: never signed.
    pub s3_public_endpoint: Option<&'static str>,
}

/// The store a service is configured with.
pub enum Store {
    R2(R2Store),
    S3(S3Store),
}

impl Store {
    pub fn from_env(env: &Env, config: &Config) -> Result<Store> {
        if var(env, config.kind) == "s3" {
            return Ok(Store::S3(S3Store::from_env(env, config)?));
        }
        Ok(Store::R2(R2Store::from_env(env, config)?))
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

/// A configuration variable or secret, or the empty string.
pub fn var(env: &Env, name: &str) -> String {
    env.var(name)
        .map(|v| v.to_string())
        .or_else(|_| env.secret(name).map(|v| v.to_string()))
        .unwrap_or_default()
}
