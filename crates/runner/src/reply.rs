//! Answers a question someone asked `@g1t` in a comment, in the
//! thread it was asked in, changing nothing.
//!
//! The agent reads the repository as it is (the default branch for an
//! issue, the pull request's head for a pull request) and writes its answer
//! to a file. This program posts the answer as `g1t`, with the
//! agent's own token, which the agent itself never holds.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `G1T_REPO`, `REPLY_NUMBER`: where the question was asked.
//! - `G1T_AGENT_TOKEN`: g1t's token for this run, to post the answer.
//! - `GIT_REMOTE`, `GIT_REF`: what to read, and at which branch or commit.
//! - `G1T_USER`, `G1T_TOKEN`: to read it, if it is private.
//! - `PROMPT`: the question and what the agent is told around it.

use std::path::Path;

use anyhow::{Context, Result, bail};

use crate::report::Reporter;
use crate::{WORKDIR, auth_option, env, git, harness};

const ANSWER_FILE: &str = "/work/answer.md";
const MAX_ANSWER_CHARS: usize = 20_000;

const INSTRUCTIONS: &str = "Write your answer to /work/answer.md as Markdown, addressed to whoever asked: \
plain sentences, specific, naming files and functions where that helps, no headings and no emoji. \
Read the code before you answer; say so when you are not sure. Do not change any file in the repository, \
and do not post the answer with add_comment: it is posted in the thread for you. Then finish.";

fn answer() -> Result<String> {
    let remote = env("GIT_REMOTE")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);
    std::fs::create_dir_all("/work")?;
    crate::clone::clone(Path::new("/work"), &auth, &[], &remote, WORKDIR).context("could not clone the repository")?;
    if let Ok(reference) = env("GIT_REF")
        && !reference.is_empty()
    {
        // A commit the clone may not have fetched by name: fetch it, and
        // everything if that is refused.
        if crate::clone::fetch(workdir, &auth, "origin", &reference).is_err() && crate::clone::is_shallow(workdir) {
            let _ = git(workdir, &["-c", &auth, "fetch", "--quiet", "--unshallow", "origin"]);
        }
        git(workdir, &["checkout", "--quiet", "--detach", &reference])
            .or_else(|_| git(workdir, &["checkout", "--quiet", "--detach", "FETCH_HEAD"]))
            .context("could not check out what the question is about")?;
    }
    let prompt = format!("{}\n\n{INSTRUCTIONS}", env("PROMPT")?);
    // Steps show on the agent run; the answer is what matters here.
    let mut reporter = Reporter::silent();
    let summary = harness::run_claude(workdir, &prompt, &mut reporter)?;
    let written = std::fs::read_to_string(ANSWER_FILE).unwrap_or_default();
    let answer = if written.trim().is_empty() { summary } else { written };
    let answer: String = answer.trim().chars().take(MAX_ANSWER_CHARS).collect();
    if answer.is_empty() {
        bail!("the agent wrote no answer");
    }
    Ok(answer)
}

pub fn main() -> i32 {
    let (Ok(api), Ok(repo), Ok(number), Ok(token)) = (
        env("G1T_API"),
        env("G1T_REPO"),
        env("REPLY_NUMBER"),
        env("G1T_AGENT_TOKEN"),
    ) else {
        eprintln!("g1t-runner: G1T_API, G1T_REPO, REPLY_NUMBER and G1T_AGENT_TOKEN must be set");
        return 2;
    };
    let secrets: Vec<String> = ["G1T_TOKEN", "G1T_AGENT_TOKEN", "ANTHROPIC_API_KEY", "BILLING_TOKEN", "AGENT_RUN_TOKEN"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| !secret.is_empty())
        .collect();
    let outcome = answer();
    let body = match &outcome {
        Ok(answer) => answer.clone(),
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            "I could not answer this: the run failed before I had an answer. Its steps are on the Agents page.".to_owned()
        }
    };
    // Whatever the agent wrote passes through here, so nothing it could
    // have read from its environment leaves in the answer.
    let body = secrets
        .iter()
        .fold(body, |text, secret| text.replace(secret, "[redacted]"));
    let posted = ureq::post(&format!("{api}/repos/{repo}/issues/{number}/comments"))
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(serde_json::json!({ "body": body }));
    if let Err(error) = posted {
        eprintln!("g1t-runner: could not post the answer: {error:#}");
        return 1;
    }
    i32::from(outcome.is_err())
}
