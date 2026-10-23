//! The work service: work items, pull requests, comments and sessions.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::work` for the methods and their arguments. It also
//! consumes its queue of events from the bus.

mod attachments;
mod authored;
mod automerge;
mod checks;
mod closing;
mod cloud_agents;
mod ghost;
mod codeowners;
mod commit_checks;
mod commit_comments;
mod contributions;
mod coordination;
mod decisions;
mod guardrails;
mod head_repo;
mod heads;
mod inbox;
mod insights;
mod integration;
mod items;
mod lifecycle;
#[cfg(test)]
mod migrated;
mod merge_message;
mod mergeability;
mod merging;
mod prefetch;
mod pull_edits;
mod pushed;
mod queue;
mod reactions;
mod retired;
mod reviews;
mod rows;
mod rulesets;
mod runs;
mod settings;
mod signals;
mod spend;
mod statuses;
mod team_reviews;

use g1t_contracts::events::{
    ChangedFrom, CommentChanges, CommentCreated, CommentDeleted, CommentEdited, CommentOn, DeletedComment, Event, NewEvent,
    Publish, PullEvent, SessionAppended,
};
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{
    ForkArgs, GetArgs, HeadArgs, LandArgs, Landed, NeedsAgentReason, PullBranchUpdate, ReadableArgs, Repo, RepoPath,
    UpdateMethod, UpdatePullBranchArgs,
};
use g1t_contracts::access::{self, Capability, Denied};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use futures_util::future::{try_join, try_join3, try_join_all};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Serialize;
use worker::wasm_bindgen::JsValue;
use worker::{
    Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, QueueRetryOptionsBuilder, Request, Response, Result, ScheduleContext, ScheduledEvent,
    event,
};

use items::Held;
use retired::writable;
use rows::{CommentRow, MovedRow, NumberRow, PULL_COLUMNS, PullRow, SessionRow, Snapshot};

pub(crate) const SOURCE: &str = "work";
const MAX_ENTRY_BATCH: usize = 200;
pub(crate) const MAX_ENTRY_CHARS: usize = 64_000;
const MAX_TITLE_CHARS: usize = 200;
const SESSION_PAGE: u32 = 500;
pub(crate) const LIST_PAGE: u32 = 100;
const MAX_ASSIGNEES: usize = 10;
pub(crate) const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

/// Where a note or a comment goes: a pull request of a repository, by its
/// number, or a work item, by its id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum On<'a> {
    Pull(&'a str, u32),
    Item(&'a str),
}

/// What a comment, a reaction or a set of labels is on: a pull request of
/// a repository, or a work item. See `AddCommentArgs`.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum Thread {
    Pull(Repo, Pull),
    Item(Held),
}

impl Thread {
    /// Where its comments and notes are kept.
    pub(crate) fn on(&self) -> On<'_> {
        match self {
            Thread::Pull(_, pull) => On::Pull(&pull.repo_id, pull.number),
            Thread::Item(held) => On::Item(&held.item.id),
        }
    }

    /// The id its description's reactions are kept under.
    pub(crate) fn subject(&self) -> &str {
        match self {
            Thread::Pull(_, pull) => &pull.id,
            Thread::Item(held) => &held.item.id,
        }
    }

    /// Where it is, as the `comment.*` events say.
    pub(crate) fn comment_on(&self) -> CommentOn {
        match self {
            Thread::Pull(_, pull) => CommentOn {
                repo_id: Some(pull.repo_id.clone()),
                number: pull.number,
                pull_id: Some(pull.id.clone()),
                ..CommentOn::default()
            },
            Thread::Item(held) => CommentOn {
                repo_id: held.event_repo().map(str::to_owned),
                number: held.item.number,
                item_id: Some(held.item.id.clone()),
                workspace: Some(held.item.workspace.clone()),
                repo_ids: held.repo_ids(),
                ..CommentOn::default()
            },
        }
    }

    /// The repository its events are filed under.
    pub(crate) fn event_repo(&self) -> Option<&str> {
        match self {
            Thread::Pull(repo, _) => Some(&repo.id),
            Thread::Item(held) => held.event_repo(),
        }
    }

    /// Whether `actor` may do `capability` on it.
    pub(crate) fn may(&self, actor: &User, capability: Capability) -> bool {
        match self {
            Thread::Pull(repo, _) => access::can(Some(actor), repo, capability),
            Thread::Item(held) => held.may(Some(actor), capability),
        }
    }
}

fn no_pull<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Pull request not found.")
}

/// Whether a pull request was behind when its mergeability was last
/// worked out, and for which pair of commits (mergeability.rs).
#[derive(serde::Deserialize)]
struct StoredBehind {
    #[serde(default)]
    behind: Option<u8>,
    #[serde(default)]
    mergeable_key: Option<String>,
}

impl StoredBehind {
    /// The stored answer, if it was worked out for `head`.
    fn for_head(&self, head: Option<&str>) -> Option<bool> {
        let (worked_for, _) = self.mergeable_key.as_deref()?.split_once("..")?;
        (Some(worked_for) == head).then_some(self.behind? != 0)
    }
}

/// A pull request's work item, by id, read beside its row.
#[derive(serde::Deserialize)]
struct PullItemRow {
    #[serde(default)]
    item_id: Option<String>,
}

/// Refuses `actor` unless their role on `repo` has `capability`: not found
/// when they cannot read it, forbidden with the role it needs otherwise.
pub(crate) fn allowed(actor: Option<&User>, repo: &Repo, capability: Capability) -> Outcome<()> {
    match access::check(actor, repo, capability) {
        Ok(()) => Outcome::Ok(()),
        Err(Denied::NotFound) => Outcome::fail(FailureCode::NotFound, "Repository not found."),
        Err(Denied::Forbidden) => Outcome::fail(
            FailureCode::Forbidden,
            access::needs(capability, &format!("{}/{}", repo.namespace, repo.name)),
        ),
    }
}

pub(crate) fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

pub(crate) fn optional_number(value: Option<u32>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// Names the branch a pull request merges into when it is the default
/// branch, which is stored as none so that it follows a change of default.
pub(crate) fn fill_base(pull: &mut Pull, repo: &Repo) {
    if pull.base.as_deref().is_none_or(str::is_empty) {
        pull.base = Some(repo.default_branch.clone());
    }
}

/// The branch a pull request is stored as merging into: none for the
/// default branch.
fn stored_base(base: &str, repo: &Repo) -> Option<String> {
    let base = base.trim();
    (!base.is_empty() && base != repo.default_branch).then(|| base.to_owned())
}

/// The lowercase name a `State` is stored and sent as.
pub(crate) fn state_name(state: Option<State>) -> Option<&'static str> {
    state.map(|state| match state {
        State::Open => "open",
        State::Closed => "closed",
    })
}

/// A trimmed title, or why it cannot be used.
pub(crate) fn valid_title(title: &str) -> std::result::Result<&str, &'static str> {
    let title = title.trim();
    if title.is_empty() {
        Err("A title is required.")
    } else if title.chars().count() > MAX_TITLE_CHARS {
        Err("That title is too long.")
    } else {
        Ok(title)
    }
}

/// What a closed pull request was when it was closed.
#[derive(serde::Deserialize)]
struct ClosedFrom {
    #[serde(default)]
    closed_from: Option<String>,
}

/// Why a pull request in `status` cannot be reopened, if it cannot: only a
/// closed one can, never a merged one.
fn reopen_refusal(status: PullStatus) -> Option<&'static str> {
    match status {
        PullStatus::Closed => None,
        PullStatus::Merged => Some("This pull request was merged; it cannot be reopened."),
        PullStatus::Draft | PullStatus::Open => Some("This pull request is already open."),
    }
}

/// What a closed pull request is reopened as: the draft it was, when it
/// was closed as one, else ready for review.
fn reopened_status(closed_from: Option<&str>) -> PullStatus {
    if closed_from == Some("draft") { PullStatus::Draft } else { PullStatus::Open }
}

/// Why a pull request in `status` cannot be turned into a draft, if it
/// cannot: only one that is open, ready for review, can.
fn draft_refusal(status: PullStatus) -> Option<&'static str> {
    match status {
        PullStatus::Open => None,
        PullStatus::Draft => Some("This pull request is already a draft."),
        PullStatus::Merged => Some("This pull request is already merged."),
        PullStatus::Closed => Some("This pull request is closed. Reopen it first."),
    }
}

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

struct Work {
    db: D1Database,
    identity: Fetcher,
    repos: Fetcher,
    events: Fetcher,
    /// GitHub Actions: runs a merge queue's `merge_group` workflows.
    actions: Fetcher,
    /// Integrations: the workspace's AI provider names sessions
    /// (coordination/titles.rs). None where it is not bound.
    integrations: Option<Fetcher>,
    /// Where this request's time went, for its `Server-Timing`.
    timing: g1t_kit::d1::Timing,
    /// A pull request's rows read in one batch for this request
    /// (prefetch.rs), which the helpers below read instead of the database.
    prefetched: std::cell::RefCell<Option<std::rc::Rc<prefetch::Prefetched>>>,
    /// Repositories read in this request, by id, for rules that need one
    /// where only a pull request is at hand (rulesets.rs `repo_for`).
    known_repos: std::cell::RefCell<std::collections::HashMap<String, Repo>>,
    /// Where this request's reads of repos may go: the session the site
    /// would have asked repos for itself (crates/kit/src/d1.rs
    /// `forwarded`), so a page's access checks read a replica near it
    /// rather than the primary each time. `None`, the primary, for every
    /// other caller, and for methods that may write.
    repos_session: Option<String>,
}

impl Work {
    async fn publish<T: Serialize>(
        &self,
        kind: &'static str,
        repo_id: &str,
        actor: &User,
        data: T,
    ) -> Result<()> {
        // What a workflow job's token did is marked, so it starts no
        // workflows (`g1t_contracts::events::CAUSED_BY_JOB`).
        self.publish_as(kind, repo_id, Some(actor.id.clone()), g1t_contracts::events::marked(data, Some(actor)))
            .await
    }

    /// A pull request's owner (whoever asked g1t for it, or its author) as
    /// a viewer who can read its repository and source. Stored people carry
    /// no memberships, so a private repository would otherwise look missing
    /// to them. The membership given reads and nothing more: it is for
    /// looking, never for acting.
    pub(crate) async fn owner_viewer(&self, pull: &Pull) -> Result<Viewer> {
        let path: Option<RepoPath> = g1t_kit::call(
            &self.repos,
            "path_by_id",
            &g1t_contracts::repos::PathByIdArgs { id: pull.repo_id.clone() },
        )
        .await?;
        let mut owner = pull.owner().clone();
        if let Some(path) = path
            && !owner.is_member(&path.namespace.to_lowercase())
        {
            owner.workspaces.push(g1t_contracts::Membership {
                base_permission: Some(access::BasePermission::Read),
                ..g1t_contracts::Membership::member(path.namespace.to_lowercase())
            });
        }
        Ok(Some(owner))
    }

    /// Publishes an event caused by `actor`, or by g1t itself.
    async fn publish_as<T: Serialize>(
        &self,
        kind: &'static str,
        repo_id: &str,
        actor: Option<String>,
        data: T,
    ) -> Result<()> {
        let data = serde_json::to_value(data)?;
        // Store agent updates before external event delivery. A retry may repeat
        // an event, but an external delivery failure cannot erase its inbox copy.
        // Coordination changes write their updates with themselves instead
        // (coordination::updates) and call `publish_value`.
        self.deliver_update(kind, repo_id, &data).await?;
        self.publish_value(kind, repo_id, actor, data).await
    }

    /// Publishes an event whose session updates are already written.
    pub(crate) async fn publish_value(
        &self,
        kind: &'static str,
        repo_id: &str,
        actor: Option<String>,
        data: serde_json::Value,
    ) -> Result<()> {
        self.publish_on(kind, Some(repo_id).filter(|id| !id.is_empty()), actor, data).await
    }

    /// Publishes an event about a repository, or about none (a work item
    /// filed in its workspace alone).
    pub(crate) async fn publish_on(
        &self,
        kind: &'static str,
        repo_id: Option<&str>,
        actor: Option<String>,
        data: serde_json::Value,
    ) -> Result<()> {
        let event = NewEvent {
            kind,
            source: SOURCE,
            repo_id: repo_id.map(str::to_owned),
            actor,
            data,
        };
        g1t_kit::call(
            &self.events,
            "publish",
            &Publish {
                events: vec![event],
            },
        )
        .await
    }

    /// The repository, if the viewer may see it. Whether they may is
    /// decided by the repos service, from where the caller would have read
    /// it (`repos_session`).
    async fn repo(&self, path: &RepoPath, viewer: &Viewer) -> Result<Outcome<Repo>> {
        let found: Outcome<Repo> = self
            .timing
            .rpc(g1t_kit::call_in(
                &self.repos,
                "get",
                &GetArgs {
                    path: path.clone(),
                    viewer: viewer.clone(),
                },
                self.repos_session.as_deref(),
            ))
            .await?;
        if let Outcome::Ok(repo) = &found {
            self.known_repos.borrow_mut().insert(repo.id.clone(), repo.clone());
        }
        Ok(found)
    }

    async fn pull(&self, repo_id: &str, number: u32) -> Result<Option<Pull>> {
        Ok(self
            .db
            .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id = ? AND number = ?"))
            .bind(&[repo_id.into(), number.into()])?
            .first::<PullRow>(None)
            .await?
            .map(Pull::from))
    }

    /// The thread a pair of `repo` (a pull request of it) or `workspace`
    /// (a work item of it) and `number` names, if `viewer` may read it.
    pub(crate) async fn thread(&self, viewer: &Viewer, repo: Option<&RepoPath>, workspace: &str, number: u32) -> Result<Outcome<Thread>> {
        Ok(match repo {
            Some(path) => match self.pull_at(path, number, viewer).await? {
                Outcome::Ok((repo, pull)) => Outcome::Ok(Thread::Pull(repo, pull)),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            },
            None => match items::for_viewer(self, viewer, workspace, number, Capability::Read).await? {
                Outcome::Ok(held) => Outcome::Ok(Thread::Item(held)),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            },
        })
    }

