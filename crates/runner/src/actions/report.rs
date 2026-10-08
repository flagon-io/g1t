//! Telling g1t how a job is going: its steps, its log in batches, its
//! annotations, and how it ended. Every report carries the job's token.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::Result;
use g1t_actions::mask;
use serde_json::{Value, json};

/// How long log lines wait before they are sent.
const FLUSH_EVERY: Duration = Duration::from_millis(1500);
/// How much log is sent at once.
const FLUSH_BYTES: usize = 64 * 1024;
/// The most one step may add to the job's summary, as on GitHub.
pub(crate) const MAX_SUMMARY_BYTES: usize = 1024 * 1024;
/// How long the runner goes without a report before it asks whether the
/// job was cancelled.
const PING_EVERY: Duration = Duration::from_secs(10);

/// Whether the job was cancelled, as g1t's answers to its reports say.
struct Cancel {
    /// g1t said so.
    said: AtomicBool,
    /// The job has taken it in: the step it was on was stopped, and the
    /// cleanup steps that follow are not stopped for it again.
    taken: AtomicBool,
}

impl Cancel {
    const fn new() -> Cancel {
        Cancel { said: AtomicBool::new(false), taken: AtomicBool::new(false) }
    }

    /// Reads an answer to a report: `cancelled` when the run was cancelled.
    fn hear(&self, answer: &Value) {
        if answer["cancelled"].as_bool() == Some(true) {
            self.said.store(true, Ordering::Relaxed);
        }
    }

    fn cancelled(&self) -> bool {
        self.said.load(Ordering::Relaxed)
    }

    fn interrupt(&self) -> bool {
        self.cancelled() && !self.taken.load(Ordering::Relaxed)
    }

    fn take(&self) {
        self.taken.store(true, Ordering::Relaxed);
    }
}

/// This job's (one runs per process).
static CANCEL: Cancel = Cancel::new();

/// Whether g1t said the job was cancelled.
pub(crate) fn cancelled() -> bool {
    CANCEL.cancelled()
}

/// Whether a running step should be stopped: cancelled, and not yet taken in.
pub(crate) fn interrupt() -> bool {
    CANCEL.interrupt()
}

/// The job has seen the cancellation: what runs from here is its cleanup.
pub(crate) fn take_cancel() {
    CANCEL.take();
}

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

    /// Where to fetch another repository's action from: `{"source": "g1t",
    /// "url", "ref", "token"}` or `{"source": "github"}`. Err holds why g1t
    /// refused (`true`: the repository is private and may not be used
    /// here), or that it could not be asked (`false`).
    pub(crate) fn action(&self, repository: &str, git_ref: &str) -> std::result::Result<Value, (bool, String)> {
        let sent = ureq::post(&format!("{}/actions/jobs/{}/action", self.base, self.job))
            .timeout(Duration::from_secs(30))
            .send_json(json!({ "token": self.token, "report": { "repository": repository, "ref": git_ref } }));
        match sent {
            Ok(response) => response.into_json().map_err(|error| (false, error.to_string())),
            Err(ureq::Error::Status(code, response)) => {
                let body: Value = response.into_json().unwrap_or(Value::Null);
                let message = body["error"]["message"].as_str().unwrap_or("g1t did not answer.").to_owned();
                Err((code == 403, message))
            }
            Err(error) => Err((false, error.to_string())),
        }
    }

    pub(crate) fn report(&self, report: Value) {
        // A report that cannot be sent is tried a few times, then dropped:
        // the job goes on, and g1t notices a silent job by itself.
        for attempt in 0..3 {
            let sent = ureq::post(&format!("{}/actions/jobs/{}", self.base, self.job))
                .timeout(Duration::from_secs(30))
                .send_json(json!({ "token": self.token, "report": report }));
            match sent {
                Ok(response) => {
                    if let Ok(answer) = response.into_json::<Value>() {
                        CANCEL.hear(&answer);
                    }
                    return;
                }
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
    /// When anything was last sent, for the ping.
    sent: Instant,
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
            sent: Instant::now(),
        }
    }

    /// What waits to be sent.
    #[cfg(all(test, unix))]
    pub(crate) fn buffered(&self) -> String {
        self.buffer.clone()
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

    /// Sends what is waiting if it has waited long enough, and asks after
    /// the job when nothing has been sent for a while, so a cancellation
    /// reaches a step that prints nothing.
    pub(crate) fn tick(&mut self) {
        if !self.buffer.is_empty() && self.last.elapsed() >= FLUSH_EVERY {
            self.flush();
        } else if self.sent.elapsed() >= PING_EVERY {
            self.sent = Instant::now();
            self.api.report(json!({ "kind": "ping" }));
        }
    }

    pub(crate) fn flush(&mut self) {
        self.last = Instant::now();
        if self.buffer.is_empty() {
            return;
        }
        self.sent = Instant::now();
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

    /// What a step wrote to `$GITHUB_STEP_SUMMARY`, masked, for the run's
    /// page. More than 1 MiB is refused, as on GitHub, with an error in the
    /// log.
    pub(crate) fn summary(&mut self, markdown: &str) {
        if markdown.trim().is_empty() {
            return;
        }
        if markdown.len() > MAX_SUMMARY_BYTES {
            self.line(&format!(
                "##[error]$GITHUB_STEP_SUMMARY upload aborted: a step's summary may be up to 1024k, and this one is {}k.",
                markdown.len().div_ceil(1024)
            ));
            return;
        }
        let markdown = self.mask(markdown);
        self.flush();
        self.api.report(json!({ "kind": "summary", "step": self.step, "markdown": markdown }));
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
    fn a_cancelled_answer_is_heard_once_and_taken_in() {
        let cancel = Cancel::new();
        cancel.hear(&json!({ "ok": true }));
        assert!(!cancel.cancelled());
        cancel.hear(&json!({ "ok": true, "cancelled": true }));
        assert!(cancel.cancelled() && cancel.interrupt());
        cancel.take();
        assert!(cancel.cancelled() && !cancel.interrupt(), "cleanup steps are not stopped again");
        cancel.hear(&json!({ "ok": true, "cancelled": false }));
        assert!(cancel.cancelled(), "a cancelled job stays cancelled");
    }

    #[test]
    fn a_summary_past_its_limit_is_refused_in_the_log() {
        let mut log = log(&[]);
        log.summary("   
");
        assert!(log.buffer.is_empty(), "an empty summary is not sent");
        log.summary(&"x".repeat(MAX_SUMMARY_BYTES + 1));
        assert!(log.buffer.contains("$GITHUB_STEP_SUMMARY upload aborted"));
        assert!(log.buffer.contains("1025k"));
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
