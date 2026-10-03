//! Telling g1t how a job is going: its steps, its log in batches, its
//! annotations, and how it ended. Every report carries the job's token.

use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::{Value, json};

/// How long log lines wait before they are sent.
const FLUSH_EVERY: Duration = Duration::from_millis(1500);
/// How much log is sent at once.
const FLUSH_BYTES: usize = 64 * 1024;

pub(crate) struct Api {
    pub(crate) base: String,
    pub(crate) job: String,
    pub(crate) token: String,
}

impl Api {
    pub(crate) fn spec(&self) -> Result<Value> {
        let response = ureq::post(&format!("{}/actions/jobs/{}/spec", self.base, self.job))
            .timeout(Duration::from_secs(60))
            .send_json(json!({ "token": self.token }))?;
        Ok(response.into_json()?)
    }

    pub(crate) fn report(&self, report: Value) {
        // A report that cannot be sent is tried a few times, then dropped:
        // the job goes on, and g1t notices a silent job by itself.
        for attempt in 0..3 {
            let sent = ureq::post(&format!("{}/actions/jobs/{}", self.base, self.job))
                .timeout(Duration::from_secs(30))
                .send_json(json!({ "token": self.token, "report": report }));
            match sent {
                Ok(_) => return,
                // Refused: the job was cancelled or finished; nothing to retry.
                Err(ureq::Error::Status(code, _)) if (400..500).contains(&code) => return,
                Err(_) => std::thread::sleep(Duration::from_millis(500 * (attempt + 1))),
            }
        }
    }
}

/// The job's log, masked, sent in batches.
pub(crate) struct Log {
    pub(crate) api: Api,
    pub(crate) masks: Vec<String>,
    step: u32,
    buffer: String,
    last: Instant,
}

impl Log {
    pub(crate) fn new(api: Api, masks: Vec<String>) -> Log {
        Log {
            api,
            masks,
            step: 0,
            buffer: String::new(),
            last: Instant::now(),
        }
    }

    /// Starts writing to step `number` (0 for the job's setup).
    pub(crate) fn step(&mut self, number: u32) {
        self.flush();
        self.step = number;
    }

    pub(crate) fn mask(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for mask in self.masks.iter().filter(|mask| !mask.is_empty()) {
            if out.contains(mask.as_str()) {
                out = out.replace(mask.as_str(), "***");
            }
        }
        out
    }

    pub(crate) fn line(&mut self, text: &str) {
        let masked = self.mask(text);
        self.buffer.push_str(&masked);
        self.buffer.push('\n');
        if self.buffer.len() >= FLUSH_BYTES || self.last.elapsed() >= FLUSH_EVERY {
            self.flush();
        }
    }

    /// Sends what is waiting if it has waited long enough.
    pub(crate) fn tick(&mut self) {
        if !self.buffer.is_empty() && self.last.elapsed() >= FLUSH_EVERY {
            self.flush();
        }
    }

    pub(crate) fn flush(&mut self) {
        self.last = Instant::now();
        if self.buffer.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.buffer);
        self.api.report(json!({ "kind": "log", "step": self.step, "text": text }));
    }

    pub(crate) fn steps(&self, names: &[String]) {
        self.api.report(json!({ "kind": "steps", "steps": names }));
    }

    pub(crate) fn step_state(&mut self, number: u32, name: &str, status: &str, conclusion: Option<&str>) {
        self.flush();
        let name = self.mask(name);
        self.api.report(json!({ "kind": "step", "number": number, "name": name, "status": status, "conclusion": conclusion }));
    }

    pub(crate) fn annotation(&mut self, level: &str, message: &str, properties: &serde_json::Map<String, Value>) {
        let message = self.mask(message);
        self.api.report(json!({
            "kind": "annotation",
            "level": level,
            "message": message,
            "title": properties.get("title"),
            "file": properties.get("file"),
            "line": properties.get("line").and_then(|l| l.as_str()).and_then(|l| l.parse::<u32>().ok()),
        }));
    }

    pub(crate) fn done(&mut self, conclusion: &str, outputs: &serde_json::Map<String, Value>, reason: Option<&str>) {
        self.flush();
        self.api.report(json!({ "kind": "done", "conclusion": conclusion, "outputs": outputs, "reason": reason }));
    }
}
