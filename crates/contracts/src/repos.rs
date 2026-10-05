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
    /// Words that say what it is about, for search and Explore: lowercase
    /// letters, digits and hyphens. See [`clean_topics`].
    #[serde(default)]
    pub topics: Vec<String>,
}

/// The most topics a repository has.
pub const MAX_TOPICS: usize = 20;
/// The longest topic.
pub const MAX_TOPIC_CHARS: usize = 35;

/// Topics as they are kept: lowercase, spaces and underscores made
/// hyphens, each of letters, digits and hyphens, starting with a letter or
/// digit, without repeats, at most [`MAX_TOPICS`]. Anything else is the
/// first topic that could not be read.
pub fn clean_topics(topics: &[String]) -> Result<Vec<String>, String> {
    let mut kept: Vec<String> = Vec::new();
    for topic in topics {
        let topic: String = topic
            .trim()
            .to_lowercase()
            .chars()
            .map(|c| if c == ' ' || c == '_' { '-' } else { c })
            .collect();
        if topic.is_empty() {
            continue;
        }
        let valid = topic.chars().count() <= MAX_TOPIC_CHARS
            && topic.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && topic.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
        if !valid {
            return Err(format!(
                "\"{topic}\" is not a topic: use letters, digits and hyphens, at most {MAX_TOPIC_CHARS} characters."
            ));
        }
        if !kept.contains(&topic) {
            kept.push(topic);
        }
    }
    if kept.len() > MAX_TOPICS {
        return Err(format!("A repository has at most {MAX_TOPICS} topics."));
    }
    Ok(kept)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Replaces its topics; an empty list clears them.
    #[serde(default)]
    pub topics: Option<Vec<String>>,
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

/// `divergence`: how a pull request's source and the default branch it
/// would merge into have moved apart since they last agreed: the files each
/// side changed. Takes `BehindArgs`. For services that have already decided
/// the caller may see the pull request; it reveals paths, not contents.
/// Returns `Option<Divergence>`, null when either side has no commits.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    /// The source's commit.
    pub head: String,
    /// The default branch's commit.
    pub base: String,
    /// Where they last agreed, if that could be found.
    pub merge_base: Option<String>,
    /// Whether the default branch has commits the source does not.
    pub behind: bool,
    /// The files the source changed since the merge base.
    pub ours: Vec<String>,
    /// The files the default branch changed since the merge base. Empty
    /// when it is not behind.
    pub theirs: Vec<String>,
    /// Whether either list was cut short.
    pub truncated: bool,
}

/// `update_pull_branch`: brings a pull request's source up to date with the
/// default branch it would merge into, without a sandbox, when that can be
/// done safely: merges the default branch's head into the source's head and
/// pushes the merge commit to the source's branch, as `actor`, only if the
/// branch has not moved meanwhile. It applies only when the two sides
/// changed different files since they last agreed; otherwise the answer is
/// [`PullBranchUpdate::NeedsAgent`] and nothing is pushed. Refused unless
/// `actor` may push to the source. Returns `Outcome<PullBranchUpdate>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePullBranchArgs {
    /// The pull request's fork, or the repository itself for a branch.
    pub source_id: String,
    /// The branch of the source. A fork is updated on its default branch.
    #[serde(default)]
    pub branch: Option<String>,
    /// The pull request's number, to name it in the merge commit's message
    /// when its branch has the same name as the default branch.
    pub number: u32,
    /// Who asked: the merge commit's author and committer, and the pusher.
    pub actor: User,
}

/// Why an update has to be left to a sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsAgentReason {
    /// Both sides changed some of the same files; merging them needs a
    /// real merge, which may or may not conflict.
    Overlap,
    /// Merging is known to conflict.
    Conflicting,
    /// The update could not be worked out here, such as when the two sides
    /// share no history g1t can see, or the change is too large to list.
    Unsupported,
}

/// What came of `update_pull_branch` (or the work service's `catch_up_pull`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PullBranchUpdate {
    /// The merge commit was pushed: the branch moved from `previous` to
    /// `commit`.
    Updated { commit: String, previous: String },
    /// The source already holds the default branch's head.
    UpToDate { commit: String },
    /// Nothing was pushed; a sandbox has to merge it. `paths` are the
    /// files both sides changed, or that conflict, when known.
    NeedsAgent {
        reason: NeedsAgentReason,
        detail: String,
        paths: Vec<String>,
    },
}

/// `head`: the commit a branch points to, or null. For services reacting
/// to a push, which have no viewer; it reveals nothing but a commit hash.
/// Returns `Option<String>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadArgs {
    pub repo_id: String,
    /// Empty for the repository's default branch.
    pub branch: String,
}

