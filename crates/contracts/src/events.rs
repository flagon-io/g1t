//! Events published on the bus, and the events service that carries them.
//! Mirrors `packages/contracts/src/events.ts`.

use serde::Serialize;

/// The key in an event's `data` that marks what a workflow job's own token
/// (`G1T_TOKEN`) did, with the run's id as its value. The actions service
/// starts no workflows for such an event, as GitHub starts none for what
/// its `GITHUB_TOKEN` does, so a workflow cannot set itself off.
pub const CAUSED_BY_JOB: &str = "causedByJob";

/// The run whose job's token caused an event, if one did.
pub fn caused_by_job(data: &serde_json::Value) -> Option<&str> {
    data[CAUSED_BY_JOB].as_str().filter(|run| !run.is_empty())
}

/// The run whose job's token `actor` is acting with, if it is one.
pub fn job_run_of(actor: &crate::User) -> Option<&str> {
    actor.token.as_deref().and_then(|token| token.job.as_ref()).map(|job| job.run_id.as_str())
}

/// `data` as JSON, marked as a workflow job's doing when `actor` acted
/// with a job's token (see [`CAUSED_BY_JOB`]).
pub fn marked<T: Serialize>(data: T, actor: Option<&crate::User>) -> serde_json::Value {
    let mut value = serde_json::to_value(data).unwrap_or(serde_json::Value::Null);
    if let (Some(run), serde_json::Value::Object(map)) = (actor.and_then(job_run_of), &mut value) {
        map.insert(CAUSED_BY_JOB.to_owned(), serde_json::Value::String(run.to_owned()));
    }
    value
}

/// `data` as JSON, marked as a workflow job's doing when the event it
/// follows from (`cause`, its data) was: a push by a job's token moves its
/// pull request, and that starts no workflows either.
pub fn carried<T: Serialize>(data: T, cause: &serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::to_value(data).unwrap_or(serde_json::Value::Null);
    if let (Some(run), serde_json::Value::Object(map)) = (caused_by_job(cause), &mut value) {
        map.insert(CAUSED_BY_JOB.to_owned(), serde_json::Value::String(run.to_owned()));
    }
    value
}

/// What a publisher supplies; the bus fills in the id and time.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent<T: Serialize> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// The service that published it.
    pub source: &'static str,
    /// The repo the event concerns.
    pub repo_id: Option<String>,
    /// The user or agent that caused it, if any.
    pub actor: Option<String>,
    pub data: T,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCreated {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
    pub is_private: bool,
}

/// The payload of `repo.collaborator_added`, `repo.collaborator_removed`
/// and `repo.collaborator_role_changed`: a person's own role on one
/// repository (see `access`). `role` is the role they have now (null once
/// removed); `previous_role` what they had before (null when added).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCollaborator {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
    pub username: String,
    pub role: Option<crate::access::RepoRole>,
    pub previous_role: Option<crate::access::RepoRole>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoForked {
    pub repo_id: String,
    pub source_repo_id: String,
    pub pull_id: String,
}

/// One branch or tag moved by a push. `after` is the commit it points to now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPush {
    pub repo_id: String,
    /// The full ref, such as `refs/heads/main`.
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// Where it pointed before; absent for a new branch or tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    pub after: String,
    /// Whether the ref is the repository's default branch.
    pub default_branch: bool,
    /// Set when the push was too large to scan for secrets before it was
    /// stored, and was let through: the security service scans
    /// `before..after` after it landed. Absent otherwise.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unscanned: bool,
    /// Set when a workflow job's token pushed: the run's id (see
    /// [`CAUSED_BY_JOB`]). Absent otherwise.
    #[serde(rename = "causedByJob", skip_serializing_if = "Option::is_none")]
    pub caused_by_job: Option<String>,
}

