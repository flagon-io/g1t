//! Telling g1t how a job is going: its steps, its log in batches, its
//! annotations, and how it ended. Every report carries the job's token.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use g1t_actions::mask;
use serde_json::{Value, json};

/// How long log lines wait before they are sent: about a second, so a
/// running step's page follows it closely, at one write to g1t a second.
const FLUSH_EVERY: Duration = Duration::from_millis(1000);
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

/// How many times a spec is asked for before the job fails.
const SPEC_TRIES: u32 = 4;

/// How long to wait before asking for a spec again, after `attempt` tries:
/// 1, 2, then 4 seconds.
fn spec_backoff(attempt: u32) -> Duration {
    Duration::from_secs(1 << (attempt - 1).min(2))
}

/// Why a spec did not arrive.
#[derive(Debug)]
enum SpecError {
    /// g1t answered with this status.
    Status(u16),
    /// The request could not be made or answered (connection, timeout).
    Transport(String),
    /// The answer's body did not read as JSON: cut short, usually.
    Body(std::io::Error),
}

impl SpecError {
    /// Whether asking again may get the spec: not when g1t said no.
    fn worth_retrying(&self) -> bool {
        match self {
            SpecError::Status(code) => *code >= 500,
            SpecError::Transport(_) | SpecError::Body(_) => true,
        }
    }
}

impl From<ureq::Error> for SpecError {
    fn from(error: ureq::Error) -> Self {
        match error {
            ureq::Error::Status(code, _) => SpecError::Status(code),
            ureq::Error::Transport(transport) => SpecError::Transport(transport.to_string()),
        }
    }
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpecError::Status(code) => write!(f, "g1t answered {code}"),
            SpecError::Transport(error) => write!(f, "{error}"),
            SpecError::Body(error) => write!(f, "Failed to read JSON: {error}"),
        }
    }
}

impl std::error::Error for SpecError {}

#[derive(Clone)]
pub(crate) struct Api {
    pub(crate) base: String,
    pub(crate) job: String,
    pub(crate) token: String,
}

impl Api {
    /// The job's spec. With `rotate`, g1t spends the token it was asked
    /// with and sends a new one beside the spec, which this takes for
    /// everything after (`next_token`): a copy of the first left on the
    /// runner's computer cannot fetch the job, its secrets or a G1T_TOKEN
    /// again. A g1t that predates it sends none, and the token stays.
    ///
    /// With `broker`, this harness passes its job's requests to brokered
    /// secrets' hosts through g1t (broker.rs), and the spec lists each
    /// stand-in's hosts (`brokered`).
    ///
    /// A spec that does not arrive whole (the connection drops, or the body
    /// ends early) or that g1t could not make (5xx) is asked for again, up
    /// to [`SPEC_TRIES`] times: Deploy #449's job failed on one truncated
    /// answer. Not with `rotate`: g1t spends the token on the first ask,
    /// whether or not the answer arrived, so a second would be refused.
    pub(crate) fn spec(&mut self, rotate: bool, broker: bool) -> Result<Value> {
        let mut body = json!({ "token": self.token });
        if rotate {
            body["rotate"] = json!(true);
        }
        if broker {
            body["broker"] = json!(true);
        }
        let url = format!("{}/actions/jobs/{}/spec", self.base, self.job);
        let tries = if rotate { 1 } else { SPEC_TRIES };
        let mut attempt = 1;
        let mut spec: Value = loop {
            let fetched = crate::http::agent().post(&url)
                .timeout(Duration::from_secs(60))
                .send_json(body.clone())
                .map_err(SpecError::from)
                .and_then(|response| response.into_json::<Value>().map_err(SpecError::Body));
            match fetched {
                Ok(spec) => break spec,
                Err(error) if attempt < tries && error.worth_retrying() => {
                    eprintln!("g1t-runner: the job's spec did not arrive whole ({error}); asking again");
                    std::thread::sleep(spec_backoff(attempt));
                    attempt += 1;
                }
                Err(error) => return Err(error.into()),
            }
        };
        self.take_next_token(&mut spec);
        Ok(spec)
    }

