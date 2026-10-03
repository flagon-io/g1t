//! The work service: issues, pull requests, comments and sessions.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.
//!
//! Issues and pull requests share one sequence of numbers per repository,
//! so `#12` names exactly one of them.

use serde::{Deserialize, Serialize};

use crate::repos::{CompareArgs, RepoPath};
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
    /// Usernames of the people it is assigned to.
    #[serde(default)]
    pub assignees: Vec<String>,
    /// The numbers of the issues that have to be merged before this one is
    /// worked on.
    #[serde(default)]
    pub blocked_by: Vec<u32>,
    /// Whether a g1t agent takes it as soon as it can: at once, or when
    /// what it is blocked by has merged.
    #[serde(default)]
    pub queued: bool,
    /// The agent working on it now: the one behind its newest pull request
    /// that is still in progress in a fork, such as `g1t-agent`.
    #[serde(default)]
    pub agent: Option<String>,
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
    /// Where the latest run of the issue's acceptance checks stands, if
    /// there has been one against the current head.
    pub check_status: Option<CheckStatus>,
    /// The files it changes, as of its latest push.
    #[serde(default)]
    pub files: Vec<ChangedFile>,
    /// Usernames of the people it is assigned to.
    #[serde(default)]
    pub assignees: Vec<String>,
    /// Those whose review was asked for: usernames, and `g1t-agent` when a
    /// g1t agent was asked.
    #[serde(default)]
    pub reviewers: Vec<String>,
    pub author: User,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
}

/// One file a pull request changes, and by how much.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Another pull request in progress that changes some of the same files.
/// Two for the same issue are alternatives; two for different issues are
/// heading for a conflict.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Overlap {
    pub number: u32,
    pub title: String,
    /// The number of the issue the other pull request is for.
    pub issue: Option<u32>,
    /// The files both change.
    pub paths: Vec<String>,
}

impl Pull {
    /// What to ask the repos service to see what this pull request changes.
    ///
    /// A fork is compared as a whole. A branch is compared by name while
    /// the pull request is open, and by the commit it was merged or closed
    /// at afterwards, so later pushes to the branch do not change the record.
    pub fn comparison(&self, viewer: &Viewer) -> CompareArgs {
        let settled = matches!(self.status, PullStatus::Merged | PullStatus::Closed);
        let (repo_id, head) = match &self.fork_repo_id {
            Some(fork) => (fork.clone(), None),
            None => (
                self.repo_id.clone(),
                self.head_commit
                    .clone()
                    .filter(|_| settled)
                    .or_else(|| self.branch.clone()),
            ),
        };
        CompareArgs {
            repo_id,
            viewer: viewer.clone(),
            base: self.merge_base.clone(),
            head,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    /// Waiting for a sandbox.
    Queued,
    Running,
    Passed,
    Failed,
    /// The checks could not be run at all.
    Errored,
}

impl CheckStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckStatus::Queued => "queued",
            CheckStatus::Running => "running",
            CheckStatus::Passed => "passed",
            CheckStatus::Failed => "failed",
            CheckStatus::Errored => "errored",
        }
    }
}

/// How one acceptance check went.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub command: String,
    pub passed: bool,
    /// Absent when the command was stopped for taking too long.
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// What the command printed, standard output and error together. The
    /// end of it, when there was a lot.
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub duration_ms: u64,
}

/// One run of an issue's acceptance checks against a pull request's head,
/// in a sandbox that holds nothing but that commit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub id: String,
    /// The commit that was checked.
    pub head_commit: String,
    pub status: CheckStatus,
    pub results: Vec<CheckResult>,
    /// Why the checks could not be run, when `status` is `errored`.
    pub error: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub finished_at: Option<String>,
}

/// A reviewer's decision on a pull request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Approve,
    RequestChanges,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Approve => "approve",
            Verdict::RequestChanges => "request_changes",
        }
    }
}

/// What an entry in a conversation is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentKind {
    /// Something a person or an agent wrote.
    #[default]
    Comment,
    /// Something that happened: an assignment, a review asked for, a close.
    Event,
}

