//! Turns an outcome someone wrote into a plan: the issues that would get
//! there, what each must pass, which files each will touch, and which must
//! land before which.
//!
//! The agent reads the repository to do it, so the plan is about the code
//! as it is and not a guess. It writes the plan to a file as JSON and this
//! program posts it to g1t, where a person reads and edits it before
//! anything is opened. The agent never holds the credential that reports
//! the plan, and changes nothing.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `PLAN_ID`, `PLAN_TOKEN`: where and how to report.
//! - `GIT_REMOTE`: the repository to plan for.
//! - `G1T_USER`, `G1T_TOKEN`: to read it, if it is private.
//! - `PROMPT`: the outcome wanted.

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::report::Reporter;
use crate::{WORKDIR, auth_option, env, git, harness};

const PLAN_FILE: &str = "/work/plan.json";

const INSTRUCTIONS: &str = "You are planning work for a team of coding agents. The repository is checked out in the current directory. \
Read enough of it to understand how it is built and tested. Do not modify it.

Split the outcome below into issues. Each issue will be given to a separate agent that sees only that issue and the repository, \
and each will be merged on its own. So:

- Make each issue one coherent change that can be merged by itself and leaves the project working.
- Write the body for someone with no other context: what to change, where, and why. Name the files and functions involved.
- Prefer several small issues to one large one, but do not split a change that only makes sense whole. At most 12 issues.
- Give acceptance checks: shell commands that must pass once the change is made. Use the project's real test or build commands. \
Give none if the project has no way to check that kind of change.
- List the files each issue will most likely change.
- Two agents working at once must not edit the same code. If two issues would change the same file, or one needs what another adds, \
make the later one depend on the earlier. Otherwise leave them independent, so that they are worked on at the same time.

Write the plan to /work/plan.json as JSON with exactly this shape:

{
  \"summary\": \"Two or three sentences: how you split the outcome and why in this order.\",
  \"issues\": [
    {
      \"title\": \"One line, as an instruction\",
      \"body\": \"Markdown.\",
      \"labels\": [\"feature\"],
      \"checks\": [\"cargo test\"],
      \"files\": [\"src/lib.rs\"],
      \"depends_on\": [1]
    }
  ]
}

`labels` are from: bug, feature, docs, chore. `depends_on` holds the positions, counting from 1, of earlier issues in this list that must be merged first; \
it is empty for an issue that can start at once. An issue may only depend on issues before it. Then finish.

The outcome wanted:";

fn plan() -> Result<Value> {
    let remote = env("GIT_REMOTE")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);

    std::fs::create_dir_all("/work")?;
    git(
        Path::new("/work"),
        &["-c", &auth, "clone", "--quiet", &remote, WORKDIR],
    )
    .context("could not clone the repository")?;

    let prompt = format!("{INSTRUCTIONS}\n\n{}", env("PROMPT")?);
    // A plan has no session; what matters is the plan.
    let mut reporter = Reporter::silent();
    let answer = harness::run_claude(workdir, &prompt, &mut reporter)?;

    let written = std::fs::read_to_string(PLAN_FILE).unwrap_or_default();
    let plan: Value = serde_json::from_str(&written)
        .ok()
        .filter(|plan: &Value| plan["issues"].is_array())
        // The agent may have answered with the plan instead of writing it.
        .or_else(|| embedded_json(&answer).filter(|plan| plan["issues"].is_array()))
        .context("the agent did not produce a plan")?;
    if plan["issues"].as_array().is_some_and(Vec::is_empty) {
        bail!("the agent proposed no issues");
    }
    Ok(plan)
}

/// The JSON object in a piece of text, from its first brace to its last.
fn embedded_json(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(text.get(start..=end)?).ok()
}

pub fn main() -> i32 {
    let (Ok(api), Ok(id), Ok(token)) = (env("G1T_API"), env("PLAN_ID"), env("PLAN_TOKEN")) else {
        eprintln!("g1t-runner: G1T_API, PLAN_ID and PLAN_TOKEN must be set");
        return 2;
    };
    let secrets: Vec<String> = [
        "G1T_TOKEN",
        "PLAN_TOKEN",
        "ANTHROPIC_API_KEY",
        "BILLING_TOKEN",
    ]
    .iter()
    .filter_map(|name| std::env::var(name).ok())
    .filter(|secret| !secret.is_empty())
    .collect();
    let redact = |text: String| {
        secrets
            .iter()
            .fold(text, |text, secret| text.replace(secret, "[redacted]"))
    };

    let outcome = plan();
    let report = match &outcome {
        Ok(plan) => plan.clone(),
        Err(error) => json!({ "error": format!("{error:#}") }),
    };
    // Whatever the agent wrote passes through here, so nothing it could
    // have read from its environment leaves in a plan. The plan's own token
    // is added afterwards: it is what authorises the report.
    let mut report: Value =
        serde_json::from_str(&redact(report.to_string())).unwrap_or_else(|_| json!({}));
    report["token"] = token.into();
    if let Err(error) = ureq::post(&format!("{api}/plans/{id}")).send_json(report) {
        eprintln!("g1t-runner: could not report the plan: {error:#}");
        return 1;
    }
    i32::from(outcome.is_err())
}

#[cfg(test)]
mod tests {
    use super::embedded_json;

    #[test]
    fn a_plan_is_found_inside_an_answer() {
        let answer = "Here is the plan:\n```json\n{\"summary\": \"x\", \"issues\": []}\n```\nDone.";
        let plan = embedded_json(answer).unwrap();
        assert_eq!(plan["summary"], "x");
        assert!(embedded_json("no plan here").is_none());
    }
}
