//! `list_commits`: a branch's history, newest first, with each commit's
//! message, author, time and page; with `path`, that file's or directory's
//! own history: the commits that changed it. What an agent (or Ask g1t)
//! reads to say what changed lately and why: g1t's commit messages say why.
//!
//! The repos service reads it, as the caller may see it: `log` for a
//! branch, `path_log` for a path. The shaping is [`commit`], a plain
//! function.
//!
//! Each author is named as git wrote them, and with the g1t account their
//! address belongs to (`author.username`) when it is a confirmed or noreply
//! address of one, as the site shows commits: identity's `email_owners`.
//! The address itself is never returned.

use std::collections::{BTreeSet, HashMap};

use g1t_contracts::accounts::{EmailOwner, EmailOwnersArgs};
use g1t_contracts::repos::{Commit, LogArgs, PathLog, PathLogArgs, RepoPath};
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

/// g1t's own commit addresses, shown as @g1t: its noreply address and those
/// its agents and merge queue used before (services/repos contributors.rs).
const G1T_EMAILS: [&str; 4] = ["g1t@users.noreply.g1t.sh", "agent@g1t.sh", "queue@g1t.sh", "mergecheck@g1t.sh"];
/// The most addresses one `email_owners` call takes.
const MAX_ADDRESSES: usize = 200;

/// Author address, lowercased, to the g1t username it belongs to.
pub type Authors = HashMap<String, String>;

/// The distinct author addresses of some commits that identity is asked
/// about, lowercased: g1t's own are known already.
pub fn addresses<'a>(commits: impl IntoIterator<Item = &'a Commit>) -> Vec<String> {
    commits
        .into_iter()
        .map(|commit| commit.author.email.trim().to_lowercase())
        .filter(|email| email.contains('@') && !G1T_EMAILS.contains(&email.as_str()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_ADDRESSES)
        .collect()
}

/// Who each address belongs to, as usernames: g1t's own addresses are g1t,
/// the rest whatever identity matched (a confirmed or noreply address,
/// never an unconfirmed one). An address nobody owns is left out.
pub fn authors(commits: &[&Commit], owners: &HashMap<String, EmailOwner>) -> Authors {
    let mut found = Authors::new();
    for commit in commits {
        let email = commit.author.email.trim().to_lowercase();
        if G1T_EMAILS.contains(&email.as_str()) {
            found.insert(email, "g1t".to_owned());
        } else if let Some(owner) = owners.get(&email) {
            found.insert(email, owner.username.clone());
        }
    }
    found
}

/// The g1t username of a commit's author, when their address is known.
pub fn username<'a>(commit: &Commit, authors: &'a Authors) -> Option<&'a str> {
    authors.get(&commit.author.email.trim().to_lowercase()).map(String::as_str)
}

/// Reads who wrote some commits from identity. Without identity, nobody:
/// the commits still say their authors' names.
pub async fn read_authors(services: &Services, commits: &[&Commit]) -> Authors {
    let emails = addresses(commits.iter().copied());
    let owners = if emails.is_empty() {
        HashMap::new()
    } else {
        g1t_kit::call::<_, HashMap<String, EmailOwner>>(&services.identity, "email_owners", &EmailOwnersArgs { emails })
            .await
            .unwrap_or_default()
    };
    authors(commits, &owners)
}

pub fn description() -> &'static str {
    "A branch's commits, newest first (the default branch unless `ref` names a branch, tag or commit): each with its `sha`, `message` (why it was made: g1t's commit messages say), `author` (`name` as git wrote it, and `username`, the g1t account the author's address belongs to, when one does), `authored_at` and `html_url`. `limit` is 30 unless you say, at most 100. With `path` (a file or directory), only the commits that changed it, newest first (its history: added, changed, removed), with `last_changed`, the newest of them, and `complete` false when a long history was not walked to its start in time."
}

pub fn input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "repo": { "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." },
            "ref": { "type": "string", "description": "A branch, tag or commit; the default branch when left out." },
            "path": { "type": "string", "description": "A file or directory, such as scripts/deploy/npm-ci.mjs: only the commits that changed it." },
            "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "How many commits: 30 unless you say, at most 100." },
        },
        "required": ["repo"],
    })
}

/// One commit as an answer shows it.
pub fn commit(site: &str, repo: &RepoPath, commit: &Commit, authors: &Authors) -> Value {
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
        "author": author(commit, authors),
        "authored_at": commit.authored_at,
        "parents": commit.parents,
        "html_url": format!("{site}/{}/{}/commit/{}", repo.namespace, repo.name, commit.hash),
    })
}

