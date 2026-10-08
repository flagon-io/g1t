//! The inbox, kept beside the event log. See `g1t_contracts::inbox`.
//!
//! As each batch arrives from the bus, the events that tell someone are
//! read against what they name (the work service's `inbox_subject`), who
//! subscribes to it and who watches its repository (subscriptions.rs), and
//! each person told gets their thread about it brought to the top, unread,
//! with a line added to its history. Who is told is worked out in
//! [`notices`], from the event, its subject and that audience alone:
//!
//! | Event | Who | Reason | Severity |
//! | --- | --- | --- | --- |
//! | `agent.asked`, `pull.stalled` | the pull request's owner, and its issue's owner and assignees | agent | warning |
//! | `pull.review_requested` | the reviewers asked, and the people each team asked tells | review_requested | warning |
//! | `issue.assigned`, `pull.assigned` | the people newly assigned | assign | info |
//! | `checks.completed`, failed or errored | the pull request's owner | ci_activity | error |
//! | `workflow.completed`, failed | the pull request's owner, or whoever pushed | ci_activity | error |
//! | `deployment.failed` | the pull request's owner, or whoever pushed; watchers | ci_activity | error |
//! | `deployment.succeeded` after a failure | the same | ci_activity | success |
//! | `review.completed` by g1t | the pull request's owner | author | success, or info for changes asked |
//! | `pull.ready` for a change g1t made | whoever asked g1t for it | author | success |
//! | `pull.merged`, `pull.closed`, `issue.closed`, `issue.reopened` | everyone subscribed | state_change | success for a merge, else info |
//! | `comment.created` | everyone mentioned, the people of teams mentioned, then everyone subscribed | mention, team_mention, or why they are subscribed | info (success for an approval) |
//! | `issue.opened`, `pull.opened` | whoever was assigned, asked to review or mentioned in its description (people and teams); watchers | assign, review_requested, mention, team_mention, subscribed | info |
//!
//! Watchers of a repository at `all` (or `custom`, for the kinds they
//! chose) hear of every issue and pull request opened, commented on,
//! closed, reopened or merged, and of deployments. Anyone who ignores the
//! thread or the repository hears of nothing on it; anyone who
//! unsubscribed hears only of what is asked of them.
//!
//! Nobody is told of what they did themselves, though an outcome they set
//! off (checks, a workflow, a deployment, g1t's work) is theirs to hear of.
//! g1t is never told. A failure here is logged and the batch goes on: the
//! bus never waits on the inbox, so an item can be missed, but nothing else
//! is held up.

use std::collections::{HashMap, HashSet};

use g1t_contracts::credentials::Principal;
use g1t_contracts::events::{Event, WorkspaceRenamed};
use g1t_contracts::identity::{AGENT_ID, UsernamesArgs};
use g1t_contracts::inbox::*;
use g1t_contracts::repos::{PathByIdArgs, ReadableArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{new_id, system};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Fetcher, Result};

use crate::subscriptions::{self, Audience};

/// Items marked done are kept this long, then removed.
pub const DONE_DAYS: u32 = 30;
/// No item is kept longer than this, unless it was saved.
pub const MAX_DAYS: u32 = 180;
/// Unread warnings shown ahead of everything else on the first page.
const MAX_RANKED: u32 = 20;
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 300;

/// What the inbox asks about an event before deciding who is told.
#[derive(Debug, PartialEq, Eq)]
pub struct Wanted {
    pub repo_id: String,
    /// The issue or pull request, when the event names one.
    pub number: Option<u32>,
    pub comment_id: Option<String>,
}

/// One person to tell, and what.
#[derive(Debug, PartialEq, Eq)]
pub struct Notice {
    pub username: String,
    pub reason: Reason,
    pub severity: Severity,
    pub title: String,
    pub body: String,
}

/// Who did it, as far as is known.
#[derive(Debug, Default)]
pub struct Actor {
    pub id: Option<String>,
    pub username: Option<String>,
}

impl Actor {
    fn is(&self, person: &Principal) -> bool {
        self.id.as_deref().is_some_and(|id| id == person.id) || self.is_named(&person.username)
    }

    fn is_named(&self, username: &str) -> bool {
        self.username.as_deref().is_some_and(|name| name.eq_ignore_ascii_case(username))
    }

    /// A person's name, for a title: never g1t's ids.
    fn name(&self) -> Option<&str> {
        self.username.as_deref().filter(|name| !is_g1t(name))
    }
}

pub(crate) fn is_g1t(username: &str) -> bool {
    username.eq_ignore_ascii_case(system::USERNAME) || username.eq_ignore_ascii_case("g1t-agent")
}

pub(crate) fn is_g1t_id(id: &str) -> bool {
    system::is_system_id(id) || id == AGENT_ID
}

/// Events that end what an agent was waiting on a person for: it picked
/// back up, its head moved, a merge was asked for, or it is over.
const RESUMES: [&str; 5] = ["pull.resumed", "pull.updated", "pull.merge_requested", "pull.merged", "pull.closed"];

/// The issue or pull request an event names, and what to read for it.
/// None for events the inbox does not tell anyone of.
pub fn wants(event: &Event) -> Option<Wanted> {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    let number = |key: &str| data[key].as_u64().and_then(|n| u32::try_from(n).ok());
    let repo_id = text("repoId").or_else(|| event.repo_id.clone())?;
    let on = |number: Option<u32>, comment_id: Option<String>| {
        Some(Wanted {
            repo_id: repo_id.clone(),
            number,
            comment_id,
        })
    };
    match event.kind.as_str() {
        "agent.asked" | "pull.stalled" | "pull.merged" | "pull.closed" | "pull.ready" | "pull.opened"
        | "pull.review_requested" | "pull.assigned" | "issue.opened" | "issue.closed" | "issue.reopened"
        | "issue.assigned" => on(Some(number("number")?), None),
        "checks.completed" => match data["status"].as_str() {
            Some("failed" | "errored") => on(Some(number("number")?), None),
            _ => None,
        },
        "review.completed" => match data["verdict"].as_str() {
            Some("approve" | "request_changes") => on(Some(number("number")?), None),
            _ => None,
        },
        "workflow.completed" => match data["conclusion"].as_str() {
            Some("failure") => on(number("pull"), None),
            _ => None,
        },
        "deployment.failed" | "deployment.succeeded" => on(number("number"), None),
        // A workflow run's jobs wait for their environment's reviewers.
        "deployment.review_requested" => on(None, None),
        "comment.created" => on(Some(number("number")?), Some(text("commentId")?)),
        // Security alerts are threads of their own, not of an issue.
        kind if SECURITY_EVENTS.contains(&kind) => on(None, None),
        _ => None,
    }
}

/// The security service's events the inbox tells people of: new alerts,
/// and push protection bypasses asked for and decided. Fixes and
/// dismissals are on the Security page and in webhooks.
pub const SECURITY_EVENTS: [&str; 5] = [
    "secret_scanning_alert.created",
    "code_scanning_alert.created",
    "vulnerability_alert.created",
    "secret_scanning.bypass_requested",
    "secret_scanning.bypass_reviewed",
];

/// Where an event's items go: which thread, what it is, and where it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thread {
    pub key: String,
    pub kind: Option<SubjectKind>,
    pub number: Option<u32>,
    pub run_id: Option<String>,
    /// A path, for a subject with a page of its own.
    pub link: Option<String>,
}

/// The thread key of an issue or pull request.
pub fn numbered_thread(repo_id: &str, number: u32) -> String {
    format!("{repo_id}#{number}")
}

/// The thread an event's items go to.
pub fn thread_of(event: &Event, wanted: &Wanted, subject: Option<&InboxSubject>) -> Thread {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    match event.kind.as_str() {
        // A project's production, or one pull request's preview.
        "deployment.failed" | "deployment.succeeded" => {
            let which = wanted.number.map_or_else(|| "production".to_owned(), |number| number.to_string());
            Thread {
                key: format!("{}/deploy/{}/{which}", wanted.repo_id, text("projectId").unwrap_or_default()),
                kind: Some(SubjectKind::Deploy),
                number: wanted.number,
                run_id: text("deploymentId"),
                link: text("path"),
            }
        }
        // One run's deployment to one environment, waiting for review.
        "deployment.review_requested" => Thread {
            key: format!(
                "{}/review/{}/{}",
                wanted.repo_id,
                text("runId").unwrap_or_default(),
                text("environment").unwrap_or_default()
            ),
            kind: Some(SubjectKind::Run),
            number: None,
            run_id: text("runId"),
            link: text("link"),
        },
        // A workflow on a branch: its next failure bumps the same thread.
        "workflow.completed" if subject.is_none() => {
            let branch = text("ref").unwrap_or_default();
            let branch = branch.strip_prefix("refs/heads/").unwrap_or(&branch).to_owned();
            let workflow = text("path").or_else(|| text("workflow")).unwrap_or_default();
            Thread {
                key: format!("{}/run/{workflow}@{branch}", wanted.repo_id),
                kind: Some(SubjectKind::Run),
                number: None,
                run_id: text("runId"),
                link: None,
            }
        }
        // One alert, or one bypass request: its page is the link.
        kind if SECURITY_EVENTS.contains(&kind) => {
            let which = text("requestId").or_else(|| text("alertId")).unwrap_or_else(|| event.id.clone());
            Thread {
                key: format!("{}/security/{which}", wanted.repo_id),
                kind: None,
                number: None,
                run_id: None,
                link: text("link"),
            }
        }
        _ => match wanted.number {
            Some(number) => Thread {
                key: numbered_thread(&wanted.repo_id, number),
                kind: subject.and_then(|subject| subject.kind),
                number: Some(number),
                run_id: None,
                link: None,
            },
            None => Thread {
                key: format!("event/{}", event.id),
                kind: None,
                number: None,
                run_id: None,
                link: None,
            },
        },
    }
}

/// The issue or pull request whose agent threads an event closes: what an
/// agent was waiting on a person for is over.
pub fn resolves(event: &Event) -> Option<String> {
    if !RESUMES.contains(&event.kind.as_str()) {
        return None;
    }
    let repo_id = event.data["repoId"].as_str().map(str::to_owned).or_else(|| event.repo_id.clone())?;
    let number = event.data["number"].as_u64().and_then(|n| u32::try_from(n).ok())?;
    Some(numbered_thread(&repo_id, number))
}

/// Collects who is told, each once with the most specific reason, never
/// the actor, never g1t, and never anyone ignoring the thread.
struct Told<'a> {
    actor: &'a Actor,
    audience: &'a Audience,
    notices: Vec<Notice>,
}

