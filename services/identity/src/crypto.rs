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

/// A confirmation code: `digits` decimal digits, each uniformly random
/// (bytes of 250 and up are drawn again, so no digit is likelier).
pub fn random_digits(digits: usize) -> String {
    let mut code = String::with_capacity(digits);
    let mut byte = [0u8; 1];
    while code.len() < digits {
        getrandom::getrandom(&mut byte).expect("no source of randomness");
        if byte[0] < 250 {
            code.push(char::from(b'0' + byte[0] % 10));
        }
    }
    code
}

/// What is kept of a confirmation code: an HMAC-SHA256 under `key` of the
/// code, bound to the link it was sent with (`token_id`, the hash of the
/// link's token, which names the user and the address). Six digits are few
/// enough to try every one, so a key nobody reading the database has is
/// what keeps the hash from giving the code away. `key` is IDENTITY_KEY;
/// without one (a development setup) the hash is unkeyed.
pub fn code_hash(key: &[u8], token_id: &str, code: &str) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(b"g1t email confirmation code\0");
    mac.update(token_id.as_bytes());
    mac.update(b"\0");
    mac.update(code.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The proof an invite email's link carries that whoever follows it reads
/// that inbox: an HMAC-SHA256 under `key` (IDENTITY_KEY) of the invite's id
/// and the address it is bound to, trimmed and lowercased. Only the email
/// has it: the inviter sees the code, never this, and nobody can make one
/// without the key.
pub fn invite_proof(key: &[u8], invite_id: &str, email: &str) -> String {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(b"g1t invite email proof\0");
    mac.update(invite_id.as_bytes());
    mac.update(b"\0");
    mac.update(email.trim().to_lowercase().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Whether two strings are equal, in time that depends on their length only.
pub fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_codes_are_six_digits_and_every_digit_turns_up() {
        let mut seen = [0u32; 10];
        for _ in 0..2000 {
            let code = random_digits(6);
            assert_eq!(code.len(), 6);
            for digit in code.bytes() {
                assert!(digit.is_ascii_digit());
                seen[usize::from(digit - b'0')] += 1;
            }
        }
        // 12,000 digits: each about 1,200 times.
        assert!(seen.iter().all(|count| (900..1500).contains(count)), "{seen:?}");
    }

    #[test]
    fn a_code_is_kept_as_a_keyed_hash_bound_to_its_link() {
        let hash = code_hash(b"key", "link-a", "482913");
        assert_eq!(hash.len(), 64);
        assert!(!hash.contains("482913"));
        assert_eq!(hash, code_hash(b"key", "link-a", "482913"));
        assert_ne!(hash, code_hash(b"key", "link-b", "482913"));
        assert_ne!(hash, code_hash(b"other", "link-a", "482913"));
        assert_ne!(hash, code_hash(b"key", "link-a", "482914"));
        // The separator keeps "link-a1" + "23456" apart from "link-a" + "123456".
        assert_ne!(code_hash(b"key", "link-a1", "23456"), code_hash(b"key", "link-a", "123456"));
    }

    #[test]
    fn same_compares_whole_strings() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
        assert!(same("", ""));
    }
}
