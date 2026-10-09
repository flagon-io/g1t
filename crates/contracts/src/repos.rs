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
    /// Its home page, an http(s) address, shown beside its description.
    /// See [`clean_website`].
    #[serde(default)]
    pub website: Option<String>,
    /// RFC 3339: when it was archived, made read-only. Null when it is not.
    #[serde(default)]
    pub archived_at: Option<String>,
    /// Set when it mirrors a remote that leads (see [`crate::mirrors`]).
    /// Unless g1t has taken over, it is read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror: Option<crate::mirrors::RepoMirror>,
}

impl Repo {
    pub fn archived(&self) -> bool {
        self.archived_at.is_some()
    }

    /// Whether it is a mirror that does not take writes now.
    pub fn mirror_read_only(&self) -> bool {
        self.mirror.as_ref().is_some_and(|mirror| !mirror.writable())
    }

    /// Why it takes no pushes, merges, issues or agents now: archived, or
    /// a mirror standing by. `None` when it takes them.
    pub fn read_only_reason(&self) -> Option<String> {
        if self.archived() {
            return Some(archived_message(&self.namespace, &self.name));
        }
        self.mirror
            .as_ref()
            .filter(|mirror| !mirror.writable())
            .map(|mirror| crate::mirrors::mirror_message(&self.namespace, &self.name, mirror))
    }
}

/// `storage_options` (no arguments, `{}`): what a workspace may choose
/// about where its repositories are kept. `eu_available`: an EU namespace
/// is configured and takes new repositories, so a workspace may keep its
/// data in the EU (`set_workspace_residency` on identity). Returns
/// `StorageOptions`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageOptions {
    pub eu_available: bool,
}

/// How long a deleted repository can be restored before it is purged.
pub const RESTORE_DAYS: u64 = 30;

/// A deleted repository, as its workspace's Recently deleted list shows
/// it: restorable until `purge_after`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedRepo {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub description: Option<String>,
    pub is_private: bool,
    /// RFC 3339.
    pub deleted_at: String,
    /// The username of who deleted it.
    pub deleted_by: String,
    /// RFC 3339: when it is purged, unless restored first.
    pub purge_after: String,
}

/// The longest website address a repository keeps.
pub const MAX_WEBSITE_CHARS: usize = 255;

/// A website as it is kept: an http(s) address, `https://` added when no
/// scheme is given; empty clears it. Anything else is refused.
pub fn clean_website(text: &str) -> Result<Option<String>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let url = if text.starts_with("https://") || text.starts_with("http://") {
        text.to_owned()
    } else if text.contains("://") {
        return Err("A website is an http or https address.".into());
    } else {
        format!("https://{text}")
    };
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    if url.chars().count() > MAX_WEBSITE_CHARS
        || host.is_empty()
        || !host.contains('.')
        || url.chars().any(char::is_whitespace)
    {
        return Err("That is not a website address, such as https://example.com.".into());
    }
    Ok(Some(url))
}

/// Whether `name` can be a branch people name: what `git check-ref-format
/// --branch` accepts, less the names g1t keeps for itself
/// ([`G1T_BRANCH_PREFIX`]).
pub fn is_valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name != "@"
        && !name.starts_with(G1T_BRANCH_PREFIX)
        && !name.split('/').any(|part| part.starts_with('.'))
        && name
            .chars()
            .all(|c| !c.is_control() && !matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
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
    /// With `import_url`: a GitHub installation access token that opens it,
    /// for a private repository. Every branch and tag is then copied, not
    /// only the default branch. Set only by the integrations service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_token: Option<String>,
    /// Set by the integrations service for a mirror: it is read-only from
    /// the start. See [`crate::mirrors`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirror: Option<crate::mirrors::RepoMirror>,
}

