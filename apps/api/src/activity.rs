//! `get_workspace_activity`: what happened across a workspace's
//! repositories over a span, newest first, as one list a person (or Ask
//! g1t, or an agent) can read: pull requests merged and opened, work items
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
//!
//! Shipping on g1t is reaching the default branch, then production. For the
//! repositories whose default branch moved, `landed` lists the commits, each
//! with its author's g1t username where their address is one's
//! (commits.rs), and whether it is in production ([`production`]): carried
//! by a successful deploy (a run of a deploy workflow on the default branch,
//! for a repository that deploys itself, or a project's production
//! deployment on g1t.page), still deploying, or failed to.

use std::collections::{BTreeSet, HashMap};

use g1t_contracts::actions::{RunsArgs, WorkflowRun};
use g1t_contracts::events::{Event, ListArgs as ListEventsArgs, MAX_LIST_REPOS};
use g1t_contracts::identity::UsernamesArgs;
use g1t_contracts::repos::{Commit, ListArgs as ListReposArgs, LogArgs, Repo, RepoPath};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::work::{MAX_PULLS_FOR_REPOS, PullsForReposArgs, RepoPulls};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::commits::{self, Authors};
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
    ("work_items", &["work_item.opened", "work_item.closed"]),
    ("releases", &["release.published"]),
    ("deployments", &["deployment.succeeded", "deployment.failed"]),
    ("pushes", &["git.push"]),
    ("reviews", &["review.completed"]),
    ("comments", &["comment.created"]),
    ("packages", &["package.published"]),
    ("runs", &["workflow.completed"]),
];

/// The most repositories whose default-branch commits are read, and the
/// most commits that `landed` lists across them.
const LANDED_REPOS: usize = 8;
const LANDED_MAX: usize = 40;
/// How far back each of those repositories' history is read.
const LANDED_LOG: u32 = 60;
/// How many of each of those repositories' default-branch runs in the span
/// are read for its deploys.
const LANDED_RUNS: u32 = 100;

/// What is read when no kinds are given: everything but comments, which
/// would crowd out the rest on a busy day.
const DEFAULT_KINDS: &[&str] = &["pulls", "work_items", "releases", "deployments", "pushes", "reviews", "packages", "runs"];