impl Told<'_> {
    /// `asked`: something asked of the person directly, told even when
    /// they unsubscribed from the thread.
    fn tell(&mut self, username: &str, reason: Reason, severity: Severity, title: &str, body: &str, asked: bool) {
        let username = username.trim().trim_start_matches('@').to_lowercase();
        if username.is_empty()
            || is_g1t(&username)
            || self.actor.is_named(&username)
            || self.audience.ignores(&username)
            || (!asked && self.audience.unsubscribed(&username))
        {
            return;
        }
        let notice = Notice {
            username,
            reason,
            severity,
            title: clip(title, MAX_TITLE),
            body: clip(body, MAX_BODY),
        };
        match self.notices.iter_mut().find(|told| told.username == notice.username) {
            Some(told) if notice.reason.rank() < told.reason.rank() => *told = notice,
            Some(_) => {}
            None => self.notices.push(notice),
        }
    }

    /// A person known by id as well as name, such as an author.
    fn tell_person(&mut self, person: &Principal, reason: Reason, severity: Severity, title: &str, body: &str, asked: bool) {
        if is_g1t_id(&person.id) || self.actor.is(person) {
            return;
        }
        self.tell(&person.username, reason, severity, title, body, asked);
    }

    /// Everyone subscribed to an issue or pull request: its owner and
    /// author, its assignees and reviewers, and whoever subscribed by
    /// commenting, being mentioned or by hand. `reason` overrides why
    /// each is told, as a state change does.
    fn tell_subscribed(&mut self, subject: &InboxSubject, reason: Option<Reason>, severity: Severity, title: &str, body: &str) {
        let why = |own: Reason| reason.unwrap_or(own);
        self.tell_person(subject.owner(), why(Reason::Author), severity, title, body, false);
        self.tell_person(&subject.author, why(Reason::Author), severity, title, body, false);
        for name in &subject.assignees {
            self.tell(name, why(Reason::Assign), severity, title, body, false);
        }
        for name in &subject.reviewers {
            self.tell(name, why(Reason::ReviewRequested), severity, title, body, false);
        }
        let subscribed: Vec<(String, Reason)> = self.audience.subscribed().collect();
        for (name, own) in subscribed {
            self.tell(&name, why(own), severity, title, body, false);
        }
    }

    /// Everyone watching the repository for this kind of activity.
    fn tell_watchers(&mut self, kind: &str, severity: Severity, title: &str, body: &str) {
        let watching: Vec<String> = self.audience.watching(kind).collect();
        for name in watching {
            self.tell(&name, Reason::Subscribed, severity, title, body, false);
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The kind of activity a watcher chooses: `issues` or `pulls`.
fn activity_of(subject: &InboxSubject) -> &'static str {
    match subject.kind {
        Some(SubjectKind::Pull) => "pulls",
        _ => "issues",
    }
}

/// The names in an event's list field, such as the reviewers just asked.
/// The teams an event asked to review: each `workspace/slug` with the
/// people it tells.
fn teams_asked(data: &serde_json::Value) -> Vec<(String, Vec<String>)> {
    data["teams"]
        .as_array()
        .map(|teams| {
            teams
                .iter()
                .filter_map(|team| Some((team["team"].as_str()?.to_owned(), names(team, "notified"))))
                .collect()
        })
        .unwrap_or_default()
}

fn names(data: &serde_json::Value, key: &str) -> Vec<String> {
    data[key]
        .as_array()
        .map(|names| names.iter().filter_map(|name| name.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

/// Who is told of `event`, in `repo` (`owner/name`), given what it names
/// and who follows it. `actor` is who caused it; outcomes nobody chose
/// (checks, workflows, deployments, a review, an agent finishing or
/// stopping) are told whoever caused them.
pub fn notices(event: &Event, repo: &str, actor: &Actor, subject: Option<&InboxSubject>, audience: &Audience) -> Vec<Notice> {
    let nobody = Actor::default();
    let data = &event.data;
    // The issue or pull request, as titles name it: `acme/rocket#12`.
    let at = match data["number"].as_u64().or(data["pull"].as_u64()) {
        Some(number) if subject.is_some() => format!("{repo}#{number}"),
        _ => repo.to_owned(),
    };
    let outcome = matches!(
        event.kind.as_str(),
        "checks.completed"
            | "workflow.completed"
            | "review.completed"
            | "pull.ready"
            | "agent.asked"
            | "pull.stalled"
            | "deployment.failed"
            | "deployment.succeeded"
            | "deployment.review_requested"
    ) || SECURITY_EVENTS.contains(&event.kind.as_str());
    let mut told = Told {
        actor: if outcome { &nobody } else { actor },
        audience,
        notices: Vec::new(),
    };
    // Who did it, as titles name them.
    let who = actor.name().unwrap_or("g1t");

    match (event.kind.as_str(), subject) {
        ("agent.asked" | "pull.stalled", Some(pull)) => {
            let (title, body) = if event.kind == "agent.asked" {
                (format!("An agent is waiting on {at}"), pull.title.clone())
            } else {
                let detail = data["detail"].as_str().map(str::trim).filter(|detail| !detail.is_empty());
                (format!("g1t stopped on {at} and needs you"), detail.unwrap_or(&pull.title).to_owned())
            };
            told.tell_person(pull.owner(), Reason::Agent, Severity::Warning, &title, &body, true);
            if let Some(issue) = &pull.issue {
                told.tell_person(issue.owner(), Reason::Agent, Severity::Warning, &title, &body, true);
                for name in &issue.assignees {
                    told.tell(name, Reason::Agent, Severity::Warning, &title, &body, true);
                }
            }
        }
        ("pull.review_requested", Some(pull)) => {
            // Asked because the CODEOWNERS file says they own what changed.
            let owned = data["codeOwners"].as_bool() == Some(true);
            let title = if owned {
                format!("{at} changes files you own")
            } else {
                format!("{who} asked you to review {at}")
            };
            for name in names(data, "reviewers") {
                told.tell(&name, Reason::ReviewRequested, Severity::Warning, &title, &pull.title, true);
            }
            for (team, people) in teams_asked(data) {
                let title = if owned {
                    format!("{at} changes files @{team} owns")
                } else {
                    format!("{who} asked @{team} to review {at}")
                };
                for name in people {
                    told.tell(&name, Reason::ReviewRequested, Severity::Warning, &title, &pull.title, true);
                }
            }
        }
        ("issue.assigned" | "pull.assigned", Some(on)) => {
            let title = format!("{who} assigned you to {at}");
            for name in names(data, "added") {
                told.tell(&name, Reason::Assign, Severity::Info, &title, &on.title, true);
            }
        }
        ("issue.opened" | "pull.opened", Some(on)) => {
            let title = format!("{who} opened {at}");
            for name in &on.assignees {
                told.tell(name, Reason::Assign, Severity::Info, &format!("{who} assigned you to {at}"), &on.title, true);
            }
            for name in &on.reviewers {
                told.tell(name, Reason::ReviewRequested, Severity::Warning, &format!("{who} asked you to review {at}"), &on.title, true);
            }
            for name in &on.mentions {
                told.tell(name, Reason::Mention, Severity::Info, &format!("{who} mentioned you on {at}"), &on.title, true);
            }
            for team in &on.team_mentions {
                let title = format!("{who} mentioned @{} on {at}", team.team);
                for name in &team.members {
                    told.tell(name, Reason::TeamMention, Severity::Info, &title, &on.title, true);
                }
            }
            told.tell_watchers(activity_of(on), Severity::Info, &title, &on.title);
        }
        ("checks.completed", Some(pull)) => {
            let title = match data["status"].as_str() {
                Some("errored") => format!("Checks could not run on {at}"),
                _ => format!("Checks failed on {at}"),
            };
            told.tell_person(pull.owner(), Reason::CiActivity, Severity::Error, &title, &pull.title, true);
        }
        ("workflow.completed", subject) => {
            let workflow = data["workflow"].as_str().filter(|name| !name.is_empty()).unwrap_or("A workflow");
            match subject {
                Some(pull) => {
                    let title = format!("{workflow} failed on {at}");
                    told.tell_person(pull.owner(), Reason::CiActivity, Severity::Error, &title, &pull.title, true);
                }
                None => {
                    // Not on a pull request: whoever pushed the commit it ran on.
                    let branch = data["ref"].as_str().unwrap_or_default();
                    let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
                    let title = format!("{workflow} failed on {branch} in {repo}");
                    let body = format!("Run {} at {}", data["number"], short(data["sha"].as_str().unwrap_or_default()));
                    if let Some(id) = &actor.id
                        && !is_g1t_id(id)
                        && let Some(name) = &actor.username
                    {
                        told.tell(name, Reason::CiActivity, Severity::Error, &title, &body, true);
                    }
                }
            }
        }
        ("deployment.failed" | "deployment.succeeded", subject) => {
            let failed = event.kind == "deployment.failed";
            let project = data["project"].as_str().filter(|name| !name.is_empty()).unwrap_or(repo);
            let what = match subject {
                Some(_) => format!("The preview of {at}"),
                None => format!("Production of {project}"),
            };
            let (title, severity) = if failed {
                (format!("{what} failed to deploy"), Severity::Error)
            } else {
                (format!("{what} is live"), Severity::Success)
            };
            let body = match (failed, data["error"].as_str().map(str::trim).filter(|error| !error.is_empty())) {
                (true, Some(error)) => error.to_owned(),
                _ => match subject {
                    Some(pull) => pull.title.clone(),
                    None => format!("Commit {}", short(data["commit"].as_str().unwrap_or_default())),
                },
            };
            // A success is news to whoever answers for it only after a failure.
            if failed || data["recovered"].as_bool() == Some(true) {
                let title = if failed { title.clone() } else { format!("{what} is live again") };
                match subject {
                    Some(pull) => told.tell_person(pull.owner(), Reason::CiActivity, severity, &title, &body, true),
                    None => {
                        let pusher = actor
                            .id
                            .as_deref()
                            .filter(|id| !is_g1t_id(id))
                            .and(actor.username.as_deref())
                            .or_else(|| data["triggeredBy"].as_str());
                        if let Some(name) = pusher {
                            told.tell(name, Reason::CiActivity, severity, &title, &body, true);
                        }
                    }
                }
            }
            told.tell_watchers("deployments", severity, &title, &body);
        }
        ("review.completed", Some(pull)) => {
            let (title, severity) = match data["verdict"].as_str() {
                Some("approve") => (format!("g1t approved {at}"), Severity::Success),
                _ => (format!("g1t asked for changes on {at}"), Severity::Info),
            };
            told.tell_person(pull.owner(), Reason::Author, severity, &title, &pull.title, true);
        }
        ("pull.ready", Some(pull)) => {
            // A change g1t made is ready: the agent's run is over.
            if let Some(owner) = pull.requested_by.as_ref().filter(|_| is_g1t_id(&pull.author.id) || is_g1t(&pull.author.username)) {
                let title = format!("g1t finished {at}");
                told.tell_person(owner, Reason::Author, Severity::Success, &title, &pull.title, true);
            }
        }
        ("pull.merged" | "pull.closed" | "issue.closed" | "issue.reopened", Some(on)) => {
            let (verb, severity) = match event.kind.as_str() {
                "pull.merged" => ("merged", Severity::Success),
                "issue.reopened" => ("reopened", Severity::Info),
                _ => ("closed", Severity::Info),
            };
            let title = match (actor.name(), data["resolvedBy"].as_u64()) {
                (_, Some(pull)) if event.kind == "issue.closed" => format!("{at} was closed by #{pull}"),
                (Some(name), _) => format!("{name} {verb} {at}"),
                (None, _) => format!("{at} was {verb}"),
            };
            told.tell_subscribed(on, Some(Reason::StateChange), severity, &title, &on.title);
            told.tell_watchers(activity_of(on), severity, &title, &on.title);
        }
        ("deployment.review_requested", _) => {
            let environment = data["environment"].as_str().unwrap_or("an environment");
            let workflow = data["workflow"].as_str().unwrap_or("A workflow");
            let title = format!("{workflow} is waiting for your review to deploy to {environment} in {repo}");
            let body = data["title"].as_str().unwrap_or_default();
            // Those the actions service names: the environment's reviewers.
            for name in names(data, "notify") {
                told.tell(&name, Reason::ReviewRequested, Severity::Warning, &title, body, true);
            }
        }
        (kind, None) if SECURITY_EVENTS.contains(&kind) => {
            let severity = match data["severity"].as_str() {
                _ if kind == "secret_scanning.bypass_requested" => Severity::Warning,
                _ if kind == "secret_scanning.bypass_reviewed" => Severity::Info,
                Some("critical" | "high") => Severity::Error,
                _ => Severity::Warning,
            };
            let what = data["title"].as_str().unwrap_or("A security alert");
            let title = match kind {
                "secret_scanning.bypass_requested" => format!("{who} asked to bypass push protection in {repo}"),
                "secret_scanning.bypass_reviewed" => {
                    let verdict = data["state"].as_str().unwrap_or("reviewed");
                    format!("Your request to bypass push protection in {repo} was {verdict}")
                }
                _ if data["pusher"].is_string() => format!("A push to {repo} was blocked: it adds a secret"),
                _ => format!("New security alert in {repo}"),
            };
            // Whoever pushed a blocked secret, and those the service names
            // (the workspace's owners, or whoever asked for a bypass).
            if let Some(pusher) = data["pusher"].as_str() {
                told.tell(pusher, Reason::SecurityAlert, Severity::Error, &title, what, true);
            }
            for name in names(data, "notify") {
                told.tell(&name, Reason::SecurityAlert, severity, &title, what, true);
            }
            // Watchers who chose security alerts, if they may see findings:
            // the service lists who may (`members`), as findings are never
            // shown to someone who cannot change the code.
            if !kind.starts_with("secret_scanning.bypass") {
                let members = names(data, "members");
                let watching: Vec<String> = told.audience.watching("security").collect();
                for name in watching.iter().filter(|name| members.iter().any(|member| member.eq_ignore_ascii_case(name))) {
                    told.tell(name, Reason::SecurityAlert, severity, &title, what, false);
                }
            }
        }
        ("comment.created", Some(on)) => {
            let Some(comment) = on.comment.as_ref().filter(|comment| !comment.event) else {
                return Vec::new();
            };
            // Whoever wrote it is the actor, whatever the event says.
            let writer = Actor {
                id: Some(comment.author.id.clone()),
                username: Some(comment.author.username.clone()),
            };
            told.actor = &writer;
            let who = &comment.author.username;
            let body = if comment.excerpt.is_empty() { &on.title } else { &comment.excerpt };
            for name in &comment.mentions {
                let title = format!("{who} mentioned you on {at}");
                told.tell(name, Reason::Mention, Severity::Info, &title, body, true);
            }
            for team in &comment.team_mentions {
                let title = format!("{who} mentioned @{} on {at}", team.team);
                for name in &team.members {
                    told.tell(name, Reason::TeamMention, Severity::Info, &title, body, true);
                }
            }
            let (severity, title) = match comment.verdict.as_deref() {
                Some("approve") => (Severity::Success, format!("{who} approved {at}")),
                Some("request_changes") => (Severity::Info, format!("{who} asked for changes on {at}")),
                _ => (Severity::Info, format!("{who} commented on {at}")),
            };
            // An approval or a request for changes is the owner's to hear
            // of whatever they chose; the rest, as they subscribed.
            if comment.verdict.is_some() {
                told.tell_person(on.owner(), Reason::Author, severity, &title, body, true);
            }
            told.tell_subscribed(on, None, severity, &title, body);
            told.tell_watchers(activity_of(on), severity, &title, body);
            return told.notices;
        }
        _ => {}
    }
    told.notices
}

/// Who an event subscribes to its issue or pull request without asking,
/// and why: whoever commented, whoever they mentioned, the people assigned
/// and the reviewers asked. Never g1t.
pub fn subscribes(event: &Event, subject: Option<&InboxSubject>) -> Vec<(String, Reason)> {
    let mut people: Vec<(String, Reason)> = Vec::new();
    let mut add = |name: &str, reason: Reason| {
        let name = name.trim().trim_start_matches('@').to_lowercase();
        if !name.is_empty() && !is_g1t(&name) && !people.iter().any(|(had, _)| *had == name) {
            people.push((name, reason));
        }
    };
    match event.kind.as_str() {
        "comment.created" => {
            if let Some(comment) = subject.and_then(|subject| subject.comment.as_ref()).filter(|comment| !comment.event) {
                if !is_g1t_id(&comment.author.id) {
                    add(&comment.author.username, Reason::Comment);
                }
                for name in &comment.mentions {
                    add(name, Reason::Mention);
                }
                for team in &comment.team_mentions {
                    for name in &team.members {
                        add(name, Reason::TeamMention);
                    }
                }
            }
        }
        "issue.opened" | "pull.opened" => {
            if let Some(on) = subject {
                for name in &on.mentions {
                    add(name, Reason::Mention);
                }
                for team in &on.team_mentions {
                    for name in &team.members {
                        add(name, Reason::TeamMention);
                    }
                }
            }
        }
        "issue.assigned" | "pull.assigned" => {
            for name in names(&event.data, "added") {
                add(&name, Reason::Assign);
            }
        }
        "pull.review_requested" => {
            for name in names(&event.data, "reviewers") {
                add(&name, Reason::ReviewRequested);
            }
            for (_, people) in teams_asked(&event.data) {
                for name in people {
                    add(&name, Reason::ReviewRequested);
                }
            }
        }
        _ => {}
    }
    people
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// Where an item is on g1t.sh.
pub fn url(repo: Option<&str>, subject: Option<SubjectKind>, number: Option<u32>, run_id: Option<&str>, link: Option<&str>) -> String {
    if let Some(link) = link.filter(|link| link.starts_with('/')) {
        return link.to_owned();
    }
    let Some(repo) = repo else {
        return "/inbox".to_owned();
    };
    match (subject, number, run_id) {
        (Some(SubjectKind::Pull), Some(number), _) => format!("/{repo}/pull/{number}"),
        (Some(SubjectKind::Issue), Some(number), _) => format!("/{repo}/issues/{number}"),
        (Some(SubjectKind::Run), _, Some(run)) => format!("/{repo}/actions/runs/{run}"),
        (Some(SubjectKind::Deploy), Some(number), _) => format!("/{repo}/pull/{number}"),
        _ => format!("/{repo}"),
    }
}

// --- Writing ---------------------------------------------------------------

/// The services the inbox reads from as events arrive.
pub struct Sources<'a> {
    pub work: &'a Fetcher,
    pub repos: &'a Fetcher,
    pub identity: &'a Fetcher,
}

/// One notice written, and whether it was news (not a redelivery): what
/// may be emailed.
struct Written {
    notice: Notice,
    repo_id: String,
    url: String,
}

/// Writes the items a batch from the bus calls for. Never fails the batch:
/// what cannot be worked out is logged and left.
pub async fn deliver(db: &D1Database, sources: &Sources<'_>, events: &[Event]) {
    if let Err(error) = resolve(db, events).await {
        worker::console_error!("inbox: agent threads not closed: {error}");
    }
    let wanted: Vec<(&Event, Wanted)> = events
        .iter()
        .filter_map(|event| wants(event).map(|wanted| (event, wanted)))
        .collect();
    let created: Vec<&Event> = events.iter().filter(|event| event.kind == "repo.created").collect();
    if wanted.is_empty() && created.is_empty() {
        return;
    }
    // Everyone who caused one, named in one call.
    let ids: Vec<String> = wanted
        .iter()
        .map(|(event, _)| *event)
        .chain(created.iter().copied())
        .filter_map(|event| event.actor.clone())
        .filter(|id| !is_g1t_id(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let names: HashMap<String, String> = if ids.is_empty() {
        HashMap::new()
    } else {
        g1t_kit::call(sources.identity, "usernames", &UsernamesArgs { ids })
            .await
            .unwrap_or_else(|error| {
                worker::console_error!("inbox: could not name who acted: {error}");
                HashMap::new()
            })
    };
    for event in created {
        if let Err(error) = subscriptions::watch_created(db, event, &names).await {
            worker::console_error!("inbox: {} {} not watched: {error}", event.kind, event.id);
        }
    }
    let mut paths: HashMap<String, Option<RepoPath>> = HashMap::new();
    let mut watchers: HashMap<String, Vec<subscriptions::Watcher>> = HashMap::new();
    let mut written: Vec<Written> = Vec::new();
    for (event, wanted) in wanted {
        match deliver_one(db, sources, &names, &mut paths, &mut watchers, event, wanted).await {
            Ok(mut news) => written.append(&mut news),
            Err(error) => worker::console_error!("inbox: {} {} not delivered: {error}", event.kind, event.id),
        }
    }
    if let Err(error) = email(db, sources.identity, written).await {
        worker::console_error!("inbox: emails not sent: {error}");
    }
}

/// Closes what an agent was waiting on a person for once it is over.
async fn resolve(db: &D1Database, events: &[Event]) -> Result<()> {
    let now = rfc3339(now_ms());
    let mut statements = Vec::new();
    for thread in events.iter().filter_map(resolves) {
        statements.push(
            db.prepare(
                "UPDATE inbox_items SET done_at = ?1, read_at = COALESCE(read_at, ?1)
                 WHERE thread = ?2 AND reason = 'agent' AND done_at IS NULL",
            )
            .bind(&[now.as_str().into(), thread.into()])?,
        );
    }
    // Reviews no longer asked for are no longer waiting.
    for event in events.iter().filter(|event| event.kind == "pull.review_request_removed") {
        let (Some(repo_id), Some(number)) = (
            event.data["repoId"].as_str().map(str::to_owned).or_else(|| event.repo_id.clone()),
            event.data["number"].as_u64(),
        ) else {
            continue;
        };
        for name in names(&event.data, "reviewers") {
            statements.push(
                db.prepare(
                    "UPDATE inbox_items SET done_at = ?1, read_at = COALESCE(read_at, ?1)
                     WHERE thread = ?2 AND username = ?3 AND reason = 'review_requested' AND done_at IS NULL",
                )
                .bind(&[
                    now.as_str().into(),
                    format!("{repo_id}#{number}").into(),
                    name.to_lowercase().into(),
                ])?,
            );
        }
    }
    if !statements.is_empty() {
        db.batch(statements).await?;
    }
    Ok(())
}

async fn deliver_one(
    db: &D1Database,
    sources: &Sources<'_>,
    names: &HashMap<String, String>,
    paths: &mut HashMap<String, Option<RepoPath>>,
    watchers: &mut HashMap<String, Vec<subscriptions::Watcher>>,
    event: &Event,
    wanted: Wanted,
) -> Result<Vec<Written>> {
    if !paths.contains_key(&wanted.repo_id) {
        let path: Option<RepoPath> = g1t_kit::call(
            sources.repos,
            "path_by_id",
            &PathByIdArgs {
                id: wanted.repo_id.clone(),
            },
        )
        .await?;
        paths.insert(wanted.repo_id.clone(), path);
    }
    // A repository that is gone tells nobody.
    let Some(path) = paths.get(&wanted.repo_id).cloned().flatten() else {
        return Ok(Vec::new());
    };
    let subject: Option<InboxSubject> = match wanted.number {
        Some(number) => {
            let found: Option<InboxSubject> = g1t_kit::call(
                sources.work,
                "inbox_subject",
                &InboxSubjectArgs {
                    repo_id: wanted.repo_id.clone(),
                    number,
                    comment_id: wanted.comment_id.clone(),
                },
            )
            .await?;
            if found.is_none() {
                return Ok(Vec::new());
            }
            found
        }
        None => None,
    };
    let actor = Actor {
        id: event.actor.clone(),
        username: match event.actor.as_deref() {
            Some(id) if is_g1t_id(id) => Some(system::USERNAME.to_owned()),
            Some(id) => names.get(id).map(|name| name.to_lowercase()),
            None => None,
        },
    };
    let thread = thread_of(event, &wanted, subject.as_ref());
    if !watchers.contains_key(&wanted.repo_id) {
        watchers.insert(wanted.repo_id.clone(), subscriptions::watchers(db, &wanted.repo_id).await?);
    }
    let audience = Audience {
        subscriptions: match thread.kind {
            Some(SubjectKind::Issue | SubjectKind::Pull) => subscriptions::of_thread(db, &thread.key).await?,
            _ => Vec::new(),
        },
        watchers: watchers.get(&wanted.repo_id).cloned().unwrap_or_default(),
    };
    let repo = format!("{}/{}", path.namespace, path.name).to_lowercase();
    let told = notices(event, &repo, &actor, subject.as_ref(), &audience);
    let mut statements = subscriptions::auto_subscribe(db, &thread.key, &wanted.repo_id, &subscribes(event, subject.as_ref()), &event.time)?;
    if told.is_empty() {
        if !statements.is_empty() {
            db.batch(statements).await?;
        }
        return Ok(Vec::new());
    }
    let now = now_ms();
    let link = thread.link.as_deref();
    let item_url = url(Some(&repo), thread.kind, thread.number, thread.run_id.as_deref(), link);
    // Three statements a notice: its thread brought up (unless this event
    // was told before), a line of history, and the history kept short.
    let first = statements.len();
    for notice in &told {
        let username = notice.username.as_str();
        let values: Vec<JsValue> = vec![
            new_id("ntf", now).into(),
            username.into(),
            thread.key.as_str().into(),
            event.id.as_str().into(),
            event.kind.as_str().into(),
            notice.reason.as_str().into(),
            notice.severity.as_str().into(),
            notice.title.as_str().into(),
            notice.body.as_str().into(),
            path.namespace.to_lowercase().into(),
            wanted.repo_id.as_str().into(),
            repo.as_str().into(),
            thread.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
            thread.number.map_or(JsValue::NULL, JsValue::from),
            thread.run_id.as_deref().map_or(JsValue::NULL, JsValue::from),
            link.map_or(JsValue::NULL, JsValue::from),
            actor.username.as_deref().map_or(JsValue::NULL, JsValue::from),
            event.time.as_str().into(),
            // Same prefix as item ids, so old and new sort by time together.
            new_id("ntf", now).into(),
        ];
        statements.push(db.prepare(BUMP).bind(&values)?);
        statements.push(
            db.prepare(
                "INSERT OR IGNORE INTO inbox_activity (id, item_id, username, event_id, event, reason, severity, title, body, actor, created_at)
                 SELECT ?1, id, ?2, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 FROM inbox_items WHERE username = ?2 AND thread = ?3
                 RETURNING username",
            )
            .bind(&[
                new_id("ntf", now).into(),
                username.into(),
                thread.key.as_str().into(),
                event.id.as_str().into(),
                event.kind.as_str().into(),
                notice.reason.as_str().into(),
                notice.severity.as_str().into(),
                notice.title.as_str().into(),
                notice.body.as_str().into(),
                actor.username.as_deref().map_or(JsValue::NULL, JsValue::from),
                event.time.as_str().into(),
            ])?,
        );
        statements.push(
            db.prepare(
                "DELETE FROM inbox_activity
                 WHERE item_id = (SELECT id FROM inbox_items WHERE username = ?1 AND thread = ?2)
                   AND id NOT IN (
                     SELECT a.id FROM inbox_activity a
                     WHERE a.item_id = (SELECT id FROM inbox_items WHERE username = ?1 AND thread = ?2)
                     ORDER BY a.id DESC LIMIT ?3)",
            )
            .bind(&[username.into(), thread.key.as_str().into(), MAX_ACTIVITY.into()])?,
        );
    }
    let results = db.batch(statements).await?;
    #[derive(Deserialize)]
    struct Told {
        username: String,
    }
    // A line of history written means the event is news to that person.
    let mut news = HashSet::new();
    for (at, _) in told.iter().enumerate() {
        if let Some(result) = results.get(first + at * 3 + 1)
            && let Ok(rows) = result.results::<Told>()
        {
            news.extend(rows.into_iter().map(|row| row.username));
        }
    }
    Ok(told
        .into_iter()
        .filter(|notice| news.contains(&notice.username))
        .map(|notice| Written {
            notice,
            repo_id: wanted.repo_id.clone(),
            url: item_url.clone(),
        })
        .collect())
}

/// Brings a person's thread up with new activity, or starts it. `?1` id,
/// `?2` username, `?3` thread, `?4` event id, `?5` event type, `?6` reason,
/// `?7` severity, `?8` title, `?9` body, `?10` workspace, `?11` repo id,
/// `?12` repo, `?13` subject, `?14` number, `?15` run id, `?16` link, `?17`
/// actor, `?18` time, `?19` the time-sortable id lists order by. Nothing
/// happens when the person was already told of this event. While the
/// thread is unread its most urgent severity is kept; done or not, it
/// comes back to the inbox. A snooze stands.
const BUMP: &str = "INSERT INTO inbox_items (id, username, thread, event_id, event, reason, severity, title, body,
   workspace, repo_id, repo, subject, number, run_id, link, actor, created_at, updated_at, bumped, activity)
 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18, ?19, 1
 WHERE NOT EXISTS (SELECT 1 FROM inbox_activity WHERE event_id = ?4 AND username = ?2)
 ON CONFLICT (username, thread) DO UPDATE SET
   event_id = excluded.event_id,
   event = excluded.event,
   reason = excluded.reason,
   severity = CASE
     WHEN inbox_items.read_at IS NULL AND inbox_items.done_at IS NULL
      AND (CASE inbox_items.severity WHEN 'warning' THEN 0 WHEN 'error' THEN 1 WHEN 'success' THEN 2 ELSE 3 END)
        < (CASE excluded.severity WHEN 'warning' THEN 0 WHEN 'error' THEN 1 WHEN 'success' THEN 2 ELSE 3 END)
     THEN inbox_items.severity ELSE excluded.severity END,
   title = excluded.title,
   body = excluded.body,
   workspace = excluded.workspace,
   repo = excluded.repo,
   subject = COALESCE(excluded.subject, inbox_items.subject),
   run_id = COALESCE(excluded.run_id, inbox_items.run_id),
   link = COALESCE(excluded.link, inbox_items.link),
   actor = excluded.actor,
   updated_at = excluded.updated_at,
   bumped = excluded.bumped,
   activity = inbox_items.activity + 1,
   read_at = NULL,
   done_at = NULL";

/// Emails what was news to people who asked to be emailed for its reason.
/// Identity sends each, only to a confirmed address and only if the person
/// can still read the repository.
async fn email(db: &D1Database, identity: &Fetcher, written: Vec<Written>) -> Result<()> {
    if written.is_empty() {
        return Ok(());
    }
    let people: Vec<String> = written
        .iter()
        .map(|item| item.notice.username.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let settings = subscriptions::settings_of(db, &people).await?;
    for item in written {
        let wants = settings.get(&item.notice.username).map_or(&DEFAULT_EMAIL[..], |settings| &settings.email[..]);
        if !wants.contains(&item.notice.reason) {
            continue;
        }
        let sent: Result<bool> = g1t_kit::call(
            identity,
            "notify_by_email",
            &NotifyByEmailArgs {
                username: item.notice.username.clone(),
                repo_id: item.repo_id.clone(),
                subject: item.notice.title.clone(),
                intro: item.notice.body.clone(),
                quote: None,
                path: item.url.clone(),
                reason: item.notice.reason,
            },
        )
        .await;
        if let Err(error) = sent {
            worker::console_error!("inbox: email to {} not sent: {error}", item.notice.username);
        }
    }
    Ok(())
}

// --- Reading and changing ----------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct Row {
    pub(crate) id: String,
    reason: String,
    severity: String,
    title: String,
    body: String,
    event: Option<String>,
    workspace: Option<String>,
    pub(crate) repo_id: Option<String>,
    repo: Option<String>,
    subject: Option<String>,
    number: Option<f64>,
    run_id: Option<String>,
    link: Option<String>,
    actor: Option<String>,
    activity: Option<f64>,
    created_at: String,
    updated_at: Option<String>,
    read_at: Option<String>,
    done_at: Option<String>,
    saved: f64,
    snoozed_until: Option<String>,
    bumped: Option<String>,
}

impl Row {
    pub(crate) fn into_item(self) -> InboxItem {
        let subject = self.subject.as_deref().and_then(SubjectKind::parse);
        let number = self.number.map(|n| n as u32);
        InboxItem {
            url: url(self.repo.as_deref(), subject, number, self.run_id.as_deref(), self.link.as_deref()),
            id: self.id,
            reason: Reason::parse(&self.reason).unwrap_or(Reason::Subscribed),
            severity: Severity::parse(&self.severity).unwrap_or(Severity::Info),
            title: self.title,
            body: self.body,
            event: self.event,
            repo: self.repo,
            workspace: self.workspace,
            subject,
            number,
            actor: self.actor,
            count: self.activity.map_or(1, |n| n as u32),
            updated_at: self.updated_at.unwrap_or_else(|| self.created_at.clone()),
            created_at: self.created_at,
            read_at: self.read_at,
            done_at: self.done_at,
            saved: self.saved != 0.0,
            snoozed_until: self.snoozed_until,
        }
    }
}

pub(crate) const COLUMNS: &str = "id, reason, severity, title, body, event, workspace, repo_id, repo, subject, number, run_id,
                       link, actor, activity, created_at, updated_at, read_at, done_at, saved, snoozed_until, bumped";

/// The conditions that pick a view's items, after `username = ?1`; `?2` is now.
fn view_filter(view: InboxView) -> &'static str {
    match view {
        InboxView::Inbox => "done_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?2)",
        InboxView::Saved => "saved = 1",
        InboxView::Done => "done_at IS NOT NULL",
    }
}

/// Whether a list ranks unread warnings first: the inbox itself, unfiltered.
fn ranked(a: &ListInboxArgs) -> bool {
    a.view == InboxView::Inbox
        && a.severity.is_none()
        && a.reason.is_none()
        && !a.participating
        && a.repo_id.is_none()
        && !a.unread
        && a.since.is_none()
        && a.updated_before.is_none()
}

/// The conditions a list's filters add, and the values they bind, numbered
/// after the `bound` values already given.
fn filters(a: &ListInboxArgs, bound: usize) -> (Vec<String>, Vec<String>) {
    let mut conditions = Vec::new();
    let mut values: Vec<String> = Vec::new();
    let mut bind = |value: &str, condition: &str| {
        values.push(value.to_owned());
        conditions.push(condition.replace('?', &format!("?{}", bound + values.len())));
    };
    if let Some(severity) = a.severity {
        bind(severity.as_str(), "severity = ?");
    }
    if let Some(reason) = a.reason {
        bind(reason.as_str(), "reason = ?");
    }
    if let Some(repo_id) = &a.repo_id {
        bind(repo_id, "repo_id = ?");
    }
    if let Some(since) = &a.since {
        bind(since.trim(), "COALESCE(updated_at, created_at) >= ?");
    }
    if let Some(before) = &a.updated_before {
        bind(before.trim(), "COALESCE(updated_at, created_at) < ?");
    }
    if a.participating {
        conditions.push("reason NOT IN ('manual', 'subscribed')".to_owned());
    }
    if a.unread {
        conditions.push("read_at IS NULL".to_owned());
    }
    (conditions, values)
}

pub async fn list(db: &D1Database, repos: &Fetcher, a: ListInboxArgs) -> Result<InboxPage> {
    let Some(viewer) = &a.viewer else {
        return Ok(InboxPage::default());
    };
    let username = viewer.username.to_lowercase();
    let now = rfc3339(now_ms());
    let limit = a.limit.unwrap_or(DEFAULT_INBOX_PAGE).clamp(1, MAX_INBOX_PAGE);
    let mut values: Vec<JsValue> = vec![username.as_str().into(), now.as_str().into()];
    let mut conditions = vec!["username = ?1".to_owned(), view_filter(a.view).to_owned()];
    let (filtered, bound) = filters(&a, values.len());
    conditions.extend(filtered);
    values.extend(bound.iter().map(|value| JsValue::from(value.as_str())));
    let ranked = ranked(&a);
    // Unread warnings lead the first page, and are left out of the rest.
    let leading = "severity = 'warning' AND read_at IS NULL";
    let mut rest = conditions.clone();
    let mut rest_values = values.clone();
    if ranked {
        rest.push(format!("NOT ({leading})"));
    }
    if let Some(before) = &a.before {
        rest_values.push(before.as_str().into());
        rest.push(format!("bumped < ?{}", rest_values.len()));
    }
    rest_values.push((limit + 1).into());
    let order = if a.view == InboxView::Done { "done_at DESC, bumped DESC" } else { "bumped DESC" };
    let mut statements = vec![
        db.prepare(format!(
            "SELECT {COLUMNS} FROM inbox_items WHERE {} ORDER BY {order} LIMIT ?{}",
            rest.join(" AND "),
            rest_values.len()
        ))
        .bind(&rest_values)?,
    ];
    if ranked && a.before.is_none() {
        statements.push(
            db.prepare(format!(
                "SELECT {COLUMNS} FROM inbox_items WHERE {} AND {leading} ORDER BY bumped DESC LIMIT ?3",
                conditions.join(" AND ")
            ))
            .bind(&[username.as_str().into(), now.as_str().into(), MAX_RANKED.into()])?,
        );
    }
    let results = db.batch(statements).await?;
    let mut rows = results.first().map(|result| result.results::<Row>()).transpose()?.unwrap_or_default();
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|row| row.bumped.clone().unwrap_or_else(|| row.id.clone()))
    } else {
        None
    };
    let mut items: Vec<Row> = results.get(1).map(|result| result.results::<Row>()).transpose()?.unwrap_or_default();
    items.extend(rows);
    let items = readable_only(db, repos, &a.viewer, &username, items).await?;
    Ok(InboxPage {
        items: items.into_iter().map(Row::into_item).collect(),
        next,
    })
}

/// Rows about repositories the viewer can still read; the rest are
/// removed from their inbox as they are found.
pub(crate) async fn readable_only(db: &D1Database, repos: &Fetcher, viewer: &g1t_contracts::Viewer, username: &str, mut rows: Vec<Row>) -> Result<Vec<Row>> {
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.repo_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(rows);
    }
    let readable: Vec<Repo> = g1t_kit::call(
        repos,
        "readable",
        &ReadableArgs {
            ids: ids.clone(),
            viewer: viewer.clone(),
        },
    )
    .await?;
    let readable: HashSet<String> = readable.into_iter().map(|repo| repo.id).collect();
    let gone: Vec<String> = ids.into_iter().filter(|id| !readable.contains(id)).collect();
    if !gone.is_empty() {
        forget(db, username, &gone).await?;
        rows.retain(|row| row.repo_id.as_ref().is_none_or(|id| !gone.contains(id)));
    }
    Ok(rows)
}

/// Removes a person's items about repositories they cannot read.
async fn forget(db: &D1Database, username: &str, repo_ids: &[String]) -> Result<()> {
    let marks = vec!["?"; repo_ids.len()].join(", ");
    let mut values: Vec<JsValue> = vec![username.into()];
    values.extend(repo_ids.iter().map(|id| JsValue::from(id.as_str())));
    db.batch(vec![
        db.prepare(format!(
            "DELETE FROM inbox_activity WHERE item_id IN (SELECT id FROM inbox_items WHERE username = ? AND repo_id IN ({marks}))"
        ))
        .bind(&values)?,
        db.prepare(format!("DELETE FROM inbox_items WHERE username = ? AND repo_id IN ({marks})"))
            .bind(&values)?,
    ])
    .await?;
    Ok(())
}

#[derive(Deserialize)]
struct CountRow {
    severity: String,
    n: f64,
}

pub async fn counts(db: &D1Database, a: InboxCountsArgs) -> Result<InboxCounts> {
    let rows = db
        .prepare(
            "SELECT severity, count(*) AS n FROM inbox_items
             WHERE username = ? AND read_at IS NULL AND done_at IS NULL
               AND (snoozed_until IS NULL OR snoozed_until <= ?)
             GROUP BY severity",
        )
        .bind(&[a.username.to_lowercase().into(), rfc3339(now_ms()).into()])?
        .all()
        .await?
        .results::<CountRow>()?;
    let mut counts = InboxCounts::default();
    for row in rows {
        let n = row.n as u32;
        counts.unread += n;
        match Severity::parse(&row.severity) {
            Some(Severity::Error) => counts.error += n,
            Some(Severity::Warning) => counts.warning += n,
            Some(Severity::Success) => counts.success += n,
            Some(Severity::Info) | None => counts.info += n,
        }
    }
    Ok(counts)
}

/// The change a mark makes, as a `SET` clause; `?1` is now.
fn mark_change(mark: InboxMark) -> &'static str {
    match mark {
        InboxMark::Read => "read_at = COALESCE(read_at, ?1)",
        InboxMark::Unread => "read_at = NULL",
        InboxMark::Done => "done_at = ?1, read_at = COALESCE(read_at, ?1)",
        InboxMark::Undone => "done_at = NULL",
        InboxMark::Save => "saved = 1",
        InboxMark::Unsave => "saved = 0",
        InboxMark::Snooze => "snoozed_until = ?2, read_at = COALESCE(read_at, ?1)",
        InboxMark::Unsnooze => "snoozed_until = NULL",
    }
}

