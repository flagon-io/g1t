//! Commit signatures, for the "Require signed commits" rule.
//!
//! A commit signed with an SSH key carries an `SSHSIG` signature in its
//! `gpgsig` header (git's `gpg.format ssh`). It is verified here when the
//! key is ed25519: the signature must be valid over the commit without
//! that header, in the `git` namespace, and the key must be registered on
//! the g1t account that owns the committer's verified email address.
//! Signatures with other key types and GPG signatures are reported as not
//! verified, with why.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use ed25519_dalek::{Signature as Ed25519Signature, Verifier, VerifyingKey};
use g1t_contracts::rules::Signature;
use sha2::{Digest, Sha256, Sha512};

/// A commit's signature as found in its object: the armored text, and the
/// bytes it signs (the commit without its `gpgsig` header).
#[derive(Debug, PartialEq, Eq)]
pub struct Signed {
    pub armored: String,
    pub payload: Vec<u8>,
}

/// The signature in a raw commit object, if it has one.
pub fn signed(commit: &[u8]) -> Option<Signed> {
    let text = std::str::from_utf8(commit).ok()?;
    let (headers, message) = text.split_once("\n\n").unwrap_or((text, ""));
    let mut payload = String::with_capacity(text.len());
    let mut armored = String::new();
    let mut in_signature = false;
    for line in headers.split('\n') {
        if let Some(first) = line.strip_prefix("gpgsig ").or_else(|| line.strip_prefix("gpgsig-sha256 ")) {
            in_signature = true;
            armored.push_str(first);
            armored.push('\n');
            continue;
        }
        if in_signature && let Some(more) = line.strip_prefix(' ') {
            armored.push_str(more);
            armored.push('\n');
            continue;
        }
        in_signature = false;
        payload.push_str(line);
        payload.push('\n');
    }
    if armored.is_empty() {
        return None;
    }
    payload.push('\n');
    payload.push_str(message);
    Some(Signed { armored, payload: payload.into_bytes() })
}

/// What reading an SSH signature found: the key's fingerprint, as
/// `ssh-keygen -lf` prints it, once the signature checks out.
#[derive(Debug, PartialEq, Eq)]
pub enum Checked {
    /// Valid; owned by whoever registered this key.
    Valid { fingerprint: String },
    Invalid(String),
}

fn take<'a>(bytes: &mut &'a [u8], count: usize) -> Option<&'a [u8]> {
    if bytes.len() < count {
        return None;
    }
    let (head, rest) = bytes.split_at(count);
    *bytes = rest;
    Some(head)
}

fn string<'a>(bytes: &mut &'a [u8]) -> Option<&'a [u8]> {
    let length = u32::from_be_bytes(take(bytes, 4)?.try_into().ok()?) as usize;
    take(bytes, length)
}

fn put_string(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}

