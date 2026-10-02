//! The work service: issues, pull requests, comments and sessions.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.
//!
//! Issues and pull requests share one sequence of numbers per repository,
//! so `#12` names exactly one of them.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Labels every repository starts with. Any other label comes into being
/// the first time it is put on an issue.
pub const DEFAULT_LABELS: [&str; 5] = ["bug", "feature", "docs", "chore", "question"];

/// `open` or `closed`: the filter on lists of issues and pull requests. An
/// open pull request is a draft or one ready for review; a closed one was
/// merged or closed without merging.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Open,
    Closed,
}

/// Why an issue was closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueReason {
    /// The work was done. If a pull request did it, `resolved_by` names it.
    Completed,
    NotPlanned,
}

impl IssueReason {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueReason::Completed => "completed",
            IssueReason::NotPlanned => "not_planned",
        }
    }
}

/// Something that should change in a repository: a bug, a feature, a
/// question. Opened by a person, an agent or an integration. Pull requests
/// are made against it; the one that is merged resolves it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub repo_id: String,
    /// Shown as `#12`.
    pub number: u32,
    pub title: String,
    /// Markdown. Also what an agent is given to work from.
    pub body: String,
    pub labels: Vec<String>,
    /// Commands that must pass for a pull request to be accepted.
    pub checks: Vec<String>,
    pub state: State,
    /// Set when closed.
    pub reason: Option<IssueReason>,
    /// The number of the pull request whose merge closed this issue.
    pub resolved_by: Option<u32>,
    pub author: User,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
    /// RFC 3339.
    pub closed_at: Option<String>,
    /// Pull requests made against this issue, in any state.
    pub pull_count: u32,
    pub comment_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullStatus {
    /// Still being worked on.
    Draft,
    /// Ready for review.
    Open,
    Merged,
    /// Closed without merging.
    Closed,
}

impl PullStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PullStatus::Draft => "draft",
            PullStatus::Open => "open",
            PullStatus::Merged => "merged",
            PullStatus::Closed => "closed",
        }
    }

    /// Whether the pull request can still be changed or merged.
    pub fn is_active(self) -> bool {
        matches!(self, PullStatus::Draft | PullStatus::Open)
    }
}

/// Where the agent runs: on g1t's sandboxes, or in someone's own session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Hosted,
    External,
}

/// A proposed change. It is made either in a fork created for it, which is
/// how agents work, or on a branch pushed to the repository itself.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub id: String,
    pub repo_id: String,
    /// Shown as `#12`.
    pub number: u32,
    /// The number of the issue this is for, if any.
    pub issue: Option<u32>,
    pub title: String,
    /// Markdown: what changed and why. Set when marked ready.
    pub body: Option<String>,
    /// A label for the agent doing the work, e.g. `claude-code`.
    pub agent: String,
    pub runtime: Runtime,
    pub status: PullStatus,
    /// The fork holding the change, unless it is on a branch.
    pub fork: Option<RepoPath>,
    /// The fork's repository id.
    pub fork_repo_id: Option<String>,
    /// The branch of the repository holding the change, unless it is in a
    /// fork.
    pub branch: Option<String>,
    pub head_commit: Option<String>,
    /// For a merged pull request, what the branch pointed to before the
    /// merge. Comparing against it shows what the pull request changed.
    pub merge_base: Option<String>,
    /// Username of whoever merged it.
    pub merged_by: Option<String>,
    /// RFC 3339.
    pub merged_at: Option<String>,
    /// Set on a pull request closed because another one for the same issue
    /// was merged: that one's number.
    pub superseded_by: Option<u32>,
    pub author: User,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: User,
    /// Markdown.
    pub body: String,
    /// RFC 3339.
    pub created_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEntryKind {
    Prompt,
    Message,
    ToolCall,
    ToolResult,
    Note,
}

/// One step of an agent's session: the "why" behind a pull request's commits.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionEntry {
    pub seq: u32,
    pub kind: SessionEntryKind,
    pub text: String,
    /// For tool calls and results.
    pub tool: Option<String>,
    /// The fork's head commit when this entry was recorded, if known.
    pub commit: Option<String>,
    /// RFC 3339.
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NewSessionEntry {
    pub kind: SessionEntryKind,
    pub text: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IssueDetail {
    pub issue: Issue,
    /// Every pull request made against it, oldest first.
    pub pulls: Vec<Pull>,
    pub comments: Vec<Comment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PullDetail {
    pub pull: Pull,
    /// The issue it is for, if any.
    pub issue: Option<Issue>,
    pub comments: Vec<Comment>,
}

/// `open_issue`. Returns `Outcome<Issue>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenIssueArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
}

/// `list_issues`, newest first. Returns `Outcome<Vec<Issue>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListIssuesArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub state: Option<State>,
    /// Only issues carrying this label.
    #[serde(default)]
    pub label: Option<String>,
}

