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
    pub state: State,
    /// Set when closed.
    pub reason: Option<IssueReason>,
    /// The number of the pull request whose merge closed this issue.
    pub resolved_by: Option<u32>,
    /// Who opened it: a person, an integration, or g1t (`kind` `agent`)
    /// for one its agent filed while at work.
    pub author: User,
    /// For an issue g1t's agent filed: the person it was working for. They
    /// may manage it as its author could. See [`owner`](Issue::owner).
    #[serde(default)]
    pub requested_by: Option<User>,
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
    /// that is still in progress in a fork, such as `g1t`.
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
    /// `failed` when the merge queue took it out because its combined
    /// state failed, until its head moves. Its checks are the statuses
    /// workflows report on its head: see `PullDetail::statuses` and
    /// `PullDetail::required_checks`.
    pub check_status: Option<CheckStatus>,
    /// The files it changes, as of its latest push.
    #[serde(default)]
    pub files: Vec<ChangedFile>,
    /// Usernames of the people it is assigned to.
    #[serde(default)]
    pub assignees: Vec<String>,
    /// Those whose review was asked for: usernames, and `g1t` when a
    /// g1t agent was asked.
    #[serde(default)]
    pub reviewers: Vec<String>,
    /// Who opened it: a person, or g1t (`kind` `agent`, username `g1t`)
    /// for a change g1t made.
    pub author: User,
    /// For a change g1t made: the person who asked for it, by assigning
    /// an issue or handing g1t the work. They answer for it as its author
    /// would. See [`owner`](Pull::owner).
    #[serde(default)]
    pub requested_by: Option<User>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
    /// How sure g1t is of a g1t agent's change, from what it can observe,
    /// once the agent has finished it. Absent before then, and on changes
    /// g1t is not seeing through.
    #[serde(default)]
    pub confidence: Option<Confidence>,
}

/// How sure g1t is that an agent's change is right. Low is below medium,
/// which is below high, so the lower of two is their minimum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfidenceLevel {
    Low,
    Medium,
    High,
}

impl ConfidenceLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfidenceLevel::Low => "low",
            ConfidenceLevel::Medium => "medium",
            ConfidenceLevel::High => "high",
        }
    }

    pub fn parse(value: &str) -> Option<ConfidenceLevel> {
        match value.trim().to_ascii_lowercase().as_str() {
            "low" => Some(ConfidenceLevel::Low),
            "medium" => Some(ConfidenceLevel::Medium),
            "high" => Some(ConfidenceLevel::High),
            _ => None,
        }
    }
}

/// How sure g1t is of a change an agent made, worked out from what can be
/// observed: its checks, how often it was sent back, the reviewer agent's
/// verdict, whether it touched tests, its size, where it reached, how close
/// it came to its guardrails, and what it asked and was not answered. The
/// agent may say how sure it is too; what g1t observes can only lower that.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confidence {
    pub level: ConfidenceLevel,
    /// A few words each, most telling first: what lowered it, or for
    /// `high`, what it rests on.
    pub reasons: Vec<String>,
    /// What the agent said of its own change, if it said.
    #[serde(default)]
    pub self_reported: Option<ConfidenceLevel>,
    /// What the agent said it was unsure about.
    #[serde(default)]
    pub uncertain_about: Vec<String>,
    /// The agent run it was worked out after.
    #[serde(default)]
    pub run_id: Option<String>,
    /// RFC 3339.
    pub assessed_at: String,
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

impl Issue {
    /// Who the issue is theirs to manage: the person g1t's agent filed it
    /// for, or its author. They may edit, close and reopen it without the
    /// Triage role.
    pub fn owner(&self) -> &User {
        self.requested_by.as_ref().unwrap_or(&self.author)
    }
}

impl Pull {
    /// Who the pull request is theirs to answer for: whoever asked g1t to
    /// make it, or its author. Every rule that once read "its author" reads
    /// this: they may update, close and steer it, are never asked to review
    /// it and cannot approve it, see it as theirs, and a sandbox at work on
    /// it acts as them.
    pub fn owner(&self) -> &User {
        self.requested_by.as_ref().unwrap_or(&self.author)
    }