/// A comment on an issue or a pull request. On a pull request it can sit
/// on one line of the change, and it can carry a reviewer's verdict.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    /// Something a person wrote, or something that happened.
    #[serde(default)]
    pub kind: CommentKind,
    pub author: User,
    /// Markdown. For an event, what its author did, as the rest of a
    /// sentence that starts with their name: "assigned ana".
    pub body: String,
    /// The file commented on, for a comment on a line.
    pub path: Option<String>,
    /// The line of that file, as numbered after the change.
    pub line: Option<u32>,
    pub verdict: Option<Verdict>,
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
    /// The latest run of the issue's acceptance checks.
    pub checks: Option<CheckRun>,
    /// Other pull requests in progress that change the same files.
    #[serde(default)]
    pub overlaps: Vec<Overlap>,
    /// Whether the branch it would merge into has moved on without it, so
    /// that it has to catch up before it can merge.
    #[serde(default)]
    pub behind: bool,
    /// Whether a g1t agent is reviewing it right now.
    #[serde(default)]
    pub review_pending: bool,
    /// Where it stands on its way to being merged, for a pull request g1t
    /// is seeing through. Absent on anyone else's.
    #[serde(default)]
    pub lifecycle: Option<Lifecycle>,
    /// A merge was asked for while it was behind: g1t is bringing it up to
    /// date and will then land it.
    #[serde(default)]
    pub landing: bool,
    /// Why g1t stopped working on it, if it did: a catch-up that could not
    /// be completed, for example.
    #[serde(default)]
    pub stalled: Option<String>,
    /// Messages people sent the agent while it worked, oldest first.
    #[serde(default)]
    pub messages: Vec<AgentMessage>,
}

/// A message a person sent an agent at work on a pull request. The agent
/// receives it at its next step.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub author: String,
    pub body: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339. When the agent received it; null until then.
    pub delivered_at: Option<String>,
    /// `message` from a person, or from another pull request's agent a
    /// `question`, a `handoff` of work, or the `answer` to one.
    #[serde(default = "message_kind")]
    pub kind: String,
    /// The pull request whose agent sent it, when an agent did.
    #[serde(default)]
    pub from_number: Option<u32>,
    /// The pull request it was sent to.
    #[serde(default)]
    pub to_number: u32,
    /// For a question or handoff: the reply, once there is one.
    #[serde(default)]
    pub answer: Option<String>,
    /// For a handoff: whether it was declined.
    #[serde(default)]
    pub declined: bool,
    /// For the agent that sent it: what to expect, when the agent it asked
    /// is not at work and will not answer soon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

fn message_kind() -> String {
    "message".to_owned()
}

/// `message_agent`: sends the agent working on a pull request a message.
/// The pull request's author and members of the workspace may. Returns
/// `Outcome<AgentMessage>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MessageAgentArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    pub body: String,
    /// For an agent: `question` or `handoff`; a person's is a `message`.
    #[serde(default)]
    pub kind: Option<String>,
    /// For an agent: the pull request it is working on, which the reply
    /// goes back to.
    #[serde(default)]
    pub from_number: Option<u32>,
}

/// `answer_message`: replies to a question or a handoff an agent received,
/// accepting or declining a handoff. The reply reaches the asking agent at
/// its next step. Returns `Outcome<AgentMessage>`, the message answered.
#[derive(Debug, Serialize, Deserialize)]
pub struct AnswerMessageArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub body: String,
    #[serde(default)]
    pub decline: bool,
}

/// `take_messages`: the messages not yet delivered to the agent working on
/// a pull request, marked delivered. Only g1t's agents may. Returns
/// `Outcome<Vec<AgentMessage>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TakeMessagesArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
}

/// A step on the way from an assigned issue to a pull request that is ready
/// to merge. g1t takes each one without being asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// The agent is making the change.
    Working,
    /// The issue's acceptance checks are running against it.
    Checking,
    /// A g1t agent is reviewing it.
    Reviewing,
    /// The agent is addressing failed checks or a review.
    Revising,
    /// The agent is merging in the branch it would land on, which moved.
    CatchingUp,
    /// In the repository's merge queue, being tested with what is ahead of
    /// it before it lands.
    Queued,
    /// Checks passed, reviewed and approved, up to date. A person merges.
    Ready,
    /// g1t has stopped and a person has to decide what happens next.
    NeedsYou,
}

/// Where a pull request made by a g1t agent stands. See [`Stage`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lifecycle {
    pub stage: Stage,
    /// One sentence saying what is happening, or why it stopped.
    pub detail: String,
    /// How many times the agent has been sent back to revise it.
    pub revisions: u32,
}

