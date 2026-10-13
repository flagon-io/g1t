//! `get_workspace_activity`: what happened across a workspace's
//! repositories over a span, newest first, as one list a person (or Ask
//! g1t, or an agent) can read: pull requests merged and opened, issues
//! opened and closed, releases, deployments and pushes, each with its
//! repository, who did it, its title where it has one and its address on
//! the site. "What shipped today?" is one call.
//!
//! The repositories are those of the workspace the caller can read, as the
//! repos service lists them for them; the events service reads their events
//! as one list (`repo_ids`). Pull requests' titles, which their events do
//! not carry, come from the work service's newest pull requests of the
//! repositories that had any; people's names from identity. Everything
//! after the reads is [`shape`], a plain function, tested on its own.

use std::collections::{BTreeSet, HashMap};

use g1t_contracts::events::{Event, ListArgs as ListEventsArgs, MAX_LIST_REPOS};
use g1t_contracts::identity::UsernamesArgs;
use g1t_contracts::repos::{ListArgs as ListReposArgs, Repo};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::work::{MAX_PULLS_FOR_REPOS, PullsForReposArgs, RepoPulls};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// The span when none is given: the last day.
const DEFAULT_SPAN_MS: u64 = 24 * 60 * 60 * 1000;
/// The longest span one call reads.
const MAX_SPAN_MS: u64 = 31 * 24 * 60 * 60 * 1000;
pub const DEFAULT_LIMIT: u32 = 100;
pub const MAX_LIMIT: u32 = 200;

/// The kinds a caller may ask for, and the events each is.
pub const KINDS: &[(&str, &[&str])] = &[
    ("merged", &["pull.merged"]),
    ("pulls", &["pull.opened", "pull.merged", "pull.closed"]),
    ("issues", &["issue.opened", "issue.closed"]),
    ("releases", &["release.published"]),
    ("deployments", &["deployment.succeeded", "deployment.failed"]),
    ("pushes", &["git.push"]),
    ("reviews", &["review.completed"]),
    ("comments", &["comment.created"]),
    ("packages", &["package.published"]),
    ("runs", &["workflow.completed"]),
];

/// What is read when no kinds are given: everything but comments, which
/// would crowd out the rest on a busy day.
const DEFAULT_KINDS: &[&str] = &["pulls", "issues", "releases", "deployments", "pushes", "reviews", "packages", "runs"];

pub fn description() -> &'static str {
    "What happened across a workspace's repositories that you can read, newest first: pull requests merged, opened and closed, issues opened and closed, releases published, deployments that succeeded or failed, pushes (with `default_branch` true for what landed on the default branch without a pull request), reviews, packages, and workflow runs that finished (`workflow`, `run_number`, `conclusion`, `run_id` for workflow get_run). Each event has its `kind`, `time`, `repo` (owner/name), `actor` (a username), and where it has them its `number`, `title`, `url` (its page on g1t), `branch`, `commit`, `commits`, `tag` and `error`. `summary` counts merged pull requests, releases, production deployments, default-branch pushes and failed runs: what shipped, and what broke. The span is `since` to `until` (RFC 3339; the last 24 hours when `since` is left out, at most 31 days); narrow it with `kinds` (merged, pulls, issues, releases, deployments, pushes, reviews, comments, packages, runs; all but comments when left out) and `limit` (100 unless you say, at most 200). `complete` is false when more happened than was read: narrow the span or the kinds. For one repository's full timeline use list_events."
}

pub fn input() -> Value {
    json!({
        "type": "object",
        "properties": {
            "workspace": { "type": "string", "description": "The workspace's slug, e.g. \"flagon-io\"." },
            "since": { "type": "string", "description": "RFC 3339: the start of the span, inclusive. The last 24 hours when left out; for \"today\", midnight UTC." },
            "until": { "type": "string", "description": "RFC 3339: the end of the span, exclusive. Now when left out." },
            "kinds": {
                "type": "array",
                "items": { "type": "string", "enum": KINDS.iter().map(|(name, _)| *name).collect::<Vec<_>>() },
                "description": "What to read: merged (merged pull requests only), pulls, issues, releases, deployments, pushes, reviews, comments, packages, runs (workflow runs that finished). All but comments when left out.",
            },
            "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "The most events to return, newest first: 100 unless you say, at most 200." },
        },
        "required": ["workspace"],
    })
}