/// `mirror`: makes a repository's branches and tags match another git
/// host's, or pushes its own out to one. Services only. Returns
/// `Outcome<Mirrored>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorArgs {
    pub repo_id: String,
    /// The other host's https address, such as
    /// `https://github.com/owner/repo.git`.
    pub url: String,
    /// A token for it, such as a GitHub installation access token. Opaque:
    /// any length.
    pub token: String,
    /// The user the token is sent as, by basic authentication.
    /// `x-access-token` (GitHub's) when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub direction: MirrorDirection,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MirrorDirection {
    /// The repository on g1t follows the other host: its refs are moved,
    /// and removed, to match.
    Pull,
    /// The other host follows g1t: refs g1t has are pushed there; refs only
    /// the other host has are left alone.
    Push,
}

/// What a `mirror` changed.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirrored {
    /// Full ref names created or moved.
    pub updated: Vec<String>,
    pub deleted: Vec<String>,
    /// Refs a pull moved somewhere their old commit is not part of (a
    /// force-push on the remote), each as the `refs/g1t/replaced/...` ref
    /// that keeps the old commit.
    #[serde(default)]
    pub replaced: Vec<String>,
}

/// `mirror_refs`: a repository's branches and tags, and another host's (only
/// the repository's when `url` is empty).
/// Services only. Returns `Outcome<MirrorRefs>`; when the other host does
/// not answer, `theirs` is absent and `unreachable` says why. It fails
/// when the other host answers and refuses.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRefsArgs {
    pub repo_id: String,
    pub url: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRefs {
    /// Full ref name to commit (or tag) id, on g1t.
    pub ours: std::collections::BTreeMap<String, String>,
    /// The same, on the other host; absent when it did not answer.
    pub theirs: Option<std::collections::BTreeMap<String, String>>,
    /// Why the other host's refs are absent.
    #[serde(default)]
    pub unreachable: Option<String>,
}

/// One ref moved by `mirror_apply`, from one side to the other.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefMove {
    pub direction: MirrorDirection,
    /// The ref on the side it comes from.
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// The ref it is written to; the same name when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// What the target must hold now for the move to happen; absent when it
    /// must not exist.
    #[serde(default)]
    pub old: Option<String>,
    /// What it is moved to; absent to delete it.
    #[serde(default)]
    pub new: Option<String>,
}

/// `mirror_apply`: moves the given refs, each only if its target still
/// holds `old`. Pulled refs that lose their old commit keep it under
/// `refs/g1t/replaced/`. Services only. Returns `Outcome<MirrorApplied>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorApplyArgs {
    pub repo_id: String,
    pub url: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub moves: Vec<RefMove>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorApplied {
    pub moved: Vec<RefMoved>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefMoved {
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub direction: MirrorDirection,
    /// Why it did not move; absent when it did.
    #[serde(default)]
    pub problem: Option<String>,
    /// The `refs/g1t/replaced/...` ref that keeps what it pointed at.
    #[serde(default)]
    pub replaced: Option<String>,
}

/// `set_mirror`: records a repository's [`crate::mirrors::RepoMirror`], or
/// clears it. Services only (integrations). Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMirrorArgs {
    pub repo_id: String,
    pub mirror: Option<crate::mirrors::RepoMirror>,
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
    /// Its home page; an empty string clears it.
    #[serde(default)]
    pub website: Option<String>,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
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

/// `land`: moves the branch a pull request merges into (the repository's
/// default branch unless `target_branch` names another) to the head of
/// its source. Refused with `conflict` when the source is behind, since
/// that would discard commits. Returns `Outcome<Landed>`.
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
    /// The branch of the target to land on; its default branch when absent.
    #[serde(default)]
    pub target_branch: Option<String>,
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
    /// With no `base`: the branch whose shared point with the head it is
    /// compared from, instead of the default branch. A pull request into
    /// another branch is compared this way.
    #[serde(default)]
    pub base_branch: Option<String>,
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

/// `last_commits`: which commit last changed each entry of a directory at
/// `ref` (the default branch when absent). Returns `Outcome<LastCommits>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommitsArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub tree_path: String,
    /// Answer within this many milliseconds with what was found, not kept;
    /// absent, the walk runs to the end and is kept.
    #[serde(default)]
    pub budget_ms: Option<u64>,
}

/// An entry of a directory and the commit that last changed it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LastCommit {
    pub name: String,
    pub commit: Commit,
}