    /// Whether `id` is its [`owner`](Pull::owner)'s.
    pub fn is_owned_by(&self, id: &str) -> bool {
        self.owner().id == id
    }

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

/// g1t's agent, as the author of what it opens: stored by
/// [`AGENT_ID`](crate::identity::AGENT_ID), shown as `g1t`.
pub fn g1t_author() -> User {
    User {
        id: crate::identity::AGENT_ID.to_owned(),
        username: crate::identity::AGENT_NAME.to_owned(),
        kind: crate::PrincipalKind::Agent,
        ..User::default()
    }
}

/// Who is recorded as opening an issue or a pull request that `actor`
/// opens, and who asked for it: `(author, requested_by)`.
///
/// - g1t's agent, acting for someone through its token (an issue it files
///   while at work): g1t, requested by that person.
/// - A person having g1t make the change (`by_g1t`: a hosted g1t agent in
///   a fork of its own): g1t, requested by them.
/// - Anyone else, and g1t's own work that nobody asked for: the actor, and
///   nobody asking.
pub fn authorship(actor: &User, by_g1t: bool) -> (User, Option<User>) {
    let person = |id: &str, username: &str| User {
        id: id.to_owned(),
        username: username.to_owned(),
        kind: crate::PrincipalKind::User,
        ..User::default()
    };
    if actor.kind == crate::PrincipalKind::Agent {
        let asked = actor
            .acting
            .as_ref()
            .map(|acting| &acting.on_behalf_of)
            .filter(|on_behalf_of| !crate::system::is_system_id(&on_behalf_of.id))
            .map(|on_behalf_of| person(&on_behalf_of.id, &on_behalf_of.username));
        return (g1t_author(), asked);
    }
    if by_g1t && actor.kind != crate::PrincipalKind::System {
        return (g1t_author(), Some(person(&actor.id, &actor.username)));
    }
    let author = User {
        id: actor.id.clone(),
        username: actor.username.clone(),
        kind: actor.kind,
        ..User::default()
    };
    (author, None)
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

/// How one command went. Recorded by earlier runs of commands written on
/// issues, which g1t no longer runs; kept so their history still reads.
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

/// A record against a pull request's head: the merge queue taking it out,
/// with why, or an earlier run of commands written on its issue.
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
    /// The latest record against its head: the merge queue taking it out,
    /// or (from before checks were workflows) a run of its issue's commands.
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
    /// What workflow runs said about its head commit, one per workflow.
    #[serde(default)]
    pub statuses: Vec<CommitStatus>,
    /// Whether it merges cleanly into the branch it targets, worked out
    /// ahead of time whenever either side moves.
    #[serde(default)]
    pub mergeable: Mergeable,
    /// When `mergeable` is `conflicting`: the files that conflict.
    #[serde(default)]
    pub conflicts: Vec<String>,
    /// Earlier records like `checks`, newest first, without their output.
    #[serde(default)]
    pub earlier_checks: Vec<CheckRun>,
    /// The checks the default branch's protection requires, each as it
    /// stands on the head commit. Empty when none are required.
    #[serde(default, alias = "requiredChecks")]
    pub required_checks: Vec<RequiredCheck>,
}

/// Where a required check stands on a commit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequiredState {
    Success,
    Failure,
    /// Reported and still running.
    Pending,
    /// Nothing has reported it on this commit yet.
    Expected,
}

impl RequiredState {
    pub fn as_str(self) -> &'static str {
        match self {
            RequiredState::Success => "success",
            RequiredState::Failure => "failure",
            RequiredState::Pending => "pending",
            RequiredState::Expected => "expected",
        }
    }
}

/// One check a branch's protection requires, as it stands on a commit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredCheck {
    /// The check's name, such as `CI` or `g1t / deploy`.
    pub name: String,
    pub state: RequiredState,
    /// What the status that decided it says, if one did.
    #[serde(default)]
    pub description: Option<String>,
    /// Where to see more: the workflow run, for one a workflow reported.
    #[serde(default)]
    pub target_url: Option<String>,
}

/// The events a workflow status's context can end in: `CI / pull_request`
/// is the `CI` check, reported by a run for a `pull_request` event.
const STATUS_EVENTS: &[&str] = &[
    "push",
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "merge_group",
    "workflow_dispatch",
    "workflow_run",
    "workflow_call",
    "schedule",
    "release",
    "issues",
    "issue_comment",
    "repository_dispatch",
];

