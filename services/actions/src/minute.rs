//! What drives the sweep every minute: a Durable Object's alarm, not the
//! cron trigger.
//!
//! Cloudflare's cron trigger skipped or delayed about one minute in six
//! for this Worker (#466): in the 24 hours to 2026-10-23 19:10 UTC, 234 of
//! 1440 minutes never had an invocation, 183 invocations started over two
//! minutes after the minute they were for (up to five hours), and 36
//! minutes were delivered twice. An unrelated minute cron (apps/status)
//! showed the same, while the sweep's own work took a few seconds of each.
//!
//! So the cron only arms [`Minute`]'s alarm, which sets the next one
//! before it sweeps: a sweep that fails or runs long cannot lose the next,
//! and alarms never overlap. The object keeps the last minute it swept,
//! and runs the schedules of minutes a late alarm passed over
//! ([`minutes_due`]). A self-hosted g1t binds no Durable Objects, and its
//! actions cron does not run (deploy/self-host/configs.mjs); without the
//! binding the cron sweeps by itself, as it did before.

use crate::Actions;
use worker::{DurableObject, Env, Request, Response, Result, State, durable_object, wasm_bindgen};

/// The binding of [`Minute`], in wrangler.jsonc.
pub const BINDING: &str = "MINUTE";
/// The one object that sweeps.
const NAME: &str = "sweep";
/// Next to the database (D1 `g1t-actions` runs in WNAM): a sweep makes
/// many queries in turn.
const LOCATION: &str = "wnam";
/// How far past the minute the alarm rings.
pub const OFFSET_MS: u64 = 1_000;
/// The most minutes of schedules a late sweep runs after the fact. Past
/// that, they are skipped, as a pause skips them.
pub const CATCH_UP_MINUTES: u64 = 10;
/// Where the object keeps the last minute it swept.
const LAST: &str = "last_minute";

/// When the alarm rings next: [`OFFSET_MS`] into the minute after `now_ms`.
pub fn next_alarm_ms(now_ms: u64) -> u64 {
    (now_ms.saturating_sub(OFFSET_MS) / 60_000 + 1) * 60_000 + OFFSET_MS
}

/// The minutes whose schedules a sweep at `now_ms` runs, oldest first: its
/// own, and those since `last` that no sweep ran, at most
/// [`CATCH_UP_MINUTES`] of them. None when its own minute was swept already.
pub fn minutes_due(last: Option<u64>, now_ms: u64) -> Vec<u64> {
    let minute = now_ms / 60_000 * 60_000;
    let from = match last {
        Some(last) if last >= minute => return Vec::new(),
        Some(last) => (last + 60_000).max(minute.saturating_sub((CATCH_UP_MINUTES - 1) * 60_000)),
        None => minute,
    };
    (from..=minute).step_by(60_000).collect()
}

#[durable_object]
pub struct Minute {
    state: State,
    env: Env,
}

impl DurableObject for Minute {
    fn new(state: State, env: Env) -> Self {
        Minute { state, env }
    }

    /// From the cron: arms the alarm if it is not set.
    async fn fetch(&self, _request: Request) -> Result<Response> {
        let storage = self.state.storage();
        if storage.get_alarm().await?.is_none() {
            let at = next_alarm_ms(g1t_kit::now_ms());
            storage.set_alarm(worker::ScheduledTime::new(js_sys_date(at))).await?;
            worker::console_log!("actions: the minute's alarm was not set; it rings at {}", g1t_contracts::time::rfc3339(at));
        }
        Response::ok("armed")
    }

    async fn alarm(&self) -> Result<Response> {
        let now = g1t_kit::now_ms();
        let storage = self.state.storage();
        // The next one first, so nothing below can lose it.
        storage.set_alarm(worker::ScheduledTime::new(js_sys_date(next_alarm_ms(now)))).await?;
        let last = storage.get::<u64>(LAST).await.ok().flatten();
        let minutes = minutes_due(last, now);
        if let Some(&latest) = minutes.last() {
            storage.put(LAST, latest).await?;
        }
        sweep(&self.env, now, &minutes).await;
        Response::ok("swept")
    }
}

fn js_sys_date(ms: u64) -> worker::js_sys::Date {
    worker::js_sys::Date::new(&worker::wasm_bindgen::JsValue::from_f64(ms as f64))
}

/// One sweep, and its line in the log.
pub async fn sweep(env: &Env, now_ms: u64, minutes: &[u64]) {
    match Actions::new(env) {
        Ok(service) => match service.on_minute(now_ms, minutes).await {
            Ok(report) => worker::console_log!("{}", report.line(now_ms, g1t_kit::now_ms())),
            Err(error) => {
                worker::console_error!("actions: the sweep failed after {} ms: {error}", g1t_kit::now_ms().saturating_sub(now_ms))
            }
        },
        Err(error) => worker::console_error!("actions: could not start: {error}"),
    }
}

