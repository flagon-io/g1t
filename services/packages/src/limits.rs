//! How often a client may pull and ask for tokens.
//!
//! Anonymous requests are limited by the address they come from
//! (`CF-Connecting-IP`), signed-in ones by who they are, with a much higher
//! limit. Both are Workers Rate Limiting bindings, ANONYMOUS_LIMIT and
//! SIGNED_LIMIT; without them (self-hosted) nothing is limited. Pushes are
//! not limited here: they need an account, and the store's own limits
//! apply.

use worker::Method;

use crate::names::Route;

/// Which limit a request counts against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Anonymous,
    Signed,
}

impl Limit {
    pub fn binding(self) -> &'static str {
        match self {
            Limit::Anonymous => "ANONYMOUS_LIMIT",
            Limit::Signed => "SIGNED_LIMIT",
        }
    }
}

/// How long a client limited is told to wait: the limits' period.
pub const RETRY_AFTER_SECONDS: u32 = 60;

/// Whether a request counts: pulls (reads of any kind) and asking for a
/// token, which is also where a wrong password is tried again and again.
pub fn counts(method: &Method, route: &Route) -> bool {
    matches!(route, Route::Token) || matches!(method, Method::Get | Method::Head)
}

/// The limit a request counts against and its key there. `subject` is who
/// the credentials name (a person's, workspace's or agent's id), absent
/// for anonymous requests and for credentials that turned out wrong, which
/// count as anonymous so guessing is limited by address.
pub fn key(subject: Option<&str>, address: Option<&str>) -> (Limit, String) {
    match subject.filter(|s| !s.is_empty()) {
        Some(subject) => (Limit::Signed, format!("sub:{subject}")),
        None => (Limit::Anonymous, format!("ip:{}", address.map(str::trim).filter(|a| !a.is_empty()).unwrap_or("unknown"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulls_and_tokens_count_and_pushes_do_not() {
        let manifest = Route::Manifest { name: "acme/web".into(), reference: "v1".into() };
        assert!(counts(&Method::Get, &manifest));
        assert!(counts(&Method::Head, &Route::Blob { name: "acme/web".into(), digest: "d".into() }));
        assert!(counts(&Method::Get, &Route::Base));
        assert!(counts(&Method::Post, &Route::Token), "docker's OAuth form");
        assert!(!counts(&Method::Put, &manifest));
        assert!(!counts(&Method::Patch, &Route::Upload { name: "acme/web".into(), id: "u".into() }));
        assert!(!counts(&Method::Delete, &manifest));
    }

    #[test]
    fn anonymous_clients_are_counted_by_address_and_others_by_who_they_are() {
        assert_eq!(key(None, Some("203.0.113.9")), (Limit::Anonymous, "ip:203.0.113.9".to_owned()));
        assert_eq!(key(None, None), (Limit::Anonymous, "ip:unknown".to_owned()));
        assert_eq!(key(Some(""), Some("2001:db8::1")), (Limit::Anonymous, "ip:2001:db8::1".to_owned()));
        assert_eq!(key(Some("usr_1"), Some("203.0.113.9")), (Limit::Signed, "sub:usr_1".to_owned()));
        assert_eq!(Limit::Anonymous.binding(), "ANONYMOUS_LIMIT");
        assert_eq!(Limit::Signed.binding(), "SIGNED_LIMIT");
    }
}