/// A status context's check name and the event it was reported for:
/// `CI / pull_request` is `("CI", Some("pull_request"))`. A context that
/// does not end in an event, such as `g1t / deploy`, is its own name.
pub fn check_name(context: &str) -> (&str, Option<&str>) {
    match context.rsplit_once(" / ") {
        Some((name, event)) if STATUS_EVENTS.contains(&event) && !name.trim().is_empty() => (name, Some(event)),
        _ => (context, None),
    }
}

/// Where each required check stands among a commit's statuses. A check is
/// met by any status of that name, for any event: one that failed fails
/// it, one still running holds it, and with neither, one that passed
/// passes it. Names compare without regard to case.
pub fn required_checks(required: &[String], statuses: &[CommitStatus]) -> Vec<RequiredCheck> {
    required
        .iter()
        .map(|name| {
            let matching: Vec<&CommitStatus> = statuses
                .iter()
                .filter(|status| check_name(&status.context).0.eq_ignore_ascii_case(name.trim()))
                .collect();
            let failed = matching.iter().find(|s| s.state == "failure" || s.state == "error");
            let pending = matching.iter().find(|s| s.state == "pending");
            let passed = matching.iter().find(|s| s.state == "success");
            let (state, decided) = match (failed, pending, passed) {
                (Some(status), _, _) => (RequiredState::Failure, Some(*status)),
                (None, Some(status), _) => (RequiredState::Pending, Some(*status)),
                (None, None, Some(status)) => (RequiredState::Success, Some(*status)),
                _ => (RequiredState::Expected, None),
            };
            RequiredCheck {
                name: name.trim().to_owned(),
                state,
                description: decided.and_then(|status| status.description.clone()),
                target_url: decided.and_then(|status| status.target_url.clone()),
            }
        })
        .collect()
}

/// A repository's required check names, tidied: trimmed, without blanks
/// or repeats (ignoring case), at most [`MAX_REQUIRED_CHECKS`].
pub fn tidy_required(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name: String = name.trim().chars().take(MAX_CHECK_NAME_CHARS).collect();
        if !name.is_empty() && !out.iter().any(|kept| kept.eq_ignore_ascii_case(&name)) {
            out.push(name);
        }
    }
    out.truncate(MAX_REQUIRED_CHECKS);
    out
}

/// The most checks a branch can require, and the longest name of one.
pub const MAX_REQUIRED_CHECKS: usize = 20;
pub const MAX_CHECK_NAME_CHARS: usize = 100;

/// A check name seen on the repository's commits recently, for choosing
/// required checks: what reported it, and for which events.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenCheck {
    pub name: String,
    /// The events it was reported for, such as `pull_request`; empty for a
    /// status that names none, such as a deployment's.
    pub events: Vec<String>,
    /// RFC 3339. The latest report.
    pub last_seen: String,
}

/// `seen_checks`: the check names reported on a repository's commits in
/// the last 30 days, most recent first. Returns `Outcome<Vec<SeenCheck>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SeenChecksArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
}

/// The heading an issue's plain-words description of done goes under.
pub const DEFINITION_OF_DONE: &str = "## Definition of done";

/// An issue's body with `items` added as a bulleted "Definition of done"
/// section, for the agent and reviewers to read. Nothing is added when
/// `items` is empty, or when the body already has the section, so folding
/// the same items twice changes nothing.
pub fn with_definition_of_done(body: &str, items: &[String]) -> String {
    let items: Vec<&str> = items.iter().map(|item| item.trim()).filter(|item| !item.is_empty()).collect();
    let body = body.trim();
    if items.is_empty() || body.contains(DEFINITION_OF_DONE) {
        return body.to_owned();
    }
    let list = items.iter().map(|item| format!("- {item}")).collect::<Vec<_>>().join("\n");
    if body.is_empty() {
        format!("{DEFINITION_OF_DONE}\n\n{list}")
    } else {
        format!("{body}\n\n{DEFINITION_OF_DONE}\n\n{list}")
    }
}

/// Commands, as items of a definition of done: "`npm test` passes."
pub fn commands_pass(commands: &[String]) -> Vec<String> {
    commands
        .iter()
        .map(|command| command.trim())
        .filter(|command| !command.is_empty())
        .map(|command| format!("`{}` passes.", command.replace('`', "'")))
        .collect()
}

