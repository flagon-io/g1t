//! Runs an issue's acceptance checks against one commit and reports how
//! each went.
//!
//! The sandbox holds nothing but that commit: no agent has run here, so a
//! passing result says something about the code and not about what an
//! agent left lying around.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `CHECK_RUN`, `CHECK_TOKEN`: where and how to report.
//! - `GIT_REMOTE`, `GIT_COMMIT`: what to check out.
//! - `G1T_USER`, `G1T_TOKEN`: to read the repository, if it is private.
//! - `CHECKS`: the commands, as a JSON array.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::{WORKDIR, auth_option, env, git};

/// The longest one command may run.
const COMMAND_TIMEOUT_SECONDS: u32 = 10 * 60;
/// How much of a command's output is kept: the end, where failures are.
const MAX_OUTPUT_CHARS: usize = 12_000;
/// What `timeout` exits with when it had to stop the command.
const TIMED_OUT: i32 = 124;
const KILLED: i32 = 137;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckResult {
    pub(crate) command: String,
    pub(crate) passed: bool,
    exit_code: Option<i32>,
    output: String,
    duration_ms: u64,
}

impl CheckResult {
    pub(crate) fn output_text(&self) -> &str {
        &self.output
    }
}

/// The last `limit` characters of `text`, saying so if any were dropped.
fn tail(text: &str, limit: usize) -> String {
    let length = text.chars().count();
    if length <= limit {
        return text.to_owned();
    }
    let kept: String = text.chars().skip(length - limit).collect();
    format!("… (earlier output not shown)\n{kept}")
}

pub(crate) fn redact(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_owned(), |text, secret| {
        text.replace(secret, "[redacted]")
    })
}

/// Runs one command in the checkout, without this process's credentials.
pub(crate) fn run_command(command: &str, workdir: &Path, secrets: &[String]) -> CheckResult {
    let started = Instant::now();
    let output = Command::new("timeout")
        .args([
            "--signal=KILL",
            &COMMAND_TIMEOUT_SECONDS.to_string(),
            "sh",
            "-c",
            // One stream, in the order it was written.
            &format!("( {command}\n) 2>&1"),
        ])
        .current_dir(workdir)
        .env_remove("G1T_TOKEN")
        .env_remove("CHECK_TOKEN")
        .env_remove("DEPLOY_TOKEN")
        .stdin(Stdio::null())
        .output();
    let duration_ms = started.elapsed().as_millis() as u64;
    match output {
        Ok(output) => {
            let code = output.status.code();
            let timed_out = matches!(code, Some(TIMED_OUT | KILLED) | None);
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            if timed_out {
                text.push_str(&format!(
                    "\nStopped after {} minutes.",
                    COMMAND_TIMEOUT_SECONDS / 60
                ));
            }
            CheckResult {
                command: command.to_owned(),
                passed: output.status.success(),
                exit_code: code.filter(|_| !timed_out),
                output: redact(&tail(text.trim_end(), MAX_OUTPUT_CHARS), secrets),
                duration_ms,
            }
        }
        Err(error) => CheckResult {
            command: command.to_owned(),
            passed: false,
            exit_code: None,
            output: format!("Could not start the command: {error}"),
            duration_ms,
        },
    }
}

struct Reporter {
    url: String,
    token: String,
}

impl Reporter {
    fn send(&self, mut body: serde_json::Value) -> Result<()> {
        body["token"] = self.token.clone().into();
        ureq::post(&self.url)
            .send_json(body)
            .context("could not report the check run")?;
        Ok(())
    }
}

fn check_out(secrets: &[String]) -> Result<()> {
    let remote = env("GIT_REMOTE")?;
    let commit = env("GIT_COMMIT")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    std::fs::create_dir_all("/work")?;
    let cloned = git(
        Path::new("/work"),
        &["-c", &auth, "clone", "--quiet", &remote, WORKDIR],
    )
    .and_then(|_| {
        git(
            Path::new(WORKDIR),
            &[
                "-c",
                "advice.detachedHead=false",
                "checkout",
                "--quiet",
                &commit,
            ],
        )
    });
    if let Err(error) = cloned {
        bail!("{}", redact(&format!("{error:#}"), secrets));
    }
    Ok(())
}

pub fn main() -> i32 {
    let reporter = match (env("G1T_API"), env("CHECK_RUN"), env("CHECK_TOKEN")) {
        (Ok(api), Ok(run), Ok(token)) => Reporter {
            url: format!("{api}/checks/{run}"),
            token,
        },
        _ => {
            eprintln!("g1t-runner: G1T_API, CHECK_RUN and CHECK_TOKEN must be set");
            return 2;
        }
    };
    let secrets: Vec<String> = ["G1T_TOKEN", "CHECK_TOKEN"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| !secret.is_empty())
        .collect();
    let commands: Vec<String> = std::env::var("CHECKS")
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();

    // Says the run has started.
    if let Err(error) = reporter.send(serde_json::json!({})) {
        eprintln!("g1t-runner: {error:#}");
        return 1;
    }
    let report = match check_out(&secrets) {
        Err(error) => serde_json::json!({
            "error": format!("The commit could not be checked out: {error:#}"),
        }),
        Ok(()) => {
            let results: Vec<CheckResult> = commands
                .iter()
                .map(|command| run_command(command, Path::new(WORKDIR), &secrets))
                .collect();
            serde_json::json!({ "results": results })
        }
    };
    match reporter.send(report) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_output_keeps_its_end() {
        let text = format!("{}END", "x".repeat(50));
        let kept = tail(&text, 10);
        assert!(kept.ends_with("xxxxxxxEND"));
        assert!(kept.starts_with("… (earlier output not shown)"));
        assert_eq!(tail("short", 10), "short");
    }

    #[test]
    fn secrets_do_not_reach_a_report() {
        let secrets = vec!["g1t_secret".to_owned()];
        assert_eq!(redact("token=g1t_secret", &secrets), "token=[redacted]");
    }

    #[cfg(unix)]
    #[test]
    fn a_command_passes_or_fails_by_its_exit_code() {
        let here = std::env::temp_dir();
        let passed = run_command("echo out; echo err >&2", &here, &[]);
        assert!(passed.passed);
        assert_eq!(passed.exit_code, Some(0));
        assert_eq!(passed.output, "out\nerr");
        let failed = run_command("echo nope; exit 3", &here, &[]);
        assert!(!failed.passed);
        assert_eq!(failed.exit_code, Some(3));
        assert_eq!(failed.output, "nope");
    }
}