/// Checks an armored signature over `payload`.
pub fn check(armored: &str, payload: &[u8]) -> Checked {
    let armored = armored.trim();
    if armored.starts_with("-----BEGIN PGP SIGNATURE-----") {
        return Checked::Invalid("GPG signatures are not verified yet; sign with an SSH key (git config gpg.format ssh).".to_owned());
    }
    if armored.starts_with("-----BEGIN SIGNED MESSAGE-----") {
        return Checked::Invalid("S/MIME signatures are not verified; sign with an SSH key (git config gpg.format ssh).".to_owned());
    }
    let Some(body) = armored
        .strip_prefix("-----BEGIN SSH SIGNATURE-----")
        .and_then(|rest| rest.trim().strip_suffix("-----END SSH SIGNATURE-----"))
    else {
        return Checked::Invalid("the signature is in a format g1t does not read.".to_owned());
    };
    let encoded: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let Ok(blob) = STANDARD.decode(encoded) else {
        return Checked::Invalid("the signature is not valid base64.".to_owned());
    };
    let invalid = |why: &str| Checked::Invalid(why.to_owned());
    let mut rest = blob.as_slice();
    if take(&mut rest, 6) != Some(b"SSHSIG".as_slice()) {
        return invalid("the signature is not an SSH signature.");
    }
    if take(&mut rest, 4).map(|version| u32::from_be_bytes(version.try_into().unwrap_or_default())) != Some(1) {
        return invalid("the signature's version is not one g1t reads.");
    }
    let (Some(public_key), Some(namespace), Some(reserved), Some(hash), Some(signature)) =
        (string(&mut rest), string(&mut rest), string(&mut rest), string(&mut rest), string(&mut rest))
    else {
        return invalid("the signature is cut short.");
    };
    if namespace != b"git" {
        return invalid("the signature is not for git commits (its namespace is not git).");
    }
    let mut key = public_key;
    let (Some(key_type), Some(key_bytes)) = (string(&mut key), string(&mut key)) else {
        return invalid("the signing key could not be read.");
    };
    if key_type != b"ssh-ed25519" {
        return Checked::Invalid(format!(
            "{} keys are not verified yet; sign with an ed25519 key.",
            String::from_utf8_lossy(key_type)
        ));
    }
    let mut sig = signature;
    let (Some(sig_type), Some(sig_bytes)) = (string(&mut sig), string(&mut sig)) else {
        return invalid("the signature could not be read.");
    };
    if sig_type != b"ssh-ed25519" {
        return invalid("the signature does not match its key's type.");
    }
    let digest: Vec<u8> = match hash {
        b"sha512" => Sha512::digest(payload).to_vec(),
        b"sha256" => Sha256::digest(payload).to_vec(),
        _ => return invalid("the signature uses a hash g1t does not read."),
    };
    let mut signed_data = b"SSHSIG".to_vec();
    put_string(&mut signed_data, namespace);
    put_string(&mut signed_data, reserved);
    put_string(&mut signed_data, hash);
    put_string(&mut signed_data, &digest);
    let (Ok(key_bytes), Ok(sig_bytes)) = (<[u8; 32]>::try_from(key_bytes), <[u8; 64]>::try_from(sig_bytes)) else {
        return invalid("the key or signature has the wrong length.");
    };
    let Ok(verifying) = VerifyingKey::from_bytes(&key_bytes) else {
        return invalid("the signing key is not a valid ed25519 key.");
    };
    if verifying.verify(&signed_data, &Ed25519Signature::from_bytes(&sig_bytes)).is_err() {
        return invalid("the signature does not match the commit.");
    }
    Checked::Valid { fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(public_key))) }
}

/// A commit's signature, decided: `key_owners` maps fingerprints to the
/// account (user id) that registered the key, `email_owners` the
/// committer's address to the account (id, username) that verified it.
pub fn decide(
    commit: &[u8],
    committer_email: Option<&str>,
    key_owners: &HashMap<String, String>,
    email_owners: &HashMap<String, (String, String)>,
) -> Signature {
    let Some(signed) = signed(commit) else {
        return Signature::Unsigned;
    };
    match check(&signed.armored, &signed.payload) {
        Checked::Invalid(reason) => Signature::Unverified { reason },
        Checked::Valid { fingerprint } => {
            let Some(key_owner) = key_owners.get(&fingerprint) else {
                return Signature::Unverified {
                    reason: format!("the key {fingerprint} is not registered on any g1t account."),
                };
            };
            let email = committer_email.unwrap_or_default().to_lowercase();
            match email_owners.get(&email) {
                Some((id, username)) if id == key_owner => Signature::Verified { signer: username.clone() },
                Some(_) => Signature::Unverified {
                    reason: format!("the key is not registered on the account that owns {email}."),
                },
                None => Signature::Unverified { reason: format!("{email} is not a verified email address on g1t.") },
            }
        }
    }
}

