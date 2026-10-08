//! Telling g1t how a job is going: its steps, its log in batches, its
//! annotations, and how it ended. Every report carries the job's token.

use std::time::{Duration, Instant};

use anyhow::Result;
use g1t_actions::mask;
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

/// The job's log, masked, sent in batches. `masks` holds every form of
/// every secret (`g1t_actions::mask`), longest first.
pub(crate) struct Log {
    pub(crate) api: Api,
    pub(crate) masks: Vec<String>,
    step: u32,
    buffer: String,
    last: Instant,
}

impl Log {
    pub(crate) fn new(api: Api, mut masks: Vec<String>) -> Log {
        masks.retain(|mask| !mask.is_empty());
        masks.sort_by_key(|mask| std::cmp::Reverse(mask.len()));
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
        mask::apply(text, &self.masks)
    }

    /// `::add-mask::`: masks `value` from here on, in every form it can
    /// take (each line, base64, JSON-escaped), as a secret is.
    pub(crate) fn add_mask(&mut self, value: &str) {
        let mut added = false;
        for variant in mask::variants(value) {
            if !self.masks.contains(&variant) {
                self.masks.push(variant);
                added = true;
            }
        }
        if added {
            self.masks.sort_by_key(|mask| std::cmp::Reverse(mask.len()));
        }
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
        let title = properties.get("title").and_then(Value::as_str).map(|title| self.mask(title));
        self.api.report(json!({
            "kind": "annotation",
            "level": level,
            "message": message,
            "title": title,
            "file": properties.get("file"),
            "line": properties.get("line").and_then(|l| l.as_str()).and_then(|l| l.parse::<u32>().ok()),
        }));
    }

    pub(crate) fn done(&mut self, conclusion: &str, outputs: &serde_json::Map<String, Value>, reason: Option<&str>) {
        let outputs = self.withhold_secrets(outputs);
        self.flush();
        self.api.report(json!({ "kind": "done", "conclusion": conclusion, "outputs": outputs, "reason": reason }));
    }

    /// The job's outputs without any that hold a secret, as on GitHub: an
    /// output goes to other jobs and to the run's page, where no mask
    /// reaches. Each one left out is warned of in the log.
    pub(crate) fn withhold_secrets(&mut self, outputs: &serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
        let mut kept = serde_json::Map::new();
        for (name, value) in outputs {
            let text = match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            if mask::reveals(&text, &self.masks) {
                self.line(&format!("##[warning]The output `{name}` was left out: it holds a secret."));
                continue;
            }
            kept.insert(name.clone(), value.clone());
        }
        kept
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(secrets: &[&str]) -> Log {
        let api = Api { base: "http://127.0.0.1:9".into(), job: "job_1".into(), token: "t".into() };
        Log::new(api, mask::all_variants(secrets.iter().copied()))
    }

    #[test]
    fn outputs_holding_a_secret_are_left_out() {
        let mut log = log(&["s3cr3t-token"]);
        let mut outputs = serde_json::Map::new();
        outputs.insert("version".into(), json!("1.2.0"));
        outputs.insert("leak".into(), json!("token=s3cr3t-token"));
        outputs.insert("encoded".into(), json!("czNjcjN0LXRva2Vu"));
        let kept = log.withhold_secrets(&outputs);
        assert_eq!(kept.keys().collect::<Vec<_>>(), ["version"]);
        assert!(log.buffer.contains("The output `leak` was left out"));
        assert!(log.buffer.contains("The output `encoded` was left out"));
    }

    #[test]
    fn added_masks_cover_every_form() {
        let mut log = log(&[]);
        log.add_mask("line one\nline two");
        assert_eq!(log.mask("first: line one"), "first: ***");
        assert_eq!(log.mask("then line two"), "then ***");
        // Longest first: the whole value, not its pieces.
        log.add_mask("abc");
        log.add_mask("abcdef");
        assert_eq!(log.mask("abcdef"), "***");
    }
}