#[derive(Deserialize)]
struct IdRow {
    #[allow(dead_code)]
    id: String,
}

/// Changes the person's own items. Returns how many changed.
pub async fn mark(db: &D1Database, a: MarkInboxArgs) -> Result<u32> {
    let now = rfc3339(now_ms());
    let until = match (a.mark, a.until.as_deref().map(str::trim)) {
        // Times compare as text (`g1t_contracts::time`); a snooze is for later.
        (InboxMark::Snooze, Some(until)) if until.len() == now.len() && until > now.as_str() => until.to_owned(),
        (InboxMark::Snooze, _) => return Ok(0),
        _ => String::new(),
    };
    let mut values: Vec<JsValue> = vec![now.as_str().into(), until.as_str().into(), a.username.to_lowercase().into()];
    let target = if a.all && a.ids.is_empty() {
        let mut target = "done_at IS NULL".to_owned();
        let mut bind = |values: &mut Vec<JsValue>, value: &str, condition: &str| {
            values.push(value.into());
            target.push_str(&format!(" AND {}", condition.replace('?', &format!("?{}", values.len()))));
        };
        if let Some(severity) = a.severity {
            bind(&mut values, severity.as_str(), "severity = ?");
        }
        if let Some(repo_id) = &a.repo_id {
            bind(&mut values, repo_id, "repo_id = ?");
        }
        if let Some(last_read_at) = a.last_read_at.as_deref().map(str::trim).filter(|at| !at.is_empty()) {
            bind(&mut values, last_read_at, "COALESCE(updated_at, created_at) <= ?");
        }
        target
    } else {
        let ids: Vec<&String> = a.ids.iter().take(MAX_MARK).collect();
        if ids.is_empty() {
            return Ok(0);
        }
        let first = values.len() + 1;
        values.extend(ids.iter().map(|id| JsValue::from(id.as_str())));
        let marks: Vec<String> = (first..values.len() + 1).map(|at| format!("?{at}")).collect();
        format!("id IN ({})", marks.join(", "))
    };
    let changed = db
        .prepare(format!(
            "UPDATE inbox_items SET {} WHERE username = ?3 AND {target} RETURNING id",
            mark_change(a.mark)
        ))
        .bind(&values)?
        .all()
        .await?
        .results::<IdRow>()?;
    Ok(changed.len() as u32)
}