    /// The repository and one of its pull requests, as seen by `viewer`.
    async fn pull_at(
        &self,
        path: &RepoPath,
        number: u32,
        viewer: &Viewer,
    ) -> Result<Outcome<(Repo, Pull)>> {
        let Outcome::Ok(repo) = self.repo(path, viewer).await? else {
            return Ok(no_pull());
        };
        Ok(match self.pull(&repo.id, number).await? {
            Some(pull) => Outcome::Ok((repo, pull)),
            None => no_pull(),
        })
    }

    /// Records something that happened to a pull request, so that it shows
    /// in the conversation where it happened. `text` is what `author` did,
    /// as the rest of a sentence starting with their name: an id and a
    /// name, or someone acting, as [`rows::By`] records them.
    pub(crate) async fn note<'a>(
        &self,
        repo_id: &str,
        number: u32,
        author: impl Into<rows::By<'a>>,
        text: &str,
    ) -> Result<()> {
        self.note_on(On::Pull(repo_id, number), author.into(), text).await
    }

    /// Records something that happened, on a pull request or a work item.
    pub(crate) async fn note_on(&self, on: On<'_>, author: rows::By<'_>, text: &str) -> Result<()> {
        let now = now_ms();
        let (repo_id, number, item_id) = match on {
            On::Pull(repo_id, number) => (JsValue::from(repo_id), JsValue::from(number), JsValue::NULL),
            On::Item(item_id) => (JsValue::NULL, JsValue::NULL, JsValue::from(item_id)),
        };
        self.db
            .prepare(
                "INSERT INTO comments
                   (id, repo_id, number, item_id, author_id, author_name, body, kind, created_at,
                    acting_for_id, acting_for_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'event', ?, ?, ?)",
            )
            .bind(&[
                new_id("cmt", now).into(),
                repo_id,
                number,
                item_id,
                author.id.into(),
                author.name.into(),
                text.into(),
                rfc3339(now).into(),
                author.acting_for.map_or(JsValue::NULL, |(id, _)| id.into()),
                author.acting_for.map_or(JsValue::NULL, |(_, name)| name.into()),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Notes who was added to and removed from a list of people, such as
    /// "assigned ana" or "requested a review from g1t".
    pub(crate) async fn note_changes(
        &self,
        on: On<'_>,
        actor: &User,
        before: &[String],
        after: &[String],
        (added, removed): (&str, &str),
    ) -> Result<()> {
        let joined = |names: Vec<&String>| {
            names
                .into_iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        };
        let new: Vec<&String> = after.iter().filter(|name| !before.contains(name)).collect();
        let gone: Vec<&String> = before.iter().filter(|name| !after.contains(name)).collect();
        let who = actor;
        if !new.is_empty() {
            // Taking something on oneself reads better said that way (not
            // when g1t, acting for them, did it).
            let text = if added == "assigned" && new == [&actor.username] && actor.acting.is_none() {
                "self-assigned this".to_owned()
            } else {
                format!("{added} {}", joined(new))
            };
            self.note_on(on, who.into(), &text).await?;
        }
        if !gone.is_empty() {
            self.note_on(on, who.into(), &format!("{removed} {}", joined(gone))).await?;
        }
        Ok(())
    }

    /// The commit a pull request's change is at in git right now: its
    /// working copy's default branch, or its branch, of the repository or
    /// of the fork it is in.
    async fn live_head(&self, pull: &Pull) -> Result<Option<String>> {
        g1t_kit::call(
            &self.repos,
            "head",
            &HeadArgs {
                repo_id: pull.source_id().to_owned(),
                branch: pull.branch.clone().unwrap_or_default(),
            },
        )
        .await
    }

    fn pull_event(pull: &Pull) -> PullEvent {
        PullEvent {
            pull_id: pull.id.clone(),
            repo_id: pull.repo_id.clone(),
            number: pull.number,
            author: Some((&pull.author).into()),
            requested_by: pull.requested_by.as_ref().map(Into::into),
            item: pull.item,
            ..PullEvent::default()
        }
    }

    /// Usernames as given, tidied, if each names an account.
    async fn valid_assignees(&self, names: Vec<String>) -> Result<Outcome<Vec<String>>> {
        let mut assignees: Vec<String> = Vec::new();
        for name in names {
            let name = name.trim().trim_start_matches('@').to_lowercase();
            if name.is_empty() || assignees.contains(&name) {
                continue;
            }
            if assignees.len() == MAX_ASSIGNEES {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("A work item or pull request can be assigned to at most {MAX_ASSIGNEES} people."),
                ));
            }
            // g1t has no account, and takes the work on: a session on the
            // workspace's own Claude (integrations' summon.rs).
            if name == g1t_contracts::system::USERNAME {
                assignees.push(name);
                continue;
            }
            let account: Viewer = g1t_kit::call(
                &self.identity,
                "user_by_username",
                &UsernameArgs {
                    username: name.clone(),
                },
            )
            .await?;
            if account.is_none() {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("There is no account named {name}."),
                ));
            }
            assignees.push(name);
        }
        Ok(Outcome::Ok(assignees))
    }

    /// How many work items linked to a repository are open, and how many
    /// of its pull requests.
    async fn counts(&self, a: ViewArgs) -> Result<Outcome<Counts>> {
        let read = |repo_id: String| async move {
            let query = self
                .db
                .prepare(concat!(
                    "SELECT
                       ",
                    items::sql::open_items_linked_to!("?1"),
                    " AS items,
                       (SELECT count(*) FROM pulls
                        WHERE repo_id = ?1 AND status IN ('draft', 'open')) AS pulls",
                ))
                .bind(&[repo_id.into()])?;
            self.timing.db(1, query.first::<Counts>(None)).await
        };
        let (_, counts) = check!(self.repo_then(&a.repo, &a.viewer, read).await?);
        Ok(Outcome::Ok(counts.unwrap_or(Counts { items: 0, pulls: 0 })))
    }

    // --- Comments ----------------------------------------------------------

    async fn add_comment(&self, a: AddCommentArgs) -> Result<Outcome<Comment>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let body = a.body.trim();
        // An approval speaks for itself; anything else has to say something.
        if body.is_empty() && a.verdict != Some(Verdict::Approve) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "A comment cannot be empty.",
            ));
        }
        let path = a
            .path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let line = a.line.filter(|line| *line > 0 && path.is_some());
        if body.chars().count() > MAX_ENTRY_CHARS {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "That comment is too long.",
            ));
        }
        let thread = check!(self.thread(&Some(a.actor.clone()), a.repo.as_ref(), &a.workspace, a.number).await?);
        match &thread {
            Thread::Pull(repo, pull) => {
                check!(writable(repo));
                if a.verdict.is_some() && pull.is_owned_by(&a.actor.id) {
                    return Ok(Outcome::fail(
                        FailureCode::Forbidden,
                        "You cannot approve or request changes on your own pull request.",
                    ));
                }
            }
            Thread::Item(held) => {
                check!(held.allowed(Some(&a.actor), Capability::Participate));
                if path.is_some() || a.verdict.is_some() {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        "Only a pull request can be reviewed or commented on by line.",
                    ));
                }
            }
        }

        let now = now_ms();
        // A session g1t started for someone writes as g1t, for them.
        let by = rows::By::from(&a.actor);
        let comment = Comment {
            kind: CommentKind::Comment,
            id: new_id("cmt", now),
            author: if by.id == a.actor.id { a.actor.clone() } else { rows::user(by.id.to_owned(), by.name.to_owned()) },
            body: body.to_owned(),
            path: path.map(str::to_owned),
            line,
            verdict: a.verdict,
            created_at: rfc3339(now),
            edited_at: None,
            agent: None,
            acting_for: by.acting_for.map(|(id, name)| rows::user(id.to_owned(), name.to_owned())),
            advisory: false,
            reactions: Vec::new(),
        };
        let (repo_id, number, item_id) = match thread.on() {
            On::Pull(repo_id, number) => (JsValue::from(repo_id), JsValue::from(number), JsValue::NULL),
            On::Item(item_id) => (JsValue::NULL, JsValue::NULL, JsValue::from(item_id)),
        };
        let touched = match &thread {
            Thread::Pull(_, pull) => self
                .db
                .prepare("UPDATE pulls SET updated_at = ? WHERE id = ?")
                .bind(&[comment.created_at.as_str().into(), pull.id.as_str().into()])?,
            Thread::Item(held) => items::stamp(self, &held.item.id, &comment.created_at)?,
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO comments
                           (id, repo_id, number, item_id, author_id, author_name, body, path, line,
                            verdict, created_at, acting_for_id, acting_for_name)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        comment.id.as_str().into(),
                        repo_id,
                        number,
                        item_id,
                        by.id.into(),
                        by.name.into(),
                        body.into(),
                        optional(&comment.path),
                        optional_number(line),
                        a.verdict
                            .map_or(JsValue::NULL, |verdict| verdict.as_str().into()),
                        comment.created_at.as_str().into(),
                        by.acting_for.map_or(JsValue::NULL, |(id, _)| id.into()),
                        by.acting_for.map_or(JsValue::NULL, |(_, name)| name.into()),
                    ])?,
                touched,
            ])
            .await?;
        self.publish_thread(
            "comment.created",
            &thread,
            &a.actor,
            CommentCreated {
                comment_id: comment.id.clone(),
                on: thread.comment_on(),
                verdict: a.verdict,
                ..CommentCreated::default()
            },
        )
        .await?;
        // An approval is a decision: a person's is approved.
        if let Thread::Pull(repo, pull) = &thread
            && a.verdict == Some(Verdict::Approve)
        {
            let said = if body.is_empty() { String::new() } else { format!(": {}", body.chars().take(300).collect::<String>()) };
            self.keep_decision_quietly(
                &repo.id,
                decisions::NewDecision {
                    item: self.pull_item_id(&pull.id).await?,
                    pull: Some(a.number),
                    session_id: None,
                    actor: Some(&a.actor),
                    kind: g1t_contracts::decisions::DecisionKind::Approval,
                    confidence: decisions::approval_confidence(&a.actor),
                    summary: format!("{} approved #{}{said}", a.actor.username, a.number),
                    evidence: serde_json::json!({ "comment": comment.id }),
                },
            )
            .await;
        }
        Ok(Outcome::Ok(comment))
    }

    /// Publishes an event about a thread, filed under its repository.
    pub(crate) async fn publish_thread<T: Serialize>(&self, kind: &'static str, thread: &Thread, actor: &User, data: T) -> Result<()> {
        match thread.event_repo() {
            Some(repo_id) => self.publish(kind, repo_id, actor, data).await,
            None => {
                let data = g1t_contracts::events::marked(data, Some(actor));
                self.publish_on(kind, None, Some(actor.id.clone()), data).await
            }
        }
    }

    /// A comment, with the thread it is on, when `actor` may edit it, or
    /// with `deleting`, delete it (`may_change_comment`).
    async fn changeable_comment(&self, a: &CommentActionArgs, deleting: bool) -> Result<Outcome<(Thread, CommentRow)>> {
        let actor = Some(a.actor.clone());
        let id = a.comment_id.trim();
        let not_found = || Ok(Outcome::fail(FailureCode::NotFound, "Comment not found."));
        let (thread, row) = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &actor).await?);
                check!(writable(&repo));
                let found = self
                    .db
                    .prepare("SELECT * FROM comments WHERE id = ? AND repo_id = ?")
                    .bind(&[id.into(), repo.id.as_str().into()])?
                    .first::<CommentRow>(None)
                    .await?;
                let Some(row) = found else { return not_found() };
                let Some(pull) = self.pull(&repo.id, row.number.unwrap_or_default()).await? else { return not_found() };
                (Thread::Pull(repo, pull), row)
            }
            None => {
                let found = self
                    .db
                    .prepare("SELECT * FROM comments WHERE id = ? AND item_id IS NOT NULL")
                    .bind(&[id.into()])?
                    .first::<CommentRow>(None)
                    .await?;
                let Some(row) = found else { return not_found() };
                let held = match row.item_id.as_deref() {
                    Some(item_id) => items::by_id(self, item_id).await?,
                    None => None,
                };
                let Some(held) = held.filter(|held| held.item.workspace == items::workspace_of(&a.workspace, None)) else {
                    return not_found();
                };
                if !held.may(actor.as_ref(), Capability::Read) {
                    return not_found();
                }
                (Thread::Item(held), row)
            }
        };
        let maintains = thread.may(&a.actor, Capability::ManageSettings);
        // What an agent wrote as itself is answered for by whoever it acted for.
        let author_id = row.answerable_id().to_owned();
        if let Err(refusal) = may_change_comment(
            row.kind,
            row.has_verdict(),
            &author_id,
            &a.actor.id,
            maintains,
            deleting,
        ) {
            // Someone who may change it otherwise was refused for what it is.
            let code = if author_id == a.actor.id || maintains { FailureCode::Conflict } else { FailureCode::Forbidden };
            return Ok(Outcome::fail(code, refusal));
        }
        Ok(Outcome::Ok((thread, row)))
    }

    /// Changes the text of a comment: its author's to do, or a
    /// maintainer's. Publishes `comment.edited` with what it said before.
    async fn edit_comment(&self, a: CommentActionArgs) -> Result<Outcome<Comment>> {
        let body = a.body.trim().to_owned();
        if body.chars().count() > MAX_ENTRY_CHARS {
            return Ok(Outcome::fail(FailureCode::Invalid, "That comment is too long."));
        }
        let (thread, row) = check!(self.changeable_comment(&a, false).await?);
        // An approval speaks for itself; anything else has to say something.
        if body.is_empty() && row.verdict != Some(Verdict::Approve) && row.agent_verdict.as_deref() != Some("approve") {
            return Ok(Outcome::fail(FailureCode::Invalid, "A comment cannot be empty."));
        }
        let mut comment = Comment::from(row);
        if comment.body == body {
            return Ok(Outcome::Ok(comment));
        }
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?")
            .bind(&[body.as_str().into(), now.as_str().into(), comment.id.as_str().into()])?
            .run()
            .await?;
        let before = std::mem::replace(&mut comment.body, body);
        comment.edited_at = Some(now);
        self.publish_thread(
            "comment.edited",
            &thread,
            &a.actor,
            CommentEdited {
                comment_id: comment.id.clone(),
                on: thread.comment_on(),
                changes: CommentChanges { body: ChangedFrom { from: before } },
            },
        )
        .await?;
        Ok(Outcome::Ok(comment))
    }

    /// Deletes a comment: its author's to do, or a maintainer's. A review
    /// that gave a verdict stays. Publishes `comment.deleted` with the
    /// comment as it was.
    async fn delete_comment(&self, a: CommentActionArgs) -> Result<Outcome<bool>> {
        let (thread, row) = check!(self.changeable_comment(&a, true).await?);
        self.db
            .prepare("DELETE FROM comments WHERE id = ?")
            .bind(&[row.id.as_str().into()])?
            .run()
            .await?;
        self.db.prepare("DELETE FROM reactions WHERE subject = ?").bind(&[row.id.as_str().into()])?.run().await?;
        let comment = Comment::from(row);
        self.publish_thread(
            "comment.deleted",
            &thread,
            &a.actor,
            CommentDeleted {
                comment_id: comment.id.clone(),
                on: thread.comment_on(),
                comment: DeletedComment {
                    id: comment.id,
                    body: comment.body,
                    author: (&comment.author).into(),
                    created_at: comment.created_at,
                    path: comment.path,
                    line: comment.line,
                },
            },
        )
        .await?;
        Ok(Outcome::Ok(true))
    }

    // --- Pull requests -----------------------------------------------------

    async fn open_pull(&self, a: OpenPullArgs) -> Result<Outcome<Pull>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        let workspace = repo.namespace.to_lowercase();
        // A work item of the repository's workspace, which the actor can see.
        let item = match a.item {
            Some(number) => match items::for_viewer(self, &Some(a.actor.clone()), &workspace, number, Capability::Read).await? {
                Outcome::Ok(held) if held.item.state == State::Open => Some(held),
                Outcome::Ok(_) => {
                    return Ok(Outcome::fail(FailureCode::Conflict, "This work item is closed."));
                }
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => None,
        };
        // A pull request for a work item takes its title unless given one.
        let title = match (a.title.trim(), &item) {
            ("", Some(held)) => held.item.title.clone(),
            (title, _) => match valid_title(title) {
                Ok(title) => title.to_owned(),
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            },
        };
        // Unnamed, the change is its author's, unless an agent opened it.
        let agent = match a.agent.trim() {
            "" if g1t_contracts::rules::is_agent(&a.actor) => "agent",
            "" => a.actor.username.as_str(),
            agent => agent,
        };
        let runtime = match a.runtime {
            Runtime::Hosted => "hosted",
            Runtime::External => "external",
        };

        let now = now_ms();
        let id = new_id("pr", now);
        let branch = a
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty());
        // A branch of someone's fork of the repository, rather than of the
        // repository itself (head_repo.rs).
        let head_repo = match &a.head_repo {
            Some(path) => {
                if branch.is_none() {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Say which branch of {}/{} holds the change.", path.namespace, path.name),
                    ));
                }
                check!(self.head_repo_for(path, &repo, &a.actor).await?)
            }
            None => None,
        };
        let head_path = head_repo.as_ref().map(|fork| RepoPath { namespace: fork.namespace.clone(), name: fork.name.clone() });
        // The branch it merges into: the default branch unless another is
        // asked for, which has to exist.
        let base = a.base.as_deref().and_then(|base| stored_base(base, &repo));
        if let Some(base) = &base {
            if head_repo.is_none() && branch == Some(base.as_str()) {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("A pull request cannot merge {base} into itself. Choose another base."),
                ));
            }
            let exists: Option<String> = g1t_kit::call(
                &self.repos,
                "head",
                &HeadArgs { repo_id: repo.id.clone(), branch: base.clone() },
            )
            .await?;
            if exists.is_none() {
                return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no branch named {base} to merge into.")));
            }
        }
        let base_name = base.clone().unwrap_or_else(|| repo.default_branch.clone());
        // The change is on a branch already pushed to the repository or to
        // a fork of it, or will be made in a fork created for this pull
        // request.
        let head_repo_id = head_repo.as_ref().map(|fork| fork.id.clone());
        let (fork, head) = match branch {
            Some(branch) => {
                let source = head_repo::source_label(head_path.as_ref(), branch);
                // A fork's branch may share the base's name: it is another
                // repository's.
                if head_repo.is_none() && branch == base_name {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Choose a branch other than {branch}."),
                    ));
                }
                let head: Option<String> = g1t_kit::call(
                    &self.repos,
                    "head",
                    &HeadArgs {
                        repo_id: head_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                        branch: branch.to_owned(),
                    },
                )
                .await?;
                let Some(head) = head else {
                    return Ok(Outcome::fail(
                        FailureCode::NotFound,
                        format!("There is no branch named {source}. Push it first."),
                    ));
                };
                // One open pull request for each branch (of the repository
                // or of one fork) and base.
                let existing = self
                    .db
                    .prepare(head_repo::OPEN_FROM_BRANCH)
                    .bind(&[repo.id.as_str().into(), branch.into(), optional(&head_repo_id), optional(&base)])?
                    .first::<NumberRow>(None)
                    .await?;
                if let Some(existing) = existing {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        format!("Pull request #{} is already open from {source} into {base_name}.", existing.n),
                    ));
                }
                (None, Some(head))
            }
            None => {
                let fork: Outcome<Repo> = g1t_kit::call(
                    &self.repos,
                    "fork_for_pull",
                    &ForkArgs {
                        source_id: repo.id.clone(),
                        pull_id: id.clone(),
                        actor: a.actor.clone(),
                    },
                )
                .await?;
                (Some(check!(fork)), None)
            }
        };
        // A branch already holds the work, so its pull request is ready for
        // review from the start; one with a fork starts as a draft.
        // Asked for as a draft, it waits until it is marked ready.
        let status = if branch.is_some() && !a.draft { "open" } else { "draft" };
        let body = Some(a.body.trim().to_owned()).filter(|body| !body.is_empty());

        // Numbered in the workspace, never as one of this repository's are.
        items::remember_repo(self, &repo).await?;
        let number = items::next_number(self, &workspace, Some(&repo.id)).await?;
        let timestamp = rfc3339(now);
        let (author, requested_by) = authorship(&a.actor);
        // The work items it says it closes and is part of (closing.rs).
        let item_id = item.as_ref().map(|held| held.item.id.clone());
        let named =
            items::named(self, &repo, item_id.as_deref(), &format!("{title}\n{}", body.as_deref().unwrap_or_default()), &[&a.actor]).await?;
        self.db
            .prepare(
                "INSERT INTO pulls
                   (id, repo_id, number, item_id, title, body, agent, runtime,
                    status, fork_repo_id, fork_namespace, fork_name, source_branch, head_commit,
                    author_id, author_name, requested_by_id, requested_by_name, created_at, updated_at,
                    base_branch, head_repo_id, head_namespace, head_name, closes_items, parts)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                optional(&item_id),
                title.into(),
                optional(&body),
                agent.into(),
                runtime.into(),
                status.into(),
                optional(&fork.as_ref().map(|fork| fork.id.clone())),
                optional(&fork.as_ref().map(|fork| fork.namespace.clone())),
                optional(&fork.as_ref().map(|fork| fork.name.clone())),
                optional(&branch.map(str::to_owned)),
                optional(&head),
                author.id.as_str().into(),
                author.username.as_str().into(),
                optional(&requested_by.as_ref().map(|user| user.id.clone())),
                optional(&requested_by.as_ref().map(|user| user.username.clone())),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
                optional(&base),
                optional(&head_repo_id),
                optional(&head_path.as_ref().map(|path| path.namespace.clone())),
                optional(&head_path.as_ref().map(|path| path.name.clone())),
                serde_json::to_string(&named.close_ids())?.into(),
                serde_json::to_string(&named.part_ids())?.into(),
            ])?
            .run()
            .await?;
        let Some(mut pull) = self.pull(&repo.id, number).await? else {
            return Ok(no_pull());
        };
        fill_base(&mut pull, &repo);
        // The work item hears of it, and links the repository it is in.
        if let Some(held) = &item {
            let text = format!("opened {}#{} for this", items::path_of(&repo), pull.number);
            items::note(self, &held.item.id, &a.actor, &text).await?;
            items::touch(self, held, &repo, &a.actor).await?;
        }
        // Its head and merge refs in the repository, before its events go out.
        self.keep_pull_refs(&pull).await;
        // A coding agent's commits make it that agent's (cloud_agents.rs).
        self.mark_agent_pull(&pull, None).await;
        self.publish(
            "pull.opened",
            &repo.id,
            &a.actor,
            PullEvent {
                agent: Some(pull.agent.clone()),
                base: pull.base.clone(),
                ..Self::pull_event(&pull)
            },
        )
        .await?;
        // Its code owners asked to review (codeowners.rs).
        self.refresh_code_owners(&pull).await;
        let pull = self.pull(&repo.id, number).await?.unwrap_or(pull);
        // A branch pushed before may overlap others from the start.
        self.announce_overlaps(&pull, Some(a.actor.id.clone())).await;
        Ok(Outcome::Ok(pull))
    }

    async fn list_pulls(&self, a: ListPullsArgs) -> Result<Outcome<Vec<Pull>>> {
        let filter = match a.state {
            Some(State::Open) => "AND status IN ('draft', 'open')",
            Some(State::Closed) => "AND status IN ('merged', 'closed')",
            None => "",
        };
        let label = a
            .label
            .map(|label| label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
            .filter(|label| !label.is_empty());
        let milestone = a.milestone;
        let before = a.before;
        let merged_since = a.merged_since.map(|at| at.trim().to_owned()).filter(|at| !at.is_empty());
        let read = |repo_id: String| {
            let label = label.clone();
            let merged_since = merged_since.clone();
            async move {
                let query = self
                    .db
                    .prepare(format!(
                        "SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id = ?1 {filter}
                           AND (?2 IS NULL OR EXISTS
                             (SELECT 1 FROM json_each(pulls.labels) WHERE json_each.value = ?2))
                           AND (?3 IS NULL OR milestone = ?3)
                           AND (?5 IS NULL OR number < ?5)
                           AND (?6 IS NULL OR (status = 'merged' AND merged_at >= ?6))
                         ORDER BY number DESC LIMIT ?4"
                    ))
                    .bind(&[
                        repo_id.into(),
                        optional(&label),
                        optional_number(milestone),
                        LIST_PAGE.into(),
                        optional_number(before),
                        optional(&merged_since),
                    ])?;
                self.timing.db(1, query.all()).await?.results::<PullRow>()
            }
        };
        let (repo, rows) = check!(self.repo_then(&a.repo, &a.viewer, read).await?);
        let base = a.base.map(|base| base.trim().to_owned()).filter(|base| !base.is_empty());
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| {
                    let mut pull = Pull::from(row);
                    fill_base(&mut pull, &repo);
                    pull
                })
                .filter(|pull| base.as_deref().is_none_or(|base| pull.base.as_deref() == Some(base)))
                .collect(),
        ))
    }

    /// `pulls_for_repos`: what `list_pulls` gives, open and closed, for many
    /// repositories at once: one access check with repos for all of them
    /// and one query, instead of two of each per repository.
    async fn pulls_for_repos(&self, a: PullsForReposArgs) -> Result<Vec<RepoPulls>> {
        let ids: Vec<String> = a.repo_ids.into_iter().take(MAX_PULLS_FOR_REPOS).collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let limit = a.limit.clamp(1, LIST_PAGE);
        // The rows are read beside the access check, for every id asked
        // about; those of repositories the viewer cannot read are dropped.
        let asked = serde_json::to_string(&ids)?;
        let check = ReadableArgs { ids, viewer: a.viewer };
        let readable = self.timing.rpc(g1t_kit::call_in::<_, Vec<Repo>>(&self.repos, "readable", &check, self.repos_session.as_deref()));
        let (readable, rows) = try_join(readable, self.timing.db(1, self.newest_pulls(asked, limit))).await?;
        if readable.is_empty() {
            return Ok(Vec::new());
        }
        let mut answer: Vec<RepoPulls> = readable
            .iter()
            .map(|repo| RepoPulls { repo_id: repo.id.clone(), open: Vec::new(), closed: Vec::new() })
            .collect();
        for pull in rows.into_iter().map(Pull::from) {
            let Some(entry) = answer.iter_mut().find(|entry| entry.repo_id == pull.repo_id) else {
                continue;
            };
            match pull.status {
                PullStatus::Draft | PullStatus::Open => entry.open.push(pull),
                PullStatus::Merged | PullStatus::Closed => entry.closed.push(pull),
            }
        }
        for entry in &mut answer {
            entry.open.sort_by_key(|pull| std::cmp::Reverse(pull.number));
            entry.closed.sort_by_key(|pull| std::cmp::Reverse(pull.number));
        }
        Ok(answer)
    }

    /// The newest `limit` of each repository's open (draft or open) and
    /// closed (merged or closed) pull requests, for the ids in `ids` (JSON).
    async fn newest_pulls(&self, ids: String, limit: u32) -> Result<Vec<PullRow>> {
        self.db
            .prepare(format!(
                "SELECT * FROM (
                   SELECT {PULL_COLUMNS}, ROW_NUMBER() OVER (
                     PARTITION BY pulls.repo_id, pulls.status IN ('draft', 'open') ORDER BY pulls.number DESC
                   ) AS place
                   FROM pulls WHERE pulls.repo_id IN (SELECT value FROM json_each(?1))
                 ) WHERE place <= ?2"
            ))
            .bind(&[ids.into(), limit.into()])?
            .all()
            .await?
            .results::<PullRow>()
    }

    async fn get_pull(&self, a: ViewArgs) -> Result<Outcome<PullDetail>> {
        let number = a.number;
        // Every row the page and the lifecycle read, in one batch started
        // beside the access check; the helpers below read from it.
        let namespace = a.repo.namespace.clone();
        let read = |repo_id: String| self.prefetch_pull(repo_id, namespace.clone(), number);
        let Outcome::Ok((repo, Some(found))) = self.repo_then(&a.repo, &a.viewer, read).await? else {
            return Ok(no_pull());
        };
        let Some(row) = found.first::<PullRow>(prefetch::Slot::Pull)? else {
            return Ok(no_pull());
        };
        let stored = found.first::<StoredBehind>(prefetch::Slot::Pull)?;
        // Its work item, as far as the viewer may see it.
        let item = found
            .held(prefetch::Slot::Item)?
            .filter(|held| held.may(a.viewer.as_ref(), Capability::Read))
            .map(|held| held.shown(a.viewer.as_ref()));
        let mut comments: Vec<Comment> =
            found.rows::<CommentRow>(prefetch::Slot::Comments)?.into_iter().map(Comment::from).collect();
        let reactions = reactions::attach(&found.rows::<reactions::ReactionRow>(prefetch::Slot::Reactions)?, &row.id, &mut comments);
        self.keep_prefetched(Some(found));
        let default_branch = repo.default_branch.clone();
        let detail = self.pull_detail(repo, Pull::from(row), item, comments, stored, &a.viewer).await;
        self.keep_prefetched(None);
        // The branch it merges into, named, for whoever reads it.
        Ok(match detail? {
            Outcome::Ok(mut detail) => {
                if detail.pull.base.as_deref().is_none_or(str::is_empty) {
                    detail.pull.base = Some(default_branch);
                }
                detail.reactions = reactions;
                Outcome::Ok(detail)
            }
            failed => failed,
        })
    }

    async fn pull_detail(
        &self,
        repo: Repo,
        mut pull: Pull,
        item: Option<WorkItem>,
        comments: Vec<Comment>,
        stored: Option<StoredBehind>,
        viewer: &Viewer,
    ) -> Result<Outcome<PullDetail>> {
        // Whether it is behind, as worked out with its mergeability on the
        // last push to either side (mergeability.rs), when that was for
        // its head as it is now; otherwise asked of the repos service.
        let known_behind = stored.and_then(|stored| stored.for_head(pull.head_commit.as_deref()));
        // Worked out on each push; this covers a pull request from before
        // that was recorded.
        if pull.files.is_empty() && pull.head_commit.is_some() {
            pull.files = self.refresh_files(&pull).await?;
        }
        // Everything else at once: none of it depends on the rest, and each
        // is a round trip of its own.
        let standing = async {
            // Mergeability first: where g1t sees a pull request through, a
            // conflict decides its next step.
            let behind = async {
                match known_behind {
                    Some(behind) => Ok(behind),
                    None => {
                        let behind = self.is_behind(&pull).await?;
                        // Kept for the next view when the mergeability on
                        // record is for this head: a pull request from
                        // before `behind` was kept asks once.
                        if let Some(head) = pull.head_commit.as_deref()
                            && pull.status.is_active()
                        {
                            self.db
                                .prepare(
                                    "UPDATE pulls SET behind = ?1
                                     WHERE id = ?2 AND behind IS NULL AND mergeable_key LIKE ?3 || '..%'",
                                )
                                .bind(&[u32::from(behind).into(), pull.id.as_str().into(), head.into()])?
                                .run()
                                .await?;
                        }
                        Ok(behind)
                    }
                }
            };
            let (merge, behind) = try_join(self.mergeability(&pull), behind).await?;
            let lifecycle = self.assess(&pull, &item, behind).await?.map(|(lifecycle, _)| lifecycle);
            Ok::<_, worker::Error>((behind, lifecycle, merge))
        };
        let (((behind, lifecycle, (mergeable, conflicts)), (landing, stalled), comments), (checks, overlaps)) =
            try_join(
                try_join3(standing, self.landing_state(&pull.id), async { Ok(comments) }),
                try_join(self.latest_checks(&pull.id), self.overlaps(&pull)),
            )
            .await?;
        // The rules of the branch it merges into, as they stack, and which
        // of them it does not meet yet, for whoever is looking.
        let (statuses, settings, gate) = try_join3(
            self.statuses(&repo.id, pull.head_commit.as_deref()),
            self.settings_on(&repo, &pull),
            async {
                if pull.status.is_active() {
                    self.merge_gate_seen(&repo, &pull, viewer.as_ref(), behind).await.map(Some)
                } else {
                    Ok(None)
                }
            },
        )
        .await?;
        let code_owners = self.pull_code_owners(&pull, &comments, &settings).await?;
        // The work items it closes, as its title and description say now;
        // none where the repository does not close them that way.
        if pull.status.is_active() {
            let named = self.items_to_close(&pull, &repo, &settings, false, &[]).await?;
            pull.closes = named.close_numbers();
            pull.parts = named.part_numbers();
        }
        let required = if settings.required_checks.is_empty() {
            Vec::new()
        } else {
            let checked = self.with_job_checks(&repo.id, pull.head_commit.as_deref(), statuses.clone()).await?;
            required_checks(&settings.required_checks, &checked)
        };
        Ok(Outcome::Ok(PullDetail {
            required_checks: required,
            rules: gate.map(|gate| rulesets::merge_rules(&gate.judged, &gate.requirements, pull.base_branch(&repo.default_branch) == repo.default_branch)),
            code_owners,
            comments,
            checks,
            overlaps,
            behind,
            lifecycle,
            landing,
            stalled,
            statuses,
            mergeable,
            conflicts,
            earlier_checks: self.earlier_checks(&pull.id).await?,
            reactions: Vec::new(),
            item,
            pull,
        }))
    }

    /// The pull request, whatever its status, if its repository is not
    /// archived and `actor` opened it or may triage its pull requests.
    async fn managed_pull(
        &self,
        actor: &User,
        path: &RepoPath,
        number: u32,
    ) -> Result<Outcome<Pull>> {
        let (repo, pull) = check!(self.pull_at(path, number, &Some(actor.clone())).await?);
        check!(writable(&repo));
        if !pull.is_owned_by(&actor.id) {
            check!(allowed(Some(actor), &repo, Capability::Triage));
        }
        Ok(Outcome::Ok(pull))
    }

    /// The pull request, if it is still active and `actor` opened it or
    /// may triage the repository's pull requests.
    async fn manageable_pull(
        &self,
        actor: &User,
        path: &RepoPath,
        number: u32,
    ) -> Result<Outcome<Pull>> {
        let pull = check!(self.managed_pull(actor, path, number).await?);
        if !pull.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This pull request is already {}.", pull.status.as_str()),
            ));
        }
        Ok(Outcome::Ok(pull))
    }

    /// Brings a pull request up to date with the default branch without a
    /// sandbox, where the repos service can do that safely. Whoever could
    /// have pushed the merge themselves may ask: whoever opened it (or asked
    /// g1t for it), for a fork; anyone who may push, for a branch of the
    /// repository. When it needs a
    /// real merge, says so, naming the conflicting files if a probe found
    /// them, and pushes nothing.
    async fn catch_up_pull(&self, a: PullActionArgs) -> Result<Outcome<PullBranchUpdate>> {
        let (repo, pull) = check!(self.pull_at(&a.repo, a.number, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        if !pull.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This pull request is already {}.", pull.status.as_str()),
            ));
        }
        if pull.fork_repo_id.is_some() {
            if !pull.is_owned_by(&a.actor.id) {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "Only whoever opened this pull request, or asked g1t for it, can update it.",
                ));
            }
        } else if !pull.from_head_repo() {
            check!(allowed(Some(&a.actor), &repo, Capability::Push));
        }
        // A fork's branch is updated by those who may push to the fork,
        // which repos decides.
        let updated: Outcome<PullBranchUpdate> = g1t_kit::call(
            &self.repos,
            "update_pull_branch",
            &UpdatePullBranchArgs {
                source_id: pull.source_id().to_owned(),
                branch: pull.branch.clone(),
                number: pull.number,
                actor: a.actor,
                target_branch: pull.base.clone(),
                target_id: pull.target_id(),
                method: a.update_method.unwrap_or_default(),
                expected_head: a.expected_head.clone().filter(|head| !head.trim().is_empty()),
            },
        )
        .await?;
        // A probe that found conflicts says more than "both changed it".
        if let Outcome::Ok(PullBranchUpdate::NeedsAgent { .. }) = &updated
            && let Some(files) = self.conflicting_files(&pull).await?
            && !files.is_empty()
        {
            return Ok(Outcome::Ok(PullBranchUpdate::NeedsAgent {
                reason: NeedsAgentReason::Conflicting,
                detail: "Merging it conflicts.".to_owned(),
                paths: files,
            }));
        }
        Ok(updated)
    }

    async fn update_pull(&self, a: UpdatePullArgs) -> Result<Outcome<Pull>> {
        let edit = match pull_edits::Edit::asked(a.title.as_deref(), a.body.as_deref(), a.item) {
            Ok(edit) => edit,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let others = a.assignees.is_some() || a.reviewers.is_some() || a.labels.is_some() || a.milestone.is_some() || a.base.is_some();
        // A merged or closed pull request's title and description can still
        // be corrected (pull_edits.rs); everything else needs it active.
        let pull = if !others && !edit.is_empty() && edit.text_only() {
            check!(self.managed_pull(&a.actor, &a.repo, a.number).await?)
        } else {
            check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?)
        };
        // Its title, description and work item checked first, like the
        // rest: anything refused, and nothing changes.
        let edit = check!(self.ready_pull_edit(&a.actor, &a.repo, &pull, edit).await?);
        // The branch it merges into, its milestone and its labels first:
        // each can be refused, and then nothing else changes.
        if a.base.is_some() || a.milestone.is_some() || a.labels.is_some() {
            let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
            if let Some(base) = &a.base {
                check!(self.change_base(&a.actor, &repo, &pull, base).await?);
            }
            if let Some(number) = a.milestone {
                check!(items::set_milestone(self, &a.actor, &items::Labeled::Pull(repo.clone(), pull.clone()), number).await?);
            }
            if let Some(labels) = &a.labels {
                check!(items::relabel(self, &a.actor, &items::Labeled::Pull(repo.clone(), pull.clone()), labels).await?);
            }
        }
        let assignees = match a.assignees {
            Some(names) => Some(check!(self.valid_assignees(names).await?)),
            None => None,
        };
        // Teams, named `workspace/team`, apart from the people.
        let (team_names, a_reviewers) = match a.reviewers {
            Some(names) => {
                let (teams, people): (Vec<String>, Vec<String>) =
                    names.into_iter().partition(|name| team_reviews::team_name(name).is_some());
                (Some(teams), Some(people))
            }
            None => (None, None),
        };
        let teams = match team_names {
            Some(names) => Some(check!(self.valid_team_reviewers(&a.actor, &a.repo, &pull, names).await?)),
            None => None,
        };
        let reviewers = match a_reviewers {
            Some(names) => {
                let mut reviewers = check!(self.valid_assignees(names).await?);
                // Nobody is asked to review their own, nor what they had g1t make.
                reviewers.retain(|name| *name != pull.owner().username);
                Some(reviewers)
            }
            None => None,
        };
        if let Some(edit) = edit {
            self.make_pull_edit(&a.actor, &pull, edit).await?;
        }
        self.db
            .prepare(
                "UPDATE pulls
                 SET assignees = COALESCE(?, assignees), updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&assignees.as_ref().map(serde_json::to_string).transpose()?),
                rfc3339(now_ms()).into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        if let Some(assignees) = &assignees {
            self.note_changes(
                On::Pull(&pull.repo_id, pull.number),
                &a.actor,
                &pull.assignees,
                assignees,
                ("assigned", "unassigned"),
            )
            .await?;
        }
        // Who was newly assigned or asked to review, and whose request was
        // withdrawn: the inbox tells them, and webhooks say so.
        let newly = |after: &[String], before: &[String]| -> Vec<String> {
            after.iter().filter(|name| !before.contains(name)).cloned().collect()
        };
        if let Some(assignees) = &assignees {
            let added = newly(assignees, &pull.assignees);
            if !added.is_empty() {
                self.publish(
                    "pull.assigned",
                    &pull.repo_id,
                    &a.actor,
                    PullEvent {
                        assignees: Some(assignees.clone()),
                        added: Some(added),
                        ..Self::pull_event(&pull)
                    },
                )
                .await?;
            }
        }
        if reviewers.is_some() || teams.is_some() {
            let people = reviewers.unwrap_or_else(|| pull.reviewers.clone());
            let teams = teams.unwrap_or_else(|| pull.team_reviewers.clone());
            self.set_reviewers(&pull, people, teams, Some(&a.actor), false).await?;
        }
        Ok(match self.pull(&pull.repo_id, pull.number).await? {
            Some(pull) => Outcome::Ok(pull),
            None => no_pull(),
        })
    }

    /// Points an open pull request at another branch to merge into. Needs
    /// the Write role. What it would merge, whether it is behind, its
    /// mergeability and its checks are all worked out against the new base.
    async fn change_base(&self, actor: &User, repo: &Repo, pull: &Pull, base: &str) -> Result<Outcome<()>> {
        check!(allowed(Some(actor), repo, Capability::Push));
        let base = base.trim();
        if base.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the branch it should merge into."));
        }
        let before = pull.base_branch(&repo.default_branch).to_owned();
        if base == before {
            return Ok(Outcome::Ok(()));
        }
        if !pull.from_other_repo() && pull.branch.as_deref() == Some(base) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A pull request cannot merge {base} into itself. Choose another base."),
            ));
        }
        let exists: Option<String> = g1t_kit::call(
            &self.repos,
            "head",
            &HeadArgs { repo_id: repo.id.clone(), branch: base.to_owned() },
        )
        .await?;
        if exists.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no branch named {base} to merge into.")));
        }
        // In the merge queue it was headed for the default branch; it
        // leaves the queue for another base.
        let left_queue = self
            .leave(&pull.repo_id, pull, QueueState::Removed, Some("Its base branch changed."))
            .await?;
        // Its tested commit is being published to the default branch: a new
        // base would describe a merge that is not the one taking place.
        if !left_queue && self.publishing(&pull.id).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, "This pull request is being published. Wait for landing to finish."));
        }
        let stored = stored_base(base, repo);
        self.db
            .prepare(
                "UPDATE pulls
                 SET base_branch = ?, updated_at = ?, land_requested = NULL, land_requested_at = NULL, behind = NULL,
                     mergeable = NULL, mergeable_key = NULL, conflicts = NULL
                 WHERE id = ?",
            )
            .bind(&[optional(&stored), rfc3339(now_ms()).into(), pull.id.as_str().into()])?
            .run()
            .await?;
        self.note(
            &pull.repo_id,
            pull.number,
            actor,
            &format!("changed the base branch from `{before}` to `{base}`"),
        )
        .await?;
        self.publish(
            "pull.base_changed",
            &pull.repo_id,
            actor,
            PullEvent { base: Some(base.to_owned()), ..Self::pull_event(pull) },
        )
        .await?;
        if left_queue {
            self.publish_as(
                "queue.changed",
                &pull.repo_id,
                None,
                g1t_contracts::events::QueueChanged { repo_id: pull.repo_id.clone() },
            )
            .await?;
        }
        // Its merge ref, and whether it merges cleanly, against the new base.
        if let Some(moved) = self.pull_by_id(&pull.id).await? {
            self.keep_pull_refs(&moved).await;
            if let Err(error) = self.assess_mergeability(&moved).await {
                worker::console_warn!("mergeability of {}: {error}", pull.id);
            }
        }
        Ok(Outcome::Ok(()))
    }

    /// Marks a draft ready for review, or updates the description of one
    /// that already is.
    async fn ready_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let mut pull = check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?);
        let summary = Some(a.summary.trim().to_owned()).filter(|summary| !summary.is_empty());
        let now = rfc3339(now_ms());
        // The work items it closes and is part of, as its description says
        // now (closing.rs).
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        let own = self.pull_item_id(&pull.id).await?;
        let text = format!("{}\n{}", pull.title, summary.as_deref().or(pull.body.as_deref()).unwrap_or_default());
        let named = items::named(self, &repo, own.as_deref(), &text, &[&a.actor]).await?;
        self.db
            .prepare(
                "UPDATE pulls SET status = 'open', body = COALESCE(?, body), updated_at = ?, closes_items = ?, parts = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&summary),
                now.as_str().into(),
                serde_json::to_string(&named.close_ids())?.into(),
                serde_json::to_string(&named.part_ids())?.into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        if pull.status == PullStatus::Draft {
            // The head as it is now: the push that came just before may not
            // have reached `head_commit` yet, and workflows run on it.
            let commit = self.live_head(&pull).await?.or_else(|| pull.head_commit.clone());
            self.publish(
                "pull.ready",
                &pull.repo_id,
                &a.actor,
                PullEvent {
                    commit,
                    ..Self::pull_event(&pull)
                },
            )
            .await?;
        }
        if pull.status == PullStatus::Draft {
            self.note(
                &pull.repo_id,
                pull.number,
                &a.actor,
                "marked this ready for review",
            )
            .await?;
        }
        pull.status = PullStatus::Open;
        pull.body = summary.or(pull.body);
        pull.closes = named.close_numbers();
        pull.parts = named.part_numbers();
        pull.updated_at = now;
        // A draft's code owners are asked once it is ready.
        self.refresh_code_owners(&pull).await;
        if let Some(fresh) = self.pull(&pull.repo_id, pull.number).await? {
            pull.reviewers = fresh.reviewers;
            pull.team_reviewers = fresh.team_reviewers;
        }
        Ok(Outcome::Ok(pull))
    }

    async fn close_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let mut pull = check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?);
        let now = rfc3339(now_ms());
        let closed = self.db
            // What it was closed as, so that reopening brings that back.
            .prepare("UPDATE pulls SET status = 'closed', closed_from = ?, updated_at = ?, auto_merge = NULL WHERE id = ? AND status <> 'merged'
                AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.pull_id = pulls.id AND q.state = 'passed' AND q.landing_commit IS NOT NULL)
                RETURNING id AS value")
            .bind(&[pull.status.as_str().into(), now.as_str().into(), pull.id.as_str().into()])?
            .first::<rows::ValueRow>(None)
            .await?;
        if closed.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This pull request is being published or has already merged."));
        }
        self.publish(
            "pull.closed",
            &pull.repo_id,
            &a.actor,
            Self::pull_event(&pull),
        )
        .await?;
        self.note(
            &pull.repo_id,
            pull.number,
            &a.actor,
            "closed this",
        )
        .await?;
        // A closed pull request leaves the merge queue.
        if self
            .leave(&pull.repo_id, &pull, QueueState::Removed, Some("It was closed."))
            .await?
        {
            self.publish_as(
                "queue.changed",
                &pull.repo_id,
                None,
                g1t_contracts::events::QueueChanged {
                    repo_id: pull.repo_id.clone(),
                },
            )
            .await?;
        }
        pull.status = PullStatus::Closed;
        pull.auto_merge = None;
        pull.updated_at = now;
        Ok(Outcome::Ok(pull))
    }

    /// Opens a closed pull request again: as the draft it was, if it was
    /// closed as one, else ready for review. A merged one stays merged.
    async fn reopen_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let mut pull = check!(self.managed_pull(&a.actor, &a.repo, a.number).await?);
        if let Some(refusal) = reopen_refusal(pull.status) {
            return Ok(Outcome::fail(FailureCode::Conflict, refusal));
        }
        // The head as it is now, which workflows run on. A branch of the
        // repository that was deleted since leaves nothing to reopen; a
        // fork removed after the close is made again (repos, `pull.reopened`).
        let head = self.live_head(&pull).await?;
        if head.is_none() && pull.fork_repo_id.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!(
                    "The branch {} no longer exists. Push it again to reopen this pull request.",
                    head_repo::source_label(pull.head_repo.as_ref(), pull.branch.as_deref().unwrap_or_default())
                ),
            ));
        }
        let closed_from: Option<ClosedFrom> = self
            .db
            .prepare("SELECT closed_from FROM pulls WHERE id = ?")
            .bind(&[pull.id.as_str().into()])?
            .first(None)
            .await?;
        let status = reopened_status(closed_from.and_then(|row| row.closed_from).as_deref());
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE pulls SET status = ?, closed_from = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?")
            .bind(&[status.as_str().into(), now.as_str().into(), pull.id.as_str().into()])?
            .run()
            .await?;
        self.publish(
            "pull.reopened",
            &pull.repo_id,
            &a.actor,
            PullEvent {
                commit: head.or_else(|| pull.head_commit.clone()),
                ..Self::pull_event(&pull)
            },
        )
        .await?;
        self.note(
            &pull.repo_id,
            pull.number,
            &a.actor,
            "reopened this",
        )
        .await?;
        pull.status = status;
        pull.superseded_by = None;
        pull.updated_at = now;
        // Its refs in the repository, and whether it still merges cleanly,
        // now that it is open again.
        self.keep_pull_refs(&pull).await;
        if let Err(error) = self.assess_mergeability(&pull).await {
            worker::console_warn!("mergeability of {}: {error}", pull.id);
        }
        Ok(Outcome::Ok(pull))
    }

    /// Turns a pull request that is ready for review back into a draft: it
    /// cannot be merged until it is marked ready again, and it leaves the
    /// merge queue and any merge that was waiting for it to catch up.
    async fn convert_pull_to_draft(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let mut pull = check!(self.managed_pull(&a.actor, &a.repo, a.number).await?);
        if let Some(refusal) = draft_refusal(pull.status) {
            return Ok(Outcome::fail(FailureCode::Conflict, refusal));
        }
        let now = rfc3339(now_ms());
        let drafted = self.db
            .prepare(
                "UPDATE pulls SET status = 'draft', land_requested = NULL, land_requested_at = NULL, updated_at = ?
                 WHERE id = ? AND status = 'open'
                   AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.pull_id = pulls.id AND q.state = 'passed' AND q.landing_commit IS NOT NULL)
                 RETURNING id AS value",
            )
            .bind(&[now.as_str().into(), pull.id.as_str().into()])?
            .first::<rows::ValueRow>(None)
            .await?;
        if drafted.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This pull request changed or is already being published."));
        }
        self.publish(
            "pull.converted_to_draft",
            &pull.repo_id,
            &a.actor,
            Self::pull_event(&pull),
        )
        .await?;
        self.note(
            &pull.repo_id,
            pull.number,
            &a.actor,
            "marked this as a draft",
        )
        .await?;
        if self
            .leave(&pull.repo_id, &pull, QueueState::Removed, Some("It was marked as a draft."))
            .await?
        {
            self.publish_as(
                "queue.changed",
                &pull.repo_id,
                None,
                g1t_contracts::events::QueueChanged {
                    repo_id: pull.repo_id.clone(),
                },
            )
            .await?;
        }
        pull.status = PullStatus::Draft;
        pull.updated_at = now;
        Ok(Outcome::Ok(pull))
    }

    /// Lands the pull request on the branch it merges into, by the method
    /// asked for or the repository's default (merging.rs). Unless told to
    /// keep them open, a merge into the default branch lands the work items
    /// it closes in this repository: its own and those it names
    /// (closing.rs), each closing once nothing else is left to land, and
    /// the others still in progress here for its own close as superseded.
    async fn merge_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let viewer = Some(a.actor.clone());
        let (repo, pull) = check!(self.pull_at(&a.repo, a.number, &viewer).await?);
        check!(writable(&repo));
        match pull.status {
            PullStatus::Open => {}
            PullStatus::Draft => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "This pull request is still a draft. Mark it ready for review first.",
                ));
            }
            status => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("This pull request is already {}.", status.as_str()),
                ));
            }
        }
        // Whoever looked at one head merges that one.
        if let Some(expected) = a.expected_head.as_deref().map(str::trim).filter(|head| !head.is_empty())
            && pull.head_commit.as_deref() != Some(expected)
        {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request has new commits since you looked. Review them, then merge again.",
            ));
        }
        let base = pull.base_branch(&repo.default_branch).to_owned();
        // How it merges: as asked, or the repository's default, where the
        // repository and the rules for its base allow it.
        let (choosing, requirements) = self.settings_and_requirements(&repo, &pull).await?;
        let method = match merging::choose_method(a.merge_method, &choosing, &requirements, &base) {
            Ok(method) => method,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        // The rules of the branch it merges into, as they stack: the one
        // gate for the merge button, the API, MCP, auto-merge and the queue,
        // for a person's pull request and an agent's alike. A bypass counts
        // when the merger asks for it, or for g1t when a ruleset lists it.
        let gate = self.merge_gate_by(&repo, &pull, Some(&a.actor), a.ignore_checks, true, method).await?;
        let bypassable = gate.bypassable();
        let gate = if a.bypass_rules || a.actor.is_system() { gate } else { gate.without_bypass() };
        let settings = rulesets::overlay(self.settings(&repo.id).await?, &gate.requirements, base == repo.default_branch);
        if pull.check_status == Some(CheckStatus::Failed) && !(a.ignore_checks && settings.allow_ignoring_checks) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "It failed in the merge queue; push a fix to try again.",
            ));
        }
        if let Some(refusal) = gate.refusal() {
            if access::can(Some(&a.actor), &repo, Capability::Merge) {
                self.record_merge_evaluations(&repo, &pull, &gate).await;
            }
            let offer = if bypassable && !a.bypass_rules {
                " You may bypass these rules: merge again and ask to bypass them (bypass_rules)."
            } else {
                ""
            };
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{refusal}{offer}")));
        }
        // Known ahead of time to conflict: neither a merge nor the queue
        // would get through, so say what has to be resolved now.
        if let Some(files) = self.conflicting_files(&pull).await? {
            let named = if files.is_empty() {
                String::new()
            } else {
                format!(" in {}", files.join(", "))
            };
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!(
                    "This branch has conflicts with {base}{named} that must be resolved first. Merge {base} into it, fix them and push."
                ),
            ));
        }

        // A repository that merges through a queue: it joins the queue, and
        // lands once its state together with everything ahead has passed.
        // Its state is built by the method asked for, else the merge queue
        // rule's, and lands exactly as tested (queue.rs).
        if settings.merge_queue {
            if !a.actor.verified {
                return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
            }
            check!(allowed(Some(&a.actor), &repo, Capability::Merge));
            let queued = match a.merge_method {
                Some(_) => method,
                None => {
                    let rule = self.queue_rule(&repo.id).await?;
                    match merging::choose_method(Some(rule.merge_method), &choosing, &requirements, &base) {
                        Ok(method) => method,
                        Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
                    }
                }
            };
            self.record_merge_evaluations(&repo, &pull, &gate).await;
            // Landing honours the same bypass request against the rules as
            // they are then (queue.rs `settle`).
            let message = (a.commit_title.as_deref(), a.commit_message.as_deref());
            return self.enqueue(&repo, &pull, &a.actor, a.keep_item_open, a.bypass_rules, queued, message).await;
        }

        // The commit it makes, for a merge or a squash: what the merger
        // wrote, over the repository's default.
        let message = match self
            .merge_message_for(&repo, &pull, &settings, method, a.commit_title.as_deref(), a.commit_message.as_deref())
            .await?
        {
            Ok(message) => message,
            Err(problem) => return Ok(Outcome::fail(FailureCode::Invalid, problem)),
        };

        // The branch it merges into has moved under it. A merge, squash or
        // rebase makes new commits on its head anyway; a fast-forward needs
        // it brought up to date first, and lands when that is done. Unless
        // the repository insists on that being dealt with first.
        let behind = self.is_behind(&pull).await?;
        match merging::when_behind(method, behind, settings.require_up_to_date, &base) {
            merging::WhenBehind::Land => {}
            merging::WhenBehind::Refuse(refusal) => return Ok(Outcome::fail(FailureCode::Conflict, refusal)),
            merging::WhenBehind::CatchUpFirst => {
                if !a.actor.verified {
                    return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
                }
                check!(allowed(Some(&a.actor), &repo, Capability::Merge));
                self.record_merge_evaluations(&repo, &pull, &gate).await;
                // Brought up to date here, without a sandbox: the merge is
                // recorded first, and lands once the push that catches it up
                // arrives and the required checks pass on that commit
                // (lifecycle.rs `land_if_requested`, `land_when_checked`).
                // Merging past failing checks, where that is allowed, carries
                // over: it then lands without waiting for them.
                self.request_landing(
                    &pull,
                    &a.actor,
                    a.keep_item_open,
                    a.delete_branch,
                    a.ignore_checks && settings.allow_ignoring_checks,
                )
                .await?;
                // Bounded: a repository that does not answer gets a clear
                // failure back to whoever clicked, not a request that hangs
                // until the site gives up on it.
                let updated: Option<Outcome<PullBranchUpdate>> = g1t_kit::call_within(
                    &self.repos,
                    "update_pull_branch",
                    &UpdatePullBranchArgs {
                        source_id: pull.source_id().to_owned(),
                        branch: pull.branch.clone(),
                        number: pull.number,
                        actor: a.actor.clone(),
                        target_branch: pull.base.clone(),
                        target_id: pull.target_id(),
                        // Linear history takes no merge commit on the way.
                        method: if requirements.linear_history { UpdateMethod::Rebase } else { UpdateMethod::Merge },
                        expected_head: pull.head_commit.clone(),
                    },
                    lifecycle::REPOS_WRITE_WITHIN,
                )
                .await?;
                // A push that still arrives later only brings it up to date.
                let updated = updated.unwrap_or_else(lifecycle::repository_unreachable);
                match updated {
                    Outcome::Ok(PullBranchUpdate::Updated { .. }) => return Ok(Outcome::Ok(pull)),
                    // Moved again in between, or already caught up: land it now.
                    Outcome::Ok(PullBranchUpdate::UpToDate { .. }) => self.forget_landing(&pull.id).await?,
                    Outcome::Ok(PullBranchUpdate::NeedsAgent { paths, .. }) => {
                        self.forget_landing(&pull.id).await?;
                        let named = if paths.is_empty() { String::new() } else { format!(" ({})", paths.join(", ")) };
                        return Ok(Outcome::fail(
                            FailureCode::Conflict,
                            format!(
                                "{base} has moved since this pull request was made, and both changed the same files{named}. Merge {base} into it, resolve any conflicts, push, and merge again."
                            ),
                        ));
                    }
                    // Only those who can push where its branch is can catch
                    // it up; anyone may merge it another way. A refusal of
                    // room, or of a repository being copied into a fork,
                    // says so as it came.
                    Outcome::Fail(failure) if merging::refused_the_pusher(&failure) => {
                        self.forget_landing(&pull.id).await?;
                        let source = pull.source_path(&a.repo);
                        return Ok(Outcome::fail(
                            FailureCode::Conflict,
                            merging::cannot_fast_forward(&base, &format!("{}/{}", source.namespace, source.name)),
                        ));
                    }
                    Outcome::Fail(failure) => {
                        self.forget_landing(&pull.id).await?;
                        return Ok(Outcome::Fail(failure));
                    }
                }
            }
        }

        // Whether the actor may write to the repository is decided by repos.
        let head = pull.head_commit.clone();
        // Bounded like the catch-up above. Landing the same checked commit
        // again is recognised as done (repos `land`), so trying again after
        // a land that finished late records it.
        let landed: Option<Outcome<Landed>> = g1t_kit::call_within(
            &self.repos,
            "land",
            &LandArgs {
                // A pull request from a branch lands from the repository
                // itself, or from the fork the branch is in.
                source_id: pull.source_id().to_owned(),
                branch: pull.branch.clone(),
                actor: a.actor.clone(),
                target_branch: Some(base.clone()),
                expected_commit: head.clone(),
                target_id: pull.target_id(),
                method: Some(method),
                message,
                author: merging::squash_author(&pull, method),
                sign_off: settings.require_web_commit_sign_off,
                pull: Some(pull.number),
            },
            lifecycle::REPOS_WRITE_WITHIN,
        )
        .await?;
        let landed = check!(landed.unwrap_or_else(lifecycle::repository_unreachable));
        self.record_merge_evaluations(&repo, &pull, &gate).await;
        let merged = self.record_merge(&repo, pull, &a.actor, a.keep_item_open, landed, None).await?;
        // Its branch, where the merger or the repository says it goes.
        if merged.status == PullStatus::Merged {
            self.delete_branch_after_merge(&repo, &merged, &a.actor, a.delete_branch, head).await?;
        }
        Ok(Outcome::Ok(self.pull_by_id(&merged.id).await?.unwrap_or(merged)))
    }

    /// Records a pull request as merged once the default branch holds it:
    /// lands the work items it closes (closing.rs), links those it is part
    /// of, supersedes the others for its own work item in this repository,
    /// and says so. `pushed` names the branch when a push brought its head
    /// in, rather than a merge from the site or the queue (pushed.rs).
    pub(crate) async fn record_merge(
        &self,
        repo: &Repo,
        mut pull: Pull,
        actor: &User,
        keep_item_open: bool,
        landed: Landed,
        pushed: Option<&str>,
    ) -> Result<Pull> {
        // Only a merge into the default branch lands work: into another
        // branch, it has not landed yet. Its own work item and those it
        // names land, where the repository closes them that way.
        let settings = self.settings(&repo.id).await?;
        // Only what whoever merges it, and whoever it is for, may close: an
        // outside collaborator's "Fixes #N" closes no work item they cannot see.
        let owner = self.pull_owner(&pull).await?;
        let mut who: Vec<&User> = vec![actor];
        who.extend(owner.as_ref().filter(|owner| owner.id != actor.id));
        let named = self.items_to_close(&pull, repo, &settings, keep_item_open, &who).await?;
        let own = self.pull_item_id(&pull.id).await?;
        // A fast-forward leaves the base at what was landed, which is its
        // head; the other methods leave its head as it was.
        let head = if landed.method == g1t_contracts::rules::MergeMethod::FastForward {
            Some(landed.commit.clone())
        } else {
            pull.head_commit.clone().or_else(|| Some(landed.commit.clone()))
        };
        let now = rfc3339(now_ms());
        let mut statements = vec![self
            .db
            .prepare(
                "UPDATE pulls
                 SET status = 'merged', head_commit = ?, merge_base = ?, merged_by = ?,
                     merged_at = ?, updated_at = ?, merge_method = ?, merge_commit = ?,
                     auto_merge = NULL, closes_items = ?, parts = ?
                 WHERE id = ? AND status <> 'merged' RETURNING id AS value",
            )
            .bind(&[
                optional(&head),
                optional(&landed.previous),
                actor.username.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
                landed.method.as_str().into(),
                landed.commit.as_str().into(),
                serde_json::to_string(&named.close_ids())?.into(),
                serde_json::to_string(&named.part_ids())?.into(),
                pull.id.as_str().into(),
            ])?];
        // The others for its own work item in this repository were other
        // ways to do the same thing.
        if let Some(own) = own.as_deref().filter(|own| named.close_ids().iter().any(|id| id == own)) {
            statements.push(
                self.db
                    .prepare(
                        "UPDATE pulls SET status = 'closed', superseded_by = ?, updated_at = ?
                         WHERE item_id = ? AND repo_id = ? AND id != ? AND status IN ('draft', 'open')",
                    )
                    .bind(&[pull.number.into(), now.as_str().into(), own.into(), repo.id.as_str().into(), pull.id.as_str().into()])?,
            );
        }
        let recorded = self.db.batch(statements).await?;
        if recorded.first().map(|result| result.results::<rows::ValueRow>()).transpose()?.is_none_or(|rows| rows.is_empty()) {
            return Ok(self.pull_by_id(&pull.id).await?.unwrap_or(pull));
        }

        self.publish(
            "pull.merged",
            &repo.id,
            actor,
            PullEvent {
                commit: Some(landed.commit.clone()),
                ..Self::pull_event(&pull)
            },
        )
        .await?;
        let who = (actor.id.as_str(), actor.username.as_str());
        let note = match pushed {
            Some(branch) => format!("merged this by pushing {} to {branch}", landed.commit),
            None => merging::merged_note(landed.method).to_owned(),
        };
        self.note(&repo.id, pull.number, who, &note).await?;
        let landing = items::Landing { pull: Some(pull.number), commit: None, pushed_by: None, tie: None };
        items::land(self, repo, &landing, actor, &named.close_ids(), &named.part_ids(), None, false).await?;
        let through_queue = self.landed_through_queue(&pull.id).await?;
        self.keep_decision_quietly(
            &repo.id,
            decisions::NewDecision {
                item: own.clone(),
                pull: Some(pull.number),
                session_id: None,
                actor: (!decisions::is_g1t(actor)).then_some(actor),
                kind: g1t_contracts::decisions::DecisionKind::Merge,
                confidence: decisions::merge_confidence(through_queue, actor),
                summary: match pushed {
                    _ if through_queue => format!("#{} landed through the merge queue.", pull.number),
                    Some(branch) => format!("{} merged #{} by pushing to {branch}.", actor.username, pull.number),
                    None => format!("{} merged #{}.", actor.username, pull.number),
                },
                evidence: serde_json::json!({
                    "commit": landed.commit,
                    "previous": landed.previous,
                    "method": landed.method,
                    "merge_queue": through_queue,
                    "pushed": pushed.is_some(),
                }),
            },
        )
        .await;
        pull.status = PullStatus::Merged;
        pull.head_commit = head;
        pull.merge_method = Some(landed.method);
        pull.merge_commit = Some(landed.commit.clone());
        pull.auto_merge = None;
        pull.closes = named.close_numbers();
        pull.parts = named.part_numbers();
        pull.merge_base = landed.previous;
        pull.merged_by = Some(actor.username.clone());
        pull.merged_at = Some(now.clone());
        pull.updated_at = now;
        Ok(pull)
    }

    async fn list_active_pulls(&self, a: ViewerArgs) -> Result<Vec<ActivePull>> {
        let Some(viewer) = a.viewer else {
            return Ok(Vec::new());
        };
        // The pull requests and their work items, in one round trip: their
        // own, and those g1t made for them (Pull::owner).
        let author = [JsValue::from(viewer.id.as_str())];
        let found = self
            .timing
            .db(
                2,
                self.db.batch(vec![
                    self.db
                        .prepare(format!(
                            "SELECT {PULL_COLUMNS} FROM pulls
                             WHERE COALESCE(requested_by_id, author_id) = ?1 AND status IN ('draft', 'open')
                             ORDER BY updated_at DESC LIMIT 50"
                        ))
                        .bind(&author)?,
                    self.db
                        .prepare(items::select(
                            "work_items.id IN (
                               SELECT item_id FROM pulls
                               WHERE COALESCE(requested_by_id, author_id) = ?1 AND status IN ('draft', 'open') AND item_id IS NOT NULL
                               ORDER BY updated_at DESC LIMIT 50)",
                        ))
                        .bind(&author)?,
                ]),
            )
            .await?;
        let (Some(found), Some(item_rows)) = (found.first(), found.get(1)) else {
            return Ok(Vec::new());
        };
        let snapshots = found.results::<Snapshot>()?;
        let item_ids: Vec<Option<String>> = found.results::<PullItemRow>()?.into_iter().map(|row| row.item_id).collect();
        let pulls: Vec<Pull> = found.results::<PullRow>()?.into_iter().map(Pull::from).collect();
        let items: Vec<Held> = items::held_rows(item_rows)?;
        let items = &items;
        let viewer = &viewer;
        // Where each stands: the remembered assessment when there is one,
        // and worked out otherwise.
        try_join_all(pulls.into_iter().zip(snapshots).zip(item_ids).map(|((pull, snapshot), item_id)| async move {
            let item = item_id.and_then(|id| {
                items
                    .iter()
                    .find(|held| held.item.id == id && held.may(Some(viewer), Capability::Read))
                    .map(|held| held.clone().shown(Some(viewer)))
            });
            // Every open pull request has a lifecycle (lifecycle.rs), kept
            // fresh by what moves it (`advance`, on each event that can);
            // anyone's draft but g1t's has none.
            let managed = lifecycle::made_by_g1t(&pull) && snapshot.managed != 0;
            let lifecycle = if pull.status == PullStatus::Draft && !managed {
                None
            } else if let (Some(stage), Some(detail)) = (snapshot.stage, snapshot.stage_detail) {
                Some(Lifecycle {
                    stage,
                    detail,
                    revisions: snapshot.revisions,
                })
            } else {
                // Never worked out yet: once, and remembered.
                let behind = self.behind_now(&pull).await?;
                self.assess(&pull, &item, behind)
                    .await?
                    .map(|(lifecycle, _)| lifecycle)
            };
            Ok::<_, worker::Error>(ActivePull {
                pull,
                item,
                lifecycle,
            })
        }))
        .await
    }

    // --- Sessions ----------------------------------------------------------

    async fn append_session(&self, a: AppendSessionArgs) -> Result<Outcome<Appended>> {
        if a.entries.is_empty() {
            return Ok(Outcome::Ok(Appended { count: 0 }));
        }
        if a.entries.len() > MAX_ENTRY_BATCH {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Send at most {MAX_ENTRY_BATCH} entries at a time."),
            ));
        }
        let viewer = Some(a.actor.clone());
        let (_, pull) = check!(self.pull_at(&a.repo, a.number, &viewer).await?);
        if !pull.is_owned_by(&a.actor.id) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only whoever opened a pull request, or asked g1t for it, can record its session.",
            ));
        }

        let now = rfc3339(now_ms());
        let count = a.entries.len() as u32;
        let mut statements = Vec::with_capacity(a.entries.len() + 1);
        for entry in a.entries {
            let kind = serde_json::to_value(entry.kind)?;
            let text = coordination::shown::clean(&entry.text.chars().take(MAX_ENTRY_CHARS).collect::<String>());
            // Each insert takes the next sequence number itself, so two
            // writers appending at once cannot collide.
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO session_entries (pull_id, seq, kind, text, tool, \"commit\", at)
                         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
                         FROM session_entries WHERE pull_id = ?",
                    )
                    .bind(&[
                        pull.id.as_str().into(),
                        kind.as_str().unwrap_or("note").into(),
                        text.into(),
                        optional(&entry.tool),
                        optional(&entry.commit.or_else(|| pull.head_commit.clone())),
                        now.as_str().into(),
                        pull.id.as_str().into(),
                    ])?,
            );
        }
        statements.push(
            self.db
                .prepare("UPDATE pulls SET updated_at = ? WHERE id = ?")
                .bind(&[now.as_str().into(), pull.id.as_str().into()])?,
        );
        self.db.batch(statements).await?;
        self.publish(
            "session.appended",
            &pull.repo_id,
            &a.actor,
            SessionAppended {
                pull_id: pull.id.clone(),
                repo_id: pull.repo_id.clone(),
                number: pull.number,
                count,
            },
        )
        .await?;
        Ok(Outcome::Ok(Appended { count }))
    }

    async fn read_session(&self, a: ViewArgs) -> Result<Outcome<Vec<SessionEntry>>> {
        let (_, pull) = check!(self.pull_at(&a.repo, a.number, &a.viewer).await?);
        let rows = self
            .db
            .prepare(
                "SELECT seq, kind, text, tool, \"commit\", at FROM session_entries
                 WHERE pull_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .bind(&[pull.id.into(), a.after_seq.into(), SESSION_PAGE.into()])?
            .all()
            .await?
            .results::<SessionRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter().map(SessionEntry::from).collect(),
        ))
    }

    /// A push moves the head of the pull request it concerns: the one whose
    /// fork was pushed to, or the one opened from the branch that moved.
    async fn on_event(&self, event: &Event) -> Result<()> {
        // A new repository: where it is, for its workspace's work items and
        // numbers; a workspace's first starts it with the default labels.
        if event.kind == "repo.created" {
            return items::repo_created(self, &event.data).await;
        }
        if event.kind == "repo.restored" {
            return items::repo_restored(self, &event.data).await;
        }
        if event.kind == "repo.visibility_changed" || event.kind == "repo.updated" {
            return items::repo_visibility(self, &event.data).await;
        }
        // Pull requests into the branch that became the default merge into
        // the default branch, which is stored as none.
        if event.kind == "repo.default_branch_changed"
            && let (Some(repo_id), Some(to)) = (event.repo_id.as_deref(), event.data["to"].as_str())
        {
            self.db
                .prepare(
                    "UPDATE pulls SET base_branch = NULL
                     WHERE repo_id = ? AND base_branch = ? AND status IN ('draft', 'open')",
                )
                .bind(&[repo_id.into(), to.into()])?
                .run()
                .await?;
            return Ok(());
        }
        if event.kind != "git.push" {
            return Ok(());
        }
        let (Some(repo_id), Some(after), Some(git_ref)) = (
            event.repo_id.as_deref(),
            event.data["after"].as_str(),
            event.data["ref"].as_str(),
        ) else {
            return Ok(());
        };
        let now = rfc3339(now_ms());
        // Who moved it, for rules about the most recent push.
        let pusher: JsValue = event.actor.as_deref().map_or(JsValue::NULL, Into::into);
        // The head moved, so whatever the checks said no longer applies, and
        // whatever step g1t was waiting on has been taken. The same event
        // handled again finds the pull requests it moved (heads.rs).
        let (moved, active) = (heads::MOVE, heads::ACTIVE);
        let returning = "RETURNING id, repo_id, number, author_id, author_name, requested_by_id, requested_by_name";
        let moving = [after.into(), now.as_str().into(), pusher, event.id.as_str().into(), event.time.as_str().into(), repo_id.into()];
        let mut pulls: Vec<MovedRow> = Vec::new();
        // A fork carries its pull request on its default branch.
        if event.data["defaultBranch"].as_bool() == Some(true) {
            pulls.extend(
                self.db
                    .prepare(format!("{moved} WHERE fork_repo_id = ?6 AND {active} {returning}"))
                    .bind(&moving)?
                    .all()
                    .await?
                    .results::<MovedRow>()?,
            );
        }
        if let Some(branch) = git_ref.strip_prefix("refs/heads/") {
            // A branch of the repository, and a branch of a fork pull
            // requests into other repositories were opened from.
            let mut values = moving.to_vec();
            values.extend([repo_id.into(), branch.into()]);
            pulls.extend(
                self.db
                    .prepare(format!("{moved} WHERE {} AND {active} {returning}", head_repo::ON_BRANCH))
                    .bind(&values)?
                    .all()
                    .await?
                    .results::<MovedRow>()?,
            );
        }
        // What each now changes, so overlaps show while the work is under way.
        let mut moved_pulls = Vec::new();
        for moved in &pulls {
            if let Some(mut pull) = self.pull_by_id(&moved.id).await? {
                pull.files = self.refresh_files(&pull).await?;
                // Owners of files it now changes are asked too.
                self.refresh_code_owners(&pull).await;
                // A new overlap with another pull request is announced.
                self.announce_overlaps(&pull, event.actor.clone()).await;
                // Auto-merge someone else turned on stops (automerge.rs).
                self.auto_merge_after_push(&pull, event.actor.as_deref()).await?;
                moved_pulls.push(pull);
            }
        }
        // The harness sessions that pushed the branch, or that its new
        // commits name in trailers, are tied to its pull requests.
        if let Some(branch) = git_ref.strip_prefix("refs/heads/") {
            let commits = event.data["commits"].as_u64().and_then(|n| u32::try_from(n).ok());
            self.link_push(repo_id, branch, after, commits, &moved_pulls).await;
        }
        // A merge that was waiting for this push to bring it up to date.
        for moved in &pulls {
            self.land_if_requested(&moved.id).await?;
        }
        // The pull requests into the branch whose heads it brought in are
        // merged, and the work items its commits name landed (pushed.rs).
        if let Some(branch) = git_ref.strip_prefix("refs/heads/") {
            self.after_branch_push(event, repo_id, branch, after).await;
        }
        // Whether each still merges cleanly, and, when a default branch
        // moved, every open pull request into it.
        let moved_ids: Vec<String> = pulls.iter().map(|pull| pull.id.clone()).collect();
        let into = match event.data["defaultBranch"].as_bool() {
            Some(true) => mergeability::Moved::DefaultBranch,
            _ => match git_ref.strip_prefix("refs/heads/") {
                Some(branch) => mergeability::Moved::Branch(branch),
                None => mergeability::Moved::Nothing,
            },
        };
        self.after_push(repo_id, into, &moved_ids).await;
        // A draft's too, as on GitHub: its workflows run on `synchronize`
        // whether or not it is ready.
        for pull in pulls {
            let item = moved_pulls.iter().find(|moved| moved.id == pull.id).and_then(|moved| moved.item);
            self.publish_as(
                "pull.updated",
                &pull.repo_id,
                event.actor.clone(),
                PullEvent {
                    author: Some(g1t_contracts::credentials::Principal { id: pull.author_id, username: pull.author_name }),
                    requested_by: pull
                        .requested_by_id
                        .zip(pull.requested_by_name)
                        .map(|(id, username)| g1t_contracts::credentials::Principal { id, username }),
                    pull_id: pull.id,
                    repo_id: pull.repo_id.clone(),
                    number: pull.number,
                    item,
                    commit: Some(after.to_owned()),
                    ..PullEvent::default()
                }
                .carrying(&event.data),
            )
            .await?;
        }
        Ok(())
    }
}

