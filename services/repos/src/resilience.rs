//! What g1t does when the git store fails for a moment.
//!
//! - Errors are sorted ([`Failure`]): a rate limit, a failure that may pass
//!   (the store's `INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE`, a repository
//!   still being made, HTTP 5xx), and an answer that will not change
//!   (`NOT_FOUND`, `ALREADY_EXISTS`, bad input).
//! - Calls that only read, and minting credentials, are tried again with
//!   exponential backoff and jitter ([`backoff_ms`]). Pushes never are.
//! - Each namespace has a circuit breaker ([`Breaker`]), per isolate: after
//!   [`TRIP_AFTER`] failures in a row that may pass, calls are refused at
//!   once for [`COOL_MS`], then one probe is let through; it closes the
//!   breaker or opens it again.
//! - What reaches the caller says so ([`busy`]): git gets 429 or 503 with
//!   `Retry-After`; the site says the git store is busy.

use std::cell::RefCell;
use std::collections::HashMap;

/// How a failure is treated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The store refused for its rate limit.
    RateLimited,
    /// May pass if asked again.
    Transient,
    /// The same question gets the same answer.
    Permanent,
}

/// Sorts an error the binding threw, by its `code` and message.
pub fn classify(code: Option<&str>, message: &str) -> Failure {
    let lower = message.to_ascii_lowercase();
    if code == Some("RATE_LIMITED")
        || lower.contains("rate limit")
        || lower.contains("ratelimit")
        || lower.contains("too many requests")
        || lower.contains("status 429")
    {
        return Failure::RateLimited;
    }
    match code {
        Some("INTERNAL_ERROR" | "UPSTREAM_UNAVAILABLE" | "CREATE_IN_PROGRESS" | "IMPORT_IN_PROGRESS" | "FORK_IN_PROGRESS") => {
            Failure::Transient
        }
        Some(_) => Failure::Permanent,
        // No code: the call did not get an answer (a dropped connection, an
        // overloaded runtime), which may pass.
        None => Failure::Transient,
    }
}

/// Sorts an HTTP answer from the store's git server; `None` when it worked
/// or failed for good (401, 404, ...).
pub fn classify_status(status: u16) -> Option<Failure> {
    match status {
        429 => Some(Failure::RateLimited),
        500 | 502 | 503 | 504 => Some(Failure::Transient),
        _ => None,
    }
}

/// Attempts in all for a call that may be tried again.
pub const ATTEMPTS: u32 = 3;
const BASE_MS: u64 = 80;
const RATE_LIMITED_BASE_MS: u64 = 400;
const MAX_DELAY_MS: u64 = 2_000;

/// How long to wait before attempt `attempt + 1` (`attempt` from 0), with
/// `jitter` in [0, 1): half the exponential step, plus up to the other half
/// at random, so callers that failed together do not retry together.
pub fn backoff_ms(failure: Failure, attempt: u32, jitter: f64) -> u64 {
    let base = if failure == Failure::RateLimited { RATE_LIMITED_BASE_MS } else { BASE_MS };
    let step = base.saturating_mul(1 << attempt.min(10)).min(MAX_DELAY_MS);
    step / 2 + ((step / 2) as f64 * jitter.clamp(0.0, 1.0)) as u64
}

/// Whether to try again after `failure` on attempt `attempt` (from 0).
pub fn retry(failure: Failure, attempt: u32) -> bool {
    failure != Failure::Permanent && attempt + 1 < ATTEMPTS
}

/// Failures in a row that may pass before a namespace's breaker opens.
pub const TRIP_AFTER: u32 = 5;
/// How long an open breaker refuses calls before letting a probe through.
pub const COOL_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Closed { failures: u32 },
    Open { until: u64 },
    /// One probe is out; everything else waits for it.
    HalfOpen,
}