/// The entries' last commits. `complete` is false when the history walked
/// ran out before every entry was placed; those entries are left out.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LastCommits {
    pub entries: Vec<LastCommit>,
    pub complete: bool,
}

/// `branch_drift`: how far each of `heads` (branch head commits) has moved
/// from `base` (the default branch's head commit), and each one's head
/// commit, in one call. Every answer is kept by the pair of hashes: neither
/// history can change, so neither can it. Returns `Outcome<BranchDrifts>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDriftArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    pub base: String,
    pub heads: Vec<String>,
}

/// Commits a branch has that the default branch does not (`ahead`), and
/// the other way round (`behind`), as `git rev-list --left-right --count`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Drift {
    pub ahead: u32,
    pub behind: u32,
}

/// One branch head's commit and drift. `drift` is absent when the two
/// histories do not meet within what is read (or could not be read).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BranchDrift {
    pub head: String,
    pub commit: Option<Commit>,
    pub drift: Option<Drift>,
}

/// `base`'s own commit, and each head's answer in the order asked.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BranchDrifts {
    pub base: Option<Commit>,
    pub branches: Vec<BranchDrift>,
}

/// `tags`: the repository's tags, newest commit first, each with the
/// commit it names. Returns `Outcome<Vec<Tag>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TagsArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
}

/// A tag, and its commit when it could be read.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub commit: Option<Commit>,
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
    /// The branch of the target it would merge into; the default branch
    /// when absent.
    #[serde(default)]
    pub target_branch: Option<String>,
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
    /// The branch of the target to merge in; its default branch when absent.
    #[serde(default)]
    pub target_branch: Option<String>,
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

/// `commit_file`: writes one file on a new branch made from the default
/// branch's head, as one commit by `actor`, without a sandbox. For a change
/// g1t proposes on someone's behalf, such as a starter workflow, which then
/// becomes a pull request. Refused unless `actor` may push, when the branch
/// already exists, or when the file is already there. Returns
/// `Outcome<CommittedFile>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileArgs {
    pub repo: RepoPath,
    pub actor: User,
    /// The new branch, which must not exist yet.
    pub branch: String,
    /// Where the file goes, such as `.g1t/workflows/ci.yml`.
    pub path: String,
    pub content: String,
    pub message: String,
}

/// The commit `commit_file` made.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedFile {
    pub branch: String,
    pub commit: String,
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

