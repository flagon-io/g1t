//! Builds one state of a merge queue and checks it: the default branch with
//! a run of pull requests merged in, in queue order, tested with all of
//! their acceptance checks. The tested state is pushed to its own branch,
//! from which g1t lands it if it passed and everything ahead of it has
//! landed.
//!
//! No agent runs here. A merge that does not apply cleanly is reported as a
//! conflict, naming the pull request ahead whose change it collided with;
//! resolving it is the job of the pull request's own agent once that one
//! has landed.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `QUEUE_ENTRY`, `QUEUE_TOKEN`: where and how to report.
//! - `G1T_USER`, `G1T_TOKEN`: a member, to read the changes and push.
//! - `BASE_REMOTE`, `BASE_COMMIT`: the repository and the commit to build on.
//! - `QUEUE_BRANCH`: where to push the tested state.
//! - `STACK`: the pull requests to merge, as JSON `[{number, title, remote,
//!   branch, commit}]`, the entry being tested last.
//! - `CHECKS`: the stack's own acceptance checks, as a JSON array.
//! - `CONTRACT_CHECKS`: the checks of issues already completed, which the
//!   default branch has to keep passing. One that fails is run again on the
//!   base alone; if it fails there too, it was broken already and is not
//!   held against the stack.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::checks::{redact, run_command};
use crate::{WORKDIR, auth_option, env, git};

#[derive(Deserialize)]
struct Item {
    number: u32,
    title: String,
    remote: String,
    branch: String,
    commit: String,
}

