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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoForked {
    pub repo_id: String,
    pub source_repo_id: String,
    pub pull_id: String,
}

/// One branch moved by a push. `after` is the commit it points to now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPush {
    pub repo_id: String,
    /// The full ref, such as `refs/heads/main`.
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub after: String,
    /// Whether the ref is the repository's default branch.
    pub default_branch: bool,
}

/// The payload of `issue.opened`, `issue.updated`, `issue.closed` and
/// `issue.reopened`; each uses the fields that apply to it.
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
    /// On merge: the commit the branch now points to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// On close: the pull request that was merged instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<u32>,
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

/// `comment.created`. `number` is the issue or pull request commented on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentCreated {
    pub comment_id: String,
    pub repo_id: String,
    pub number: u32,
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