#[derive(Deserialize)]
struct ActivityRow {
    reason: String,
    severity: String,
    title: String,
    body: String,
    event: Option<String>,
    actor: Option<String>,
    created_at: String,
}

/// One of the viewer's threads, with its history and their subscription.
pub async fn thread(db: &D1Database, repos: &Fetcher, work: &Fetcher, a: ThreadArgs) -> Result<Option<InboxThread>> {
    let Some(viewer) = &a.viewer else {
        return Ok(None);
    };
    let username = viewer.username.to_lowercase();
    let row = db
        .prepare(format!("SELECT {COLUMNS} FROM inbox_items WHERE id = ? AND username = ?"))
        .bind(&[a.id.as_str().into(), username.as_str().into()])?
        .first::<Row>(None)
        .await?;
    let Some(row) = readable_only(db, repos, &a.viewer, &username, row.into_iter().collect()).await?.pop() else {
        return Ok(None);
    };
    let activity = db
        .prepare(
            "SELECT reason, severity, title, body, event, actor, created_at FROM inbox_activity
             WHERE item_id = ? ORDER BY id DESC LIMIT ?",
        )
        .bind(&[row.id.as_str().into(), MAX_ACTIVITY.into()])?
        .all()
        .await?
        .results::<ActivityRow>()?
        .into_iter()
        .map(|row| InboxActivity {
            reason: Reason::parse(&row.reason).unwrap_or(Reason::Subscribed),
            severity: Severity::parse(&row.severity).unwrap_or(Severity::Info),
            title: row.title,
            body: row.body,
            event: row.event,
            actor: row.actor,
            created_at: row.created_at,
        })
        .collect();
    let item = row.into_item();
    let subscription = match (item.subject, item.number) {
        (Some(SubjectKind::Issue | SubjectKind::Pull), Some(_)) => {
            subscriptions::subscription(
                db,
                work,
                SubscriptionArgs {
                    viewer: a.viewer.clone(),
                    id: Some(item.id.clone()),
                    ..SubscriptionArgs::default()
                },
            )
            .await?
        }
        _ => None,
    };
    Ok(Some(InboxThread {
        item,
        activity,
        subscription,
    }))
}

