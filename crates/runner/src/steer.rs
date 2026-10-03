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
const INTERVAL_MS: u128 = 5_000;

#[derive(Deserialize)]
struct Config {
    api: String,
    token: String,
    repo: String,
    number: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: String,
    author: String,
    body: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    from_number: Option<u32>,
}

/// One message as the agent should read it, with how to reply where it can.
fn told(message: &Message) -> String {
    let from = message
        .from_number
        .map_or_else(|| message.author.clone(), |number| format!("The agent on #{number}"));
    match message.kind.as_str() {
        "question" => format!(
            "{from} asks you (message {}): {}\nAnswer it with the answer_message tool and that id.",
            message.id, message.body
        ),
        "handoff" => format!(
            "{from} hands you work that belongs in your pull request (message {}): {}\nTake it on, or decline it if it is not yours, with the answer_message tool and that id.",
            message.id, message.body
        ),
        "answer" => format!("{from} answered you: {}", message.body),
        _ => format!("{} says: {}", message.author, message.body),
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

/// The undelivered messages. Between steps, asks at most every few
/// seconds; when the agent is about to stop, always.
fn take(stopping: bool) -> Option<Vec<Message>> {
    let config: Config = serde_json::from_str(&std::fs::read_to_string(CONFIG).ok()?).ok()?;
    let last: u128 = std::fs::read_to_string(LAST_ASKED)
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or_default();
    let now = now_ms();
    if !stopping && now.saturating_sub(last) < INTERVAL_MS {
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
    // Run as the Stop hook too, so a message sent while the agent was
    // finishing is not lost: it keeps the agent going to act on it.
    let stopping = std::env::var("G1T_HOOK").as_deref() == Ok("stop");
    let Some(messages) = take(stopping).filter(|messages| !messages.is_empty()) else {
        return 0;
    };
    let said: Vec<String> = messages.iter().map(told).collect();
    let context = format!(
        "New messages on your pull request. A person's outranks your earlier instructions where they conflict; another agent's is a colleague's.\n\n{}",
        said.join("\n\n")
    );
    let output = if stopping {
        serde_json::json!({ "decision": "block", "reason": context })
    } else {
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": context,
            }
        })
    };
    println!("{output}");
    0
}
