//! Where packages' files are kept: the `BlobStore` port (crates/blobstore),
//! with R2 behind it on Cloudflare and any S3-compatible storage (MinIO in
//! the compose file) when self-hosted. BLOB_STORE chooses: `r2` (the
//! default) or `s3`.
//!
//! Files are content-addressed: a blob stored whole is at
//! `blobs/sha256/<hex>`, and one that came in parts at the key its upload
//! started with, which the `blobs` table records. Large uploads go up as
//! multipart parts of one size, as R2 requires (every part but the last
//! the same size), however the client cut its chunks.

use worker::{Env, Result};

#[cfg(test)]
pub use g1t_blobstore::Got;
pub use g1t_blobstore::{BlobStore, Part, Store, var};

/// The `BLOBS` bucket; R2's S3 endpoint signs downloads when
/// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID and R2_BUCKET are
/// set. Self-hosted: S3_BUCKET, and S3_PUBLIC_ENDPOINT for signed downloads.
const CONFIG: g1t_blobstore::Config = g1t_blobstore::Config {
    kind: "BLOB_STORE",
    binding: "BLOBS",
    r2_signer: Some(["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_BUCKET"]),
    s3_bucket: "S3_BUCKET",
    s3_public_endpoint: Some("S3_PUBLIC_ENDPOINT"),
};

/// The store this installation keeps packages' files in.
pub fn from_env(env: &Env) -> Result<Store> {
    Store::from_env(env, &CONFIG)
}