/// An event's data that carries on what caused the event it follows from.
trait Carrying: serde::Serialize + Sized {
    /// As JSON, marked as a workflow job's doing when `cause` was.
    fn carrying(self, cause: &serde_json::Value) -> serde_json::Value {
        g1t_contracts::events::carried(self, cause)
    }
}

impl Carrying for PullEvent {}

fn service(env: &Env) -> Result<Work> {
    Ok(Work {
        db: env.d1("DB")?,
        identity: env.service("IDENTITY")?,
        repos: env.service("REPOS")?,
        events: env.service("EVENTS")?,
        actions: env.service("ACTIONS")?,
        integrations: env.service("INTEGRATIONS").ok(),
        timing: g1t_kit::d1::Timing::default(),
        prefetched: std::cell::RefCell::new(None),
        known_repos: std::cell::RefCell::new(std::collections::HashMap::new()),
        repos_session: None,
    })
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    // A replica near the caller when it asks for one (crates/kit/src/d1.rs).
    let (db, served) = g1t_kit::d1::open(&env, "DB", &request)?;
    let body: serde_json::Value = request.json().await?;
    let mut work = service(&env)?;
    work.db = db;
    work.repos_session = g1t_kit::d1::forwarded(&request, "repos")?;

    // Opening a pull request writes it, then makes its refs and tells
    // everyone (`pull.opened`, which starts its checks). A caller that gave
    // up in between (an MCP client's timeout, on #454) cancelled the
    // request there, leaving a pull request nothing had heard of. It runs
    // where the caller leaving cannot stop it, for the 30 s `wait_until`
    // has after.
    if method == "open_pull" {
        let (answer, answered) = futures_channel::oneshot::channel();
        ctx.wait_until(async move {
            let opened = async { reply(&work.open_pull(args(body)?).await?) }.await;
            let _ = answer.send(served.finish_timed(opened, &work.timing));
        });
        return match answered.await {
            Ok(answered) => answered,
            Err(_) => Response::error("Opening the pull request stopped before it answered.", 500),
        };
    }

    let answered = match method.as_str() {
        // Work items (items/) and moving issues into them (items/migration.rs).
        "open_work_item" => reply(&work.open_work_item(args(body)?).await?),
        "list_work_items" => reply(&work.list_work_items(args(body)?).await?),
        "get_work_item" => reply(&work.get_work_item(args(body)?).await?),
        "update_work_item" => reply(&work.update_work_item(args(body)?).await?),
        "plan_work_item" => reply(&work.plan_work_item(args(body)?).await?),
        "get_plan" => reply(&work.get_plan(args(body)?).await?),
        "next_work_item" => reply(&work.next_work_item(args(body)?).await?),
        "configure_plan" => reply(&work.configure_plan(args(body)?).await?),
        // Cycles: Now as a time box (items/cycles.rs).
        "list_cycles" => reply(&work.list_cycles(args(body)?).await?),
        "get_cycle" => reply(&work.get_cycle(args(body)?).await?),
        "configure_cycles" => reply(&work.configure_cycles(args(body)?).await?),
        "cycle_work_item" => reply(&work.cycle_work_item(args(body)?).await?),
        "close_work_item" => reply(&work.close_work_item(args(body)?).await?),
        "set_work_item_parent" => reply(&work.set_work_item_parent(args(body)?).await?),
        "check_work_item_task" => reply(&work.check_work_item_task(args(body)?).await?),
        "reopen_work_item" => reply(&work.reopen_work_item(args(body)?).await?),
        "link_work_item" => reply(&work.link_work_item(args(body)?).await?),
        "unlink_work_item" => reply(&work.unlink_work_item(args(body)?).await?),
        "resolve_ref" => reply(&work.resolve_ref(args(body)?).await?),
        "legacy_item_map" => reply(&work.legacy_item_map(args(body)?).await?),
        "migrate_work_items" => {
            let _: MigrateWorkItemsArgs = args(body)?;
            reply(&work.migrate_work_items().await?)
        }
        "list_labels" => reply(&work.list_labels(args(body)?).await?),
        "save_label" => reply(&work.save_label(args(body)?).await?),
        "delete_label" => reply(&work.delete_label(args(body)?).await?),
        "add_default_labels" => reply(&work.add_default_labels(args(body)?).await?),
        "set_labels" => reply(&work.set_labels(args(body)?).await?),
        "list_milestones" => reply(&work.list_milestones(args(body)?).await?),
        "get_milestone" => reply(&work.get_milestone(args(body)?).await?),
        "save_milestone" => reply(&work.save_milestone(args(body)?).await?),
        "delete_milestone" => reply(&work.delete_milestone(args(body)?).await?),
        // Projects: homes for bodies of work (items/projects.rs).
        "list_projects" => reply(&work.list_projects(args(body)?).await?),
        "get_project" => reply(&work.get_project(args(body)?).await?),
        "create_project" => reply(&work.create_project(args(body)?).await?),
        "update_project" => reply(&work.update_project(args(body)?).await?),
        "archive_project" => reply(&work.archive_project(args(body)?).await?),
        "add_project_member" => reply(&work.add_project_member(args(body)?).await?),
        "remove_project_member" => reply(&work.remove_project_member(args(body)?).await?),
        "add_project_repo" => reply(&work.add_project_repo(args(body)?).await?),
        "remove_project_repo" => reply(&work.remove_project_repo(args(body)?).await?),
        "counts" => reply(&work.counts(args(body)?).await?),
        "add_comment" => reply(&work.add_comment(args(body)?).await?),
        "upload_attachment" => reply(&work.upload_attachment(&env, args(body)?).await?),
        "edit_comment" => reply(&work.edit_comment(args(body)?).await?),
        "delete_comment" => reply(&work.delete_comment(args(body)?).await?),
        "react" => reply(&work.react(args(body)?).await?),
        "commit_comments" => reply(&work.commit_comments(args(body)?).await?),
        "closed_by_commit" => reply(&work.closed_by_commit(args(body)?).await?),
        "add_commit_comment" => reply(&work.add_commit_comment(args(body)?).await?),
        "edit_commit_comment" => reply(&work.edit_commit_comment(args(body)?).await?),
        "delete_commit_comment" => reply(&work.delete_commit_comment(args(body)?).await?),
        "seen_checks" => reply(&work.seen_checks(args(body)?).await?),
        "report_checks" => reply(&work.report_checks(args(body)?).await?),
        "set_commit_status" => reply(&work.set_commit_status(args(body)?).await?),
        "create_commit_status" => reply(&work.create_commit_status(args(body)?).await?),
        "commit_statuses" => reply(&work.commit_statuses(args(body)?).await?),
        "combined_status" => reply(&work.combined_status(args(body)?).await?),
        "create_check_run" => reply(&work.create_check_run(args(body)?).await?),
        "update_check_run" => reply(&work.update_check_run(args(body)?).await?),
        "get_check_run" => reply(&work.get_check_run(args(body)?).await?),
        "check_run_annotations" => reply(&work.check_run_annotations(args(body)?).await?),
        "ref_check_runs" => reply(&work.ref_check_runs(args(body)?).await?),
        "ref_check_suites" => reply(&work.ref_check_suites(args(body)?).await?),
        "get_check_suite" => reply(&work.get_check_suite(args(body)?).await?),
        "rerequest_check_run" => reply(&work.rerequest_check_run(args(body)?).await?),
        "rerequest_check_suite" => reply(&work.rerequest_check_suite(args(body)?).await?),
        "request_check_action" => reply(&work.request_check_action(args(body)?).await?),
        "commit_checks" => reply(&work.commit_checks(args(body)?).await?),
        "advance" => reply(&work.advance(args(body)?).await?),
        "managed_pulls" => reply(&work.managed_pulls(args(body)?).await?),
        "queue" => reply(&work.queue(args(body)?).await?),
        "queue_build" => reply(&work.queue_build(args(body)?).await?),
        "waiting_queues" => reply(&work.waiting_queues().await?),
        "report_queue" => reply(&work.report_queue(args(body)?).await?),
        "remove_from_queue" => reply(&work.remove_from_queue(args(body)?).await?),
        "locate_pull" => reply(&work.locate_pull(args(body)?).await?),
        "inbox_subject" => reply(&work.inbox_subject(args(body)?).await?),
        "get_settings" => reply(&work.get_settings(args(body)?).await?),
        "codeowners_errors" => reply(&work.codeowners_errors(args(body)?).await?),
        "update_settings" => reply(&work.update_settings(args(body)?).await?),
        "open_pull" => reply(&work.open_pull(args(body)?).await?),
        "list_pulls" => reply(&work.list_pulls(args(body)?).await?),
        "delivery_insights" => reply(&work.delivery_insights(args(body)?).await?),
        "workspace_signals" => reply(&work.workspace_signals(args(body)?).await?),
        "get_spend" => reply(&work.get_spend(args(body)?).await?),
        "configure_spend" => reply(&work.configure_spend(args(body)?).await?),
        "pulls_for_repos" => reply(&work.pulls_for_repos(args(body)?).await?),
        "get_pull" => reply(&work.get_pull(args(body)?).await?),
        "update_pull" => reply(&work.update_pull(args(body)?).await?),
        "catch_up_pull" => reply(&work.catch_up_pull(args(body)?).await?),
        "ready_pull" => reply(&work.ready_pull(args(body)?).await?),
        "check_pull_task" => reply(&work.check_pull_task(args(body)?).await?),
        "close_pull" => reply(&work.close_pull(args(body)?).await?),
        "reopen_pull" => reply(&work.reopen_pull(args(body)?).await?),
        "convert_pull_to_draft" => reply(&work.convert_pull_to_draft(args(body)?).await?),
        "merge_pull" => reply(&work.merge_pull(args(body)?).await?),
        // How it may merge, auto-merge and its branch (merging.rs, automerge.rs).
        "merge_choices" => reply(&work.merge_choices(args(body)?).await?),
        "set_auto_merge" => reply(&work.set_auto_merge(args(body)?).await?),
        "delete_head_branch" => reply(&work.delete_head_branch(args(body)?).await?),
        "restore_head_branch" => reply(&work.restore_head_branch(args(body)?).await?),
        "list_active_pulls" => reply(&work.list_active_pulls(args(body)?).await?),
        "by_author" => reply(&work.by_author(args(body)?).await?),
        "contributions" => reply(&work.contributions(args(body)?).await?),
        "append_session" => reply(&work.append_session(args(body)?).await?),
        "read_session" => reply(&work.read_session(args(body)?).await?),
        // Decision records (decisions.rs).
        "record_decision" => reply(&work.record_decision(args(body)?).await?),
        "list_decisions" => reply(&work.list_decisions(args(body)?).await?),
        // Coordinating work: harness sessions, claims, dependencies and a
        // work item's whole context (coordination/).
        "start_session" => reply(&work.start_session(args(body)?).await?),
        "update_session" => reply(&work.update_session(args(body)?).await?),
        "end_session" => reply(&work.end_session(args(body)?).await?),
        // Usage from coding agents' OpenTelemetry (the API's /v1/logs and /v1/metrics).
        "record_agent_telemetry" => reply(&work.record_agent_telemetry(args(body)?).await?),
        "title_session" => reply(&work.title_session(args(body)?).await?),
        "get_work_session" => reply(&work.get_work_session(args(body)?).await?),
        "list_work_sessions" => reply(&work.list_work_sessions(args(body)?).await?),
        "list_workspace_sessions" => reply(&work.list_workspace_sessions(args(body)?).await?),
        "get_workspace_session" => reply(&work.get_workspace_session(args(body)?).await?),
        "pull_sessions" => reply(&work.pull_sessions(args(body)?).await?),
        "record_session_entries" => reply(&work.record_session_entries(args(body)?).await?),
        "claim_work_item" => reply(&work.claim_work_item(args(body)?).await?),
        "release_claim" => reply(&work.release_claim(args(body)?).await?),
        "hand_off_work_item" => reply(&work.hand_off_work_item(args(body)?).await?),
        "list_claims" => reply(&work.list_claims(args(body)?).await?),
        "get_work" => reply(&work.get_work(args(body)?).await?),
        // Runs of sandboxes (runs.rs).
        "open_run" => reply(&work.open_run(args(body)?).await?),
        "report_run" => reply(&work.report_run(args(body)?).await?),
        "list_runs" => reply(&work.list_runs(args(body)?).await?),
        "get_run" => reply(&work.get_run(args(body)?).await?),
        "list_sessions" => reply(&work.list_sessions(args(body)?).await?),
        "get_session" => reply(&work.get_session(args(body)?).await?),
        // What a sandbox may reach (guardrails.rs).
        "get_guardrails" => reply(&work.get_guardrails(args(body)?).await?),
        "update_guardrails" => reply(&work.update_guardrails(args(body)?).await?),
        "run_guardrails" => reply(&work.run_guardrails(args(body)?).await?),
        // The runs whose sandboxes stop with their repository (retired.rs).
        "runs_in_repo" => reply(&work.runs_in_repo(args(body)?).await?),
        "start_mergecheck" => reply(&work.start_mergecheck(args(body)?).await?),
        "report_mergecheck" => reply(&work.report_mergecheck(args(body)?).await?),
        // Rulesets (rulesets.rs): kept here, enforced here on merge and by
        // repos on push.
        "list_rulesets" => reply(&work.list_rulesets(args(body)?).await?),
        "get_ruleset" => reply(&work.get_ruleset(args(body)?).await?),
        "save_ruleset" => reply(&work.save_ruleset(args(body)?).await?),
        "delete_ruleset" => reply(&work.delete_ruleset(args(body)?).await?),
        "effective_rules" => reply(&work.effective_rules(args(body)?).await?),
        "rule_evaluations" => reply(&work.rule_evaluations(args(body)?).await?),
        "ref_rules" => reply(&work.ref_rules(args(body)?).await?),
        "record_evaluations" => reply(&work.record_evaluations(args(body)?).await?),
        "set_requires_pull_request" => reply(&work.set_requires_pull_request(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    };
    served.finish_timed(answered, &work.timing)
}

/// The cron trigger: moves on the job that moves issues into work items
/// (items/migration.rs), until it is done, settles the sessions' titles
/// that are due (coordination/titles.rs), keeps the plan up
/// (items/plan_settle.rs), closes the cycles that are over, carrying
/// what is open in them into the next (items/cycles.rs), and catches up on
/// pushes to pull requests whose event never arrived (heads.rs).
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let moved = async {
        let work = service(&env)?;
        work.migrate_work_items().await
    };
    if let Err(error) = moved.await {
        worker::console_error!("moving issues into work items: {error}");
    }
    let settled = async {
        let work = service(&env)?;
        work.settle_titles().await
    };
    if let Err(error) = settled.await {
        worker::console_error!("settling session titles: {error}");
    }
    let planned = async {
        let work = service(&env)?;
        work.settle_plan().await
    };
    if let Err(error) = planned.await {
        worker::console_error!("the plan's upkeep: {error}");
    }
    let cycled = async {
        let work = service(&env)?;
        work.settle_cycles().await
    };
    if let Err(error) = cycled.await {
        worker::console_error!("rolling cycles over: {error}");
    }
    let swept = async {
        let work = service(&env)?;
        work.sweep_heads().await
    };
    if let Err(error) = swept.await {
        worker::console_error!("comparing pull requests with their branches: {error}");
    }
}

/// Events from the bus, delivered on this service's own queue. One that
/// fails is retried on its own, after a while: what fails is nearly always
/// the database being overloaded, which a retry straight away finds still
/// overloaded. The others are acknowledged. After its retries an event goes
/// to the dead-letter queue (wrangler.jsonc), which the events service
/// counts; a push it held is caught up by the sweep (heads.rs).
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let work = service(&env)?;
    let later = QueueRetryOptionsBuilder::new().with_delay_seconds(RETRY_DELAY_SECONDS).build();
    for message in batch.messages()? {
        match on_message(&work, &env, message.body()).await {
            Ok(()) => message.ack(),
            Err(error) => {
                worker::console_error!("work: event {} ({}) failed: {error}", message.body().id, message.body().kind);
                message.retry_with_options(&later);
            }
        }
    }
    Ok(())
}

