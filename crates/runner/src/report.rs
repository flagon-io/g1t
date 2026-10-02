//! Reports a pull request's progress to g1t through its public API.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Serialize;

/// Entries are sent in batches at most this often.
const FLUSH_INTERVAL: Duration = Duration::from_millis(1500);
const FLUSH_SIZE: usize = 50;
/// Tool output can be enormous; the session keeps the start of it.
const MAX_ENTRY_CHARS: usize = 8000;

/// One step of the session, as the API accepts it.
#[derive(Debug, Serialize)]
pub struct Entry {
    kind: &'static str,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
}

impl Entry {
    pub fn new(kind: &'static str, text: &str) -> Self {
        let mut chars = text.chars();
        let mut text: String = chars.by_ref().take(MAX_ENTRY_CHARS).collect();
        if chars.next().is_some() {
            text.push_str("\n… (truncated)");
        }
        Entry {
            kind,
            text,
            tool: None,
        }
    }

    pub fn tool(kind: &'static str, tool: &str, text: &str) -> Self {
        Entry {
            tool: Some(tool.to_owned()),
            ..Entry::new(kind, text)
        }
    }
}

/// Replaces every occurrence of a secret with a marker. An agent can print
/// its environment or a git remote; whatever it prints is recorded.
fn redact(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_owned(), |text, secret| {
        text.replace(secret, "[redacted]")
    })
}

pub struct Reporter {
    api: String,
    token: String,
    /// The pull request's path in the API: `repos/<owner>/<name>/pulls/<number>`.
    pull: String,
    /// Values that must never reach a session, which is as public as the
    /// repository: the credentials this process was started with.
    secrets: Vec<String>,
    pending: Vec<Entry>,
    last_flush: Instant,
}

impl Reporter {
    pub fn from_env() -> Result<Self> {
        let var = |name: &str| std::env::var(name).with_context(|| format!("{name} is not set"));
        let token = var("G1T_TOKEN")?;
        let secrets = std::iter::once(token.clone())
            .chain(std::env::var("ANTHROPIC_API_KEY"))
            .chain(std::env::var("AI_GATEWAY_TOKEN"))
            .filter(|secret| !secret.is_empty())
            .collect();
        Ok(Reporter {
            api: var("G1T_API")?,
            token,
            pull: format!("repos/{}/pulls/{}", var("G1T_REPO")?, var("PULL_NUMBER")?),
            secrets,
            pending: Vec::new(),
            last_flush: Instant::now(),
        })
    }

    fn post(&self, action: &str, body: serde_json::Value) -> Result<()> {
        ureq::post(&format!("{}/v1/{}/{action}", self.api, self.pull))
            .set("authorization", &format!("Bearer {}", self.token))
            .send_json(body)
            .with_context(|| format!("{action} request failed"))?;
        Ok(())
    }

    /// Queues an entry, sending the batch if it is due.
    pub fn record(&mut self, mut entry: Entry) {
        entry.text = redact(&entry.text, &self.secrets);
        self.pending.push(entry);
        if self.pending.len() >= FLUSH_SIZE || self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush();
        }
    }

    /// Sends everything queued. A failed send is logged and the entries
    /// kept, so one bad request does not lose the session or stop the run.
    pub fn flush(&mut self) {
        self.last_flush = Instant::now();
        if self.pending.is_empty() {
            return;
        }
        let body = serde_json::json!({ "entries": self.pending });
        match self.post("session", body) {
            Ok(()) => self.pending.clear(),
            Err(error) => eprintln!("g1t-runner: {error:#}"),
        }
    }

    /// Marks the pull request ready for review, with `summary` as its
    /// description.
    pub fn ready(&self, summary: &str) -> Result<()> {
        self.post("ready", serde_json::json!({ "summary": summary }))
    }

    /// Closes the pull request without merging.
    pub fn close(&self) -> Result<()> {
        self.post("close", serde_json::json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_removed_from_entries() {
        let secrets = vec!["g1t_abc123".to_owned(), "sk-ant-xyz".to_owned()];
        let text = "origin https://me:g1t_abc123@g1t.sh/a.git
KEY=sk-ant-xyz g1t_abc123";
        let clean = redact(text, &secrets);
        assert!(!clean.contains("g1t_abc123"));
        assert!(!clean.contains("sk-ant-xyz"));
        assert_eq!(clean.matches("[redacted]").count(), 3);
    }

    #[test]
    fn long_entries_are_truncated() {
        let entry = Entry::new("note", &"x".repeat(MAX_ENTRY_CHARS + 10));
        assert!(entry.text.ends_with("(truncated)"));
        assert!(Entry::new("note", "short").text == "short");
    }
}
