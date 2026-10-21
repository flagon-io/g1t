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
//! | `pull.stalled` | the pull request's owner, and its work item's owner and assignees | agent | warning |
//! | `pull.review_requested` | the reviewers asked, and the people each team asked tells | review_requested | warning |
//! | `work_item.assigned`, `pull.assigned` | the people newly assigned | assign | info |
//! | `checks.completed`, failed or errored | the pull request's owner | ci_activity | error |
//! | `workflow.completed`, failed | the pull request's owner, or whoever pushed | ci_activity | error |
//! | `deployment.failed` | the pull request's owner, or whoever pushed; watchers | ci_activity | error |
//! | `deployment.succeeded` | watchers; it settles the failure before it | subscribed | success |
//! | `pull.auto_merge_disabled` | whoever turned it on, unless g1t handed it to the merge queue | state_change | warning |
//! | `pull.merged`, `pull.closed`, `work_item.closed`, `work_item.reopened` | everyone subscribed | state_change | success for a merge, else info |
//! | `comment.created` | everyone mentioned, the people of teams mentioned, then everyone subscribed | mention, team_mention, or why they are subscribed | info (success for an approval) |
//! | `comment.created` by a workspace's agent | the same, shown as "Margo (agent)"; a review also tells the owner, "(advisory)" | the same, or author | the same |
//! | `commit_comment.created` | everyone mentioned, the people of teams mentioned, and the commit's author when their address is a g1t account's; one thread per commit | mention, team_mention, author | info |
//! | `work_item.opened`, `pull.opened` | whoever was assigned, asked to review or mentioned in its description (people and teams); watchers | assign, review_requested, mention, team_mention, subscribed | info |
//! | `secret_scanning_alert.summary`, `code_scanning_alert.summary`, `vulnerability_alert.summary` | the workspace's owners and security managers, whoever pushed a refused push, and watchers who chose security and may see findings; one thread per repository and alert type | security_alert | error for critical or high (told at once), info for the rest (a digest, unless the person chose at once) |
//! | `security_advisory.reported` | the workspace's owners and security managers | security_alert | warning |
//! | `secret_scanning.bypass_requested`, `.bypass_reviewed` | the reviewers named; the requester | security_alert | warning; info |
//!
//! What leaves nothing for a person to do settles their item about it
//! (marks it done): see "Settling" below for which event settles what.
//! A merge or a close reaches each thread's history but settles it at
//! once, so it is neither left unread nor pushed.
//!
//! Watchers of a repository at `all` (or `custom`, for the kinds they
//! chose) hear of every work item and pull request opened, commented on,
//! closed, reopened or merged, and of deployments. Anyone who ignores the
//! thread or the repository hears of nothing on it; anyone who
//! unsubscribed hears only of what is asked of them.
//!
//! A work item belongs to a workspace and is one thread (`item:<id>`),
//! however many repositories it is linked to. Watchers of each of them
//! hear of it; whoever ignores its origin hears of nothing on it. Its
//! items are kept with its workspace and its origin, if it has one, and
//! are shown to the workspace's members and to whoever can read the
//! origin (the event's own repository, never the first of `repoIds`).
//! Those who hear of it only by watching another repository it is linked
//! to are told only when they may read it: members of its workspace, or
//! anyone when its origin is public.
//!
//! Nobody is told of what they did themselves, though an outcome they set
//! off (checks, a workflow, a deployment, g1t's work) is theirs to hear of.
//! g1t is never told. A failure here is logged and the batch goes on: the
//! bus never waits on the inbox, so an item can be missed, but nothing else
//! is held up.

use std::collections::{HashMap, HashSet};

use g1t_contracts::agent_sessions::{APPROVAL_REQUESTED, APPROVAL_SETTLED, approval_thread, approval_threads};
use g1t_contracts::credentials::Principal;
use g1t_contracts::events::{Event, WorkspaceRenamed};
use g1t_contracts::identity::{AGENT_ID, MembersAmongArgs, UsernamesArgs};
use g1t_contracts::inbox::*;
use g1t_contracts::repos::{PathByIdArgs, ReadableArgs, Repo, RepoPath};
use g1t_contracts::security::SeverityCounts;
use g1t_contracts::security_suite::{AlertType, SecuritySummary};
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
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Wanted {
    /// The repository; for a work item, its origin, if it has one.
    pub repo_id: Option<String>,
    /// The work item or pull request, when the event names one.
    pub number: Option<u32>,
    pub comment_id: Option<String>,
    /// When the event is about a work item.
    pub item: Option<WantedItem>,
}

/// The work item an event is about.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct WantedItem {
    pub id: String,
    /// The workspace's slug.
    pub workspace: String,
    /// Every repository it is linked to, its origin first.
    pub repo_ids: Vec<String>,
}