/// What stopped a state from being built.
enum Stopped {
    /// Merging this pull request's change did not apply cleanly. The
    /// pull request ahead whose change it collided with, if one did.
    Conflict { number: u32, with: Option<u32>, files: Vec<String> },
    Failed(anyhow::Error),
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn changed_files(dir: &Path, from: &str, to: &str) -> Vec<String> {
    git(dir, &["diff", "--name-only", from, to])
        .map(|out| out.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Clones the base, then merges each pull request in order. Returns the
/// tested state's commit.
fn build(stack: &[Item], auth: &str) -> std::result::Result<String, Stopped> {
    let base_remote = env("BASE_REMOTE").map_err(Stopped::Failed)?;
    let base = env("BASE_COMMIT").map_err(Stopped::Failed)?;
    std::fs::create_dir_all("/work").map_err(|error| Stopped::Failed(error.into()))?;
    let workdir = Path::new(WORKDIR);
    git(
        Path::new("/work"),
        &["-c", auth, "clone", "--quiet", &base_remote, WORKDIR],
    )
    .and_then(|_| git(workdir, &["checkout", "--quiet", "-B", "g1t-queue", &base]))
    .and_then(|_| git(workdir, &["config", "user.name", "g1t merge queue"]))
    .and_then(|_| git(workdir, &["config", "user.email", "queue@g1t.sh"]))
    .map_err(Stopped::Failed)?;

    for (index, item) in stack.iter().enumerate() {
        git(
            workdir,
            &["-c", auth, "fetch", "--quiet", &item.remote, &item.branch],
        )
        .with_context(|| format!("could not fetch #{}", item.number))
        .map_err(Stopped::Failed)?;
        // The branch may have moved on since the queue looked; what was
        // queued is the commit, and it must be there.
        if !git_ok(workdir, &["cat-file", "-e", &format!("{}^{{commit}}", item.commit)]) {
            return Err(Stopped::Failed(anyhow::anyhow!(
                "#{}'s commit {} is no longer on its branch",
                item.number,
                &item.commit[..item.commit.len().min(12)]
            )));
        }
        let message = format!("Merge #{}: {}", item.number, item.title);
        if !git_ok(workdir, &["merge", "--quiet", "--no-edit", "-m", &message, &item.commit]) {
            let files: Vec<String> = git(workdir, &["diff", "--name-only", "--diff-filter=U"])
                .map(|out| out.lines().map(str::to_owned).collect())
                .unwrap_or_default();
            let _ = git(workdir, &["merge", "--abort"]);
            // The pull request ahead that changed one of the same files.
            let with = stack[..index]
                .iter()
                .rev()
                .find(|earlier| {
                    let theirs = changed_files(workdir, &base, &earlier.commit);
                    files.iter().any(|file| theirs.contains(file))
                })
                .map(|earlier| earlier.number);
            return Err(Stopped::Conflict {
                number: item.number,
                with,
                files,
            });
        }
    }
    git(workdir, &["rev-parse", "HEAD"])
        .map(|out| out.trim().to_owned())
        .map_err(Stopped::Failed)
}

fn report(api: &str, entry: &str, token: &str, mut body: serde_json::Value) -> Result<()> {
    body["token"] = token.into();
    ureq::post(&format!("{api}/queue/{entry}"))
        .send_json(body)
        .context("could not report the merge queue's result")?;
    Ok(())
}

pub fn main() -> i32 {
    let (api, entry, token) = match (env("G1T_API"), env("QUEUE_ENTRY"), env("QUEUE_TOKEN")) {
        (Ok(api), Ok(entry), Ok(token)) => (api, entry, token),
        _ => {
            eprintln!("g1t-runner: G1T_API, QUEUE_ENTRY and QUEUE_TOKEN must be set");
            return 2;
        }
    };
    let secrets: Vec<String> = ["G1T_TOKEN", "QUEUE_TOKEN"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| !secret.is_empty())
        .collect();
    let result = (|| -> Result<serde_json::Value> {
        let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
        let stack: Vec<Item> = serde_json::from_str(&env("STACK")?).context("STACK is not valid")?;
        if stack.is_empty() {
            bail!("nothing to merge");
        }
        let commands: Vec<String> = std::env::var("CHECKS")
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        let combined = match build(&stack, &auth) {
            Ok(combined) => combined,
            Err(Stopped::Conflict { number, with, files }) => {
                let against = with.map_or("the default branch".to_owned(), |n| format!("#{n}"));
                return Ok(serde_json::json!({
                    "error": format!(
                        "#{number} does not merge cleanly with {against}: {} conflict.",
                        files.join(", ")
                    ),
                    "conflictWith": with,
                }));
            }
            Err(Stopped::Failed(error)) => {
                return Ok(serde_json::json!({
                    "error": redact(&format!("{error:#}"), &secrets),
                }));
            }
        };
        let contract: Vec<String> = std::env::var("CONTRACT_CHECKS")
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        let workdir = Path::new(WORKDIR);
        let mut results: Vec<_> = commands
            .iter()
            .map(|command| run_command(command, workdir, &secrets))
            .collect();
        let contract_results: Vec<_> = contract
            .iter()
            .map(|command| run_command(command, workdir, &secrets))
            .collect();
        // A contract check that fails here may have been failing on the base
        // already: try those on the base alone.
        let failing: Vec<usize> = (0..contract_results.len())
            .filter(|&index| !contract_results[index].passed)
            .collect();
        let mut contract_results = contract_results;
        if !failing.is_empty() {
            let base = env("BASE_COMMIT")?;
            let combined_head = git(workdir, &["rev-parse", "HEAD"])?.trim().to_owned();
            git(workdir, &["checkout", "--quiet", "--detach", &base])?;
            for index in failing {
                let on_base = run_command(&contract_results[index].command, workdir, &secrets);
                if !on_base.passed {
                    let result = &mut contract_results[index];
                    result.passed = true;
                    result.command = format!(
                        "{} (already failing on the default branch; not held against this)",
                        result.command
                    );
                }
            }
            git(workdir, &["checkout", "--quiet", &combined_head])?;
        }
        results.extend(contract_results);
        // Pushed whether or not it passed, so a failure can be looked at.
        let branch = env("QUEUE_BRANCH")?;
        let base_remote = env("BASE_REMOTE")?;
        git(
            Path::new(WORKDIR),
            &[
                "-c",
                &auth,
                "push",
                "--quiet",
                "--force",
                &base_remote,
                &format!("HEAD:refs/heads/{branch}"),
            ],
        )
        .map_err(|error| anyhow::anyhow!("{}", redact(&format!("{error:#}"), &secrets)))
        .context("could not push the tested state")?;
        Ok(serde_json::json!({ "combinedCommit": combined, "results": results }))
    })();
    let body = result.unwrap_or_else(|error| {
        serde_json::json!({ "error": redact(&format!("{error:#}"), &secrets) })
    });
    match report(&api, &entry, &token, body) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}