/// Where g1t keeps branches of its own in a repository, such as the merge
/// queue's tested states. Only these can be removed with `delete_branch`.
pub const G1T_BRANCH_PREFIX: &str = "g1t-";

/// `delete_branch`: removes a branch g1t made for itself once it is done
/// with it, never one of people's: the name must start with
/// [`G1T_BRANCH_PREFIX`]. For services, which have no viewer. Returns
/// `Outcome<bool>`: whether there was such a branch.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchArgs {
    pub repo_id: String,
    pub branch: String,
}

/// `readable`: of these repository ids, the repositories the viewer may
/// read, as `get_by_id` decides; forks and unknown ids are left out. For
/// services that hold ids and must show only what the viewer could open.
/// At most [`MAX_READABLE`] ids are looked at. Returns `Vec<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReadableArgs {
    pub ids: Vec<String>,
    pub viewer: Viewer,
}

/// The most ids one `readable` call looks at.
pub const MAX_READABLE: usize = 500;

/// `public_namespaces`: the workspaces in which this account made a public
/// repository, and so a public project, which anyone can see on its page.
/// Returns `Vec<String>` of workspace slugs.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicNamespacesArgs {
    pub owner_id: String,
}

/// One file on a branch, or one a change touched: its path and blob.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    /// The blob it holds now; null when the change deleted it.
    pub hash: Option<String>,
}

/// Files, and whether there were more than were listed.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// The commit the files were read at; null for an empty repository.
    pub commit: Option<String>,
    pub files: Vec<FileEntry>,
    pub truncated: bool,
}

/// `list_files`: every file on a branch (the default branch when absent),
/// path order by level, never descending into a directory named in
/// `skip_dirs`. For services that index a repository; no viewer, since it
/// is only reached by g1t's own services. Returns `FileList`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesArgs {
    pub repo_id: String,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub skip_dirs: Vec<String>,
    /// At most this many files; capped at [`MAX_LISTED_FILES`].
    pub limit: u32,
}

/// `changed_files`: the files that differ between two commits, as
/// `list_files` reads them. With no `base`, every file at `head`. Returns
/// `FileList`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFilesArgs {
    pub repo_id: String,
    #[serde(default)]
    pub base: Option<String>,
    pub head: String,
    #[serde(default)]
    pub skip_dirs: Vec<String>,
    pub limit: u32,
}

/// The most files one `list_files` or `changed_files` call lists.
pub const MAX_LISTED_FILES: u32 = 10_000;

/// `read_blobs`: the text of these blobs of a repository, for services
/// that index it. A blob larger than `max_bytes`, or binary, comes back
/// with no text. Returns `Vec<BlobText>`, in the order asked.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBlobsArgs {
    pub repo_id: String,
    pub hashes: Vec<String>,
    pub max_bytes: u32,
}

/// The most blobs one `read_blobs` call reads.
pub const MAX_READ_BLOBS: usize = 100;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlobText {
    pub hash: String,
    pub size: u64,
    /// Null when the blob is missing, binary or larger than asked.
    pub text: Option<String>,
}

/// `all_ids`: every repository that is not a fork, by id, a page at a
/// time, for services that index all of them. Returns `IdPage`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AllIdsArgs {
    /// Ids after this one.
    #[serde(default)]
    pub after: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct IdPage {
    pub ids: Vec<String>,
    /// Where the next page starts; null on the last.
    pub next: Option<String>,
}

#[cfg(test)]
mod topic_tests {
    use super::*;

    fn topics(list: &[&str]) -> Result<Vec<String>, String> {
        clean_topics(&list.iter().map(|t| t.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn topics_are_tidied() {
        assert_eq!(topics(&["Rust", " web_server ", "rust", ""]).unwrap(), vec!["rust", "web-server"]);
    }

    #[test]
    fn odd_topics_are_refused() {
        assert!(topics(&["c++"]).is_err());
        assert!(topics(&["-lead"]).is_err());
        assert!(topics(&[&"a".repeat(36)]).is_err());
        let many: Vec<String> = (0..21).map(|i| format!("t{i}")).collect();
        assert!(clean_topics(&many).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_branch_update_reads_as_the_web_expects() {
        let update = PullBranchUpdate::NeedsAgent {
            reason: NeedsAgentReason::Overlap,
            detail: "both".into(),
            paths: vec!["a.rs".into()],
        };
        assert_eq!(
            serde_json::to_value(&update).unwrap(),
            serde_json::json!({ "outcome": "needs_agent", "reason": "overlap", "detail": "both", "paths": ["a.rs"] })
        );
        let done = PullBranchUpdate::UpToDate { commit: "c".into() };
        assert_eq!(serde_json::to_value(&done).unwrap(), serde_json::json!({ "outcome": "up_to_date", "commit": "c" }));
    }
}
