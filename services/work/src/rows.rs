//! Rows as they come out of D1, and their conversion to contract types.

use g1t_contracts::User;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::work::{
    Comment, Issue, IssueReason, Pull, PullStatus, Runtime, SessionEntry, SessionEntryKind, State,
};
use serde::Deserialize;

fn user(id: String, username: String) -> User {
    User {
        id,
        username,
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
    /// JSON array of commands.
    pub checks: String,
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
            checks: serde_json::from_str(&row.checks).unwrap_or_default(),
            state: row.state,
            reason: row.reason,
            resolved_by: row.resolved_by,
            author: user(row.author_id, row.author_name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            closed_at: row.closed_at,
            pull_count: row.pull_count,
            comment_count: row.comment_count,
        }
    }
}

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
    pub fork_repo_id: String,
    pub fork_namespace: String,
    pub fork_name: String,
    pub head_commit: Option<String>,
    pub merge_base: Option<String>,
    pub merged_by: Option<String>,
    pub merged_at: Option<String>,
    pub superseded_by: Option<u32>,
    pub author_id: String,
    pub author_name: String,
    pub created_at: String,
    pub updated_at: String,
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
            fork: RepoPath {
                namespace: row.fork_namespace,
                name: row.fork_name,
            },
            fork_repo_id: row.fork_repo_id,
            head_commit: row.head_commit,
            merge_base: row.merge_base,
            merged_by: row.merged_by,
            merged_at: row.merged_at,
            superseded_by: row.superseded_by,
            author: user(row.author_id, row.author_name),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Deserialize)]
pub struct CommentRow {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub body: String,
    pub created_at: String,
}

impl From<CommentRow> for Comment {
    fn from(row: CommentRow) -> Self {
        Comment {
            id: row.id,
            author: user(row.author_id, row.author_name),
            body: row.body,
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
