//! The repos service: repository metadata, contents, forks and git access.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::{User, Viewer};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    /// The owning user's (later, workspace's) name: the first URL segment.
    pub namespace: String,
    pub name: String,
    pub description: Option<String>,
    pub is_private: bool,
    pub owner_id: String,
    pub default_branch: String,
    /// Set when this repo is an attempt's working copy of another repo.
    pub fork_of: Option<String>,
    /// Milliseconds since the epoch.
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepoPath {
    pub namespace: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Signature {
    pub name: String,
    pub email: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub tree_hash: String,
    pub message: String,
    pub author: Signature,
    pub parents: Vec<String>,
    /// Milliseconds since the epoch.
    pub authored_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Tree,
    Blob,
    Symlink,
    Gitlink,
    Exec,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeEntry {
    pub name: String,
    pub hash: String,
    pub kind: EntryKind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Readme {
    pub name: String,
    /// Null when the file is binary or too large to show.
    pub text: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TreeView {
    pub repo: Repo,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub path: String,
    /// Null when the repo has no commits yet.
    pub head: Option<Commit>,
    pub entries: Vec<TreeEntry>,
    pub readme: Option<Readme>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlobView {
    pub repo: Repo,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub path: String,
    pub size: u64,
    /// Null when the file is binary or too large to show.
    pub text: Option<String>,
}

/// A git remote and a short-lived credential for it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitAccess {
    pub remote: String,
    pub token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GitService {
    #[serde(rename = "git-upload-pack")]
    UploadPack,
    #[serde(rename = "git-receive-pack")]
    ReceivePack,
}

/// The commit `main` points to after an attempt has landed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Landed {
    pub commit: String,
}

/// `get`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
}

/// `get_by_id`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetByIdArgs {
    pub id: String,
    pub viewer: Viewer,
}

/// `list`: repos the viewer may see, newest first. Returns `Vec<Repo>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ListArgs {
    pub viewer: Viewer,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
}

/// `create`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    pub owner: User,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_private: bool,
}

/// `tree`. Returns `Outcome<TreeView>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    /// The default branch when absent.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub tree_path: String,
}

/// `blob`. Returns `Outcome<BlobView>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub file_path: String,
}

/// `log`. Returns `Outcome<Vec<Commit>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LogArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    pub limit: u32,
}

/// `fork_for_attempt`: a copy-on-write copy of the source repo, hidden from
/// listings, for one attempt to work in. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkArgs {
    pub source_id: String,
    pub attempt_id: String,
    pub actor: User,
}

/// `git_access`: authorizes a git operation and says where to send it.
/// Pushing to a repo that does not exist creates it in the pusher's own
/// namespace. Returns `Outcome<GitAccess>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GitAccessArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    pub service: GitService,
}

/// `land`: moves the default branch of the repo a fork came from to the
/// fork's head. Refused with `conflict` when the fork is behind, since
/// that would discard commits. Returns `Outcome<Landed>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandArgs {
    pub fork_id: String,
    pub actor: User,
}