/// How long a failed event waits before it is tried again.
const RETRY_DELAY_SECONDS: u32 = 30;

async fn on_message(work: &Work, env: &Env, event: &Event) -> Result<()> {
    // A workspace renamed: its runs, work items, labels, milestones,
    // projects and numbers move to the slug it has now.
    let renamed = [runs::RENAMED, guardrails::RENAMED, rulesets::RENAMED, items::RENAMED, items::PROJECTS_RENAMED, items::CYCLES_RENAMED, attachments::RENAMED].concat();
    if g1t_kit::rename::on_event(env, &env.d1("DB")?, event, &renamed).await? {
        return Ok(());
    }
    // A repository renamed or transferred: its runs and guardrails
    // follow, and where it is is recorded for work items and numbers.
    let transferred = [runs::TRANSFERRED, guardrails::TRANSFERRED, head_repo::TRANSFERRED, items::TRANSFERRED].concat();
    if g1t_kit::transfer::on_event(env, &env.d1("DB")?, event, &transferred).await? {
        return Ok(());
    }
    // A workspace deleted: what it kept for itself goes, its work items'
    // attachments' bytes first.
    if event.kind == "workspace.deleted"
        && let Some(slug) = event.data["slug"].as_str()
    {
        attachments::purge_workspace(env, &work.db, slug).await?;
    }
    let deleted = [guardrails::DELETED, items::DELETED, items::PROJECTS_DELETED, items::CYCLES_DELETED, attachments::DELETED].concat();
    if g1t_kit::deleted::on_event(&env.d1("DB")?, event, &deleted).await? {
        return Ok(());
    }
    // An account purged: what it wrote shows as ghost (ghost.rs).
    let ghost = ghost::statements();
    let ghost: Vec<&str> = ghost.iter().map(String::as_str).collect();
    if g1t_kit::user_deleted::on_event(&env.d1("DB")?, event, &ghost).await? {
        return Ok(());
    }
    // A repository purged: its attachments' bytes go before their rows do.
    if let Some(g1t_kit::lifecycle::Lifecycle::Purged(purged)) = g1t_kit::lifecycle::read(event) {
        attachments::purge(env, &work.db, &purged.repo_id).await?;
    }
    // A repository deleted, archived or purged, or a branch renamed (retired.rs).
    if work.on_retired(event).await? {
        return Ok(());
    }
    work.on_event(event).await
}

