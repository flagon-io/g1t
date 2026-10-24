//! `list_events`: a repository's timeline, and following it.
//!
//! Without `after` it is the timeline, newest first, paged back with
//! `before`. With `after` (an event id) it is what the log wrote after that
//! event, oldest first, and the last event's id is the cursor for the next
//! call. With `after` and `wait`, a call that finds nothing holds on until
//! something matching is written or `wait` seconds pass, asking the events
//! service about once a second, so an agent with no public address can
//! follow a repository with one request at a time instead of a webhook.
//!
//! Holding a request costs a Worker wall time, not CPU time: between polls
//! it awaits a timer, which is not billed or limited as CPU. Each poll is
//! one subrequest, so a call makes at most `MAX_WAIT_SECONDS` + 1 of them,
//! well under the per-request limit, and the hold stays far below the time
//! clients and proxies give an idle response.

use g1t_contracts::events::{Event, ListArgs};
use serde_json::Value;
use worker::{Fetcher, Result};

/// The longest a call holds on, in seconds.
pub const MAX_WAIT_SECONDS: u64 = 25;
/// How often a held call asks again.
const POLL_MS: u64 = 1_000;
/// The most events one call returns; the events service's own page.
const MAX_LIMIT: u32 = 200;

/// What a `list_events` call asks for, read from its input.
#[derive(Debug, Default, PartialEq)]
pub struct Asked {
    pub after: Option<String>,
    pub before: Option<String>,
    pub types: Vec<String>,
    pub numbers: Vec<u32>,
    pub since: Option<String>,
    pub limit: Option<u32>,
    /// Milliseconds to hold on; zero without `after`.
    pub wait_ms: u64,
}

/// A list given as an array or as one comma-separated string.
fn list(value: &Value) -> Vec<String> {
    let items: Vec<String> = match value {
        Value::String(text) => text.split(',').map(str::to_owned).collect(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect(),
        Value::Number(number) => vec![number.to_string()],
        _ => Vec::new(),
    };
    items.into_iter().map(|item| item.trim().trim_start_matches('#').to_owned()).filter(|item| !item.is_empty()).collect()
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

fn whole(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64().or_else(|| number.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64)),
        Value::String(digits) => digits.trim().parse().ok(),
        _ => None,
    }
}

/// Reads a call's input, or says what is wrong with it.
pub fn asked(input: &Value) -> std::result::Result<Asked, String> {
    let mut numbers = Vec::new();
    for item in list(&input["numbers"]) {
        match item.parse::<u32>() {
            Ok(number) if number > 0 => numbers.push(number),
            _ => return Err(format!("numbers are work item and pull request numbers, and {item} is not one.")),
        }
    }
    numbers.sort_unstable();
    numbers.dedup();
    let mut types = list(&input["types"]);
    types.sort();
    types.dedup();
    let limit = match &input["limit"] {
        Value::Null => None,
        value => match whole(value) {
            Some(limit) if limit > 0 => Some(u32::try_from(limit).unwrap_or(MAX_LIMIT).min(MAX_LIMIT)),
            _ => return Err("limit is a whole number from 1 to 200.".to_owned()),
        },
    };
    let after = text(input, "after");
    let wait = match &input["wait"] {
        Value::Null => 0,
        value => match whole(value) {
            Some(seconds) => seconds.min(MAX_WAIT_SECONDS),
            None => return Err(format!("wait is a number of seconds, at most {MAX_WAIT_SECONDS}.")),
        },
    };
    let before = text(input, "before");
    if after.is_some() && before.is_some() {
        return Err("Give after to follow the timeline or before to page back through it, not both.".to_owned());
    }
    Ok(Asked { wait_ms: if after.is_some() { wait * 1_000 } else { 0 }, after, before, types, numbers, since: text(input, "since"), limit })
}

impl Asked {
    fn args(&self, repo_id: &str) -> ListArgs {
        ListArgs {
            repo_id: Some(repo_id.to_owned()),
            types: self.types.clone(),
            before: self.before.clone(),
            after: self.after.clone(),
            numbers: self.numbers.clone(),
            since: self.since.clone(),
            limit: self.limit,
            ..ListArgs::default()
        }
    }
}

