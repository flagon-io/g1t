//! The runner's calls to g1t: outbound HTTPS only, JSON in `snake_case`.
//! See `g1t_contracts::runners` for the shapes.

use std::time::Duration;

use anyhow::{Result, anyhow};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use g1t_contracts::runners::OfferedSize;

use super::VERSION;

#[derive(Clone, Debug, Deserialize)]
pub struct Assignment {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub repo: String,
    pub timeout_minutes: u32,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub env: Option<Map<String, Value>>,
    /// `public` or `private`; none from an older g1t.
    #[serde(default)]
    pub visibility: Option<String>,
    /// The size a job that asked for one of g1t's machines was taken for,
    /// with its sandbox's CPUs and memory; none for any other job, which
    /// keeps this runner's limits, and from an older g1t.
    #[serde(default)]
    pub size: Option<g1t_contracts::runners::OfferedSize>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Poll {
    #[serde(default)]
    pub assignment: Option<Assignment>,
    #[serde(default)]
    pub cancel: Vec<String>,
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub removed: bool,
}

/// What a job on this runner gets, as g1t is told at registration and in
/// each poll: g1t offers a job asking for one of its own machines
/// (`ubuntu-latest`) with Docker only to a runner whose jobs can use it,
/// and, to a runner that says no sizes (sizes.rs), only when it is at least
/// that machine's size. An older g1t ignores it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Capacity {
    pub cpus: Option<u32>,
    pub memory_mib: Option<u64>,
    /// Whether a job can use Docker, for `services:` and `container:`.
    pub docker: bool,
    /// Whether a job asking for one of g1t's machines runs in g1t's runner
    /// image here (`exec::hosted_image`): g1t gives it none of those jobs
    /// otherwise.
    pub hosted_image: bool,
}

impl Capacity {
    /// Its fields, into a registration's or a poll's body.
    pub fn add_to(&self, body: &mut Value) {
        body["cpus"] = json!(self.cpus);
        body["memory_mib"] = json!(self.memory_mib);
        body["docker"] = json!(self.docker);
        body["hosted_image"] = json!(self.hosted_image);
    }
}

#[derive(Debug, Deserialize)]
pub struct RegisteredRunner {
    pub id: String,
    pub name: String,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    pub labels: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct Registered {
    pub runner: RegisteredRunner,
    pub credential: String,
}

/// How a call failed: g1t refused it (with its status and message), or it
/// did not get through.
#[derive(Debug)]
pub enum Failure {
    Refused(u16, String),
    Unreachable(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Refused(status, message) => write!(f, "{message} ({status})"),
            Failure::Unreachable(why) => write!(f, "could not reach g1t: {why}"),
        }
    }
}

fn agent() -> ureq::Agent {
    crate::http::builder()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .user_agent(&format!("g1t-runner/{VERSION} ({}; {})", std::env::consts::OS, std::env::consts::ARCH))
        .build()
}

fn post(url: &str, credential: Option<&str>, body: &Value) -> std::result::Result<Value, Failure> {
    let mut request = agent().post(url);
    if let Some(credential) = credential {
        request = request.set("authorization", &format!("Bearer {credential}"));
    }
    match request.send_json(body.clone()) {
        Ok(response) => response.into_json::<Value>().map_err(|e| Failure::Unreachable(e.to_string())),
        Err(ureq::Error::Status(status, response)) => {
            let text = response.into_string().unwrap_or_default();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
                .unwrap_or(text);
            Err(Failure::Refused(status, message))
        }
        Err(error) => Err(Failure::Unreachable(error.to_string())),
    }
}

pub struct Api {
    pub base: String,
    pub runner: String,
    pub credential: String,
}

impl Api {
    pub fn register(base: &str, body: &Value) -> Result<Registered> {
        let answer = post(&format!("{base}/runners/register"), None, body).map_err(|failure| anyhow!("{failure}"))?;
        Ok(serde_json::from_value(answer)?)
    }

    /// Asks for work. `isolation` is how this runner keeps work from its
    /// machine now, `capacity` what a job on it gets, and `sizes` which of
    /// g1t's machines it takes jobs for, which g1t keeps up to date from each
    /// poll (it gives a host-mode runner no public repository's work, and a
    /// job asking for one of its machines only to a runner that takes its
    /// size); an older g1t ignores them.
    pub fn poll(&self, running: &[String], wait_ms: u64, isolation: &str, capacity: &Capacity, sizes: &[OfferedSize]) -> std::result::Result<Poll, Failure> {
        let mut body = poll_body(running, wait_ms, isolation);
        capacity.add_to(&mut body);
        body["sizes"] = json!(sizes);
        let answer = post(&format!("{}/runners/{}/poll", self.base, self.runner), Some(&self.credential), &body)?;
        serde_json::from_value(answer).map_err(|e| Failure::Unreachable(e.to_string()))
    }

    pub fn finished(&self, id: &str, exit_code: i32, reason: Option<&str>) -> std::result::Result<(), Failure> {
        let body = json!({ "id": id, "exit_code": exit_code, "reason": reason });
        // Tried a few times: a job that crashed should not wait for the
        // silence check to be noticed.
        let mut last = None;
        for attempt in 0..3 {
            match post(&format!("{}/runners/{}/finished", self.base, self.runner), Some(&self.credential), &body) {
                Ok(_) => return Ok(()),
                Err(Failure::Refused(status, message)) => return Err(Failure::Refused(status, message)),
                Err(failure) => {
                    last = Some(failure);
                    std::thread::sleep(Duration::from_secs(2 * (attempt + 1)));
                }
            }
        }
        Err(last.unwrap_or(Failure::Unreachable("no answer".into())))
    }

    pub fn remove(&self) -> std::result::Result<(), Failure> {
        post(&format!("{}/runners/{}/remove", self.base, self.runner), Some(&self.credential), &json!({})).map(|_| ())
    }
}

/// Fetches a file's bytes.
pub fn download(url: &str) -> Result<Vec<u8>> {
    let response = agent().get(url).timeout(Duration::from_secs(300)).call().map_err(|e| anyhow!("could not download {url}: {e}"))?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut response.into_reader(), &mut bytes)?;
    Ok(bytes)
}

fn poll_body(running: &[String], wait_ms: u64, isolation: &str) -> Value {
    json!({ "version": VERSION, "running": running, "wait_ms": wait_ms, "isolation": isolation })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_poll_says_how_the_runner_is_isolated() {
        let body = poll_body(&["job_1".to_owned()], 0, "host");
        assert_eq!(body["isolation"], "host");
        assert_eq!(body["running"], json!(["job_1"]));
        assert_eq!(body["version"], VERSION);
    }

    #[test]
    fn a_poll_says_what_a_job_gets() {
        let mut body = poll_body(&[], 0, "nested-container");
        Capacity { cpus: Some(8), memory_mib: Some(12_000), docker: true, hosted_image: true }.add_to(&mut body);
        assert_eq!((body["cpus"].clone(), body["memory_mib"].clone(), body["docker"].clone()), (json!(8), json!(12_000), json!(true)));
        assert_eq!(body["hosted_image"], json!(true));
        let mut unknown = poll_body(&[], 0, "host");
        Capacity::default().add_to(&mut unknown);
        assert!(unknown["cpus"].is_null() && unknown["memory_mib"].is_null());
    }
}