/// The payload of `issue.opened`, `issue.updated`, `issue.assigned`,
/// `issue.labeled`, `issue.unlabeled`, `issue.milestoned`,
/// `issue.demilestoned`, `issue.closed` and `issue.reopened`; each uses
/// the fields that apply to it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueEvent {
    pub issue_id: String,
    pub repo_id: String,
    pub number: u32,
    /// Who opened it: g1t, for one its agent filed while at work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<crate::credentials::Principal>,
    /// For an issue g1t's agent filed: the person it was working for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<crate::credentials::Principal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// On close: `completed` or `not_planned`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    /// On close: the number of the pull request whose merge closed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<u32>,
    /// On `issue.assigned`: the people it is now assigned to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
    /// On `issue.assigned`: those of them who were not before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<Vec<String>>,
    /// On `issue.labeled` and `issue.unlabeled`: the label put on or taken
    /// off. One event for each.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<EventLabel>,
    /// On `issue.milestoned`: the milestone it was put in; on
    /// `issue.demilestoned`, the one it was taken out of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<crate::work::MilestoneRef>,
}

/// A label, as `issue.labeled`, `pull.labeled` and their `unlabeled` say.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct EventLabel {
    pub name: String,
    /// Six hex digits.
    pub color: String,
}

/// The payload of `pull.opened`, `pull.ready`, `pull.updated` (its head
/// moved), `pull.closed`, `pull.merged`, `pull.assigned`,
/// `pull.review_requested` and `pull.review_request_removed` (reviewers
/// asked, or no longer), `pull.labeled` and `pull.unlabeled`,
/// `pull.milestoned` and `pull.demilestoned`, `pull.base_changed` (the
/// branch it merges into changed), `pull.stalled` (g1t stopped seeing it
/// through until a person steps in) and `pull.resumed` (it picked back
/// up); each uses the fields that apply to it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullEvent {
    pub pull_id: String,
    pub repo_id: String,
    pub number: u32,
    /// Who opened it: g1t, for a change g1t made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<crate::credentials::Principal>,
    /// For a change g1t made: the person who asked for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<crate::credentials::Principal>,
    /// The number of the issue it is for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// On merge: the commit the branch now points to. On update and when
    /// marked ready: the head of the change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// On close: the pull request that was merged instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<u32>,
    /// How sure g1t is of a g1t agent's change, once it has worked that out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<crate::work::Confidence>,
    /// On `pull.assigned`: the people it is now assigned to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
    /// On `pull.assigned`: those newly assigned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<Vec<String>>,
    /// On `pull.review_requested`: the reviewers newly asked; on
    /// `pull.review_request_removed`, those no longer asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewers: Option<Vec<String>>,
    /// On `pull.review_requested` and `pull.review_request_removed`: the
    /// teams newly asked, or no longer, each with the people it asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teams: Option<Vec<TeamRequested>>,
    /// On `pull.review_requested`: asked because they own files it changes
    /// (its CODEOWNERS file), not by a person.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub code_owners: bool,
    /// On `pull.stalled`: why g1t stopped, and what would start it again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// On `pull.labeled` and `pull.unlabeled`: the label put on or taken off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<EventLabel>,
    /// On `pull.milestoned`: the milestone it was put in; on
    /// `pull.demilestoned`, the one it was taken out of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<crate::work::MilestoneRef>,
    /// On `pull.opened` and `pull.base_changed`: the branch it merges into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// A team asked to review a pull request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRequested {
    /// `workspace/slug`.
    pub team: String,
    /// Everyone in it who is told: the whole team, or, with review
    /// assignment, the people picked (and the rest when it says to tell
    /// them). Never the pull request's author.
    pub notified: Vec<String>,
    /// With review assignment: the people picked, who are asked as
    /// reviewers themselves.
    #[serde(default)]
    pub assigned: Vec<String>,
}

/// The payload of every `team.*` event: `team.created`, `team.edited`,
/// `team.deleted`; `team.member_added`, `team.member_role_changed`,
/// `team.member_removed` (with `username`, `role` and `previousRole`);
/// and `team.repo_added`, `team.repo_role_changed`, `team.repo_removed`
/// (with `repoId`, `repo`, `repoRole` and `previousRepoRole`), which also
/// name the repository as the event's own.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamChanged {
    pub workspace: String,
    pub team_id: String,
    /// The team's slug, as it is now.
    pub team: String,
    pub name: String,
    pub visibility: Option<crate::teams::TeamVisibility>,
    /// The parent's slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// On `team.edited`: what changed, such as `name` or `parent`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<crate::teams::TeamRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_role: Option<crate::teams::TeamRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    /// `workspace/name`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_role: Option<crate::access::RepoRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_repo_role: Option<crate::access::RepoRole>,
}