/// A commit's author as an answer shows them: the name git wrote, and their
/// username when it is known. Never the address.
fn author(commit: &Commit, authors: &Authors) -> Value {
    match username(commit, authors) {
        Some(username) => json!({ "name": commit.author.name, "username": username }),
        None => json!({ "name": commit.author.name }),
    }
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
    let full = format!("{}/{}", repo.namespace, repo.name);
    if path.is_empty() {
        let log: Outcome<Vec<Commit>> =
            g1t_kit::call(&services.repos, "log", &LogArgs { path: repo.clone(), viewer: viewer.clone(), git_ref, limit: limit(input) })
                .await?;
        let commits = match log {
            Outcome::Ok(commits) => commits,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let authors = read_authors(services, &commits.iter().collect::<Vec<_>>()).await;
        return Ok(Outcome::Ok(json!({
            "repo": full,
            "commits": commits.iter().map(|found| commit(&site, repo, found, &authors)).collect::<Vec<_>>(),
        })));
    }
    // A path's own history: the commits that changed it, newest first.
    let history: Outcome<PathLog> = g1t_kit::call(
        &services.repos,
        "path_log",
        &PathLogArgs {
            path: repo.clone(),
            viewer: viewer.clone(),
            git_ref,
            file_path: path.clone(),
            limit: limit(input),
            budget_ms: Some(PATH_BUDGET_MS),
        },
    )
    .await?;
    let history = match history {
        Outcome::Ok(history) => history,
        Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
    };
    let authors = read_authors(services, &history.commits.iter().collect::<Vec<_>>()).await;
    let last_changed = match history.commits.first() {
        Some(first) => commit(&site, repo, first, &authors),
        None if history.complete => json!(format!("{path} is not in this repository at this ref.")),
        None => json!("Not found in time: its history is long. Ask with a smaller limit, or read the branch's commits."),
    };
    Ok(Outcome::Ok(json!({
        "repo": full,
        "path": path,
        "commits": history.commits.iter().map(|found| commit(&site, repo, found, &authors)).collect::<Vec<_>>(),
        "last_changed": last_changed,
        "complete": history.complete,
    })))
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
        let shown = commit("https://g1t.sh/", &repo, &found, &Authors::new());
        assert_eq!(shown["sha"], "abc123");
        assert_eq!(shown["message"], "The runner retries installs that break off.");
        assert_eq!(shown["author"], json!({ "name": "Chase Pierce" }));
        assert!(shown.get("email").is_none() && shown["author"].get("email").is_none(), "no email addresses");
        assert_eq!(shown["html_url"], "https://g1t.sh/acme/web/commit/abc123");
        assert_eq!(limit(&json!({ "limit": "500" })), MAX_LIMIT);
        assert_eq!(limit(&json!({})), DEFAULT_LIMIT);
    }

    fn by(name: &str, email: &str) -> Commit {
        Commit {
            hash: format!("{}1", name.len()),
            tree_hash: "t".into(),
            message: "m".into(),
            author: Signature { name: name.into(), email: email.into() },
            parents: Vec::new(),
            authored_at: "2026-10-14T01:00:00Z".into(),
        }
    }

    #[test]
    fn an_author_is_named_by_the_account_their_address_belongs_to() {
        let known = by("Chase Pierce", " Syntaqx@Gmail.com ");
        let stranger = by("Someone Else", "someone@example.com");
        let ours = by("g1t", "g1t@users.noreply.g1t.sh");
        let unsigned = by("Nobody", "");
        let all = [&known, &stranger, &ours, &unsigned];
        // Asked about: each real address once, lowercased; never g1t's own.
        assert_eq!(addresses(all), vec!["someone@example.com".to_owned(), "syntaqx@gmail.com".to_owned()]);
        let owners =
            HashMap::from([("syntaqx@gmail.com".to_owned(), EmailOwner { id: "usr_1".into(), username: "syntaqx".into(), avatar: None })]);
        let found = authors(&all, &owners);
        let repo = RepoPath { namespace: "flagon-io".into(), name: "g1t".into() };
        // A known address: the git name and the username, never the address.
        let shown = commit("https://g1t.sh", &repo, &known, &found);
        assert_eq!(shown["author"], json!({ "name": "Chase Pierce", "username": "syntaqx" }));
        assert!(!shown.to_string().to_lowercase().contains("gmail"), "no address");
        // Nobody on g1t: the name alone, and no username made up from it.
        assert_eq!(commit("https://g1t.sh", &repo, &stranger, &found)["author"], json!({ "name": "Someone Else" }));
        assert_eq!(commit("https://g1t.sh", &repo, &unsigned, &found)["author"], json!({ "name": "Nobody" }));
        // g1t's own commits are @g1t's.
        assert_eq!(commit("https://g1t.sh", &repo, &ours, &found)["author"]["username"], "g1t");
    }
}
