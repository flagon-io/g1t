//! Downloading workflow logs, at GitHub's addresses: a run's (or one
//! attempt's) as a zip archive, and one job's as plain text.
//!
//! - `GET /repos/{owner}/{repo}/actions/runs/{id}/logs`
//! - `GET /repos/{owner}/{repo}/actions/runs/{id}/attempts/{attempt}/logs`
//! - `GET /repos/{owner}/{repo}/actions/jobs/{job}/logs?format=text`
//!
//! The archive holds `{n}_{job}.txt`, each job's whole log, and a folder
//! per job with `{step}_{step name}.txt` for each step, as GitHub's does.
//! Who may read the run may download its logs; a token needs the scope
//! `get_job_logs` needs.

use g1t_contracts::actions::{JobLogText, JobLogTextArgs, RunLogsArgs};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::json;
use worker::{Response, Result};

use crate::operations::Op;
use crate::operations::Services;
use crate::{audit, fail, failure};

/// What a download path asks for.
#[derive(Debug, PartialEq)]
pub enum Wanted<'a> {
    Run { owner: &'a str, repo: &'a str, id: &'a str, attempt: Option<u64> },
    Job { owner: &'a str, repo: &'a str, job: &'a str },
}

/// The download a `GET` path (and its query) asks for, if it is one.
pub fn wanted<'a>(path: &'a str, text: bool) -> Option<Wanted<'a>> {
    let parts: Vec<&str> = path.strip_prefix("/repos/")?.trim_end_matches('/').split('/').collect();
    match parts.as_slice() {
        [owner, repo, "actions", "runs", id, "logs"] => Some(Wanted::Run { owner, repo, id, attempt: None }),
        [owner, repo, "actions", "runs", id, "attempts", attempt, "logs"] => {
            Some(Wanted::Run { owner, repo, id, attempt: Some(attempt.parse().ok()?) })
        }
        [owner, repo, "actions", "jobs", job, "logs"] if text => Some(Wanted::Job { owner, repo, job }),
        _ => None,
    }
}

/// A name safe as a file name in an archive: no slashes or characters
/// Windows refuses, at most 100 characters.
pub fn file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .take(100)
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() { "job".to_owned() } else { trimmed.to_owned() }
}

/// A job's log as one text, in order.
pub fn job_text(job: &JobLogText) -> String {
    if job.omitted {
        return "This job's log was left out: the run's logs are larger than one download holds. Download it on its own.\n".to_owned();
    }
    job.chunks.iter().map(|chunk| chunk.text.as_str()).collect()
}

/// The files of a run's log archive, in order.
pub fn archive_files(jobs: &[JobLogText]) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for (index, job) in jobs.iter().enumerate() {
        let name = file_name(&job.name);
        files.push((format!("{}_{name}.txt", index + 1), job_text(job)));
        if job.omitted {
            continue;
        }
        let mut steps: Vec<u32> = job.chunks.iter().map(|chunk| chunk.step).collect();
        steps.sort_unstable();
        steps.dedup();
        for step in steps {
            let title = if step == 0 {
                "Set up job".to_owned()
            } else {
                job.steps.iter().find(|s| s.number == step).map_or_else(|| format!("Step {step}"), |s| s.name.clone())
            };
            let text: String = job.chunks.iter().filter(|chunk| chunk.step == step).map(|chunk| chunk.text.as_str()).collect();
            files.push((format!("{name}/{}_{}.txt", step, file_name(&title)), text));
        }
    }
    files
}

const CRC_POLY: u32 = 0xedb8_8320;

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ CRC_POLY } else { crc >> 1 };
        }
    }
    !crc
}