/// The rules that once read a pull request's author read its owner now:
/// whoever asked g1t for it, or its author. For each, the person who asked
/// is held to what an author was, and g1t's agent (a token it works with)
/// gains nothing by being the author.
#[cfg(test)]
mod owner_rules {
    use super::*;
    use crate::rows::stored::{ASKER, G1T, pull};
    use g1t_contracts::identity::AGENT_ID;

    const SOMEONE: &str = "usr_2";

    #[test]
    fn no_self_approval() {
        // add_comment refuses a verdict on one that is theirs.
        let made = pull(G1T, Some(ASKER));
        assert!(made.is_owned_by(ASKER.0), "the person who asked cannot approve it");
        assert!(!made.is_owned_by(AGENT_ID), "g1t's review agent still gives its verdict");
        assert!(!made.is_owned_by(SOMEONE));
    }

    #[test]
    fn what_an_author_could_do_without_a_role() {
        // manageable_pull (update, ready, close), catch_up_pull on a fork,
        // and append_session: theirs to do.
        let made = pull(G1T, Some(ASKER));
        assert!(made.is_owned_by(ASKER.0));
        assert!(!made.is_owned_by(SOMEONE), "anyone else still needs the role");
        assert!(!made.is_owned_by(AGENT_ID), "being its author gives g1t's tokens nothing more");
    }