/// `advance`: works out the next step for a pull request g1t is seeing
/// through and, if there is one to take now, claims it, so that it is
/// taken once however many times this is called. Called by the runner
/// service, which carries the step out. Returns `Advance`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvanceArgs {
    pub pull_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Advance {
    /// Nothing to do now: a step is under way, or it is a person's turn.
    None,
    /// Have a g1t agent review it.
    Review { job: LifecycleJob },
    /// Send the agent back to address `job.feedback`.
    Revise { job: LifecycleJob },
    /// Merge in the branch it would land on.
    CatchUp { job: LifecycleJob },
}

/// What the runner needs to carry out a step of a pull request's lifecycle.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleJob {
    pub pull_id: String,
    pub repo: RepoPath,
    pub number: u32,
    /// Who the pull request belongs to. Sandboxes act as them.
    pub author: User,
    /// The repository holding the change: its fork, or the repository
    /// itself for one made on a branch.
    pub source: RepoPath,
    /// The branch of the source holding the change; its default branch
    /// when absent.
    #[serde(default)]
    pub branch: Option<String>,
    pub default_branch: String,
    pub title: String,
    pub description: String,
    pub issue: Option<Issue>,
    /// For a revision: the failed checks or the review to address.
    pub feedback: String,
    /// For a revision: which one this is, from 1.
    pub round: u32,
}

/// How a repository wants its pull requests handled. A repository that has
/// changed nothing has the defaults.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoSettings {
    /// Land a g1t agent's pull request without a person once it is ready:
    /// checks passed and approved as the settings below require.
    pub auto_merge: bool,
    /// Refuse to merge a pull request that does not contain the default
    /// branch's latest commits, so that what merges is what was checked.
    /// When off, merging one that is behind brings it up to date first.
    pub require_up_to_date: bool,
    /// How many approving reviews a pull request needs before it may
    /// merge. A reviewer who has since asked for changes blocks it.
    pub required_approvals: u32,
    /// Whether a g1t agent's approval counts towards `required_approvals`.
    pub count_agent_approvals: bool,
    /// Whether a member may merge although the acceptance checks did not
    /// pass.
    pub allow_ignoring_checks: bool,
    /// Whether a g1t agent's pull request is reviewed by a second agent
    /// without being asked.
    pub agent_review: bool,
    /// How many times a g1t agent is sent back to its pull request before
    /// a person is asked instead.
    pub max_revisions: u32,
    /// Merge through a queue: pull requests are tested together with those
    /// ahead of them, and only a combination that passed reaches the default
    /// branch.
    pub merge_queue: bool,
    /// Username of the member who last changed the settings, if anyone has.
    pub updated_by: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

impl Default for RepoSettings {
    fn default() -> Self {
        RepoSettings {
            auto_merge: false,
            require_up_to_date: false,
            required_approvals: 0,
            count_agent_approvals: true,
            allow_ignoring_checks: true,
            agent_review: true,
            max_revisions: 2,
            merge_queue: false,
            updated_by: None,
            updated_at: None,
        }
    }
}

/// `update_settings`: replaces a repository's settings. Members of its
/// workspace only. Returns `Outcome<RepoSettings>`. `get_settings` takes
/// `ViewArgs` and returns the same.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateSettingsArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// Who changed them and when are filled in by the service.
    pub settings: RepoSettings,
}

/// `catch_up_job`: what the runner needs to bring a pull request up to date
/// because a merge of it was asked for. Null if none was. Returns
/// `Option<LifecycleJob>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatchUpJobArgs {
    pub pull_id: String,
}

/// `stall`: records that a step could not be carried out, so that g1t
/// stops and a person is asked. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallArgs {
    pub pull_id: String,
    pub reason: String,
}

/// `managed_pulls`: ids of the open pull requests g1t is seeing through,
/// in one repository or in all of them. Returns `Vec<String>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPullsArgs {
    #[serde(default)]
    pub repo_id: Option<String>,
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
    /// Usernames of the people it is assigned to; replaces the whole set.
    /// Assigning it to the g1t agent is the runner's `run`, not this.
    #[serde(default)]
    pub assignees: Option<Vec<String>>,
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

