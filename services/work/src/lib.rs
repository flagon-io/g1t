//! The work service: issues, pull requests, comments and sessions.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::work` for the methods and their arguments. It also
//! consumes its queue of events from the bus.

mod checks;
mod lifecycle;
mod plans;
mod messages;
mod queue;
mod reviews;
mod rows;
mod settings;
mod statuses;

use g1t_contracts::events::{
    CommentCreated, Event, IssueEvent, NewEvent, Publish, PullEvent, SessionAppended,
};
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{ForkArgs, GetArgs, HeadArgs, LandArgs, Landed, Repo, RepoPath};
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

use rows::{CommentRow, IssueRow, MovedRow, NumberRow, PullRow, SessionRow, Snapshot, ValueRow};

const SOURCE: &str = "work";
const MAX_ENTRY_BATCH: usize = 200;
const MAX_ENTRY_CHARS: usize = 64_000;
const MAX_TITLE_CHARS: usize = 200;
const SESSION_PAGE: u32 = 500;
const LIST_PAGE: u32 = 100;
const MAX_ASSIGNEES: usize = 10;
const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

const ISSUE_COLUMNS: &str = "issues.*,
  (SELECT count(*) FROM pulls WHERE pulls.issue_id = issues.id) AS pull_count,
  (SELECT agent FROM pulls
   WHERE pulls.issue_id = issues.id AND pulls.status IN ('draft', 'open')
     AND pulls.fork_repo_id IS NOT NULL
   ORDER BY pulls.number DESC LIMIT 1) AS agent,
  (SELECT count(*) FROM comments
   WHERE comments.repo_id = issues.repo_id AND comments.number = issues.number
     AND comments.kind = 'comment') AS comment_count";

fn no_issue<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Issue not found.")
}

fn no_pull<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Pull request not found.")
}

fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

fn optional_number(value: Option<u32>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
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
}

impl Work {
    async fn publish<T: Serialize>(
        &self,
        kind: &'static str,
        repo_id: &str,
        actor: &User,
        data: T,
    ) -> Result<()> {
        self.publish_as(kind, repo_id, Some(actor.id.clone()), data)
            .await
    }