/// The cron's part: arm the alarm, or, with no binding, sweep this minute.
pub async fn on_cron(env: &Env, scheduled_ms: u64) {
    let Ok(namespace) = env.durable_object(BINDING) else {
        let now = g1t_kit::now_ms();
        sweep(env, now, &minutes_due(None, now)).await;
        return;
    };
    let late = g1t_kit::now_ms().saturating_sub(scheduled_ms);
    let armed = match namespace.get_by_name_with_location_hint(NAME, LOCATION) {
        Ok(stub) => stub.fetch_with_str("https://minute/arm").await.map(|_| ()),
        Err(error) => Err(error),
    };
    if let Err(error) = armed {
        worker::console_error!("actions: could not arm the minute's alarm ({late} ms after its cron): {error}");
    }
}

/// What a sweep did, for its one line in the log: a gap or a slow pass
/// shows there.
#[derive(Debug, Default)]
pub struct Report {
    /// The minutes whose schedules it ran.
    pub minutes: Vec<u64>,
    /// Jobs in progress it looked at.
    pub running: usize,
    /// Of those, put back in the queue after a lost start or machine.
    pub requeued: usize,
    /// Of those, ended: cancelled past grace, over time, or silent.
    pub ended: usize,
    /// Runs waiting in a concurrency group it moved along.
    pub held: usize,
    /// How long each part took, in ms, in the order they ran.
    pub parts: Vec<(&'static str, u64)>,
}

impl Report {
    /// Times `part` from `since_ms`, and returns now for the next one.
    pub fn took(&mut self, part: &'static str, since_ms: u64) -> u64 {
        let now = g1t_kit::now_ms();
        self.parts.push((part, now.saturating_sub(since_ms)));
        now
    }

    pub fn line(&self, started_ms: u64, ended_ms: u64) -> String {
        let minute = |ms: u64| g1t_contracts::time::rfc3339(ms).get(11..16).unwrap_or_default().to_owned();
        let schedules = match self.minutes.as_slice() {
            [] => "none (already swept)".to_owned(),
            [one] => minute(*one),
            [first, .., last] => format!("{}-{} ({} caught up)", minute(*first), minute(*last), self.minutes.len() - 1),
        };
        let parts: Vec<String> = self.parts.iter().map(|(part, ms)| format!("{part} {ms}")).collect();
        format!(
            "actions: swept in {} ms, {} ms after the minute; schedules {schedules}; {} running, {} requeued, {} ended, {} held runs; ms: {}",
            ended_ms.saturating_sub(started_ms),
            started_ms % 60_000,
            self.running,
            self.requeued,
            self.ended,
            self.held,
            parts.join(", "),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: u64 = 1_792_782_600_000; // 2026-10-23T19:10:00Z

    #[test]
    fn the_alarm_rings_just_past_the_next_minute() {
        assert_eq!(next_alarm_ms(MINUTE), MINUTE + OFFSET_MS);
        assert_eq!(next_alarm_ms(MINUTE + OFFSET_MS), MINUTE + 60_000 + OFFSET_MS);
        assert_eq!(next_alarm_ms(MINUTE + 30_000), MINUTE + 60_000 + OFFSET_MS);
        // A sweep that took longer than a minute: the next minute, not one
        // already past.
        assert_eq!(next_alarm_ms(MINUTE + 95_000), MINUTE + 120_000 + OFFSET_MS);
    }

    #[test]
    fn a_sweep_runs_its_own_minutes_schedules_once() {
        assert_eq!(minutes_due(None, MINUTE + 1_000), vec![MINUTE]);
        assert_eq!(minutes_due(Some(MINUTE - 60_000), MINUTE + 1_000), vec![MINUTE]);
        // An alarm tried again within the minute.
        assert_eq!(minutes_due(Some(MINUTE), MINUTE + 40_000), Vec::<u64>::new());
    }

    #[test]
    fn a_late_sweep_runs_the_schedules_it_passed_over() {
        let minutes = minutes_due(Some(MINUTE - 3 * 60_000), MINUTE + 1_000);
        assert_eq!(minutes, vec![MINUTE - 120_000, MINUTE - 60_000, MINUTE]);
        // Only so far back.
        let minutes = minutes_due(Some(MINUTE - 60 * 60_000), MINUTE + 1_000);
        assert_eq!(minutes.len() as u64, CATCH_UP_MINUTES);
        assert_eq!(minutes.first(), Some(&(MINUTE - (CATCH_UP_MINUTES - 1) * 60_000)));
        assert_eq!(minutes.last(), Some(&MINUTE));
    }

    #[test]
    fn a_sweep_says_in_one_line_what_it_did_and_how_long_each_part_took() {
        let report = Report {
            minutes: vec![MINUTE - 120_000, MINUTE - 60_000, MINUTE],
            running: 7,
            requeued: 2,
            ended: 1,
            held: 0,
            parts: vec![("syncs", 40), ("schedules", 300), ("running", 2_100), ("starts", 900)],
        };
        assert_eq!(
            report.line(MINUTE + 1_200, MINUTE + 4_700),
            "actions: swept in 3500 ms, 1200 ms after the minute; schedules 19:08-19:10 (2 caught up); 7 running, 2 requeued, 1 ended, 0 held runs; ms: syncs 40, schedules 300, running 2100, starts 900"
        );
        let report = Report { minutes: vec![MINUTE], ..Report::default() };
        assert!(report.line(MINUTE, MINUTE).contains("schedules 19:10;"));
        assert!(Report::default().line(MINUTE, MINUTE).contains("schedules none (already swept);"));
    }
}
