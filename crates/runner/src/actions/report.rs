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
    /// "url", "ref", "token"}`, or `{"source": "github", "sha", "archive",
    /// "note"}`: the commit GitHub's ref names, and whether g1t keeps its
    /// archive (`action_archive`). Err holds why g1t
    /// refused (`true`: the repository is private and may not be used
    /// here), or that it could not be asked (`false`).
    pub(crate) fn action(&self, repository: &str, git_ref: &str) -> std::result::Result<Value, (bool, String)> {
        // The first job to use an action at a commit waits while g1t
        // fetches and keeps its archive.
        let sent = ureq::post(&format!("{}/actions/jobs/{}/action", self.base, self.job))
            .timeout(Duration::from_secs(120))
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

    /// Downloads the archive g1t keeps of `repository` at `sha` to `to`.
    pub(crate) fn action_archive(&self, repository: &str, sha: &str, to: &std::path::Path) -> std::result::Result<u64, String> {
        let response = ureq::post(&format!("{}/actions/jobs/{}/archive", self.base, self.job))
            .timeout(Duration::from_secs(300))
            .send_json(json!({ "token": self.token, "report": { "repository": repository, "sha": sha } }))
            .map_err(|error| match error {
                ureq::Error::Status(code, response) => {
                    let body: Value = response.into_json().unwrap_or(Value::Null);
                    body["error"]["message"].as_str().map_or_else(|| format!("g1t answered {code}"), str::to_owned)
                }
                other => other.to_string(),
            })?;
        let mut file = std::fs::File::create(to).map_err(|error| error.to_string())?;
        std::io::copy(&mut response.into_reader(), &mut file).map_err(|error| error.to_string())
    }

    /// An API with no address, which sends nothing: what the tests use, so
    /// a step's run is not held up by reports that go nowhere (each one
    /// tried three times, with waits between, over a second and a half).
    #[cfg(test)]
    pub(crate) fn offline() -> Api {
        Api { base: String::new(), job: "job_1".into(), token: "t".into() }
    }

    pub(crate) fn report(&self, report: Value) {
        // No address: nowhere to send it (Api::offline).
        if self.base.is_empty() {
            return;
        }
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
    /// The problem matchers steps added, which last the whole job.
    pub(crate) matchers: super::matchers::Matchers,
    /// Everything sent so far, so a test reads the whole log however its
    /// batches fell (`buffered`).
    #[cfg(test)]
    flushed: String,
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
            matchers: super::matchers::Matchers::default(),
            #[cfg(test)]
            flushed: String::new(),
        }
    }

    /// The log so far: what was sent and what waits to be.
    #[cfg(all(test, unix))]
    pub(crate) fn buffered(&self) -> String {
        format!("{}{}", self.flushed, self.buffer)
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
        #[cfg(test)]
        self.flushed.push_str(&text);
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

    /// An annotation, from `::error::` and its kin or a problem matcher:
    /// its `file`, `line`, `col`, `endLine` and `endColumn` as GitHub's
    /// commands spell them, sent as `file`, `line`, `column`, `end_line`
    /// and `end_column`.
    pub(crate) fn annotation(&mut self, level: &str, message: &str, properties: &serde_json::Map<String, Value>) {
        let report = self.annotation_report(level, message, properties);
        self.api.report(report);
    }

    fn annotation_report(&self, level: &str, message: &str, properties: &serde_json::Map<String, Value>) -> Value {
        let message = self.mask(message);
        let title = properties.get("title").and_then(Value::as_str).map(|title| self.mask(title));
        let number = |keys: &[&str]| keys.iter().find_map(|key| properties.get(*key).and_then(Value::as_str)).and_then(|n| n.trim().parse::<u32>().ok());
        json!({
            "kind": "annotation",
            "level": level,
            "message": message,
            "title": title,
            "file": properties.get("file"),
            "line": number(&["line"]),
            "column": number(&["col"]),
            "end_line": number(&["endLine"]),
            "end_column": number(&["endColumn"]),
        })
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
        Log::new(Api::offline(), mask::all_variants(secrets.iter().copied()))
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
    fn annotations_carry_their_columns_and_end() {
        let log = log(&["hidden"]);
        let properties: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "file": "a.rs", "line": "3", "col": "7", "endLine": "4", "endColumn": "2", "title": "t hidden" })).unwrap();
        let report = log.annotation_report("error", "bad hidden", &properties);
        assert_eq!(report["line"], 3);
        assert_eq!(report["column"], 7);
        assert_eq!(report["end_line"], 4);
        assert_eq!(report["end_column"], 2);
        assert_eq!(report["title"], "t ***");
        assert_eq!(report["message"], "bad ***");
        let bare = log.annotation_report("notice", "x", &serde_json::Map::new());
        assert!(bare["column"].is_null() && bare["file"].is_null());
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
