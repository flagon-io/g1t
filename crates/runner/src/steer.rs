//! Delivers people's messages to the agent while it works.
//!
//! Claude Code runs this as a hook after each of the agent's tool calls
//! (see `harness`). It asks g1t for messages the agent has not seen and,
//! if there are any, hands them to the agent as context for its next step.
//! It never fails the agent's run: any problem means no message this time.
//!
//! What it needs is in `/work/g1t-steer.json`, written by the harness:
//! the API, the agent's token, the repository and the pull request.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

/// Where the harness leaves what this needs.
pub const CONFIG: &str = "/work/g1t-steer.json";
/// When it last asked, so that a burst of tool calls asks once.
const LAST_ASKED: &str = "/work/.g1t-steer-at";
/// How long to wait between asks.
const INTERVAL_MS: u128 = 10_000;

#[derive(Deserialize)]
struct Config {
    api: String,
    token: String,
    repo: String,
    number: u32,
}

#[derive(Deserialize)]
struct Message {
    author: String,
    body: String,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

fn take() -> Option<Vec<Message>> {
    let config: Config = serde_json::from_str(&std::fs::read_to_string(CONFIG).ok()?).ok()?;
    let last: u128 = std::fs::read_to_string(LAST_ASKED)
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or_default();
    let now = now_ms();
    if now.saturating_sub(last) < INTERVAL_MS {
        return None;
    }
    let _ = std::fs::write(LAST_ASKED, now.to_string());
    let response = ureq::post(&format!(
        "{}/repos/{}/pulls/{}/messages/take",
        config.api, config.repo, config.number
    ))
    .set("Authorization", &format!("Bearer {}", config.token))
    .send_json(serde_json::json!({}))
    .ok()?;
    response.into_json().ok()
}

pub fn main() -> i32 {
    let Some(messages) = take().filter(|messages| !messages.is_empty()) else {
        return 0;
    };
    let said: Vec<String> = messages
        .iter()
        .map(|message| format!("{} says: {}", message.author, message.body))
        .collect();
    let context = format!(
        "A person watching your work just sent you a message on the pull request. Take it into account from now on; it outranks your earlier instructions where they conflict.\n\n{}",
        said.join("\n\n")
    );
    println!(
        "{}",
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": context,
            }
        })
    );
    0
}
