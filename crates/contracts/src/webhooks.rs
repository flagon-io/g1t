//! The webhooks service: events, delivered to the addresses a repository or
//! a workspace registers.
//!
//! Every event g1t publishes can be delivered: an HTTPS `POST` of JSON,
//! signed with the webhook's secret in `X-G1t-Signature-256`, and retried
//! with growing waits when the receiver does not answer with a 2xx. Each
//! delivery is kept, with what was sent and what came back, and can be sent
//! again.
//!
//! Mirrors `packages/contracts/src/webhooks.ts`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Every event a webhook can be sent, in the order people are shown them.
pub const EVENT_TYPES: [&str; 101] = [
    "git.push",
    "branch.renamed",
    "repo.created",
    "repo.forked",
    "repo.updated",
    "repo.visibility_changed",
    "repo.renamed",
    "repo.transferred",
    "repo.default_branch_changed",
    "repo.archived",
    "repo.unarchived",
    "repo.deleted",
    "repo.restored",
    "repo.purged",
    "repo.collaborator_added",
    "repo.collaborator_removed",
    "repo.collaborator_role_changed",
    "team.created",
    "team.edited",
    "team.deleted",
    "team.member_added",
    "team.member_role_changed",
    "team.member_removed",
    "team.repo_added",
    "team.repo_role_changed",
    "team.repo_removed",
    "ruleset.created",
    "ruleset.updated",
    "ruleset.deleted",
    "issue.opened",
    "issue.updated",
    "issue.assigned",
    "issue.labeled",
    "issue.unlabeled",
    "issue.milestoned",
    "issue.demilestoned",
    "issue.closed",
    "issue.reopened",
    "comment.created",
    "comment.edited",
    "comment.deleted",
    "pull.opened",
    "pull.ready",
    "pull.updated",
    "pull.merge_requested",
    "pull.merged",
    "pull.closed",
    "pull.reopened",
    "pull.converted_to_draft",
    "pull.assigned",
    "pull.review_requested",
    "pull.review_request_removed",
    "pull.labeled",
    "pull.unlabeled",
    "pull.milestoned",
    "pull.demilestoned",
    "pull.base_changed",
    "pull.stalled",
    "pull.resumed",
    "release.created",
    "release.published",
    "release.released",
    "release.prereleased",
    "release.edited",
    "release.unpublished",
    "release.deleted",
    "agent.asked",
    "checks.completed",
    "status.created",
    "check_run.created",
    "check_run.completed",
    "check_run.rerequested",
    "check_run.requested_action",
    "check_suite.completed",
    "check_suite.rerequested",
    "review.completed",
    "workflow.completed",
    "deployment.succeeded",
    "deployment.failed",
    "deployment.created",
    "deployment_status.created",
    "queue.changed",
    "session.appended",
    "package.published",
    "package.version_deleted",
    "package.deleted",
    "package.visibility_changed",
    "secret_scanning_alert.created",
    "secret_scanning_alert.fixed",
    "secret_scanning_alert.dismissed",
    "secret_scanning_alert.reopened",
    "secret_scanning.bypass_requested",
    "secret_scanning.bypass_reviewed",
    "code_scanning_alert.created",
    "code_scanning_alert.fixed",
    "code_scanning_alert.dismissed",
    "code_scanning_alert.reopened",
    "vulnerability_alert.created",
    "vulnerability_alert.fixed",
    "vulnerability_alert.dismissed",
    "vulnerability_alert.reopened",
    "mirror.unreachable",
    "mirror.reachable",
    "mirror.state_changed",
    "mirror.moved_in",
];

/// What a webhook belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookScope {
    /// One repository's events.
    Repo,
    /// The events of every repository in a workspace.
    Workspace,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    pub id: String,
    pub scope: HookScope,
    pub workspace: String,
    /// For a repository's webhook: `owner/name`.
    pub repo: Option<String>,
    pub url: String,
    /// The event types it is sent, or `["*"]` for all.
    pub events: Vec<String>,
    pub active: bool,
    /// The last four characters of its secret.
    pub secret_hint: String,
    pub created_by: String,
    /// RFC 3339.
    pub created_at: String,
    /// How its latest delivery went: `delivered`, `pending` or `failed`.
    pub last_status: Option<String>,
    pub last_delivered_at: Option<String>,
}

/// One event sent, or being sent, to a webhook.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDelivery {
    pub id: String,
    pub hook_id: String,
    /// The event's id, or empty for a ping.
    pub event_id: String,
    pub event: String,
    /// `pending` while it will be tried again, `delivered`, or `failed` once
    /// it has been tried as often as it will be.
    pub status: String,
    pub attempts: u32,
    /// The receiver's HTTP status, the last time it answered.
    pub response_status: Option<u16>,
    /// The start of what it answered.
    pub response_body: Option<String>,
    /// Why the last attempt failed, when the receiver could not be reached.
    pub error: Option<String>,
    pub duration_ms: Option<u32>,
    /// The JSON that was sent.
    pub payload: String,
    /// RFC 3339.
    pub created_at: String,
    pub delivered_at: Option<String>,
    pub next_attempt_at: Option<String>,
}

/// Which webhooks a call is about: a repository's, or with `repo` left out,
/// the workspace's own.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookOwner {
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
}

/// `list`. Returns `Outcome<Vec<Hook>>`. Members of the workspace only.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListArgs {
    pub viewer: Viewer,
    #[serde(flatten)]
    pub owner: HookOwner,
}

/// `create`. Returns `Outcome<CreatedHook>`. Members, for a repository's
/// webhooks; owners, for the workspace's.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: HookOwner,
    pub url: String,
    /// Event types, or `["*"]` for all. All when empty.
    #[serde(default)]
    pub events: Vec<String>,
    /// Made by g1t when left out.
    #[serde(default)]
    pub secret: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreatedHook {
    pub hook: Hook,
    /// The secret, when g1t made it: shown this once.
    pub secret: Option<String>,
}

/// `update`: only the fields given change. Returns `Outcome<Hook>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: HookOwner,
    pub id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub events: Option<Vec<String>>,
    #[serde(default)]
    pub active: Option<bool>,
}

/// `delete` (returns `Outcome<bool>`) and `ping` (sends a `ping` event and
/// returns `Outcome<HookDelivery>`).
#[derive(Debug, Serialize, Deserialize)]
pub struct HookArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: HookOwner,
    pub id: String,
}

/// `deliveries`: a webhook's latest deliveries, newest first. Returns
/// `Outcome<Vec<HookDelivery>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeliveriesArgs {
    pub viewer: Viewer,
    #[serde(flatten)]
    pub owner: HookOwner,
    pub id: String,
}

/// `redeliver`: sends a delivery's payload again, as a new delivery.
/// Returns `Outcome<HookDelivery>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeliverArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: HookOwner,
    pub delivery_id: String,
}

#[cfg(test)]
mod tests {
    use super::EVENT_TYPES;

    /// The TypeScript mirror lists the same events, in the same order.
    #[test]
    fn the_typescript_mirror_lists_the_same_events() {
        let ts = include_str!("../../../packages/contracts/src/webhooks.ts");
        let list = ts
            .split_once("export const EVENT_TYPES = [")
            .and_then(|(_, rest)| rest.split_once("] as const"))
            .map(|(list, _)| list)
            .expect("EVENT_TYPES in webhooks.ts");
        let mirrored: Vec<&str> = list
            .split(',')
            .map(|item| item.trim().trim_matches('"'))
            .filter(|item| !item.is_empty())
            .collect();
        assert_eq!(mirrored, EVENT_TYPES);
    }
}