// --- Keeping up ------------------------------------------------------------------

/// Moves rows with renamed workspaces and repositories, and drops those
/// of purged repositories and deleted workspaces.
pub async fn follow(db: &D1Database, events: &[Event]) -> Result<()> {
    let mut statements = Vec::new();
    for event in events {
        let text = |key: &str| event.data[key].as_str().unwrap_or_default().to_lowercase();
        match event.kind.as_str() {
            "workspace.renamed" => {
                let Ok(renamed) = serde_json::from_value::<WorkspaceRenamed>(event.data.clone()) else {
                    continue;
                };
                let (from, to) = (renamed.from.to_lowercase(), renamed.to.to_lowercase());
                if from == to {
                    continue;
                }
                statements.push(
                    db.prepare(
                        "UPDATE inbox_items SET repo = ?2 || substr(repo, length(?1) + 1), workspace = ?2,
                           link = CASE WHEN link LIKE '/' || ?1 || '/%' THEN '/' || ?2 || substr(link, length(?1) + 2) ELSE link END
                         WHERE workspace = ?1",
                    )
                    .bind(&[from.as_str().into(), to.as_str().into()])?,
                );
                statements.push(
                    db.prepare("UPDATE inbox_watching SET repo = ?2 || substr(repo, length(?1) + 1) WHERE repo LIKE ?1 || '/%'")
                        .bind(&[from.as_str().into(), to.as_str().into()])?,
                );
            }
            "repo.renamed" => {
                let path = format!("{}/{}", text("namespace"), text("to"));
                for table in ["inbox_items", "inbox_watching"] {
                    statements.push(
                        db.prepare(format!("UPDATE {table} SET repo = ? WHERE repo_id = ?"))
                            .bind(&[path.as_str().into(), text("repoId").into()])?,
                    );
                }
            }
            "repo.transferred" => {
                let path = format!("{}/{}", text("to"), text("name"));
                statements.push(
                    db.prepare("UPDATE inbox_items SET repo = ?, workspace = ? WHERE repo_id = ?")
                        .bind(&[path.as_str().into(), text("to").into(), text("repoId").into()])?,
                );
                statements.push(
                    db.prepare("UPDATE inbox_watching SET repo = ? WHERE repo_id = ?")
                        .bind(&[path.as_str().into(), text("repoId").into()])?,
                );
            }
            "repo.purged" => {
                for sql in [
                    "DELETE FROM inbox_activity WHERE item_id IN (SELECT id FROM inbox_items WHERE repo_id = ?)",
                    "DELETE FROM inbox_items WHERE repo_id = ?",
                    "DELETE FROM inbox_subscriptions WHERE repo_id = ?",
                    "DELETE FROM inbox_watching WHERE repo_id = ?",
                ] {
                    statements.push(db.prepare(sql).bind(&[text("repoId").into()])?);
                }
            }
            "workspace.deleted" => {
                statements.push(
                    db.prepare("DELETE FROM inbox_items WHERE workspace = ?")
                        .bind(&[text("slug").into()])?,
                );
                statements.push(
                    db.prepare("DELETE FROM inbox_watching WHERE repo LIKE ? || '/%'")
                        .bind(&[text("slug").into()])?,
                );
            }
            _ => {}
        }
    }
    if !statements.is_empty() {
        db.batch(statements).await?;
    }
    Ok(())
}