/// `add_comment`, on an issue or a pull request. On a pull request it may
/// name a line of the change, and may carry a verdict; nobody can give a
/// verdict on their own pull request. Returns `Outcome<Comment>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddCommentArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    /// May be empty when approving.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub verdict: Option<Verdict>,
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
    /// For `merge_pull`: merge although the acceptance checks have not
    /// passed.
    #[serde(default)]
    pub ignore_checks: bool,
}

/// Where a plan stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanStatus {
    /// An agent is reading the repository and writing it.
    Planning,
    /// Written, and waiting for a person to read and apply it.
    Ready,
    /// It could not be written.
    Failed,
    /// Its issues have been opened.
    Applied,
}

/// One issue a plan proposes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlannedIssue {
    pub title: String,
    /// Markdown: what to change, where, and why.
    pub body: String,
    pub labels: Vec<String>,
    /// Commands that must pass once the change is made.
    pub checks: Vec<String>,
    /// The files it will most likely change.
    pub files: Vec<String>,
    /// The positions, counting from 1, of earlier issues in the plan that
    /// have to be merged first. An agent writes this as `depends_on`.
    #[serde(alias = "depends_on")]
    pub depends_on: Vec<u32>,
    /// Its number, once the plan has been applied and it was kept.
    pub number: Option<u32>,
}

/// An outcome someone wrote, and the issues an agent proposes to get there.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub repo_id: String,
    /// The outcome wanted, as written.
    pub brief: String,
    pub status: PlanStatus,
    /// The agent's account of how it split the work.
    pub summary: String,
    pub issues: Vec<PlannedIssue>,
    /// Why it could not be written, when `status` is `failed`.
    pub error: Option<String>,
    pub author: User,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub finished_at: Option<String>,
    /// Once applied: where each issue it opened stands now, in plan order.
    /// Filled in by `get_plan` only.
    #[serde(default)]
    pub progress: Vec<IssueProgress>,
    /// Questions and handoffs between the agents on its pull requests,
    /// newest first. Filled in by `get_plan` only.
    #[serde(default)]
    pub exchanges: Vec<AgentMessage>,
}

/// Where one issue of an applied plan stands.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueProgress {
    pub number: u32,
    pub title: String,
    /// `blocked` (waiting on issues it depends on), `waiting` (for an
    /// agent), `open` (nobody on it), one of the lifecycle stages
    /// (`working`, `checking`, `reviewing`, `revising`, `catching_up`,
    /// `queued`, `ready`, `needs_you`), `landed` or `closed`.
    pub state: String,
    /// One sentence about where it stands.
    pub detail: String,
    /// The issues it is waiting on that are still open.
    pub blocked_by: Vec<u32>,
    /// The pull request carrying it, the newest if several.
    pub pull: Option<u32>,
    /// Who or what is working on it, e.g. `g1t-agent`.
    pub agent: Option<String>,
}

/// `start_plan`: records an outcome to plan for. Members of the
/// repository's workspace only. Called by the runner service, which starts
/// the sandbox. Returns `Outcome<PlanJob>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StartPlanArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub brief: String,
}

/// What a sandbox needs to write a plan.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanJob {
    pub plan_id: String,
    /// Lets the sandbox, and nothing else, report this plan.
    pub token: String,
    pub brief: String,
    pub repo: RepoPath,
}

/// `report_plan`: the plan a sandbox's agent wrote, or why it could not
/// write one. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPlanArgs {
    pub plan_id: String,
    pub token: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub issues: Vec<PlannedIssue>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `get_plan`. Members only. Returns `Outcome<Plan>`. `list_plans` takes
/// `ViewArgs` and returns `Outcome<Vec<Plan>>`, newest first.
#[derive(Debug, Serialize, Deserialize)]
pub struct PlanArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    pub id: String,
}

/// `apply_plan`: opens a plan's issues, each blocked by the ones it depends
/// on. Members only, and once. Returns `Outcome<Plan>`, its issues now
/// carrying their numbers.
#[derive(Debug, Serialize, Deserialize)]
pub struct ApplyPlanArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    /// Queue every issue for a g1t agent.
    #[serde(default)]
    pub assign: bool,
    /// The positions, counting from 1, of the issues to open. All of them
    /// when absent.
    #[serde(default)]
    pub keep: Option<Vec<u32>>,
}