/// Whether a pull request's change merges cleanly into the branch it
/// targets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mergeable {
    /// It merges without conflicts.
    Clean,
    /// Some files conflict: see `PullDetail::conflicts`.
    Conflicting,
    /// Not known: never worked out, or it could not be.
    #[default]
    Unknown,
    /// Being worked out now.
    Checking,
}

impl Mergeable {
    pub fn as_str(self) -> &'static str {
        match self {
            Mergeable::Clean => "clean",
            Mergeable::Conflicting => "conflicting",
            Mergeable::Unknown => "unknown",
            Mergeable::Checking => "checking",
        }
    }

    pub fn parse(value: Option<&str>) -> Mergeable {
        match value {
            Some("clean") => Mergeable::Clean,
            Some("conflicting") => Mergeable::Conflicting,
            Some("checking") => Mergeable::Checking,
            _ => Mergeable::Unknown,
        }
    }
}

/// `start_mergecheck`: claims the probe of whether a pull request merges
/// cleanly, which the work service asked for with a `pull.mergecheck`
/// event. Called by the runner service, which starts the sandbox. Refused
/// when it is no longer wanted, or when the repository already has as many
/// probes running as it may. Returns `Outcome<MergecheckJob>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMergecheckArgs {
    pub pull_id: String,
}

/// What a sandbox needs to find out whether a pull request merges cleanly.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergecheckJob {
    pub pull_id: String,
    /// Lets the sandbox, and nothing else, report this probe.
    pub token: String,
    pub repo: RepoPath,
    pub number: u32,
    pub default_branch: String,
    /// The default branch's commit to merge into.
    pub base: String,
    /// The repository holding the change: its fork, or the repository.
    pub source: RepoPath,
    /// The branch of `source` holding it.
    pub branch: String,
    /// The change's commit.
    pub head: String,
    /// Who the pull request is for ([`Pull::owner`]: whoever asked g1t for
    /// it, or its author), and so can read its source.
    pub author: User,
}

/// `report_mergecheck`: what a sandbox found. Returns `Outcome<Mergeable>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportMergecheckArgs {
    pub pull_id: String,
    pub token: String,
    /// The files that conflict; empty when it merges cleanly.
    #[serde(default)]
    pub conflicts: Vec<String>,
    /// Why it could not be found out.
    #[serde(default)]
    pub error: Option<String>,
}

/// What a workflow run (or another tool) says about a commit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStatus {
    /// What reported it, such as `CI / push`.
    pub context: String,
    /// `pending`, `success`, `failure` or `error`.
    pub state: String,
    pub description: Option<String>,
    /// Where to see more, such as the run's page.
    pub target_url: Option<String>,
    pub updated_at: String,
}

/// `set_commit_status`: for services only. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCommitStatusArgs {
    pub repo_id: String,
    pub sha: String,
    pub context: String,
    pub state: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_url: Option<String>,
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
/// The pull request's owner ([`Pull::owner`]: whoever asked g1t for it, or
/// its author) and members of the workspace may. Returns
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
    /// Waiting for the checks workflows report on its head.
    Checking,
    /// g1t is reviewing it.
    Reviewing,
    /// The agent is addressing failed checks or a review.
    Revising,
    /// The agent is merging in the branch it would land on, which moved.
    CatchingUp,
    /// Woken to answer a question another agent asked it, or a handoff.
    Answering,
    /// In the repository's merge queue, being tested with what is ahead of
    /// it before it lands.
    Queued,
    /// Required checks passed, reviewed and approved, up to date. A
    /// person merges.
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
    /// Who the pull request belongs to ([`Pull::owner`]: whoever asked g1t
    /// for it, or its author). Sandboxes act as them.
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
    /// required checks passed and approved as the settings below require.
    pub auto_merge: bool,
    /// The checks that must pass on a pull request's head before it may
    /// merge into the default branch, by name: a workflow's name (`CI`), or
    /// the context of another status (`g1t / deploy`). The same for a
    /// person's pull request and an agent's, and for the merge queue.
    pub required_checks: Vec<String>,
    /// Refuse to merge a pull request that does not contain the default
    /// branch's latest commits, so that what merges is what was checked.
    /// When off, merging one that is behind brings it up to date first.
    pub require_up_to_date: bool,
    /// How many approving reviews a pull request needs before it may
    /// merge. A reviewer who has since asked for changes blocks it.
    pub required_approvals: u32,
    /// Whether a g1t agent's approval counts towards `required_approvals`.
    pub count_agent_approvals: bool,
    /// Whether someone who may merge can bypass required checks that have
    /// not passed, by saying so as they merge.
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
    /// Ask a person before merging a g1t agent's change whose confidence is
    /// low: auto-merge and the merge queue leave it, and it needs someone,
    /// until a person approves it.
    pub hold_low_confidence: bool,
    /// Username of the member who last changed the settings, if anyone has.
    pub updated_by: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