/// A zip archive of `files`, stored (not compressed), with UTF-8 names.
/// Logs are small next to the 4 GB zip64 would be needed for.
pub fn zip(files: &[(String, String)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, text) in files {
        let data = text.as_bytes();
        let crc = crc32(data);
        let offset = out.len() as u32;
        let size = data.len() as u32;
        let name = name.as_bytes();
        // Local file header: version 2.0, UTF-8 names (bit 11), stored.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0x21u16.to_le_bytes()); // 1980-01-01
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name);
        out.extend_from_slice(data);
        // Its central directory entry.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0x21u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 12]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let start = out.len() as u32;
    let count = files.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn attachment(bytes: Vec<u8>, content_type: &str, file: &str) -> Result<Response> {
    let mut response = Response::from_bytes(bytes)?;
    let headers = response.headers_mut();
    headers.set("content-type", content_type)?;
    headers.set("content-disposition", &format!("attachment; filename=\"{}\"", file.replace('"', "")))?;
    headers.set("cache-control", "no-store")?;
    Ok(response)
}

/// Answers a download `wanted` names, for `viewer`.
pub async fn download(services: &Services, viewer: &Viewer, wanted: Wanted<'_>) -> Result<Response> {
    let (owner, repo) = match &wanted {
        Wanted::Run { owner, repo, .. } | Wanted::Job { owner, repo, .. } => (*owner, *repo),
    };
    // A workflow job's token reaches its own repository only, and any
    // token needs what reading a job's log needs.
    if viewer.as_ref().and_then(|user| user.token.as_deref()).is_some_and(|token| !token.reaches(&format!("{owner}/{repo}"))) {
        return fail(FailureCode::NotFound, "There is no such repository.");
    }
    let input = json!({ "repo": format!("{owner}/{repo}") });
    if let Some(scope) = audit::missing_scope(Op::GetJobLogs, viewer, &input) {
        return Ok(Response::from_json(&json!({
            "error": { "code": FailureCode::Forbidden, "message": "This token cannot read workflow logs.", "needed_scope": scope.as_str() }
        }))?
        .with_status(403));
    }
    let path = RepoPath { namespace: owner.to_owned(), name: repo.to_owned() };
    match wanted {
        Wanted::Run { id, attempt, .. } => {
            let logs: Outcome<Vec<JobLogText>> =
                g1t_kit::call(&services.actions, "run_logs", &RunLogsArgs { repo: path, viewer: viewer.clone(), id: id.to_owned(), attempt }).await?;
            match logs {
                Outcome::Ok(jobs) => {
                    let file = match attempt {
                        Some(n) => format!("logs_{id}_attempt_{n}.zip"),
                        None => format!("logs_{id}.zip"),
                    };
                    attachment(zip(&archive_files(&jobs)), "application/zip", &file)
                }
                Outcome::Fail(refused) => failure(&refused),
            }
        }
        Wanted::Job { job, .. } => {
            let log: Outcome<JobLogText> =
                g1t_kit::call(&services.actions, "job_log_text", &JobLogTextArgs { repo: path, viewer: viewer.clone(), job: job.to_owned() }).await?;
            match log {
                Outcome::Ok(log) => attachment(job_text(&log).into_bytes(), "text/plain; charset=utf-8", &format!("{}.txt", file_name(&log.name))),
                Outcome::Fail(refused) => failure(&refused),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use g1t_contracts::actions::{JobLogText, LogChunk, StepState};

    use super::*;

    fn job(name: &str, chunks: &[(u32, &str)]) -> JobLogText {
        JobLogText {
            job_id: "job_1".into(),
            name: name.into(),
            steps: vec![StepState { number: 1, name: "Run cargo test".into(), ..StepState::default() }],
            chunks: chunks.iter().enumerate().map(|(i, (step, text))| LogChunk { seq: i as u64 + 1, step: *step, text: (*text).into() }).collect(),
            done: true,
            omitted: false,
        }
    }

    #[test]
    fn download_paths_are_githubs() {
        assert_eq!(
            wanted("/repos/acme/web/actions/runs/run_1/logs", false),
            Some(Wanted::Run { owner: "acme", repo: "web", id: "run_1", attempt: None })
        );
        assert_eq!(
            wanted("/repos/acme/web/actions/runs/run_1/attempts/2/logs", false),
            Some(Wanted::Run { owner: "acme", repo: "web", id: "run_1", attempt: Some(2) })
        );
        assert_eq!(wanted("/repos/acme/web/actions/runs/run_1/attempts/x/logs", false), None);
        // A job's log is text when asked for; otherwise the JSON operation answers.
        assert_eq!(wanted("/repos/acme/web/actions/jobs/job_1/logs", false), None);
        assert_eq!(wanted("/repos/acme/web/actions/jobs/job_1/logs", true), Some(Wanted::Job { owner: "acme", repo: "web", job: "job_1" }));
        assert_eq!(wanted("/repos/acme/web/actions/runs/run_1", false), None);
    }

    #[test]
    fn names_are_safe_in_an_archive() {
        assert_eq!(file_name("test (ubuntu-latest, 20)"), "test (ubuntu-latest, 20)");
        assert_eq!(file_name("build / a:b"), "build _ a_b");
        assert_eq!(file_name(".."), "job");
        assert_eq!(file_name(&"x".repeat(300)).len(), 100);
    }

    #[test]
    fn an_archive_has_each_job_whole_and_by_step() {
        let jobs = [job("test", &[(0, "set up\n"), (1, "running\n"), (1, "ok\n")]), JobLogText { omitted: true, ..job("deploy/x", &[]) }];
        let files = archive_files(&jobs);
        let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["1_test.txt", "test/0_Set up job.txt", "test/1_Run cargo test.txt", "2_deploy_x.txt"]);
        assert_eq!(files[0].1, "set up\nrunning\nok\n");
        assert_eq!(files[2].1, "running\nok\n");
        assert!(files[3].1.contains("left out"));
    }

    #[test]
    fn the_archive_is_a_zip() {
        let bytes = zip(&[("a.txt".into(), "hello".into()), ("dir/b.txt".into(), String::new())]);
        assert_eq!(&bytes[..4], &[0x50, 0x4b, 0x03, 0x04]);
        // The end of the central directory names both files.
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], &[0x50, 0x4b, 0x05, 0x06]);
        assert_eq!(u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]), 2);
        assert_eq!(crc32(b"hello"), 0x3610_a686);
        assert_eq!(crc32(b""), 0);
    }
}
