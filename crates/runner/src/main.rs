//! Runs a coding agent on one pull request and reports back to g1t.
//!
//! This is the program a hosted sandbox starts. It clones the pull
//! request's fork, runs the agent harness headless, streams what the agent
//! does into the pull request's session as it happens, pushes the result
//! and marks the pull request ready for review. It talks to g1t only through the public API and git, exactly
//! as an agent on someone's own machine would.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `G1T_TOKEN`, `G1T_USER`: where and who to report as.
//! - `G1T_REPO`, `PULL_NUMBER`, `GIT_REMOTE`: the pull request and its fork.
//! - `PROMPT`: what the agent is asked to do.
//! - `COMMIT_MESSAGE`: used if the agent leaves changes uncommitted.
//! - `ANTHROPIC_API_KEY`: read by the harness itself.

mod harness;
mod report;

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use report::{Entry, Reporter};

const WORKDIR: &str = "/work/repo";

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

/// Runs git and returns its trimmed output, failing on a non-zero exit.
fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .context("could not run git")?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// A git option that authenticates one command. The credential is passed
/// per command and never written to the clone's config or its remote URL,
/// where the agent would find it.
fn auth_option(user: &str, token: &str) -> String {
    let credentials = STANDARD.encode(format!("{user}:{token}"));
    format!("http.extraHeader=Authorization: Basic {credentials}")
}

fn run(reporter: &mut Reporter) -> Result<String> {
    let prompt = env("PROMPT")?;
    let remote = env("GIT_REMOTE")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);

    if let Ok(model) = std::env::var("AGENT_MODEL_NAME") {
        reporter.record(Entry::new("note", &format!("Running on {model}.")));
    }
    reporter.record(Entry::new("prompt", &prompt));
    reporter.flush();

    std::fs::create_dir_all("/work")?;
    git(
        Path::new("/work"),
        &["-c", &auth, "clone", "--quiet", &remote, WORKDIR],
    )
    .context("could not clone the pull request's fork")?;
    git(workdir, &["config", "user.name", "g1t agent"])?;
    git(workdir, &["config", "user.email", "agent@g1t.sh"])?;
    let branch = git(workdir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let start = git(workdir, &["rev-parse", "HEAD"]).unwrap_or_default();

    let summary = harness::run_claude(workdir, &prompt, reporter)?;

    // Commit whatever the agent left in the working tree.
    if !git(workdir, &["status", "--porcelain"])?.is_empty() {
        let message = std::env::var("COMMIT_MESSAGE").unwrap_or_else(|_| "Agent changes".into());
        git(workdir, &["add", "--all"])?;
        git(workdir, &["commit", "--quiet", "--message", &message])?;
    }
    let head = git(workdir, &["rev-parse", "HEAD"])?;
    if head == start {
        bail!("the agent finished without changing anything");
    }
    git(
        workdir,
        &[
            "-c",
            &auth,
            "push",
            "--quiet",
            "origin",
            &format!("HEAD:{branch}"),
        ],
    )
    .context("could not push the pull request's commits")?;
    reporter.record(Entry::new(
        "note",
        &format!("Pushed {}.", &head[..head.len().min(12)]),
    ));
    Ok(summary)
}

fn main() {
    let mut reporter = match Reporter::from_env() {
        Ok(reporter) => reporter,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            std::process::exit(2);
        }
    };
    match run(&mut reporter) {
        Ok(summary) => {
            reporter.flush();
            if let Err(error) = reporter.ready(&summary) {
                eprintln!("g1t-runner: could not mark the pull request ready: {error:#}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            reporter.record(Entry::new("note", &format!("The run failed: {error:#}")));
            reporter.flush();
            let _ = reporter.close();
            std::process::exit(1);
        }
    }
}
