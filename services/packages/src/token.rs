//! The registry's bearer tokens, and the credentials they are given for.
//!
//! `docker login` sends Basic credentials to `GET /v2/token` (any
//! username, a g1t token as the password) and gets back a short-lived
//! token naming what it may do to which images, signed with
//! PACKAGES_TOKEN_SECRET. Every later request carries that token, so
//! nothing is asked of identity again until it expires. A token is
//! `r1.<claims>.<signature>`: base64url JSON, then base64url HMAC-SHA256
//! over `r1.<claims>`.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use g1t_contracts::audit::AuditActor;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};

use crate::access::Action;

type HmacSha256 = Hmac<sha2::Sha256>;

const PREFIX: &str = "r1";
/// How long a token lasts. Clients ask again when it runs out.
pub const TTL_SECONDS: u64 = 15 * 60;

/// What a token lets its holder do to one image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// `workspace/name`.
    pub name: String,
    pub actions: Vec<Action>,
}

/// What a token says.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Claims {
    /// Who it was given to, as audit entries name them; absent for an
    /// anonymous one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<AuditActor>,
    pub access: Vec<Grant>,
    /// Seconds since the epoch.
    pub iat: u64,
    pub exp: u64,
}

impl Claims {
    pub fn allows(&self, name: &str, action: Action) -> bool {
        self.access
            .iter()
            .any(|grant| grant.name == name && grant.actions.contains(&action))
    }
}

fn mac(secret: &[u8]) -> HmacSha256 {
    HmacSha256::new_from_slice(secret).expect("HMAC takes a key of any length")
}

pub fn sign(claims: &Claims, secret: &[u8]) -> String {
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default());
    let signed = format!("{PREFIX}.{body}");
    let mut mac = mac(secret);
    mac.update(signed.as_bytes());
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

/// The claims of a token this registry signed and that has not expired.
pub fn verify(token: &str, secret: &[u8], now_seconds: u64) -> Option<Claims> {
    let (signed, signature) = token.rsplit_once('.')?;
    let body = signed.strip_prefix(PREFIX)?.strip_prefix('.')?;
    let mut mac = mac(secret);
    mac.update(signed.as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?).ok()?;
    let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
    (claims.exp > now_seconds).then_some(claims)
}

/// Whether `token` looks like one of this registry's, rather than a g1t
/// access token sent as a bearer token.
pub fn is_registry_token(token: &str) -> bool {
    token.starts_with("r1.")
}

/// One `scope` a client asks a token for: `repository:<name>:<actions>`.
/// Other resource types (`registry:catalog:*`) are left out.
pub fn parse_scope(scope: &str) -> Option<(String, Vec<Action>)> {
    let rest = scope.strip_prefix("repository:")?;
    let (name, actions) = rest.rsplit_once(':')?;
    let mut wanted: Vec<Action> = Vec::new();
    for action in actions.split(',') {
        let more: &[Action] = match action.trim() {
            "pull" => &[Action::Pull],
            "push" => &[Action::Push],
            "delete" => &[Action::Delete],
            "*" => &[Action::Pull, Action::Push, Action::Delete],
            _ => &[],
        };
        for action in more {
            if !wanted.contains(action) {
                wanted.push(*action);
            }
        }
    }
    (!name.is_empty() && !wanted.is_empty()).then(|| (name.to_owned(), wanted))
}

/// The username and secret of an HTTP Basic `Authorization` header.
pub fn basic(header: &str) -> Option<(String, String)> {
    let (scheme, encoded) = header.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = String::from_utf8(STANDARD.decode(encoded.trim()).ok()?).ok()?;
    let (username, secret) = decoded.split_once(':')?;
    Some((username.to_owned(), secret.to_owned()))
}

/// The token of a `Bearer` `Authorization` header.
pub fn bearer(header: &str) -> Option<&str> {
    let (scheme, token) = header.trim().split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(exp: u64) -> Claims {
        Claims {
            actor: Some(AuditActor { actor: "ana".into(), actor_id: "usr_1".into(), ..AuditActor::default() }),
            access: vec![Grant { name: "acme/web".into(), actions: vec![Action::Pull, Action::Push] }],
            iat: 100,
            exp,
        }
    }

    #[test]
    fn a_signed_token_reads_back_until_it_expires() {
        let token = sign(&claims(1000), b"secret");
        assert!(is_registry_token(&token));
        let read = verify(&token, b"secret", 999).expect("valid");
        assert_eq!(read, claims(1000));
        assert!(read.allows("acme/web", Action::Push));
        assert!(!read.allows("acme/web", Action::Delete));
        assert!(!read.allows("acme/other", Action::Pull));
        assert!(verify(&token, b"secret", 1000).is_none(), "expired");
        assert!(verify(&token, b"other", 999).is_none(), "another key");
    }

    #[test]
    fn a_changed_token_is_refused() {
        let token = sign(&claims(1000), b"secret");
        let (signed, signature) = token.rsplit_once('.').unwrap();
        let mut forged = claims(1000);
        forged.access[0].actions.push(Action::Delete);
        let forged_body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
        assert!(verify(&format!("r1.{forged_body}.{signature}"), b"secret", 0).is_none());
        assert!(verify(&format!("{signed}.AAAA"), b"secret", 0).is_none());
        assert!(verify("g1t_abc", b"secret", 0).is_none());
        assert!(verify("", b"secret", 0).is_none());
    }

    #[test]
    fn scopes_are_read_as_docker_writes_them() {
        assert_eq!(
            parse_scope("repository:acme/web/api:pull,push"),
            Some(("acme/web/api".into(), vec![Action::Pull, Action::Push]))
        );
        assert_eq!(
            parse_scope("repository:acme/web:*"),
            Some(("acme/web".into(), vec![Action::Pull, Action::Push, Action::Delete]))
        );
        assert_eq!(parse_scope("repository:acme/web:pull,pull"), Some(("acme/web".into(), vec![Action::Pull])));
        assert_eq!(parse_scope("registry:catalog:*"), None);
        assert_eq!(parse_scope("repository:acme/web:unknown"), None);
    }

    #[test]
    fn credentials_are_read_from_either_scheme() {
        let header = format!("Basic {}", STANDARD.encode("ana:g1t_secret:with:colons"));
        assert_eq!(basic(&header), Some(("ana".into(), "g1t_secret:with:colons".into())));
        assert_eq!(basic("Bearer abc"), None);
        assert_eq!(basic("Basic !!!"), None);
        assert_eq!(bearer("Bearer r1.abc.def"), Some("r1.abc.def"));
        assert_eq!(bearer("bearer  g1t_x "), Some("g1t_x"));
        assert_eq!(bearer("Basic abc"), None);
    }
}