/// `queue_issue`: asks for a g1t agent to take an issue as soon as it can,
/// or withdraws that. The author or a member may. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct QueueIssueArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    pub queued: bool,
}

/// `ready_issues`: issues waiting for a g1t agent that can be given one
/// now, in one repository or in all. Called by the runner service. Returns
/// `Vec<ReadyIssue>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyIssuesArgs {
    #[serde(default)]
    pub repo_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadyIssue {
    pub repo: RepoPath,
    pub number: u32,
    /// Who queued it, on whose say-so the agent works.
    pub actor: User,
}

/// `update_pull`: changes who a pull request is assigned to and whose
/// review is asked for. Each list given replaces the whole set. Whoever
/// opened it, or a member of the workspace, may. Returns `Outcome<Pull>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdatePullArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    #[serde(default)]
    pub assignees: Option<Vec<String>>,
    /// May include `g1t-agent`. Asking for its review does not by itself
    /// start one; the runner's `review` does.
    #[serde(default)]
    pub reviewers: Option<Vec<String>>,
}

/// `start_checks`: begins a run of the acceptance checks for a pull request
/// that is ready for review. Called by the runner service, which starts the
/// sandbox. Returns `Outcome<CheckJob>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChecksArgs {
    pub pull_id: String,
}

/// What a sandbox needs to carry out a check run.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckJob {
    pub run_id: String,
    /// Lets the sandbox, and nothing else, report this run's results.
    pub token: String,
    pub commands: Vec<String>,
    /// The repository holding the commit: the fork, or the repository itself.
    pub source: RepoPath,
    pub commit: String,
    /// Who opened the pull request, and so can read its source.
    pub author: User,
    /// Username of whoever wrote the checks: the issue's author.
    pub requested_by: String,
    pub repo: RepoPath,
    pub number: u32,
}

/// `report_checks`: what a sandbox says about its run. With no results and
/// no error it has started. `skip` forgets the run, for one that will not
/// be carried out. Returns `Outcome<CheckRun>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportChecksArgs {
    pub run_id: String,
    pub token: String,
    #[serde(default)]
    pub results: Vec<CheckResult>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub skip: bool,
}

/// A pull request in progress, with where it lives.
#[derive(Debug, Serialize, Deserialize)]
pub struct ActivePull {
    pub pull: Pull,
    pub issue: Option<Issue>,
    /// Where it stands, for one g1t is seeing through.
    #[serde(default)]
    pub lifecycle: Option<Lifecycle>,
}

/// `list_active_pulls`: drafts and open pull requests the viewer started,
/// most recently active first. Returns `Vec<ActivePull>`. Also
/// `list_assigned_issues`: open issues assigned to the viewer, most
/// recently changed first. Returns `Vec<Issue>`.
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

/// `start_review`: begins a review of a pull request by a g1t agent. Called
/// by the runner service, which starts the sandbox. Returns
/// `Outcome<ReviewJob>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReviewArgs {
    pub pull_id: String,
}

/// What a sandbox needs to review a pull request.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewJob {
    pub run_id: String,
    /// Lets the sandbox, and nothing else, report this review.
    pub token: String,
    /// The repository holding the commit: the fork, or the repository itself.
    pub source: RepoPath,
    pub commit: String,
    pub repo: RepoPath,
    pub default_branch: String,
    pub number: u32,
    pub title: String,
    pub description: String,
    /// The issue the pull request is for, which says what it should achieve.
    pub issue: Option<Issue>,
    /// Who opened the pull request, and so can read its source.
    pub author: User,
}

/// A comment on one line, as a reviewing agent reports it.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewComment {
    pub path: String,
    #[serde(default)]
    pub line: u32,
    pub body: String,
}

/// `report_review`: the review a sandbox's agent wrote, or why it could not
/// write one. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportReviewArgs {
    pub run_id: String,
    pub token: String,
    #[serde(default)]
    pub verdict: Option<Verdict>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
    /// The model that wrote it, by its public name.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
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


// --- Merge queue ----------------------------------------------------------

/// Where a pull request in a merge queue stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueState {
    /// Waiting for its turn to be tested.
    Waiting,
    /// Its combined state is being built and checked.
    Testing,
    /// Its combined state passed; it lands once everything ahead has.
    Passed,
    /// Its combined state failed, or would not merge. It left the queue.
    Failed,
    /// On the default branch.
    Landed,
    /// Taken out of the queue by a person, or closed.
    Removed,
}