    #[test]
    fn nobody_is_asked_to_review_what_they_asked_for() {
        // update_pull drops the owner from the reviewers asked.
        let made = pull(G1T, Some(ASKER));
        let mut reviewers = vec!["syntaqx".to_owned(), "ana".to_owned()];
        reviewers.retain(|name| *name != made.owner().username);
        assert_eq!(reviewers, ["ana"]);
    }

    #[test]
    fn sandboxes_act_as_whoever_asked() {
        // MergecheckJob and the merge queue's job
        // carry who the sandbox's credential acts for: a real account.
        let made = pull(G1T, Some(ASKER));
        assert_eq!(made.owner().id, ASKER.0);
        let acts_as = made.requested_by.unwrap_or(made.author);
        assert_eq!(acts_as.id, ASKER.0);
        // g1t's own work, which nobody asked for, acts as g1t, as before.
        let own = pull(("g1t", "g1t"), None);
        assert_eq!(own.requested_by.unwrap_or(own.author).id, "g1t");
    }

    #[test]
    fn events_name_g1t_and_whoever_asked() {
        let made = pull(G1T, Some(ASKER));
        let event = serde_json::to_value(Work::pull_event(&made)).unwrap();
        assert_eq!(event["author"], serde_json::json!({ "id": AGENT_ID, "username": "g1t" }));
        assert_eq!(event["requestedBy"], serde_json::json!({ "id": "usr_1", "username": "syntaqx" }));
        let own = serde_json::to_value(Work::pull_event(&pull(ASKER, None))).unwrap();
        assert!(own.get("requestedBy").is_none());
    }

    #[test]
    fn only_a_closed_pull_request_reopens_and_only_an_open_one_turns_draft() {
        assert_eq!(reopen_refusal(PullStatus::Closed), None);
        assert!(reopen_refusal(PullStatus::Merged).is_some(), "a merge cannot be undone");
        assert!(reopen_refusal(PullStatus::Open).is_some());
        assert!(reopen_refusal(PullStatus::Draft).is_some());
        assert_eq!(draft_refusal(PullStatus::Open), None);
        assert!(draft_refusal(PullStatus::Draft).is_some());
        assert!(draft_refusal(PullStatus::Closed).is_some());
        assert!(draft_refusal(PullStatus::Merged).is_some());
    }

    #[test]
    fn a_pull_request_reopens_as_what_it_was_closed_as() {
        assert_eq!(reopened_status(Some("draft")), PullStatus::Draft);
        assert_eq!(reopened_status(Some("open")), PullStatus::Open);
        // Closed before this was recorded, or by a merge of another.
        assert_eq!(reopened_status(None), PullStatus::Open);
    }
}
