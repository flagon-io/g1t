//! The program inside a g1t sandbox: it does one piece of work and
//! reports back to g1t.
//!
//! `MODE` selects the work: `actions` runs one job of a GitHub Actions
//! workflow, `queue` builds and checks a state of the merge queue,
//! `mergecheck` finds out whether a pull request merges cleanly, `deploy`
//! builds a commit for g1t.page, `bump` makes a dependency update (one
//! package raised in its lockfiles, pushed as g1t), `backup` cuts a
//! repository's nightly backup bundle, and `checks` runs an issue's
//! commands, from before checks were workflows. See the modules of those
//! names. It talks to g1t only through the public API and git.
//!
//! Every mode runs with the mining watch in `abuse`: a sandbox that looks
//! like it is mining stops itself and exits with `abuse::EXIT_CODE`.
//!
//! Given a command instead (`register`, `run`, `service`, `remove`,
//! `update`, `version`), it is a self-hosted runner on someone's own
//! machine, which runs work in these modes: see `selfhosted`.
//!
//! `deploy` and `detect` are for a workflow step: a g1t.page build of the
//! job's own checkout, and what that build would find (see `deploy`).

mod abuse;
mod actions;
mod backup;
mod bump;
mod checks;
mod clone;
mod deploy;
mod docker;
mod guard;
mod mergecheck;
mod queue;
mod selfhosted;

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

pub(crate) const WORKDIR: &str = "/work/repo";
/// The name and address on every commit g1t makes here:
/// `g1t_contracts::system::{USERNAME, EMAIL}`.
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
/// where the work's own commands would find it.
pub(crate) fn auth_option(user: &str, token: &str) -> String {
    let credentials = STANDARD.encode(format!("{user}:{token}"));
    format!("http.extraHeader=Authorization: Basic {credentials}")
}

fn main() {
    // The runc the job's Docker Engine starts containers with (docker/oci.rs).
    if docker::oci::invoked_as_runc() {
        docker::oci::main();
    }
    // A self-hosted runner's commands; the modes below are what it, and
    // g1t's sandboxes, run work with.
    let args: Vec<String> = std::env::args().skip(1).collect();
    // From a workflow step: a g1t.page build of the job's own checkout,
    // and what it would find (deploy.rs).
    match args.first().map(String::as_str) {
        Some("deploy") => std::process::exit(deploy::cli(&args[1..])),
        Some("detect") => std::process::exit(deploy::detect_cli(&args[1..])),
        _ => {}
    }
    if selfhosted::is_command(&args) {
        std::process::exit(selfhosted::main(args));
    }
    // A sandbox whose HTTPS passes the Worker has it re-signed: trust that
    // before anything is fetched.
    guard::trust_egress_ca();
    // Watches for mining for as long as the sandbox runs (abuse.rs).
    abuse::watch();
    // The work a sandbox is started for.
    let code = match std::env::var("MODE").as_deref() {
        Ok("actions") => actions::main(),
        Ok("backup") => backup::main(),
        Ok("bump") => bump::main(),
        Ok("checks") => checks::main(),
        Ok("deploy") => deploy::main(),
        Ok("queue") => queue::main(),
        Ok("mergecheck") => mergecheck::main(),
        // Work g1t no longer does (an agent's run, a review, a plan, a
        // catch-up merge), handed over by an older g1t: refused, saying so.
        Ok(mode) => {
            eprintln!("g1t-runner: this runner does not do work of mode {mode}");
            2
        }
        Err(_) => {
            eprintln!("g1t-runner: MODE is not set: nothing to do");
            2
        }
    };
    std::process::exit(code);
}