pub fn description() -> &'static str {
    "What happened across a workspace's repositories that you can read, newest first: pull requests merged, opened and closed, work items opened and closed (linked to the repositories, numbered in the workspace), releases published, deployments that succeeded or failed, pushes (with `default_branch` true for what landed on the default branch without a pull request), reviews, packages, and workflow runs that finished (`workflow`, `run_number`, `conclusion`, `run_id` for workflow get_run, and `production` true for a run of a deploy workflow on the default branch: a repository that deploys itself). Each event has its `kind`, `time`, `repo` (owner/name), `actor` (a username), and where it has them its `number`, `title`, `url` (its page on g1t), `branch`, `commit`, `commits`, `tag` and `error`. `summary` counts merged pull requests, releases, production deployments (projects' production deployments and successful deploy runs on default branches), failed ones, default-branch pushes and failed runs, and in `shipped` the landed commits by where they are. `landed` lists the commits made on default branches in the span, one line each (`repo`, `commit`, `subject`, `author` as git wrote it, `username` when the author's address is a g1t account's, `time`, `url`), and, where the repository deploys, `production`: `live` (a successful deploy carried it, named in `deploy` with its `url`), `deploying`, `failed` (its deploy failed and none since succeeded) or `not_deployed`. That is what shipped: what reached the default branch, and which of it is live. The span is `since` to `until` (RFC 3339; the last 24 hours when `since` is left out, at most 31 days); narrow it with `kinds` (merged, pulls, work_items, releases, deployments, pushes, reviews, comments, packages, runs; all but comments when left out) and `limit` (100 unless you say, at most 200). `complete` is false when more happened than was read: narrow the span or the kinds. For one repository's full timeline use list_events."
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
                "description": "What to read: merged (merged pull requests only), pulls, work_items, releases, deployments, pushes, reviews, comments, packages, runs (workflow runs that finished). All but comments when left out.",
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
            Some(text) => {
                parse_rfc3339(text).map(Some).ok_or_else(|| format!("{key} must be an RFC 3339 time, such as 2026-10-12T00:00:00Z."))
            }
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
                if let Some(item) = data.get("item").and_then(Value::as_u64) {
                    shown["item"] = json!(item);
                }
                if event.kind == "pull.merged" {
                    merged += 1;
                }
            }
            "work_item.opened" | "work_item.closed" => {
                let Some(number) = number else { continue };
                shown["number"] = json!(number);
                if let Some(title) = text(data, "title") {
                    shown["title"] = json!(title);
                }
                if let Some(reason) = text(data, "reason") {
                    shown["reason"] = json!(reason);
                }
                // What landed it here: a merged pull request, or a commit
                // pushed to the default branch.
                if let Some(resolution) = data.get("resolution") {
                    if let Some(pull) = resolution.get("pull").and_then(Value::as_u64) {
                        shown["resolved_by"] = json!(pull);
                    }
                    if let Some(commit) = text(resolution, "commit") {
                        shown["resolved_commit"] = json!(commit);
                    }
                }
                let workspace = text(data, "workspace").unwrap_or(repo.namespace.as_str());
                shown["url"] = json!(format!("{site}/{workspace}/-/work/{number}"));
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
                if let Some(number) = number {
                    shown["number"] = json!(number);
                    // On a work item, its page in the workspace; else the
                    // pull request's.
                    shown["url"] = match (text(data, "itemId"), text(data, "workspace")) {
                        (Some(_), Some(workspace)) => json!(format!("{site}/{workspace}/-/work/{number}")),
                        _ => json!(format!("{page}/pull/{number}")),
                    };
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
                // A repository that deploys itself: its deploy workflow's
                // runs on the default branch are its production deployments.
                let on_default = text(data, "ref") == Some(format!("refs/heads/{}", repo.default_branch).as_str());
                if on_default
                    && text(data, "event") != Some("pull_request")
                    && deploy_workflow(text(data, "workflow").unwrap_or_default(), text(data, "path").unwrap_or_default())
                {
                    shown["production"] = json!(true);
                    match conclusion {
                        "success" => production += 1,
                        "failure" | "timed_out" => failed += 1,
                        _ => {}
                    }
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
            // The landed commits by where they are in production (`run`
            // fills it in).
            "shipped": shipped(&[]),
        },
        // What landed on default branches in the span, one line a commit
        // (`run` fills it in): what shipped where nothing was merged.
        "landed": [],
        "events": events,
        "complete": !found.more && found.repos.len() <= MAX_LIST_REPOS,
    })
}

/// Whether a workflow deploys: its name or file says so (Deploy,
/// deploy.yml, deploy-production.yml), and it is not for previews.
pub fn deploy_workflow(name: &str, path: &str) -> bool {
    let file = path.rsplit('/').next().unwrap_or_default();
    let named = format!("{name} {file}").to_lowercase();
    named.contains("deploy") && !named.contains("preview")
}

/// Where a deploy of a commit to production is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeployState {
    Succeeded,
    /// Queued, waiting or running.
    Running,
    Failed,
}

/// One deploy of a commit to production: a run of a repository's deploy
/// workflow on its default branch, or a project's production deployment.
#[derive(Clone, Debug, PartialEq)]
pub struct Deploy {
    pub sha: String,
    pub state: DeployState,
    /// What it was, for a person: "Deploy #311".
    pub label: String,
    pub url: String,
}

/// A run as a deploy to production, when it is one: its deploy workflow's,
/// on the default branch and not for a pull request. Cancelled and skipped
/// runs deployed nothing.
pub fn run_deploy(site: &str, repo: &str, default_branch: &str, run: &WorkflowRun) -> Option<Deploy> {
    if run.git_ref != format!("refs/heads/{default_branch}") || run.event == "pull_request" || !deploy_workflow(&run.name, &run.path) {
        return None;
    }
    let state = match (run.status.as_str(), run.conclusion.as_deref()) {
        ("completed", Some("success")) => DeployState::Succeeded,
        ("completed", Some("failure" | "timed_out")) => DeployState::Failed,
        ("completed", _) => return None,
        _ => DeployState::Running,
    };
    Some(Deploy {
        sha: run.sha.clone(),
        state,
        label: format!("{} #{}", run.name, run.number),
        url: format!("{}/{repo}/actions/runs/{}", site.trim_end_matches('/'), run.id),
    })
}