/// What a breaker says about a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admit {
    Go,
    /// The call is the probe: its outcome decides.
    Probe,
    /// Refused; try again in this many milliseconds.
    Wait(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Breaker {
    state: State,
    /// When the probe went out, so a probe that never reports does not hold
    /// the breaker half open for good.
    probe_at: u64,
}

impl Default for Breaker {
    fn default() -> Self {
        Breaker { state: State::Closed { failures: 0 }, probe_at: 0 }
    }
}

impl Breaker {
    pub fn admit(&mut self, now: u64) -> Admit {
        match self.state {
            State::Closed { .. } => Admit::Go,
            State::Open { until } if now < until => Admit::Wait(until - now),
            State::Open { .. } => {
                self.state = State::HalfOpen;
                self.probe_at = now;
                Admit::Probe
            }
            State::HalfOpen if now.saturating_sub(self.probe_at) > COOL_MS => {
                self.probe_at = now;
                Admit::Probe
            }
            State::HalfOpen => Admit::Wait(1_000),
        }
    }

    pub fn succeeded(&mut self) {
        self.state = State::Closed { failures: 0 };
    }

    /// Records a failure; only those that may pass count.
    pub fn failed(&mut self, failure: Failure, now: u64) {
        if failure == Failure::Permanent {
            // The store answered: it is up.
            self.succeeded();
            return;
        }
        self.state = match self.state {
            State::Closed { failures } if failures + 1 < TRIP_AFTER => State::Closed { failures: failures + 1 },
            _ => State::Open { until: now + COOL_MS },
        };
    }

    pub fn is_open(&self, now: u64) -> bool {
        matches!(self.state, State::Open { until } if now < until)
    }
}

thread_local! {
    static BREAKERS: RefCell<HashMap<String, Breaker>> = RefCell::new(HashMap::new());
}

/// The breaker of namespace `store`, in this isolate.
pub fn with_breaker<T>(store: &str, f: impl FnOnce(&mut Breaker) -> T) -> T {
    BREAKERS.with(|breakers| f(breakers.borrow_mut().entry(store.to_owned()).or_default()))
}

/// Whether namespace `store`'s breaker refuses calls in this isolate now.
pub fn open_now(store: &str, now: u64) -> bool {
    BREAKERS.with(|breakers| breakers.borrow().get(store).is_some_and(|breaker| breaker.is_open(now)))
}

/// What marks an error as the git store being busy, through every `?` and
/// `format!` it passes.
const BUSY: &str = "git-store-busy:";

/// The git store is busy: rate limited, unavailable after retries, or its
/// breaker open; or read-only for now, served from the fallback store
/// (fallback.rs). Seconds to wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Busy {
    pub rate_limited: bool,
    pub retry_after: u64,
    /// Reads work; writes wait until the store is back.
    pub read_only: bool,
}

/// How long a writer is told to wait while the store is read-only.
pub const READ_ONLY_RETRY_AFTER: u64 = 300;

impl Busy {
    /// Writes refused while the store is read-only.
    pub fn read_only() -> Self {
        Busy { rate_limited: false, retry_after: READ_ONLY_RETRY_AFTER, read_only: true }
    }

    pub fn error(self, detail: &str) -> worker::Error {
        let kind = if self.read_only {
            "read-only"
        } else if self.rate_limited {
            "rate-limited"
        } else {
            "unavailable"
        };
        worker::Error::RustError(format!("{BUSY}{kind}:{}: {detail}", self.retry_after))
    }

    /// The HTTP status for git: 429 for a rate limit, else 503.
    pub fn status(self) -> u16 {
        if self.rate_limited { 429 } else { 503 }
    }

    /// What people are told.
    pub fn message(self) -> String {
        if self.read_only {
            "g1t's git storage is read-only while it recovers: clones, fetches and pages work, and pushes, merges and new repositories wait until it is back. https://status.g1t.sh has the latest.\n".to_owned()
        } else if self.rate_limited {
            format!("g1t's git storage is handling more requests than it allows right now. Try again in {} seconds.\n", self.retry_after)
        } else {
            format!("g1t's git storage is not answering right now. Try again in {} seconds; https://status.g1t.sh has the latest.\n", self.retry_after)
        }
    }
}

/// The [`Busy`] an error carries, if it is one.
pub fn busy(message: &str) -> Option<Busy> {
    let at = message.find(BUSY)? + BUSY.len();
    let mut parts = message[at..].splitn(3, ':');
    let kind = parts.next()?;
    let retry_after = parts.next()?.trim().parse().ok()?;
    Some(Busy { rate_limited: kind == "rate-limited", retry_after, read_only: kind == "read-only" })
}

