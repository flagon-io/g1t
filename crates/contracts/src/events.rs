//! Events published on the bus. Mirrors `packages/contracts/src/events.ts`.

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
    pub attempt_id: String,
}

/// `after` is the commit the ref points to once the push has landed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPush {
    pub repo_id: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentOpened {
    pub intent_id: String,
    pub repo_id: String,
    pub number: u32,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentClosed {
    pub intent_id: String,
    pub repo_id: String,
    /// `shipped` or `withdrawn`.
    pub reason: &'static str,
}

/// The payload of `attempt.started`, `attempt.updated`, `attempt.submitted`
/// and `attempt.shipped`; each uses the fields that apply to it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptEvent {
    pub attempt_id: String,
    pub intent_id: String,
    pub repo_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAppended {
    pub attempt_id: String,
    pub session_id: String,
    pub count: u32,
}

/// An event as delivered to subscribers. `data` is left as JSON; each
/// subscriber decodes the types it cares about.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivered {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// Milliseconds since the epoch, until the bus itself moves to RFC 3339.
    pub time: serde_json::Value,
    pub repo_id: Option<String>,
    pub data: serde_json::Value,
}