    /// Takes the token a spec carries in place of the one it was fetched
    /// with, and masks it in the log.
    fn take_next_token(&mut self, spec: &mut Value) {
        let next = spec.as_object_mut().and_then(|s| s.remove("next_token").or_else(|| s.remove("nextToken")));
        if let Some(next) = next.as_ref().and_then(Value::as_str).filter(|t| !t.is_empty()) {
            self.token = next.to_owned();
            if let Some(masks) = spec.get_mut("masks").and_then(Value::as_array_mut) {
                masks.push(json!(next));
            }
        }
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
        let sent = crate::http::agent().post(&format!("{}/actions/jobs/{}/action", self.base, self.job))
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
        let response = crate::http::agent().post(&format!("{}/actions/jobs/{}/archive", self.base, self.job))
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
            let sent = crate::http::agent().post(&format!("{}/actions/jobs/{}", self.base, self.job))
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
    /// The number of the last batch sent, 1 for the job's first: each
    /// batch carries its own, and keeps it when it is sent again, so g1t
    /// keeps a batch it already has once.
    chunk: u64,
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
            chunk: 0,
            #[cfg(test)]
            flushed: String::new(),
        }
    }

    /// The log so far, what was sent and what waits to be, without the
    /// time each line is stamped with.
    #[cfg(test)]
    pub(crate) fn buffered(&self) -> String {
        unstamped(&format!("{}{}", self.flushed, self.buffer))
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

    /// Adds a line to the log, masked, each of its lines stamped with the
    /// time, as GitHub's runner writes its logs
    /// (`2026-10-12T09:41:07.1234567Z text`).
    pub(crate) fn line(&mut self, text: &str) {
        let masked = self.mask(text);
        let at = stamp(SystemTime::now());
        for line in masked.split('\n') {
            self.buffer.push_str(&at);
            self.buffer.push(' ');
            self.buffer.push_str(line);
            self.buffer.push('\n');
        }
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
        let report = self.log_report(text);
        self.api.report(report);
    }

    /// The next batch of the log, numbered.
    fn log_report(&mut self, text: String) -> Value {
        self.chunk += 1;
        json!({ "kind": "log", "step": self.step, "chunk": self.chunk, "text": text })
    }

    /// Does `work` with the job's API on a thread of its own, writing
    /// `waiting(seconds)` to the log, and sending it, every `every` it is
    /// still going: a wait the job's page would otherwise show as a silent
    /// log, such as g1t fetching an action's archive from GitHub.
    pub(crate) fn waiting<T: Send + 'static>(
        &mut self,
        every: Duration,
        work: impl FnOnce(Api) -> T + Send + 'static,
        waiting: impl Fn(u64) -> String,
    ) -> T {
        self.flush();
        let api = self.api.clone();
        let (done, answer) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = done.send(work(api));
        });
        let started = Instant::now();
        let result = loop {
            match answer.recv_timeout(every) {
                Ok(result) => break result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    self.line(&waiting(started.elapsed().as_secs()));
                    self.flush();
                }
                // The work panicked: so does the job, as it would have.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => match worker.join() {
                    Err(panic) => std::panic::resume_unwind(panic),
                    Ok(()) => unreachable!("the work sends its result before it ends"),
                },
            }
        };
        let _ = worker.join();
        result
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

/// A time as GitHub's logs stamp each line: RFC 3339 in UTC, to a tenth
/// of a microsecond (`2026-10-12T09:41:07.1234567Z`).
pub(crate) fn stamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs();
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:07}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_nanos() / 100
    )
}