impl Default for RepoSettings {
    fn default() -> Self {
        RepoSettings {
            auto_merge: false,
            required_checks: Vec::new(),
            require_up_to_date: false,
            required_approvals: 0,
            count_agent_approvals: true,
            allow_ignoring_checks: true,
            agent_review: true,
            max_revisions: 2,
            merge_queue: false,
            hold_low_confidence: true,
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

/// `wake_for_messages`: the agent on a pull request was asked a question
/// or handed work while it was not at work. Claims a short step for it to
/// answer, and hands over what it was sent, marked read. Null when there
/// is nothing waiting, or the pull request cannot take a step now.
/// Returns `Option<Wake>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeForMessagesArgs {
    pub pull_id: String,
}

/// What an agent woken to answer needs: its pull request, and what it was
/// sent, oldest first.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    pub job: LifecycleJob,
    pub messages: Vec<AgentMessage>,
}

/// `stall`: records that a step could not be carried out, so that g1t
/// stops and a person is asked. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallArgs {
    pub pull_id: String,
    pub reason: String,
    /// The person who stopped it, by id, when someone did: they are not
    /// told it needs them.
    #[serde(default)]
    pub by: Option<String>,
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
    /// Deprecated: commands, added to the body under "Definition of done".
    /// Checks are the workflows the branch's protection requires.
    #[serde(default)]
    pub checks: Vec<String>,
}

/// `delegate_issue`: opens an issue to put g1t on at once, refused
/// before anything is opened unless `actor` may put agents to work in the
/// repository (Run, which the Write role has). The runner service's
/// `delegate` calls it and then starts the agent. Returns `Outcome<Issue>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DelegateIssueArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub labels: Vec<String>,
    /// Deprecated, as on `OpenIssueArgs`.
    #[serde(default)]
    pub checks: Vec<String>,
}

/// What became of the agent when an issue was opened and handed to it in
/// one step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStartStatus {
    /// It is at work on the issue's pull request.
    Started,
    /// Every agent slot of the workspace is busy: it starts on its own when
    /// one frees up.
    Queued,
    /// It did not start, and will not until someone fixes what `code` says.
    NotStarted,
}

/// Whether the agent started, and if not, why and what fixes it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStart {
    pub status: AgentStartStatus,
    /// Why it did not start: `not_paid`, `trial_used`, `limit`, `paused`,
    /// `issue_cap`, `billing_unavailable` or `no_model`; `waiting` when
    /// queued.
    #[serde(default)]
    pub code: Option<String>,
    /// What happened, in a sentence or two, with what to do.
    #[serde(default)]
    pub message: Option<String>,
    /// Where the fix is: the workspace's billing or model settings.
    #[serde(default)]
    pub fix_url: Option<String>,
}

/// The runner service's `delegate`: the issue opened, and the agent put on
/// it. The issue exists whatever became of the agent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delegated {
    pub issue: Issue,
    /// The pull request the agent opened, when it started.
    #[serde(default)]
    pub pull: Option<Pull>,
    pub agent: AgentStart,
}

/// `report_confidence`: what the agent of a run says of its own change,
/// with the run's own token. Kept with the run, and the pull request's
/// confidence is worked out again with it. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportConfidenceArgs {
    pub run_id: String,
    pub token: String,
    /// `high`, `medium` or `low`.
    pub confidence: String,
    #[serde(default)]
    pub uncertain_about: Vec<String>,
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

/// `pulls_for_repos`: the newest open and the newest closed pull requests
/// of many repositories, in one call, for pages that show several projects
/// at once. Repositories the viewer cannot read are left out, as are forks
/// (ask those with `list_pulls`). Returns `Vec<RepoPulls>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullsForReposArgs {
    /// At most [`MAX_PULLS_FOR_REPOS`] are looked at.
    pub repo_ids: Vec<String>,
    pub viewer: Viewer,
    /// How many of each, open and closed, per repository (at most 100).
    pub limit: u32,
}

