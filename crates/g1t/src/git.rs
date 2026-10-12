//! Running git, and reading what the current repository says.

use std::process::{Command, Stdio};

use crate::error::{Error, Result};

/// Runs git and returns its output, trimmed.
pub fn run(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::failed(format!("Could not run git: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let line = stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim();
        return Err(Error::failed(format!(
            "git {} failed: {line}",
            args.join(" ")
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned())
}

/// Runs git with its output on the terminal, as for a clone or a push.
pub fn run_visible(args: &[&str]) -> Result<()> {
    let status = Command::new("git")
        .args(args)
        .status()
        .map_err(|e| Error::failed(format!("Could not run git: {e}")))?;
    if !status.success() {
        return Err(Error::exit(crate::error::Kind::Failed));
    }
    Ok(())
}

pub fn ok(args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The remotes, in the order git lists them, with their fetch URLs.
pub fn remotes() -> Vec<(String, String)> {
    let Ok(out) = run(&["remote", "-v"]) else {
        return Vec::new();
    };
    let mut seen = Vec::<(String, String)>::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else {
            continue;
        };
        if line.ends_with("(fetch)") && !seen.iter().any(|(n, _)| n == name) {
            seen.push((name.to_owned(), url.to_owned()));
        }
    }
    seen
}

pub fn current_branch() -> Option<String> {
    run(&["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty())
}

/// The commits on `head` that `base` lacks, oldest first: (subject, body).
pub fn commits_between(base: &str, head: &str) -> Vec<(String, String)> {
    let range = format!("{base}..{head}");
    let Ok(out) = run(&["log", "--reverse", "--format=%s%x1f%b%x1e", &range]) else {
        return Vec::new();
    };
    out.split('\u{1e}')
        .filter_map(|entry| {
            let entry = entry.trim_matches(['\n', '\r']);
            let (subject, body) = entry.split_once('\u{1f}')?;
            Some((subject.trim().to_owned(), body.trim().to_owned()))
        })
        .collect()
}
