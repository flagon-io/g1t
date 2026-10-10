//! Rate limits: Workers Rate Limiting bindings, asked once per request with
//! a key (a client's address, a repository's id, a hash of a token).
//!
//! Every binding, its namespace id and its limit is listed in `RATE_LIMITS`
//! (packages/contracts/src/rate-limits.ts), which apps/web's tests check
//! each wrangler.jsonc against; CONTRIBUTING.md ("Rate limits") says how
//! to change one.
//!
//! A limit fails open: a binding that is not there (self-hosted) or that
//! fails lets the request through. A limit guards against floods; it is
//! never a reason for g1t to stop answering.

use worker::Env;

/// Every limit's window, in seconds, and how long a client past one is
/// told to wait (`Retry-After`). Workers Rate Limiting counts over 10 or 60.
pub const PERIOD_SECONDS: u32 = 60;

/// What asking a limit said. Only `Limited` refuses the request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allowed,
    Limited,
    /// No binding, or it failed: let through.
    Unavailable,
}

impl Verdict {
    pub fn limited(self) -> bool {
        self == Verdict::Limited
    }
}

/// The verdict from what the binding answered: `None` when there is no
/// binding, `Some(Err)` when asking it failed, else whether it let the
/// request through.
pub fn verdict<E>(answered: Option<std::result::Result<bool, E>>) -> Verdict {
    match answered {
        Some(Ok(true)) => Verdict::Allowed,
        Some(Ok(false)) => Verdict::Limited,
        Some(Err(_)) | None => Verdict::Unavailable,
    }
}

/// Counts one request against the binding named `binding` under `key`.
/// Never fails; a failure to ask is logged and lets the request through.
pub async fn check(env: &Env, binding: &str, key: String) -> Verdict {
    let Ok(limiter) = env.rate_limiter(binding) else {
        return Verdict::Unavailable;
    };
    let answered = limiter.limit(key).await.map(|outcome| outcome.success);
    if let Err(problem) = &answered {
        worker::console_error!("rate limit {binding} could not be asked: {problem}");
    }
    verdict(Some(answered))
}

/// A client's address for a key: `ip:` and `CF-Connecting-IP`, or
/// `ip:unknown` when there is none (local development).
pub fn address_key(address: Option<&str>) -> String {
    format!("ip:{}", address.map(str::trim).filter(|a| !a.is_empty()).unwrap_or("unknown"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_limit_the_binding_says_is_reached_refuses() {
        assert_eq!(verdict::<()>(Some(Ok(true))), Verdict::Allowed);
        assert_eq!(verdict::<()>(Some(Ok(false))), Verdict::Limited);
        assert!(verdict::<()>(Some(Ok(false))).limited());
    }

    #[test]
    fn no_binding_or_a_failing_one_lets_requests_through() {
        assert_eq!(verdict::<()>(None), Verdict::Unavailable);
        assert_eq!(verdict(Some(Err("binding threw"))), Verdict::Unavailable);
        assert!(!verdict::<()>(None).limited());
        assert!(!verdict(Some(Err("binding threw"))).limited());
    }

    #[test]
    fn addresses_are_keyed_as_given_or_unknown() {
        assert_eq!(address_key(Some(" 203.0.113.9 ")), "ip:203.0.113.9");
        assert_eq!(address_key(Some("")), "ip:unknown");
        assert_eq!(address_key(None), "ip:unknown");
    }
}