/// `refs`: a repository's branches and tags with the commit each points to
/// (annotated tags peeled), for services that follow them, such as the
/// packages service's Composer registry. No viewer: g1t's own services
/// only. Returns `Option<RepoRefs>`, null for a fork or an unknown id.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsArgs {
    pub repo_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRefEntry {
    /// The full ref: `refs/heads/main`, `refs/tags/v1.0.0`.
    pub name: String,
    pub commit: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepoRefs {
    pub repo: Repo,
    pub refs: Vec<GitRefEntry>,
}

/// `raw_file`: one file's bytes at a ref or commit, base64, for g1t's own
/// services (no viewer). Returns `Option<RawFile>`: null when the file is
/// missing or larger than `max_bytes`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawFileArgs {
    pub repo_id: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub path: String,
    pub max_bytes: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawFile {
    pub size: u64,
    /// Standard base64.
    pub data: String,
}

/// `raw_blobs`: blobs' bytes, base64, in the order asked, at most
/// [`MAX_READ_BLOBS`]; `data` is null for one missing or larger than
/// `max_bytes`. For g1t's own services. Returns `Vec<RawBlob>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBlobsArgs {
    pub repo_id: String,
    pub hashes: Vec<String>,
    pub max_bytes: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawBlob {
    pub hash: String,
    pub size: u64,
    pub data: Option<String>,
}

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

/// `repo_creators` takes [`AllIdsArgs`]: every repository that is not a
/// fork, with the account that created it, a page at a time, for identity
/// giving creators the Admin role. Returns [`CreatorPage`].
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CreatorPage {
    pub repos: Vec<RepoCreator>,
    /// Where the next page starts; null on the last.
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoCreator {
    pub id: String,
    /// Its workspace's slug.
    pub namespace: String,
    pub name: String,
    /// The account that created it.
    pub owner_id: String,
}

/// `visibility`: which of these repositories (`namespace/name`) are
/// private, for billing, which pays for work on public ones from g1t's
/// open-source pool. A pull request's working copy answers as the
/// repository it is a copy of. Unknown paths are left out. Returns
/// `Vec<RepoVisibility>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct VisibilityArgs {
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RepoVisibility {
    pub path: String,
    pub is_private: bool,
}

/// `git_operations`: how many git operations (clones, fetches and pushes
/// through g1t's git endpoints) each workspace's repositories had in a
/// month, for billing's git meter. Cloudflare Artifacts charges per
/// operation from 2026-10-14. Pushes from agents' sandboxes go to the
/// store directly and are not counted here. Returns
/// `Vec<WorkspaceGitOperations>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GitOperationsArgs {
    /// YYYY-MM.
    pub month: String,
    /// Count only from this hour on, `YYYY-MM-DDTHH`, such as the day the
    /// provider starts charging.
    #[serde(default)]
    pub since: Option<String>,
    /// One workspace only; every workspace with any when absent.
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceGitOperations {
    pub namespace: String,
    pub operations: u64,
}

/// `storage`: what each workspace's private repositories hold, as far as
/// g1t can measure it, for billing's daily storage meter. Returns
/// `Vec<WorkspaceStorage>`.
///
/// The git store does not report a repository's size. What is counted is
/// the bytes of every pack pushed through g1t's git endpoints to the
/// repository or to its pull requests' working copies. Pushes made from
/// agents' sandboxes, which go to the store directly, and imports are not
/// counted, so it is a lower bound on what is stored.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StorageArgs {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceStorage {
    pub namespace: String,
    pub private_bytes: i64,
    pub public_bytes: i64,
}

/// `transfer`: moves a repository to another workspace, keeping its name,
/// its id and everything kept under it. The actor must own both
/// workspaces. The old path keeps working as a redirect (see
/// `resolve_path`) until a repository is made there. Publishes
/// `repo.transferred`. Returns `Outcome<Repo>`, the repository at its new
/// path.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferArgs {
    pub actor: User,
    pub path: RepoPath,
    /// The destination workspace's slug.
    pub to: String,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `resolve_path`: where a repository that was transferred away from
/// `path` is now, while nothing else is there. Returns `Option<RepoPath>`:
/// null when `path` is a repository, or never was one that moved. Callers
/// check the viewer may see the repository at its new path, as for any
/// other.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvePathArgs {
    pub path: RepoPath,
}

/// `namespace_count`: how many repositories (not pull request working
/// copies) a workspace holds, private or not, for deciding whether it can
/// be deleted. Returns `u32`.
#[derive(Debug, Serialize, Deserialize)]
pub struct NamespaceCountArgs {
    pub namespace: String,
}

/// `delete`: deletes a repository. Owners of its workspace only, who type
/// its full name (`namespace/name`) as `confirm`. It is hidden at once,
/// git refuses it, and nothing runs for it; it can be restored for
/// [`RESTORE_DAYS`] days, then it is purged, its git data with it. Its
/// name stays taken until then, or until it is purged sooner from the
/// workspace's Recently deleted list. Publishes `repo.deleted`. Returns
/// `Outcome<DeletedRepo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArgs {
    pub actor: User,
    pub path: RepoPath,
    #[serde(default)]
    pub confirm: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `deleted`: a workspace's recently deleted repositories, newest first.
/// Owners only; empty for anyone else. Returns `Vec<DeletedRepo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeletedArgs {
    pub viewer: Viewer,
    pub namespace: String,
}

/// `restore` and `purge`: a deleted repository, by the path it had.
/// `restore` brings it back as it was, at that path (`repo.restored`).
/// `purge` removes it for good now, its git data with it, and frees its
/// name (`repo.purged`); it takes the full name typed as `confirm`.
/// Owners only. Return `Outcome<Repo>` and `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedRepoArgs {
    pub actor: User,
    pub path: RepoPath,
    #[serde(default)]
    pub confirm: Option<String>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `purge_due`: purges deleted repositories whose time has passed, at