    /// A pull request's author as a viewer who can read its repository and
    /// source. Stored authors carry no memberships, so a private repository
    /// would otherwise look missing to them.
    pub(crate) async fn author_viewer(&self, pull: &Pull) -> Result<Viewer> {
        let path: Option<RepoPath> = g1t_kit::call(
            &self.repos,
            "path_by_id",
            &g1t_contracts::repos::PathByIdArgs { id: pull.repo_id.clone() },
        )
        .await?;
        let mut author = pull.author.clone();
        if let Some(path) = path
            && !author.is_member(&path.namespace.to_lowercase())
        {
            author.workspaces.push(g1t_contracts::Membership {
                slug: path.namespace.to_lowercase(),
                role: g1t_contracts::Role::Member,
            });
        }
        Ok(Some(author))
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
        g1t_kit::call(
            &self.repos,
            "get",
            &GetArgs {
                path: path.clone(),
                viewer: viewer.clone(),
            },
        )
        .await
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
            .prepare("SELECT * FROM pulls WHERE repo_id = ? AND number = ?")
            .bind(&[repo_id.into(), number.into()])?
            .first::<PullRow>(None)
            .await?
            .map(Pull::from))
    }

    async fn comments(&self, repo_id: &str, number: u32) -> Result<Vec<Comment>> {
        let rows = self
            .db
            .prepare(
                "SELECT * FROM comments WHERE repo_id = ? AND number = ? ORDER BY id LIMIT 500",
            )
            .bind(&[repo_id.into(), number.into()])?
            .all()
            .await?
            .results::<CommentRow>()?;
        Ok(rows.into_iter().map(Comment::from).collect())
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
    /// "assigned ana" or "requested a review from g1t-agent".
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
            ..IssueEvent::default()
        }
    }

    fn pull_event(pull: &Pull) -> PullEvent {
        PullEvent {
            pull_id: pull.id.clone(),
            repo_id: pull.repo_id.clone(),
            number: pull.number,
            issue: pull.issue,
            ..PullEvent::default()
        }
    }

    // --- Issues ------------------------------------------------------------

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
                "An issue can have up to 10 labels of up to 40 characters each.",
            ));
        };
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        let checks: Vec<&str> = a
            .checks
            .iter()
            .map(|check| check.trim())
            .filter(|check| !check.is_empty())
            .collect();

        let now = now_ms();
        let id = new_id("iss", now);
        let number = self.next_number(&repo.id).await?;
        let timestamp = rfc3339(now);
        self.db
            .prepare(
                "INSERT INTO issues
                   (id, repo_id, number, title, body, labels, checks, author_id, author_name,
                    created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                title.into(),
                a.body.trim().into(),
                serde_json::to_string(&labels)?.into(),
                serde_json::to_string(&checks)?.into(),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(issue) = self.issue(&repo.id, number).await? else {
            return Ok(no_issue());
        };
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
        Ok(Outcome::Ok(issue))
    }

    async fn list_issues(&self, a: ListIssuesArgs) -> Result<Outcome<Vec<Issue>>> {
        let repo = check!(self.repo(&a.repo, &a.viewer).await?);
        let state = state_name(a.state).map_or(JsValue::NULL, JsValue::from);
        let label = a
            .label
            .map(|label| label.trim().to_lowercase())
            .filter(|label| !label.is_empty());
        let rows = self
            .db
            .prepare(format!(
                "SELECT {ISSUE_COLUMNS} FROM issues
                 WHERE repo_id = ? AND (? IS NULL OR state = ?)
                   AND (? IS NULL OR EXISTS
                     (SELECT 1 FROM json_each(issues.labels) WHERE json_each.value = ?))
                 ORDER BY number DESC LIMIT ?"
            ))
            .bind(&[
                repo.id.into(),
                state.clone(),
                state,
                optional(&label),
                optional(&label),
                LIST_PAGE.into(),
            ])?
            .all()
            .await?
            .results::<IssueRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(Issue::from).collect()))
    }

    async fn get_issue(&self, a: ViewArgs) -> Result<Outcome<IssueDetail>> {
        let (repo, issue) = check!(self.issue_at(&a.repo, a.number, &a.viewer).await?);
        let pulls = self
            .db
            .prepare("SELECT * FROM pulls WHERE issue_id = ? ORDER BY number")
            .bind(&[issue.id.as_str().into()])?
            .all()
            .await?
            .results::<PullRow>()?;
        Ok(Outcome::Ok(IssueDetail {
            comments: self.comments(&repo.id, issue.number).await?,
            pulls: pulls.into_iter().map(Pull::from).collect(),
            issue,
        }))
    }

    /// The issue, if `actor` wrote it or belongs to the repository's workspace.
    async fn manageable_issue(
        &self,
        actor: &User,
        path: &RepoPath,
        number: u32,
    ) -> Result<Outcome<Issue>> {
        let (repo, issue) = check!(self.issue_at(path, number, &Some(actor.clone())).await?);
        if issue.author.id != actor.id && !actor.is_member(&repo.namespace) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only the author or a member of the workspace can change an issue.",
            ));
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
        let labels = match a.labels.as_deref().map(normalize_labels) {
            Some(None) => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "An issue can have up to 10 labels of up to 40 characters each.",
                ));
            }
            Some(Some(labels)) => Some(serde_json::to_string(&labels)?),
            None => None,
        };
        let assignees = match a.assignees {
            Some(names) => Some(check!(self.valid_assignees(names).await?)),
            None => None,
        };
        let assigned = assignees.as_ref().map(serde_json::to_string).transpose()?;
        let body = a.body.map(|body| body.trim().to_owned());
        self.db
            .prepare(
                "UPDATE issues
                 SET title = COALESCE(?, title), body = COALESCE(?, body),
                     labels = COALESCE(?, labels), assignees = COALESCE(?, assignees),
                     updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&title),
                optional(&body),
                optional(&labels),
                optional(&assigned),
                rfc3339(now_ms()).into(),
                issue.id.as_str().into(),
            ])?
            .run()
            .await?;
        let before = issue.assignees.clone();
        let Some(issue) = self.issue(&issue.repo_id, issue.number).await? else {
            return Ok(no_issue());
        };
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
            self.publish(
                "issue.assigned",
                &issue.repo_id,
                &a.actor,
                IssueEvent {
                    assignees: Some(assignees),
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

    /// The default labels, then every other label in use on the repository.
    async fn list_labels(&self, a: ViewArgs) -> Result<Outcome<Vec<String>>> {
        let repo = check!(self.repo(&a.repo, &a.viewer).await?);
        let used = self
            .db
            .prepare(
                "SELECT DISTINCT json_each.value AS value
                 FROM issues, json_each(issues.labels)
                 WHERE issues.repo_id = ? ORDER BY 1 LIMIT 200",
            )
            .bind(&[repo.id.into()])?
            .all()
            .await?
            .results::<ValueRow>()?;
        let mut labels: Vec<String> = DEFAULT_LABELS.iter().map(|label| (*label).into()).collect();
        for row in used {
            if !labels.contains(&row.value) {
                labels.push(row.value);
            }
        }
        Ok(Outcome::Ok(labels))
    }

    async fn counts(&self, a: ViewArgs) -> Result<Outcome<Counts>> {
        let repo = check!(self.repo(&a.repo, &a.viewer).await?);
        let counts = self
            .db
            .prepare(
                "SELECT
                   (SELECT count(*) FROM issues WHERE repo_id = ? AND state = 'open') AS issues,
                   (SELECT count(*) FROM pulls
                    WHERE repo_id = ? AND status IN ('draft', 'open')) AS pulls",
            )
            .bind(&[repo.id.as_str().into(), repo.id.as_str().into()])?
            .first::<Counts>(None)
            .await?;
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
        // The number names an issue or a pull request, never both.
        let mut pull_id = None;
        let table = if self.issue(&repo.id, a.number).await?.is_some() {
            if path.is_some() || a.verdict.is_some() {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "Only a pull request can be reviewed or commented on by line.",
                ));
            }
            "issues"
        } else if let Some(pull) = self.pull(&repo.id, a.number).await? {
            if a.verdict.is_some() && pull.author.id == a.actor.id {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "You cannot approve or request changes on your own pull request.",
                ));
            }
            pull_id = Some(pull.id.clone());
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

    // --- Pull requests -----------------------------------------------------

    async fn open_pull(&self, a: OpenPullArgs) -> Result<Outcome<Pull>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
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
        let agent = match a.agent.trim() {
            "" => "agent",
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
        // The change is on a branch already pushed to the repository, or
        // will be made in a fork created for this pull request.
        let (fork, head) = match branch {
            Some(branch) => {
                if branch == repo.default_branch {
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
                let existing = self
                    .db
                    .prepare(
                        "SELECT number AS n FROM pulls
                         WHERE repo_id = ? AND source_branch = ? AND status IN ('draft', 'open')",
                    )
                    .bind(&[repo.id.as_str().into(), branch.into()])?
                    .first::<NumberRow>(None)
                    .await?;
                if let Some(existing) = existing {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        format!("Pull request #{} is already open for {branch}.", existing.n),
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
        self.db
            .prepare(
                "INSERT INTO pulls
                   (id, repo_id, number, issue_id, issue_number, title, body, agent, runtime,
                    status, fork_repo_id, fork_namespace, fork_name, source_branch, head_commit,
                    author_id, author_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(pull) = self.pull(&repo.id, number).await? else {
            return Ok(no_pull());
        };
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
                format!("assigned this to g1t-agent, which opened #{}", pull.number)
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
                ..Self::pull_event(&pull)
            },
        )
        .await?;
        Ok(Outcome::Ok(pull))
    }

    async fn list_pulls(&self, a: ListPullsArgs) -> Result<Outcome<Vec<Pull>>> {
        let repo = check!(self.repo(&a.repo, &a.viewer).await?);
        let filter = match a.state {
            Some(State::Open) => "AND status IN ('draft', 'open')",
            Some(State::Closed) => "AND status IN ('merged', 'closed')",
            None => "",
        };
        let rows = self
            .db
            .prepare(format!(
                "SELECT * FROM pulls WHERE repo_id = ? {filter} ORDER BY number DESC LIMIT ?"
            ))
            .bind(&[repo.id.into(), LIST_PAGE.into()])?
            .all()
            .await?
            .results::<PullRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(Pull::from).collect()))
    }

    async fn get_pull(&self, a: ViewArgs) -> Result<Outcome<PullDetail>> {
        let (repo, pull) = check!(self.pull_at(&a.repo, a.number, &a.viewer).await?);
        let issue = match pull.issue {
            Some(number) => self.issue(&repo.id, number).await?,
            None => None,
        };
        let mut pull = pull;
        // Worked out on each push; this covers a pull request from before
        // that was recorded.
        if pull.files.is_empty() && pull.head_commit.is_some() {
            pull.files = self.refresh_files(&pull).await?;
        }
        // Everything else at once: none of it depends on the rest, and each
        // is a round trip of its own.
        let standing = async {
            let behind = self.is_behind(&repo.id, &pull).await?;
            let lifecycle = self
                .assess(&pull, &issue, behind)
                .await?
                .map(|(lifecycle, _)| lifecycle);
            Ok::<_, worker::Error>((behind, lifecycle))
        };
        let (((behind, lifecycle), (landing, stalled), comments), (checks, overlaps, review_pending)) =
            try_join(
                try_join3(standing, self.landing_state(&pull.id), self.comments(&repo.id, pull.number)),
                try_join3(
                    self.latest_checks(&pull.id),
                    self.overlaps(&pull),
                    self.review_pending(&pull.id),
                ),
            )
            .await?;
        Ok(Outcome::Ok(PullDetail {
            comments,
            checks,
            overlaps,
            behind,
            review_pending,
            lifecycle,
            landing,
            stalled,
            messages: self.messages(&pull.id).await?,
            statuses: self.statuses(&repo.id, pull.head_commit.as_deref()).await?,
            issue,
            pull,
        }))
    }

    /// The pull request, if it is still active and `actor` opened it or
    /// belongs to the repository's workspace.
    async fn manageable_pull(
        &self,
        actor: &User,
        path: &RepoPath,
        number: u32,
    ) -> Result<Outcome<Pull>> {
        let (repo, pull) = check!(self.pull_at(path, number, &Some(actor.clone())).await?);
        if pull.author.id != actor.id && !actor.is_member(&repo.namespace) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only whoever opened a pull request, or a member of the workspace, can change it.",
            ));
        }
        if !pull.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This pull request is already {}.", pull.status.as_str()),
            ));
        }
        Ok(Outcome::Ok(pull))
    }

    async fn update_pull(&self, a: UpdatePullArgs) -> Result<Outcome<Pull>> {
        let pull = check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?);
        let assignees = match a.assignees {
            Some(names) => Some(check!(self.valid_assignees(names).await?)),
            None => None,
        };
        let reviewers = match a.reviewers {
            Some(names) => {
                // A g1t agent is not an account; everyone else has to be.
                let agent = names
                    .iter()
                    .any(|name| name.trim().eq_ignore_ascii_case(reviews::AGENT_NAME));
                let people = names
                    .into_iter()
                    .filter(|name| !name.trim().eq_ignore_ascii_case(reviews::AGENT_NAME))
                    .collect();
                let mut reviewers = check!(self.valid_assignees(people).await?);
                reviewers.retain(|name| *name != pull.author.username);
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
                 SET assignees = COALESCE(?, assignees), reviewers = COALESCE(?, reviewers),
                     updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&assignees.as_ref().map(serde_json::to_string).transpose()?),
                optional(&reviewers.as_ref().map(serde_json::to_string).transpose()?),
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
        if let Some(reviewers) = &reviewers {
            self.note_changes(
                &pull.repo_id,
                pull.number,
                &a.actor,
                &pull.reviewers,
                reviewers,
                (
                    "requested a review from",
                    "withdrew the request for a review from",
                ),
            )
            .await?;
        }
        Ok(match self.pull(&pull.repo_id, pull.number).await? {
            Some(pull) => Outcome::Ok(pull),
            None => no_pull(),
        })
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
            self.publish(
                "pull.ready",
                &pull.repo_id,
                &a.actor,
                Self::pull_event(&pull),
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
        Ok(Outcome::Ok(pull))
    }

    async fn close_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let mut pull = check!(self.manageable_pull(&a.actor, &a.repo, a.number).await?);
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE pulls SET status = 'closed', updated_at = ? WHERE id = ?")
            .bind(&[now.as_str().into(), pull.id.as_str().into()])?
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

    /// Lands the pull request on the repository's default branch. Unless
    /// told to keep it open, that resolves the issue it was for: the issue
    /// closes naming this pull request, and the others still in progress
    /// for it close as superseded.
    async fn merge_pull(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        let viewer = Some(a.actor.clone());
        let (repo, pull) = check!(self.pull_at(&a.repo, a.number, &viewer).await?);
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
        let settings = self.settings(&repo.id).await?;
        // Where the repository does not allow it, asking to ignore the
        // checks changes nothing.
        if !a.ignore_checks || !settings.allow_ignoring_checks {
            let waiting = match pull.check_status {
                Some(CheckStatus::Queued | CheckStatus::Running) => {
                    Some("The acceptance checks are still running.")
                }
                Some(CheckStatus::Failed) => Some("The acceptance checks did not pass."),
                Some(CheckStatus::Errored) => Some("The acceptance checks could not be run."),
                Some(CheckStatus::Passed) | None => None,
            };
            // Workflows run on its head count as checks too.
            let workflows = statuses::WorkflowFacts::of(&self.statuses(&repo.id, pull.head_commit.as_deref()).await?).refusal();
            let waiting = waiting.map(str::to_owned).or(workflows);
            if let Some(reason) = waiting {
                let remedy = if settings.allow_ignoring_checks {
                    "Wait or fix them, or merge anyway by ignoring the checks."
                } else {
                    "This repository only merges pull requests whose checks pass."
                };
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("{reason} {remedy}"),
                ));
            }
        }
        if let Some(missing) = self.approvals_gap(&settings, &pull).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, missing));
        }

        // A repository that merges through a queue: it joins the queue, and
        // lands once its state together with everything ahead has passed.
        if settings.merge_queue {
            if !a.actor.verified {
                return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
            }
            if !a.actor.is_member(&repo.namespace) {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "Only members of the repository's workspace can merge a pull request.",
                ));
            }
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
                        "{} has moved since this pull request was made, and this repository requires pull requests to be up to date before they merge. Catch up with {0} first.",
                        repo.default_branch
                    ),
                ));
            }
            if !a.actor.verified {
                return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
            }
            if !a.actor.is_member(&repo.namespace) {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "Only members of the repository's workspace can merge a pull request.",
                ));
            }
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
            },
        )
        .await?;
        let landed = check!(landed);
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
        let found = self
            .db
            .prepare(
                "SELECT * FROM pulls
                 WHERE author_id = ? AND status IN ('draft', 'open')
                 ORDER BY updated_at DESC LIMIT 50",
            )
            .bind(&[viewer.id.into()])?
            .all()
            .await?;
        let snapshots = found.results::<Snapshot>()?;
        let pulls: Vec<Pull> = found.results::<PullRow>()?.into_iter().map(Pull::from).collect();
        // Each one at once: its issue, and where it stands. That is the
        // remembered assessment when there is one, and worked out otherwise.
        try_join_all(pulls.into_iter().zip(snapshots).map(|(pull, snapshot)| async move {
            let issue = match pull.issue {
                Some(number) => self.issue(&pull.repo_id, number).await?,
                None => None,
            };
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
        if pull.author.id != a.actor.id {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only whoever opened a pull request can record its session.",
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
        // The head moved, so whatever the checks said no longer applies, and
        // whatever step g1t was waiting on has been taken.
        let moved = "UPDATE pulls
             SET head_commit = ?, updated_at = ?, check_status = NULL, check_run_id = NULL,
                 working_on = NULL, working_until = NULL, stalled = NULL";
        let active = "status IN ('draft', 'open') AND head_commit IS NOT ?";
        let returning = "RETURNING id, repo_id, number, issue_number, status";
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
            if let Some(pull) = self.pull_by_id(&moved.id).await? {
                self.refresh_files(&pull).await?;
            }
        }
        // A merge that was waiting for this push to bring it up to date.
        for moved in &pulls {
            self.land_if_requested(&moved.id).await?;
        }
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
                    pull_id: pull.id,
                    repo_id: pull.repo_id.clone(),
                    number: pull.number,
                    issue: pull.issue_number,
                    commit: Some(after.to_owned()),
                    ..PullEvent::default()
                },
            )
            .await?;
        }
        Ok(())
    }
}