/// The most repositories one `pulls_for_repos` call looks at.
pub const MAX_PULLS_FOR_REPOS: usize = 50;

/// One repository's pull requests from `pulls_for_repos`, newest first.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPulls {
    pub repo_id: String,
    /// Draft and open.
    pub open: Vec<Pull>,
    /// Merged and closed.
    pub closed: Vec<Pull>,
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
    /// Assigning it to g1t is the runner's `run`, not this.
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
///
/// Also `catch_up_pull`: brings the pull request up to date with the
/// default branch without a sandbox where that is safe, as the repos
/// service's `update_pull_branch` does, after checking that `actor` may
/// update it: its owner ([`Pull::owner`]) for a fork, any member for a
/// branch.
/// Returns `Outcome<repos::PullBranchUpdate>`; on `needs_agent` nothing was
/// pushed and the runner's `update` is the way on.
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
    /// For `merge_pull`: merge although required checks have not passed,
    /// where the repository lets members bypass them.
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
    /// What is true once it is done, in plain words. Added to the issue's
    /// body under "Definition of done". Plans written before this was
    /// called `done` named it `checks`.
    #[serde(alias = "checks")]
    pub done: Vec<String>,
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
    /// `answering`, `queued`, `ready`, `needs_you`), `landed` or `closed`.
    pub state: String,
    /// One sentence about where it stands.
    pub detail: String,
    /// The issues it is waiting on that are still open.
    pub blocked_by: Vec<u32>,
    /// The pull request carrying it, the newest if several.
    pub pull: Option<u32>,
    /// Who or what is working on it, e.g. `g1t`.
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
    /// May include `g1t`. Asking for its review does not by itself
    /// start one; the runner's `review` does.
    #[serde(default)]
    pub reviewers: Option<Vec<String>>,
}

/// `start_checks`: always refused now; a pull request's checks are the
/// workflows run on it. Kept so that a runner from before is answered.
/// Returns `Outcome<CheckJob>`.
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
    /// Who the pull request is for ([`Pull::owner`]: whoever asked g1t for
    /// it, or its author), and so can read its source.
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
    /// Who the pull request is for ([`Pull::owner`]: whoever asked g1t for
    /// it, or its author), and so can read its source.
    pub author: User,
    /// The files it changes, as of its latest push: how large the change
    /// is, which decides the model that reviews it.
    #[serde(default)]
    pub files: Vec<ChangedFile>,
    /// What among them runs, configures or guards things (CI workflows,
    /// secrets, infrastructure), once each. Any sends the review to the
    /// larger model.
    #[serde(default)]
    pub sensitive: Vec<String>,
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
    /// Who or what made the pull request, e.g. `g1t`.
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
    /// Commands run against the tested state by queues from before its
    /// checks were workflows. Empty since.
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
    /// Commands to run on the built state. Always empty: the state is
    /// checked by the `merge_group` workflows run on it, and the default
    /// branch's required checks must pass there.
    pub checks: Vec<String>,
    /// Always empty, as `checks`.
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
    /// For a merge conflict: the files that conflicted.
    #[serde(default)]
    pub conflicts: Vec<String>,
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

// --- A person's work -------------------------------------------------------

/// Issues or pull requests, on a person's profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthoredKind {
    Issue,
    Pull,
}

/// The state filter on a person's work. `Closed` takes in merged pull
/// requests too; `Merged` is only those.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthoredState {
    Open,
    Closed,
    Merged,
}

/// How a person's work is ordered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthoredSort {
    /// Newest first.
    #[default]
    Created,
    /// Most recently changed first.
    Updated,
    /// Oldest first.
    Oldest,
}

/// The most items one `by_author` page holds.
pub const AUTHORED_PAGE: u32 = 25;