/// most `limit` (25 when absent). The service's own schedule runs it.
/// Returns `u32`, how many were purged.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PurgeDueArgs {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `rename`: gives a repository a new name in its workspace, keeping its
/// id, its git data and everything kept under it. Owners only. The old
/// path keeps redirecting, as after a transfer, until a repository is made
/// there. Publishes `repo.renamed`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameArgs {
    pub actor: User,
    pub path: RepoPath,
    pub name: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `archive`: makes a repository read-only (`archived: true`), or writable
/// again. Owners only. While archived, pushes and merges are refused,
/// issues and pull requests are locked, and agents and workflows do not
/// run; deployments keep serving. Publishes `repo.archived` or
/// `repo.unarchived`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveArgs {
    pub actor: User,
    pub path: RepoPath,
    pub archived: bool,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_visibility`: makes a repository public or private. Owners only,
/// who type its full name as `confirm`. A free workspace takes a private
/// repository only while its private storage has room. Publishes
/// `repo.updated` and `repo.visibility_changed`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVisibilityArgs {
    pub actor: User,
    pub path: RepoPath,
    pub is_private: bool,
    #[serde(default)]
    pub confirm: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_default_branch`: makes another existing branch the one everything
/// lands on. Members of its workspace. Open pull requests then merge into
/// it. Publishes `repo.default_branch_changed`. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultBranchArgs {
    pub actor: User,
    pub path: RepoPath,
    pub branch: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `rename_branch`: renames a branch. Members of its workspace; only an
/// owner renames the default branch, which stays the default. Pull
/// requests from it follow, and web addresses naming the old branch
/// redirect until a branch of that name is made again. Publishes
/// `branch.renamed` (and `repo.default_branch_changed` for the default).
/// Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchArgs {
    pub actor: User,
    pub path: RepoPath,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `resolve_branch`: what a branch renamed away from `branch` is called
/// now, for web addresses that name the old one; null when `branch` was
/// never renamed or exists again. Returns `Option<String>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveBranchArgs {
    pub repo_id: String,
    pub branch: String,
}

/// `status_by_id`: whether a repository is archived or deleted, for g1t's
/// own services deciding whether to act on it. An unknown id answers as
/// deleted. Returns `RepoStatus`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StatusByIdArgs {
    pub id: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoStatus {
    pub archived: bool,
    pub deleted: bool,
}

impl RepoStatus {
    /// Whether work may start on it: neither archived nor deleted.
    pub fn active(&self) -> bool {
        !self.archived && !self.deleted
    }
}

/// What a person is told when something would change an archived
/// repository.
pub fn archived_message(namespace: &str, name: &str) -> String {
    format!(
        "{namespace}/{name} is archived, so it is read-only. An owner can unarchive it in its settings."
    )
}

/// The path a repository was transferred from, and when, as `transfer`
/// keeps it so old addresses redirect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRedirect {
    pub from: RepoPath,
    pub repo_id: String,
    /// RFC 3339.
    pub created_at: String,
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
    fn websites_are_tidied() {
        assert_eq!(clean_website(" example.com ").unwrap().as_deref(), Some("https://example.com"));
        assert_eq!(clean_website("http://a.io/x").unwrap().as_deref(), Some("http://a.io/x"));
        assert_eq!(clean_website("").unwrap(), None);
        assert!(clean_website("ftp://a.io").is_err());
        assert!(clean_website("localhost").is_err());
        assert!(clean_website("https://a b.io").is_err());
    }

    #[test]
    fn branch_names_follow_git() {
        for good in ["main", "trunk", "release/1.2", "feat-x_y"] {
            assert!(is_valid_branch_name(good), "{good}");
        }
        for bad in ["", "-x", "a..b", "a b", "x.lock", "a/", ".hidden", "a/.b", "g1t-queue", "a~1", "a:b", "@"] {
            assert!(!is_valid_branch_name(bad), "{bad}");
        }
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
