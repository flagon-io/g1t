//! Secrets at rest, and the signatures put on what crosses between g1t
//! and outside systems.
//!
//! A secret is sealed with AES-256-GCM under its service's own key, with the
//! id of the row it belongs to as associated data, so a sealed value copied
//! onto another row does not open.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const VERSION: &str = "v1:";

pub struct Sealer {
    cipher: Aes256Gcm,
}

impl Sealer {
    /// From the service's key: 64 hex characters.
    pub fn new(key_hex: &str) -> Option<Sealer> {
        let key = hex::decode(key_hex.trim()).ok()?;
        (key.len() == 32).then(|| Sealer {
            cipher: Aes256Gcm::new_from_slice(&key).expect("a 32-byte key"),
        })
    }

    pub fn seal(&self, plaintext: &str, bound_to: &str) -> String {
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce).expect("no source of randomness");
        let sealed = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: bound_to.as_bytes(),
                },
            )
            .expect("encrypting cannot fail");
        let mut out = nonce.to_vec();
        out.extend(sealed);
        format!("{VERSION}{}", STANDARD.encode(out))
    }

    /// `None` when it was sealed under another key or for another row.
    pub fn open(&self, sealed: &str, bound_to: &str) -> Option<String> {
        let bytes = STANDARD.decode(sealed.strip_prefix(VERSION)?).ok()?;
        if bytes.len() < 12 {
            return None;
        }
        let (nonce, ciphertext) = bytes.split_at(12);
        let plain = self
            .cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: bound_to.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(plain).ok()
    }
}

pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).expect("no source of randomness");
    hex::encode(buffer)
}

pub fn hmac_sha256_hex(secret: &str, body: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(body.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Compares in time that does not depend on where they differ.
pub fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// Whether `signature` is `body` signed with `secret`: hex HMAC-SHA256,
/// optionally written `sha256=<hex>`.
pub fn signed(secret: &str, body: &str, signature: &str) -> bool {
    let given = signature.trim();
    let given = given.strip_prefix("sha256=").unwrap_or(given);
    same(&hmac_sha256_hex(secret, body), &given.to_ascii_lowercase())
}

/// The last four characters, to tell keys apart without showing them.
pub fn hint(secret: &str) -> String {
    let tail: String = secret.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    #[test]
    fn a_sealed_secret_opens_only_for_its_own_row() {
        let sealer = Sealer::new(KEY).unwrap();
        let sealed = sealer.seal("sk-ant-secret", "con_1");
        assert!(!sealed.contains("sk-ant"));
        assert_eq!(sealer.open(&sealed, "con_1").as_deref(), Some("sk-ant-secret"));
        assert_eq!(sealer.open(&sealed, "con_2"), None);
    }

    #[test]
    fn a_key_of_the_wrong_length_is_refused() {
        assert!(Sealer::new("abcd").is_none());
    }

    #[test]
    fn signatures_are_checked_in_either_form() {
        let signature = hmac_sha256_hex("shh", "{\"a\":1}");
        assert!(signed("shh", "{\"a\":1}", &signature));
        assert!(signed("shh", "{\"a\":1}", &format!("sha256={signature}")));
        assert!(!signed("shh", "{\"a\":2}", &signature));
        assert!(!signed("other", "{\"a\":1}", &signature));
    }

    #[test]
    fn a_hint_shows_only_the_end() {
        assert_eq!(hint("sk-ant-api03-abcdef"), "…cdef");
    }
}