/// `deployment.succeeded` and `deployment.failed`: a build of a project
/// finished, for production or for one pull request's preview.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentEvent {
    pub deployment_id: String,
    pub project_id: String,
    pub repo_id: String,
    pub workspace: String,
    /// The project's slug.
    pub project: String,
    /// `production` or `preview`.
    pub kind: String,
    pub branch: Option<String>,
    /// For a preview: its pull request.
    pub number: Option<u32>,
    pub commit: String,
    /// Where the deployment is on the site, such as
    /// `/acme/rocket/deployments/dpl_1`.
    pub path: String,
    /// For a failure: what went wrong.
    pub error: Option<String>,
    /// For a success: whether the deployment before it, of the same app, failed.
    pub recovered: bool,
    /// Who started it, by username, or `g1t`.
    pub triggered_by: String,
}

/// `checks.completed`: a run of an issue's acceptance checks against a pull
/// request finished.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksEvent {
    pub pull_id: String,
    pub repo_id: String,
    pub number: u32,
    /// `passed`, `failed` or `errored`.
    pub status: &'static str,
    /// The commit that was checked.
    pub commit: String,
}

/// `workflow.completed`: a GitHub Actions run finished.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEvent {
    pub run_id: String,
    pub repo_id: String,
    /// The workflow's name, and its file.
    pub workflow: String,
    pub path: String,
    /// The run's number among the workflow's runs.
    pub number: u64,
    /// The GitHub event that started it, such as `push`.
    pub event: String,
    /// `success`, `failure`, `cancelled` or `skipped`.
    pub conclusion: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
    /// The pull request it ran for, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull: Option<u32>,
}

/// `review.completed`: a g1t agent finished reviewing a pull request, or
/// could not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvent {
    pub pull_id: String,
    pub repo_id: String,
    pub number: u32,
    /// `approve` or `request_changes`; absent when no review was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<&'static str>,
}

/// `comment.created`. `number` is the issue or pull request commented on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentCreated {
    pub comment_id: String,
    pub repo_id: String,
    pub number: u32,
    /// Set when the comment is on a pull request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_id: Option<String>,
    /// Set when the comment is a review: approve or request changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<crate::work::Verdict>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAppended {
    pub pull_id: String,
    pub repo_id: String,
    pub number: u32,
    pub count: u32,
}

/// An event as stored in the log and delivered to subscribers. `data` is
/// left as JSON; each reader decodes the types it cares about.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// Sorts by the time the event was published.
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// The service that published it.
    pub source: String,
    /// RFC 3339.
    pub time: String,
    /// The repo the event concerns.
    pub repo_id: Option<String>,
    /// The user or agent that caused it, if any.
    pub actor: Option<String>,
    pub data: serde_json::Value,
}

/// `publish`, as a publisher sends it. Returns nothing.
#[derive(Debug, Serialize)]
pub struct Publish<T: Serialize> {
    pub events: Vec<NewEvent<T>>,
}

/// `publish`, as the events service reads it.
#[derive(Debug, serde::Deserialize)]
pub struct PublishArgs {
    pub events: Vec<Published>,
}

/// A [`NewEvent`] of any type, as received.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    #[serde(rename = "type")]
    pub kind: String,
    pub source: String,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
    pub data: serde_json::Value,
}

/// `list`: events from the log, newest first. Returns `Vec<Event>`.
#[derive(Debug, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    #[serde(default)]
    pub repo_id: Option<String>,
    /// Only these types; all types when empty.
    #[serde(default)]
    pub types: Vec<String>,
    /// Only events older than this event id.
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `workspace.renamed`: a workspace's slug changed from `from` to `to`.
/// Every service that stores a slug moves its rows to the workspace's
/// *current* slug (ask identity by `workspace_id`), so that a repeated or
/// late delivery after a second rename still lands in the right place.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRenamed {
    pub workspace_id: String,
    pub from: String,
    pub to: String,
}

impl WorkspaceRenamed {
    /// The slugs whose rows move to `current`: the two this rename names,
    /// minus `current` itself. Moving rows keyed by either converges on the
    /// current slug whatever order renames are delivered in.
    pub fn stale_slugs(&self, current: &str) -> Vec<String> {
        let mut slugs: Vec<String> = Vec::new();
        for slug in [&self.from, &self.to] {
            if slug != current && !slugs.contains(slug) {
                slugs.push(slug.clone());
            }
        }
        slugs
    }
}

