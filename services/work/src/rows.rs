//! Rows as they come out of D1, and their conversion to contract types.

use g1t_contracts::User;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::work::{
    CheckStatus, Comment, CommentKind, Issue, IssueReason, Pull, PullStatus, Runtime, SessionEntry,
    SessionEntryKind, State, Verdict,
};
use serde::Deserialize;

/// An author or actor as stored: g1t itself when the id is its own (a
/// security update it opened, a merge its settings made), a person otherwise.
pub(crate) fn user(id: String, username: String) -> User {
    let kind = if g1t_contracts::system::is_system_id(&id) {
        g1t_contracts::PrincipalKind::System
    } else {
        g1t_contracts::PrincipalKind::User
    };
    User {
        id,
        username,
        kind,
        ..User::default()
    }
}

#[derive(Deserialize)]
pub struct IssueRow {
    pub id: String,
    pub repo_id: String,
    pub number: u32,
    pub title: String,
    pub body: String,
    /// JSON array of label names.
    pub labels: String,
    pub state: State,
    pub reason: Option<IssueReason>,
    pub resolved_by: Option<u32>,
    pub author_id: String,
    pub author_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub pull_count: u32,
    pub comment_count: u32,
    /// JSON array of usernames.
    pub assignees: String,
    /// JSON array of issue numbers.
    pub blocked_by: String,
    /// JSON of who queued it for a g1t agent, if anyone has.
    pub queued_by: Option<String>,
    pub agent: Option<String>,
}

impl From<IssueRow> for Issue {
    fn from(row: IssueRow) -> Self {
        Issue {
            id: row.id,
            repo_id: row.repo_id,
            number: row.number,
            title: row.title,
            body: row.body,
            labels: serde_json::from_str(&row.labels).unwrap_or_default(),
            state: row.state,
            reason: row.reason,
            resolved_by: row.resolved_by,
            author: user(row.author_id, row.author_name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            closed_at: row.closed_at,
            pull_count: row.pull_count,
            comment_count: row.comment_count,
            assignees: serde_json::from_str(&row.assignees).unwrap_or_default(),
            blocked_by: serde_json::from_str(&row.blocked_by).unwrap_or_default(),
            queued: row.queued_by.is_some(),
            agent: row.agent,
        }
    }
}

/// The remembered assessment of a pull request, read beside its row.
#[derive(Deserialize)]
pub struct Snapshot {
    pub stage: Option<g1t_contracts::work::Stage>,
    pub stage_detail: Option<String>,
    #[serde(default)]
    pub revisions: u32,
    /// Whether g1t is seeing it through at all.
    #[serde(default)]
    pub managed: u32,
}

/// A pull request's columns, with its confidence (confidence.rs) beside
/// them: what every read of a [`PullRow`] selects.
pub const PULL_COLUMNS: &str =
    "pulls.*, (SELECT detail FROM pull_confidence WHERE pull_confidence.pull_id = pulls.id) AS confidence";

#[derive(Deserialize)]
pub struct PullRow {
    pub id: String,
    pub repo_id: String,
    pub number: u32,
    pub issue_number: Option<u32>,
    pub title: String,
    pub body: Option<String>,
    pub agent: String,
    pub runtime: Runtime,
    pub status: PullStatus,
    pub fork_repo_id: Option<String>,
    pub fork_namespace: Option<String>,
    pub fork_name: Option<String>,
    pub source_branch: Option<String>,
    pub head_commit: Option<String>,
    pub merge_base: Option<String>,
    pub merged_by: Option<String>,
    pub merged_at: Option<String>,
    pub superseded_by: Option<u32>,
    pub check_status: Option<CheckStatus>,
    /// JSON array of changed files; `None` until first worked out.
    pub files: Option<String>,
    /// JSON arrays of usernames.
    pub assignees: String,
    pub reviewers: String,
    pub author_id: String,
    pub author_name: String,
    pub created_at: String,
    pub updated_at: String,
    /// JSON of its confidence, once worked out.
    #[serde(default)]
    pub confidence: Option<String>,
}

impl From<PullRow> for Pull {
    fn from(row: PullRow) -> Self {
        Pull {
            id: row.id,
            repo_id: row.repo_id,
            number: row.number,
            issue: row.issue_number,
            title: row.title,
            body: row.body,
            agent: row.agent,
            runtime: row.runtime,
            status: row.status,
            fork: row
                .fork_namespace
                .zip(row.fork_name)
                .map(|(namespace, name)| RepoPath { namespace, name }),
            fork_repo_id: row.fork_repo_id,
            branch: row.source_branch,
            head_commit: row.head_commit,
            merge_base: row.merge_base,
            merged_by: row.merged_by,
            merged_at: row.merged_at,
            superseded_by: row.superseded_by,
            check_status: row.check_status,
            files: row
                .files
                .as_deref()
                .and_then(|files| serde_json::from_str(files).ok())
                .unwrap_or_default(),
            assignees: serde_json::from_str(&row.assignees).unwrap_or_default(),
            reviewers: serde_json::from_str(&row.reviewers).unwrap_or_default(),
            author: user(row.author_id, row.author_name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            confidence: row
                .confidence
                .as_deref()
                .and_then(|detail| serde_json::from_str(detail).ok()),
        }
    }
}

#[derive(Deserialize)]
pub struct CommentRow {
    pub id: String,
    pub kind: CommentKind,
    pub author_id: String,
    pub author_name: String,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<u32>,
    pub verdict: Option<Verdict>,
    pub created_at: String,
}

impl From<CommentRow> for Comment {
    fn from(row: CommentRow) -> Self {
        Comment {
            id: row.id,
            kind: row.kind,
            author: user(row.author_id, row.author_name),
            body: row.body,
            path: row.path,
            line: row.line,
            verdict: row.verdict,
            created_at: row.created_at,
        }
    }
}

#[derive(Deserialize)]
pub struct SessionRow {
    pub seq: u32,
    pub kind: SessionEntryKind,
    pub text: String,
    pub tool: Option<String>,
    pub commit: Option<String>,
    pub at: String,
}

impl From<SessionRow> for SessionEntry {
    fn from(row: SessionRow) -> Self {
        SessionEntry {
            seq: row.seq,
            kind: row.kind,
            text: row.text,
            tool: row.tool,
            commit: row.commit,
            at: row.at,
        }
    }
}

/// A pull request whose head a push moved.
#[derive(Deserialize)]
pub struct MovedRow {
    pub id: String,
    pub repo_id: String,
    pub number: u32,
    pub issue_number: Option<u32>,
    pub status: PullStatus,
}

/// A single number selected as `n`.
#[derive(Deserialize)]
pub struct NumberRow {
    pub n: u32,
}

/// A single string selected as `value`.
#[derive(Deserialize)]
pub struct ValueRow {
    pub value: String,
}