/// Removes items done more than [`DONE_DAYS`] ago, and any not saved older
/// than [`MAX_DAYS`], with their history. Returns how many went.
pub async fn purge(db: &D1Database, now: u64) -> Result<u32> {
    let done = crate::audit::keep_from(now, DONE_DAYS);
    let oldest = crate::audit::keep_from(now, MAX_DAYS);
    let statements: Vec<D1PreparedStatement> = vec![
        db.prepare("DELETE FROM inbox_items WHERE saved = 0 AND done_at < ?")
            .bind(&[done.into()])?,
        db.prepare("DELETE FROM inbox_items WHERE saved = 0 AND COALESCE(updated_at, created_at) < ?")
            .bind(&[oldest.into()])?,
        db.prepare("DELETE FROM inbox_activity WHERE NOT EXISTS (SELECT 1 FROM inbox_items WHERE inbox_items.id = inbox_activity.item_id)"),
    ];
    let results = db.batch(statements).await?;
    let mut removed = 0;
    for result in results.into_iter().take(2) {
        removed += result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) as u32;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::{State, Subscription, Watcher};
    use serde_json::json;

    fn event(kind: &str, actor: Option<&str>, data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "work".into(),
            time: "2026-10-07T12:00:00.000Z".into(),
            repo_id: Some("rep_1".into()),
            actor: actor.map(str::to_owned),
            data,
        }
    }

    fn person(id: &str, username: &str) -> Principal {
        Principal {
            id: id.into(),
            username: username.into(),
        }
    }

    fn actor(id: &str, username: &str) -> Actor {
        Actor {
            id: Some(id.into()),
            username: Some(username.into()),
        }
    }

    /// A pull request ana opened, assigned to bo, for an issue cy filed and dee is assigned.
    fn pull() -> InboxSubject {
        InboxSubject {
            kind: Some(SubjectKind::Pull),
            title: "Add the inbox".into(),
            author: person("usr_ana", "ana"),
            assignees: vec!["bo".into()],
            issue: Some(Box::new(InboxSubject {
                kind: Some(SubjectKind::Issue),
                title: "An inbox".into(),
                author: person("usr_cy", "cy"),
                assignees: vec!["dee".into()],
                ..InboxSubject::default()
            })),
            ..InboxSubject::default()
        }
    }

    /// A change g1t made for ana.
    fn g1t_pull() -> InboxSubject {
        InboxSubject {
            author: person(AGENT_ID, "g1t"),
            requested_by: Some(person("usr_ana", "ana")),
            ..pull()
        }
    }

    fn nobody() -> Audience {
        Audience::default()
    }

    fn told(notices: &[Notice]) -> Vec<(&str, Reason, Severity)> {
        notices
            .iter()
            .map(|notice| (notice.username.as_str(), notice.reason, notice.severity))
            .collect()
    }

    fn comment(author: Principal, body: &str, mentions: &[&str]) -> InboxSubject {
        InboxSubject {
            comment: Some(InboxComment {
                author,
                excerpt: body.into(),
                mentions: mentions.iter().map(|name| (*name).to_owned()).collect(),
                ..InboxComment::default()
            }),
            ..pull()
        }
    }

    fn subscribed(rows: &[(&str, State, Option<Reason>)]) -> Audience {
        Audience {
            subscriptions: rows
                .iter()
                .map(|(name, state, reason)| Subscription {
                    username: (*name).into(),
                    state: *state,
                    reason: *reason,
                })
                .collect(),
            watchers: Vec::new(),
        }
    }

    fn watched(rows: &[(&str, WatchLevel, &[&str])]) -> Audience {
        Audience {
            subscriptions: Vec::new(),
            watchers: rows
                .iter()
                .map(|(name, level, events)| Watcher {
                    username: (*name).into(),
                    level: *level,
                    events: events.iter().map(|kind| (*kind).to_owned()).collect(),
                })
                .collect(),
        }
    }

    #[test]
    fn only_events_that_tell_someone_are_read() {
        let asked = |kind: &str, data| wants(&event(kind, None, data));
        assert_eq!(
            asked("checks.completed", json!({ "repoId": "rep_1", "number": 4, "status": "failed" })),
            Some(Wanted { repo_id: "rep_1".into(), number: Some(4), comment_id: None })
        );
        assert_eq!(asked("checks.completed", json!({ "repoId": "rep_1", "number": 4, "status": "passed" })), None);
        assert_eq!(asked("review.completed", json!({ "repoId": "rep_1", "number": 4 })), None);
        assert_eq!(asked("workflow.completed", json!({ "repoId": "rep_1", "conclusion": "success" })), None);
        assert_eq!(
            asked("workflow.completed", json!({ "repoId": "rep_1", "conclusion": "failure" })),
            Some(Wanted { repo_id: "rep_1".into(), number: None, comment_id: None })
        );
        assert_eq!(
            asked("comment.created", json!({ "repoId": "rep_1", "number": 2, "commentId": "cmt_1" })).map(|w| w.comment_id),
            Some(Some("cmt_1".into()))
        );
        assert_eq!(asked("git.push", json!({ "repoId": "rep_1" })), None);
        for kind in ["issue.opened", "pull.review_requested", "pull.stalled", "issue.assigned", "pull.closed", "issue.reopened"] {
            assert!(asked(kind, json!({ "repoId": "rep_1", "number": 1 })).is_some(), "{kind}");
        }
        assert_eq!(asked("deployment.failed", json!({ "repoId": "rep_1" })).map(|w| w.number), Some(None));
    }

    #[test]
    fn a_waiting_or_stopped_agent_needs_the_pull_requests_and_the_issues_people_first() {
        let asked = event("agent.asked", Some("usr_agent"), json!({ "number": 7 }));
        let notices_ = notices(&asked, "acme/rocket", &Actor::default(), Some(&pull()), &nobody());
        assert_eq!(
            told(&notices_),
            vec![
                ("ana", Reason::Agent, Severity::Warning),
                ("cy", Reason::Agent, Severity::Warning),
                ("dee", Reason::Agent, Severity::Warning),
            ]
        );
        assert_eq!(notices_[0].title, "An agent is waiting on acme/rocket#7");
        assert_eq!(notices_[0].body, "Add the inbox");
        // Stopping says why; even someone who unsubscribed hears of it.
        let stalled = event("pull.stalled", None, json!({ "number": 7, "detail": "Its checks could not be run." }));
        let audience = subscribed(&[("ana", State::Unsubscribed, None)]);
        let notices_ = notices(&stalled, "acme/rocket", &Actor::default(), Some(&g1t_pull()), &audience);
        assert_eq!(notices_[0].username, "ana");
        assert_eq!(notices_[0].title, "g1t stopped on acme/rocket#7 and needs you");
        assert_eq!(notices_[0].body, "Its checks could not be run.");
        // Ignoring the thread silences even that.
        let audience = subscribed(&[("ana", State::Ignored, None)]);
        let notices_ = notices(&stalled, "acme/rocket", &Actor::default(), Some(&g1t_pull()), &audience);
        assert!(!notices_.iter().any(|notice| notice.username == "ana"));
    }

    #[test]
    fn whatever_an_agent_waits_on_closes_when_it_goes_on() {
        for kind in RESUMES {
            assert_eq!(resolves(&event(kind, None, json!({ "repoId": "rep_1", "number": 7 }))), Some("rep_1#7".into()));
        }
        assert_eq!(resolves(&event("comment.created", None, json!({ "repoId": "rep_1", "number": 7 }))), None);
    }

    #[test]
    fn a_deployments_reviewers_are_told() {
        let asked = event(
            "deployment.review_requested",
            Some("usr_ana"),
            json!({
                "repoId": "rep_1", "runId": "run_7", "environment": "production", "workflow": "Deploy",
                "title": "Ship it", "notify": ["cy", "ana"], "link": "/acme/rocket/actions/runs/run_7"
            }),
        );
        let wanted = wants(&asked).unwrap();
        assert_eq!(wanted.number, None);
        let thread = thread_of(&asked, &wanted, None);
        assert_eq!(thread.key, "rep_1/review/run_7/production");
        assert_eq!(thread.link.as_deref(), Some("/acme/rocket/actions/runs/run_7"));
        let told = notices(&asked, "acme/rocket", &actor("usr_ana", "ana"), None, &nobody());
        let names: Vec<&str> = told.iter().map(|notice| notice.username.as_str()).collect();
        // Whoever started the run is told too, when they review it.
        assert_eq!(names, ["cy", "ana"]);
        assert!(told[0].title.contains("waiting for your review to deploy to production"));
    }

    #[test]
    fn teams_asked_to_review_tell_the_people_they_name() {
        let requested = event(
            "pull.review_requested",
            Some("usr_ana"),
            json!({ "number": 7, "reviewers": ["cy"], "teams": [
                { "team": "acme/backend", "notified": ["cy", "dee", "ana"], "assigned": ["cy"] }
            ] }),
        );
        let notices_ = notices(&requested, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()), &nobody());
        // cy was picked and is told as a reviewer; dee through the team;
        // never whoever asked.
        assert_eq!(
            told(&notices_),
            vec![("cy", Reason::ReviewRequested, Severity::Warning), ("dee", Reason::ReviewRequested, Severity::Warning)]
        );
        assert_eq!(notices_[0].title, "ana asked you to review acme/rocket#7");
        assert_eq!(notices_[1].title, "ana asked @acme/backend to review acme/rocket#7");
        assert_eq!(
            subscribes(&requested, Some(&pull())),
            vec![("cy".into(), Reason::ReviewRequested), ("dee".into(), Reason::ReviewRequested), ("ana".into(), Reason::ReviewRequested)]
        );
        // Asked by the CODEOWNERS file.
        let owned = event(
            "pull.review_requested",
            None,
            json!({ "number": 7, "reviewers": ["bo"], "codeOwners": true, "teams": [{ "team": "acme/docs", "notified": ["wren"], "assigned": [] }] }),
        );
        let notices_ = notices(&owned, "acme/rocket", &Actor::default(), Some(&pull()), &nobody());
        assert_eq!(notices_[0].title, "acme/rocket#7 changes files you own");
        assert_eq!(notices_[1].title, "acme/rocket#7 changes files @acme/docs owns");
    }

    #[test]
    fn a_team_mention_tells_its_people_once_and_a_name_wins() {
        let mut on = comment(person("usr_bo", "bo"), "cc @ana @acme/backend", &["ana"]);
        if let Some(comment) = on.comment.as_mut() {
            comment.team_mentions = vec![TeamMentioned {
                team: "acme/backend".into(),
                members: vec!["ana".into(), "cy".into(), "bo".into()],
            }];
        }
        let created = event("comment.created", Some("usr_bo"), json!({ "number": 7, "commentId": "cmt_1" }));
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &nobody());
        let mentioned: Vec<(&str, Reason)> = notices_.iter().map(|n| (n.username.as_str(), n.reason)).filter(|(_, r)| matches!(r, Reason::Mention | Reason::TeamMention)).collect();
        assert_eq!(mentioned, vec![("ana", Reason::Mention), ("cy", Reason::TeamMention)]);
        assert_eq!(
            notices_.iter().find(|n| n.username == "cy").unwrap().title,
            "bo mentioned @acme/backend on acme/rocket#7"
        );
        let subscribed = subscribes(&created, Some(&on));
        assert!(subscribed.contains(&("cy".into(), Reason::TeamMention)));
        assert!(subscribed.contains(&("ana".into(), Reason::Mention)));
    }

    #[test]
    fn a_description_tells_the_people_and_teams_it_mentions() {
        let mut on = pull();
        on.mentions = vec!["dee".into()];
        on.team_mentions = vec![TeamMentioned {
            team: "acme/web".into(),
            members: vec!["eve".into()],
        }];
        let opened = event("pull.opened", Some("usr_ana"), json!({ "number": 7 }));
        let notices_ = notices(&opened, "acme/rocket", &actor("usr_ana", "ana"), Some(&on), &nobody());
        assert!(told(&notices_).contains(&("dee", Reason::Mention, Severity::Info)));
        assert!(told(&notices_).contains(&("eve", Reason::TeamMention, Severity::Info)));
        assert_eq!(
            subscribes(&opened, Some(&on)),
            vec![("dee".into(), Reason::Mention), ("eve".into(), Reason::TeamMention)]
        );
    }

    #[test]
    fn reviewers_and_assignees_asked_are_told_never_whoever_asked() {
        let requested = event("pull.review_requested", Some("usr_ana"), json!({ "number": 7, "reviewers": ["bo", "g1t", "ana"] }));
        let notices_ = notices(&requested, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()), &nobody());
        assert_eq!(told(&notices_), vec![("bo", Reason::ReviewRequested, Severity::Warning)]);
        assert_eq!(notices_[0].title, "ana asked you to review acme/rocket#7");
        let assigned = event("issue.assigned", Some("usr_ana"), json!({ "number": 3, "added": ["ana", "eve"] }));
        let notices_ = notices(&assigned, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()), &nobody());
        assert_eq!(told(&notices_), vec![("eve", Reason::Assign, Severity::Info)]);
        assert_eq!(notices_[0].title, "ana assigned you to acme/rocket#3");
        // Both subscribe whoever they name, never g1t.
        assert_eq!(subscribes(&requested, Some(&pull())), vec![("bo".into(), Reason::ReviewRequested), ("ana".into(), Reason::ReviewRequested)]);
        assert_eq!(subscribes(&assigned, Some(&pull())), vec![("ana".into(), Reason::Assign), ("eve".into(), Reason::Assign)]);
    }

    #[test]
    fn failures_go_to_whoever_answers_for_the_change() {
        let failed = event("checks.completed", None, json!({ "number": 7, "status": "failed" }));
        assert_eq!(
            told(&notices(&failed, "acme/rocket", &Actor::default(), Some(&pull()), &nobody())),
            vec![("ana", Reason::CiActivity, Severity::Error)]
        );
        // g1t's change is the person's who asked for it, never g1t's.
        let notices_ = notices(&failed, "acme/rocket", &Actor::default(), Some(&g1t_pull()), &nobody());
        assert_eq!(told(&notices_), vec![("ana", Reason::CiActivity, Severity::Error)]);
        let errored = event("checks.completed", None, json!({ "number": 7, "status": "errored" }));
        assert_eq!(
            notices(&errored, "acme/rocket", &Actor::default(), Some(&pull()), &nobody())[0].title,
            "Checks could not run on acme/rocket#7"
        );
    }

    #[test]
    fn a_workflow_that_fails_tells_its_pull_requests_owner_even_if_they_pushed() {
        let failed = event("workflow.completed", Some("usr_ana"), json!({ "pull": 7, "workflow": "CI", "conclusion": "failure" }));
        let notices_ = notices(&failed, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()), &nobody());
        assert_eq!(told(&notices_), vec![("ana", Reason::CiActivity, Severity::Error)]);
        assert_eq!(notices_[0].title, "CI failed on acme/rocket#7");
        // On a branch: whoever pushed.
        let pushed = event(
            "workflow.completed",
            Some("usr_bo"),
            json!({ "workflow": "Deploy", "path": ".g1t/workflows/deploy.yml", "conclusion": "failure", "ref": "refs/heads/main", "number": 12, "sha": "abcdef0123", "runId": "run_9" }),
        );
        let notices_ = notices(&pushed, "acme/rocket", &actor("usr_bo", "bo"), None, &nobody());
        assert_eq!(told(&notices_), vec![("bo", Reason::CiActivity, Severity::Error)]);
        assert_eq!(notices_[0].title, "Deploy failed on main in acme/rocket");
        assert_eq!(notices_[0].body, "Run 12 at abcdef0");
        // Nobody to tell when g1t pushed.
        assert!(notices(&pushed, "acme/rocket", &actor("g1t", "g1t"), None, &nobody()).is_empty());
        // Every failure of a workflow on a branch is one thread.
        let wanted = wants(&pushed).unwrap();
        let thread = thread_of(&pushed, &wanted, None);
        assert_eq!(thread.key, "rep_1/run/.g1t/workflows/deploy.yml@main");
        assert_eq!(thread.run_id.as_deref(), Some("run_9"));
    }

    #[test]
    fn deployments_tell_whoever_answers_for_them_and_watchers() {
        let failed = event(
            "deployment.failed",
            Some("usr_bo"),
            json!({ "repoId": "rep_1", "projectId": "prj_1", "project": "rocket", "deploymentId": "dpl_1", "error": "The build failed.", "path": "/acme/rocket/deployments/dpl_1" }),
        );
        let audience = watched(&[("cy", WatchLevel::Custom, &["deployments"]), ("dee", WatchLevel::Custom, &["issues"]), ("eve", WatchLevel::All, &[])]);
        let notices_ = notices(&failed, "acme/rocket", &actor("usr_bo", "bo"), None, &audience);
        assert_eq!(
            told(&notices_),
            vec![
                ("bo", Reason::CiActivity, Severity::Error),
                ("cy", Reason::Subscribed, Severity::Error),
                ("eve", Reason::Subscribed, Severity::Error),
            ]
        );
        assert_eq!(notices_[0].title, "Production of rocket failed to deploy");
        assert_eq!(notices_[0].body, "The build failed.");
        let thread = thread_of(&failed, &wants(&failed).unwrap(), None);
        assert_eq!(thread.key, "rep_1/deploy/prj_1/production");
        assert_eq!(url(Some("acme/rocket"), thread.kind, None, None, thread.link.as_deref()), "/acme/rocket/deployments/dpl_1");
        // A success is news to the owner only after a failure.
        let live = event("deployment.succeeded", Some("usr_bo"), json!({ "repoId": "rep_1", "projectId": "prj_1", "project": "rocket", "commit": "abcdef0123" }));
        assert!(notices(&live, "acme/rocket", &actor("usr_bo", "bo"), None, &nobody()).is_empty());
        let recovered = event("deployment.succeeded", Some("usr_bo"), json!({ "repoId": "rep_1", "projectId": "prj_1", "project": "rocket", "recovered": true }));
        let notices_ = notices(&recovered, "acme/rocket", &actor("usr_bo", "bo"), None, &nobody());
        assert_eq!(told(&notices_), vec![("bo", Reason::CiActivity, Severity::Success)]);
        assert_eq!(notices_[0].title, "Production of rocket is live again");
        // A preview's is the pull request's owner's.
        let preview = event("deployment.failed", None, json!({ "repoId": "rep_1", "projectId": "prj_1", "number": 7, "triggeredBy": "g1t" }));
        assert_eq!(told(&notices(&preview, "acme/rocket", &Actor::default(), Some(&pull()), &nobody())), vec![("ana", Reason::CiActivity, Severity::Error)]);
        assert_eq!(thread_of(&preview, &wants(&preview).unwrap(), Some(&pull())).key, "rep_1/deploy/prj_1/7");
    }

    #[test]
    fn security_alerts_tell_the_pusher_the_owners_and_member_watchers() {
        let blocked = event(
            "secret_scanning_alert.created",
            None,
            json!({
                "repoId": "rep_1", "alertId": "sec_1", "alertType": "secret_scanning", "severity": "critical",
                "title": "An AWS access key in config/prod.env", "link": "/acme/rocket/security/secret-scanning/sec_1",
                "state": "open", "pusher": "bo", "notify": ["ana"], "members": ["ana", "bo", "cy"]
            }),
        );
        assert_eq!(wants(&blocked), Some(Wanted { repo_id: "rep_1".into(), number: None, comment_id: None }));
        // cy watches for security alerts and is a member; eve watches
        // everything but cannot see findings; dee watches issues only.
        let audience = watched(&[
            ("cy", WatchLevel::Custom, &["security"]),
            ("dee", WatchLevel::Custom, &["issues"]),
            ("eve", WatchLevel::All, &[]),
        ]);
        let notices_ = notices(&blocked, "acme/rocket", &Actor::default(), None, &audience);
        assert_eq!(
            told(&notices_),
            vec![
                ("bo", Reason::SecurityAlert, Severity::Error),
                ("ana", Reason::SecurityAlert, Severity::Error),
                ("cy", Reason::SecurityAlert, Severity::Error),
            ]
        );
        assert_eq!(notices_[0].title, "A push to acme/rocket was blocked: it adds a secret");
        assert_eq!(notices_[0].body, "An AWS access key in config/prod.env");
        let thread = thread_of(&blocked, &wants(&blocked).unwrap(), None);
        assert_eq!(thread.key, "rep_1/security/sec_1");
        assert_eq!(url(Some("acme/rocket"), thread.kind, None, None, thread.link.as_deref()), "/acme/rocket/security/secret-scanning/sec_1");
        // A bypass request goes to the reviewers named, never to watchers.
        let requested = event(
            "secret_scanning.bypass_requested",
            Some("usr_bo"),
            json!({ "repoId": "rep_1", "alertId": "sec_1", "requestId": "byp_1", "title": "An AWS access key in a.env", "notify": ["ana"], "link": "/acme/-/security/bypass-requests" }),
        );
        let notices_ = notices(&requested, "acme/rocket", &actor("usr_bo", "bo"), None, &audience);
        assert_eq!(told(&notices_), vec![("ana", Reason::SecurityAlert, Severity::Warning)]);
        assert_eq!(notices_[0].title, "bo asked to bypass push protection in acme/rocket");
        // Fixes and dismissals are not news to the inbox.
        assert_eq!(wants(&event("code_scanning_alert.fixed", None, json!({ "repoId": "rep_1" }))), None);
    }

    #[test]
    fn nobody_hears_of_what_they_did_themselves() {
        let merged = event("pull.merged", Some("usr_ana"), json!({ "number": 7 }));
        let by_ana = notices(&merged, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()), &nobody());
        // The assignee still hears; ana, who merged, does not.
        assert_eq!(told(&by_ana), vec![("bo", Reason::StateChange, Severity::Success)]);
        let by_bo = notices(&merged, "acme/rocket", &actor("usr_bo", "bo"), Some(&pull()), &nobody());
        assert_eq!(told(&by_bo), vec![("ana", Reason::StateChange, Severity::Success)]);
        assert_eq!(by_bo[0].title, "bo merged acme/rocket#7");
        let by_queue = notices(&merged, "acme/rocket", &Actor::default(), Some(&pull()), &nobody());
        assert_eq!(by_queue[0].title, "acme/rocket#7 was merged");
    }

    #[test]
    fn closing_and_reopening_tells_everyone_subscribed_and_watchers() {
        let closed = event("issue.closed", Some("usr_bo"), json!({ "number": 3, "reason": "completed" }));
        let issue = InboxSubject {
            kind: Some(SubjectKind::Issue),
            title: "Crash".into(),
            author: person("usr_cy", "cy"),
            assignees: vec!["bo".into()],
            ..InboxSubject::default()
        };
        let mut audience = subscribed(&[("eve", State::Subscribed, Some(Reason::Comment)), ("fay", State::Unsubscribed, None)]);
        audience.watchers = watched(&[("gus", WatchLevel::All, &[]), ("hal", WatchLevel::Custom, &["pulls"])]).watchers;
        let notices_ = notices(&closed, "acme/rocket", &actor("usr_bo", "bo"), Some(&issue), &audience);
        assert_eq!(
            told(&notices_),
            vec![
                ("cy", Reason::StateChange, Severity::Info),
                ("eve", Reason::StateChange, Severity::Info),
                ("gus", Reason::Subscribed, Severity::Info),
            ]
        );
        assert_eq!(notices_[0].title, "bo closed acme/rocket#3");
        let by_pull = event("issue.closed", None, json!({ "number": 3, "resolvedBy": 9 }));
        assert_eq!(notices(&by_pull, "acme/rocket", &Actor::default(), Some(&issue), &nobody())[0].title, "acme/rocket#3 was closed by #9");
        let reopened = event("issue.reopened", Some("usr_cy"), json!({ "number": 3 }));
        assert_eq!(told(&notices(&reopened, "acme/rocket", &actor("usr_cy", "cy"), Some(&issue), &nobody())), vec![("bo", Reason::StateChange, Severity::Info)]);
    }

    #[test]
    fn opening_tells_who_it_names_and_watchers_of_its_kind() {
        let opened = event("pull.opened", Some("usr_ana"), json!({ "number": 7 }));
        let subject = InboxSubject { reviewers: vec!["cy".into(), "g1t".into()], ..pull() };
        let audience = watched(&[("bo", WatchLevel::All, &[]), ("dee", WatchLevel::Custom, &["issues"]), ("eve", WatchLevel::Custom, &["pulls"]), ("fay", WatchLevel::Participating, &[])]);
        let notices_ = notices(&opened, "acme/rocket", &actor("usr_ana", "ana"), Some(&subject), &audience);
        assert_eq!(
            told(&notices_),
            vec![
                ("bo", Reason::Assign, Severity::Info),
                ("cy", Reason::ReviewRequested, Severity::Warning),
                ("eve", Reason::Subscribed, Severity::Info),
            ]
        );
        assert_eq!(notices_[2].title, "ana opened acme/rocket#7");
    }

    #[test]
    fn ignoring_a_repository_silences_it_and_unsubscribing_keeps_only_what_is_asked() {
        let created = event("comment.created", Some("usr_bo"), json!({ "number": 7, "commentId": "cmt_1" }));
        let on = comment(person("usr_bo", "bo"), "@cy have a look", &["cy"]);
        let audience = watched(&[("cy", WatchLevel::Ignore, &[]), ("ana", WatchLevel::All, &[])]);
        assert!(notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &audience).iter().all(|notice| notice.username != "cy"));
        let audience = subscribed(&[("cy", State::Unsubscribed, None), ("ana", State::Unsubscribed, None)]);
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &audience);
        // cy was mentioned, which is asked of them; ana unsubscribed from the conversation.
        assert_eq!(told(&notices_), vec![("cy", Reason::Mention, Severity::Info)]);
    }

    #[test]
    fn g1t_finishing_or_reviewing_tells_the_person_it_worked_for() {
        // The agent acts as the person it works for: still an outcome they hear of.
        let ready = event("pull.ready", Some("usr_ana"), json!({ "number": 7 }));
        let notices_ = notices(&ready, "acme/rocket", &actor("usr_ana", "ana"), Some(&g1t_pull()), &nobody());
        assert_eq!(told(&notices_), vec![("ana", Reason::Author, Severity::Success)]);
        assert_eq!(notices_[0].title, "g1t finished acme/rocket#7");
        // A person's draft marked ready is not news to them.
        assert!(notices(&ready, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()), &nobody()).is_empty());

        let approve = event("review.completed", None, json!({ "number": 7, "verdict": "approve" }));
        assert_eq!(
            told(&notices(&approve, "acme/rocket", &Actor::default(), Some(&pull()), &nobody())),
            vec![("ana", Reason::Author, Severity::Success)]
        );
        let changes = event("review.completed", None, json!({ "number": 7, "verdict": "request_changes" }));
        assert_eq!(
            told(&notices(&changes, "acme/rocket", &Actor::default(), Some(&pull()), &nobody())),
            vec![("ana", Reason::Author, Severity::Info)]
        );
    }

    #[test]
    fn comments_tell_those_mentioned_then_everyone_subscribed_never_the_writer() {
        let created = event("comment.created", Some("usr_bo"), json!({ "number": 7, "commentId": "cmt_1" }));
        let on = comment(person("usr_bo", "bo"), "@cy @bo have a look", &["cy", "bo", "g1t"]);
        let audience = subscribed(&[("eve", State::Subscribed, Some(Reason::Comment)), ("fay", State::Subscribed, Some(Reason::Manual))]);
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &audience);
        assert_eq!(
            told(&notices_),
            vec![
                ("cy", Reason::Mention, Severity::Info),
                ("ana", Reason::Author, Severity::Info),
                ("eve", Reason::Comment, Severity::Info),
                ("fay", Reason::Manual, Severity::Info),
            ]
        );
        assert_eq!(notices_[0].title, "bo mentioned you on acme/rocket#7");
        assert_eq!(notices_[1].title, "bo commented on acme/rocket#7");
        assert_eq!(notices_[0].body, "@cy @bo have a look");
        // Mentioned and the owner: told once, as mentioned.
        let on = comment(person("usr_bo", "bo"), "@ana", &["ana"]);
        assert_eq!(
            told(&notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &nobody())),
            vec![("ana", Reason::Mention, Severity::Info)]
        );
        // The owner's own comment tells the assignee, not the owner.
        let on = comment(person("usr_ana", "ana"), "thanks", &[]);
        assert_eq!(
            told(&notices(&created, "acme/rocket", &actor("usr_ana", "ana"), Some(&on), &nobody())),
            vec![("bo", Reason::Assign, Severity::Info)]
        );
        // Something that happened, not something written, tells nobody.
        let mut on = comment(person("usr_bo", "bo"), "assigned cy", &[]);
        on.comment.as_mut().unwrap().event = true;
        assert!(notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &nobody()).is_empty());
        // An approval is good news.
        let mut on = comment(person("usr_cy", "cy"), "", &[]);
        on.comment.as_mut().unwrap().verdict = Some("approve".into());
        let notices_ = notices(&created, "acme/rocket", &actor("usr_cy", "cy"), Some(&on), &nobody());
        assert_eq!(told(&notices_)[0], ("ana", Reason::Author, Severity::Success));
        assert_eq!(notices_[0].body, "Add the inbox");
        // Writing and being mentioned subscribe, never g1t.
        let on = comment(person("usr_bo", "bo"), "@cy", &["cy"]);
        assert_eq!(subscribes(&created, Some(&on)), vec![("bo".into(), Reason::Comment), ("cy".into(), Reason::Mention)]);
        let on = comment(person(AGENT_ID, "g1t"), "done", &[]);
        assert!(subscribes(&created, Some(&on)).is_empty());
    }

    #[test]
    fn issues_and_pull_requests_are_one_thread_each() {
        let created = event("comment.created", Some("usr_bo"), json!({ "repoId": "rep_1", "number": 7, "commentId": "cmt_1" }));
        let wanted = wants(&created).unwrap();
        let thread = thread_of(&created, &wanted, Some(&pull()));
        assert_eq!(thread.key, "rep_1#7");
        assert_eq!(thread.kind, Some(SubjectKind::Pull));
        let merged = event("pull.merged", None, json!({ "repoId": "rep_1", "number": 7 }));
        assert_eq!(thread_of(&merged, &wants(&merged).unwrap(), Some(&pull())).key, thread.key);
    }

    #[test]
    fn items_link_to_what_they_are_about() {
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Pull), Some(7), None, None), "/acme/rocket/pull/7");
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Issue), Some(3), None, None), "/acme/rocket/issues/3");
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Run), None, Some("run_1"), None), "/acme/rocket/actions/runs/run_1");
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Deploy), None, None, Some("/acme/site/deployments/dpl_1")), "/acme/site/deployments/dpl_1");
        assert_eq!(url(Some("acme/rocket"), None, None, None, None), "/acme/rocket");
        assert_eq!(url(None, None, None, None, None), "/inbox");
    }

    #[test]
    fn long_titles_are_cut_to_a_line() {
        let long = "x".repeat(400);
        assert_eq!(clip(&long, MAX_TITLE).chars().count(), MAX_TITLE);
        assert_eq!(clip("  short ", MAX_TITLE), "short");
    }

    #[test]
    fn marks_change_only_what_they_say() {
        assert_eq!(mark_change(InboxMark::Read), "read_at = COALESCE(read_at, ?1)");
        assert!(mark_change(InboxMark::Done).contains("done_at = ?1"));
        assert_eq!(mark_change(InboxMark::Unsnooze), "snoozed_until = NULL");
        assert!(ranked(&ListInboxArgs::default()));
        assert!(!ranked(&ListInboxArgs { reason: Some(Reason::Mention), ..ListInboxArgs::default() }));
        assert!(!ranked(&ListInboxArgs { participating: true, ..ListInboxArgs::default() }));
    }

    #[test]
    fn filters_bind_in_order_after_what_is_bound() {
        let a = ListInboxArgs {
            reason: Some(Reason::Mention),
            repo_id: Some("rep_1".into()),
            participating: true,
            unread: true,
            ..ListInboxArgs::default()
        };
        // Two values come first: the username and now.
        let (conditions, values) = filters(&a, 2);
        assert_eq!(
            conditions,
            vec!["reason = ?3", "repo_id = ?4", "reason NOT IN ('manual', 'subscribed')", "read_at IS NULL"]
        );
        assert_eq!(values, vec!["mention", "rep_1"]);
    }

    #[test]
    fn the_bump_keeps_whatever_is_most_urgent_while_unread() {
        assert!(BUMP.contains("WHERE NOT EXISTS (SELECT 1 FROM inbox_activity WHERE event_id = ?4 AND username = ?2)"));
        assert!(BUMP.contains("ON CONFLICT (username, thread) DO UPDATE"));
        assert!(BUMP.contains("activity = inbox_items.activity + 1"));
        // Its numbered parameters run from 1 to 19.
        for at in 1..=19 {
            assert!(BUMP.contains(&format!("?{at}")), "?{at}");
        }
        assert!(!BUMP.contains("?20"));
    }
}
