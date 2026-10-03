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
pub const EVENT_TYPES: [&str; 19] = [
    "git.push",
    "repo.created",
    "repo.forked",
    "issue.opened",
    "issue.updated",
    "issue.assigned",
    "issue.closed",
    "issue.reopened",
    "comment.created",
    "pull.opened",
    "pull.ready",
    "pull.updated",
    "pull.merge_requested",
    "pull.merged",
    "pull.closed",
    "checks.completed",
    "review.completed",
    "queue.changed",
    "session.appended",
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
