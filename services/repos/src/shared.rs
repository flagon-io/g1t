//! What isolates share with each other: a key-value store whose every value
//! is sealed (AES-256-GCM) under the service's own key, `REPOS_KEY`, with
//! the value's own key as associated data, so a value copied onto another
//! key does not open.
//!
//! Optional: without the `GIT_CACHE` binding or the key, nothing is shared
//! and each isolate keeps only what it made itself. Self-hosted, any
//! Workers KV-compatible store will do.

use g1t_secrets::Sealer;
use worker::Env;
use worker::kv::KvStore;

/// The shortest life Workers KV gives a value.
pub const MIN_TTL_SECONDS: u64 = 60;

pub struct Shared {
    kv: KvStore,
    sealer: Sealer,
}

impl Shared {
    pub fn from_env(env: &Env) -> Option<Shared> {
        let kv = env.kv("GIT_CACHE").ok()?;
        let sealer = Sealer::new(&env.secret("REPOS_KEY").ok()?.to_string())?;
        Some(Shared { kv, sealer })
    }

    /// The value under `key`, if there is one that opens. A failure to
    /// read is a miss.
    pub async fn get(&self, key: &str) -> Option<Vec<u8>> {
        let sealed = self.kv.get(key).bytes().await.ok()??;
        self.sealer.open_bytes(&sealed, key)
    }

    /// Keeps `value` under `key` for `ttl_seconds` (at least a minute). A
    /// failure only costs a later miss.
    pub async fn put(&self, key: &str, value: &[u8], ttl_seconds: u64) {
        let sealed = self.sealer.seal_bytes(value, key);
        let put = match self.kv.put_bytes(key, &sealed) {
            Ok(put) => put.expiration_ttl(ttl_seconds.max(MIN_TTL_SECONDS)),
            Err(_) => return,
        };
        if let Err(error) = put.execute().await {
            worker::console_error!("shared cache: {key} not kept: {error}");
        }
    }

    pub async fn delete(&self, key: &str) {
        if let Err(error) = self.kv.delete(key).await {
            worker::console_error!("shared cache: {key} not removed: {error}");
        }
    }
}