/// The span asked for, in milliseconds, or why it cannot be read.
pub fn span(input: &Value, now: u64) -> std::result::Result<(u64, u64), String> {
    let at = |key: &str| -> std::result::Result<Option<u64>, String> {
        match input.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()) {
            None => Ok(None),
            Some(text) => parse_rfc3339(text).map(Some).ok_or_else(|| format!("{key} must be an RFC 3339 time, such as 2026-10-12T00:00:00Z.")),
        }
    };
    let until = at("until")?.unwrap_or(now).min(now);
    let since = at("since")?.unwrap_or(until.saturating_sub(DEFAULT_SPAN_MS));
    if since >= until {
        return Err("since must be before until.".to_owned());
    }
    if until - since > MAX_SPAN_MS {
        return Err("A span can be at most 31 days. Narrow since and until.".to_owned());
    }
    Ok((since, until))
}

/// The event types the `kinds` asked for read, or the unknown kind.
pub fn event_types(input: &Value) -> std::result::Result<Vec<&'static str>, String> {
    // An array, or over REST a comma-separated list.
    let asked: Vec<String> = match input.get("kinds") {
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        Some(Value::String(kinds)) => kinds.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    }
    .into_iter()
    .map(|kind| kind.trim().to_lowercase())
    .filter(|kind| !kind.is_empty())
    .collect();
    let names: Vec<&str> = if asked.is_empty() { DEFAULT_KINDS.to_vec() } else { asked.iter().map(String::as_str).collect() };
    let mut types = BTreeSet::new();
    for name in names {
        let Some((_, kinds)) = KINDS.iter().find(|(kind, _)| *kind == name) else {
            let known: Vec<&str> = KINDS.iter().map(|(kind, _)| *kind).collect();
            return Err(format!("There is no kind {name}. Kinds: {}.", known.join(", ")));
        };
        types.extend(kinds.iter().copied());
    }
    Ok(types.into_iter().collect())
}

/// The most events asked for: a number, or over REST its text.
pub fn limit(input: &Value) -> u32 {
    let asked = match input.get("limit") {
        Some(Value::String(text)) => text.trim().parse::<u64>().ok(),
        Some(value) => value.as_u64(),
        None => None,
    };
    asked.map_or(DEFAULT_LIMIT, |n| n.clamp(1, u64::from(MAX_LIMIT)) as u32)
}

fn text<'a>(data: &'a Value, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// What the reads found, shaped into the answer.
pub struct Found<'a> {
    pub workspace: &'a str,
    pub site: &'a str,
    pub since: u64,
    pub until: u64,
    pub repos: &'a [Repo],
    /// Newest first, as the events service lists them.
    pub events: &'a [Event],
    /// Whether the events service had more than was read.
    pub more: bool,
    /// `(repo id, number)` to a pull request's title.
    pub pull_titles: &'a HashMap<(String, u32), String>,
    /// Account id to username.
    pub usernames: &'a HashMap<String, String>,
}