/// `by_author`: the issues and pull requests a person opened, only on
/// repositories `viewer` may read, so a private title never reaches anyone
/// who could not open it. Returns `Outcome<Authored>`; not found for an
/// account that does not exist.
#[derive(Debug, Serialize, Deserialize)]
pub struct ByAuthorArgs {
    pub username: String,
    pub viewer: Viewer,
    #[serde(default)]
    pub kind: Option<AuthoredKind>,
    #[serde(default)]
    pub state: Option<AuthoredState>,
    /// Only work on this repository: `namespace/name`.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub sort: AuthoredSort,
    /// The `next` of the page before, to read on from there.
    #[serde(default)]
    pub before: Option<String>,
    /// At most [`AUTHORED_PAGE`]; that when absent.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// One issue or pull request a person opened.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoredItem {
    pub kind: AuthoredKind,
    pub repo: RepoPath,
    pub number: u32,
    pub title: String,
    /// Open or closed; a merged pull request is closed.
    pub state: State,
    /// A pull request's own status.
    pub status: Option<PullStatus>,
    /// Why an issue was closed.
    pub reason: Option<IssueReason>,
    pub draft: bool,
    pub merged: bool,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
    /// When a pull request was merged. RFC 3339.
    pub merged_at: Option<String>,
}

/// What a person has done, as far as the viewer may see.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoredCounts {
    pub pulls_merged: u32,
    pub pulls_open: u32,
    pub pulls: u32,
    pub issues: u32,
    pub issues_open: u32,
}

/// A repository a person has opened work on, with how much.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthoredRepo {
    pub repo: RepoPath,
    pub count: u32,
}

/// A page of a person's work.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authored {
    pub items: Vec<AuthoredItem>,
    /// Pass as `before` for the next page; null on the last.
    pub next: Option<String>,
    /// Over every repository the viewer may read, whatever the filters.
    pub counts: AuthoredCounts,
    /// Those repositories, most work first.
    pub repos: Vec<AuthoredRepo>,
}

#[cfg(test)]
mod required_tests {
    use super::*;

