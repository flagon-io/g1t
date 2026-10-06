//! Events published on the bus, and the events service that carries them.
//! Mirrors `packages/contracts/src/events.ts`.

use serde::Serialize;

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
}

/// The payload of `issue.opened`, `issue.updated`, `issue.assigned`,
/// `issue.closed` and `issue.reopened`; each uses the fields that apply to it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueEvent {
    pub issue_id: String,
    pub repo_id: String,
    pub number: u32,
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
}

/// The payload of `pull.opened`, `pull.ready`, `pull.updated` (its head
/// moved), `pull.closed` and `pull.merged`; each uses the fields that apply to it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullEvent {
    pub pull_id: String,
    pub repo_id: String,
    pub number: u32,
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