/// A repository's deploys to production that the events name: projects'
/// production deployments, and its deploy workflow's finished runs.
pub fn event_deploys(site: &str, repo: &Repo, events: &[Event]) -> Vec<Deploy> {
    let site = site.trim_end_matches('/');
    let full = format!("{}/{}", repo.namespace, repo.name);
    let mut found = Vec::new();
    for event in events.iter().filter(|event| event.repo_id.as_deref() == Some(repo.id.as_str())) {
        let data = &event.data;
        match event.kind.as_str() {
            "deployment.succeeded" | "deployment.failed" if text(data, "kind") == Some("production") => {
                let Some(sha) = text(data, "commit") else { continue };
                found.push(Deploy {
                    sha: sha.to_owned(),
                    state: if event.kind == "deployment.succeeded" { DeployState::Succeeded } else { DeployState::Failed },
                    label: format!("{}'s production deployment", text(data, "project").unwrap_or(&repo.name)),
                    url: match text(data, "path") {
                        Some(path) => format!("{site}{path}"),
                        None => format!("{site}/{full}/deployments"),
                    },
                });
            }
            "workflow.completed" => {
                let run = WorkflowRun {
                    id: text(data, "runId").unwrap_or_default().to_owned(),
                    path: text(data, "path").unwrap_or_default().to_owned(),
                    name: text(data, "workflow").unwrap_or_default().to_owned(),
                    number: data.get("number").and_then(Value::as_u64).unwrap_or_default(),
                    event: text(data, "event").unwrap_or_default().to_owned(),
                    git_ref: text(data, "ref").unwrap_or_default().to_owned(),
                    sha: text(data, "sha").unwrap_or_default().to_owned(),
                    status: "completed".to_owned(),
                    conclusion: text(data, "conclusion").map(str::to_owned),
                    ..WorkflowRun::default()
                };
                if run.id.is_empty() || run.sha.is_empty() {
                    continue;
                }
                found.extend(run_deploy(site, &full, &repo.default_branch, &run));
            }
            _ => {}
        }
    }
    found
}

/// Where each commit of a default branch's history (newest first) is in
/// production, given the deploys seen: `live` when a successful deploy was
/// of it or of a commit after it (which carries it), else `deploying` when
/// one is under way, `failed` when one failed, or `not_deployed`; with the
/// deploy that says so. None for every commit when the repository was not
/// seen deploying at all.
pub fn production<'a>(log: &[Commit], deploys: &'a [Deploy]) -> Vec<Option<(&'static str, Option<&'a Deploy>)>> {
    if deploys.is_empty() {
        return vec![None; log.len()];
    }
    let same = |sha: &str, hash: &str| !sha.is_empty() && (hash.starts_with(sha) || sha.starts_with(hash));
    // Each deploy at its commit's place in the history.
    let placed: Vec<(usize, &Deploy)> =
        deploys.iter().filter_map(|deploy| log.iter().position(|commit| same(&deploy.sha, &commit.hash)).map(|at| (at, deploy))).collect();
    // The nearest deploy at or after a commit in the given state: the one
    // that first carried it.
    let nearest = |index: usize, state: DeployState| {
        placed.iter().filter(|(at, deploy)| *at <= index && deploy.state == state).max_by_key(|(at, _)| *at).map(|(_, deploy)| *deploy)
    };
    (0..log.len())
        .map(|index| {
            Some(if let Some(deploy) = nearest(index, DeployState::Succeeded) {
                ("live", Some(deploy))
            } else if let Some(deploy) = nearest(index, DeployState::Running) {
                ("deploying", Some(deploy))
            } else if let Some(deploy) = nearest(index, DeployState::Failed) {
                ("failed", Some(deploy))
            } else {
                ("not_deployed", None)
            })
        })
        .collect()
}

