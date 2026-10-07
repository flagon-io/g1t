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
//! into issues, `queue` builds and checks a state of the merge queue,
//! `mergecheck` finds out whether a pull request merges cleanly,
//! `actions` runs one job of a GitHub Actions workflow, `backup` cuts a
//! repository's nightly backup bundle, and `bump` makes a
//! security update: one package raised in its lockfiles, pushed as g1t.
//! See the modules of those names.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `G1T_TOKEN`, `G1T_USER`: where and who to report as.
//! - `G1T_REPO`, `PULL_NUMBER`, `GIT_REMOTE`: the pull request and its fork.
//! - `PROMPT`: what the agent is asked to do.
//! - `COMMIT_MESSAGE`: used if the agent leaves changes uncommitted.
//! - `ANTHROPIC_API_KEY`: read by the harness itself.
//!
//! Every mode runs with the mining watch in `abuse`: a sandbox that looks
//! like it is mining stops itself and exits with `abuse::EXIT_CODE`.
//!
//! Given a command instead (`register`, `run`, `service`, `remove`,
//! `update`, `version`), it is a self-hosted runner on someone's own
//! machine, which runs work in these modes: see `selfhosted`.

mod abuse;
mod actions;
mod backup;
mod bump;
mod checks;
mod clone;
mod confidence;
mod deploy;
mod guard;
mod harness;
mod learned;
mod mergecheck;
mod plan;
mod progress;
mod queue;
mod reply;
mod report;
mod review;
mod revise;
mod selfhosted;
mod steer;
mod update;

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use report::{Entry, Reporter};

pub(crate) const WORKDIR: &str = "/work/repo";
/// The name and address on every commit g1t makes here, whether its agent
/// or g1t itself: `g1t_contracts::system::{USERNAME, EMAIL}`.
pub(crate) const AUTHOR_NAME: &str = "g1t";
pub(crate) const AUTHOR_EMAIL: &str = "g1t@users.noreply.g1t.sh";

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
    clone::clone(Path::new("/work"), &auth, &[], &remote, WORKDIR).context("could not clone the pull request's fork")?;
    git(workdir, &["config", "user.name", crate::AUTHOR_NAME])?;
    git(workdir, &["config", "user.email", crate::AUTHOR_EMAIL])?;
    let branch = git(workdir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let start = git(workdir, &["rev-parse", "HEAD"]).unwrap_or_default();

    // Sent back to work that is already open: start from where the branch it
    // will land on is now, so what passes here passes there too.
    if let (Ok(upstream), Ok(upstream_branch)) = (env("UPSTREAM_REMOTE"), env("UPSTREAM_BRANCH")) {
        clone::fetch(workdir, &auth, &upstream, &upstream_branch).context("could not fetch the branch this will land on")?;
        // Shallow: deep enough to tell whether it is behind, and to merge.
        clone::share_history(workdir, &auth, &[("origin", branch.as_str()), (upstream.as_str(), upstream_branch.as_str())], "HEAD", "FETCH_HEAD")?;
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

    // The agent is asked what it learned, which goes to memory, and how sure
    // it is of its change, which g1t weighs with what it observes. Neither
    // stays in the summary.
    let asked = confidence::ask(&learned::ask(&prompt));
    let summary = confidence::finish(learned::finish(harness::run_claude(workdir, &asked, reporter)?));

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
    // A self-hosted runner's commands; the modes below are what it, and
    // g1t's sandboxes, run work with.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if selfhosted::is_command(&args) {
        std::process::exit(selfhosted::main(args));
    }
    // A guarded sandbox's HTTPS is re-signed on its way out: trust that
    // before anything is fetched. The guard hook runs before every tool
    // call, so it skips this.
    if std::env::var("MODE").as_deref() == Ok("guard") {
        std::process::exit(guard::hook_main());
    }
    guard::trust_egress_ca();
    // Watches for mining for as long as the sandbox runs (abuse.rs). Not in
    // the hooks the harness runs after every tool call.
    if std::env::var("MODE").as_deref() != Ok("steer") {
        abuse::watch();
    }
    // The same image does the other jobs a sandbox is started for.
    match std::env::var("MODE").as_deref() {
        Ok("actions") => std::process::exit(actions::main()),
        Ok("backup") => std::process::exit(backup::main()),
        Ok("bump") => std::process::exit(bump::main()),
        Ok("checks") => std::process::exit(checks::main()),
        Ok("deploy") => std::process::exit(deploy::main()),
        Ok("update") => std::process::exit(update::main()),
        Ok("review") => std::process::exit(review::main()),
        Ok("revise") => std::process::exit(revise::main()),
        Ok("answer") => std::process::exit(revise::answer()),
        Ok("plan") => std::process::exit(plan::main()),
        Ok("reply") => std::process::exit(reply::main()),
        Ok("queue") => std::process::exit(queue::main()),
        Ok("mergecheck") => std::process::exit(mergecheck::main()),
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
            // Stopped at a cap: like a person's stop, the pull request is
            // left open for a person, not closed.
            if guard::is_halt(&error) {
                reporter.record(Entry::new("note", &format!("g1t stopped the agent: {error:#}.")));
                reporter.flush();
                std::process::exit(1);
            }
            reporter.record(Entry::new("note", &format!("The run failed: {error:#}")));
            reporter.flush();
            let _ = reporter.close();
            std::process::exit(1);
        }
    }
}