impl Wanted {
    /// The repository's id, or empty for a work item without an origin.
    fn repo(&self) -> &str {
        self.repo_id.as_deref().unwrap_or_default()
    }
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

/// The work item an event's data names (`itemId`, with its workspace and
/// linked repositories), if any.
fn item_of(data: &serde_json::Value) -> Option<WantedItem> {
    let id = data["itemId"].as_str().filter(|id| !id.is_empty())?;
    Some(WantedItem {
        id: id.to_owned(),
        workspace: data["workspace"].as_str().unwrap_or_default().to_lowercase(),
        repo_ids: names(data, "repoIds"),
    })
}

/// The work item events the inbox tells people of.
const ITEM_TOLD: [&str; 4] = ["work_item.opened", "work_item.closed", "work_item.reopened", "work_item.assigned"];

/// The work item or pull request an event names, and what to read for it.
/// None for events the inbox does not tell anyone of.
pub fn wants(event: &Event) -> Option<Wanted> {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    let number = |key: &str| data[key].as_u64().and_then(|n| u32::try_from(n).ok());
    // A work item's events, and comments on one: it may have no origin.
    // Its origin is the event's own repository and nothing else: never a
    // `repoId` in its data, nor the first of `repoIds`, which may be a
    // repository it is only linked to, whose readers may not see it.
    let on_item = event.kind == "comment.created" && data["itemId"].is_string();
    if ITEM_TOLD.contains(&event.kind.as_str()) || on_item {
        return Some(Wanted {
            repo_id: event.repo_id.clone().filter(|id| !id.is_empty()),
            number: Some(number("number")?),
            comment_id: if on_item { Some(text("commentId")?) } else { None },
            item: Some(item_of(data)?),
        });
    }
    let repo_id = text("repoId").or_else(|| event.repo_id.clone())?;
    let on = |number: Option<u32>, comment_id: Option<String>| {
        Some(Wanted {
            repo_id: Some(repo_id.clone()),
            number,
            comment_id,
            item: None,
        })
    };
    match event.kind.as_str() {
        "pull.stalled" | "pull.merged" | "pull.closed" | "pull.opened" | "pull.auto_merge_disabled"
        | "pull.review_requested" | "pull.assigned" => on(Some(number("number")?), None),
        "checks.completed" => match data["status"].as_str() {
            Some("failed" | "errored") => on(Some(number("number")?), None),
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
        // A commit is a thread of its own, its link the commit's page.
        "commit_comment.created" => on(None, None),
        // Security alerts are threads of their own, not of a work item.
        kind if SECURITY_EVENTS.contains(&kind) => on(None, None),
        _ => None,
    }
}

/// The security service's events the inbox tells people of: each scan's
/// summary of what it opened and fixed (one thread per repository and
/// alert type, brought up to date by the next scan; never one item per
/// alert), push protection bypasses asked for and decided, vulnerability
/// reports, and advisories published. The per-alert `.created`, `.fixed`
/// and `.dismissed` events are for webhooks.
pub const SECURITY_EVENTS: [&str; 7] = [
    "secret_scanning_alert.summary",
    "code_scanning_alert.summary",
    "vulnerability_alert.summary",
    "secret_scanning.bypass_requested",
    "secret_scanning.bypass_reviewed",
    "security_advisory.reported",
    "security_advisory.published",
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

/// The thread key of a pull request.
pub fn numbered_thread(repo_id: &str, number: u32) -> String {
    format!("{repo_id}#{number}")
}

/// What a work item's thread key starts with: `item:<item_id>`.
pub const ITEM_THREAD: &str = "item:";

/// The thread key of a work item.
pub fn item_thread(item_id: &str) -> String {
    format!("{ITEM_THREAD}{item_id}")
}

/// Whether people subscribe to a thread: a work item's or a pull request's.
pub fn subscribable(thread: &str) -> bool {
    thread.starts_with(ITEM_THREAD) || thread.contains('#')
}

/// The thread of a workflow on a branch: `<repo_id>/run/<workflow>@<branch>`.
pub fn run_thread(repo_id: &str, data: &serde_json::Value) -> String {
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    let branch = text("ref").unwrap_or_default();
    let branch = branch.strip_prefix("refs/heads/").unwrap_or(&branch).to_owned();
    let workflow = text("path").or_else(|| text("workflow")).unwrap_or_default();
    format!("{repo_id}/run/{workflow}@{branch}")
}

/// The thread of a project's production, or of one pull request's preview:
/// `<repo_id>/deploy/<project_id>/<production|number>`.
pub fn deploy_thread(repo_id: &str, data: &serde_json::Value, number: Option<u32>) -> String {
    let which = number.map_or_else(|| "production".to_owned(), |number| number.to_string());
    format!("{repo_id}/deploy/{}/{which}", data["projectId"].as_str().unwrap_or_default())
}

/// The thread an event's items go to.
pub fn thread_of(event: &Event, wanted: &Wanted, subject: Option<&InboxSubject>) -> Thread {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    match event.kind.as_str() {
        // A project's production, or one pull request's preview.
        "deployment.failed" | "deployment.succeeded" => {
            Thread {
                key: deploy_thread(wanted.repo(), data, wanted.number),
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
                wanted.repo(),
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
            Thread {
                key: run_thread(wanted.repo(), data),
                kind: Some(SubjectKind::Run),
                number: None,
                run_id: text("runId"),
                link: None,
            }
        }
        // One commit's comments (work/src/commit_comments.rs).
        "commit_comment.created" => Thread {
            key: format!("{}/commit/{}", wanted.repo(), text("commit").unwrap_or_default()),
            kind: None,
            number: None,
            run_id: None,
            link: text("link"),
        },
        // A repository's alerts of one type (`rep_1/security/vulnerability`),
        // its reports, one advisory, or one bypass request: the page is the link.
        kind if SECURITY_EVENTS.contains(&kind) => {
            let which = match kind {
                "security_advisory.reported" => "reports".to_owned(),
                "security_advisory.published" => format!("advisories/{}", text("id").unwrap_or_default()),
                _ if kind.ends_with(".summary") => text("alertType").unwrap_or_else(|| "alerts".to_owned()),
                _ => text("requestId").or_else(|| text("alertId")).unwrap_or_else(|| event.id.clone()),
            };
            Thread {
                key: format!("{}/security/{which}", wanted.repo()),
                kind: None,
                number: None,
                run_id: None,
                link: text("link"),
            }
        }
        // A work item: one thread, wherever it is linked.
        _ if wanted.item.is_some() => Thread {
            key: item_thread(wanted.item.as_ref().map_or("", |item| item.id.as_str())),
            kind: Some(SubjectKind::Item),
            number: wanted.number,
            run_id: None,
            link: None,
        },
        _ => match wanted.number {
            Some(number) => Thread {
                key: numbered_thread(wanted.repo(), number),
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

// --- Settling ----------------------------------------------------------------
//
// An item is settled (marked done, and read) by the event that leaves
// nothing for its person to do about it, so the inbox, its count, Home's
// Needs you and `g1t status` show only what still waits on someone. A
// settled item stays in Done, with its history, until it is purged; new
// activity on its thread brings it back.
//
// | Item | Settled by |
// | --- | --- |
// | g1t stopped and needs you (`agent`) | `pull.resumed`, `pull.updated`, `pull.merge_requested`, `pull.merged`, `pull.closed` |
// | Anything on a work item or pull request | `work_item.closed`, `pull.merged`, `pull.closed`, after it is told (`closes`) |
// | Your own item on a thread | your comment or review on it (`handled_by`) |
// | A review asked of you | `pull.review_request_removed` naming you or your team |
// | Checks failed on a pull request (`ci_activity`) | `checks.completed` passed on its head |
// | A workflow failed on a branch | the next `workflow.completed` success of that workflow on that branch |
// | A deployment failed | `deployment.succeeded` of that project's production, or that preview |
// | A deployment waits for your review | `workflow.completed` of its run, however it ended |
// | A push protection bypass to review | `secret_scanning.bypass_reviewed` |
// | A token waits for your approval | `token.approval_reviewed` |
// | A hosted session's call waits for your approval | `agent_session.approval_settled`: answered, declined, or the session ended |
// | A workspace invitation | `workspace_invitation.accepted`, `.declined`, `.revoked` |
// | A scan's alerts | the next scan's summary with none open (`refresh_security_thread`) |

/// Which threads a settle reaches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// One thread.
    Thread(String),
    /// Every thread matching a GLOB pattern, such as one pull request's
    /// previews in every project: `rep_1/deploy/*/7`.
    Matching(String),
}

/// Items an event settles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settle {
    pub scope: Scope,
    /// One person's item, or everyone's.
    pub username: Option<String>,
    /// Only items whose latest activity was for one of these reasons; any when empty.
    pub reasons: Vec<Reason>,
    /// Only items whose latest activity was one of these events; any when empty.
    pub events: Vec<&'static str>,
    /// Why, in a few words (`settled_reason`): "CI passed in run 330", "Merged".
    pub why: Option<String>,
    /// Who settled it, when a person or g1t did (`settled_by`): a username, or g1t.
    pub by: Option<String>,
}

/// An item a settle reached: whose, and its thread.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
pub struct Settled {
    pub username: String,
    pub thread: String,
}

impl Settle {
    fn thread(thread: impl Into<String>) -> Self {
        Settle {
            scope: Scope::Thread(thread.into()),
            username: None,
            reasons: Vec::new(),
            events: Vec::new(),
            why: None,
            by: None,
        }
    }

    fn matching(pattern: impl Into<String>) -> Self {
        Settle {
            scope: Scope::Matching(pattern.into()),
            ..Settle::thread("")
        }
    }

    fn because(mut self, reasons: &[Reason]) -> Self {
        self.reasons = reasons.to_vec();
        self
    }

    fn after(mut self, events: &[&'static str]) -> Self {
        self.events = events.to_vec();
        self
    }

    fn of(mut self, username: &str) -> Self {
        self.username = Some(username.trim().trim_start_matches('@').to_lowercase());
        self
    }

    /// Says why it settled, and who settled it when someone did.
    fn saying(mut self, why: impl Into<String>, by: Option<&str>) -> Self {
        self.why = Some(why.into());
        self.by = by.map(|name| name.trim().trim_start_matches('@').to_lowercase()).filter(|name| !name.is_empty());
        self
    }

    /// The statement that settles the items, as of `now`, naming whose it
    /// settled and their threads.
    fn statement(&self, db: &D1Database, now: &str) -> Result<D1PreparedStatement> {
        let mut values: Vec<JsValue> = vec![
            now.into(),
            self.why.as_deref().map_or(JsValue::NULL, JsValue::from),
            self.by.as_deref().map_or(JsValue::NULL, JsValue::from),
        ];
        let mut conditions = vec!["done_at IS NULL".to_owned()];
        let bind = |values: &mut Vec<JsValue>, value: &str| {
            values.push(value.into());
            format!("?{}", values.len())
        };
        match &self.scope {
            Scope::Thread(thread) => conditions.push(format!("thread = {}", bind(&mut values, thread))),
            Scope::Matching(pattern) => conditions.push(format!("thread GLOB {}", bind(&mut values, pattern))),
        }
        if let Some(username) = &self.username {
            conditions.push(format!("username = {}", bind(&mut values, username)));
        }
        if !self.reasons.is_empty() {
            let marks: Vec<String> = self.reasons.iter().map(|reason| bind(&mut values, reason.as_str())).collect();
            conditions.push(format!("reason IN ({})", marks.join(", ")));
        }
        if !self.events.is_empty() {
            let marks: Vec<String> = self.events.iter().map(|kind| bind(&mut values, kind)).collect();
            conditions.push(format!("event IN ({})", marks.join(", ")));
        }
        db.prepare(format!(
            "UPDATE inbox_items SET done_at = ?1, read_at = COALESCE(read_at, ?1), settled_reason = ?2, settled_by = ?3
             WHERE {} RETURNING username, thread",
            conditions.join(" AND ")
        ))
        .bind(&values)
    }
}

/// The work item or pull request an event names, as its thread.
fn numbered(event: &Event) -> Option<String> {
    if let Some(item) = item_of(&event.data) {
        return Some(item_thread(&item.id));
    }
    let repo_id = event.data["repoId"].as_str().map(str::to_owned).or_else(|| event.repo_id.clone())?;
    let number = event.data["number"].as_u64().and_then(|n| u32::try_from(n).ok())?;
    Some(numbered_thread(&repo_id, number))
}

/// Why an agent's wait is over, by the event that ended it (`RESUMES`).
fn resumed_because(kind: &str) -> &'static str {
    match kind {
        "pull.resumed" => "g1t went on",
        "pull.updated" => "New commits were pushed",
        "pull.merge_requested" => "Merge was asked for",
        "pull.merged" => "Merged",
        _ => "Closed",
    }
}

/// What an event settles before its own notices are written: what it
/// supersedes. A success after a failure, a review given or no longer
/// asked for, a request answered. `actor` is who caused it, by username
/// (g1t for g1t), when known: each settle says why, and who did.
pub fn settles(event: &Event, actor: Option<&str>) -> Vec<Settle> {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    let repo_id = text("repoId").or_else(|| event.repo_id.clone());
    let mut settled = Vec::new();
    let kind = event.kind.as_str();
    // What an agent was waiting on a person for is over.
    if RESUMES.contains(&kind)
        && let Some(thread) = numbered(event)
    {
        settled.push(Settle::thread(thread).because(&[Reason::Agent]).saying(resumed_because(kind), actor));
    }
    match kind {
        // Reviews no longer asked for, of the people or the teams named.
        "pull.review_request_removed" => {
            if let Some(thread) = numbered(event) {
                let people = names(data, "reviewers").into_iter().chain(teams_asked(data).into_iter().flat_map(|(_, people)| people));
                for name in people.collect::<HashSet<_>>() {
                    settled.push(
                        Settle::thread(thread.clone())
                            .because(&[Reason::ReviewRequested])
                            .of(&name)
                            .saying("Review no longer asked of you", actor),
                    );
                }
            }
        }
        // A workspace invitation answered or revoked no longer waits on its person.
        _ if INVITATION_ANSWERED.contains(&kind) => {
            if let Some(thread) = text("thread").filter(|thread| thread.starts_with("invitation:")) {
                let why = match kind {
                    "workspace_invitation.accepted" => "Invitation accepted",
                    "workspace_invitation.declined" => "Invitation declined",
                    _ => "Invitation revoked",
                };
                settled.push(Settle::thread(thread).because(&[Reason::ReviewRequested]).saying(why, actor));
            }
        }
        // A token approved, denied or revoked no longer waits on the owners.
        "token.approval_reviewed" => {
            let (thread, _) = workspace_notices(event, None);
            settled.push(Settle::thread(thread).because(&[Reason::ReviewRequested]).saying("Token request decided", actor));
        }
        // Every check on its head passes now (or none fails): the failure
        // its owner was told of is behind them.
        "checks.completed" if data["status"].as_str() == Some("passed") => {
            if let Some(thread) = numbered(event) {
                let why = match text("commit") {
                    Some(commit) => format!("Checks passed on {}", short(&commit)),
                    None => "Checks passed".to_owned(),
                };
                settled.push(Settle::thread(thread).because(&[Reason::CiActivity]).saying(why, None));
            }
        }
        "workflow.completed" => {
            if let Some(repo_id) = &repo_id {
                let workflow = text("workflow").unwrap_or_else(|| "The workflow".to_owned());
                let run = data["number"].as_u64().map(|n| format!(" in run {n}")).unwrap_or_default();
                // The workflow passes on the branch again: its failures there are over.
                if data["conclusion"].as_str() == Some("success") && data["pull"].as_u64().is_none() {
                    settled.push(Settle::thread(run_thread(repo_id, data)).saying(format!("{workflow} passed{run}"), None));
                }
                // Its run is over, however it ended: no deployment of it waits for review.
                if let Some(id) = text("runId") {
                    settled.push(
                        Settle::matching(format!("{repo_id}/review/{id}/*"))
                            .because(&[Reason::ReviewRequested])
                            .saying(format!("{workflow} finished{run}"), None),
                    );
                }
            }
        }
        // It deployed: the failure before it is over.
        "deployment.succeeded" => {
            if let Some(repo_id) = &repo_id {
                let number = data["number"].as_u64().and_then(|n| u32::try_from(n).ok());
                let what = match number {
                    Some(n) => format!("Preview of #{n}"),
                    None => text("project").map_or_else(|| "Production".to_owned(), |project| format!("Production of {project}")),
                };
                let commit = text("commit").map(|commit| format!(" at {}", short(&commit))).unwrap_or_default();
                let by = actor.map(str::to_owned).or_else(|| text("triggeredBy"));
                settled.push(
                    Settle::thread(deploy_thread(repo_id, data, number))
                        .after(&["deployment.failed"])
                        .saying(format!("{what} deployed{commit}"), by.as_deref()),
                );
            }
        }
        // A bypass decided no longer waits on its reviewers.
        "secret_scanning.bypass_reviewed" => {
            if let (Some(repo_id), Some(which)) = (&repo_id, text("requestId").or_else(|| text("alertId"))) {
                settled.push(
                    Settle::thread(format!("{repo_id}/security/{which}"))
                        .because(&[Reason::SecurityAlert])
                        .saying("Bypass request decided", actor),
                );
            }
        }
        _ => {}
    }
    settled
}

/// The events after which nothing is left to do about a work item or pull
/// request: every item about it is settled once its own notices are
/// written, so they reach each thread's history but nobody's inbox, and
/// are not pushed. What landed shows on Home instead.
pub const CLOSES: [&str; 3] = ["pull.merged", "pull.closed", "work_item.closed"];

/// What an event settles once its own notices are written: everything
/// about a work item or pull request that is over, a pull request's
/// previews with it, and a hosted session's call that no longer waits.
/// `actor` is who merged or closed it, or answered the call, by username.
pub fn closes(event: &Event, actor: Option<&str>) -> Vec<Settle> {
    if event.kind == APPROVAL_SETTLED {
        return approval_settled(event, actor);
    }
    if !CLOSES.contains(&event.kind.as_str()) {
        return Vec::new();
    }
    let Some(thread) = numbered(event) else {
        return Vec::new();
    };
    let why = match event.kind.as_str() {
        "pull.merged" => "Merged",
        "work_item.closed" if event.data["reason"].as_str() == Some("not_planned") => "Closed as not planned",
        _ => "Closed",
    };
    let mut settled = vec![Settle::thread(thread).saying(why, actor)];
    if event.kind.starts_with("pull.")
        && let (Some(repo_id), Some(number)) = (
            event.data["repoId"].as_str().map(str::to_owned).or_else(|| event.repo_id.clone()),
            event.data["number"].as_u64(),
        )
    {
        settled.push(Settle::matching(format!("{repo_id}/deploy/*/{number}")).saying(why, actor));
    }
    settled
}

/// A hosted session's call answered, declined for want of an answer, or
/// ended with its session no longer waits on its starter: that call's item,
/// or with no call named every one of the session. Settled after a batch's
/// notices are written, so a call that starts waiting and stops in the same
/// batch (its session ended at once) is never left waiting in the inbox.
fn approval_settled(event: &Event, actor: Option<&str>) -> Vec<Settle> {
    let text = |key: &str| event.data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    let Some(session) = text("sessionId") else {
        return Vec::new();
    };
    let why = text("why").unwrap_or_else(|| "No longer waiting".to_owned());
    let scope = match text("toolUseId") {
        Some(call) => Some(Settle::thread(approval_thread(&session, &call))),
        None => approval_threads(&session).map(Settle::matching),
    };
    scope.map(|scope| scope.because(&[Reason::Agent]).saying(why, actor)).into_iter().collect()
}

/// The item a person's own comment or review settles: theirs on that
/// thread, which they have answered. Never an agent's, nor g1t's.
pub fn handled_by(event: &Event, subject: Option<&InboxSubject>) -> Option<Settle> {
    if event.kind != "comment.created" {
        return None;
    }
    let comment = subject?.comment.as_ref().filter(|comment| !comment.event && comment.agent.is_none())?;
    if is_g1t_id(&comment.author.id) || is_g1t(&comment.author.username) {
        return None;
    }
    let why = if comment.verdict.is_some() { "Reviewed" } else { "Commented" };
    Some(Settle::thread(numbered(event)?).of(&comment.author.username).saying(why, Some(&comment.author.username)))
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

    /// Everyone subscribed to a work item or pull request: its owner and
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

/// The kind of activity a watcher chooses: `work_items` or `pulls`.
fn activity_of(subject: &InboxSubject) -> &'static str {
    match subject.kind {
        Some(SubjectKind::Pull) => "pulls",
        _ => "work_items",
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

/// Who is told of `event`, in `repo` (`owner/name`, or for a work item its
/// workspace), given what it names and who follows it. `actor` is who
/// caused it; outcomes nobody chose (checks, workflows, deployments, g1t
/// stopping) are told whoever caused them.
pub fn notices(event: &Event, repo: &str, actor: &Actor, subject: Option<&InboxSubject>, audience: &Audience) -> Vec<Notice> {
    let nobody = Actor::default();
    let data = &event.data;
    // The work item or pull request, as titles name it: `acme/rocket#12`,
    // or `acme#12` for a work item.
    let at = match data["number"].as_u64().or(data["pull"].as_u64()) {
        Some(number) if subject.is_some() => format!("{repo}#{number}"),
        _ => repo.to_owned(),
    };
    let outcome = matches!(
        event.kind.as_str(),
        "checks.completed"
            | "workflow.completed"
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
        ("pull.stalled", Some(pull)) => {
            let detail = data["detail"].as_str().map(str::trim).filter(|detail| !detail.is_empty());
            let (title, body) = (format!("g1t stopped on {at} and needs you"), detail.unwrap_or(&pull.title).to_owned());
            told.tell_person(pull.owner(), Reason::Agent, Severity::Warning, &title, &body, true);
            if let Some(item) = &pull.item {
                told.tell_person(item.owner(), Reason::Agent, Severity::Warning, &title, &body, true);
                for name in &item.assignees {
                    told.tell(name, Reason::Agent, Severity::Warning, &title, &body, true);
                }
            }
        }
        // Whoever turned auto-merge on hears that it is off, unless they
        // turned it off themselves: it will not merge without them now.
        // Not when g1t handed it to the merge queue, which lands it: there
        // is nothing for them to do.
        ("pull.auto_merge_disabled", Some(pull)) => {
            if data["queued"].as_bool() == Some(true) {
                return told.notices;
            }
            if let Some(by) = data["autoMergeBy"].as_str() {
                let detail = data["detail"].as_str().map(str::trim).filter(|detail| !detail.is_empty());
                let title = format!("Auto-merge was turned off on {at}");
                told.tell(by, Reason::StateChange, Severity::Warning, &title, detail.unwrap_or(&pull.title), true);
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
        ("work_item.assigned" | "pull.assigned", Some(on)) => {
            let title = format!("{who} assigned you to {at}");
            for name in names(data, "added") {
                told.tell(&name, Reason::Assign, Severity::Info, &title, &on.title, true);
            }
        }
        ("work_item.opened" | "pull.opened", Some(on)) => {
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
            // A failure is whoever answers for it's to fix. A success after
            // one tells them nothing: it settles the failure's item instead
            // (`settles`), so there is nothing left in their inbox about it.
            if failed {
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
        ("pull.merged" | "pull.closed" | "work_item.closed" | "work_item.reopened", Some(on)) => {
            let (verb, severity) = match event.kind.as_str() {
                "pull.merged" => ("merged", Severity::Success),
                "work_item.reopened" => ("reopened", Severity::Info),
                _ => ("closed", Severity::Info),
            };
            let title = match (actor.name(), landed_by(data)) {
                (_, Some(what)) if event.kind == "work_item.closed" => format!("{at} was closed by {what}"),
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
            let what = data["title"].as_str().unwrap_or("A security alert");
            match kind {
                "secret_scanning.bypass_requested" => {
                    let title = format!("{who} asked to bypass push protection in {repo}");
                    for name in names(data, "notify") {
                        told.tell(&name, Reason::SecurityAlert, Severity::Warning, &title, what, true);
                    }
                }
                "secret_scanning.bypass_reviewed" => {
                    let verdict = data["state"].as_str().unwrap_or("reviewed");
                    let title = format!("Your request to bypass push protection in {repo} was {verdict}");
                    for name in names(data, "notify") {
                        told.tell(&name, Reason::SecurityAlert, Severity::Info, &title, what, true);
                    }
                }
                // Something to act on: the owners and security managers, at once.
                "security_advisory.reported" => {
                    let title = format!("A vulnerability was reported privately to {repo}");
                    for name in names(data, "notify") {
                        told.tell(&name, Reason::SecurityAlert, Severity::Warning, &title, what, true);
                    }
                }
                // Published for everyone: watchers who chose security.
                "security_advisory.published" => {
                    let title = format!("{repo} published a security advisory");
                    told.tell_watchers("security", Severity::Info, &title, what);
                }
                // A scan's summary. One that opened nothing is no news: it
                // brings the thread up to date instead (deliver_one). Whether
                // what is not urgent is told now or in a digest is each
                // person's choice, applied there too.
                _ => {
                    let Some(summary) = security_summary(event) else {
                        return told.notices;
                    };
                    if summary.opened_count == 0 {
                        return told.notices;
                    }
                    let severity = if summary.urgent() { Severity::Error } else { Severity::Info };
                    let (title, pushed) = summary_titles(repo, &summary);
                    let body = summary.latest.clone().unwrap_or_default();
                    // Whoever pushed a refused push must act: told at once, whatever was found.
                    if let Some(pusher) = &summary.pusher {
                        told.tell(pusher, Reason::SecurityAlert, Severity::Error, &pushed, &body, true);
                    }
                    for name in &summary.notify {
                        told.tell(name, Reason::SecurityAlert, severity, &title, &body, true);
                    }
                    // Watchers who chose security alerts, if they may see findings:
                    // the service lists who may (`members`), as findings are never
                    // shown to someone who cannot change the code.
                    let members = names(data, "members");
                    let watching: Vec<String> = told.audience.watching("security").collect();
                    for name in watching.iter().filter(|name| members.iter().any(|member| member.eq_ignore_ascii_case(name))) {
                        told.tell(name, Reason::SecurityAlert, severity, &title, &body, false);
                    }
                }
            }
        }
        // The work service names who: the people and teams mentioned, and
        // the commit's author when they have an account.
        ("commit_comment.created", None) => {
            let short = data["commit"].as_str().map(short).unwrap_or_default();
            let at = format!("{repo}@{short}");
            let body = data["excerpt"].as_str().unwrap_or_default();
            for name in names(data, "mentions") {
                told.tell(&name, Reason::Mention, Severity::Info, &format!("{who} mentioned you on {at}"), body, true);
            }
            for team in data["teamMentions"].as_array().into_iter().flatten() {
                let title = format!("{who} mentioned @{} on {at}", team["team"].as_str().unwrap_or_default());
                for name in names(team, "members") {
                    told.tell(&name, Reason::TeamMention, Severity::Info, &title, body, true);
                }
            }
            if let Some(author) = data["commitAuthor"].as_str() {
                told.tell(author, Reason::Author, Severity::Info, &format!("{who} commented on your commit {at}"), body, false);
            }
        }
        ("comment.created", Some(on)) => {
            let Some(comment) = on.comment.as_ref().filter(|comment| !comment.event) else {
                return Vec::new();
            };
            // Whoever wrote it is the actor, whatever the event says. One of
            // the workspace's agents is shown by its name, marked as an
            // agent; its handle is not a person's, so nobody is left out
            // for sharing it, and whoever it acted for hears of it as of
            // anything they set off.
            let writer = match &comment.agent {
                Some(agent) => Actor { id: Some(agent.id.clone()), username: None },
                None => Actor {
                    id: Some(comment.author.id.clone()),
                    username: Some(comment.author.username.clone()),
                },
            };
            told.actor = &writer;
            let who = match &comment.agent {
                Some(agent) => format!("{} (agent)", agent.display_name),
                None => comment.author.username.clone(),
            };
            let advisory = if comment.advisory { " (advisory)" } else { "" };
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
                Some("approve") => (Severity::Success, format!("{who} approved {at}{advisory}")),
                Some("request_changes") => (Severity::Info, format!("{who} asked for changes on {at}{advisory}")),
                _ if comment.advisory => (Severity::Info, format!("{who} reviewed {at}{advisory}")),
                _ => (Severity::Info, format!("{who} commented on {at}")),
            };
            // An approval or a request for changes (or an agent's review)
            // is the owner's to hear of whatever they chose; the rest, as
            // they subscribed.
            if comment.verdict.is_some() || comment.advisory {
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

/// Who an event subscribes to its work item or pull request without asking,
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
                // An agent is no person to subscribe; its handle may be someone's name.
                if !is_g1t_id(&comment.author.id) && comment.agent.is_none() {
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
        "work_item.opened" | "pull.opened" => {
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
        "work_item.assigned" | "pull.assigned" => {
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

/// What landed a work item, as a close says it: the pull request
/// (`acme/rocket#9`) or the commit (`acme/rocket@1a2b3c4`), from its
/// `resolution`.
fn landed_by(data: &serde_json::Value) -> Option<String> {
    let resolution = &data["resolution"];
    let repo = resolution["repo"].as_str().filter(|repo| !repo.is_empty())?;
    match (resolution["pull"].as_u64(), resolution["commit"].as_str()) {
        (Some(pull), _) => Some(format!("{repo}#{pull}")),
        (None, Some(commit)) => Some(format!("{repo}@{}", short(commit))),
        _ => None,
    }
}

// --- Security summaries ------------------------------------------------------

/// The scan summary a `<type>_alert.summary` event carries.
pub fn security_summary(event: &Event) -> Option<SecuritySummary> {
    if !event.kind.ends_with("_alert.summary") {
        return None;
    }
    serde_json::from_value(event.data.clone()).ok()
}

/// "1 critical, 2 high": the counts that are not zero, worst first.
pub fn breakdown(counts: &SeverityCounts) -> String {
    [("critical", counts.critical), ("high", counts.high), ("medium", counts.medium), ("low", counts.low), ("unknown", counts.unknown)]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .map(|(name, n)| format!("{n} {name}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// "vulnerability" or "vulnerabilities", as a count wants.
fn alerts_called(alert_type: &str, n: u32) -> &'static str {
    match (AlertType::parse(alert_type), n) {
        (Some(AlertType::SecretScanning), 1) => "secret",
        (Some(AlertType::SecretScanning), _) => "secrets",
        (Some(AlertType::CodeScanning), 1) => "code scanning alert",
        (Some(AlertType::CodeScanning), _) => "code scanning alerts",
        (Some(AlertType::Vulnerability), 1) => "vulnerability",
        (Some(AlertType::Vulnerability), _) => "vulnerabilities",
        (None, 1) => "security alert",
        (None, _) => "security alerts",
    }
}

/// What a scan's item says to those who look after the repository ("3 new
/// vulnerabilities in acme/rocket: 1 critical, 2 high"), and to whoever
/// pushed a push that was refused.
pub fn summary_titles(repo: &str, summary: &SecuritySummary) -> (String, String) {
    let n = summary.opened_count;
    let counts = breakdown(&summary.new_by_severity);
    let title = if counts.is_empty() {
        format!("{n} new {} in {repo}", alerts_called(&summary.alert_type, n))
    } else {
        format!("{n} new {} in {repo}: {counts}", alerts_called(&summary.alert_type, n))
    };
    let pushed = match summary.blocked {
        0 | 1 => format!("A push to {repo} was blocked: it adds a secret"),
        n => format!("A push to {repo} was blocked: it adds {n} secrets"),
    };
    (title, pushed)
}

/// What a scan that opened nothing makes the thread say: how many alerts
/// are open now ("2 open vulnerabilities in acme/rocket: 2 high"), or that
/// none is, with what changed as the line of history.
pub fn refreshed_text(repo: &str, summary: &SecuritySummary) -> (String, String) {
    let open = summary.open_total();
    let mut changes = Vec::new();
    if summary.fixed_count > 0 {
        changes.push(format!("{} fixed", summary.fixed_count));
    }
    if summary.dismissed_count > 0 {
        changes.push(format!("{} dismissed", summary.dismissed_count));
    }
    let title = if open == 0 {
        format!("No open {} in {repo}", alerts_called(&summary.alert_type, 2))
    } else {
        format!("{open} open {} in {repo}: {}", alerts_called(&summary.alert_type, open), breakdown(&summary.open))
    };
    (title, changes.join(", "))
}

/// Where a scan summary's notice goes for one person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Their inbox, now.
    Now,
    /// Their next security digest.
    Digest,
    /// Nowhere.
    Never,
}

/// The policy: critical and high alerts, and a refused push, reach the
/// people the service names (the workspace's owners and security managers,
/// the pusher) at once whatever they chose, and watchers at once unless
/// they turned security alerts off. Everything else waits for the person's
/// digest, or comes at once or never, as they chose.
pub fn security_delivery(summary: &SecuritySummary, username: &str, settings: &InboxSettings) -> Delivery {
    if summary.urgent() {
        let named = summary.notify.iter().any(|name| name.eq_ignore_ascii_case(username))
            || summary.pusher.as_deref().is_some_and(|pusher| pusher.eq_ignore_ascii_case(username));
        return if named || settings.security_alerts { Delivery::Now } else { Delivery::Never };
    }
    match settings.security_digest {
        DigestCadence::AtOnce => Delivery::Now,
        DigestCadence::Daily | DigestCadence::Weekly => Delivery::Digest,
        DigestCadence::Off => Delivery::Never,
    }
}

/// Brings every person's thread about a repository's alerts of one type up
/// to date after a scan that opened nothing: the title says what is open
/// now, a line of history says what changed, and a thread with nothing
/// left open is done. Nobody is woken: what was read stays read, and the
/// thread keeps its place.
async fn refresh_security_thread(db: &D1Database, thread: &str, repo: &str, summary: &SecuritySummary, event: &Event) -> Result<()> {
    let (title, body) = refreshed_text(repo, summary);
    let now = now_ms();
    let at = rfc3339(now);
    let settled = i32::from(summary.open_total() == 0);
    db.batch(vec![
        db.prepare(
            "UPDATE inbox_items SET event_id = ?1, event = ?2, title = ?3, body = ?4, updated_at = ?5, activity = activity + 1,
               done_at = CASE WHEN ?6 = 1 THEN COALESCE(done_at, ?5) ELSE done_at END,
               read_at = CASE WHEN ?6 = 1 THEN COALESCE(read_at, ?5) ELSE read_at END,
               settled_reason = CASE WHEN ?6 = 1 AND done_at IS NULL THEN 'Nothing left open after the latest scan' ELSE settled_reason END,
               settled_by = CASE WHEN ?6 = 1 AND done_at IS NULL THEN NULL ELSE settled_by END
             WHERE thread = ?7
               AND NOT EXISTS (SELECT 1 FROM inbox_activity a WHERE a.event_id = ?1 AND a.username = inbox_items.username)",
        )
        .bind(&[
            event.id.as_str().into(),
            event.kind.as_str().into(),
            title.as_str().into(),
            body.as_str().into(),
            at.as_str().into(),
            settled.into(),
            thread.into(),
        ])?,
        db.prepare(
            "INSERT OR IGNORE INTO inbox_activity (id, item_id, username, event_id, event, reason, severity, title, body, actor, created_at)
             SELECT ?1 || ':' || username, id, username, ?2, ?3, 'security_alert', 'info', ?4, ?5, NULL, ?6 FROM inbox_items WHERE thread = ?7",
        )
        .bind(&[
            new_id("ntf", now).into(),
            event.id.as_str().into(),
            event.kind.as_str().into(),
            title.as_str().into(),
            body.as_str().into(),
            event.time.as_str().into(),
            thread.into(),
        ])?,
    ])
    .await?;
    Ok(())
}

/// Where an item is on g1t.sh: a work item's in its workspace, the rest in
/// their repository.
pub fn url(
    repo: Option<&str>,
    workspace: Option<&str>,
    subject: Option<SubjectKind>,
    number: Option<u32>,
    run_id: Option<&str>,
    link: Option<&str>,
) -> String {
    if let Some(link) = link.filter(|link| link.starts_with('/')) {
        return link.to_owned();
    }
    if let (Some(SubjectKind::Item), Some(workspace), Some(number)) = (subject, workspace.filter(|slug| !slug.is_empty()), number) {
        return format!("/{workspace}/-/work/{number}");
    }
    let Some(repo) = repo else {
        return "/inbox".to_owned();
    };
    match (subject, number, run_id) {
        (Some(SubjectKind::Pull), Some(number), _) => format!("/{repo}/pull/{number}"),
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
    /// The notify service, told of each new item for live toasts and pushes; None, nobody is.
    pub notify: Option<&'a Fetcher>,
}

/// One notice written, and whether it was news (not a redelivery): what
/// may be emailed.
struct Written {
    notice: Notice,
    /// What its email is checked against: its repository (a work item's
    /// origin, which it may not have), and a work item's workspace, whose
    /// members may see it.
    repo_id: Option<String>,
    workspace: Option<String>,
    url: String,
    event_id: String,
    /// Its event leaves nothing to do (`CLOSES`): settled once written.
    closing: bool,
    /// The thread it is on, which notify keeps with what it replays.
    thread: String,
}

/// Writes the items a batch from the bus calls for. Never fails the batch:
/// what cannot be worked out is logged and left.
pub async fn deliver(db: &D1Database, sources: &Sources<'_>, events: &[Event]) {
    // Everyone who caused one, named in one call: notices and settles say who.
    let names = actor_names(sources, events).await;
    let actor_of = |event: &Event| -> Option<String> {
        match event.actor.as_deref() {
            Some(id) if is_g1t_id(id) => Some(system::USERNAME.to_owned()),
            Some(id) => names.get(id).map(|name| name.to_lowercase()),
            None => None,
        }
    };
    // Whose items were settled, and on which threads, to tell once at the end.
    let mut settled: HashSet<Settled> = HashSet::new();
    // What the batch supersedes goes first, so its own notices start afresh.
    let superseded: Vec<Settle> = events.iter().flat_map(|event| settles(event, actor_of(event).as_deref())).collect();
    match settle(db, &superseded).await {
        Ok(items) => settled.extend(items),
        Err(error) => worker::console_error!("inbox: items not settled: {error}"),
    }
    deliver_events(db, sources, events, &names, &mut settled).await;
    // What is over goes last, after its own notices reached each thread's history.
    let over: Vec<Settle> = events.iter().flat_map(|event| closes(event, actor_of(event).as_deref())).collect();
    match settle(db, &over).await {
        Ok(items) => settled.extend(items),
        Err(error) => worker::console_error!("inbox: closed threads not settled: {error}"),
    }
    if let Some(notify) = sources.notify {
        let mut threads: HashMap<&str, Vec<String>> = HashMap::new();
        for item in &settled {
            threads.entry(item.username.as_str()).or_default().push(item.thread.clone());
        }
        for (username, threads) in threads {
            tell_inbox_settled(db, notify, username, threads).await;
        }
    }
}

/// The usernames of whoever caused the events that tell, watch or settle
/// anything, by account id, in one call. g1t is not looked up.
async fn actor_names(sources: &Sources<'_>, events: &[Event]) -> HashMap<String, String> {
    let ids: Vec<String> = events
        .iter()
        .filter(|event| {
            wants(event).is_some() || event.kind == "repo.created" || !settles(event, None).is_empty() || !closes(event, None).is_empty()
        })
        .filter_map(|event| event.actor.clone())
        .filter(|id| !is_g1t_id(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return HashMap::new();
    }
    g1t_kit::call(sources.identity, "usernames", &UsernamesArgs { ids }).await.unwrap_or_else(|error| {
        worker::console_error!("inbox: could not name who acted: {error}");
        HashMap::new()
    })
}

async fn deliver_events(db: &D1Database, sources: &Sources<'_>, events: &[Event], names: &HashMap<String, String>, settled: &mut HashSet<Settled>) {
    // A workspace's own notices, about no repository (workspace_notices).
    for event in events.iter().filter(|event| WORKSPACE_EVENTS.contains(&event.kind.as_str())) {
        if let Err(error) = deliver_workspace(db, event).await {
            worker::console_error!("inbox: {} {} not delivered: {error}", event.kind, event.id);
        } else if let Some(notify) = sources.notify {
            // Notify: the feed tells each person once per event, redelivered or not.
            let (thread, told) = workspace_notices(event, None);
            let link = event.data["link"].as_str().filter(|link| link.starts_with('/')).unwrap_or("/inbox");
            let live = told
                .iter()
                .map(|notice| (notice.username.clone(), live_notification(&event.id, notice, link, &event.time, Some(&thread))))
                .collect();
            tell_live(notify, live).await;
            for notice in &told {
                tell_inbox_count(db, notify, &notice.username).await;
            }
        }
    }
    let wanted: Vec<(&Event, Wanted)> = events
        .iter()
        .filter_map(|event| wants(event).map(|wanted| (event, wanted)))
        .collect();
    let created: Vec<&Event> = events.iter().filter(|event| event.kind == "repo.created").collect();
    if wanted.is_empty() && created.is_empty() {
        return;
    }
    for event in created {
        if let Err(error) = subscriptions::watch_created(db, event, names).await {
            worker::console_error!("inbox: {} {} not watched: {error}", event.kind, event.id);
        }
    }
    let mut paths: HashMap<String, Option<RepoPath>> = HashMap::new();
    let mut watchers: HashMap<String, Vec<subscriptions::Watcher>> = HashMap::new();
    let mut written: Vec<Written> = Vec::new();
    for (event, wanted) in wanted {
        match deliver_one(db, sources, names, &mut paths, &mut watchers, event, wanted, settled).await {
            Ok(mut news) => written.append(&mut news),
            Err(error) => worker::console_error!("inbox: {} {} not delivered: {error}", event.kind, event.id),
        }
    }
    // Notify: every item that was news, live in the person's tabs
    // (services/notify), but for what is over, which is settled at once:
    // nobody is pushed a notification that is already done.
    if let Some(notify) = sources.notify {
        let live = written
            .iter()
            .filter(|item| !item.closing)
            .map(|item| {
                let live = live_notification(&item.event_id, &item.notice, &item.url, &rfc3339(now_ms()), Some(&item.thread));
                (item.notice.username.clone(), live)
            })
            .collect::<Vec<_>>();
        tell_live(notify, live).await;
        let people: HashSet<&str> = written.iter().filter(|item| !item.closing).map(|item| item.notice.username.as_str()).collect();
        for username in people {
            if !settled.iter().any(|item| item.username == username) {
                tell_inbox_count(db, notify, username).await;
            }
        }
    }
    if let Err(error) = email(db, sources.identity, written).await {
        worker::console_error!("inbox: emails not sent: {error}");
    }
}

/// Events about a workspace rather than a repository, each naming who to
/// tell (`notify`), what to say (`title`, `body`) and where it is (`link`):
/// identity's personal access token approvals, workspace invitations, and
/// hosted sessions' calls waiting for approval (integrations).
///
/// | Event | Who | Reason | Severity |
/// | --- | --- | --- | --- |
/// | `token.approval_requested` | the workspace's owners | review_requested | warning |
/// | `token.approval_reviewed` | the token's owner | author | info |
/// | `workspace_invitation.created` | the person invited | review_requested | warning |
/// | `workspace_invitation.accepted` | who invited them | author | success |
/// | `workspace_invitation.declined` | who invited them | author | info |
/// | `agent_session.approval_requested` | whoever started the session | agent | warning |
///
/// An invitation's item for the person invited is done once it is
/// accepted, declined or revoked (`workspace_invitation.revoked`, which
/// tells nobody). A waiting call's is done once it is answered, declined
/// for want of an answer, or its session ends
/// (`agent_session.approval_settled`, which tells nobody).
pub const WORKSPACE_EVENTS: [&str; 6] = [
    "token.approval_requested",
    "token.approval_reviewed",
    "workspace_invitation.created",
    "workspace_invitation.accepted",
    "workspace_invitation.declined",
    APPROVAL_REQUESTED,
];

/// Events that close what a workspace invitation asked of its person.
pub const INVITATION_ANSWERED: [&str; 3] =
    ["workspace_invitation.accepted", "workspace_invitation.declined", "workspace_invitation.revoked"];

/// The notices a workspace event calls for, and the thread they go to.
pub fn workspace_notices(event: &Event, actor: Option<&str>) -> (String, Vec<Notice>) {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().unwrap_or_default().to_owned();
    let (reason, severity) = match event.kind.as_str() {
        "token.approval_requested" | "workspace_invitation.created" => (Reason::ReviewRequested, Severity::Warning),
        // An agent waits on its starter: Needs you, as g1t stopping on a pull request is.
        APPROVAL_REQUESTED => (Reason::Agent, Severity::Warning),
        "workspace_invitation.accepted" => (Reason::Author, Severity::Success),
        _ => (Reason::Author, Severity::Info),
    };
    // An invitation names its own thread; a token approval's is the token's.
    let thread = match data["thread"].as_str().filter(|thread| !thread.is_empty()) {
        Some(thread) => thread.to_owned(),
        None => format!("workspace:{}/token/{}", text("workspace"), text("tokenId")),
    };
    let notices = names(data, "notify")
        .into_iter()
        .map(|name| name.to_lowercase())
        .filter(|name| actor.is_none_or(|actor| !actor.eq_ignore_ascii_case(name)) && !is_g1t(name))
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|username| Notice { username, reason, severity, title: text("title"), body: text("body") })
        .collect();
    (thread, notices)
}

/// Writes a workspace event's notices: a thread each, with no repository.
async fn deliver_workspace(db: &D1Database, event: &Event) -> Result<()> {
    let (thread, told) = workspace_notices(event, None);
    if told.is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let workspace = event.data["workspace"].as_str().unwrap_or_default().to_lowercase();
    let link = event.data["link"].as_str().filter(|link| link.starts_with('/'));
    let mut statements = Vec::new();
    for notice in &told {
        let username = notice.username.as_str();
        statements.push(db.prepare(BUMP).bind(&[
            new_id("ntf", now).into(),
            username.into(),
            thread.as_str().into(),
            event.id.as_str().into(),
            event.kind.as_str().into(),
            notice.reason.as_str().into(),
            notice.severity.as_str().into(),
            notice.title.as_str().into(),
            notice.body.as_str().into(),
            workspace.as_str().into(),
            JsValue::NULL,
            JsValue::NULL,
            JsValue::NULL,
            JsValue::NULL,
            JsValue::NULL,
            link.map_or(JsValue::NULL, JsValue::from),
            JsValue::NULL,
            event.time.as_str().into(),
            new_id("ntf", now).into(),
        ])?);
        statements.push(
            db.prepare(
                "INSERT OR IGNORE INTO inbox_activity (id, item_id, username, event_id, event, reason, severity, title, body, actor, created_at)
                 SELECT ?1, id, ?2, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10 FROM inbox_items WHERE username = ?2 AND thread = ?3",
            )
            .bind(&[
                new_id("ntf", now).into(),
                username.into(),
                thread.as_str().into(),
                event.id.as_str().into(),
                event.kind.as_str().into(),
                notice.reason.as_str().into(),
                notice.severity.as_str().into(),
                notice.title.as_str().into(),
                notice.body.as_str().into(),
                event.time.as_str().into(),
            ])?,
        );
    }
    db.batch(statements).await?;
    Ok(())
}

/// Settles items (see [`settles`]), in one batch. Returns the items it
/// settled, by person and thread, so their counts can be told again and
/// notify can stop replaying them.
async fn settle(db: &D1Database, settled: &[Settle]) -> Result<HashSet<Settled>> {
    if settled.is_empty() {
        return Ok(HashSet::new());
    }
    let now = rfc3339(now_ms());
    let statements = settled.iter().map(|settle| settle.statement(db, &now)).collect::<Result<Vec<_>>>()?;
    let mut items = HashSet::new();
    for result in db.batch(statements).await? {
        items.extend(result.results::<Settled>()?);
    }
    Ok(items)
}

#[allow(clippy::too_many_arguments)]
async fn deliver_one(
    db: &D1Database,
    sources: &Sources<'_>,
    names: &HashMap<String, String>,
    paths: &mut HashMap<String, Option<RepoPath>>,
    watchers: &mut HashMap<String, Vec<subscriptions::Watcher>>,
    event: &Event,
    wanted: Wanted,
    settled: &mut HashSet<Settled>,
) -> Result<Vec<Written>> {
    if let Some(repo_id) = &wanted.repo_id
        && !paths.contains_key(repo_id)
    {
        let path: Option<RepoPath> = g1t_kit::call(sources.repos, "path_by_id", &PathByIdArgs { id: repo_id.clone() }).await?;
        paths.insert(repo_id.clone(), path);
    }
    let path = wanted.repo_id.as_ref().and_then(|repo_id| paths.get(repo_id).cloned().flatten());
    // A repository that is gone tells nobody; a work item stays in its
    // workspace when its origin goes.
    if path.is_none() && wanted.item.is_none() {
        return Ok(Vec::new());
    }
    let subject: Option<InboxSubject> = match wanted.number {
        Some(number) => {
            let found: Option<InboxSubject> = g1t_kit::call(
                sources.work,
                "inbox_subject",
                &InboxSubjectArgs {
                    repo_id: wanted.repo_id.clone(),
                    number,
                    item_id: wanted.item.as_ref().map(|item| item.id.clone()),
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
    // Whoever commented has answered what was on the thread for them.
    if let Some(handled) = handled_by(event, subject.as_ref()) {
        settled.extend(settle(db, &[handled]).await?);
    }
    // Who watches it: its repository's watchers, or a work item's linked
    // repositories', its origin's first.
    let linked: Vec<&str> = wanted.item.as_ref().map_or_else(Vec::new, |item| {
        item.repo_ids
            .iter()
            .map(String::as_str)
            .filter(|id| wanted.repo_id.as_deref() != Some(*id))
            .collect()
    });
    for repo_id in wanted.repo_id.iter().map(String::as_str).chain(linked.iter().copied()) {
        if !watchers.contains_key(repo_id) {
            watchers.insert(repo_id.to_owned(), subscriptions::watchers(db, repo_id).await?);
        }
    }
    let own = wanted.repo_id.as_ref().and_then(|id| watchers.get(id)).cloned().unwrap_or_default();
    let others: Vec<Vec<subscriptions::Watcher>> = linked.iter().map(|id| watchers.get(*id).cloned().unwrap_or_default()).collect();
    let (watching, elsewhere) = subscriptions::linked_watchers(own, &others);
    let audience = Audience {
        subscriptions: match thread.kind {
            Some(SubjectKind::Item | SubjectKind::Pull) => subscriptions::of_thread(db, &thread.key).await?,
            _ => Vec::new(),
        },
        watchers: watching,
    };
    let repo = path.as_ref().map(|path| format!("{}/{}", path.namespace, path.name).to_lowercase());
    // Where titles say it is: a work item's workspace, else the repository.
    let workspace = match &wanted.item {
        Some(item) => item.workspace.clone(),
        None => path.as_ref().map(|path| path.namespace.to_lowercase()).unwrap_or_default(),
    };
    let place = match &wanted.item {
        Some(item) => item.workspace.clone(),
        None => repo.clone().unwrap_or_default(),
    };
    let mut told = notices(event, &place, &actor, subject.as_ref(), &audience);
    // Who hears of a work item only by watching another repository it is
    // linked to is told only if they may read it: a member of its
    // workspace, or anyone when its origin is public. Nothing of it (title,
    // body, push, email, count) reaches anyone else.
    if let Some(item) = &wanted.item {
        let hearsay: Vec<String> = told
            .iter()
            .filter(|notice| only_elsewhere(notice, &elsewhere))
            .map(|notice| notice.username.clone())
            .collect();
        if !hearsay.is_empty() {
            let asked = MembersAmongArgs { workspace: item.workspace.clone(), usernames: hearsay.clone() };
            let members: HashSet<String> = g1t_kit::call::<_, Vec<String>>(sources.identity, "members_among", &asked)
                .await
                .unwrap_or_else(|error| {
                    worker::console_error!("inbox: could not tell who is a member of {}: {error}", item.workspace);
                    Vec::new()
                })
                .into_iter()
                .map(|name| name.to_lowercase())
                .collect();
            let public = match &wanted.repo_id {
                Some(origin) if hearsay.iter().any(|name| !members.contains(name)) => {
                    crate::live::public_of(sources.repos, vec![origin.clone()]).await.contains(origin)
                }
                _ => false,
            };
            told.retain(|notice| may_hear(notice, &elsewhere, &members, public));
        }
    }
    let mut statements =
        subscriptions::auto_subscribe(db, &thread.key, wanted.repo_id.as_deref(), &subscribes(event, subject.as_ref()), &event.time)?;
    // A scan's summary: one that opened nothing brings the thread up to date
    // without waking anyone, and what is not urgent waits for each person's
    // digest, or comes at once or never, as they chose (security_delivery).
    if let (Some(summary), Some(path)) = (security_summary(event), &path) {
        if summary.opened_count == 0 {
            refresh_security_thread(db, &thread.key, &place, &summary, event).await?;
            return Ok(Vec::new());
        }
        let people: Vec<String> = told.iter().map(|notice| notice.username.clone()).collect();
        let settings = subscriptions::settings_of(db, &people).await?;
        let now = now_ms();
        let mut kept = Vec::with_capacity(told.len());
        for notice in told {
            let setting = settings.get(&notice.username).cloned().unwrap_or_default();
            match security_delivery(&summary, &notice.username, &setting) {
                Delivery::Now => kept.push(notice),
                Delivery::Digest => statements.push(crate::security_digest::queue(db, &notice.username, path, &summary, &event.id, now)?),
                Delivery::Never => {}
            }
        }
        told = kept;
    }
    if told.is_empty() {
        if !statements.is_empty() {
            db.batch(statements).await?;
        }
        return Ok(Vec::new());
    }
    let now = now_ms();
    let link = thread.link.as_deref();
    let item_url = url(repo.as_deref(), Some(&workspace), thread.kind, thread.number, thread.run_id.as_deref(), link);
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
            workspace.as_str().into(),
            wanted.repo_id.as_deref().map_or(JsValue::NULL, JsValue::from),
            repo.as_deref().map_or(JsValue::NULL, JsValue::from),
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
            workspace: wanted.item.as_ref().map(|item| item.workspace.clone()),
            url: item_url.clone(),
            event_id: event.id.clone(),
            closing: CLOSES.contains(&event.kind.as_str()),
            thread: thread.key.clone(),
        })
        .collect())
}

/// Whether a notice is someone's only by watching a repository a work item
/// is linked to other than its origin: whether they may read it is not
/// known from that.
fn only_elsewhere(notice: &Notice, elsewhere: &HashSet<String>) -> bool {
    notice.reason == Reason::Subscribed && elsewhere.contains(&notice.username)
}

/// Whether a work item's notice may be written: anyone told for a reason
/// of their own, or who watches its origin; one who only watches another
/// repository it is linked to (`elsewhere`) when they may read it, as a
/// member of its workspace (`members`) or because its origin is public.
/// An item with no origin is its workspace members' alone.
fn may_hear(notice: &Notice, elsewhere: &HashSet<String>, members: &HashSet<String>, origin_public: bool) -> bool {
    !only_elsewhere(notice, elsewhere) || origin_public || members.contains(&notice.username)
}

/// Brings a person's thread up with new activity, or starts it. `?1` id,
/// `?2` username, `?3` thread, `?4` event id, `?5` event type, `?6` reason,
/// `?7` severity, `?8` title, `?9` body, `?10` workspace, `?11` repo id,
/// `?12` repo, `?13` subject, `?14` number, `?15` run id, `?16` link, `?17`
/// actor, `?18` time, `?19` the time-sortable id lists order by. Nothing
/// happens when the person was already told of this event. While the
/// thread is unread its most urgent severity is kept; done or not, it
/// comes back to the inbox. A snooze stands.
pub(crate) const BUMP: &str = "INSERT INTO inbox_items (id, username, thread, event_id, event, reason, severity, title, body,
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
   number = COALESCE(excluded.number, inbox_items.number),
   run_id = COALESCE(excluded.run_id, inbox_items.run_id),
   link = COALESCE(excluded.link, inbox_items.link),
   actor = excluded.actor,
   updated_at = excluded.updated_at,
   bumped = excluded.bumped,
   activity = inbox_items.activity + 1,
   read_at = NULL,
   done_at = NULL,
   settled_reason = NULL,
   settled_by = NULL";

/// What the notify service is told of an inbox item (`FeedNotification` in
/// @g1t/contracts): its kind from why the person was told, the workspace
/// from where it links, and the item's title and first line.
pub fn live_notification(event_id: &str, notice: &Notice, url: &str, at: &str, thread: Option<&str>) -> serde_json::Value {
    let kind = match notice.reason {
        Reason::ReviewRequested => "approval",
        Reason::Mention | Reason::TeamMention => "mention",
        // A critical or high alert, a refused push, a report or a bypass to
        // review: toasted like a mention. A digest, or what came at once by
        // choice, is an ordinary inbox item.
        Reason::SecurityAlert if notice.severity != Severity::Info => "security",
        _ => "inbox",
    };
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let mut segments = path.trim_start_matches('/').split('/');
    let workspace = segments.next().unwrap_or_default().to_lowercase();
    let repo = segments.next().map(|name| format!("{workspace}/{name}"));
    let name = repo.unwrap_or_else(|| if workspace.is_empty() { "g1t".to_owned() } else { workspace.clone() });
    serde_json::json!({
        "id": format!("inbox:{event_id}"),
        "kind": kind,
        "workspace": workspace,
        "title": notice.title,
        "body": clip(&notice.body, 140),
        "href": if url.starts_with('/') { url } else { "/inbox" },
        "actor": { "kind": "system", "id": name, "name": name },
        "inbox_thread": thread,
        "created_at": at,
    })
}

/// What the notify service is told when a person's inbox count changes
/// (its `set_inbox`): the count as it now is, never a difference, so a
/// call repeated or out of order still ends right.
pub fn inbox_count_update(username: &str, unread: u32) -> serde_json::Value {
    serde_json::json!({ "username": username.to_lowercase(), "unread": unread })
}

/// What the notify service is told when some of a person's items settled
/// (its `set_inbox` with `settled`): the count as it now is, and the
/// threads that settled, whose notifications it then stops replaying to
/// tabs that open later and drops from open tabs' lists.
pub fn inbox_settled_update(username: &str, unread: u32, threads: &[String]) -> serde_json::Value {
    let mut threads: Vec<&str> = threads.iter().map(String::as_str).collect();
    threads.sort_unstable();
    threads.dedup();
    serde_json::json!({ "username": username.to_lowercase(), "unread": unread, "settled": threads })
}

/// Tells the notify service a person's unread count as it now is, so every
/// tab of theirs shows it at once: after items arrive, and after marks made
/// anywhere (the site, the API, MCP). Logged and left when it fails.
pub async fn tell_inbox_count(db: &D1Database, notify: &Fetcher, username: &str) {
    let counted = counts(db, InboxCountsArgs { username: username.to_owned() }).await;
    let told: Result<serde_json::Value> = match counted {
        Ok(counts) => g1t_kit::call(notify, "set_inbox", &inbox_count_update(username, counts.unread)).await,
        Err(error) => Err(error),
    };
    if let Err(error) = told {
        worker::console_error!("inbox: live count not sent: {error}");
    }
}

/// Tells the notify service a person's count after items of theirs
/// settled, with the threads that did. Logged and left when it fails.
pub async fn tell_inbox_settled(db: &D1Database, notify: &Fetcher, username: &str, threads: Vec<String>) {
    let counted = counts(db, InboxCountsArgs { username: username.to_owned() }).await;
    let told: Result<serde_json::Value> = match counted {
        Ok(counts) => g1t_kit::call(notify, "set_inbox", &inbox_settled_update(username, counts.unread, &threads)).await,
        Err(error) => Err(error),
    };
    if let Err(error) = told {
        worker::console_error!("inbox: settled items not told: {error}");
    }
}

/// Hands items to the notify service, one call each. Logged and left when it
/// cannot be reached: the inbox and email do not wait on it.
pub(crate) async fn tell_live(notify: &Fetcher, items: Vec<(String, serde_json::Value)>) {
    #[derive(serde::Serialize)]
    struct NotifyArgs {
        username: String,
        notification: serde_json::Value,
    }
    for (username, notification) in items {
        let told: Result<serde_json::Value> = g1t_kit::call(notify, "notify", &NotifyArgs { username, notification }).await;
        if let Err(error) = told {
            worker::console_error!("inbox: live notification not sent: {error}");
        }
    }
}

/// Emails what was news to people who asked to be emailed for its reason.
/// Identity sends each, only to a confirmed address and only if the person
/// can still see it: they can read its repository, or are a member of a
/// work item's workspace (all one filed with no repository has).
async fn email(db: &D1Database, identity: &Fetcher, written: Vec<Written>) -> Result<()> {
    let written: Vec<Written> = written.into_iter().filter(|item| item.repo_id.is_some() || item.workspace.is_some()).collect();
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
                workspace: item.workspace.clone(),
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
    #[serde(default)]
    thread: Option<String>,
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
    settled_reason: Option<String>,
    settled_by: Option<String>,
}

impl Row {
    pub(crate) fn into_item(self) -> InboxItem {
        let subject = self.subject.as_deref().and_then(SubjectKind::parse);
        let number = self.number.map(|n| n as u32);
        // A work item whose thread still has its issue's number, until the
        // work service's numbers arrive (work_items.rs): the old link,
        // which leads to it.
        let legacy = subject == Some(SubjectKind::Item) && self.thread.as_deref().is_some_and(|thread| !thread.starts_with(ITEM_THREAD));
        let link = match (legacy, &self.repo, number) {
            (true, Some(repo), Some(number)) => Some(format!("/{repo}/issues/{number}")),
            _ => self.link.clone(),
        };
        InboxItem {
            url: url(self.repo.as_deref(), self.workspace.as_deref(), subject, number, self.run_id.as_deref(), link.as_deref()),
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
            settled_reason: self.settled_reason,
            settled_by: self.settled_by,
        }
    }
}

pub(crate) const COLUMNS: &str = "id, thread, reason, severity, title, body, event, workspace, repo_id, repo, subject, number, run_id,
                       link, actor, activity, created_at, updated_at, read_at, done_at, saved, snoozed_until, bumped,
                       settled_reason, settled_by";

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

/// The workspaces whose work items the viewer sees all of: those they are
/// a member of, lowercased.
fn member_of(viewer: &g1t_contracts::Viewer) -> Vec<String> {
    let Some(user) = viewer else {
        return Vec::new();
    };
    user.workspaces
        .iter()
        .filter(|membership| g1t_contracts::access::workspace_role(user, &membership.slug).is_some())
        .map(|membership| membership.slug.to_lowercase())
        .collect()
}

impl Row {
    /// A work item of one of these workspaces, which a member sees
    /// whatever its origin.
    fn seen_as_member(&self, members: &[String]) -> bool {
        self.subject.as_deref() == Some(SubjectKind::Item.as_str())
            && self.workspace.as_deref().is_some_and(|slug| members.iter().any(|member| member.eq_ignore_ascii_case(slug)))
    }
}

/// Rows the viewer may still see: about repositories they can read, and
/// work items of workspaces they belong to or whose origin they can read.
/// The rest are removed from their inbox as they are found.
pub(crate) async fn readable_only(db: &D1Database, repos: &Fetcher, viewer: &g1t_contracts::Viewer, username: &str, mut rows: Vec<Row>) -> Result<Vec<Row>> {
    let members = member_of(viewer);
    // A work item outside the viewer's workspaces with no origin is not theirs to see.
    let unseen: Vec<String> = rows
        .iter()
        .filter(|row| row.subject.as_deref() == Some(SubjectKind::Item.as_str()) && row.repo_id.is_none() && !row.seen_as_member(&members))
        .map(|row| row.id.clone())
        .collect();
    let ids: Vec<String> = rows
        .iter()
        .filter(|row| !row.seen_as_member(&members))
        .filter_map(|row| row.repo_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let gone: Vec<String> = if ids.is_empty() {
        Vec::new()
    } else {
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
        ids.into_iter().filter(|id| !readable.contains(id)).collect()
    };
    if !gone.is_empty() || !unseen.is_empty() {
        forget(db, username, &gone, &unseen, &members).await?;
        rows.retain(|row| {
            !unseen.contains(&row.id) && (row.seen_as_member(&members) || row.repo_id.as_ref().is_none_or(|id| !gone.contains(id)))
        });
    }
    Ok(rows)
}

/// Removes a person's items about repositories they cannot read (but for
/// work items of the workspaces they are a member of), and the items by
/// id in `unseen`.
async fn forget(db: &D1Database, username: &str, repo_ids: &[String], unseen: &[String], members: &[String]) -> Result<()> {
    let which = "username = ?1 AND (
         (repo_id IN (SELECT value FROM json_each(?2))
          AND NOT (subject = 'item' AND workspace IN (SELECT value FROM json_each(?3))))
         OR id IN (SELECT value FROM json_each(?4)))";
    let values: Vec<JsValue> = vec![
        username.into(),
        serde_json::to_string(repo_ids)?.into(),
        serde_json::to_string(members)?.into(),
        serde_json::to_string(unseen)?.into(),
    ];
    db.batch(vec![
        db.prepare(format!("DELETE FROM inbox_activity WHERE item_id IN (SELECT id FROM inbox_items WHERE {which})"))
            .bind(&values)?,
        db.prepare(format!("DELETE FROM inbox_items WHERE {which}")).bind(&values)?,
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
        InboxMark::Done => "done_at = ?1, read_at = COALESCE(read_at, ?1), settled_reason = NULL, settled_by = NULL",
        InboxMark::Undone => "done_at = NULL, settled_reason = NULL, settled_by = NULL",
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
        (Some(SubjectKind::Item | SubjectKind::Pull), Some(_)) => {
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

/// Moves rows with renamed workspaces and repositories, drops those of
/// purged repositories, deleted workspaces and purged accounts, and
/// rewrites what was kept by issue number as issues become work items
/// (work_items.rs).
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
                // A work item's origin may be in another workspace by now.
                statements.push(
                    db.prepare(
                        "UPDATE inbox_items SET workspace = ?2,
                           repo = CASE WHEN repo LIKE ?1 || '/%' THEN ?2 || substr(repo, length(?1) + 1) ELSE repo END,
                           link = CASE WHEN link LIKE '/' || ?1 || '/%' THEN '/' || ?2 || substr(link, length(?1) + 2) ELSE link END
                         WHERE workspace = ?1",
                    )
                    .bind(&[from.as_str().into(), to.as_str().into()])?,
                );
                statements.push(
                    db.prepare("UPDATE inbox_items SET repo = ?2 || substr(repo, length(?1) + 1) WHERE workspace IS NOT ?2 AND repo LIKE ?1 || '/%'")
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
                // A work item stays in its workspace when its origin moves.
                statements.push(
                    db.prepare(
                        "UPDATE inbox_items SET repo = ?1, workspace = CASE WHEN subject = 'item' THEN workspace ELSE ?2 END
                         WHERE repo_id = ?3",
                    )
                    .bind(&[path.as_str().into(), text("to").into(), text("repoId").into()])?,
                );
                statements.push(
                    db.prepare("UPDATE inbox_watching SET repo = ? WHERE repo_id = ?")
                        .bind(&[path.as_str().into(), text("repoId").into()])?,
                );
            }
            // Its work items stay in their workspace, with no origin now.
            "repo.purged" => {
                for sql in [
                    "UPDATE inbox_items SET repo_id = NULL, repo = NULL WHERE repo_id = ?1 AND subject = 'item'",
                    "UPDATE inbox_subscriptions SET repo_id = NULL WHERE repo_id = ?1 AND thread LIKE 'item:%'",
                    "DELETE FROM inbox_activity WHERE item_id IN (SELECT id FROM inbox_items WHERE repo_id = ?1)",
                    "DELETE FROM inbox_items WHERE repo_id = ?1",
                    "DELETE FROM inbox_subscriptions WHERE repo_id = ?1",
                    "DELETE FROM inbox_watching WHERE repo_id = ?1",
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
            // Issues moved into work items: what was kept by their numbers follows.
            "work.migrated" => statements.extend(crate::work_items::moved(db, event)?),
            // An account purged: its inbox, what it watched and its
            // settings go with it (identity's account_deletion.rs).
            "user.deleted" => {
                let username = text("username");
                if username.is_empty() {
                    continue;
                }
                for sql in [
                    "DELETE FROM inbox_activity WHERE username = ?",
                    "DELETE FROM inbox_items WHERE username = ?",
                    "DELETE FROM inbox_subscriptions WHERE username = ?",
                    "DELETE FROM inbox_watching WHERE username = ?",
                    "DELETE FROM inbox_settings WHERE username = ?",
                ] {
                    statements.push(db.prepare(sql).bind(&[username.as_str().into()])?);
                }
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

    /// A pull request ana opened, assigned to bo, for a work item cy filed and dee is assigned.
    fn pull() -> InboxSubject {
        InboxSubject {
            kind: Some(SubjectKind::Pull),
            title: "Add the inbox".into(),
            author: person("usr_ana", "ana"),
            assignees: vec!["bo".into()],
            item: Some(Box::new(InboxSubject {
                kind: Some(SubjectKind::Item),
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
            Some(Wanted { repo_id: Some("rep_1".into()), number: Some(4), ..Wanted::default() })
        );
        assert_eq!(asked("checks.completed", json!({ "repoId": "rep_1", "number": 4, "status": "passed" })), None);
        assert_eq!(asked("review.completed", json!({ "repoId": "rep_1", "number": 4, "verdict": "approve" })), None);
        assert_eq!(asked("agent.asked", json!({ "repoId": "rep_1", "number": 4 })), None);
        assert_eq!(asked("workflow.completed", json!({ "repoId": "rep_1", "conclusion": "success" })), None);
        assert_eq!(
            asked("workflow.completed", json!({ "repoId": "rep_1", "conclusion": "failure" })),
            Some(Wanted { repo_id: Some("rep_1".into()), ..Wanted::default() })
        );
        assert_eq!(
            asked("comment.created", json!({ "repoId": "rep_1", "number": 2, "commentId": "cmt_1" })).map(|w| w.comment_id),
            Some(Some("cmt_1".into()))
        );
        assert_eq!(asked("git.push", json!({ "repoId": "rep_1" })), None);
        for kind in ["pull.review_requested", "pull.stalled", "pull.closed"] {
            assert!(asked(kind, json!({ "repoId": "rep_1", "number": 1 })).is_some(), "{kind}");
        }
        assert_eq!(asked("deployment.failed", json!({ "repoId": "rep_1" })).map(|w| w.number), Some(None));
    }

    #[test]
    fn a_work_items_events_are_read_by_its_id_with_or_without_an_origin() {
        let item = json!({ "itemId": "wki_1", "workspace": "Acme", "number": 40, "repoIds": ["rep_1", "rep_2"] });
        for kind in ITEM_TOLD {
            let wanted = wants(&event(kind, None, item.clone())).unwrap_or_else(|| panic!("{kind}"));
            assert_eq!(wanted.repo_id.as_deref(), Some("rep_1"));
            assert_eq!(wanted.number, Some(40));
            assert_eq!(
                wanted.item,
                Some(WantedItem { id: "wki_1".into(), workspace: "acme".into(), repo_ids: vec!["rep_1".into(), "rep_2".into()] })
            );
        }
        // Filed in the workspace: no origin.
        let filed = Event { repo_id: None, ..event("work_item.opened", None, item.clone()) };
        assert_eq!(wants(&filed).map(|wanted| wanted.repo_id), Some(None));
        // A comment on one names it; one on a pull request does not.
        let comment = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "commentId": "cmt_1", "repoIds": [] });
        let wanted = wants(&Event { repo_id: None, ..event("comment.created", None, comment) }).unwrap();
        assert_eq!((wanted.comment_id.as_deref(), wanted.item.map(|item| item.id)), (Some("cmt_1"), Some("wki_1".into())));
        // Without its id there is nothing to read.
        assert_eq!(wants(&event("work_item.opened", None, json!({ "number": 40 }))), None);
        // What the inbox does not tell of.
        assert_eq!(wants(&event("work_item.labeled", None, item)), None);
    }

    #[test]
    fn a_work_item_is_one_thread_in_its_workspace() {
        let data = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "repoIds": ["rep_1"] });
        let opened = event("work_item.opened", None, data.clone());
        let wanted = wants(&opened).unwrap();
        let thread = thread_of(&opened, &wanted, None);
        assert_eq!(thread.key, "item:wki_1");
        assert_eq!(thread.kind, Some(SubjectKind::Item));
        assert_eq!(url(Some("acme/rocket"), Some("acme"), thread.kind, thread.number, None, None), "/acme/-/work/40");
        // Closing it settles everything on it, and says what landed it.
        let closed = event(
            "work_item.closed",
            None,
            json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "resolution": { "repo": "acme/api", "pull": 9 } }),
        );
        assert_eq!(closes(&closed, Some("bo")), vec![Settle::thread("item:wki_1").saying("Closed", Some("bo"))]);
        let item = InboxSubject { kind: Some(SubjectKind::Item), title: "Ship it".into(), author: person("usr_cy", "cy"), ..InboxSubject::default() };
        assert_eq!(notices(&closed, "acme", &Actor::default(), Some(&item), &nobody())[0].title, "acme#40 was closed by acme/api#9");
        // A comment on it is handled on its thread.
        let comment = event("comment.created", None, json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "commentId": "cmt_1" }));
        let on = InboxSubject {
            comment: Some(InboxComment { author: person("usr_bo", "bo"), ..InboxComment::default() }),
            ..item
        };
        assert_eq!(handled_by(&comment, Some(&on)).map(|settle| settle.scope), Some(Scope::Thread("item:wki_1".into())));
        assert!(subscribable("item:wki_1") && subscribable("rep_1#7") && !subscribable("rep_1/run/ci@main"));
    }

    #[test]
    fn a_work_items_origin_is_its_events_repository_alone() {
        // Filed in the workspace and linked to rep_2: no origin, whatever
        // its data's `repoId` or the first of its `repoIds` say.
        let data = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "commentId": "cmt_1", "repoId": "rep_2", "repoIds": ["rep_2"] });
        for kind in ["work_item.opened", "comment.created"] {
            let wanted = wants(&Event { repo_id: None, ..event(kind, None, data.clone()) }).unwrap_or_else(|| panic!("{kind}"));
            assert_eq!(wanted.repo_id, None, "{kind}");
        }
        // With an origin, the event's repository, not its data's.
        let wanted = wants(&event("comment.created", None, data)).unwrap();
        assert_eq!(wanted.repo_id.as_deref(), Some("rep_1"));
    }

    #[test]
    fn who_only_watches_a_linked_repository_hears_of_a_work_item_they_may_read() {
        let notice = |username: &str, reason: Reason| Notice {
            username: username.into(),
            reason,
            severity: Severity::Info,
            title: "acme#40 Secret plans".into(),
            body: String::new(),
        };
        let set = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<HashSet<String>>();
        let elsewhere = set(&["cy", "dee"]);
        let members = set(&["dee"]);
        // Its origin's watchers and whoever is told for a reason of their own.
        assert!(may_hear(&notice("ana", Reason::Subscribed), &elsewhere, &members, false));
        assert!(may_hear(&notice("cy", Reason::Mention), &elsewhere, &members, false));
        // A member of its workspace may read it.
        assert!(may_hear(&notice("dee", Reason::Subscribed), &elsewhere, &members, false));
        // Anyone else only when its origin is public.
        assert!(!may_hear(&notice("cy", Reason::Subscribed), &elsewhere, &members, false));
        assert!(may_hear(&notice("cy", Reason::Subscribed), &elsewhere, &members, true));
    }

    #[test]
    fn a_work_items_watchers_are_its_origins_then_its_other_repositories() {
        let watcher = |name: &str, level: WatchLevel| Watcher { username: name.into(), level, events: Vec::new() };
        let own = vec![watcher("ana", WatchLevel::All), watcher("bo", WatchLevel::Ignore)];
        let others = vec![vec![watcher("bo", WatchLevel::All), watcher("cy", WatchLevel::All), watcher("dee", WatchLevel::Ignore)]];
        let (watchers, elsewhere) = subscriptions::linked_watchers(own, &others);
        let names: Vec<(&str, WatchLevel)> = watchers.iter().map(|w| (w.username.as_str(), w.level)).collect();
        // Ignoring the origin stands; ignoring another repository says nothing.
        assert_eq!(names, vec![("ana", WatchLevel::All), ("bo", WatchLevel::Ignore), ("cy", WatchLevel::All)]);
        assert_eq!(elsewhere.into_iter().collect::<Vec<_>>(), vec!["cy".to_owned()]);
    }

    #[test]
    fn a_stopped_pull_request_needs_its_people_and_its_work_items_people_first() {
        let stalled = event("pull.stalled", None, json!({ "number": 7 }));
        let notices_ = notices(&stalled, "acme/rocket", &Actor::default(), Some(&pull()), &nobody());
        assert_eq!(
            told(&notices_),
            vec![
                ("ana", Reason::Agent, Severity::Warning),
                ("cy", Reason::Agent, Severity::Warning),
                ("dee", Reason::Agent, Severity::Warning),
            ]
        );
        assert_eq!(notices_[0].title, "g1t stopped on acme/rocket#7 and needs you");
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
    fn whoever_turned_on_auto_merge_hears_it_is_off() {
        let off = event("pull.auto_merge_disabled", None, json!({ "number": 7, "autoMergeBy": "bo", "detail": "Its branch conflicts with main." }));
        let notices_ = notices(&off, "acme/rocket", &Actor::default(), Some(&pull()), &nobody());
        assert_eq!(told(&notices_), vec![("bo", Reason::StateChange, Severity::Warning)]);
        assert_eq!(notices_[0].title, "Auto-merge was turned off on acme/rocket#7");
        assert_eq!(notices_[0].body, "Its branch conflicts with main.");
        // Turning it off yourself tells no one.
        let notices_ = notices(&off, "acme/rocket", &actor("usr_bo", "bo"), Some(&pull()), &nobody());
        assert!(notices_.is_empty());
    }

    #[test]
    fn g1t_handing_a_pull_request_to_the_merge_queue_tells_no_one() {
        let off = event(
            "pull.auto_merge_disabled",
            None,
            json!({ "number": 7, "autoMergeBy": "bo", "detail": "It joined the merge queue.", "queued": true }),
        );
        assert!(notices(&off, "acme/rocket", &Actor::default(), Some(&pull()), &nobody()).is_empty());
    }

    #[test]
    fn whatever_an_agent_waits_on_closes_when_it_goes_on() {
        for kind in RESUMES {
            let settled = settles(&event(kind, None, json!({ "repoId": "rep_1", "number": 7 })), Some("ana"));
            let agent = settled.iter().find(|settle| settle.reasons == [Reason::Agent]).unwrap_or_else(|| panic!("{kind}"));
            assert_eq!(agent.scope, Scope::Thread("rep_1#7".into()));
            assert_eq!(agent.why.as_deref(), Some(resumed_because(kind)));
            assert_eq!(agent.by.as_deref(), Some("ana"));
        }
        assert_eq!(resumed_because("pull.updated"), "New commits were pushed");
        assert!(settles(&event("comment.created", None, json!({ "repoId": "rep_1", "number": 7 })), None).is_empty());
    }

    #[test]
    fn a_merge_or_a_close_settles_everything_about_it() {
        let merged = event("pull.merged", Some("usr_ana"), json!({ "repoId": "rep_1", "number": 7 }));
        assert_eq!(
            closes(&merged, Some("Ana")),
            vec![
                Settle::thread("rep_1#7").saying("Merged", Some("ana")),
                Settle::matching("rep_1/deploy/*/7").saying("Merged", Some("ana")),
            ]
        );
        let closed = event("pull.closed", None, json!({ "repoId": "rep_1", "number": 7 }));
        assert_eq!(closes(&closed, None).len(), 2);
        assert_eq!(closes(&closed, None)[0].why.as_deref(), Some("Closed"));
        assert_eq!(closes(&closed, None)[0].by, None);
        // A work item has no previews.
        let item = event("work_item.closed", None, json!({ "itemId": "wki_1", "workspace": "acme", "number": 3, "reason": "not_planned" }));
        assert_eq!(closes(&item, Some("bo")), vec![Settle::thread("item:wki_1").saying("Closed as not planned", Some("bo"))]);
        // Reopening is something to hear of, and settles nothing.
        assert!(closes(&event("work_item.reopened", None, json!({ "itemId": "wki_1", "number": 3 })), None).is_empty());
        assert!(settles(&event("work_item.reopened", None, json!({ "itemId": "wki_1", "number": 3 })), None).is_empty());
    }

    #[test]
    fn a_workflow_passing_on_a_branch_settles_its_failures_there() {
        let data = |conclusion: &str| {
            json!({ "repoId": "rep_1", "runId": "run_9", "workflow": "Deploy", "path": ".g1t/workflows/deploy.yml", "ref": "refs/heads/main", "conclusion": conclusion, "number": 328 })
        };
        let failed = event("workflow.completed", Some("usr_bo"), data("failure"));
        let thread = thread_of(&failed, &wants(&failed).unwrap(), None).key;
        assert_eq!(thread, "rep_1/run/.g1t/workflows/deploy.yml@main");
        let passed = event("workflow.completed", Some("usr_bo"), data("success"));
        assert!(wants(&passed).is_none(), "a success tells no one");
        // Whoever started the run did not settle anything: the run passing did.
        assert_eq!(
            settles(&passed, Some("bo")),
            vec![
                Settle::thread(thread.clone()).saying("Deploy passed in run 328", None),
                Settle::matching("rep_1/review/run_9/*").because(&[Reason::ReviewRequested]).saying("Deploy finished in run 328", None),
            ]
        );
        // A failure or a cancelled run settles no failure, but ends what its deployments waited for.
        for conclusion in ["failure", "cancelled"] {
            assert_eq!(
                settles(&event("workflow.completed", None, data(conclusion)), None),
                vec![Settle::matching("rep_1/review/run_9/*").because(&[Reason::ReviewRequested]).saying("Deploy finished in run 328", None)]
            );
        }
        // On a pull request, its checks passing settles the failure instead.
        let on_pull = event("workflow.completed", None, json!({ "repoId": "rep_1", "runId": "run_9", "conclusion": "success", "pull": 7 }));
        assert!(!settles(&on_pull, None).iter().any(|settle| settle.scope == Scope::Thread(thread.clone())));
    }

    #[test]
    fn checks_passing_settle_the_failure_its_owner_was_told_of() {
        let passed = event("checks.completed", None, json!({ "repoId": "rep_1", "number": 7, "status": "passed", "commit": "abcdef0123456" }));
        assert_eq!(
            settles(&passed, None),
            vec![Settle::thread("rep_1#7").because(&[Reason::CiActivity]).saying("Checks passed on abcdef0", None)]
        );
        let failed = event("checks.completed", None, json!({ "repoId": "rep_1", "number": 7, "status": "failed" }));
        assert!(settles(&failed, None).is_empty());
    }

    #[test]
    fn a_deployment_settles_the_failure_before_it() {
        let live = event("deployment.succeeded", Some("usr_bo"), json!({ "repoId": "rep_1", "projectId": "prj_1", "project": "web", "commit": "1234567890" }));
        assert_eq!(
            settles(&live, Some("bo")),
            vec![Settle::thread("rep_1/deploy/prj_1/production").after(&["deployment.failed"]).saying("Production of web deployed at 1234567", Some("bo"))]
        );
        // Started by g1t or a workflow: the deployment names who.
        let preview = event("deployment.succeeded", None, json!({ "repoId": "rep_1", "projectId": "prj_1", "number": 7, "triggeredBy": "g1t" }));
        assert_eq!(
            settles(&preview, None),
            vec![Settle::thread("rep_1/deploy/prj_1/7").after(&["deployment.failed"]).saying("Preview of #7 deployed", Some("g1t"))]
        );
    }

    #[test]
    fn requests_answered_settle_what_they_asked() {
        let removed = event(
            "pull.review_request_removed",
            None,
            json!({ "repoId": "rep_1", "number": 7, "reviewers": ["Bo"], "teams": [{ "team": "acme/web", "notified": ["cy"] }] }),
        );
        let mut people: Vec<Option<String>> = settles(&removed, Some("ana")).into_iter().map(|settle| settle.username).collect();
        people.sort();
        assert_eq!(people, vec![Some("bo".to_owned()), Some("cy".to_owned())]);
        assert!(settles(&removed, Some("ana")).iter().all(|settle| settle.why.as_deref() == Some("Review no longer asked of you")));
        let token = event("token.approval_reviewed", None, json!({ "workspace": "acme", "tokenId": "tok_1" }));
        assert_eq!(
            settles(&token, Some("ana")),
            vec![Settle::thread("workspace:acme/token/tok_1").because(&[Reason::ReviewRequested]).saying("Token request decided", Some("ana"))]
        );
        let bypass = event("secret_scanning.bypass_reviewed", None, json!({ "repoId": "rep_1", "requestId": "byp_1" }));
        assert_eq!(
            settles(&bypass, None),
            vec![Settle::thread("rep_1/security/byp_1").because(&[Reason::SecurityAlert]).saying("Bypass request decided", None)]
        );
        let invitation = event("workspace_invitation.declined", None, json!({ "thread": "invitation:inv_1" }));
        assert_eq!(
            settles(&invitation, Some("cy")),
            vec![Settle::thread("invitation:inv_1").because(&[Reason::ReviewRequested]).saying("Invitation declined", Some("cy"))]
        );
    }

    #[test]
    fn your_own_comment_settles_your_item_on_the_thread() {
        let commented = event("comment.created", Some("usr_bo"), json!({ "repoId": "rep_1", "number": 7, "commentId": "cmt_1" }));
        let by_bo = comment(person("usr_bo", "Bo"), "Looks good", &[]);
        assert_eq!(handled_by(&commented, Some(&by_bo)), Some(Settle::thread("rep_1#7").of("bo").saying("Commented", Some("bo"))));
        let mut review = comment(person("usr_bo", "Bo"), "Ship it", &[]);
        review.comment.as_mut().unwrap().verdict = Some("approve".into());
        assert_eq!(handled_by(&commented, Some(&review)).and_then(|settle| settle.why), Some("Reviewed".to_owned()));
        // Not g1t's, nor an agent's, nor a note the service wrote.
        let by_g1t = comment(person(AGENT_ID, "g1t"), "Done", &[]);
        assert_eq!(handled_by(&commented, Some(&by_g1t)), None);
        let mut note = comment(person("usr_bo", "bo"), "", &[]);
        note.comment.as_mut().unwrap().event = true;
        assert_eq!(handled_by(&commented, Some(&note)), None);
        assert_eq!(handled_by(&event("pull.merged", None, json!({ "repoId": "rep_1", "number": 7 })), Some(&by_bo)), None);
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
        let assigned = event("work_item.assigned", Some("usr_ana"), json!({ "number": 3, "added": ["ana", "eve"] }));
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
        let audience = watched(&[("cy", WatchLevel::Custom, &["deployments"]), ("dee", WatchLevel::Custom, &["work_items"]), ("eve", WatchLevel::All, &[])]);
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
        assert_eq!(url(Some("acme/rocket"), None, thread.kind, None, None, thread.link.as_deref()), "/acme/rocket/deployments/dpl_1");
        // A success tells the owner nothing, even after a failure: it
        // settles the failure (settles). Watchers who chose deployments hear of it.
        let live = event("deployment.succeeded", Some("usr_bo"), json!({ "repoId": "rep_1", "projectId": "prj_1", "project": "rocket", "commit": "abcdef0123" }));
        assert!(notices(&live, "acme/rocket", &actor("usr_bo", "bo"), None, &nobody()).is_empty());
        let recovered = event("deployment.succeeded", Some("usr_bo"), json!({ "repoId": "rep_1", "projectId": "prj_1", "project": "rocket", "recovered": true }));
        assert!(notices(&recovered, "acme/rocket", &actor("usr_bo", "bo"), None, &nobody()).is_empty());
        let notices_ = notices(&recovered, "acme/rocket", &actor("usr_bo", "bo"), None, &audience);
        assert_eq!(told(&notices_), vec![("cy", Reason::Subscribed, Severity::Success), ("eve", Reason::Subscribed, Severity::Success)]);
        assert_eq!(notices_[0].title, "Production of rocket is live");
        // A preview's is the pull request's owner's.
        let preview = event("deployment.failed", None, json!({ "repoId": "rep_1", "projectId": "prj_1", "number": 7, "triggeredBy": "g1t" }));
        assert_eq!(told(&notices(&preview, "acme/rocket", &Actor::default(), Some(&pull()), &nobody())), vec![("ana", Reason::CiActivity, Severity::Error)]);
        assert_eq!(thread_of(&preview, &wants(&preview).unwrap(), Some(&pull())).key, "rep_1/deploy/prj_1/7");
    }

    /// A scan's summary, as the security service publishes it.
    fn summary(alert_type: &str, opened: &[&str], new: (u32, u32, u32, u32), open: (u32, u32, u32, u32), pusher: Option<&str>) -> Event {
        let counts = |(critical, high, medium, low): (u32, u32, u32, u32)| json!({ "critical": critical, "high": high, "medium": medium, "low": low, "unknown": 0 });
        let worst = [(new.0, "critical"), (new.1, "high"), (new.2, "medium"), (new.3, "low")].into_iter().find(|(n, _)| *n > 0).map(|(_, name)| name);
        let page = match alert_type {
            "secret_scanning" => "secret-scanning",
            "code_scanning" => "code-scanning",
            _ => "vulnerabilities",
        };
        event(
            &format!("{alert_type}_alert.summary"),
            None,
            json!({
                "repoId": "rep_1", "alertType": alert_type, "scan": if pusher.is_some() { "push" } else { "dependencies" },
                "opened": opened, "openedCount": opened.len(), "fixedCount": 0, "dismissedCount": 0,
                "newBySeverity": counts(new), "open": counts(open), "worst": worst,
                "latest": if opened.is_empty() { serde_json::Value::Null } else { json!("lodash 4.17.20 in package-lock.json: GHSA-1") },
                "link": format!("/acme/rocket/security/{page}"),
                "pusher": pusher, "blocked": if pusher.is_some() { opened.len() } else { 0 },
                "notify": ["ana"], "members": ["ana", "bo", "cy"]
            }),
        )
    }

    #[test]
    fn a_scan_is_one_item_per_repository_and_alert_type() {
        let found = summary("vulnerability", &["vul_3", "vul_2", "vul_1"], (1, 2, 0, 0), (1, 2, 0, 0), None);
        assert_eq!(wants(&found), Some(Wanted { repo_id: Some("rep_1".into()), ..Wanted::default() }));
        // cy watches for security alerts and is a member; eve watches
        // everything but cannot see findings; dee watches work items only.
        let audience = watched(&[
            ("cy", WatchLevel::Custom, &["security"]),
            ("dee", WatchLevel::Custom, &["work_items"]),
            ("eve", WatchLevel::All, &[]),
        ]);
        let notices_ = notices(&found, "acme/rocket", &Actor::default(), None, &audience);
        assert_eq!(told(&notices_), vec![("ana", Reason::SecurityAlert, Severity::Error), ("cy", Reason::SecurityAlert, Severity::Error)]);
        assert_eq!(notices_[0].title, "3 new vulnerabilities in acme/rocket: 1 critical, 2 high");
        assert_eq!(notices_[0].body, "lodash 4.17.20 in package-lock.json: GHSA-1");
        // The same thread for every scan of this type, however many alerts.
        let thread = thread_of(&found, &wants(&found).unwrap(), None);
        assert_eq!(thread.key, "rep_1/security/vulnerability");
        assert_eq!(url(Some("acme/rocket"), None, thread.kind, None, None, thread.link.as_deref()), "/acme/rocket/security/vulnerabilities");
        // Medium and low are news, but not urgent: an info item, or the digest.
        let quiet = summary("code_scanning", &["cod_1"], (0, 0, 1, 0), (0, 0, 1, 0), None);
        let notices_ = notices(&quiet, "acme/rocket", &Actor::default(), None, &audience);
        assert_eq!(told(&notices_), vec![("ana", Reason::SecurityAlert, Severity::Info), ("cy", Reason::SecurityAlert, Severity::Info)]);
        assert_eq!(notices_[0].title, "1 new code scanning alert in acme/rocket: 1 medium");
        // A scan that opened nothing tells nobody: the thread is brought up to date instead.
        let fixed = summary("vulnerability", &[], (0, 0, 0, 0), (0, 1, 0, 0), None);
        assert!(notices(&fixed, "acme/rocket", &Actor::default(), None, &audience).is_empty());
        let (title, body) = refreshed_text("acme/rocket", &SecuritySummary { fixed_count: 2, ..security_summary(&fixed).unwrap() });
        assert_eq!(title, "1 open vulnerability in acme/rocket: 1 high");
        assert_eq!(body, "2 fixed");
        let settled = SecuritySummary { fixed_count: 1, dismissed_count: 1, open: SeverityCounts::default(), ..security_summary(&fixed).unwrap() };
        assert_eq!(refreshed_text("acme/rocket", &settled), ("No open vulnerabilities in acme/rocket".to_owned(), "1 fixed, 1 dismissed".to_owned()));
        // Per-alert events are for webhooks.
        assert_eq!(wants(&event("vulnerability_alert.created", None, json!({ "repoId": "rep_1" }))), None);
        assert_eq!(wants(&event("code_scanning_alert.fixed", None, json!({ "repoId": "rep_1" }))), None);
    }

    #[test]
    fn a_refused_push_tells_the_pusher_at_once_and_the_owners_once() {
        let blocked = summary("secret_scanning", &["sec_1", "sec_2"], (2, 0, 0, 0), (2, 0, 0, 0), Some("bo"));
        let notices_ = notices(&blocked, "acme/rocket", &Actor::default(), None, &nobody());
        assert_eq!(told(&notices_), vec![("bo", Reason::SecurityAlert, Severity::Error), ("ana", Reason::SecurityAlert, Severity::Error)]);
        assert_eq!(notices_[0].title, "A push to acme/rocket was blocked: it adds 2 secrets");
        assert_eq!(notices_[1].title, "2 new secrets in acme/rocket: 2 critical");
        assert_eq!(thread_of(&blocked, &wants(&blocked).unwrap(), None).key, "rep_1/security/secret_scanning");
        // Whatever bo chose, the push is theirs to fix; ana, an owner, is told whatever she chose.
        let summary_ = security_summary(&blocked).unwrap();
        let off = InboxSettings { security_alerts: false, security_digest: DigestCadence::Off, ..InboxSettings::default() };
        assert_eq!(security_delivery(&summary_, "bo", &off), Delivery::Now);
        assert_eq!(security_delivery(&summary_, "ana", &off), Delivery::Now);
        // A watcher who turned security alerts off hears of nothing urgent.
        assert_eq!(security_delivery(&summary_, "cy", &off), Delivery::Never);
        assert_eq!(security_delivery(&summary_, "cy", &InboxSettings::default()), Delivery::Now);
    }

    #[test]
    fn what_is_not_urgent_waits_for_the_digest_unless_the_person_chose_otherwise() {
        let medium = security_summary(&summary("vulnerability", &["vul_1"], (0, 0, 1, 0), (0, 0, 1, 0), None)).unwrap();
        assert!(!medium.urgent());
        let choose = |cadence| InboxSettings { security_digest: cadence, ..InboxSettings::default() };
        // Owners too: a medium alert is for the digest, as they chose.
        assert_eq!(security_delivery(&medium, "ana", &choose(DigestCadence::Daily)), Delivery::Digest);
        assert_eq!(security_delivery(&medium, "cy", &choose(DigestCadence::Weekly)), Delivery::Digest);
        assert_eq!(security_delivery(&medium, "cy", &choose(DigestCadence::AtOnce)), Delivery::Now);
        assert_eq!(security_delivery(&medium, "ana", &choose(DigestCadence::Off)), Delivery::Never);
        let high = security_summary(&summary("vulnerability", &["vul_1"], (0, 1, 0, 0), (0, 1, 0, 0), None)).unwrap();
        assert_eq!(security_delivery(&high, "ana", &choose(DigestCadence::Off)), Delivery::Now);
        assert_eq!(breakdown(&SeverityCounts { critical: 1, low: 3, ..SeverityCounts::default() }), "1 critical, 3 low");
        assert_eq!(breakdown(&SeverityCounts::default()), "");
    }

    #[test]
    fn bypass_requests_reports_and_advisories_tell_who_they_name() {
        let audience = watched(&[("cy", WatchLevel::Custom, &["security"]), ("eve", WatchLevel::All, &[])]);
        // A bypass request goes to the reviewers named, never to watchers.
        let requested = event(
            "secret_scanning.bypass_requested",
            Some("usr_bo"),
            json!({ "repoId": "rep_1", "alertId": "sec_1", "requestId": "byp_1", "title": "An AWS access key in a.env", "notify": ["ana"], "link": "/acme/-/security/bypass-requests" }),
        );
        let notices_ = notices(&requested, "acme/rocket", &actor("usr_bo", "bo"), None, &audience);
        assert_eq!(told(&notices_), vec![("ana", Reason::SecurityAlert, Severity::Warning)]);
        assert_eq!(notices_[0].title, "bo asked to bypass push protection in acme/rocket");
        assert_eq!(thread_of(&requested, &wants(&requested).unwrap(), None).key, "rep_1/security/byp_1");
        // A private report is for the owners and security managers, at once, with no reporter named.
        let reported = event(
            "security_advisory.reported",
            None,
            json!({ "repoId": "rep_1", "id": "vrp_1", "title": "XSS in the search box", "state": "new", "link": "/acme/rocket/security/reports", "notify": ["ana"], "members": ["ana", "cy"] }),
        );
        let notices_ = notices(&reported, "acme/rocket", &Actor::default(), None, &audience);
        assert_eq!(told(&notices_), vec![("ana", Reason::SecurityAlert, Severity::Warning)]);
        assert_eq!(notices_[0].title, "A vulnerability was reported privately to acme/rocket");
        assert_eq!(thread_of(&reported, &wants(&reported).unwrap(), None).key, "rep_1/security/reports");
        // A published advisory is for watchers who chose security; it is public, so no members list is needed.
        let published = event(
            "security_advisory.published",
            Some("usr_ana"),
            json!({ "repoId": "rep_1", "id": "adv_1", "g1tsaId": "G1TSA-2026-abcd-efgh", "title": "XSS in the search box", "severity": "high", "state": "published", "link": "/acme/rocket/security/advisories/G1TSA-2026-abcd-efgh" }),
        );
        let notices_ = notices(&published, "acme/rocket", &actor("usr_ana", "ana"), None, &audience);
        assert_eq!(told(&notices_), vec![("cy", Reason::Subscribed, Severity::Info), ("eve", Reason::Subscribed, Severity::Info)]);
        assert_eq!(thread_of(&published, &wants(&published).unwrap(), None).key, "rep_1/security/advisories/adv_1");
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
        let closed = event("work_item.closed", Some("usr_bo"), json!({ "number": 3, "reason": "completed" }));
        let item = InboxSubject {
            kind: Some(SubjectKind::Item),
            title: "Crash".into(),
            author: person("usr_cy", "cy"),
            assignees: vec!["bo".into()],
            ..InboxSubject::default()
        };
        let mut audience = subscribed(&[("eve", State::Subscribed, Some(Reason::Comment)), ("fay", State::Unsubscribed, None)]);
        audience.watchers = watched(&[("gus", WatchLevel::All, &[]), ("hal", WatchLevel::Custom, &["pulls"])]).watchers;
        let notices_ = notices(&closed, "acme", &actor("usr_bo", "bo"), Some(&item), &audience);
        assert_eq!(
            told(&notices_),
            vec![
                ("cy", Reason::StateChange, Severity::Info),
                ("eve", Reason::StateChange, Severity::Info),
                ("gus", Reason::Subscribed, Severity::Info),
            ]
        );
        assert_eq!(notices_[0].title, "bo closed acme#3");
        let by_pull = event("work_item.closed", None, json!({ "number": 3, "resolution": { "repo": "acme/rocket", "commit": "1a2b3c4d5e" } }));
        assert_eq!(notices(&by_pull, "acme", &Actor::default(), Some(&item), &nobody())[0].title, "acme#3 was closed by acme/rocket@1a2b3c4");
        let reopened = event("work_item.reopened", Some("usr_cy"), json!({ "number": 3 }));
        assert_eq!(told(&notices(&reopened, "acme", &actor("usr_cy", "cy"), Some(&item), &nobody())), vec![("bo", Reason::StateChange, Severity::Info)]);
    }

    #[test]
    fn opening_tells_who_it_names_and_watchers_of_its_kind() {
        let opened = event("pull.opened", Some("usr_ana"), json!({ "number": 7 }));
        let subject = InboxSubject { reviewers: vec!["cy".into(), "g1t".into()], ..pull() };
        let audience = watched(&[("bo", WatchLevel::All, &[]), ("dee", WatchLevel::Custom, &["work_items"]), ("eve", WatchLevel::Custom, &["pulls"]), ("fay", WatchLevel::Participating, &[])]);
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
    fn an_agent_s_review_is_shown_by_its_name_and_marked_advisory() {
        // Margo (@margo), acting for bo, asks for changes on ana's pull request.
        let created = event("comment.created", Some("usr_bo"), json!({ "number": 7, "commentId": "cmt_1" }));
        let mut on = comment(person("agt_1", "ana"), "Trim the name.", &[]);
        if let Some(said) = on.comment.as_mut() {
            said.agent = Some(g1t_contracts::work::AgentRef {
                id: "agt_1".into(),
                handle: "ana".into(),
                display_name: "Margo".into(),
                avatar_seed: "margo".into(),
            });
            said.acting_for = Some(person("usr_bo", "bo"));
            said.verdict = Some("request_changes".into());
            said.advisory = true;
        }
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on), &nobody());
        // Its handle sharing ana's name leaves nobody out: ana owns it and hears.
        assert!(told(&notices_).contains(&("ana", Reason::Author, Severity::Info)));
        assert_eq!(notices_[0].title, "Margo (agent) asked for changes on acme/rocket#7 (advisory)");
        // An agent subscribes nobody by its handle.
        assert!(subscribes(&created, Some(&on)).iter().all(|(name, _)| name != "ana"));
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
    fn a_commit_comment_tells_who_it_mentions_and_the_commit_s_author() {
        let created = event(
            "commit_comment.created",
            Some("usr_bo"),
            json!({
                "repoId": "rep_1", "commit": "abcdef1234567890", "link": "/acme/rocket/commit/abcdef1234567890",
                "excerpt": "@cy why this?", "mentions": ["cy", "bo"], "commitAuthor": "ana",
                "teamMentions": [{ "team": "acme/web", "members": ["dee", "cy"] }],
            }),
        );
        let wanted = wants(&created).unwrap();
        assert_eq!(wanted.number, None);
        let thread = thread_of(&created, &wanted, None);
        assert_eq!(thread.key, "rep_1/commit/abcdef1234567890");
        assert_eq!(url(Some("acme/rocket"), None, thread.kind, thread.number, None, thread.link.as_deref()), "/acme/rocket/commit/abcdef1234567890");
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), None, &nobody());
        assert_eq!(
            told(&notices_),
            vec![
                ("cy", Reason::Mention, Severity::Info),
                ("dee", Reason::TeamMention, Severity::Info),
                ("ana", Reason::Author, Severity::Info),
            ]
        );
        assert_eq!(notices_[0].title, "bo mentioned you on acme/rocket@abcdef1");
        assert_eq!(notices_[2].title, "bo commented on your commit acme/rocket@abcdef1");
        assert_eq!(notices_[0].body, "@cy why this?");
    }

    #[test]
    fn pull_requests_are_one_thread_each() {
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
        assert_eq!(url(Some("acme/rocket"), None, Some(SubjectKind::Pull), Some(7), None, None), "/acme/rocket/pull/7");
        assert_eq!(url(Some("acme/rocket"), Some("acme"), Some(SubjectKind::Item), Some(3), None, None), "/acme/-/work/3");
        assert_eq!(url(None, Some("acme"), Some(SubjectKind::Item), Some(3), None, None), "/acme/-/work/3");
        assert_eq!(url(Some("acme/rocket"), None, Some(SubjectKind::Run), None, Some("run_1"), None), "/acme/rocket/actions/runs/run_1");
        assert_eq!(url(Some("acme/rocket"), None, Some(SubjectKind::Deploy), None, None, Some("/acme/site/deployments/dpl_1")), "/acme/site/deployments/dpl_1");
        assert_eq!(url(Some("acme/rocket"), None, None, None, None, None), "/acme/rocket");
        assert_eq!(url(None, None, None, None, None, None), "/inbox");
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

    #[test]
    fn live_notifications_say_what_and_where() {
        let notice = Notice {
            username: "ana".into(),
            reason: Reason::Agent,
            severity: Severity::Warning,
            title: "g1t needs you on acme/api#4".into(),
            body: "Which database?".into(),
        };
        let live = live_notification("evt_1", &notice, "/Acme/api/pull/4#c1", "2026-10-08T00:00:00Z", Some("rep_1#4"));
        assert_eq!(live["id"], "inbox:evt_1");
        // A stop that needs a person is an ordinary inbox item.
        assert_eq!(live["kind"], "inbox");
        assert_eq!(live["workspace"], "acme");
        assert_eq!(live["href"], "/Acme/api/pull/4#c1");
        assert_eq!(live["actor"]["name"], "acme/api");
        // Notify keeps the thread, to stop replaying it once it settles.
        assert_eq!(live["inbox_thread"], "rep_1#4");
        let mention = Notice { reason: Reason::TeamMention, ..notice };
        assert_eq!(live_notification("evt_2", &mention, "https://elsewhere", "t", None)["href"], "/inbox");
        assert_eq!(live_notification("evt_2", &mention, "/x", "t", None)["kind"], "mention");
    }

    #[test]
    fn inbox_counts_are_told_as_they_are_by_username() {
        assert_eq!(inbox_count_update("Ana", 3), serde_json::json!({ "username": "ana", "unread": 3 }));
        assert_eq!(inbox_count_update("bo", 0)["unread"], 0);
        // What settled is told with the count, each thread once.
        let threads = vec!["rep_1#7".to_owned(), "rep_1/deploy/*/7".to_owned(), "rep_1#7".to_owned()];
        assert_eq!(
            inbox_settled_update("Ana", 2, &threads),
            serde_json::json!({ "username": "ana", "unread": 2, "settled": ["rep_1#7", "rep_1/deploy/*/7"] })
        );
    }

    #[test]
    fn a_settle_says_why_and_who_and_clears_on_new_activity() {
        let settle = Settle::thread("rep_1#7").saying("Merged", Some("@Ana"));
        assert_eq!(settle.why.as_deref(), Some("Merged"));
        assert_eq!(settle.by.as_deref(), Some("ana"));
        assert_eq!(Settle::thread("rep_1#7").saying("Checks passed", Some(" ")).by, None);
        // New activity brings a thread back with no reason left on it, and so does marking it by hand.
        assert!(BUMP.contains("settled_reason = NULL"));
        assert!(mark_change(InboxMark::Done).contains("settled_reason = NULL"));
        assert!(mark_change(InboxMark::Undone).contains("settled_reason = NULL"));
    }

    #[test]
    fn token_approvals_tell_the_people_named_about_no_repository() {
        let mut asked = event(
            "token.approval_requested",
            Some("usr_ana"),
            json!({ "workspace": "acme", "tokenId": "tok_1", "notify": ["Bo", "cy", "bo", "g1t"], "title": "ana asks", "body": "ci: contents: write", "link": "/acme/-/settings/tokens" }),
        );
        asked.repo_id = None;
        let (thread, told) = workspace_notices(&asked, None);
        assert_eq!(thread, "workspace:acme/token/tok_1");
        let mut names: Vec<&str> = told.iter().map(|notice| notice.username.as_str()).collect();
        names.sort();
        assert_eq!(names, ["bo", "cy"], "each once, lowercased, never g1t");
        assert!(told.iter().all(|notice| notice.reason == Reason::ReviewRequested && notice.severity == Severity::Warning));
        assert!(wants(&asked).is_none(), "about no repository");
        let reviewed = event("token.approval_reviewed", None, json!({ "workspace": "acme", "tokenId": "tok_1", "notify": ["ana"], "title": "approved" }));
        let (_, told) = workspace_notices(&reviewed, None);
        assert_eq!(told[0].reason, Reason::Author);
        assert!(WORKSPACE_EVENTS.contains(&"token.approval_reviewed"));
    }

    #[test]
    fn a_hosted_sessions_waiting_call_needs_its_starter_until_it_is_settled() {
        let data = g1t_contracts::agent_sessions::ApprovalRequested {
            workspace: "acme".into(),
            session_id: "ses_1".into(),
            tool_use_id: "sevt_3".into(),
            thread: approval_thread("ses_1", "sevt_3"),
            notify: vec!["Ada".into()],
            title: "Your hosted session on #4 waits for your approval to use bash".into(),
            body: "bash: npm install".into(),
            link: "/acme/-/chat/sessions/ses_1#approval-sevt_3".into(),
        };
        let mut asked = event(APPROVAL_REQUESTED, None, serde_json::to_value(&data).unwrap());
        asked.repo_id = None;
        assert!(wants(&asked).is_none(), "about no repository");
        let (thread, told) = workspace_notices(&asked, None);
        assert_eq!(thread, "agent-session:ses_1/approval/sevt_3");
        assert_eq!(told.len(), 1);
        assert_eq!((told[0].username.as_str(), told[0].reason, told[0].severity), ("ada", Reason::Agent, Severity::Warning));
        assert_eq!(told[0].body, "bash: npm install");
        // Answered: that call's item is done, saying how and by whom, once the
        // batch's notices are written, so one asked in the same batch is settled too.
        let answered = event(APPROVAL_SETTLED, Some("usr_bea"), json!({ "workspace": "acme", "sessionId": "ses_1", "toolUseId": "sevt_3", "why": "Allowed" }));
        assert!(settles(&answered, Some("bea")).is_empty(), "not before the batch's notices");
        let settled = closes(&answered, Some("bea"));
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].scope, Scope::Thread("agent-session:ses_1/approval/sevt_3".into()));
        assert_eq!((settled[0].reasons.as_slice(), settled[0].why.as_deref(), settled[0].by.as_deref()), (&[Reason::Agent][..], Some("Allowed"), Some("bea")));
        // The session ended: every call of it, and no other session's.
        let ended = event(APPROVAL_SETTLED, None, json!({ "workspace": "acme", "sessionId": "ses_1", "why": "The session ended while it waited" }));
        assert_eq!(closes(&ended, None)[0].scope, Scope::Matching("agent-session:ses_1/approval/*".into()));
        let wild = event(APPROVAL_SETTLED, None, json!({ "workspace": "acme", "sessionId": "*", "why": "x" }));
        assert!(closes(&wild, None).is_empty(), "never a pattern wider than one session");
        assert!(closes(&event(APPROVAL_SETTLED, None, json!({ "workspace": "acme" })), None).is_empty());
        assert!(!WORKSPACE_EVENTS.contains(&APPROVAL_SETTLED), "settling tells nobody");
    }

    #[test]
    fn a_workspace_invitation_asks_its_person_and_tells_whoever_sent_it_the_answer() {
        let mut sent = event(
            "workspace_invitation.created",
            Some("usr_owner"),
            json!({ "workspace": "flagon-io", "invitationId": "inv_1", "thread": "invitation:inv_1", "notify": ["daweazl"], "title": "@syntaqx invited you to join Flagon, Inc.", "link": "/invitations" }),
        );
        sent.repo_id = None;
        let (thread, told) = workspace_notices(&sent, None);
        assert_eq!(thread, "invitation:inv_1");
        assert_eq!(told.len(), 1);
        assert_eq!((told[0].username.as_str(), told[0].reason, told[0].severity), ("daweazl", Reason::ReviewRequested, Severity::Warning));
        let accepted = event("workspace_invitation.accepted", None, json!({ "workspace": "flagon-io", "thread": "invitation:inv_1", "notify": ["syntaqx"] }));
        let (thread, told) = workspace_notices(&accepted, None);
        assert_eq!(thread, "invitation:inv_1");
        assert_eq!((told[0].reason, told[0].severity), (Reason::Author, Severity::Success));
        let declined = event("workspace_invitation.declined", None, json!({ "workspace": "flagon-io", "thread": "invitation:inv_1", "notify": ["syntaqx"] }));
        assert_eq!(workspace_notices(&declined, None).1[0].severity, Severity::Info);
        // Answered or revoked, the person's item is done; a revocation tells nobody.
        for kind in ["workspace_invitation.accepted", "workspace_invitation.declined", "workspace_invitation.revoked"] {
            assert!(INVITATION_ANSWERED.contains(&kind));
        }
        assert!(!WORKSPACE_EVENTS.contains(&"workspace_invitation.revoked"));
    }
}