/// `repo.updated`: a repository's description, topics or visibility
/// changed. `visibility_changed` says whether it went public or private,
/// which `repo.visibility_changed` also announces on its own.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoUpdated {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
    pub is_private: bool,
    #[serde(default)]
    pub visibility_changed: bool,
}

/// `repo.visibility_changed`: a repository went public or private.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoVisibilityChanged {
    pub repo_id: String,
    pub is_private: bool,
}

/// `repo.renamed`: a repository's name changed within its workspace,
/// keeping its id and its git store key. Like `repo.transferred`, a path
/// change: every service that keeps rows under the repository's path moves
/// them to its *current* path (ask repos `path_by_id`), so a repeated or
/// late delivery after a second rename or a transfer still lands in the
/// right place. `g1t_kit::transfer::on_event` handles both.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRenamed {
    pub repo_id: String,
    /// The workspace it is in.
    pub namespace: String,
    /// Its old name.
    pub from: String,
    /// Its new name.
    pub to: String,
}

impl RepoRenamed {
    /// The paths whose rows move to `current` (`namespace/name`): the two
    /// this rename names, minus `current`.
    pub fn stale_paths(&self, current: &str) -> Vec<String> {
        let mut paths: Vec<String> = Vec::new();
        for name in [&self.from, &self.to] {
            let path = format!("{}/{name}", self.namespace);
            if path != current && !paths.contains(&path) {
                paths.push(path);
            }
        }
        paths
    }
}

/// `repo.deleted`: a repository was deleted. It is hidden everywhere and
/// git refuses it, but it can be restored until `purge_after`, so services
/// stop what runs for it (agents, workflows, deployments, indexing,
/// webhook deliveries) and hide it, and keep what they hold until
/// `repo.purged`. `repo.restored` brings it back.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDeleted {
    pub repo_id: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_private: bool,
    /// RFC 3339: when it is purged unless restored first.
    #[serde(default)]
    pub purge_after: String,
    /// It went with its workspace (`workspace.deleting`). Services that
    /// handle the workspace as a whole (deployments pauses its apps rather
    /// than taking them down) leave this one to that.
    #[serde(default)]
    pub with_workspace: bool,
}

/// `repo.restored`: a deleted repository is back, at its path, as it was.
/// Services start again what `repo.deleted` stopped: index it, deploy its
/// production, show it.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRestored {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
    pub is_private: bool,
    /// It came back with its workspace (`workspace.restored`).
    #[serde(default)]
    pub with_workspace: bool,
}

/// `repo.purged`: a deleted repository is gone for good, its git data
/// with it. Services drop every row they keep for it by `repo_id`, except
/// history that belongs to its workspace: ledgers, invoices and the audit
/// log. Its path is free for a new repository.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPurged {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
}

/// `repo.archived` and `repo.unarchived`: a repository became read-only,
/// or writable again. While archived, pushes are refused, issues and pull
/// requests are locked, and agents and workflows do not run for it; its
/// deployments keep serving.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoArchived {
    pub repo_id: String,
    pub namespace: String,
    pub name: String,
    pub archived: bool,
}

/// `repo.default_branch_changed`: the branch everything lands on is now
/// `to`. `renamed` says whether `from` was renamed to `to` (open pull
/// requests into it now target `to`) rather than another branch chosen.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDefaultBranchChanged {
    pub repo_id: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub renamed: bool,
}

/// `branch.renamed`: a branch was renamed. Pull requests from or into
/// `from` follow it to `to`, and web addresses that name `from` redirect.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRenamed {
    pub repo_id: String,
    pub from: String,
    pub to: String,
    /// Whether it is the default branch.
    #[serde(default)]
    pub default_branch: bool,
}

/// `repo.transferred`: a repository moved from one workspace to another,
/// keeping its id and its name. Every service that keeps a repository
/// under its path (`namespace/name`) or its workspace's slug moves those
/// rows to the repository's *current* path (ask repos `path_by_id`), so a
/// repeated or late delivery after a second transfer still lands in the
/// right place. What was charged or recorded before the transfer stays
/// with the workspace it happened in.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoTransferred {
    pub repo_id: String,
    pub name: String,
    /// The workspace it left.
    pub from: String,
    /// The workspace it went to.
    pub to: String,
}