/// The fingerprint a valid SSH signature was made with, to look up its
/// owner; `None` for anything else.
pub fn fingerprint(commit: &[u8]) -> Option<String> {
    let signed = signed(commit)?;
    match check(&signed.armored, &signed.payload) {
        Checked::Valid { fingerprint } => Some(fingerprint),
        Checked::Invalid(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made with `ssh-keygen -Y sign -n git` and a throwaway ed25519 key.
    const PAYLOAD: &str = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Ada <ada@acme.com> 1759800000 +0000\ncommitter Ada <ada@acme.com> 1759800000 +0000\n\nAdd rules\n";
    const SIGNATURE: &str = "-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgtVGsjkmUevm9NOrwhStbNZ7Njn
RXkKOw20fds1RA0lwAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5
AAAAQHcrDRd94FoOk8mWAMZL9v2urJlYdG5OVKiwlbVcgFuc9qmOeP+8ivMA4duwWx0N8P
NP89FV6u51GZJ+01SZ5Ag=
-----END SSH SIGNATURE-----";
    const PUBLIC_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILVRrI5JlHr5vTTq8IUrWzWezY50V5CjsNtH3bNUQNJc";

    /// The commit as git writes it: the signature in a `gpgsig` header,
    /// each line after its first indented by a space.
    fn commit(message: &str) -> Vec<u8> {
        let (headers, _) = PAYLOAD.split_once("\n\n").unwrap();
        let sig = SIGNATURE.lines().collect::<Vec<_>>().join("\n ");
        format!("{headers}\ngpgsig {sig}\n\n{message}").into_bytes()
    }

    fn fingerprint_of_key() -> String {
        format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(STANDARD.decode(PUBLIC_KEY).unwrap())))
    }

    #[test]
    fn the_payload_is_the_commit_without_its_signature() {
        let found = signed(&commit("Add rules\n")).unwrap();
        assert_eq!(String::from_utf8(found.payload).unwrap(), PAYLOAD);
        assert!(found.armored.starts_with("-----BEGIN SSH SIGNATURE-----\nU1NIU0lH"));
        assert_eq!(signed(PAYLOAD.as_bytes()), None);
    }

    #[test]
    fn a_good_ed25519_signature_checks_out() {
        assert_eq!(
            check(SIGNATURE, PAYLOAD.as_bytes()),
            Checked::Valid { fingerprint: fingerprint_of_key() }
        );
        assert_eq!(fingerprint(&commit("Add rules\n")), Some(fingerprint_of_key()));
    }

    #[test]
    fn a_changed_commit_does_not() {
        assert_eq!(
            check(SIGNATURE, b"tree 0000\n\nSomething else\n"),
            Checked::Invalid("the signature does not match the commit.".into())
        );
        assert_eq!(fingerprint(&commit("Add rules, sneakily\n")), None);
    }

    #[test]
    fn gpg_and_unknown_formats_are_not_verified() {
        assert!(matches!(check("-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----", b"x"), Checked::Invalid(why) if why.starts_with("GPG signatures")));
        assert!(matches!(check("junk", b"x"), Checked::Invalid(_)));
        assert!(matches!(check("-----BEGIN SSH SIGNATURE-----\n!!!\n-----END SSH SIGNATURE-----", b"x"), Checked::Invalid(_)));
    }

    #[test]
    fn verified_means_the_key_belongs_to_whoever_owns_the_committer_address() {
        let commit = commit("Add rules\n");
        let mut keys = HashMap::new();
        let mut emails = HashMap::new();
        assert!(matches!(decide(&commit, Some("ada@acme.com"), &keys, &emails), Signature::Unverified { reason } if reason.contains("not registered")));
        keys.insert(fingerprint_of_key(), "usr_ada".to_owned());
        assert!(matches!(decide(&commit, Some("ada@acme.com"), &keys, &emails), Signature::Unverified { reason } if reason.contains("not a verified email")));
        emails.insert("ada@acme.com".to_owned(), ("usr_eve".to_owned(), "eve".to_owned()));
        assert!(matches!(decide(&commit, Some("Ada@acme.com"), &keys, &emails), Signature::Unverified { reason } if reason.contains("not registered on the account")));
        emails.insert("ada@acme.com".to_owned(), ("usr_ada".to_owned(), "ada".to_owned()));
        assert_eq!(decide(&commit, Some("ada@acme.com"), &keys, &emails), Signature::Verified { signer: "ada".into() });
        assert_eq!(decide(PAYLOAD.as_bytes(), Some("ada@acme.com"), &keys, &emails), Signature::Unsigned);
    }
}
