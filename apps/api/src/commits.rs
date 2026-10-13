//! `list_commits`: a branch's history, newest first, with each commit's
//! message, author, time and page; with `path`, also the commit that last
//! changed that file or directory. What an agent (or Ask g1t) reads to say
//! what changed lately and why: g1t's commit messages say why.
//!
//! The repos service reads it, as the caller may see it: `log` for the
//! history, `last_commits` of the path's directory for its last change.
//! The shaping is [`commit`], a plain function.

use g1t_contracts::repos::{Commit, LastCommits, LastCommitsArgs, LogArgs, RepoPath};
use g1t_contracts::{Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

pub const DEFAULT_LIMIT: u32 = 30;
pub const MAX_LIMIT: u32 = 100;
/// The most of one commit's message an answer carries.
const MAX_MESSAGE_CHARS: usize = 4_000;
/// How long finding a path's last change may take, in milliseconds.
const PATH_BUDGET_MS: u64 = 8_000;

pub fn description() -> &'static str {
    "A branch's commits, newest first (the default branch unless `ref` names a branch, tag or commit): each with its `sha`, `message` (why it was made: g1t's commit messages say), `author`, `authored_at` and `html_url`. `limit` is 30 unless you say, at most 100. With `path` (a file or directory), also `last_changed`: the commit that last changed it."
}

pub fn input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "repo": { "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." },
            "ref": { "type": "string", "description": "A branch, tag or commit; the default branch when left out." },
            "path": { "type": "string", "description": "A file or directory, such as scripts/deploy/npm-ci.mjs: adds the commit that last changed it." },
            "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "How many commits: 30 unless you say, at most 100." },
        },
        "required": ["repo"],
    })
}

/// One commit as an answer shows it.
pub fn commit(site: &str, repo: &RepoPath, commit: &Commit) -> Value {
    let site = site.trim_end_matches('/');
    let total = commit.message.chars().count();
    let message = if total > MAX_MESSAGE_CHARS {
        format!("{}… [{} more characters]", commit.message.chars().take(MAX_MESSAGE_CHARS).collect::<String>(), total - MAX_MESSAGE_CHARS)
    } else {
        commit.message.trim_end().to_owned()
    };
    json!({
        "sha": commit.hash,
        "message": message,
        "author": { "name": commit.author.name },
        "authored_at": commit.authored_at,
        "parents": commit.parents,
        "html_url": format!("{site}/{}/{}/commit/{}", repo.namespace, repo.name, commit.hash),
    })
}

fn limit(input: &Value) -> u32 {
    let asked = match input.get("limit") {
        Some(Value::String(text)) => text.trim().parse::<u64>().ok(),
        Some(value) => value.as_u64(),
        None => None,
    };
    asked.map_or(DEFAULT_LIMIT, |n| n.clamp(1, u64::from(MAX_LIMIT)) as u32)
}

pub async fn run(services: &Services, viewer: &Viewer, repo: &RepoPath, input: &Value) -> Result<Outcome<Value>> {
    let site = services.addresses.site.clone();
    let git_ref = input["ref"].as_str().map(str::trim).filter(|git_ref| !git_ref.is_empty()).map(str::to_owned);
    let path = input["path"].as_str().unwrap_or_default().trim().trim_matches('/').to_owned();
    let log: Outcome<Vec<Commit>> = g1t_kit::call(
        &services.repos,
        "log",
        &LogArgs { path: repo.clone(), viewer: viewer.clone(), git_ref: git_ref.clone(), limit: limit(input) },
    )
    .await?;
    let commits = match log {
        Outcome::Ok(commits) => commits,
        Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
    };
    let mut answer = json!({
        "repo": format!("{}/{}", repo.namespace, repo.name),
        "commits": commits.iter().map(|found| commit(&site, repo, found)).collect::<Vec<_>>(),
    });
    if !path.is_empty() {
        let (directory, name) = match path.rsplit_once('/') {
            Some((directory, name)) => (directory.to_owned(), name.to_owned()),
            None => (String::new(), path.clone()),
        };
        let last: Outcome<LastCommits> = g1t_kit::call(
            &services.repos,
            "last_commits",
            &LastCommitsArgs { path: repo.clone(), viewer: viewer.clone(), git_ref, tree_path: directory, budget_ms: Some(PATH_BUDGET_MS) },
        )
        .await?;
        answer["path"] = json!(path);
        answer["last_changed"] = match last {
            Outcome::Ok(last) => match last.entries.iter().find(|entry| entry.name == name) {
                Some(entry) => commit(&site, repo, &entry.commit),
                None if last.complete => json!(format!("{path} is not in this repository at this ref.")),
                None => json!("Not found in time: its history is long. Look through the commits for it."),
            },
            Outcome::Fail(failure) => json!(failure.message),
        };
    }
    Ok(Outcome::Ok(answer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::Signature;

    #[test]
    fn a_commit_says_why_and_where_it_is() {
        let found = Commit {
            hash: "abc123".into(),
            tree_hash: "t".into(),
            message: "The runner retries installs that break off.\n".into(),
            author: Signature { name: "Chase Pierce".into(), email: "c@example.com".into() },
            parents: vec!["p1".into()],
            authored_at: "2026-10-13T01:00:00Z".into(),
        };
        let repo = RepoPath { namespace: "acme".into(), name: "web".into() };
        let shown = commit("https://g1t.sh/", &repo, &found);
        assert_eq!(shown["sha"], "abc123");
        assert_eq!(shown["message"], "The runner retries installs that break off.");
        assert_eq!(shown["author"], json!({ "name": "Chase Pierce" }));
        assert!(shown.get("email").is_none() && shown["author"].get("email").is_none(), "no email addresses");
        assert_eq!(shown["html_url"], "https://g1t.sh/acme/web/commit/abc123");
        assert_eq!(limit(&json!({ "limit": "500" })), MAX_LIMIT);
        assert_eq!(limit(&json!({})), DEFAULT_LIMIT);
    }
}