/// How long to sleep before asking again, at `now`, for a call that holds
/// on until `deadline`: `None` when it is time to answer with nothing.
/// The last poll falls on the deadline itself.
pub fn next_poll(now: u64, deadline: u64) -> Option<u64> {
    if now >= deadline { None } else { Some(POLL_MS.min(deadline - now)) }
}

/// The events of the repository `repo_id` as asked, holding on for them
/// when asked to.
pub async fn list_events(events: &Fetcher, repo_id: &str, asked: &Asked) -> Result<Vec<Event>> {
    let args = asked.args(repo_id);
    let deadline = g1t_kit::now_ms() + asked.wait_ms;
    loop {
        let found: Vec<Event> = g1t_kit::call(events, "list", &args).await?;
        if !found.is_empty() {
            return Ok(found);
        }
        match next_poll(g1t_kit::now_ms(), deadline) {
            Some(ms) => worker::Delay::from(std::time::Duration::from_millis(ms)).await,
            None => return Ok(found),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_come_as_commas_or_arrays() {
        let a = asked(&json!({
            "types": "work.claimed, integration.failed,,work.claimed",
            "numbers": "12,#7, 12",
        }))
        .unwrap();
        assert_eq!(a.types, vec!["integration.failed", "work.claimed"]);
        assert_eq!(a.numbers, vec![7, 12]);
        let b = asked(&json!({ "types": ["push"], "numbers": [3, "4"] })).unwrap();
        assert_eq!(b.types, vec!["push"]);
        assert_eq!(b.numbers, vec![3, 4]);
        assert!(asked(&json!({ "numbers": "seven" })).is_err());
        assert!(asked(&json!({ "numbers": [0] })).is_err());
    }

    #[test]
    fn wait_holds_only_a_follow_and_never_past_25_seconds() {
        assert_eq!(asked(&json!({ "wait": 10 })).unwrap().wait_ms, 0, "nothing to wait for without after");
        assert_eq!(asked(&json!({ "after": "evt_1", "wait": "10" })).unwrap().wait_ms, 10_000);
        assert_eq!(asked(&json!({ "after": "evt_1", "wait": 600 })).unwrap().wait_ms, 25_000);
        assert_eq!(asked(&json!({ "after": "evt_1" })).unwrap().wait_ms, 0);
        assert!(asked(&json!({ "after": "evt_1", "wait": "soon" })).is_err());
        assert!(asked(&json!({ "after": "evt_1", "wait": -1 })).is_err());
    }

    #[test]
    fn limits_are_kept_to_a_page() {
        assert_eq!(asked(&json!({ "limit": "500" })).unwrap().limit, Some(200));
        assert_eq!(asked(&json!({ "limit": 20 })).unwrap().limit, Some(20));
        assert_eq!(asked(&json!({})).unwrap().limit, None);
        assert!(asked(&json!({ "limit": 0 })).is_err());
    }

    #[test]
    fn after_and_before_do_not_mix() {
        assert!(asked(&json!({ "after": "evt_2", "before": "evt_1" })).is_err());
        let a = asked(&json!({ "after": "evt_2", "since": "2026-10-12T00:00:00Z" })).unwrap();
        let args = a.args("rep_1");
        assert_eq!(args.after.as_deref(), Some("evt_2"));
        assert_eq!(args.since.as_deref(), Some("2026-10-12T00:00:00Z"));
        assert_eq!(args.repo_id.as_deref(), Some("rep_1"));
    }

    #[test]
    fn polls_come_about_once_a_second_and_the_last_on_the_deadline() {
        let start = 1_000_000;
        let deadline = start + 25_000;
        let mut now = start;
        let mut polls = 1; // the first, before any sleep
        while let Some(ms) = next_poll(now, deadline) {
            assert!(ms > 0 && ms <= 1_000);
            now += ms;
            polls += 1;
        }
        assert_eq!(now, deadline);
        assert_eq!(polls, 26, "one call makes at most 26 polls");
        assert_eq!(next_poll(5, 5), None);
        assert_eq!(next_poll(5, 4), None, "a slow poll past the deadline answers");
        assert_eq!(next_poll(0, 300), Some(300));
    }
}
