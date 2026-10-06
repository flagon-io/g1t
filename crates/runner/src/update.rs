//! Brings a pull request up to date with the branch it would merge into.
//!
//! When that branch has moved, the pull request cannot merge until it holds
//! the new commits. This merges them in. If the merge is clean that is all;
//! if it conflicts, the agent is given the conflicted files and what the
//! pull request is for, and resolves them. Either way the result is pushed
//! and everything done is recorded in the pull request's session.
//!
//! Configuration, beyond what a session needs (see `main`):
//!
//! - `GIT_REMOTE`, `GIT_BRANCH`: the pull request's source.
//! - `UPSTREAM_REMOTE`, `UPSTREAM_BRANCH`: what it would merge into.
//! - `PROMPT`: what the pull request is for, given to the agent on a conflict.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::report::{Entry, Reporter};
use crate::{WORKDIR, auth_option, env, git, harness};

/// Runs git and says whether it succeeded, for commands whose failure is
/// an answer and not an error.
fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(12)]
}

/// The files a stopped merge left in conflict.
fn conflicted(workdir: &Path) -> Result<Vec<String>> {
    Ok(git(workdir, &["diff", "--name-only", "--diff-filter=U"])?
        .lines()
        .map(str::to_owned)
        .collect())
}

/// Whether a file still holds the markers git writes around a conflict.
fn has_markers(workdir: &Path, file: &str) -> bool {
    std::fs::read_to_string(workdir.join(file)).is_ok_and(|text| {
        text.lines()
            .any(|line| line.starts_with("<<<<<<< ") || line.starts_with(">>>>>>> "))
    })
}

fn update(reporter: &mut Reporter) -> Result<()> {
    let remote = env("GIT_REMOTE")?;
    let branch = env("GIT_BRANCH")?;
    let upstream = env("UPSTREAM_REMOTE")?;
    let upstream_branch = env("UPSTREAM_BRANCH")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);

    std::fs::create_dir_all("/work")?;
    crate::clone::clone(Path::new("/work"), &auth, &["--branch", &branch], &remote, WORKDIR).context("could not clone the pull request")?;
    git(workdir, &["config", "user.name", "g1t agent"])?;
    git(workdir, &["config", "user.email", "agent@g1t.sh"])?;
    crate::clone::fetch(workdir, &auth, &upstream, &upstream_branch).with_context(|| format!("could not fetch {upstream_branch}"))?;
    // Shallow: deep enough to tell whether it is behind, and to merge.
    crate::clone::share_history(workdir, &auth, &[("origin", branch.as_str()), (upstream.as_str(), upstream_branch.as_str())], "HEAD", "FETCH_HEAD")?;
    let theirs = git(workdir, &["rev-parse", "FETCH_HEAD"])?;

    if git_ok(
        workdir,
        &["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
    ) {
        reporter.record(Entry::new(
            "note",
            &format!("Already up to date with {upstream_branch}."),
        ));
        return Ok(());
    }
    reporter.record(Entry::new(
        "note",
        &format!(
            "{upstream_branch} has moved to {}. Merging it into this pull request.",
            short(&theirs)
        ),
    ));
    reporter.flush();

    let message = format!("Catch up with {upstream_branch}");
    if !git_ok(
        workdir,
        &["merge", "--no-edit", "-m", &message, "FETCH_HEAD"],
    ) {
        let files = conflicted(workdir)?;
        if files.is_empty() {
            bail!("the merge failed for a reason other than a conflict");
        }
        reporter.record(Entry::new(
            "note",
            &format!("The merge conflicts in: {}.", files.join(", ")),
        ));
        let prompt = format!(
            "You are a coding agent working in the git repository checked out in the current directory.\n\n\
             A merge of `{upstream_branch}` into this pull request's branch has stopped with conflicts in:\n{}\n\n\
             What this pull request is for:\n\n{}\n\n\
             Resolve every conflict so that the result keeps what `{upstream_branch}` changed and what this pull request set out to do. \
             Read both sides before choosing; do not simply take one. Remove all conflict markers. \
             If the project has tests, run them. Then stage the files with `git add`. Do not commit and do not push; that is done for you. \
             Finish with one or two sentences on how you resolved each conflict.",
            files
                .iter()
                .map(|file| format!("- {file}"))
                .collect::<Vec<_>>()
                .join("\n"),
            std::env::var("PROMPT").unwrap_or_default(),
        );
        reporter.record(Entry::new("prompt", &prompt));
        reporter.flush();
        let summary = harness::run_claude(workdir, &prompt, reporter)?;
        reporter.record(Entry::new("message", &summary));

        git(workdir, &["add", "--all"])?;
        let unresolved = conflicted(workdir)?;
        if !unresolved.is_empty() || files.iter().any(|file| has_markers(workdir, file)) {
            bail!("conflicts remain after the agent's attempt to resolve them");
        }
        git(workdir, &["commit", "--quiet", "--no-edit"])
            .context("could not conclude the merge")?;
        reporter.record(Entry::new(
            "note",
            &format!("Resolved the conflicts in {}.", files.join(", ")),
        ));
    }

    let head = git(workdir, &["rev-parse", "HEAD"])?;
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
    .context("could not push the updated pull request")?;
    reporter.record(Entry::new(
        "note",
        &format!(
            "Pushed {}. This pull request now contains {upstream_branch}.",
            short(&head)
        ),
    ));
    Ok(())
}

pub fn main() -> i32 {
    let mut reporter = match Reporter::from_env() {
        Ok(reporter) => reporter,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            return 2;
        }
    };
    let outcome = update(&mut reporter);
    if let Err(error) = &outcome {
        eprintln!("g1t-runner: {error:#}");
        reporter.record(Entry::new(
            "note",
            &format!("Catching up failed: {error:#}. Nothing was pushed."),
        ));
    }
    reporter.flush();
    i32::from(outcome.is_err())
}
