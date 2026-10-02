//! The work service: issues, pull requests, comments and sessions.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::work` for the methods and their arguments. It also
//! consumes its queue of events from the bus.

mod rows;

use g1t_contracts::events::{
    CommentCreated, Delivered, IssueEvent, NewEvent, PullEvent, SessionAppended,
};
use g1t_contracts::repos::{ForkArgs, GetArgs, LandArgs, Landed, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::{args, js, now_ms, reply, rpc_method};
use serde::Serialize;
use worker::wasm_bindgen::JsValue;
use worker::{
    Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, event,
};

use rows::{CommentRow, IssueRow, NumberRow, PullRow, SessionRow, ValueRow};

const SOURCE: &str = "work";
const MAX_ENTRY_BATCH: usize = 200;
const MAX_ENTRY_CHARS: usize = 64_000;
const MAX_TITLE_CHARS: usize = 200;
const SESSION_PAGE: u32 = 500;
const LIST_PAGE: u32 = 100;
const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

const ISSUE_COLUMNS: &str = "issues.*,
  (SELECT count(*) FROM pulls WHERE pulls.issue_id = issues.id) AS pull_count,
  (SELECT count(*) FROM comments
   WHERE comments.repo_id = issues.repo_id AND comments.number = issues.number) AS comment_count";

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
    repos: Fetcher,
    /// The events service, an RPC stub.
    events: JsValue,
}

