//! Rows as they come out of D1, and their conversion to contract types.

use g1t_contracts::User;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::work::{
    Attempt, AttemptRuntime, AttemptStatus, Intent, IntentStatus, SessionEntry, SessionEntryKind,
};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct IntentRow {
    pub id: String,
    pub repo_id: String,
    pub number: u32,
    pub title: String,
    pub brief: String,
    /// JSON array of commands.
    pub checks: String,
    pub status: IntentStatus,
    pub author_id: String,
    pub author_name: String,
    pub created_at: String,
    pub attempt_count: u32,
}

impl From<IntentRow> for Intent {
    fn from(row: IntentRow) -> Self {
        Intent {
            id: row.id,
            repo_id: row.repo_id,
            number: row.number,
            title: row.title,
            brief: row.brief,
            checks: serde_json::from_str(&row.checks).unwrap_or_default(),
            status: row.status,
            author: User {
                id: row.author_id,
                username: row.author_name,
                ..User::default()
            },
            created_at: row.created_at,
            attempt_count: row.attempt_count,
        }
    }
}

#[derive(Deserialize)]
pub struct AttemptRow {
    pub id: String,
    pub intent_id: String,
    pub repo_id: String,
    pub number: u32,
    pub agent: String,
    pub runtime: AttemptRuntime,
    pub status: AttemptStatus,
    pub summary: Option<String>,
    pub fork_repo_id: String,
    pub fork_namespace: String,
    pub fork_name: String,
    pub head_commit: Option<String>,
    pub landed_base: Option<String>,
    pub started_by_id: String,
    pub started_by_name: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<AttemptRow> for Attempt {
    fn from(row: AttemptRow) -> Self {
        Attempt {
            id: row.id,
            intent_id: row.intent_id,
            repo_id: row.repo_id,
            number: row.number,
            agent: row.agent,
            runtime: row.runtime,
            status: row.status,
            summary: row.summary,
            fork: RepoPath {
                namespace: row.fork_namespace,
                name: row.fork_name,
            },
            fork_repo_id: row.fork_repo_id,
            head_commit: row.head_commit,
            landed_base: row.landed_base,
            started_by: User {
                id: row.started_by_id,
                username: row.started_by_name,
                ..User::default()
            },
            created_at: row.created_at,
            updated_at: row.updated_at,
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