/// Seconds to tell a caller to wait, from milliseconds, at least one.
pub fn seconds(ms: u64) -> u64 {
    ms.div_ceil(1000).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_sorted_by_code_and_message() {
        assert_eq!(classify(Some("INTERNAL_ERROR"), "boom"), Failure::Transient);
        assert_eq!(classify(Some("UPSTREAM_UNAVAILABLE"), ""), Failure::Transient);
        assert_eq!(classify(Some("FORK_IN_PROGRESS"), ""), Failure::Transient);
        assert_eq!(classify(Some("NOT_FOUND"), ""), Failure::Permanent);
        assert_eq!(classify(Some("ALREADY_EXISTS"), ""), Failure::Permanent);
        assert_eq!(classify(Some("MEMORY_LIMIT"), ""), Failure::Permanent);
        assert_eq!(classify(None, "Network connection lost."), Failure::Transient);
        assert_eq!(classify(Some("INTERNAL_ERROR"), "Rate limit exceeded"), Failure::RateLimited);
        assert_eq!(classify(None, "Too Many Requests"), Failure::RateLimited);
        assert_eq!(classify_status(429), Some(Failure::RateLimited));
        assert_eq!(classify_status(503), Some(Failure::Transient));
        assert_eq!(classify_status(404), None);
        assert_eq!(classify_status(200), None);
    }

    #[test]
    fn backoff_grows_with_jitter_and_stops() {
        assert_eq!(backoff_ms(Failure::Transient, 0, 0.0), 40);
        assert_eq!(backoff_ms(Failure::Transient, 0, 0.999), 79);
        assert_eq!(backoff_ms(Failure::Transient, 1, 0.0), 80);
        assert_eq!(backoff_ms(Failure::Transient, 2, 0.5), 240);
        assert_eq!(backoff_ms(Failure::RateLimited, 0, 0.0), 200);
        assert!(backoff_ms(Failure::Transient, 30, 1.0) <= MAX_DELAY_MS);
        assert!(retry(Failure::Transient, 0) && retry(Failure::Transient, 1));
        assert!(!retry(Failure::Transient, ATTEMPTS - 1));
        assert!(!retry(Failure::Permanent, 0));
    }

    #[test]
    fn the_breaker_opens_after_failures_in_a_row_and_probes_after_a_rest() {
        let mut breaker = Breaker::default();
        for n in 0..TRIP_AFTER - 1 {
            breaker.failed(Failure::Transient, 1_000 + u64::from(n));
            assert_eq!(breaker.admit(1_000), Admit::Go);
        }
        // An answer that will not change is an answer: the count starts over.
        breaker.failed(Failure::Permanent, 1_000);
        for _ in 0..TRIP_AFTER - 1 {
            breaker.failed(Failure::RateLimited, 1_000);
        }
        assert_eq!(breaker.admit(1_000), Admit::Go);
        breaker.failed(Failure::Transient, 2_000);
        assert!(breaker.is_open(2_000));
        assert_eq!(breaker.admit(2_500), Admit::Wait(COOL_MS - 500));
        // After the rest, one probe; the rest wait for it.
        assert_eq!(breaker.admit(2_000 + COOL_MS), Admit::Probe);
        assert_eq!(breaker.admit(2_000 + COOL_MS + 1), Admit::Wait(1_000));
        // A failed probe opens it again.
        breaker.failed(Failure::Transient, 13_000);
        assert_eq!(breaker.admit(13_001), Admit::Wait(COOL_MS - 1));
        // A good one closes it.
        assert_eq!(breaker.admit(13_000 + COOL_MS), Admit::Probe);
        breaker.succeeded();
        assert_eq!(breaker.admit(13_000 + COOL_MS), Admit::Go);
        // A probe that never reported is replaced.
        let mut stuck = Breaker::default();
        for _ in 0..TRIP_AFTER {
            stuck.failed(Failure::Transient, 0);
        }
        assert_eq!(stuck.admit(COOL_MS), Admit::Probe);
        assert_eq!(stuck.admit(2 * COOL_MS + 1), Admit::Probe);
    }

    #[test]
    fn busy_survives_being_passed_along() {
        let busy_error = Busy { rate_limited: true, retry_after: 7, read_only: false }.error("log failed");
        let wrapped = format!("divergence failed: {busy_error}");
        assert_eq!(busy(&wrapped), Some(Busy { rate_limited: true, retry_after: 7, read_only: false }));
        // Read-only: writes wait, said so in words.
        let read_only = Busy::read_only();
        assert_eq!(busy(&format!("land: {}", read_only.error("push"))), Some(read_only));
        assert_eq!(read_only.status(), 503);
        assert!(read_only.message().contains("read-only"));
        let down = Busy { rate_limited: false, retry_after: 10, read_only: false };
        assert_eq!(busy(&down.error("x").to_string()), Some(down));
        assert_eq!(down.status(), 503);
        assert!(down.message().contains("10 seconds"));
        assert_eq!(busy("NOT_FOUND: no such repository"), None);
        assert_eq!(seconds(1), 1);
        assert_eq!(seconds(10_000), 10);
        assert_eq!(seconds(10_001), 11);
    }
}