fn service(env: &Env) -> Result<Work> {
    Ok(Work {
        db: env.d1("DB")?,
        identity: env.service("IDENTITY")?,
        repos: env.service("REPOS")?,
        events: env.service("EVENTS")?,
        actions: env.service("ACTIONS")?,
    })
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: serde_json::Value = request.json().await?;
    let work = service(&env)?;

    match method.as_str() {
        "open_issue" => reply(&work.open_issue(args(body)?).await?),
        "list_issues" => reply(&work.list_issues(args(body)?).await?),
        "get_issue" => reply(&work.get_issue(args(body)?).await?),
        "update_issue" => reply(&work.update_issue(args(body)?).await?),
        "close_issue" => reply(&work.close_issue(args(body)?).await?),
        "reopen_issue" => reply(&work.reopen_issue(args(body)?).await?),
        "list_labels" => reply(&work.list_labels(args(body)?).await?),
        "counts" => reply(&work.counts(args(body)?).await?),
        "add_comment" => reply(&work.add_comment(args(body)?).await?),
        "start_checks" => reply(&work.start_checks(args(body)?).await?),
        "report_checks" => reply(&work.report_checks(args(body)?).await?),
        "set_commit_status" => reply(&work.set_commit_status(args(body)?).await?),
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
        "answer_message" => reply(&work.answer_message(args(body)?).await?),
        "take_messages" => reply(&work.take_messages(args(body)?).await?),
        "catch_up_job" => reply(&work.catch_up_job(args(body)?).await?),
        "get_settings" => reply(&work.get_settings(args(body)?).await?),
        "update_settings" => reply(&work.update_settings(args(body)?).await?),
        "report_review" => reply(&work.report_review(args(body)?).await?),
        "open_pull" => reply(&work.open_pull(args(body)?).await?),
        "list_pulls" => reply(&work.list_pulls(args(body)?).await?),
        "get_pull" => reply(&work.get_pull(args(body)?).await?),
        "update_pull" => reply(&work.update_pull(args(body)?).await?),
        "ready_pull" => reply(&work.ready_pull(args(body)?).await?),
        "close_pull" => reply(&work.close_pull(args(body)?).await?),
        "merge_pull" => reply(&work.merge_pull(args(body)?).await?),
        "list_active_pulls" => reply(&work.list_active_pulls(args(body)?).await?),
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
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, delivered on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let work = service(&env)?;
    for message in batch.messages()? {
        work.on_event(message.body()).await?;
        message.ack();
    }
    Ok(())
}
