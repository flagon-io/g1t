//! The projects service, as the Rust services call it: a project is what a
//! workspace builds and runs, with one source. Mirrors
//! `packages/contracts/src/projects.ts`, as far as Rust callers need it.

use serde::{Deserialize, Serialize};

/// `by_repo`: the projects built from a repository, its primary one first;
/// a repository from before projects is given its own. Returns
/// `Vec<ProjectRef>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByRepoArgs {
    pub repo_id: String,
}

/// A project, as much of it as other services need.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: String,
    pub workspace: String,
    pub slug: String,
    /// The project its repository's workflows read secrets from.
    #[serde(default)]
    pub primary: bool,
}
