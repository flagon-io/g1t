//! The work service: issues, pull requests, comments and sessions.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::work` for the methods and their arguments. It also
//! consumes its queue of events from the bus.

mod authored;
mod capture;
mod checks;
mod codeowners;
mod commit_checks;
mod compute;
mod confidence;
mod guardrails;
mod inbox;
mod labels;
mod lifecycle;
mod memory;
mod mentions;
mod mergeability;
mod milestones;
mod plans;
mod messages;
mod prefetch;
mod queue;
mod retired;
mod reviews;
mod rows;
mod rulesets;
mod runs;
mod settings;
mod statuses;
mod team_reviews;

use g1t_contracts::events::{
    ChangedFrom, CommentChanges, CommentCreated, CommentDeleted, CommentEdited, DeletedComment, Event, IssueEvent,
    NewEvent, Publish, PullEvent, SessionAppended,
};
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{
    ForkArgs, GetArgs, HeadArgs, LandArgs, Landed, NeedsAgentReason, PullBranchUpdate, ReadableArgs, Repo, RepoPath,
    UpdatePullBranchArgs,
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
    Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, event,
};

use retired::writable;
use rows::{CommentRow, IssueRow, MovedRow, NumberRow, PULL_COLUMNS, PullRow, SessionRow, Snapshot};

pub(crate) const SOURCE: &str = "work";
const MAX_ENTRY_BATCH: usize = 200;
const MAX_ENTRY_CHARS: usize = 64_000;
const MAX_TITLE_CHARS: usize = 200;
const SESSION_PAGE: u32 = 500;
const LIST_PAGE: u32 = 100;
const MAX_ASSIGNEES: usize = 10;
pub(crate) const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

const ISSUE_COLUMNS: &str = "issues.*,
  (SELECT count(*) FROM pulls WHERE pulls.issue_id = issues.id) AS pull_count,
  (SELECT agent FROM pulls
   WHERE pulls.issue_id = issues.id AND pulls.status IN ('draft', 'open')
     AND pulls.fork_repo_id IS NOT NULL
   ORDER BY pulls.number DESC LIMIT 1) AS agent,
  (SELECT count(*) FROM comments
   WHERE comments.repo_id = issues.repo_id AND comments.number = issues.number
     AND comments.kind = 'comment') AS comment_count,
  (SELECT title FROM milestones
   WHERE milestones.repo_id = issues.repo_id AND milestones.number = issues.milestone) AS milestone_title";

fn no_issue<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Issue not found.")
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

fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

fn optional_number(value: Option<u32>) -> JsValue {
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
fn state_name(state: Option<State>) -> Option<&'static str> {
    state.map(|state| match state {
        State::Open => "open",
        State::Closed => "closed",
    })
}

