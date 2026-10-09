//! g1t-wide pauses (billing's `platform_pause`; docs/SPEND-GUARDRAILS.md),
//! read cheaply: one call to billing per isolate every 30 seconds at most,
//! never a database read per request.
//!
//! When billing cannot say, nothing is paused: a pause is a brake staff
//! (or billing's usage watcher) pull on purpose, and a billing outage must
//! not stop schedules and indexing everywhere. The failure is kept for the
//! same 30 seconds, so an outage is not asked about on every request.

use std::cell::RefCell;

use g1t_contracts::billing::{PauseLevel, PlatformPause};
use worker::Fetcher;

/// How long an answer is kept in the isolate.
pub const KEEP_MS: u64 = 30_000;

thread_local! {
    static KEPT: RefCell<Option<(PlatformPause, u64)>> = const { RefCell::new(None) };
}

/// A kept answer, while it is fresh.
fn fresh(kept: Option<(PlatformPause, u64)>, now: u64) -> Option<PlatformPause> {
    kept.filter(|(_, until)| *until > now).map(|(pause, _)| pause)
}

/// Whether `level` is paused, through the billing service's binding.
pub async fn paused(billing: &Fetcher, level: PauseLevel) -> bool {
    current(billing).await.is(level)
}

/// Every level, kept for `KEEP_MS`. Nothing paused when billing cannot say.
pub async fn current(billing: &Fetcher) -> PlatformPause {
    let now = crate::now_ms();
    if let Some(pause) = KEPT.with(|kept| fresh(*kept.borrow(), now)) {
        return pause;
    }
    let pause = match crate::call::<_, PlatformPause>(billing, "platform_pause", &serde_json::json!({})).await {
        Ok(pause) => pause,
        Err(error) => {
            worker::console_error!("platform pause unreadable, so nothing is paused: {error}");
            PlatformPause::default()
        }
    };
    KEPT.with(|kept| *kept.borrow_mut() = Some((pause, now + KEEP_MS)));
    pause
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_is_kept_thirty_seconds() {
        let paused = PlatformPause { schedules: true, ..PlatformPause::default() };
        assert_eq!(fresh(Some((paused, 1_000 + KEEP_MS)), 1_000), Some(paused));
        assert_eq!(fresh(Some((paused, 1_000 + KEEP_MS)), 1_000 + KEEP_MS), None);
        assert_eq!(fresh(None, 0), None);
    }

    #[test]
    fn an_unread_pause_pauses_nothing() {
        let none = PlatformPause::default();
        assert!(PauseLevel::ALL.into_iter().all(|level| !none.is(level)));
        assert!(!none.any());
    }
}