impl RepoTransferred {
    /// The paths whose rows move to `current` (`namespace/name`): the two
    /// this transfer names, minus `current`. Moving rows keyed by either
    /// converges whatever order transfers are delivered in.
    pub fn stale_paths(&self, current: &str) -> Vec<String> {
        let mut paths: Vec<String> = Vec::new();
        for namespace in [&self.from, &self.to] {
            let path = format!("{namespace}/{}", self.name);
            if path != current && !paths.contains(&path) {
                paths.push(path);
            }
        }
        paths
    }
}

/// `workspace.deleted`: a workspace is gone. Services drop what they keep
/// for it alone (its webhooks, integrations, secrets, memory, guardrails,
/// agent queue) and keep what is history: ledgers, invoices and the audit
/// log stay under its slug, which is never given to another workspace.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeleted {
    pub workspace_id: String,
    pub slug: String,
}

/// `workspace.deleting`: an owner deleted a workspace, and it can be
/// restored by g1t's staff until `purge_after`. Nobody can reach it in the
/// meantime. Services hide what they keep for it and stop what runs for it,
/// keeping their rows: repos deletes its repositories softly (each with a
/// `repo.deleted` whose `with_workspace` is set), deployments pauses its
/// apps, search drops it from results. `workspace.restored` undoes exactly
/// that; once `purge_after` passes, `workspace.deleted` follows and
/// services purge as for any deleted workspace.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeleting {
    pub workspace_id: String,
    pub slug: String,
    /// The username of the owner who deleted it.
    pub by: String,
    /// RFC 3339: when it is purged unless restored first.
    pub purge_after: String,
}

/// `workspace.restored`: staff brought a deleted workspace back, with its
/// members and tokens. Services undo what they did on `workspace.deleting`,
/// and only that: a repository deleted on its own before stays deleted.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestored {
    pub workspace_id: String,
    pub slug: String,
}

/// `user.updated`: an account was made, or changed what its profile shows
/// (name, bio, avatar). Nothing private: ask identity for the profile.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserUpdated {
    pub username: String,
}

/// `user.email_added`, `user.email_verified`, `user.email_removed` and
/// `user.primary_email_changed`: an account's addresses changed. Never the
/// address itself; ask identity, as the person, for that.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEmailChanged {
    pub user_id: String,
    /// Whether g1t staff made the change.
    #[serde(default)]
    pub by_staff: bool,
}

/// `workspace.updated`: a workspace was made, or its name, description or
/// icon changed. Ask identity for it by slug.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdated {
    pub workspace_id: String,
    pub slug: String,
}

/// `invite.created`: someone (or staff) made an invite. Never the code or
/// the address it is for.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCreated {
    pub invite_id: String,
    /// The account that made it; null when staff did.
    pub inviter_id: Option<String>,
    /// The workspace it joins.
    pub workspace_id: Option<String>,
    /// Whether it is bound to one email address.
    pub bound: bool,
}

/// `invite.redeemed`: an invite was used, by a new account or by an
/// existing one joining a workspace.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRedeemed {
    pub invite_id: String,
    pub user_id: String,
    pub inviter_id: Option<String>,
    pub workspace_id: Option<String>,
    /// Whether it made the account.
    pub created_account: bool,
}

/// `waitlist.requested`: someone asked for access. Ask identity's staff
/// methods for the entry; the address is not in the event.
#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistRequested {
    pub entry_id: String,
}

/// The payload of `package.published`, `package.version_deleted`,
/// `package.deleted` and `package.visibility_changed`; each uses the fields
/// that apply to it. `repo_id` is the repository the package is linked to.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageEvent {
    pub package_id: String,
    pub workspace: String,
    pub ecosystem: String,
    pub name: String,
    pub repo_id: Option<String>,
    /// The version published or deleted: for a container image, its
    /// manifest's digest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// On publish: the tags that now point to the version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// On `package.visibility_changed`: `public` or `private`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
}

