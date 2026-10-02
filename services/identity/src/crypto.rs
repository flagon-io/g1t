use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use sha2::{Digest, Sha256};

// Kept at the cap the Workers WebCrypto API imposes, so hashes made by
// either implementation verify under the other.
const PBKDF2_ITERATIONS: u32 = 100_000;

pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).expect("no source of randomness");
    hex::encode(buffer)
}

fn derive(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut hash = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut hash);
    hash
}

/// Format: `pbkdf2$<iterations>$<salt base64>$<hash base64>`.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).expect("no source of randomness");
    let hash = derive(password, &salt, PBKDF2_ITERATIONS);
    format!(
        "pbkdf2${PBKDF2_ITERATIONS}${}${}",
        STANDARD.encode(salt),
        STANDARD.encode(hash)
    )
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    let [scheme, iterations, salt, hash] = parts[..] else {
        return false;
    };
    let (Ok(iterations), Ok(salt), Ok(expected)) = (
        iterations.parse::<u32>(),
        STANDARD.decode(salt),
        STANDARD.decode(hash),
    ) else {
        return false;
    };
    if scheme != "pbkdf2" || expected.len() != 32 {
        return false;
    }
    let given = derive(password, &salt, iterations);
    // Constant-time comparison.
    given
        .iter()
        .zip(&expected)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub struct ParsedKey {
    /// `<type> <base64 blob>`, without the comment.
    pub public_key: String,
    /// Matches `ssh-keygen -lf`: `SHA256:` then unpadded base64.
    pub fingerprint: String,
    pub comment: String,
}

/// Parses one line in OpenSSH public key format.
pub fn parse_ssh_key(line: &str) -> Option<ParsedKey> {
    let mut parts = line.split_whitespace();
    let kind = parts.next()?;
    let blob = parts.next()?;
    let supported = matches!(
        kind,
        "ssh-ed25519"
            | "ssh-rsa"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
    );
    if !supported {
        return None;
    }
    let bytes = STANDARD.decode(blob).ok()?;
    // The blob starts with its own length-prefixed copy of the key type.
    let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    if bytes.get(4..4 + length)? != kind.as_bytes() {
        return None;
    }
    Some(ParsedKey {
        public_key: format!("{kind} {blob}"),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&bytes))),
        comment: parts.collect::<Vec<_>>().join(" "),
    })
}
