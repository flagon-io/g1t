//! Has an agent review a pull request and reports what it found.
//!
//! The agent reads the change and the code around it, and writes its review
//! to a file as JSON: a verdict, a summary, and comments on lines. This
//! program posts that to g1t, which records it as a review by a g1t agent.
//! The agent never holds the credential that reports the review.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `REVIEW_RUN`, `REVIEW_TOKEN`: where and how to report.
//! - `GIT_REMOTE`, `GIT_COMMIT`: the pull request's head.
//! - `UPSTREAM_REMOTE`, `UPSTREAM_BRANCH`: what it would merge into.
//! - `G1T_USER`, `G1T_TOKEN`: to read the repository, if it is private.
//! - `PROMPT`: what the pull request is and what it is for.
//! - `AGENT_MODEL_NAME`: recorded with the review.

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::report::Reporter;
use crate::{WORKDIR, auth_option, env, git, harness};

const DIFF_FILE: &str = "/work/change.diff";
pub(crate) const REVIEW_FILE: &str = "/work/review.json";

const INSTRUCTIONS: &str = "You are reviewing a pull request. The repository is checked out in the current directory at the pull request's head. \
The change under review is in /work/change.diff; read it first, then read the surrounding code as needed. You may run the project's tests. Do not modify the repository.

Judge whether the change does what it is for, whether it is correct, and whether it would break anything. \
Be specific and brief. Comment only on real problems or things a maintainer would want to know; do not praise, and do not restate the diff.

Write your review to /work/review.json as JSON with exactly this shape:

{
  \"verdict\": \"approve\" or \"request_changes\",
  \"body\": \"A summary in Markdown: what you checked and your conclusion.\",
  \"comments\": [
    { \"path\": \"path/in/the/repository\", \"line\": 12, \"body\": \"What is wrong on this line and what to do about it.\" }
  ]
}

`line` is the line number in the file as it is after the change. `comments` may be empty. \
Use \"request_changes\" only if something must be fixed before merging. Then finish.";

fn review() -> Result<Value> {
    let remote = env("GIT_REMOTE")?;
    let commit = env("GIT_COMMIT")?;
    let upstream = env("UPSTREAM_REMOTE")?;
    let upstream_branch = env("UPSTREAM_BRANCH")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);

    std::fs::create_dir_all("/work")?;
    crate::clone::clone(Path::new("/work"), &auth, &[], &remote, WORKDIR).context("could not clone the pull request")?;
    let head = git(workdir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    crate::clone::ensure(workdir, &auth, "origin", &head, &commit)?;
    git(
        workdir,
        &[
            "-c",
            "advice.detachedHead=false",
            "checkout",
            "--quiet",
            &commit,
        ],
    )?;
    crate::clone::fetch(workdir, &auth, &upstream, &upstream_branch).with_context(|| format!("could not fetch {upstream_branch}"))?;
    // Shallow: deep enough to find where the pull request left the branch.
    crate::clone::share_history(workdir, &auth, &[("origin", head.as_str()), (upstream.as_str(), upstream_branch.as_str())], "HEAD", "FETCH_HEAD")?;
    // The change is everything since the pull request left the branch.
    let base = git(workdir, &["merge-base", "FETCH_HEAD", "HEAD"])?;
    let diff = git(workdir, &["diff", &base, "HEAD"])?;
    if diff.trim().is_empty() {
        bail!("the pull request changes nothing");
    }
    std::fs::write(DIFF_FILE, diff)?;

    let prompt = format!("{}\n\n{INSTRUCTIONS}", env("PROMPT")?);
    // A review has no session of its own; what matters is what it concludes.
    let mut reporter = Reporter::silent();
    let summary = harness::run_claude(workdir, &prompt, &mut reporter)?;

    let written = std::fs::read_to_string(REVIEW_FILE).unwrap_or_default();
    let mut review: Value = match serde_json::from_str(&written) {
        Ok(review @ Value::Object(_)) => review,
        // The agent answered without writing the file: its answer is the review.
        _ => json!({ "body": summary, "comments": [] }),
    };
    if !matches!(
        review["verdict"].as_str(),
        Some("approve" | "request_changes")
    ) {
        review["verdict"] = Value::Null;
    }
    Ok(review)
}

pub fn main() -> i32 {
    let (Ok(api), Ok(run), Ok(token)) = (env("G1T_API"), env("REVIEW_RUN"), env("REVIEW_TOKEN"))
    else {
        eprintln!("g1t-runner: G1T_API, REVIEW_RUN and REVIEW_TOKEN must be set");
        return 2;
    };
    let secrets: Vec<String> = ["G1T_TOKEN", "REVIEW_TOKEN", "ANTHROPIC_API_KEY"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| !secret.is_empty())
        .collect();
    let redact = |text: String| {
        secrets
            .iter()
            .fold(text, |text, secret| text.replace(secret, "[redacted]"))
    };

    let outcome = review();
    let report = match &outcome {
        Ok(review) => review.clone(),
        Err(error) => json!({ "error": format!("{error:#}") }),
    };
    // Whatever the agent wrote passes through here, so nothing it could
    // have read from its environment leaves in a review. The run's own
    // token is added afterwards: it is what authorises the report.
    let mut report: Value =
        serde_json::from_str(&redact(report.to_string())).unwrap_or_else(|_| json!({}));
    report["token"] = token.into();
    if let Ok(model) = std::env::var("AGENT_MODEL_NAME") {
        report["model"] = model.into();
    }
    if let Err(error) = ureq::post(&format!("{api}/reviews/{run}")).send_json(report) {
        eprintln!("g1t-runner: could not report the review: {error:#}");
        return 1;
    }
    i32::from(outcome.is_err())
}