/// `queue.changed`: a repository's merge queue gained, lost or settled an
/// entry, so the next batch may be ready to test.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueChanged {
    pub repo_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_job_token_did_is_marked_and_carried_on() {
        let mut actor = crate::User { id: "wsp_1".into(), username: "acme".into(), ..crate::User::default() };
        let plain = marked(serde_json::json!({ "number": 4 }), Some(&actor));
        assert_eq!(caused_by_job(&plain), None);
        actor.token = Some(Box::new(crate::scopes::TokenAccess {
            job: Some(crate::scopes::JobToken { run_id: "run_9".into(), job_id: "job_1".into() }),
            ..Default::default()
        }));
        let by_job = marked(serde_json::json!({ "number": 4 }), Some(&actor));
        assert_eq!(caused_by_job(&by_job), Some("run_9"));
        assert_eq!(by_job["number"], 4);
        // A push by the job's token, and the pull request it moves.
        let push = GitPush {
            repo_id: "rep_1".into(),
            git_ref: "refs/heads/fix".into(),
            before: Some("a".into()),
            after: "b".into(),
            default_branch: false,
            unscanned: false,
            caused_by_job: job_run_of(&actor).map(str::to_owned),
        };
        let push = serde_json::to_value(push).unwrap();
        assert_eq!(caused_by_job(&push), Some("run_9"));
        assert_eq!(caused_by_job(&carried(serde_json::json!({ "number": 4 }), &push)), Some("run_9"));
        assert_eq!(caused_by_job(&carried(serde_json::json!({ "number": 4 }), &serde_json::json!({}))), None);
    }

    #[test]
    fn a_push_says_it_was_unscanned_only_when_it_was() {
        let push = |unscanned| GitPush {
            repo_id: "rep_1".into(),
            git_ref: "refs/heads/import".into(),
            before: None,
            after: "abc".into(),
            default_branch: false,
            unscanned,
            caused_by_job: None,
        };
        let quiet = serde_json::to_value(push(false)).unwrap();
        assert!(quiet.get("unscanned").is_none());
        let flagged = serde_json::to_value(push(true)).unwrap();
        assert_eq!(flagged["unscanned"], true);
        assert_eq!(flagged["ref"], "refs/heads/import");
    }

    fn renamed(from: &str, to: &str) -> WorkspaceRenamed {
        WorkspaceRenamed {
            workspace_id: "wsp_1".into(),
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn stale_slugs_leave_out_the_current_one() {
        assert_eq!(renamed("a", "b").stale_slugs("b"), vec!["a"]);
        // Delivered after a second rename, b → c: both move to c.
        assert_eq!(renamed("a", "b").stale_slugs("c"), vec!["a", "b"]);
        // Renamed back: a → b → a.
        assert_eq!(renamed("a", "b").stale_slugs("a"), vec!["b"]);
    }

    fn transferred(from: &str, to: &str) -> RepoTransferred {
        RepoTransferred {
            repo_id: "rep_1".into(),
            name: "rocket".into(),
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn stale_paths_leave_out_the_current_one() {
        assert_eq!(transferred("a", "b").stale_paths("b/rocket"), vec!["a/rocket"]);
        // Delivered after a second transfer, b → c: both move to c.
        assert_eq!(
            transferred("a", "b").stale_paths("c/rocket"),
            vec!["a/rocket", "b/rocket"]
        );
        // Transferred back: a → b → a.
        assert_eq!(transferred("a", "b").stale_paths("a/rocket"), vec!["b/rocket"]);
    }

    #[test]
    fn a_transfer_reads_as_published() {
        let data = serde_json::json!({ "repoId": "rep_1", "name": "rocket", "from": "a", "to": "b" });
        let event: RepoTransferred = serde_json::from_value(data).unwrap();
        assert_eq!((event.from.as_str(), event.to.as_str()), ("a", "b"));
    }

    #[test]
    fn a_rename_names_both_paths_in_its_workspace() {
        let renamed = RepoRenamed {
            repo_id: "rep_1".into(),
            namespace: "acme".into(),
            from: "old".into(),
            to: "new".into(),
        };
        assert_eq!(renamed.stale_paths("acme/new"), vec!["acme/old"]);
        // Delivered after a transfer: both names in acme move.
        assert_eq!(renamed.stale_paths("flagon/new"), vec!["acme/old", "acme/new"]);
    }

    #[test]
    fn reads_the_published_payload() {
        let data = serde_json::json!({ "workspaceId": "wsp_1", "from": "a", "to": "b" });
        let event: WorkspaceRenamed = serde_json::from_value(data).unwrap();
        assert_eq!((event.from.as_str(), event.to.as_str()), ("a", "b"));
    }
}