    fn status(context: &str, state: &str) -> CommitStatus {
        CommitStatus {
            context: context.into(),
            state: state.into(),
            description: Some(format!("{context} {state}")),
            target_url: None,
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_context_names_its_check_and_event() {
        assert_eq!(check_name("CI / pull_request"), ("CI", Some("pull_request")));
        assert_eq!(check_name("Build and test / merge_group"), ("Build and test", Some("merge_group")));
        assert_eq!(check_name("g1t / deploy"), ("g1t / deploy", None));
        assert_eq!(check_name("g1t / deploy (docs)"), ("g1t / deploy (docs)", None));
        assert_eq!(check_name("lint"), ("lint", None));
    }

    #[test]
    fn required_checks_are_missing_pending_failed_or_passed() {
        let required = vec!["CI".to_owned(), "Lint".to_owned(), "g1t / deploy".to_owned(), "Docs".to_owned()];
        let statuses = [
            status("CI / pull_request", "success"),
            status("Lint / pull_request", "pending"),
            status("g1t / deploy", "failure"),
        ];
        let states: Vec<RequiredState> = required_checks(&required, &statuses).into_iter().map(|c| c.state).collect();
        assert_eq!(
            states,
            [RequiredState::Success, RequiredState::Pending, RequiredState::Failure, RequiredState::Expected]
        );
    }

    #[test]
    fn any_event_reports_a_check_and_a_failure_wins() {
        let required = vec!["ci".to_owned()];
        let both = [status("CI / push", "failure"), status("CI / pull_request", "success")];
        let check = &required_checks(&required, &both)[0];
        assert_eq!(check.state, RequiredState::Failure);
        assert_eq!(check.description.as_deref(), Some("CI / push failure"));
        let queue = [status("CI / merge_group", "success")];
        assert_eq!(required_checks(&required, &queue)[0].state, RequiredState::Success);
    }

    #[test]
    fn required_names_are_tidied() {
        let names = vec![" CI ".to_owned(), "ci".to_owned(), String::new(), "Lint".to_owned()];
        assert_eq!(tidy_required(&names), ["CI", "Lint"]);
    }

    #[test]
    fn a_definition_of_done_is_added_once() {
        let items = commands_pass(&["cargo test".to_owned(), " ".to_owned()]);
        assert_eq!(items, ["`cargo test` passes."]);
        let body = with_definition_of_done("Fix the greeting.", &items);
        assert_eq!(body, "Fix the greeting.\n\n## Definition of done\n\n- `cargo test` passes.");
        assert_eq!(with_definition_of_done(&body, &items), body);
        assert_eq!(with_definition_of_done("", &items), "## Definition of done\n\n- `cargo test` passes.");
        assert_eq!(with_definition_of_done(" Text ", &[]), "Text");
    }
}

#[cfg(test)]
mod authorship_tests {
    use super::*;
    use crate::PrincipalKind;
    use crate::credentials::{Acting, Principal};
    use crate::identity::{AGENT_ID, AgentScope};

    fn person() -> User {
        User {
            id: "usr_1".into(),
            username: "syntaqx".into(),
            verified: true,
            ..User::default()
        }
    }

    fn agent_for(id: &str, username: &str) -> User {
        User {
            id: AGENT_ID.into(),
            username: "g1t".into(),
            kind: PrincipalKind::Agent,
            acting: Some(Box::new(Acting {
                credential_id: "tok_1".into(),
                agent: "g1t".into(),
                on_behalf_of: Principal { id: id.into(), username: username.into() },
                scope: AgentScope {
                    repo: RepoPath { namespace: "acme".into(), name: "web".into() },
                    operations: Vec::new(),
                    run: None,
                },
            })),
            ..User::default()
        }
    }

    fn pull(author: User, requested_by: Option<User>) -> Pull {
        let mut pull: Pull = serde_json::from_value(serde_json::json!({
            "id": "pr_1", "repoId": "rep_1", "number": 14, "issue": 12, "title": "Fix it", "body": null,
            "agent": "g1t", "runtime": "hosted", "status": "open", "fork": null, "forkRepoId": null,
            "branch": null, "headCommit": null, "mergeBase": null, "mergedBy": null, "mergedAt": null,
            "supersededBy": null, "checkStatus": null,
            "author": { "id": "x", "username": "x" },
            "createdAt": "", "updatedAt": ""
        }))
        .unwrap();
        pull.author = author;
        pull.requested_by = requested_by;
        pull
    }

    #[test]
    fn a_change_a_person_has_g1t_make_is_g1t_s_requested_by_them() {
        let (author, asked) = authorship(&person(), true);
        assert_eq!((author.id.as_str(), author.username.as_str(), author.kind), (AGENT_ID, "g1t", PrincipalKind::Agent));
        let asked = asked.expect("the person asked for it");
        assert_eq!((asked.id.as_str(), asked.username.as_str(), asked.kind), ("usr_1", "syntaqx", PrincipalKind::User));
    }

    #[test]
    fn what_g1t_s_agent_files_at_work_is_g1t_s_requested_by_whoever_it_works_for() {
        let (author, asked) = authorship(&agent_for("usr_1", "syntaqx"), false);
        assert_eq!(author.id, AGENT_ID);
        assert_eq!(asked.map(|user| user.username), Some("syntaqx".into()));
    }

    #[test]
    fn nobody_asked_for_g1t_s_own_work() {
        // A run g1t started itself acts for g1t, not for a person.
        let (author, asked) = authorship(&agent_for(crate::system::ID, "g1t"), false);
        assert_eq!(author.id, AGENT_ID);
        assert!(asked.is_none());
        // A security update g1t opens is g1t's own, as before.
        let (author, asked) = authorship(&User::system("acme"), true);
        assert_eq!((author.id.as_str(), author.kind), (crate::system::ID, PrincipalKind::System));
        assert!(asked.is_none());
    }

    #[test]
    fn anyone_else_opens_their_own() {
        let (author, asked) = authorship(&person(), false);
        assert_eq!((author.id.as_str(), author.kind), ("usr_1", PrincipalKind::User));
        assert!(asked.is_none());
        // Nothing but who they are is kept.
        assert!(author.workspaces.is_empty() && author.acting.is_none());
    }

    #[test]
    fn the_requester_owns_g1t_s_pull_request_and_an_author_their_own() {
        let made = pull(g1t_author(), Some(person()));
        assert_eq!(made.owner().id, "usr_1");
        assert!(made.is_owned_by("usr_1"));
        assert!(!made.is_owned_by(AGENT_ID), "g1t's agent does not answer for its own change");
        let own = pull(person(), None);
        assert_eq!(own.owner().id, "usr_1");
        assert!(own.is_owned_by("usr_1"));
    }

    #[test]
    fn requested_by_is_null_when_nobody_asked_and_read_as_absent_from_older_senders() {
        let own = pull(person(), None);
        let sent = serde_json::to_value(&own).unwrap();
        assert!(sent["requestedBy"].is_null());
        let mut older = sent.clone();
        older.as_object_mut().unwrap().remove("requestedBy");
        let read: Pull = serde_json::from_value(older).unwrap();
        assert!(read.requested_by.is_none());
    }
}
