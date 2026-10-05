//! Tells g1t what the agent is doing, step by step, so people can watch a
//! run live: each tool call and each thing the agent says, as one short
//! line. Sent at most every few seconds, with the run's own token, and
//! never allowed to slow down or fail the run.
//!
//! The runner service gives the sandbox `AGENT_RUN` and `AGENT_RUN_TOKEN`
//! when it records the run. Without them nothing is sent.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// Steps are sent at most this often.
const INTERVAL: Duration = Duration::from_secs(3);
/// The most steps one report carries; a burst keeps its end.
const MAX_PENDING: usize = 20;
const MAX_STEP_CHARS: usize = 200;

pub struct Progress {
    url: String,
    token: String,
    pending: Vec<String>,
    last: Instant,
    /// Values that must never be sent: the credentials this process has.
    secrets: Vec<String>,
    /// Set once g1t says the run was stopped.
    stopped: bool,
}

/// One line, at most `MAX_STEP_CHARS`.
pub fn one_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_STEP_CHARS {
        return line;
    }
    let mut short: String = line.chars().take(MAX_STEP_CHARS - 1).collect();
    short.push('…');
    short
}

/// A tool call as a step: what it did, to what.
pub fn describe_tool(tool: &str, input: &Value) -> String {
    let field = |name: &str| input.get(name).and_then(Value::as_str).unwrap_or_default();
    let file = |name: &str| {
        let path = field(name);
        path.strip_prefix("/work/repo/").unwrap_or(path).to_owned()
    };
    let line = match tool {
        "Bash" => format!("Ran {}", field("command")),
        "Read" => format!("Read {}", file("file_path")),
        "Write" => format!("Wrote {}", file("file_path")),
        "Edit" | "MultiEdit" => format!("Edited {}", file("file_path")),
        "NotebookEdit" => format!("Edited {}", file("notebook_path")),
        "Glob" => format!("Looked for {}", field("pattern")),
        "Grep" => format!("Searched for {}", field("pattern")),
        "WebFetch" => format!("Fetched {}", field("url")),
        "WebSearch" => format!("Searched the web for {}", field("query")),
        "TodoWrite" => "Updated its plan".to_owned(),
        "Task" | "Agent" => format!("Asked a helper: {}", field("description")),
        other => match other.strip_prefix("mcp__g1t__") {
            Some(operation) => format!("Used g1t: {}", operation.replace('_', " ")),
            None => format!("Used {other}"),
        },
    };
    one_line(&line)
}

impl Progress {
    pub fn from_env() -> Option<Progress> {
        let run = std::env::var("AGENT_RUN").ok().filter(|run| !run.is_empty())?;
        let token = std::env::var("AGENT_RUN_TOKEN").ok().filter(|token| !token.is_empty())?;
        let api = std::env::var("G1T_API").unwrap_or_else(|_| "https://api.g1t.sh".to_owned());
        let secrets = [
            "G1T_TOKEN",
            "G1T_AGENT_TOKEN",
            "ANTHROPIC_API_KEY",
            "AI_GATEWAY_TOKEN",
            "BILLING_TOKEN",
            "AGENT_RUN_TOKEN",
        ]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| secret.len() >= 8)
        .collect();
        Some(Progress {
            url: format!("{}/agent-runs/{run}/report", api.trim_end_matches('/')),
            token,
            pending: Vec::new(),
            // So the first step goes at once.
            last: Instant::now() - INTERVAL,
            secrets,
            stopped: false,
        })
    }

    fn clean(&self, text: &str) -> String {
        self.secrets
            .iter()
            .fold(text.to_owned(), |text, secret| text.replace(secret, "[redacted]"))
    }

    fn send(&mut self, body: Value) {
        let mut body = body;
        body["token"] = json!(self.token);
        let sent = ureq::post(&self.url)
            .timeout(Duration::from_secs(10))
            .send_json(body);
        match sent {
            Ok(response) => {
                let answer: Value = response.into_json().unwrap_or(Value::Null);
                if answer["status"] == "stopped" {
                    self.stopped = true;
                }
            }
            Err(error) => eprintln!("g1t-runner: could not report the run's progress: {error}"),
        }
    }

    /// Records a step, sending what has gathered if it is time.
    pub fn step(&mut self, text: &str) {
        let line = one_line(&self.clean(text));
        if line.is_empty() {
            return;
        }
        self.pending.push(line);
        if self.pending.len() > MAX_PENDING {
            self.pending.remove(0);
        }
        if self.last.elapsed() >= INTERVAL {
            self.flush();
        }
    }

    /// Sends the steps gathered so far.
    pub fn flush(&mut self) {
        self.last = Instant::now();
        if self.pending.is_empty() {
            return;
        }
        let steps = std::mem::take(&mut self.pending);
        self.send(json!({ "steps": steps }));
    }

    /// What the run cost, as the harness worked it out.
    pub fn cost(&mut self, cost_usd: f64, turns: u64) {
        self.flush();
        self.send(json!({ "costUsd": cost_usd, "turns": turns }));
    }

    /// Ends the run as stopped because it reached a cap of its guardrails
    /// (guard.rs): `budget` or `time`.
    pub fn halt(&mut self, reason: &str, message: &str) {
        self.flush();
        self.send(json!({ "halt": reason, "error": message }));
    }

    /// Whether a person stopped the run.
    #[allow(dead_code)]
    pub fn stopped(&self) -> bool {
        self.stopped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_calls_read_as_steps() {
        assert_eq!(
            describe_tool("Edit", &json!({ "file_path": "/work/repo/src/lib.rs" })),
            "Edited src/lib.rs"
        );
        assert_eq!(describe_tool("Bash", &json!({ "command": "cargo  test\n -q" })), "Ran cargo test -q");
        assert_eq!(describe_tool("mcp__g1t__create_issue", &json!({})), "Used g1t: create issue");
    }

    #[test]
    fn steps_are_one_short_line() {
        let long = one_line(&"word ".repeat(100));
        assert_eq!(long.chars().count(), MAX_STEP_CHARS);
        assert!(long.ends_with('…'));
    }
}
