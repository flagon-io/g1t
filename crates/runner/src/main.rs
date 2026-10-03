//! Runs a coding agent on one pull request and reports back to g1t.
//!
//! This is the program a hosted sandbox starts. It clones the pull
//! request's fork, runs the agent harness headless, streams what the agent
//! does into the pull request's session as it happens, pushes the result
//! and marks the pull request ready for review. It talks to g1t only through the public API and git, exactly
//! as an agent on someone's own machine would.
//!
//! `MODE` selects another job instead: `checks` runs acceptance checks,
//! `update` brings a pull request up to date with its target branch,
//! `review` has an agent review one, and `revise` sends the author back to
//! address what the checks or a review found, `plan` turns an outcome
//! into issues, `queue` builds and checks a state of the merge queue, and
//! `actions` runs one job of a GitHub Actions workflow.
//! See the modules of those names.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `G1T_TOKEN`, `G1T_USER`: where and who to report as.
//! - `G1T_REPO`, `PULL_NUMBER`, `GIT_REMOTE`: the pull request and its fork.
//! - `PROMPT`: what the agent is asked to do.
//! - `COMMIT_MESSAGE`: used if the agent leaves changes uncommitted.
//! - `ANTHROPIC_API_KEY`: read by the harness itself.

mod actions;
mod checks;
mod harness;
mod plan;
mod queue;
mod report;
mod review;
mod revise;
mod steer;
mod update;

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use report::{Entry, Reporter};

pub(crate) const WORKDIR: &str = "/work/repo";

pub(crate) fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

/// Runs git and returns its trimmed output, failing on a non-zero exit.
pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String> {
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
pub(crate) fn auth_option(user: &str, token: &str) -> String {
    let credentials = STANDARD.encode(format!("{user}:{token}"));
    format!("http.extraHeader=Authorization: Basic {credentials}")
}

/// Clones the fork, runs the agent on `PROMPT`, commits and pushes what it
/// did, and returns its closing summary.
pub(crate) fn run(reporter: &mut Reporter) -> Result<String> {
    let mut prompt = env("PROMPT")?;
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

    // Sent back to work that is already open: start from where the branch it
    // will land on is now, so what passes here passes there too.
    if let (Ok(upstream), Ok(upstream_branch)) = (env("UPSTREAM_REMOTE"), env("UPSTREAM_BRANCH")) {
        git(
            workdir,
            &["-c", &auth, "fetch", "--quiet", &upstream, &upstream_branch],
        )
        .context("could not fetch the branch this will land on")?;
        let behind = Command::new("git")
            .current_dir(workdir)
            .args(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"])
            .status()
            .is_ok_and(|status| !status.success());
        if behind {
            let message = format!("Catch up with {upstream_branch}");
            let merged = Command::new("git")
                .current_dir(workdir)
                .args(["merge", "--quiet", "--no-edit", "-m", &message, "FETCH_HEAD"])
                .status()
                .is_ok_and(|status| status.success());
            if merged {
                reporter.record(Entry::new(
                    "note",
                    &format!("Merged in the latest {upstream_branch} before starting."),
                ));
            } else {
                let files = git(workdir, &["diff", "--name-only", "--diff-filter=U"])?;
                let files: Vec<&str> = files.lines().collect();
                reporter.record(Entry::new(
                    "note",
                    &format!(
                        "Merged in the latest {upstream_branch} before starting; {} conflict.",
                        files.join(", ")
                    ),
                ));
                prompt.push_str(&format!(
                    "\n\nBefore you started, the latest {upstream_branch} was merged into this branch, and these files conflict: {}. Resolve the conflicts first, keeping what both sides meant, then address the points above. Leave no conflict markers.",
                    files.join(", ")
                ));
            }
            reporter.flush();
        }
    }

    let summary = harness::run_claude(workdir, &prompt, reporter)?;

    // Commit whatever the agent left in the working tree.
    if !git(workdir, &["status", "--porcelain"])?.is_empty() {
        let message = std::env::var("COMMIT_MESSAGE").unwrap_or_else(|_| "Agent changes".into());
        git(workdir, &["add", "--all"])?;
        git(workdir, &["commit", "--quiet", "--message", &message])?;
    }
    let head = git(workdir, &["rev-parse", "HEAD"])?;
    if head == start {
        // An agent woken to answer usually only answers.
        if std::env::var("MODE").as_deref() == Ok("answer") {
            return Ok(summary);
        }
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
    // The same image does the other jobs a sandbox is started for.
    match std::env::var("MODE").as_deref() {
        Ok("actions") => std::process::exit(actions::main()),
        Ok("checks") => std::process::exit(checks::main()),
        Ok("update") => std::process::exit(update::main()),
        Ok("review") => std::process::exit(review::main()),
        Ok("revise") => std::process::exit(revise::main()),
        Ok("answer") => std::process::exit(revise::answer()),
        Ok("plan") => std::process::exit(plan::main()),
        Ok("queue") => std::process::exit(queue::main()),
        Ok("steer") => std::process::exit(steer::main()),
        _ => {}
    }
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