/// One repository's default-branch commits made in the span, newest first,
/// each as one line: its short sha, the first line of its message, who
/// wrote it (and their username, when known), when, its page, and where it
/// is in production when the repository deploys.
pub fn landed(site: &str, repo: &str, commits: &[Commit], since: u64, until: u64, authors: &Authors, deploys: &[Deploy]) -> Vec<Value> {
    let site = site.trim_end_matches('/');
    let states = production(commits, deploys);
    commits
        .iter()
        .zip(states)
        .filter(|(commit, _)| parse_rfc3339(&commit.authored_at).is_some_and(|at| at >= since && at < until))
        .map(|(commit, state)| {
            let subject: String = commit.message.lines().next().unwrap_or_default().trim().chars().take(160).collect();
            let mut line = json!({
                "repo": repo,
                "commit": commit.hash.chars().take(12).collect::<String>(),
                "subject": subject,
                "author": commit.author.name,
                "time": commit.authored_at,
                "url": format!("{site}/{repo}/commit/{}", commit.hash),
            });
            if let Some(username) = commits::username(commit, authors) {
                line["username"] = json!(username);
            }
            if let Some((state, deploy)) = state {
                line["production"] = json!(state);
                if let Some(deploy) = deploy {
                    line["deploy"] = json!({ "name": deploy.label, "url": deploy.url });
                }
            }
            line
        })
        .collect()
}