/// `list_pulls`, newest first. Returns `Outcome<Vec<Pull>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListPullsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub state: Option<State>,
}

/// `get_issue` (`Outcome<IssueDetail>`), `get_pull` (`Outcome<PullDetail>`),
/// `read_session` (`Outcome<Vec<SessionEntry>>`), `list_labels`
/// (`Outcome<Vec<String>>`) and `counts` (`Outcome<Counts>`). The last two
/// ignore `number`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewArgs {
    pub repo: RepoPath,
    #[serde(default)]
    pub number: u32,
    pub viewer: Viewer,
    /// For `read_session`: only entries after this sequence number.
    #[serde(default)]
    pub after_seq: u32,
}

/// How many issues and pull requests are open on a repository.
#[derive(Debug, Serialize, Deserialize)]
pub struct Counts {
    pub issues: u32,
    pub pulls: u32,
}

/// `update_issue`: changes whichever fields are given. The author or a
/// member of the workspace may. Returns `Outcome<Issue>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateIssueArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
}

/// `close_issue` and `reopen_issue`. Each returns `Outcome<Issue>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct IssueActionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    /// For `close_issue`; `completed` if left out.
    #[serde(default)]
    pub reason: Option<IssueReason>,
}

/// `add_comment`, on an issue or a pull request. Returns `Outcome<Comment>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddCommentArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    pub body: String,
}

/// `open_pull`. Without `branch`, forks the repo and returns a draft pull
/// request to push to. With it, opens a pull request, ready for review,
/// for a branch already pushed to the repo. Returns `Outcome<Pull>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenPullArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// The issue this is for.
    #[serde(default)]
    pub issue: Option<u32>,
    /// Defaults to the issue's title; required without an issue.
    #[serde(default)]
    pub title: String,
    /// What changed and why. Usually set later, when a draft is marked ready.
    #[serde(default)]
    pub body: String,
    /// A branch of the repository that already holds the change.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub agent: String,
    pub runtime: Runtime,
}

/// `ready_pull`, `close_pull` and `merge_pull`. Each returns `Outcome<Pull>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullActionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    /// For `ready_pull`: what changed and why.
    #[serde(default)]
    pub summary: String,
    /// For `merge_pull`: leave the issue open and the other pull requests
    /// for it untouched, because this one is only part of the work.
    #[serde(default)]
    pub keep_issue_open: bool,
}

/// A pull request in progress, with where it lives.
#[derive(Debug, Serialize, Deserialize)]
pub struct ActivePull {
    pub pull: Pull,
    pub issue: Option<Issue>,
}

/// `list_active_pulls`: drafts and open pull requests the viewer started,
/// most recently active first. Returns `Vec<ActivePull>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ViewerArgs {
    pub viewer: Viewer,
}

/// `append_session`. Returns `Outcome<Appended>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AppendSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    pub entries: Vec<NewSessionEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Appended {
    pub count: u32,
}

/// Lowercases, trims and de-duplicates labels, dropping empty ones.
/// Returns `None` if there are too many or one is too long.
pub fn normalize_labels(labels: &[String]) -> Option<Vec<String>> {
    const MAX_LABELS: usize = 10;
    const MAX_LABEL_CHARS: usize = 40;
    let mut normalized: Vec<String> = Vec::new();
    for label in labels {
        let label = label
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if label.is_empty() || normalized.contains(&label) {
            continue;
        }
        if label.chars().count() > MAX_LABEL_CHARS {
            return None;
        }
        normalized.push(label);
    }
    (normalized.len() <= MAX_LABELS).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::normalize_labels;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn labels_are_lowercased_trimmed_and_unique() {
        assert_eq!(
            normalize_labels(&labels(&[" Bug ", "bug", "", "Good  First Issue"])),
            Some(labels(&["bug", "good first issue"]))
        );
    }

    #[test]
    fn too_long_or_too_many_labels_are_refused() {
        assert_eq!(normalize_labels(&["x".repeat(41)]), None);
        let many: Vec<String> = (0..11).map(|i| format!("label-{i}")).collect();
        assert_eq!(normalize_labels(&many), None);
    }
}
