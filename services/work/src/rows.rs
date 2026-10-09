//! Rows as they come out of D1, and their conversion to contract types.

use g1t_contracts::User;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::work::{
    AgentRef, AgentVerdict, CheckStatus, Comment, CommentKind, Issue, IssueReason, MilestoneRef, Pull, PullStatus, Runtime, SessionEntry,
    SessionEntryKind, State, Verdict,
};
use serde::Deserialize;

/// An author or actor as stored: g1t itself when the id is its own (a
/// security update it opened, a merge its settings made), g1t's agent by
/// its id (what it made or filed), a person otherwise.
pub(crate) fn user(id: String, username: String) -> User {
    let kind = if g1t_contracts::system::is_system_id(&id) {
        g1t_contracts::PrincipalKind::System
    } else if id == g1t_contracts::identity::AGENT_ID {
        g1t_contracts::PrincipalKind::Agent
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

/// Who asked g1t for the work, as stored beside its author: both columns,
/// or nobody.
pub(crate) fn requester(id: Option<String>, username: Option<String>) -> Option<User> {
    Some(user(id?, username?))
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
    #[serde(default)]
    pub requested_by_id: Option<String>,
    #[serde(default)]
    pub requested_by_name: Option<String>,
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
    /// The number of its milestone, and that milestone's title.
    #[serde(default)]
    pub milestone: Option<u32>,
    #[serde(default)]
    pub milestone_title: Option<String>,
}

/// A milestone as an issue or pull request names it, from its number and
/// title as read beside it.
pub(crate) fn milestone_ref(number: Option<u32>, title: Option<String>) -> Option<MilestoneRef> {
    Some(MilestoneRef { number: number?, title: title? })
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
            requested_by: requester(row.requested_by_id, row.requested_by_name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            closed_at: row.closed_at,
            pull_count: row.pull_count,
            comment_count: row.comment_count,
            assignees: serde_json::from_str(&row.assignees).unwrap_or_default(),
            blocked_by: serde_json::from_str(&row.blocked_by).unwrap_or_default(),
            queued: row.queued_by.is_some(),
            agent: row.agent,
            milestone: milestone_ref(row.milestone, row.milestone_title),
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
pub const PULL_COLUMNS: &str = "pulls.*,
  (SELECT detail FROM pull_confidence WHERE pull_confidence.pull_id = pulls.id) AS confidence,
  (SELECT title FROM milestones
   WHERE milestones.repo_id = pulls.repo_id AND milestones.number = pulls.milestone) AS milestone_title";

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
    /// JSON array of `workspace/team`.
    #[serde(default)]
    pub team_reviewers: Option<String>,
    pub author_id: String,
    pub author_name: String,
    #[serde(default)]
    pub requested_by_id: Option<String>,
    #[serde(default)]
    pub requested_by_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// JSON of its confidence, once worked out.
    #[serde(default)]
    pub confidence: Option<String>,
    /// JSON array of label names.
    #[serde(default)]
    pub labels: Option<String>,
    #[serde(default)]
    pub milestone: Option<u32>,
    #[serde(default)]
    pub milestone_title: Option<String>,
    /// The branch it merges into; NULL for the default branch.
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub head_pushed_by: Option<String>,
    #[serde(default)]
    pub head_pushed_at: Option<String>,
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
            team_reviewers: row
                .team_reviewers
                .as_deref()
                .and_then(|teams| serde_json::from_str(teams).ok())
                .unwrap_or_default(),
            author: user(row.author_id, row.author_name),
            requested_by: requester(row.requested_by_id, row.requested_by_name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            confidence: row
                .confidence
                .as_deref()
                .and_then(|detail| serde_json::from_str(detail).ok()),
            labels: row
                .labels
                .as_deref()
                .and_then(|labels| serde_json::from_str(labels).ok())
                .unwrap_or_default(),
            milestone: milestone_ref(row.milestone, row.milestone_title),
            base: row.base_branch,
            head_pushed_by: row.head_pushed_by,
            head_pushed_at: row.head_pushed_at,
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
    #[serde(default)]
    pub edited_at: Option<String>,
    /// The issue or pull request it is on, where the query reads it.
    #[serde(default)]
    pub number: u32,
    /// One of the workspace's agents that wrote it, as itself, and whom it
    /// acted for (migrations/0033_agent_comments.sql).
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_handle: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub agent_avatar_seed: Option<String>,
    #[serde(default)]
    pub acting_for_id: Option<String>,
    #[serde(default)]
    pub acting_for_name: Option<String>,
    /// An agent review's verdict, kept apart from `verdict`, which every
    /// rule about approvals reads: so it is advisory.
    #[serde(default)]
    pub agent_verdict: Option<String>,
}

impl CommentRow {
    /// Who answers for it: whoever an agent acted for, or its author.
    pub fn answerable_id(&self) -> &str {
        self.acting_for_id.as_deref().unwrap_or(&self.author_id)
    }

    /// Whether it carries a verdict, a person's or an agent's.
    pub fn has_verdict(&self) -> bool {
        self.verdict.is_some() || self.agent_verdict.is_some()
    }
}

impl From<CommentRow> for Comment {
    fn from(row: CommentRow) -> Self {
        let agent = match (row.agent_id, row.agent_handle) {
            (Some(id), Some(handle)) => Some(AgentRef {
                display_name: row.agent_name.unwrap_or_else(|| handle.clone()),
                avatar_seed: row.agent_avatar_seed.unwrap_or_else(|| handle.clone()),
                id,
                handle,
            }),
            _ => None,
        };
        let advisory_verdict = row.agent_verdict.as_deref().and_then(AgentVerdict::parse);
        let mut author = user(row.author_id, row.author_name);
        if agent.is_some() {
            author.kind = g1t_contracts::PrincipalKind::Agent;
        }
        Comment {
            id: row.id,
            kind: row.kind,
            author,
            body: row.body,
            path: row.path,
            line: row.line,
            // A person's verdict, or for showing, an agent's advisory one.
            verdict: row.verdict.or(advisory_verdict.and_then(AgentVerdict::verdict)),
            created_at: row.created_at,
            edited_at: row.edited_at,
            acting_for: agent.as_ref().and(requester(row.acting_for_id, row.acting_for_name)),
            advisory: agent.is_some() && advisory_verdict.is_some(),
            agent,
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
    pub author_id: String,
    pub author_name: String,
    #[serde(default)]
    pub requested_by_id: Option<String>,
    #[serde(default)]
    pub requested_by_name: Option<String>,
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

/// Rows as the database holds them, for tests of the rules that read them.
#[cfg(test)]
pub(crate) mod stored {
    use super::*;

    /// A pull request g1t made in a fork, read back as stored: g1t as its
    /// author, and `requested_by` the person who asked, if anyone did.
    pub(crate) fn pull(author: (&str, &str), requested_by: Option<(&str, &str)>) -> Pull {
        let row: PullRow = serde_json::from_value(serde_json::json!({
            "id": "pr_1", "repo_id": "rep_1", "number": 14, "issue_number": 12, "title": "Fix it",
            "body": null, "agent": "g1t", "runtime": "hosted", "status": "open",
            "fork_repo_id": "rep_f", "fork_namespace": "pulls", "fork_name": "pr_1",
            "source_branch": null, "head_commit": null, "merge_base": null, "merged_by": null,
            "merged_at": null, "superseded_by": null, "check_status": null, "files": null,
            "assignees": "[]", "reviewers": "[]",
            "author_id": author.0, "author_name": author.1,
            "requested_by_id": requested_by.map(|(id, _)| id),
            "requested_by_name": requested_by.map(|(_, name)| name),
            "created_at": "", "updated_at": ""
        }))
        .unwrap();
        row.into()
    }

    /// g1t's agent, as an author is stored.
    pub(crate) const G1T: (&str, &str) = (g1t_contracts::identity::AGENT_ID, "g1t");
    /// The person who asked g1t for the work.
    pub(crate) const ASKER: (&str, &str) = ("usr_1", "syntaqx");
}

#[cfg(test)]
mod tests {
    use super::stored::{ASKER, G1T, pull};
    use super::*;
    use g1t_contracts::PrincipalKind;

    #[test]
    fn g1t_s_pull_request_reads_back_as_g1t_s_requested_by_the_person() {
        let made = pull(G1T, Some(ASKER));
        assert_eq!((made.author.username.as_str(), made.author.kind), ("g1t", PrincipalKind::Agent));
        let asked = made.requested_by.as_ref().expect("who asked is kept");
        assert_eq!((asked.id.as_str(), asked.username.as_str(), asked.kind), ("usr_1", "syntaqx", PrincipalKind::User));
        assert_eq!(made.owner().id, "usr_1");
    }

    #[test]
    fn anyone_else_s_reads_back_as_theirs_alone() {
        let own = pull(ASKER, None);
        assert_eq!(own.author.kind, PrincipalKind::User);
        assert!(own.requested_by.is_none());
        assert_eq!(own.owner().id, "usr_1");
        // Half a requester is nobody.
        assert!(requester(Some("usr_1".into()), None).is_none());
    }

    #[test]
    fn g1t_s_own_work_reads_back_as_g1t_itself() {
        let own = pull(("g1t", "g1t"), None);
        assert_eq!(own.author.kind, PrincipalKind::System);
        assert!(own.requested_by.is_none());
    }
}
