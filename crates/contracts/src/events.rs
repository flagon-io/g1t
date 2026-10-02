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