/// The calendar date `days` after 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A log without the time stamped at the start of each line.
#[cfg(test)]
pub(crate) fn unstamped(text: &str) -> String {
    text.split_inclusive('\n')
        .map(|line| match line.split_once(' ') {
            Some((at, rest)) if at.len() == 28 && at.ends_with('Z') && at.as_bytes()[10] == b'T' => rest,
            _ => line,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A g1t on 127.0.0.1 that answers each spec request with the next of
    /// `answers` (a body, and whether to cut it short), counting the asks.
    fn serve(answers: Vec<(&'static str, bool)>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = asked.clone();
        std::thread::spawn(move || {
            for (body, cut) in answers {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                count.fetch_add(1, Ordering::SeqCst);
                // Cut short: says the whole length, sends half, and hangs up.
                let sent = if cut { &body[..body.len() / 2] } else { body };
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(sent.as_bytes());
            }
        });
        (base, asked)
    }

    #[test]
    fn a_spec_cut_short_is_asked_for_again() {
        let body = r#"{"job":"job_1","masks":[],"steps":[{"run":"cargo test"}]}"#;
        let (base, asked) = serve(vec![(body, true), (body, false)]);
        let mut api = Api { base, job: "job_1".into(), token: "t".into() };
        let spec = api.spec(false, false).unwrap();
        assert_eq!(spec["steps"][0]["run"], "cargo test");
        assert_eq!(asked.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_spec_that_spends_its_token_is_asked_for_once() {
        let body = r#"{"job":"job_1","masks":[],"next_token":"fresh"}"#;
        let (base, asked) = serve(vec![(body, true), (body, false)]);
        let mut api = Api { base, job: "job_1".into(), token: "t".into() };
        let error = api.spec(true, false).unwrap_err().to_string();
        assert!(error.starts_with("Failed to read JSON"), "{error}");
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_what_may_arrive_next_time_is_asked_again() {
        assert!(SpecError::Status(502).worth_retrying());
        assert!(!SpecError::Status(403).worth_retrying());
        assert!(!SpecError::Status(404).worth_retrying());
        assert!(SpecError::Transport("connection reset".into()).worth_retrying());
        assert_eq!((spec_backoff(1), spec_backoff(2), spec_backoff(3)), (Duration::from_secs(1), Duration::from_secs(2), Duration::from_secs(4)));
    }

    #[test]
    fn the_token_a_spec_carries_replaces_the_one_it_was_fetched_with() {
        let mut api = Api::offline();
        let mut spec = json!({ "job": "job_1", "masks": ["s3cret"], "next_token": "fresh" });
        api.take_next_token(&mut spec);
        assert_eq!(api.token, "fresh");
        assert!(spec.get("next_token").is_none(), "the job's steps never see it");
        assert_eq!(spec["masks"], json!(["s3cret", "fresh"]));
        // A g1t that does not rotate sends none: the token stays.
        let mut spec = json!({ "job": "job_1", "masks": [] });
        api.take_next_token(&mut spec);
        assert_eq!(api.token, "fresh");
        assert_eq!(spec["masks"], json!([]));
    }

    #[test]
    fn every_line_is_stamped_with_the_time_as_github_stamps_it() {
        assert_eq!(stamp(UNIX_EPOCH), "1970-01-01T00:00:00.0000000Z");
        assert_eq!(stamp(UNIX_EPOCH + Duration::new(1_791_797_067, 123_456_789)), "2026-10-12T09:24:27.1234567Z");
        // A leap day, and the last day of February in a century that has none.
        assert_eq!(stamp(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.0000000Z");
        assert_eq!(stamp(UNIX_EPOCH + Duration::from_secs(4_107_542_399)), "2100-02-28T23:59:59.0000000Z");
        let mut log = log(&["s3cr3t"]);
        log.line("one s3cr3t\ntwo");
        let lines: Vec<&str> = log.buffer.lines().collect();
        assert_eq!(lines.len(), 2, "each line of a message is stamped");
        for (line, text) in lines.iter().zip(["one ***", "two"]) {
            let (at, rest) = line.split_once(' ').unwrap();
            assert_eq!((at.len(), &at[10..11], &at[27..]), (28, "T", "Z"), "{line}");
            assert_eq!(rest, text);
        }
        assert_eq!(log.buffered(), "one ***\ntwo\n");
    }

    fn log(secrets: &[&str]) -> Log {
        Log::new(Api::offline(), mask::all_variants(secrets.iter().copied()))
    }

    /// A server that answers the first `fail` requests with a 500 and the
    /// rest with `{}`, and hands back each request's body.
    fn flaky_server(fail: usize, requests: usize) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let serving = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for answered in 0..requests {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream);
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                bodies.push(serde_json::from_slice::<Value>(&body).unwrap());
                let status = if answered < fail { "500 Internal Server Error" } else { "200 OK" };
                write!(reader.get_mut(), "HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
            }
            bodies
        });
        (base, serving)
    }

    #[test]
    fn each_batch_of_the_log_keeps_its_number_when_sent_again() {
        let (base, serving) = flaky_server(1, 3);
        let mut log = Log::new(Api { base, job: "job_1".into(), token: "t".into() }, Vec::new());
        log.line("one");
        log.flush();
        log.line("two");
        log.flush();
        log.flush(); // Nothing waits: no batch, and no number used.
        let bodies = serving.join().unwrap();
        let sent: Vec<(u64, String)> = bodies
            .iter()
            .map(|body| (body["report"]["chunk"].as_u64().unwrap(), unstamped(body["report"]["text"].as_str().unwrap())))
            .collect();
        // The first batch failed and was sent again with its number; the
        // next is the job's second.
        assert_eq!(sent, [(1, "one\n".into()), (1, "one\n".into()), (2, "two\n".into())]);
        assert_eq!(bodies[0], bodies[1], "a batch sent again is the same batch");
    }

    #[test]
    fn a_long_wait_says_so_in_the_log_as_it_goes() {
        let mut log = log(&[]);
        // The work answers once the log has told of the wait twice, so the
        // test does not hang on how fast the machine is; a minute at most.
        let told_so_far = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = told_so_far.clone();
        let started = Instant::now();
        let answer = log.waiting(
            Duration::from_millis(50),
            move |_| {
                let deadline = Instant::now() + Duration::from_secs(60);
                while seen.load(std::sync::atomic::Ordering::SeqCst) < 2 && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                42
            },
            move |seconds| {
                told_so_far.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                format!("still waiting ({seconds}s)")
            },
        );
        let took = started.elapsed().as_millis() as usize;
        assert_eq!(answer, 42);
        let lines = log.buffered();
        let told = lines.lines().filter(|line| line.starts_with("still waiting (")).count();
        // At least the two it waited for, and never more than one per 50 ms
        // the wait really took.
        assert!(told >= 2 && told <= took / 50, "a line each time the wait goes on ({took} ms): {lines:?}");
        // A wait that ends at once writes nothing.
        let mut quick = super::tests::log(&[]);
        assert_eq!(quick.waiting(Duration::from_secs(5), |api| api.job, |_| "never".into()), "job_1");
        assert_eq!(quick.buffered(), "");
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