pub fn shape(found: &Found) -> Value {
    let site = found.site.trim_end_matches('/');
    let by_id: HashMap<&str, &Repo> = found.repos.iter().map(|repo| (repo.id.as_str(), repo)).collect();
    let mut events = Vec::new();
    let (mut merged, mut releases, mut production, mut landed, mut failed) = (0u32, 0u32, 0u32, 0u32, 0u32);
    let mut runs_failed = 0u32;
    for event in found.events {
        let Some(repo) = event.repo_id.as_deref().and_then(|id| by_id.get(id)) else {
            continue;
        };
        let at = parse_rfc3339(&event.time).unwrap_or_default();
        if at < found.since || at >= found.until {
            continue;
        }
        let full = format!("{}/{}", repo.namespace, repo.name);
        let page = format!("{site}/{full}");
        let data = &event.data;
        let number = data.get("number").and_then(Value::as_u64).map(|n| n as u32);
        let actor = event
            .actor
            .as_deref()
            .and_then(|id| found.usernames.get(id).cloned())
            .or_else(|| data.get("author").and_then(|author| text(author, "username")).map(str::to_owned))
            .or_else(|| text(data, "triggeredBy").map(str::to_owned));
        let mut shown = json!({ "kind": event.kind.replace('.', "_"), "time": event.time, "repo": full });
        if let Some(actor) = actor {
            shown["actor"] = json!(actor);
        }
        match event.kind.as_str() {
            "pull.opened" | "pull.merged" | "pull.closed" => {
                let Some(number) = number else { continue };
                shown["number"] = json!(number);
                if let Some(title) = found.pull_titles.get(&(repo.id.clone(), number)) {
                    shown["title"] = json!(title);
                }
                shown["url"] = json!(format!("{page}/pull/{number}"));
                if let Some(issue) = data.get("issue").and_then(Value::as_u64) {
                    shown["issue"] = json!(issue);
                }
                if event.kind == "pull.merged" {
                    merged += 1;
                }
            }
            "issue.opened" | "issue.closed" => {
                let Some(number) = number else { continue };
                shown["number"] = json!(number);
                if let Some(title) = text(data, "title") {
                    shown["title"] = json!(title);
                }
                if let Some(reason) = text(data, "reason") {
                    shown["reason"] = json!(reason);
                }
                if let Some(pull) = data.get("resolvedBy").and_then(Value::as_u64) {
                    shown["resolved_by"] = json!(pull);
                }
                shown["url"] = json!(format!("{page}/issues/{number}"));
            }
            "release.published" => {
                let tag = text(data, "tagName").unwrap_or_default();
                shown["tag"] = json!(tag);
                if let Some(name) = data.get("release").and_then(|release| text(release, "name")) {
                    shown["title"] = json!(name);
                }
                shown["url"] = json!(format!("{page}/releases/tag/{tag}"));
                releases += 1;
            }
            "deployment.succeeded" | "deployment.failed" => {
                let kind = text(data, "kind").unwrap_or("preview");
                shown["environment"] = json!(kind);
                if let Some(project) = text(data, "project") {
                    shown["project"] = json!(project);
                }
                if let Some(branch) = text(data, "branch") {
                    shown["branch"] = json!(branch);
                }
                if let Some(commit) = text(data, "commit") {
                    shown["commit"] = json!(commit.chars().take(12).collect::<String>());
                }
                if let Some(error) = text(data, "error") {
                    shown["error"] = json!(error.chars().take(300).collect::<String>());
                }
                shown["url"] = json!(match text(data, "path") {
                    Some(path) => format!("{site}{path}"),
                    None => format!("{page}/deployments"),
                });
                if event.kind == "deployment.succeeded" && kind == "production" {
                    production += 1;
                }
                if event.kind == "deployment.failed" {
                    failed += 1;
                }
            }
            "git.push" => {
                // Branches only: a tag's push is its release.
                let Some(branch) = text(data, "ref").and_then(|r| r.strip_prefix("refs/heads/")) else { continue };
                let default_branch = data.get("defaultBranch").and_then(Value::as_bool) == Some(true);
                shown["branch"] = json!(branch);
                shown["default_branch"] = json!(default_branch);
                if let Some(commits) = data.get("commits").and_then(Value::as_u64) {
                    shown["commits"] = json!(commits);
                }
                if let Some(after) = text(data, "after") {
                    shown["commit"] = json!(after.chars().take(12).collect::<String>());
                    shown["url"] = json!(format!("{page}/commit/{after}"));
                }
                if default_branch {
                    landed += 1;
                }
            }
            "review.completed" | "comment.created" => {
                if let Some(number) = number.or_else(|| data.get("issue").and_then(Value::as_u64).map(|n| n as u32)) {
                    shown["number"] = json!(number);
                    shown["url"] = json!(format!("{page}/issues/{number}"));
                }
                if let Some(verdict) = text(data, "verdict") {
                    shown["verdict"] = json!(verdict);
                }
            }
            "workflow.completed" => {
                let conclusion = text(data, "conclusion").unwrap_or_default();
                if let Some(workflow) = text(data, "workflow") {
                    shown["workflow"] = json!(workflow);
                }
                if let Some(run_number) = data.get("number").and_then(Value::as_u64) {
                    shown["run_number"] = json!(run_number);
                }
                shown["conclusion"] = json!(conclusion);
                if let Some(branch) = text(data, "ref").map(|r| r.strip_prefix("refs/heads/").unwrap_or(r)) {
                    shown["branch"] = json!(branch);
                }
                if let Some(sha) = text(data, "sha") {
                    shown["commit"] = json!(sha.chars().take(12).collect::<String>());
                }
                if let Some(pull) = data.get("pull").and_then(Value::as_u64) {
                    shown["pull"] = json!(pull);
                }
                if let Some(run) = text(data, "runId") {
                    shown["run_id"] = json!(run);
                    shown["url"] = json!(format!("{page}/actions/runs/{run}"));
                }
                if conclusion == "failure" {
                    runs_failed += 1;
                }
            }
            "package.published" => {
                for key in ["ecosystem", "name", "version"] {
                    if let Some(value) = text(data, key) {
                        shown[key] = json!(value);
                    }
                }
            }
            _ => continue,
        }
        events.push(shown);
    }
    json!({
        "workspace": found.workspace,
        "since": rfc3339(found.since),
        "until": rfc3339(found.until),
        "repositories": found.repos.len(),
        "summary": {
            "merged_pull_requests": merged,
            "releases": releases,
            "production_deployments": production,
            "failed_deployments": failed,
            "default_branch_pushes": landed,
            "failed_runs": runs_failed,
        },
        "events": events,
        "complete": !found.more && found.repos.len() <= MAX_LIST_REPOS,
    })
}