impl QueueState {
    pub fn as_str(self) -> &'static str {
        match self {
            QueueState::Waiting => "waiting",
            QueueState::Testing => "testing",
            QueueState::Passed => "passed",
            QueueState::Failed => "failed",
            QueueState::Landed => "landed",
            QueueState::Removed => "removed",
        }
    }

    /// Still in the queue.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            QueueState::Waiting | QueueState::Testing | QueueState::Passed
        )
    }
}

/// One pull request's place in a merge queue.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: String,
    pub number: u32,
    pub title: String,
    /// Who or what made the pull request, e.g. `g1t-agent`.
    pub agent: String,
    pub state: QueueState,
    /// The pull requests merged ahead of it in the state being tested, in
    /// queue order. Empty when it was tested on the default branch alone.
    pub ahead: Vec<u32>,
    /// The default branch's commit the tested state was built on.
    pub base_commit: Option<String>,
    /// The tested state: the default branch with everything ahead and this.
    pub combined_commit: Option<String>,
    /// Why it failed: a merge conflict or what could not be run.
    pub error: Option<String>,
    /// The checks run against the tested state.
    pub results: Vec<CheckResult>,
    /// Username of whoever merged it into the queue: a person, or `g1t`.
    pub enqueued_by: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339. When it landed or left.
    pub finished_at: Option<String>,
}

/// A repository's merge queue: what is in it, in order, and what recently
/// left it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueView {
    /// Whether the repository merges through the queue.
    pub enabled: bool,
    pub active: Vec<QueueEntry>,
    /// Newest first.
    pub recent: Vec<QueueEntry>,
}

/// `queue`: a repository's merge queue. Returns `Outcome<QueueView>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct QueueArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
}

/// `queue_build`: the next batch to test for a repository, if nothing is
/// being tested now. Returns `Vec<QueueJob>`, one per entry, each testing
/// the default branch with that entry and everything ahead of it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueBuildArgs {
    pub repo_id: String,
}

/// One pull request in a state being tested: where its change is.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStackItem {
    pub number: u32,
    pub title: String,
    /// The repository holding the change: its fork, or the repository.
    pub source: RepoPath,
    /// The branch of `source` holding it.
    pub branch: String,
    pub commit: String,
}

/// What a sandbox needs to build and check one combined state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueJob {
    pub entry_id: String,
    /// Lets the sandbox, and nothing else, report this state's result.
    pub token: String,
    pub repo: RepoPath,
    pub default_branch: String,
    /// The default branch's commit to build on.
    pub base_commit: String,
    /// Where to push the tested state, in the repository itself.
    pub branch: String,
    /// The pull requests to merge in, in order; the last is the entry.
    pub stack: Vec<QueueStackItem>,
    /// Every acceptance check of every pull request in the stack.
    pub checks: Vec<String>,
    /// The checks of issues already completed: the default branch's
    /// contract. One that fails on the base alone is not held against the
    /// entry.
    #[serde(default)]
    pub contract_checks: Vec<String>,
    /// Who the sandbox acts as: a member who can push the tested state.
    pub actor: User,
}

/// `report_queue`: a sandbox's result for one combined state. Returns
/// `Outcome<QueueState>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportQueueArgs {
    pub entry_id: String,
    pub token: String,
    #[serde(default)]
    pub combined_commit: Option<String>,
    #[serde(default)]
    pub results: Vec<CheckResult>,
    /// Set when the state could not be built or checked.
    #[serde(default)]
    pub error: Option<String>,
    /// For a merge conflict: the pull request whose change it collided with.
    #[serde(default)]
    pub conflict_with: Option<u32>,
}


/// `locate_pull`: where a pull request lives, by its id, for a tool that
/// knows only the fork it is working in (`g1t.sh/pulls/<id>`). Returns
/// `Outcome<LocatedPull>`; not found for anyone who cannot see it.
#[derive(Debug, Serialize, Deserialize)]
pub struct LocatePullArgs {
    pub id: String,
    pub viewer: Viewer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedPull {
    pub repo: RepoPath,
    pub number: u32,
    pub title: String,
    pub status: PullStatus,
}