/// A trimmed title, or why it cannot be used.
fn valid_title(title: &str) -> std::result::Result<&str, &'static str> {
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
    /// Where this request's time went, for its `Server-Timing`.
    timing: g1t_kit::d1::Timing,
    /// A pull request's rows read in one batch for this request
    /// (prefetch.rs), which the helpers below read instead of the database.
    prefetched: std::cell::RefCell<Option<std::rc::Rc<prefetch::Prefetched>>>,
    /// Repositories read in this request, by id, for rules that need one
    /// where only a pull request is at hand (rulesets.rs `repo_for`).
    known_repos: std::cell::RefCell<std::collections::HashMap<String, Repo>>,
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
        let event = NewEvent {
            kind,
            source: SOURCE,
            repo_id: Some(repo_id.to_owned()),
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
    /// decided by the repos service.
    async fn repo(&self, path: &RepoPath, viewer: &Viewer) -> Result<Outcome<Repo>> {
        let found: Outcome<Repo> = self
            .timing
            .rpc(g1t_kit::call(
                &self.repos,
                "get",
                &GetArgs {
                    path: path.clone(),
                    viewer: viewer.clone(),
                },
            ))
            .await?;
        if let Outcome::Ok(repo) = &found {
            self.known_repos.borrow_mut().insert(repo.id.clone(), repo.clone());
        }
        Ok(found)
    }

    /// The next number in the repository's sequence. Taking it is one
    /// statement, so concurrent opens cannot be given the same number.
    async fn next_number(&self, repo_id: &str) -> Result<u32> {
        let row = self
            .db
            .prepare(
                "INSERT INTO counters (repo_id, last) VALUES (?, 1)
                 ON CONFLICT (repo_id) DO UPDATE SET last = last + 1
                 RETURNING last AS n",
            )
            .bind(&[repo_id.into()])?
            .first::<NumberRow>(None)
            .await?;
        row.map(|row| row.n)
            .ok_or_else(|| worker::Error::RustError("no number was assigned".into()))
    }

    async fn issue(&self, repo_id: &str, number: u32) -> Result<Option<Issue>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {ISSUE_COLUMNS} FROM issues WHERE repo_id = ? AND number = ?"
            ))
            .bind(&[repo_id.into(), number.into()])?
            .first::<IssueRow>(None)
            .await?
            .map(Issue::from))
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

    /// The repository and one of its issues, as seen by `viewer`.
    async fn issue_at(
        &self,
        path: &RepoPath,
        number: u32,
        viewer: &Viewer,
    ) -> Result<Outcome<(Repo, Issue)>> {
        let Outcome::Ok(repo) = self.repo(path, viewer).await? else {
            return Ok(no_issue());
        };
        Ok(match self.issue(&repo.id, number).await? {
            Some(issue) => Outcome::Ok((repo, issue)),
            None => no_issue(),
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

    /// Records something that happened to an issue or a pull request, so
    /// that it shows in the conversation where it happened. `text` is what
    /// `author` did, as the rest of a sentence starting with their name.
    pub(crate) async fn note(
        &self,
        repo_id: &str,
        number: u32,
        author: (&str, &str),
        text: &str,
    ) -> Result<()> {
        let now = now_ms();
        self.db
            .prepare(
                "INSERT INTO comments
                   (id, repo_id, number, author_id, author_name, body, kind, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'event', ?)",
            )
            .bind(&[
                new_id("cmt", now).into(),
                repo_id.into(),
                number.into(),
                author.0.into(),
                author.1.into(),
                text.into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Notes who was added to and removed from a list of people, such as
    /// "assigned ana" or "requested a review from g1t".
    async fn note_changes(
        &self,
        repo_id: &str,
        number: u32,
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
        let who = (actor.id.as_str(), actor.username.as_str());
        if !new.is_empty() {
            // Taking something on oneself reads better said that way.
            let text = if added == "assigned" && new == [&actor.username] {
                "self-assigned this".to_owned()
            } else {
                format!("{added} {}", joined(new))
            };
            self.note(repo_id, number, who, &text).await?;
        }
        if !gone.is_empty() {
            self.note(repo_id, number, who, &format!("{removed} {}", joined(gone)))
                .await?;
        }
        Ok(())
    }

    fn issue_event(issue: &Issue) -> IssueEvent {
        IssueEvent {
            issue_id: issue.id.clone(),
            repo_id: issue.repo_id.clone(),
            number: issue.number,
            author: Some((&issue.author).into()),
            requested_by: issue.requested_by.as_ref().map(Into::into),
            ..IssueEvent::default()
        }
    }

    /// The commit a pull request's change is at in git right now: its
    /// fork's default branch, or its branch.
    async fn live_head(&self, pull: &Pull) -> Result<Option<String>> {
        g1t_kit::call(
            &self.repos,
            "head",
            &HeadArgs {
                repo_id: pull.fork_repo_id.clone().unwrap_or_else(|| pull.repo_id.clone()),
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
            issue: pull.issue,
            confidence: pull.confidence.clone(),
            ..PullEvent::default()
        }
    }

    // --- Issues ------------------------------------------------------------

    /// Opens an issue for g1t to take at once: refused before
    /// anything is opened unless the actor may put agents to work here. The
    /// runner's `delegate` starts the agent on it.
    async fn delegate_issue(&self, a: DelegateIssueArgs) -> Result<Outcome<Issue>> {
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        check!(allowed(Some(&a.actor), &repo, Capability::Run));
        self.open_issue(OpenIssueArgs {
            actor: a.actor,
            repo: a.repo,
            title: a.title,
            body: a.body,
            labels: a.labels,
            checks: a.checks,
            milestone: None,
        })
        .await
    }

    async fn open_issue(&self, a: OpenIssueArgs) -> Result<Outcome<Issue>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let title = match valid_title(&a.title) {
            Ok(title) => title,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let Some(labels) = normalize_labels(&a.labels) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("An issue can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        };
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        // Labels it does not have yet are made for someone who may triage;
        // anyone else picks from those there are.
        let colors = check!(self.ensure_labels(&a.actor, &repo, &labels).await?);
        let milestone = match a.milestone.filter(|number| *number > 0) {
            Some(number) => {
                check!(allowed(Some(&a.actor), &repo, Capability::Triage));
                check!(self.milestone_ref(&repo.id, number).await?)
            }
            None => None,
        };
        // Commands given the old way are words for the agent now: added to
        // the body under "Definition of done". What has to pass to merge is
        // the branch's required checks.
        let body = with_definition_of_done(&a.body, &commands_pass(&a.checks));

        let now = now_ms();
        let id = new_id("iss", now);
        let number = self.next_number(&repo.id).await?;
        let timestamp = rfc3339(now);
        // What g1t's agent files at work is g1t's, for the person it works for.
        let (author, requested_by) = authorship(&a.actor, false);
        self.db
            .prepare(
                "INSERT INTO issues
                   (id, repo_id, number, title, body, labels, checks, author_id, author_name,
                    requested_by_id, requested_by_name, created_at, updated_at, milestone)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                title.into(),
                body.into(),
                serde_json::to_string(&labels)?.into(),
                "[]".into(),
                author.id.as_str().into(),
                author.username.as_str().into(),
                optional(&requested_by.as_ref().map(|user| user.id.clone())),
                optional(&requested_by.as_ref().map(|user| user.username.clone())),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
                optional_number(milestone.as_ref().map(|milestone| milestone.number)),
            ])?
            .run()
            .await?;
        let Some(issue) = self.issue(&repo.id, number).await? else {
            return Ok(no_issue());
        };
        self.apply_label_rule(&a.actor, &issue, &[]).await?;
        self.publish(
            "issue.opened",
            &repo.id,
            &a.actor,
            IssueEvent {
                title: Some(issue.title.clone()),
                ..Self::issue_event(&issue)
            },
        )
        .await?;
        // Opened with labels and a milestone: each is said, as it would be
        // if they were added afterwards, without notes in the conversation.
        for label in &issue.labels {
            let color = colors.iter().find(|(name, _)| name == label).map_or_else(|| label_color_for(label), |(_, c)| c.clone());
            let label = Some(g1t_contracts::events::EventLabel { name: label.clone(), color });
            self.publish("issue.labeled", &repo.id, &a.actor, IssueEvent { label, ..Self::issue_event(&issue) })
                .await?;
        }
        if let Some(milestone) = milestone {
            self.publish(
                "issue.milestoned",
                &repo.id,
                &a.actor,
                IssueEvent { milestone: Some(milestone), ..Self::issue_event(&issue) },
            )
            .await?;
        }
        Ok(Outcome::Ok(issue))
    }

    async fn list_issues(&self, a: ListIssuesArgs) -> Result<Outcome<Vec<Issue>>> {
        let state = state_name(a.state);
        let label = a
            .label
            .map(|label| label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
            .filter(|label| !label.is_empty());
        let milestone = a.milestone;
        let list = |repo_id: String| {
            let label = label.clone();
            async move {
                let state = state.map_or(JsValue::NULL, JsValue::from);
                let query = self
                    .db
                    .prepare(format!(
                        "SELECT {ISSUE_COLUMNS} FROM issues
                         WHERE repo_id = ? AND (? IS NULL OR state = ?)
                           AND (? IS NULL OR EXISTS
                             (SELECT 1 FROM json_each(issues.labels) WHERE json_each.value = ?))
                           AND (? IS NULL OR milestone = ?)
                         ORDER BY number DESC LIMIT ?"
                    ))
                    .bind(&[
                        repo_id.into(),
                        state.clone(),
                        state,
                        optional(&label),
                        optional(&label),
                        optional_number(milestone),
                        optional_number(milestone),
                        LIST_PAGE.into(),
                    ])?;
                self.timing.db(1, query.all()).await?.results::<IssueRow>()
            }
        };
        let (_, rows) = check!(self.repo_then(&a.repo, &a.viewer, list).await?);
        Ok(Outcome::Ok(rows.into_iter().map(Issue::from).collect()))
    }

    /// An issue, the pull requests for it and its comments: one batch,
    /// started beside the access check (prefetch.rs).
    async fn get_issue(&self, a: ViewArgs) -> Result<Outcome<IssueDetail>> {
        let number = a.number;
        let read = |repo_id: String| async move {
            let key = [JsValue::from(repo_id.as_str()), JsValue::from(number)];
            let statements = vec![
                self.db
                    .prepare(format!("SELECT {ISSUE_COLUMNS} FROM issues WHERE repo_id = ?1 AND number = ?2"))
                    .bind(&key)?,
                self.db
                    .prepare(format!(
                        "SELECT {PULL_COLUMNS} FROM pulls
                         WHERE issue_id = (SELECT id FROM issues WHERE repo_id = ?1 AND number = ?2)
                         ORDER BY number"
                    ))
                    .bind(&key)?,
                self.db
                    .prepare("SELECT * FROM comments WHERE repo_id = ?1 AND number = ?2 ORDER BY id LIMIT 500")
                    .bind(&key)?,
            ];
            let results = self.timing.db(3, self.db.batch(statements)).await?;
            let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
            Ok::<_, worker::Error>((
                rows(0)?.results::<IssueRow>()?.into_iter().next().map(Issue::from),
                rows(1)?.results::<PullRow>()?.into_iter().map(Pull::from).collect::<Vec<_>>(),
                rows(2)?.results::<CommentRow>()?.into_iter().map(Comment::from).collect::<Vec<_>>(),
            ))
        };
        let Outcome::Ok((_, (Some(issue), pulls, comments))) = self.repo_then(&a.repo, &a.viewer, read).await? else {
            return Ok(no_issue());
        };
        Ok(Outcome::Ok(IssueDetail { comments, pulls, issue }))
    }

    /// The issue, if `actor` wrote it or may triage the repository's issues.
    async fn manageable_issue(
        &self,
        actor: &User,
        path: &RepoPath,
        number: u32,
    ) -> Result<Outcome<Issue>> {
        let (repo, issue) = check!(self.issue_at(path, number, &Some(actor.clone())).await?);
        check!(writable(&repo));
        if issue.owner().id != actor.id {
            check!(allowed(Some(actor), &repo, Capability::Triage));
        }
        Ok(Outcome::Ok(issue))
    }

    async fn update_issue(&self, a: UpdateIssueArgs) -> Result<Outcome<Issue>> {
        let issue = check!(self.manageable_issue(&a.actor, &a.repo, a.number).await?);
        let title = match a.title.as_deref().map(valid_title) {
            Some(Err(message)) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            Some(Ok(title)) => Some(title.to_owned()),
            None => None,
        };
        if a.labels.as_deref().is_some_and(|labels| normalize_labels(labels).is_none()) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("An issue can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        }
        let assignees = match a.assignees {
            Some(names) => Some(check!(self.valid_assignees(names).await?)),
            None => None,
        };
        // Its labels and milestone first: either can be refused, and then
        // nothing else changes.
        if a.milestone.is_some() || a.labels.is_some() {
            let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
            if let Some(number) = a.milestone {
                check!(self.set_milestone(&a.actor, &repo, &labels::Item::Issue(issue.clone()), number).await?);
            }
            if let Some(labels) = &a.labels {
                check!(self.relabel(&a.actor, &repo, &labels::Item::Issue(issue.clone()), labels).await?);
            }
        }
        let assigned = assignees.as_ref().map(serde_json::to_string).transpose()?;
        let body = a.body.map(|body| body.trim().to_owned());
        self.db
            .prepare(
                "UPDATE issues
                 SET title = COALESCE(?, title), body = COALESCE(?, body),
                     assignees = COALESCE(?, assignees), updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&title),
                optional(&body),
                optional(&assigned),
                rfc3339(now_ms()).into(),
                issue.id.as_str().into(),
            ])?
            .run()
            .await?;
        let before = issue.assignees.clone();
        let labels_before = issue.labels.clone();
        let Some(issue) = self.issue(&issue.repo_id, issue.number).await? else {
            return Ok(no_issue());
        };
        self.apply_label_rule(&a.actor, &issue, &labels_before).await?;
        self.publish(
            "issue.updated",
            &issue.repo_id,
            &a.actor,
            Self::issue_event(&issue),
        )
        .await?;
        if let Some(assignees) = assignees {
            self.note_changes(
                &issue.repo_id,
                issue.number,
                &a.actor,
                &before,
                &assignees,
                ("assigned", "unassigned"),
            )
            .await?;
            let added: Vec<String> = assignees.iter().filter(|name| !before.contains(name)).cloned().collect();
            self.publish(
                "issue.assigned",
                &issue.repo_id,
                &a.actor,
                IssueEvent {
                    assignees: Some(assignees),
                    added: Some(added),
                    ..Self::issue_event(&issue)
                },
            )
            .await?;
        }
        Ok(Outcome::Ok(issue))
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
                    format!("An issue can be assigned to at most {MAX_ASSIGNEES} people."),
                ));
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

    /// Open issues assigned to the viewer, in every repository. Callers
    /// show only those in repositories the viewer can still see.
    async fn list_assigned_issues(&self, a: ViewerArgs) -> Result<Vec<Issue>> {
        let Some(viewer) = a.viewer else {
            return Ok(Vec::new());
        };
        let rows = self
            .db
            .prepare(format!(
                "SELECT {ISSUE_COLUMNS} FROM issues
                 WHERE state = 'open' AND EXISTS (
                   SELECT 1 FROM json_each(issues.assignees) WHERE json_each.value = ?)
                 ORDER BY updated_at DESC LIMIT 50"
            ))
            .bind(&[viewer.username.into()])?
            .all()
            .await?
            .results::<IssueRow>()?;
        Ok(rows.into_iter().map(Issue::from).collect())
    }

    async fn close_issue(&self, a: IssueActionArgs) -> Result<Outcome<Issue>> {
        let mut issue = check!(self.manageable_issue(&a.actor, &a.repo, a.number).await?);
        if issue.state == State::Closed {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This issue is already closed.",
            ));
        }
        let reason = a.reason.unwrap_or(IssueReason::Completed);
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "UPDATE issues SET state = 'closed', reason = ?, closed_at = ?, updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                reason.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
                issue.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.publish(
            "issue.closed",
            &issue.repo_id,
            &a.actor,
            IssueEvent {
                reason: Some(reason.as_str()),
                ..Self::issue_event(&issue)
            },
        )
        .await?;
        self.note(
            &issue.repo_id,
            issue.number,
            (&a.actor.id, &a.actor.username),
            match reason {
                IssueReason::Completed => "closed this as completed",
                IssueReason::NotPlanned => "closed this as not planned",
            },
        )
        .await?;
        issue.state = State::Closed;
        issue.reason = Some(reason);
        issue.closed_at = Some(now.clone());
        issue.updated_at = now;
        Ok(Outcome::Ok(issue))
    }

    async fn reopen_issue(&self, a: IssueActionArgs) -> Result<Outcome<Issue>> {
        let mut issue = check!(self.manageable_issue(&a.actor, &a.repo, a.number).await?);
        if issue.state == State::Open {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This issue is already open.",
            ));
        }
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "UPDATE issues
                 SET state = 'open', reason = NULL, resolved_by = NULL, closed_at = NULL,
                     updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[now.as_str().into(), issue.id.as_str().into()])?
            .run()
            .await?;
        self.publish(
            "issue.reopened",
            &issue.repo_id,
            &a.actor,
            Self::issue_event(&issue),
        )
        .await?;
        self.note(
            &issue.repo_id,
            issue.number,
            (&a.actor.id, &a.actor.username),
            "reopened this",
        )
        .await?;
        issue.state = State::Open;
        issue.reason = None;
        issue.resolved_by = None;
        issue.closed_at = None;
        issue.updated_at = now;
        Ok(Outcome::Ok(issue))
    }


    async fn counts(&self, a: ViewArgs) -> Result<Outcome<Counts>> {
        let read = |repo_id: String| async move {
            let query = self
                .db
                .prepare(
                    "SELECT
                       (SELECT count(*) FROM issues WHERE repo_id = ?1 AND state = 'open') AS issues,
                       (SELECT count(*) FROM pulls
                        WHERE repo_id = ?1 AND status IN ('draft', 'open')) AS pulls",
                )
                .bind(&[repo_id.into()])?;
            self.timing.db(1, query.first::<Counts>(None)).await
        };
        let (_, counts) = check!(self.repo_then(&a.repo, &a.viewer, read).await?);
        Ok(Outcome::Ok(counts.unwrap_or(Counts {
            issues: 0,
            pulls: 0,
        })))
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
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        // The number names an issue or a pull request, never both.
        let mut pull_id = None;
        // A command to g1t on a dependency update it opened (`@g1t rebase`)
        // is the security service's to act on, not a mention for an agent.
        let mut update_command = false;
        let table = if self.issue(&repo.id, a.number).await?.is_some() {
            if path.is_some() || a.verdict.is_some() {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "Only a pull request can be reviewed or commented on by line.",
                ));
            }
            "issues"
        } else if let Some(pull) = self.pull(&repo.id, a.number).await? {
            if a.verdict.is_some() && pull.is_owned_by(&a.actor.id) {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "You cannot approve or request changes on your own pull request.",
                ));
            }
            pull_id = Some(pull.id.clone());
            update_command = pull.author.is_system()
                && g1t_contracts::updates::update_command(body).is_some();
            "pulls"
        } else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "No issue or pull request has that number.",
            ));
        };

        let now = now_ms();
        let comment = Comment {
            kind: CommentKind::Comment,
            id: new_id("cmt", now),
            author: a.actor.clone(),
            body: body.to_owned(),
            path: path.map(str::to_owned),
            line,
            verdict: a.verdict,
            created_at: rfc3339(now),
            edited_at: None,
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO comments
                           (id, repo_id, number, author_id, author_name, body, path, line,
                            verdict, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        comment.id.as_str().into(),
                        repo.id.as_str().into(),
                        a.number.into(),
                        a.actor.id.as_str().into(),
                        a.actor.username.as_str().into(),
                        body.into(),
                        optional(&comment.path),
                        optional_number(line),
                        a.verdict
                            .map_or(JsValue::NULL, |verdict| verdict.as_str().into()),
                        comment.created_at.as_str().into(),
                    ])?,
                self.db
                    .prepare(format!(
                        "UPDATE {table} SET updated_at = ? WHERE repo_id = ? AND number = ?"
                    ))
                    .bind(&[
                        comment.created_at.as_str().into(),
                        repo.id.as_str().into(),
                        a.number.into(),
                    ])?,
            ])
            .await?;
        if !update_command {
            self.note_mention(&a.actor, &repo, a.number, &comment, pull_id.as_deref()).await?;
        }
        self.publish(
            "comment.created",
            &repo.id,
            &a.actor,
            CommentCreated {
                comment_id: comment.id.clone(),
                repo_id: repo.id.clone(),
                number: a.number,
                pull_id,
                verdict: a.verdict,
            },
        )
        .await?;
        Ok(Outcome::Ok(comment))
    }

    /// A comment in the repository, with the repository and the pull
    /// request it is on (if it is on one), when `actor` may edit it, or
    /// with `deleting`, delete it (`may_change_comment`).
    async fn changeable_comment(
        &self,
        a: &CommentActionArgs,
        deleting: bool,
    ) -> Result<Outcome<(Repo, CommentRow, Option<String>)>> {
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        let Some(row) = self
            .db
            .prepare("SELECT * FROM comments WHERE id = ? AND repo_id = ?")
            .bind(&[a.comment_id.trim().into(), repo.id.as_str().into()])?
            .first::<CommentRow>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Comment not found."));
        };
        let maintains = access::can(Some(&a.actor), &repo, Capability::ManageSettings);
        if let Err(refusal) = may_change_comment(
            row.kind,
            row.verdict.is_some(),
            &row.author_id,
            &a.actor.id,
            maintains,
            deleting,
        ) {
            // Someone who may change it otherwise was refused for what it is.
            let code = if row.author_id == a.actor.id || maintains { FailureCode::Conflict } else { FailureCode::Forbidden };
            return Ok(Outcome::fail(code, refusal));
        }
        let pull_id = self.pull(&repo.id, row.number).await?.map(|pull| pull.id);
        Ok(Outcome::Ok((repo, row, pull_id)))
    }

    /// Changes the text of a comment: its author's to do, or a
    /// maintainer's. Publishes `comment.edited` with what it said before.
    async fn edit_comment(&self, a: CommentActionArgs) -> Result<Outcome<Comment>> {
        let body = a.body.trim().to_owned();
        if body.chars().count() > MAX_ENTRY_CHARS {
            return Ok(Outcome::fail(FailureCode::Invalid, "That comment is too long."));
        }
        let (repo, row, pull_id) = check!(self.changeable_comment(&a, false).await?);
        // An approval speaks for itself; anything else has to say something.
        if body.is_empty() && row.verdict != Some(Verdict::Approve) {
            return Ok(Outcome::fail(FailureCode::Invalid, "A comment cannot be empty."));
        }
        let number = row.number;
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
        self.publish(
            "comment.edited",
            &repo.id,
            &a.actor,
            CommentEdited {
                comment_id: comment.id.clone(),
                repo_id: repo.id.clone(),
                number,
                pull_id,
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
        let (repo, row, pull_id) = check!(self.changeable_comment(&a, true).await?);
        self.db
            .prepare("DELETE FROM comments WHERE id = ?")
            .bind(&[row.id.as_str().into()])?
            .run()
            .await?;
        let number = row.number;
        let comment = Comment::from(row);
        self.publish(
            "comment.deleted",
            &repo.id,
            &a.actor,
            CommentDeleted {
                comment_id: comment.id.clone(),
                repo_id: repo.id.clone(),
                number,
                pull_id,
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
        // g1t's own agent at work spends the workspace's compute; a pull
        // request anyone else's agent makes is like any other.
        if matches!(a.runtime, Runtime::Hosted) {
            check!(allowed(Some(&a.actor), &repo, Capability::Run));
        }
        let issue = match a.issue {
            Some(number) => match self.issue(&repo.id, number).await? {
                Some(issue) if issue.state == State::Open => Some(issue),
                Some(_) => {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        "This issue is closed.",
                    ));
                }
                None => return Ok(no_issue()),
            },
            None => None,
        };
        // A pull request for an issue takes the issue's title unless given one.
        let title = match (a.title.trim(), &issue) {
            ("", Some(issue)) => issue.title.clone(),
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
        // The branch it merges into: the default branch unless another is
        // asked for, which has to exist.
        let base = a.base.as_deref().and_then(|base| stored_base(base, &repo));
        if let Some(base) = &base {
            if branch == Some(base.as_str()) {
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
        // The change is on a branch already pushed to the repository, or
        // will be made in a fork created for this pull request.
        let (fork, head) = match branch {
            Some(branch) => {
                if branch == base_name {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Choose a branch other than {branch}."),
                    ));
                }
                let head: Option<String> = g1t_kit::call(
                    &self.repos,
                    "head",
                    &HeadArgs {
                        repo_id: repo.id.clone(),
                        branch: branch.to_owned(),
                    },
                )
                .await?;
                let Some(head) = head else {
                    return Ok(Outcome::fail(
                        FailureCode::NotFound,
                        format!("There is no branch named {branch}. Push it first."),
                    ));
                };
                // One open pull request for each branch and base.
                let existing = self
                    .db
                    .prepare(
                        "SELECT number AS n FROM pulls
                         WHERE repo_id = ? AND source_branch = ? AND status IN ('draft', 'open')
                           AND base_branch IS ?",
                    )
                    .bind(&[repo.id.as_str().into(), branch.into(), optional(&base)])?
                    .first::<NumberRow>(None)
                    .await?;
                if let Some(existing) = existing {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        format!("Pull request #{} is already open from {branch} into {base_name}.", existing.n),
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
        let status = if branch.is_some() { "open" } else { "draft" };
        let body = Some(a.body.trim().to_owned()).filter(|body| !body.is_empty());

        let number = self.next_number(&repo.id).await?;
        let timestamp = rfc3339(now);
        // A change g1t makes is g1t's, for whoever asked for it. This is
        // what lifecycle::made_by_g1t reads back.
        let by_g1t = matches!(a.runtime, Runtime::Hosted) && agent == reviews::AGENT_NAME && fork.is_some();
        let (author, requested_by) = authorship(&a.actor, by_g1t);
        self.db
            .prepare(
                "INSERT INTO pulls
                   (id, repo_id, number, issue_id, issue_number, title, body, agent, runtime,
                    status, fork_repo_id, fork_namespace, fork_name, source_branch, head_commit,
                    author_id, author_name, requested_by_id, requested_by_name, created_at, updated_at,
                    base_branch)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                optional(&issue.as_ref().map(|issue| issue.id.clone())),
                optional_number(issue.as_ref().map(|issue| issue.number)),
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
            ])?
            .run()
            .await?;
        let Some(mut pull) = self.pull(&repo.id, number).await? else {
            return Ok(no_pull());
        };
        fill_base(&mut pull, &repo);
        self.manage(&pull).await?;
        // Someone is on it now, so it is no longer waiting for an agent.
        if let Some(issue) = pull.issue {
            self.db
                .prepare("UPDATE issues SET queued_by = NULL WHERE repo_id = ? AND number = ?")
                .bind(&[repo.id.as_str().into(), issue.into()])?
                .run()
                .await?;
        }
        if let Some(issue) = pull.issue {
            let text = if lifecycle::made_by_g1t(&pull) {
                format!("assigned this to g1t, which opened #{}", pull.number)
            } else {
                format!("opened #{} for this", pull.number)
            };
            self.note(&repo.id, issue, (&a.actor.id, &a.actor.username), &text)
                .await?;
        }
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
        let read = |repo_id: String| {
            let label = label.clone();
            async move {
                let query = self
                    .db
                    .prepare(format!(
                        "SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id = ? {filter}
                           AND (? IS NULL OR EXISTS
                             (SELECT 1 FROM json_each(pulls.labels) WHERE json_each.value = ?))
                           AND (? IS NULL OR milestone = ?)
                         ORDER BY number DESC LIMIT ?"
                    ))
                    .bind(&[
                        repo_id.into(),
                        optional(&label),
                        optional(&label),
                        optional_number(milestone),
                        optional_number(milestone),
                        LIST_PAGE.into(),
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
        let readable = self.timing.rpc(g1t_kit::call::<_, Vec<Repo>>(&self.repos, "readable", &check));
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
        let issue = found.first::<IssueRow>(prefetch::Slot::Issue)?.map(Issue::from);
        let comments: Vec<Comment> =
            found.rows::<CommentRow>(prefetch::Slot::Comments)?.into_iter().map(Comment::from).collect();
        self.keep_prefetched(Some(found));
        let default_branch = repo.default_branch.clone();
        let detail = self.pull_detail(repo, Pull::from(row), issue, comments, stored, &a.viewer).await;
        self.keep_prefetched(None);
        // The branch it merges into, named, for whoever reads it.
        Ok(match detail? {
            Outcome::Ok(mut detail) => {
                if detail.pull.base.as_deref().is_none_or(str::is_empty) {
                    detail.pull.base = Some(default_branch);
                }
                Outcome::Ok(detail)
            }
            failed => failed,
        })
    }

    async fn pull_detail(
        &self,
        repo: Repo,
        mut pull: Pull,
        issue: Option<Issue>,
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
                        let behind = self.is_behind(&repo.id, &pull).await?;
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
            let assessed = self.assess_with_confidence(&pull, &issue, behind).await?;
            let confidence = assessed.as_ref().and_then(|(_, _, confidence)| confidence.clone());
            let lifecycle = assessed.map(|(lifecycle, _, _)| lifecycle);
            Ok::<_, worker::Error>((behind, (lifecycle, confidence), merge))
        };
        let (((behind, (lifecycle, confidence), (mergeable, conflicts)), (landing, stalled), comments), (checks, overlaps, review_pending)) =
            try_join(
                try_join3(standing, self.landing_state(&pull.id), async { Ok(comments) }),
                try_join3(
                    self.latest_checks(&pull.id),
                    self.overlaps(&pull),
                    self.review_pending(&pull.id),
                ),
            )
            .await?;
        // As just worked out, rather than as it was read.
        if confidence.is_some() {
            pull.confidence = confidence;
        }
        // The rules of the branch it merges into, as they stack, and which
        // of them it does not meet yet, for whoever is looking.
        let (statuses, settings, gate) = try_join3(
            self.statuses(&repo.id, pull.head_commit.as_deref()),
            self.settings_on(&repo, &pull),
            async {
                if pull.status.is_active() {
                    self.merge_gate(&repo, &pull, viewer.as_ref(), false, true).await.map(Some)
                } else {
                    Ok(None)
                }
            },
        )
        .await?;
        let code_owners = self.pull_code_owners(&pull, &comments, &settings).await?;
        Ok(Outcome::Ok(PullDetail {
            required_checks: required_checks(&settings.required_checks, &statuses),
            rules: gate.map(|gate| rulesets::merge_rules(&gate.judged, &gate.requirements, pull.base_branch(&repo.default_branch) == repo.default_branch)),
            code_owners,
            comments,
            checks,
            overlaps,
            behind,
            review_pending,
            lifecycle,
            landing,
            stalled,
            messages: self.messages(&pull.id).await?,
            statuses,
            mergeable,
            conflicts,
            earlier_checks: self.earlier_checks(&pull.id).await?,
            issue,
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
        } else {
            check!(allowed(Some(&a.actor), &repo, Capability::Push));
        }
        let updated: Outcome<PullBranchUpdate> = g1t_kit::call(
            &self.repos,
            "update_pull_branch",
            &UpdatePullBranchArgs {
                source_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                branch: pull.branch.clone(),
                number: pull.number,
                actor: a.actor,
                target_branch: pull.base.clone(),
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
        let pull = check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?);
        // The branch it merges into, its milestone and its labels first:
        // each can be refused, and then nothing else changes.
        if a.base.is_some() || a.milestone.is_some() || a.labels.is_some() {
            let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
            if let Some(base) = &a.base {
                check!(self.change_base(&a.actor, &repo, &pull, base).await?);
            }
            if let Some(number) = a.milestone {
                check!(self.set_milestone(&a.actor, &repo, &labels::Item::Pull(pull.clone()), number).await?);
            }
            if let Some(labels) = &a.labels {
                check!(self.relabel(&a.actor, &repo, &labels::Item::Pull(pull.clone()), labels).await?);
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
                // g1t is not an account; everyone else has to be.
                let agent = names
                    .iter()
                    .any(|name| name.trim().eq_ignore_ascii_case(reviews::AGENT_NAME));
                let people = names
                    .into_iter()
                    .filter(|name| !name.trim().eq_ignore_ascii_case(reviews::AGENT_NAME))
                    .collect();
                let mut reviewers = check!(self.valid_assignees(people).await?);
                // Nobody is asked to review their own, nor what they had g1t make.
                reviewers.retain(|name| *name != pull.owner().username);
                if agent {
                    reviewers.insert(0, reviews::AGENT_NAME.to_owned());
                }
                Some(reviewers)
            }
            None => None,
        };
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
                &pull.repo_id,
                pull.number,
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
        if pull.fork_repo_id.is_none() && pull.branch.as_deref() == Some(base) {
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
            (&actor.id, &actor.username),
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
        // Whether it merges cleanly into the new base.
        if let Some(moved) = self.pull_by_id(&pull.id).await?
            && let Err(error) = self.assess_mergeability(&moved).await
        {
            worker::console_warn!("mergeability of {}: {error}", pull.id);
        }
        Ok(Outcome::Ok(()))
    }

    /// Marks a draft ready for review, or updates the description of one
    /// that already is.
    async fn ready_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let mut pull = check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?);
        let summary = Some(a.summary.trim().to_owned()).filter(|summary| !summary.is_empty());
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "UPDATE pulls SET status = 'open', body = COALESCE(?, body), updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&summary),
                now.as_str().into(),
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
                (&a.actor.id, &a.actor.username),
                "marked this ready for review",
            )
            .await?;
        }
        pull.status = PullStatus::Open;
        pull.body = summary.or(pull.body);
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
        self.db
            // What it was closed as, so that reopening brings that back.
            .prepare("UPDATE pulls SET status = 'closed', closed_from = ?, updated_at = ? WHERE id = ?")
            .bind(&[pull.status.as_str().into(), now.as_str().into(), pull.id.as_str().into()])?
            .run()
            .await?;
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
            (&a.actor.id, &a.actor.username),
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
                    pull.branch.as_deref().unwrap_or_default()
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
            (&a.actor.id, &a.actor.username),
            "reopened this",
        )
        .await?;
        pull.status = status;
        pull.superseded_by = None;
        pull.updated_at = now;
        // Whether it still merges cleanly, now that it is open again.
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
        self.db
            .prepare(
                "UPDATE pulls SET status = 'draft', land_requested = NULL, land_requested_at = NULL, updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[now.as_str().into(), pull.id.as_str().into()])?
            .run()
            .await?;
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
            (&a.actor.id, &a.actor.username),
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

    /// Lands the pull request on the repository's default branch. Unless
    /// told to keep it open, that resolves the issue it was for: the issue
    /// closes naming this pull request, and the others still in progress
    /// for it close as superseded.
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
        let base = pull.base_branch(&repo.default_branch).to_owned();
        // The rules of the branch it merges into, as they stack: the one
        // gate for the merge button, the API, MCP, auto-merge and the queue,
        // for a person's pull request and an agent's alike. A bypass counts
        // when the merger asks for it, or for g1t when a ruleset lists it.
        let gate = self.merge_gate(&repo, &pull, Some(&a.actor), a.ignore_checks, true).await?;
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
                    "This branch has conflicts with {base}{named} that must be resolved first. Have g1t resolve them, or merge {base} into it, fix them and push."
                ),
            ));
        }

        // A repository that merges through a queue: it joins the queue, and
        // lands once its state together with everything ahead has passed.
        if settings.merge_queue {
            if !a.actor.verified {
                return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
            }
            check!(allowed(Some(&a.actor), &repo, Capability::Merge));
            self.record_merge_evaluations(&repo, &pull, &gate).await;
            return self.enqueue(&repo, &pull, &a.actor, a.keep_issue_open).await;
        }

        // The default branch has moved under it. Unless the repository
        // insists on that being dealt with first, bring it up to date and
        // land it when that is done.
        if self.is_behind(&repo.id, &pull).await? {
            if settings.require_up_to_date {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!(
                        "{base} has moved since this pull request was made, and this repository requires pull requests to be up to date before they merge. Catch up with {base} first."
                    ),
                ));
            }
            if !a.actor.verified {
                return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
            }
            check!(allowed(Some(&a.actor), &repo, Capability::Merge));
            self.record_merge_evaluations(&repo, &pull, &gate).await;
            self.request_landing(&pull, &a.actor, a.keep_issue_open)
                .await?;
            return Ok(Outcome::Ok(pull));
        }

        // Whether the actor may write to the repository is decided by repos.
        let landed: Outcome<Landed> = g1t_kit::call(
            &self.repos,
            "land",
            &LandArgs {
                // A pull request from a branch lands from the repository itself.
                source_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                branch: pull.branch.clone(),
                actor: a.actor.clone(),
                target_branch: Some(base.clone()),
            },
        )
        .await?;
        let landed = check!(landed);
        self.record_merge_evaluations(&repo, &pull, &gate).await;
        Ok(Outcome::Ok(
            self.record_merge(&repo, pull, &a.actor, a.keep_issue_open, landed)
                .await?,
        ))
    }

    /// Records a pull request as merged once the default branch holds it:
    /// closes its issue, supersedes the others for it, and says so.
    pub(crate) async fn record_merge(
        &self,
        repo: &Repo,
        mut pull: Pull,
        actor: &User,
        keep_issue_open: bool,
        landed: Landed,
    ) -> Result<Pull> {
        // Only a merge into the default branch resolves the issue: into
        // another branch, the work has not landed yet.
        let keep_issue_open = keep_issue_open || !pull.targets_default(&repo.default_branch);
        let issue = match pull.issue {
            Some(number) if !keep_issue_open => self
                .issue(&repo.id, number)
                .await?
                .filter(|issue| issue.state == State::Open),
            _ => None,
        };
        let now = rfc3339(now_ms());
        let mut statements = vec![
            self.db
                .prepare(
                    "UPDATE pulls
                     SET status = 'merged', head_commit = ?, merge_base = ?, merged_by = ?,
                         merged_at = ?, updated_at = ?
                     WHERE id = ?",
                )
                .bind(&[
                    landed.commit.as_str().into(),
                    optional(&landed.previous),
                    actor.username.as_str().into(),
                    now.as_str().into(),
                    now.as_str().into(),
                    pull.id.as_str().into(),
                ])?,
        ];
        if let Some(issue) = &issue {
            statements.push(
                self.db
                    .prepare(
                        "UPDATE issues
                         SET state = 'closed', reason = 'completed', resolved_by = ?,
                             closed_at = ?, updated_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[
                        pull.number.into(),
                        now.as_str().into(),
                        now.as_str().into(),
                        issue.id.as_str().into(),
                    ])?,
            );
            statements.push(
                self.db
                    .prepare(
                        "UPDATE pulls SET status = 'closed', superseded_by = ?, updated_at = ?
                         WHERE issue_id = ? AND id != ? AND status IN ('draft', 'open')",
                    )
                    .bind(&[
                        pull.number.into(),
                        now.as_str().into(),
                        issue.id.as_str().into(),
                        pull.id.as_str().into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;

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
        if let Some(issue) = &issue {
            self.publish(
                "issue.closed",
                &repo.id,
                actor,
                IssueEvent {
                    reason: Some(IssueReason::Completed.as_str()),
                    resolved_by: Some(pull.number),
                    ..Self::issue_event(issue)
                },
            )
            .await?;
        }

        let who = (actor.id.as_str(), actor.username.as_str());
        self.note(&repo.id, pull.number, who, "merged this").await?;
        if let Some(issue) = &issue {
            self.note(
                &repo.id,
                issue.number,
                who,
                &format!("closed this by merging #{}", pull.number),
            )
            .await?;
        }
        pull.status = PullStatus::Merged;
        pull.head_commit = Some(landed.commit.clone());
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
        // The pull requests and their issues, in one round trip: their own,
        // and those g1t made for them (Pull::owner).
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
                        .prepare(format!(
                            "SELECT {ISSUE_COLUMNS} FROM issues WHERE issues.id IN (
                               SELECT issue_id FROM pulls
                               WHERE COALESCE(requested_by_id, author_id) = ?1 AND status IN ('draft', 'open') AND issue_id IS NOT NULL
                               ORDER BY updated_at DESC LIMIT 50)"
                        ))
                        .bind(&author)?,
                ]),
            )
            .await?;
        let (Some(found), Some(issues)) = (found.first(), found.get(1)) else {
            return Ok(Vec::new());
        };
        let snapshots = found.results::<Snapshot>()?;
        let pulls: Vec<Pull> = found.results::<PullRow>()?.into_iter().map(Pull::from).collect();
        let issues: Vec<Issue> = issues.results::<IssueRow>()?.into_iter().map(Issue::from).collect();
        let issues = &issues;
        // Where each stands: the remembered assessment when there is one,
        // and worked out otherwise.
        try_join_all(pulls.into_iter().zip(snapshots).map(|(pull, snapshot)| async move {
            let issue = pull.issue.and_then(|number| {
                issues
                    .iter()
                    .find(|issue| issue.repo_id == pull.repo_id && issue.number == number)
                    .cloned()
            });
            // Only a pull request g1t is seeing through has a lifecycle.
            let lifecycle = if !lifecycle::made_by_g1t(&pull) || snapshot.managed == 0 {
                None
            } else if let (Some(stage), Some(detail)) = (snapshot.stage, snapshot.stage_detail) {
                Some(Lifecycle {
                    stage,
                    detail,
                    revisions: snapshot.revisions,
                })
            } else {
                let behind = self.is_behind(&pull.repo_id, &pull).await?;
                self.assess(&pull, &issue, behind)
                    .await?
                    .map(|(lifecycle, _)| lifecycle)
            };
            Ok::<_, worker::Error>(ActivePull {
                pull,
                issue,
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
            let text: String = entry.text.chars().take(MAX_ENTRY_CHARS).collect();
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

    /// Adds entries to a pull request's session, each taking the next
    /// sequence number, without announcing it.
    pub(crate) async fn append_entries(&self, pull: &Pull, entries: &[NewSessionEntry]) -> Result<()> {
        let now = rfc3339(now_ms());
        let mut statements = Vec::with_capacity(entries.len());
        for entry in entries {
            let kind = serde_json::to_value(entry.kind)?;
            let text: String = entry.text.chars().take(MAX_ENTRY_CHARS).collect();
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
                        optional(&entry.commit.clone().or_else(|| pull.head_commit.clone())),
                        now.as_str().into(),
                        pull.id.as_str().into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;
        Ok(())
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
        // A new repository starts with the default labels.
        if event.kind == "repo.created"
            && let Some(repo_id) = event.repo_id.as_deref()
        {
            return self.seed_labels(repo_id).await;
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
        // whatever step g1t was waiting on has been taken.
        let moved = "UPDATE pulls
             SET head_commit = ?, updated_at = ?, head_pushed_by = ?, head_pushed_at = ?, check_status = NULL, check_run_id = NULL,
                 working_on = NULL, working_until = NULL, stalled = NULL";
        let active = "status IN ('draft', 'open') AND head_commit IS NOT ?";
        let returning =
            "RETURNING id, repo_id, number, issue_number, status, author_id, author_name, requested_by_id, requested_by_name";
        let mut pulls: Vec<MovedRow> = Vec::new();
        // A fork carries its pull request on its default branch.
        if event.data["defaultBranch"].as_bool() == Some(true) {
            pulls.extend(
                self.db
                    .prepare(format!(
                        "{moved} WHERE fork_repo_id = ? AND {active} {returning}"
                    ))
                    .bind(&[
                        after.into(),
                        now.as_str().into(),
                        pusher.clone(),
                        now.as_str().into(),
                        repo_id.into(),
                        after.into(),
                    ])?
                    .all()
                    .await?
                    .results::<MovedRow>()?,
            );
        }
        if let Some(branch) = git_ref.strip_prefix("refs/heads/") {
            pulls.extend(
                self.db
                    .prepare(format!(
                        "{moved} WHERE repo_id = ? AND source_branch = ? AND {active} {returning}"
                    ))
                    .bind(&[
                        after.into(),
                        now.as_str().into(),
                        pusher.clone(),
                        now.as_str().into(),
                        repo_id.into(),
                        branch.into(),
                        after.into(),
                    ])?
                    .all()
                    .await?
                    .results::<MovedRow>()?,
            );
        }
        // What each now changes, so overlaps show while the work is under way.
        for moved in &pulls {
            if let Some(mut pull) = self.pull_by_id(&moved.id).await? {
                pull.files = self.refresh_files(&pull).await?;
                // Owners of files it now changes are asked too.
                self.refresh_code_owners(&pull).await;
            }
        }
        // A merge that was waiting for this push to bring it up to date.
        for moved in &pulls {
            self.land_if_requested(&moved.id).await?;
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
        // A draft is announced when it is marked ready instead.
        for pull in pulls
            .into_iter()
            .filter(|pull| pull.status == PullStatus::Open)
        {
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
                    issue: pull.issue_number,
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
        timing: g1t_kit::d1::Timing::default(),
        prefetched: std::cell::RefCell::new(None),
        known_repos: std::cell::RefCell::new(std::collections::HashMap::new()),
    })
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    // A replica near the caller when it asks for one (crates/kit/src/d1.rs).
    let (db, served) = g1t_kit::d1::open(&env, "DB", &request)?;
    let body: serde_json::Value = request.json().await?;
    let mut work = service(&env)?;
    work.db = db;

    let answered = match method.as_str() {
        "open_issue" => reply(&work.open_issue(args(body)?).await?),
        "delegate_issue" => reply(&work.delegate_issue(args(body)?).await?),
        "report_confidence" => reply(&work.report_confidence(args(body)?).await?),
        "list_issues" => reply(&work.list_issues(args(body)?).await?),
        "get_issue" => reply(&work.get_issue(args(body)?).await?),
        "update_issue" => reply(&work.update_issue(args(body)?).await?),
        "close_issue" => reply(&work.close_issue(args(body)?).await?),
        "reopen_issue" => reply(&work.reopen_issue(args(body)?).await?),
        "list_labels" => reply(&work.list_labels(args(body)?).await?),
        "save_label" => reply(&work.save_label(args(body)?).await?),
        "delete_label" => reply(&work.delete_label(args(body)?).await?),
        "add_default_labels" => reply(&work.add_default_labels(args(body)?).await?),
        "set_labels" => reply(&work.set_labels(args(body)?).await?),
        "list_milestones" => reply(&work.list_milestones(args(body)?).await?),
        "get_milestone" => reply(&work.get_milestone(args(body)?).await?),
        "save_milestone" => reply(&work.save_milestone(args(body)?).await?),
        "delete_milestone" => reply(&work.delete_milestone(args(body)?).await?),
        "counts" => reply(&work.counts(args(body)?).await?),
        "add_comment" => reply(&work.add_comment(args(body)?).await?),
        "edit_comment" => reply(&work.edit_comment(args(body)?).await?),
        "delete_comment" => reply(&work.delete_comment(args(body)?).await?),
        "start_checks" => reply(&work.start_checks(args(body)?).await?),
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
        "start_review" => reply(&work.start_review(args(body)?).await?),
        "advance" => reply(&work.advance(args(body)?).await?),
        "stall" => reply(&work.stall(args(body)?).await?),
        "managed_pulls" => reply(&work.managed_pulls(args(body)?).await?),
        "queue" => reply(&work.queue(args(body)?).await?),
        "queue_build" => reply(&work.queue_build(args(body)?).await?),
        "report_queue" => reply(&work.report_queue(args(body)?).await?),
        "remove_from_queue" => reply(&work.remove_from_queue(args(body)?).await?),
        "message_agent" => reply(&work.message_agent(args(body)?).await?),
        "locate_pull" => reply(&work.locate_pull(args(body)?).await?),
        "inbox_subject" => reply(&work.inbox_subject(args(body)?).await?),
        "answer_message" => reply(&work.answer_message(args(body)?).await?),
        "take_messages" => reply(&work.take_messages(args(body)?).await?),
        "wake_for_messages" => reply(&work.wake_for_messages(args(body)?).await?),
        "catch_up_job" => reply(&work.catch_up_job(args(body)?).await?),
        "get_settings" => reply(&work.get_settings(args(body)?).await?),
        "codeowners_errors" => reply(&work.codeowners_errors(args(body)?).await?),
        "update_settings" => reply(&work.update_settings(args(body)?).await?),
        "report_review" => reply(&work.report_review(args(body)?).await?),
        "open_pull" => reply(&work.open_pull(args(body)?).await?),
        "list_pulls" => reply(&work.list_pulls(args(body)?).await?),
        "pulls_for_repos" => reply(&work.pulls_for_repos(args(body)?).await?),
        "get_pull" => reply(&work.get_pull(args(body)?).await?),
        "update_pull" => reply(&work.update_pull(args(body)?).await?),
        "catch_up_pull" => reply(&work.catch_up_pull(args(body)?).await?),
        "ready_pull" => reply(&work.ready_pull(args(body)?).await?),
        "close_pull" => reply(&work.close_pull(args(body)?).await?),
        "reopen_pull" => reply(&work.reopen_pull(args(body)?).await?),
        "convert_pull_to_draft" => reply(&work.convert_pull_to_draft(args(body)?).await?),
        "merge_pull" => reply(&work.merge_pull(args(body)?).await?),
        "list_active_pulls" => reply(&work.list_active_pulls(args(body)?).await?),
        "by_author" => reply(&work.by_author(args(body)?).await?),
        "start_plan" => reply(&work.start_plan(args(body)?).await?),
        "report_plan" => reply(&work.report_plan(args(body)?).await?),
        "get_plan" => reply(&work.get_plan(args(body)?).await?),
        "list_plans" => reply(&work.list_plans(args(body)?).await?),
        "apply_plan" => reply(&work.apply_plan(args(body)?).await?),
        "queue_issue" => reply(&work.queue_issue(args(body)?).await?),
        "ready_issues" => reply(&work.ready_issues(args(body)?).await?),
        "list_assigned_issues" => reply(&work.list_assigned_issues(args(body)?).await?),
        "append_session" => reply(&work.append_session(args(body)?).await?),
        "read_session" => reply(&work.read_session(args(body)?).await?),
        // Agents at work, their sessions, and memory (runs.rs, memory.rs).
        "open_run" => reply(&work.open_run(args(body)?).await?),
        "report_run" => reply(&work.report_run(args(body)?).await?),
        "stop_run" => reply(&work.stop_run(args(body)?).await?),
        "list_runs" => reply(&work.list_runs(args(body)?).await?),
        "get_run" => reply(&work.get_run(args(body)?).await?),
        "list_sessions" => reply(&work.list_sessions(args(body)?).await?),
        "get_session" => reply(&work.get_session(args(body)?).await?),
        "list_memories" => reply(&work.list_memories(args(body)?).await?),
        "add_memory" => reply(&work.add_memory(args(body)?).await?),
        "update_memory" => reply(&work.update_memory(args(body)?).await?),
        "delete_memory" => reply(&work.delete_memory(args(body)?).await?),
        "recall" => reply(&work.recall(args(body)?).await?),
        "memory_context" => reply(&work.memory_context(args(body)?).await?),
        // What agents may do in a sandbox (guardrails.rs).
        "get_guardrails" => reply(&work.get_guardrails(args(body)?).await?),
        "update_guardrails" => reply(&work.update_guardrails(args(body)?).await?),
        "run_guardrails" => reply(&work.run_guardrails(args(body)?).await?),
        // Plan caps the runner applies (compute.rs).
        "active_agents" => reply(&work.active_agents(args(body)?).await?),
        "issue_spend" => reply(&work.issue_spend(args(body)?).await?),
        "wait_for_slot" => reply(&work.wait_for_slot(args(body)?).await?),
        "agent_comment" => reply(&work.agent_comment(args(body)?).await?),
        "add_wait" => reply(&work.add_wait(args(body)?).await?),
        "waiting_workspaces" => reply(&work.waiting_workspaces(args(body)?).await?),
        "take_wait" => reply(&work.take_wait(args(body)?).await?),
        // The runs whose sandboxes stop with their repository (retired.rs).
        "runs_in_repo" => reply(&work.runs_in_repo(args(body)?).await?),
        "run_cost" => reply(&work.run_cost(args(body)?).await?),
        "start_mergecheck" => reply(&work.start_mergecheck(args(body)?).await?),
        "report_mergecheck" => reply(&work.report_mergecheck(args(body)?).await?),
        // Memory that fills itself, and its review queue (capture.rs).
        method if capture::METHODS.contains(&method) => capture::dispatch(&work, method, body).await,
        // @g1t in comments, and the label rule (mentions.rs).
        "take_mention" => reply(&work.take_mention(args(body)?).await?),
        "mention_revision" => reply(&work.mention_revision(args(body)?).await?),
        "reply_mention" => reply(&work.reply_mention(args(body)?).await?),
        "get_agent_rules" => reply(&work.get_agent_rules(args(body)?).await?),
        "set_agent_rules" => reply(&work.set_agent_rules(args(body)?).await?),
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

/// Events from the bus, delivered on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let work = service(&env)?;
    for message in batch.messages()? {
        // A workspace renamed: its agent runs and memory move to the slug it has now.
        if g1t_kit::rename::on_event(&env, &env.d1("DB")?, message.body(), &[memory::RENAMED, guardrails::RENAMED, rulesets::RENAMED].concat()).await? {
            message.ack();
            continue;
        }
        // A repository renamed or transferred: its runs, memory, guardrails
        // and runs waiting for a slot follow.
        if g1t_kit::transfer::on_event(&env, &env.d1("DB")?, message.body(), &[memory::TRANSFERRED, guardrails::TRANSFERRED, retired::WAITS_MOVED].concat()).await? {
            message.ack();
            continue;
        }
        // A workspace deleted: what it kept for itself goes.
        if g1t_kit::deleted::on_event(&env.d1("DB")?, message.body(), memory::DELETED).await? {
            message.ack();
            continue;
        }
        // A repository deleted, archived or purged, or a branch renamed (retired.rs).
        if work.on_retired(message.body()).await? {
            message.ack();
            continue;
        }
        capture::on_event(&work, message.body()).await;
        work.on_event(message.body()).await?;
        message.ack();
    }
    Ok(())
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
        // append_session, and steering with message_agent: theirs to do.
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
        // LifecycleJob, ReviewJob, MergecheckJob and the merge queue's job
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