pub async fn run(services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let workspace = input["workspace"].as_str().unwrap_or_default().trim().to_lowercase();
    if workspace.is_empty() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the workspace's slug."));
    }
    let (since, until) = match span(input, g1t_kit::now_ms()) {
        Ok(span) => span,
        Err(problem) => return Ok(Outcome::fail(FailureCode::Invalid, problem)),
    };
    let types = match event_types(input) {
        Ok(types) => types,
        Err(problem) => return Ok(Outcome::fail(FailureCode::Invalid, problem)),
    };
    let limit = limit(input);
    // The workspace's repositories as the caller may read them; a
    // workspace they cannot see has none.
    let repos: Vec<Repo> = g1t_kit::call(
        &services.repos,
        "list",
        &ListReposArgs { viewer: viewer.clone(), query: None, namespace: Some(workspace.clone()), member_only: false },
    )
    .await?;
    let repos: Vec<Repo> = repos.into_iter().filter(|repo| repo.namespace.eq_ignore_ascii_case(&workspace)).collect();
    let site = services.addresses.site.clone();
    let none = (HashMap::new(), HashMap::new());
    if repos.is_empty() {
        return Ok(Outcome::Ok(shape(&Found {
            workspace: &workspace,
            site: &site,
            since,
            until,
            repos: &repos,
            events: &[],
            more: false,
            pull_titles: &none.0,
            usernames: &none.1,
        })));
    }
    let events: Vec<Event> = g1t_kit::call(
        &services.events,
        "list",
        &ListEventsArgs {
            repo_ids: repos.iter().take(MAX_LIST_REPOS).map(|repo| repo.id.clone()).collect(),
            types: types.iter().map(|kind| (*kind).to_owned()).collect(),
            since: Some(rfc3339(since)),
            // One past the limit says whether there was more.
            limit: Some(limit + 1),
            ..ListEventsArgs::default()
        },
    )
    .await?;
    let more = events.len() > limit as usize;
    let events: Vec<Event> = events.into_iter().take(limit as usize).collect();
    // Titles of the pull requests named, and the names of who did what.
    let pull_repos: Vec<String> = events
        .iter()
        .filter(|event| event.kind.starts_with("pull."))
        .filter_map(|event| event.repo_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_PULLS_FOR_REPOS)
        .collect();
    let actors: Vec<String> = events.iter().filter_map(|event| event.actor.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let pulls = async {
        if pull_repos.is_empty() {
            return Ok(Vec::new());
        }
        g1t_kit::call::<_, Vec<RepoPulls>>(
            &services.work,
            "pulls_for_repos",
            &PullsForReposArgs { repo_ids: pull_repos, viewer: viewer.clone(), limit: 100 },
        )
        .await
    };
    let names = async {
        if actors.is_empty() {
            return Ok(HashMap::new());
        }
        g1t_kit::call::<_, HashMap<String, String>>(&services.identity, "usernames", &UsernamesArgs { ids: actors }).await
    };
    let (pulls, names) = futures_util::future::join(pulls, names).await;
    // Without titles or names the events still say what happened.
    let mut pull_titles = HashMap::new();
    for repo in pulls.unwrap_or_default() {
        for pull in repo.open.into_iter().chain(repo.closed) {
            pull_titles.insert((repo.repo_id.clone(), pull.number), pull.title);
        }
    }
    let usernames = names.unwrap_or_default();
    Ok(Outcome::Ok(shape(&Found {
        workspace: &workspace,
        site: &site,
        since,
        until,
        repos: &repos,
        events: &events,
        more,
        pull_titles: &pull_titles,
        usernames: &usernames,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(id: &str, name: &str) -> Repo {
        serde_json::from_value(json!({
            "id": id, "namespace": "acme", "name": name, "description": null, "isPrivate": false,
            "ownerId": "wsp_1", "defaultBranch": "main", "forkOf": null, "createdAt": "2026-01-01T00:00:00Z",
        }))
        .unwrap()
    }

    fn event(kind: &str, repo: &str, time: &str, actor: &str, data: Value) -> Event {
        Event {
            id: format!("evt_{time}"),
            kind: kind.into(),
            source: "test".into(),
            time: time.into(),
            repo_id: Some(repo.into()),
            actor: Some(actor.into()),
            data,
        }
    }

    #[test]
    fn the_span_is_the_last_day_unless_given() {
        let now = parse_rfc3339("2026-10-12T18:00:00Z").unwrap();
        let (since, until) = span(&json!({}), now).unwrap();
        assert_eq!(until, now);
        assert_eq!(until - since, DEFAULT_SPAN_MS);
        let (since, _) = span(&json!({ "since": "2026-10-12T00:00:00Z" }), now).unwrap();
        assert_eq!(since, parse_rfc3339("2026-10-12T00:00:00Z").unwrap());
        assert!(span(&json!({ "since": "yesterday" }), now).unwrap_err().contains("RFC 3339"));
        assert!(span(&json!({ "since": "2026-10-13T00:00:00Z" }), now).is_err());
        assert!(span(&json!({ "since": "2026-08-01T00:00:00Z" }), now).unwrap_err().contains("31 days"));
    }

    #[test]
    fn kinds_name_their_events() {
        assert_eq!(event_types(&json!({ "kinds": ["merged"] })).unwrap(), vec!["pull.merged"]);
        let all = event_types(&json!({})).unwrap();
        assert!(all.contains(&"pull.merged") && all.contains(&"git.push") && all.contains(&"release.published"));
        assert!(!all.contains(&"comment.created"));
        assert!(event_types(&json!({ "kinds": ["shipped"] })).unwrap_err().contains("Kinds: merged"));
        // Over REST: one comma-separated text.
        assert_eq!(event_types(&json!({ "kinds": "merged, releases" })).unwrap(), vec!["pull.merged", "release.published"]);
        assert_eq!(limit(&json!({ "limit": "500" })), MAX_LIMIT);
        assert_eq!(limit(&json!({ "limit": 5 })), 5);
        assert_eq!(limit(&json!({})), DEFAULT_LIMIT);
    }

    #[test]
    fn what_shipped_reads_as_one_list_with_links_and_names() {
        let repos = [repo("rep_1", "web"), repo("rep_2", "api")];
        let events = [
            event("deployment.succeeded", "rep_1", "2026-10-12T15:00:00Z", "usr_1", json!({ "kind": "production", "project": "web", "commit": "abcdef1234567890", "path": "/acme/web/deployments/dpl_1", "triggeredBy": "ana" })),
            event("release.published", "rep_2", "2026-10-12T14:00:00Z", "usr_2", json!({ "tagName": "v1.2.0", "release": { "name": "Faster pushes" } })),
            event("pull.merged", "rep_1", "2026-10-12T13:00:00Z", "usr_1", json!({ "number": 7, "issue": 3 })),
            event("git.push", "rep_2", "2026-10-12T12:00:00Z", "usr_2", json!({ "ref": "refs/heads/main", "after": "0123456789abcdef", "defaultBranch": true, "commits": 2 })),
            event("git.push", "rep_2", "2026-10-12T11:00:00Z", "usr_2", json!({ "ref": "refs/tags/v1.2.0", "after": "0123" })),
            event("workflow.completed", "rep_1", "2026-10-12T11:30:00Z", "usr_1", json!({ "runId": "run_257", "workflow": "Deploy", "number": 257, "conclusion": "failure", "ref": "refs/heads/main", "sha": "fedcba9876543210" })),
            event("issue.closed", "rep_1", "2026-10-12T10:00:00Z", "usr_1", json!({ "number": 3, "title": "Login fails", "reason": "completed", "resolvedBy": 7 })),
            // Outside the span, and a repository the caller cannot read.
            event("pull.merged", "rep_1", "2026-10-11T10:00:00Z", "usr_1", json!({ "number": 6 })),
            event("pull.merged", "rep_9", "2026-10-12T10:00:00Z", "usr_1", json!({ "number": 1 })),
        ];
        let titles = HashMap::from([(("rep_1".to_owned(), 7), "Fix login".to_owned())]);
        let names = HashMap::from([("usr_1".to_owned(), "ana".to_owned()), ("usr_2".to_owned(), "bo".to_owned())]);
        let shown = shape(&Found {
            workspace: "acme",
            site: "https://g1t.sh/",
            since: parse_rfc3339("2026-10-12T00:00:00Z").unwrap(),
            until: parse_rfc3339("2026-10-12T18:00:00Z").unwrap(),
            repos: &repos,
            events: &events,
            more: false,
            pull_titles: &titles,
            usernames: &names,
        });
        assert_eq!(
            shown["summary"],
            json!({ "merged_pull_requests": 1, "releases": 1, "production_deployments": 1, "failed_deployments": 0, "default_branch_pushes": 1, "failed_runs": 1 })
        );
        let listed = shown["events"].as_array().unwrap();
        assert_eq!(listed.len(), 6, "{listed:#?}");
        assert_eq!(listed[0]["url"], "https://g1t.sh/acme/web/deployments/dpl_1");
        assert_eq!(listed[0]["commit"], "abcdef123456");
        assert_eq!(listed[1]["title"], "Faster pushes");
        assert_eq!(listed[1]["url"], "https://g1t.sh/acme/api/releases/tag/v1.2.0");
        assert_eq!(
            listed[2],
            json!({ "kind": "pull_merged", "time": "2026-10-12T13:00:00Z", "repo": "acme/web", "actor": "ana", "number": 7, "title": "Fix login", "url": "https://g1t.sh/acme/web/pull/7", "issue": 3 })
        );
        assert_eq!(listed[3]["default_branch"], true);
        assert_eq!(listed[3]["actor"], "bo");
        assert_eq!(
            listed[4],
            json!({ "kind": "workflow_completed", "time": "2026-10-12T11:30:00Z", "repo": "acme/web", "actor": "ana", "workflow": "Deploy", "run_number": 257, "conclusion": "failure", "branch": "main", "commit": "fedcba987654", "run_id": "run_257", "url": "https://g1t.sh/acme/web/actions/runs/run_257" })
        );
        assert_eq!(listed[5]["resolved_by"], 7);
        assert_eq!(shown["complete"], true);
    }
}