/// How many landed commits are where, for the summary.
pub fn shipped(lines: &[Value]) -> Value {
    let count = |state: &str| lines.iter().filter(|line| line["production"] == state).count();
    json!({
        "live": count("live"),
        "deploying": count("deploying"),
        "failed": count("failed"),
        "not_deployed": count("not_deployed"),
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
    let mut answer = shape(&Found {
        workspace: &workspace,
        site: &site,
        since,
        until,
        repos: &repos,
        events: &events,
        more,
        pull_titles: &pull_titles,
        usernames: &usernames,
    });
    // The repositories whose default branch was pushed to, busiest first:
    // their commits say what landed.
    let mut pushed: Vec<(String, usize)> = Vec::new();
    for event in
        events.iter().filter(|event| event.kind == "git.push" && event.data.get("defaultBranch").and_then(Value::as_bool) == Some(true))
    {
        let Some(id) = event.repo_id.as_deref() else { continue };
        match pushed.iter_mut().find(|(known, _)| known == id) {
            Some((_, count)) => *count += 1,
            None => pushed.push((id.to_owned(), 1)),
        }
    }
    pushed.sort_by(|a, b| b.1.cmp(&a.1));
    let by_id: HashMap<&str, &Repo> = repos.iter().map(|repo| (repo.id.as_str(), repo)).collect();
    // Each one's history, and its default branch's runs in the span: the
    // deploys among them, finished or not, say what reached production.
    let logs = pushed.iter().take(LANDED_REPOS).filter_map(|(id, _)| by_id.get(id.as_str()).copied()).map(|repo| async move {
        let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        let log_args = LogArgs { path: path.clone(), viewer: viewer.clone(), git_ref: None, limit: LANDED_LOG };
        let runs_args = RunsArgs {
            repo: path,
            viewer: viewer.clone(),
            workflow: None,
            branch: Some(repo.default_branch.clone()),
            event: None,
            pull: None,
            sha: None,
            status: None,
            since: Some(rfc3339(since)),
            until: None,
            limit: Some(LANDED_RUNS),
        };
        let (log, runs) = futures_util::future::join(
            g1t_kit::call::<_, Outcome<Vec<Commit>>>(&services.repos, "log", &log_args),
            g1t_kit::call::<_, Outcome<Vec<WorkflowRun>>>(&services.actions, "runs", &runs_args),
        )
        .await;
        (repo, log, runs)
    });
    let mut histories = Vec::new();
    for (repo, log, runs) in futures_util::future::join_all(logs).await {
        // A history that cannot be read leaves the events to say it.
        let Ok(Outcome::Ok(commits)) = log else { continue };
        let full = format!("{}/{}", repo.namespace, repo.name);
        let mut deploys = event_deploys(&site, repo, &events);
        if let Ok(Outcome::Ok(runs)) = runs {
            for deploy in runs.iter().filter_map(|run| run_deploy(&site, &full, &repo.default_branch, run)) {
                // A run the events named too is the same deploy; the run says
                // where it is now.
                deploys.retain(|known| known.url != deploy.url);
                deploys.push(deploy);
            }
        }
        histories.push((full, commits, deploys));
    }
    let all: Vec<&Commit> = histories.iter().flat_map(|(_, commits, _)| commits.iter()).collect();
    let authors = commits::read_authors(services, &all).await;
    let mut lines = Vec::new();
    for (repo, commits, deploys) in &histories {
        lines.extend(landed(&site, repo, commits, since, until, &authors, deploys));
    }
    lines.truncate(LANDED_MAX);
    answer["summary"]["shipped"] = shipped(&lines);
    answer["landed"] = json!(lines);
    Ok(Outcome::Ok(answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(id: &str, name: &str) -> Repo {
        serde_json::from_value(json!({
            "id": id, "namespace": "acme", "name": name, "isPrivate": false,
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
    fn what_landed_is_one_line_a_commit_made_in_the_span() {
        use g1t_contracts::repos::Signature;
        let commit = |hash: &str, message: &str, at: &str| Commit {
            hash: hash.to_owned(),
            tree_hash: String::new(),
            message: message.to_owned(),
            author: Signature { name: "Chase".into(), email: String::new() },
            parents: Vec::new(),
            authored_at: at.to_owned(),
        };
        let commits = [
            commit(
                "aaaaaaaaaaaaaaaa",
                "Ask reads g1t

The long why.",
                "2026-10-13T05:00:00Z",
            ),
            commit("bbbbbbbbbbbbbbbb", "Yesterday's change", "2026-10-12T05:00:00Z"),
        ];
        let since = parse_rfc3339("2026-10-12T06:00:00Z").unwrap();
        let until = parse_rfc3339("2026-10-13T06:00:00Z").unwrap();
        let lines = landed("https://g1t.sh/", "acme/web", &commits, since, until, &Authors::new(), &[]);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["subject"], "Ask reads g1t");
        assert_eq!(lines[0]["commit"], "aaaaaaaaaaaa");
        assert_eq!(lines[0]["author"], "Chase");
        assert_eq!(lines[0]["url"], "https://g1t.sh/acme/web/commit/aaaaaaaaaaaaaaaa");
        // Nobody known by the address, and no deploys seen: no username made
        // up from the name, and nothing said about production.
        assert!(lines[0].get("username").is_none());
        assert!(lines[0].get("production").is_none());
    }

    fn by(hash: &str, email: &str, at: &str) -> Commit {
        Commit {
            hash: hash.to_owned(),
            tree_hash: String::new(),
            message: format!("Change {hash}"),
            author: g1t_contracts::repos::Signature { name: "Chase Pierce".into(), email: email.into() },
            parents: Vec::new(),
            authored_at: at.to_owned(),
        }
    }

    fn run(id: &str, name: &str, number: u64, sha: &str, status: &str, conclusion: Option<&str>) -> WorkflowRun {
        WorkflowRun {
            id: id.into(),
            path: ".g1t/workflows/deploy.yml".into(),
            name: name.into(),
            number,
            event: "push".into(),
            git_ref: "refs/heads/main".into(),
            sha: sha.into(),
            status: status.into(),
            conclusion: conclusion.map(str::to_owned),
            ..WorkflowRun::default()
        }
    }

    #[test]
    fn what_shipped_is_what_reached_the_default_branch_and_which_of_it_is_live() {
        // Newest first: e was pushed last and is still deploying, which
        // carries d, whose own deploy failed; c went out with Deploy #311,
        // which carried b and a too.
        let log = [
            by("eeee0000", "syntaqx@gmail.com", "2026-10-14T13:00:00Z"),
            by("dddd0000", "syntaqx@gmail.com", "2026-10-14T11:00:00Z"),
            by("cccc0000", "syntaqx@gmail.com", "2026-10-14T09:00:00Z"),
            by("bbbb0000", "someone@example.com", "2026-10-14T08:00:00Z"),
            by("aaaa0000", "syntaqx@gmail.com", "2026-10-13T08:00:00Z"),
        ];
        let site = "https://g1t.sh";
        let runs = [
            run("run_313", "Deploy", 313, "eeee0000", "in_progress", None),
            run("run_312", "Deploy", 312, "dddd0000", "completed", Some("failure")),
            run("run_311", "Deploy", 311, "cccc0000", "completed", Some("success")),
            // CI is not a deploy; a cancelled deploy deployed nothing; a
            // deploy of another branch is not production.
            WorkflowRun { path: ".g1t/workflows/ci.yml".into(), ..run("run_9", "CI", 9, "eeee0000", "completed", Some("success")) },
            run("run_310", "Deploy", 310, "dddd0000", "completed", Some("cancelled")),
            WorkflowRun { git_ref: "refs/heads/next".into(), ..run("run_8", "Deploy", 8, "eeee0000", "completed", Some("success")) },
        ];
        let deploys: Vec<Deploy> = runs.iter().filter_map(|found| run_deploy(site, "flagon-io/g1t", "main", found)).collect();
        assert_eq!(deploys.len(), 3);
        assert_eq!(
            deploys[2],
            Deploy {
                sha: "cccc0000".into(),
                state: DeployState::Succeeded,
                label: "Deploy #311".into(),
                url: "https://g1t.sh/flagon-io/g1t/actions/runs/run_311".into(),
            }
        );
        let owners = HashMap::from([(
            "syntaqx@gmail.com".to_owned(),
            g1t_contracts::accounts::EmailOwner { id: "usr_1".into(), username: "syntaqx".into(), avatar: None },
        )]);
        let authors = commits::authors(&log.iter().collect::<Vec<_>>(), &owners);
        let since = parse_rfc3339("2026-10-14T06:00:00Z").unwrap();
        let until = parse_rfc3339("2026-10-14T20:00:00Z").unwrap();
        let lines = landed(site, "flagon-io/g1t", &log, since, until, &authors, &deploys);
        let states: Vec<&str> = lines.iter().map(|line| line["production"].as_str().unwrap()).collect();
        assert_eq!(states, ["deploying", "deploying", "live", "live"], "a is yesterday's");
        assert_eq!(lines[2]["deploy"], json!({ "name": "Deploy #311", "url": "https://g1t.sh/flagon-io/g1t/actions/runs/run_311" }));
        assert_eq!(lines[1]["deploy"]["name"], "Deploy #313");
        // The author by their username; someone unknown by their name alone.
        assert_eq!(lines[0]["username"], "syntaqx");
        assert_eq!(lines[0]["author"], "Chase Pierce");
        assert!(lines[3].get("username").is_none());
        assert_eq!(shipped(&lines), json!({ "live": 2, "deploying": 2, "failed": 0, "not_deployed": 0 }));
        // Before #313 started: d failed to deploy, and e is not deployed.
        let lines = landed(site, "flagon-io/g1t", &log, since, until, &authors, &deploys[1..]);
        assert_eq!(shipped(&lines), json!({ "live": 2, "deploying": 0, "failed": 1, "not_deployed": 1 }));
        assert_eq!(lines[1]["deploy"]["name"], "Deploy #312");
        assert!(lines[0].get("deploy").is_none());
        // Once #313 succeeds, everything is live; before any deploy of today's
        // commits, they are not deployed.
        let done = [Deploy { state: DeployState::Succeeded, ..deploys[0].clone() }];
        assert!(production(&log, &done).iter().all(|state| state.map(|(state, _)| state) == Some("live")));
        let old = [Deploy { sha: "ffff9999".into(), ..deploys[2].clone() }];
        assert!(production(&log, &old).iter().all(|state| state.map(|(state, _)| state) == Some("not_deployed")));
        assert!(production(&log, &[]).iter().all(Option::is_none));
    }

    #[test]
    fn deploy_workflows_are_known_by_name_or_file() {
        assert!(deploy_workflow("Deploy", ".g1t/workflows/deploy.yml"));
        assert!(deploy_workflow("Ship it", ".g1t/workflows/deploy-production.yml"));
        assert!(deploy_workflow("Deploy site", ".g1t/workflows/site.yml"));
        assert!(!deploy_workflow("CI", ".g1t/workflows/ci.yml"));
        assert!(!deploy_workflow("Deploy preview", ".g1t/workflows/preview.yml"));
    }

    #[test]
    fn what_shipped_reads_as_one_list_with_links_and_names() {
        let repos = [repo("rep_1", "web"), repo("rep_2", "api")];
        let events = [
            event(
                "deployment.succeeded",
                "rep_1",
                "2026-10-12T15:00:00Z",
                "usr_1",
                json!({ "kind": "production", "project": "web", "commit": "abcdef1234567890", "path": "/acme/web/deployments/dpl_1", "triggeredBy": "ana" }),
            ),
            event(
                "release.published",
                "rep_2",
                "2026-10-12T14:00:00Z",
                "usr_2",
                json!({ "tagName": "v1.2.0", "release": { "name": "Faster pushes" } }),
            ),
            event("pull.merged", "rep_1", "2026-10-12T13:00:00Z", "usr_1", json!({ "number": 7, "item": 3 })),
            event(
                "git.push",
                "rep_2",
                "2026-10-12T12:00:00Z",
                "usr_2",
                json!({ "ref": "refs/heads/main", "after": "0123456789abcdef", "defaultBranch": true, "commits": 2 }),
            ),
            event("git.push", "rep_2", "2026-10-12T11:00:00Z", "usr_2", json!({ "ref": "refs/tags/v1.2.0", "after": "0123" })),
            event(
                "workflow.completed",
                "rep_1",
                "2026-10-12T11:30:00Z",
                "usr_1",
                json!({ "runId": "run_257", "workflow": "Deploy", "number": 257, "conclusion": "failure", "ref": "refs/heads/main", "sha": "fedcba9876543210" }),
            ),
            event(
                "work_item.closed",
                "rep_1",
                "2026-10-12T10:00:00Z",
                "usr_1",
                json!({ "workspace": "acme", "number": 3, "title": "Login fails", "reason": "completed", "resolution": { "repo": "acme/web", "pull": 7 } }),
            ),
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
            json!({
                "merged_pull_requests": 1, "releases": 1, "production_deployments": 1, "failed_deployments": 1, "default_branch_pushes": 1, "failed_runs": 1,
                "shipped": { "live": 0, "deploying": 0, "failed": 0, "not_deployed": 0 },
            })
        );
        let listed = shown["events"].as_array().unwrap();
        assert_eq!(listed.len(), 6, "{listed:#?}");
        assert_eq!(listed[0]["url"], "https://g1t.sh/acme/web/deployments/dpl_1");
        assert_eq!(listed[0]["commit"], "abcdef123456");
        assert_eq!(listed[1]["title"], "Faster pushes");
        assert_eq!(listed[1]["url"], "https://g1t.sh/acme/api/releases/tag/v1.2.0");
        assert_eq!(
            listed[2],
            json!({ "kind": "pull_merged", "time": "2026-10-12T13:00:00Z", "repo": "acme/web", "actor": "ana", "number": 7, "title": "Fix login", "url": "https://g1t.sh/acme/web/pull/7", "item": 3 })
        );
        assert_eq!(listed[3]["default_branch"], true);
        assert_eq!(listed[3]["actor"], "bo");
        assert_eq!(
            listed[4],
            json!({ "kind": "workflow_completed", "time": "2026-10-12T11:30:00Z", "repo": "acme/web", "actor": "ana", "workflow": "Deploy", "run_number": 257, "conclusion": "failure", "branch": "main", "commit": "fedcba987654", "run_id": "run_257", "url": "https://g1t.sh/acme/web/actions/runs/run_257", "production": true })
        );
        assert_eq!(listed[5]["resolved_by"], 7);
        assert_eq!(listed[5]["url"], "https://g1t.sh/acme/-/work/3");
        assert_eq!(shown["complete"], true);
    }

    #[test]
    fn a_work_item_a_commit_closed_names_the_commit() {
        let repos = [repo("rep_1", "web")];
        let events = [event(
            "work_item.closed",
            "rep_1",
            "2026-10-12T10:00:00Z",
            "usr_1",
            json!({ "workspace": "acme", "number": 3, "title": "Login fails", "reason": "completed", "resolution": { "repo": "acme/web", "commit": "0123456789abcdef0123456789abcdef01234567" } }),
        )];
        let names = HashMap::from([("usr_1".to_owned(), "ana".to_owned())]);
        let shown = shape(&Found {
            workspace: "acme",
            site: "https://g1t.sh/",
            since: parse_rfc3339("2026-10-12T00:00:00Z").unwrap(),
            until: parse_rfc3339("2026-10-12T18:00:00Z").unwrap(),
            repos: &repos,
            events: &events,
            more: false,
            pull_titles: &HashMap::new(),
            usernames: &names,
        });
        let closed = &shown["events"][0];
        assert_eq!(closed["resolved_commit"], "0123456789abcdef0123456789abcdef01234567");
        assert!(closed.get("resolved_by").is_none());
        assert_eq!(closed["actor"], "ana");
    }
}
