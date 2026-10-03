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
    /// The slug of the workspace that owns it: the first URL segment.
    pub namespace: String,
    pub name: String,
    pub description: Option<String>,
    pub is_private: bool,
    pub owner_id: String,
    pub default_branch: String,
    /// Set when this repo is a pull request's working copy of another repo.
    pub fork_of: Option<String>,
    /// Whether the default branch is protected: it changes only by merging
    /// a pull request, and pushes to it are refused.
    #[serde(default)]
    pub protected: bool,
    /// RFC 3339.
    pub created_at: String,
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
    /// RFC 3339.
    pub authored_at: String,
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

/// The result of landing a pull request.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Landed {
    /// The commit the branch points to now.
    pub commit: String,
    /// The commit it pointed to before, if it had one. Comparing against
    /// this shows what the pull request changed.
    pub previous: Option<String>,
}

/// `get`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
}

/// `path_by_id`: where a repository is, whoever may see it. For g1t's own
/// services, which hold a repository's id from an event and act for its
/// workspace; nothing outside reaches it. Returns `Option<RepoPath>`, null
/// for a fork or an unknown id.
#[derive(Debug, Serialize, Deserialize)]
pub struct PathByIdArgs {
    pub id: String,
}

/// `get_by_id`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetByIdArgs {
    pub id: String,
    pub viewer: Viewer,
}

/// `list`: repos the viewer may see, newest first. Returns `Vec<Repo>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    pub viewer: Viewer,
    #[serde(default)]
    pub query: Option<String>,
    /// Only repos in this workspace.
    #[serde(default)]
    pub namespace: Option<String>,
    /// Only repos in workspaces the viewer belongs to.
    #[serde(default)]
    pub member_only: bool,
}

/// `create`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    /// Who is creating it; they must belong to the workspace.
    pub owner: User,
    /// The workspace it is created in.
    pub namespace: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_private: bool,
    /// The https address of a public git repository to copy the default
    /// branch of, such as `https://github.com/owner/repo`.
    #[serde(default)]
    pub import_url: Option<String>,
}

/// `update`: changes whichever of a repository's details are given.
/// Members of its workspace only. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub actor: User,
    pub path: RepoPath,
    /// An empty description clears it.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_private: Option<bool>,
    #[serde(default)]
    pub protected: Option<bool>,
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

/// `fork_for_pull`: a copy-on-write copy of the source repo, hidden from
/// listings, for one pull request to be made in. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkArgs {
    pub source_id: String,
    pub pull_id: String,
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

/// `land`: moves a repository's default branch to the head of a pull
/// request's source. Refused with `conflict` when the source is behind,
/// since that would discard commits. Returns `Outcome<Landed>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandArgs {
    /// The repository holding the commits: a pull request's fork, or the
    /// target itself when landing one of its own branches.
    pub source_id: String,
    /// The branch of the source to land. Required when the source is the
    /// target; a fork lands its default branch.
    #[serde(default)]
    pub branch: Option<String>,
    pub actor: User,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    /// Unchanged, shown for context.
    Context,
    Add,
    Delete,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: LineKind,
    /// Line number in the old file; absent for added lines.
    pub old: Option<u32>,
    /// Line number in the new file; absent for deleted lines.
    pub new: Option<u32>,
    pub text: String,
}

/// A run of changed lines with their surrounding context.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hunk {
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    /// True when the file is binary or too large, so no lines are shown.
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// What changed between two commits.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Comparison {
    /// Null when the head has no earlier commit to compare against.
    pub base: Option<String>,
    pub head: String,
    pub files: Vec<FileDiff>,
    /// True when the change was too large to return in full.
    pub truncated: bool,
}

/// `compare`: what `head` changes relative to `base`.
///
/// `head` is a branch or a commit, and defaults to the default branch.
/// With no `base`, a fork is compared against the point where it and the
/// repository it came from last agreed; a branch against the point where it
/// left the default branch; and the default branch against its head's
/// parent. Returns `Outcome<Comparison>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareArgs {
    pub repo_id: String,
    pub viewer: Viewer,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
}

/// Lines `start` to `end` of a file, inclusive and counted from 1, last
/// changed by `commit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlameRange {
    pub start: u32,
    pub end: u32,
    pub commit: String,
}

/// Who last changed each line of a file.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Blame {
    /// The commit the file was read at.
    pub head: String,
    /// Every line, in order, in runs that share a commit.
    pub ranges: Vec<BlameRange>,
    /// The commits the ranges name, each once.
    pub commits: Vec<Commit>,
    /// True when the history was too long to read in full, so the oldest
    /// lines are given to the oldest commit read.
    pub partial: bool,
}

/// `blame`: who last changed each line of `path` as of `ref` (the default
/// branch if absent). Returns `Outcome<Blame>`; not found when the file is
/// missing or is not text.
#[derive(Debug, Serialize, Deserialize)]
pub struct BlameArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

/// A branch and the commit it points to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Branch {
    pub name: String,
    pub hash: String,
}

/// `branches`: the repository's branches, default branch first.
/// Returns `Outcome<Vec<Branch>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BranchesArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
}

/// `behind`: whether the default branch of the repository a pull request
/// would merge into has commits its source does not. For services that
/// have already decided the caller may see the pull request; it reveals
/// one bit. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehindArgs {
    /// The pull request's fork, or the repository itself for a branch.
    pub source_id: String,
    /// The branch of the source. A fork is compared on its default branch.
    #[serde(default)]
    pub branch: Option<String>,
}

/// `head`: the commit a branch points to, or null. For services reacting
/// to a push, which have no viewer; it reveals nothing but a commit hash.
/// Returns `Option<String>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadArgs {
    pub repo_id: String,
    pub branch: String,
}