impl Work {
    async fn publish<T: Serialize>(
        &self,
        kind: &'static str,
        repo_id: &str,
        actor: &User,
        data: T,
    ) -> Result<()> {
        let event = NewEvent {
            kind,
            source: SOURCE,
            repo_id: Some(repo_id.to_owned()),
            actor: Some(actor.id.clone()),
            data,
        };
        js::call(&self.events, "publish", &[js::to_js(&[event])?]).await?;
        Ok(())
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
        let body = a.body.map(|body| body.trim().to_owned());
        self.db
            .prepare(
                "UPDATE issues
                 SET title = COALESCE(?, title), body = COALESCE(?, body),
                     labels = COALESCE(?, labels), updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&title),
                optional(&body),
                optional(&labels),
                rfc3339(now_ms()).into(),
                issue.id.as_str().into(),
            ])?
            .run()
            .await?;
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
        Ok(Outcome::Ok(issue))
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
        if body.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "A comment cannot be empty.",
            ));
        }
        if body.chars().count() > MAX_ENTRY_CHARS {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "That comment is too long.",
            ));
        }
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        // The number names an issue or a pull request, never both.
        let table = if self.issue(&repo.id, a.number).await?.is_some() {
            "issues"
        } else if self.pull(&repo.id, a.number).await?.is_some() {
            "pulls"
        } else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "No issue or pull request has that number.",
            ));
        };

        let now = now_ms();
        let comment = Comment {
            id: new_id("cmt", now),
            author: a.actor.clone(),
            body: body.to_owned(),
            created_at: rfc3339(now),
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO comments
                           (id, repo_id, number, author_id, author_name, body, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        comment.id.as_str().into(),
                        repo.id.as_str().into(),
                        a.number.into(),
                        a.actor.id.as_str().into(),
                        a.actor.username.as_str().into(),
                        body.into(),
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
        let fork = check!(fork);

        let number = self.next_number(&repo.id).await?;
        let timestamp = rfc3339(now);
        self.db
            .prepare(
                "INSERT INTO pulls
                   (id, repo_id, number, issue_id, issue_number, title, agent, runtime,
                    fork_repo_id, fork_namespace, fork_name, author_id, author_name,
                    created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                optional(&issue.as_ref().map(|issue| issue.id.clone())),
                optional_number(issue.as_ref().map(|issue| issue.number)),
                title.into(),
                agent.into(),
                runtime.into(),
                fork.id.into(),
                fork.namespace.into(),
                fork.name.into(),
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
        Ok(Outcome::Ok(PullDetail {
            comments: self.comments(&repo.id, pull.number).await?,
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
        let (repo, mut pull) = check!(self.pull_at(&a.repo, a.number, &viewer).await?);
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
        let issue = match pull.issue {
            Some(number) if !a.keep_issue_open => self
                .issue(&repo.id, number)
                .await?
                .filter(|issue| issue.state == State::Open),
            _ => None,
        };

        // Whether the actor may write to the repository is decided by repos.
        let landed: Outcome<Landed> = g1t_kit::call(
            &self.repos,
            "land",
            &LandArgs {
                fork_id: pull.fork_repo_id.clone(),
                actor: a.actor.clone(),
            },
        )
        .await?;
        let landed = check!(landed);

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
                    a.actor.username.as_str().into(),
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
            &a.actor,
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
                &a.actor,
                IssueEvent {
                    reason: Some(IssueReason::Completed.as_str()),
                    resolved_by: Some(pull.number),
                    ..Self::issue_event(issue)
                },
            )
            .await?;
        }

        pull.status = PullStatus::Merged;
        pull.head_commit = Some(landed.commit);
        pull.merge_base = landed.previous;
        pull.merged_by = Some(a.actor.username);
        pull.merged_at = Some(now.clone());
        pull.updated_at = now;
        Ok(Outcome::Ok(pull))
    }

    async fn list_active_pulls(&self, a: ViewerArgs) -> Result<Vec<ActivePull>> {
        let Some(viewer) = a.viewer else {
            return Ok(Vec::new());
        };
        let rows = self
            .db
            .prepare(
                "SELECT * FROM pulls
                 WHERE author_id = ? AND status IN ('draft', 'open')
                 ORDER BY updated_at DESC LIMIT 50",
            )
            .bind(&[viewer.id.into()])?
            .all()
            .await?
            .results::<PullRow>()?;
        let mut active = Vec::with_capacity(rows.len());
        for pull in rows.into_iter().map(Pull::from) {
            let issue = match pull.issue {
                Some(number) => self.issue(&pull.repo_id, number).await?,
                None => None,
            };
            active.push(ActivePull { pull, issue });
        }
        Ok(active)
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

    /// A push to a pull request's fork moves that pull request's head.
    async fn on_event(&self, event: &Delivered) -> Result<()> {
        if event.kind != "git.push" {
            return Ok(());
        }
        let (Some(repo_id), Some(after)) = (event.repo_id.as_deref(), event.data["after"].as_str())
        else {
            return Ok(());
        };
        self.db
            .prepare(
                "UPDATE pulls SET head_commit = ?, updated_at = ?
                 WHERE fork_repo_id = ? AND status IN ('draft', 'open')",
            )
            .bind(&[after.into(), rfc3339(now_ms()).into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }
}

fn service(env: &Env) -> Result<Work> {
    Ok(Work {
        db: env.d1("DB")?,
        repos: env.service("REPOS")?,
        events: js::binding(env, "EVENTS")?,
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
        "open_pull" => reply(&work.open_pull(args(body)?).await?),
        "list_pulls" => reply(&work.list_pulls(args(body)?).await?),
        "get_pull" => reply(&work.get_pull(args(body)?).await?),
        "ready_pull" => reply(&work.ready_pull(args(body)?).await?),
        "close_pull" => reply(&work.close_pull(args(body)?).await?),
        "merge_pull" => reply(&work.merge_pull(args(body)?).await?),
        "list_active_pulls" => reply(&work.list_active_pulls(args(body)?).await?),
        "append_session" => reply(&work.append_session(args(body)?).await?),
        "read_session" => reply(&work.read_session(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, delivered on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Delivered>, env: Env, _ctx: Context) -> Result<()> {
    let work = service(&env)?;
    for message in batch.messages()? {
        work.on_event(message.body()).await?;
        message.ack();
    }
    Ok(())
}
