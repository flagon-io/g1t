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
    pub is_private: bool,
    pub owner_id: String,
    pub default_branch: String,
    /// Set when this repo is a pull request's working copy of another repo
    /// (namespace `pulls`, hidden from listings). A fork someone made into
    /// a workspace is an ordinary repository with `parent_id` instead.
    pub fork_of: Option<String>,
    /// The repository this one was forked from, when someone forked it
    /// into their workspace. Null for a repository that is not a fork, and
    /// once a fork is detached or its parent changes who can see it.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// The repository this one was made a fork of, kept when it is
    /// detached: what forks start with (Actions and work items off) holds for
    /// it until someone chooses, and pull requests opened while it was a
    /// fork still merge.
    #[serde(default)]
    pub forked_from: Option<String>,
    /// Where `parent_id` is, for a viewer who may read it: filled in by
    /// `get`, `get_by_id` and `forks`, null otherwise.
    #[serde(default)]
    pub parent: Option<RepoPath>,
    /// A private repository's admins let others fork it. Public
    /// repositories can always be forked.
    #[serde(default)]
    pub allow_forking: bool,
    /// The most branches and tags one push may change; pushes that would
    /// change more are refused whole. Null for no limit.
    #[serde(default)]
    pub max_ref_updates: Option<u32>,
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
    /// Its home page, an http(s) address, shown beside its project's description.
    /// See [`clean_website`].
    #[serde(default)]
    pub website: Option<String>,
    /// RFC 3339: when it was archived, made read-only. Null when it is not.
    #[serde(default)]
    pub archived_at: Option<String>,
}

impl Repo {
    pub fn archived(&self) -> bool {
        self.archived_at.is_some()
    }

    /// Why it takes no pushes, merges, work items or agents now: it is
    /// archived. `None` when it takes them.
    pub fn read_only_reason(&self) -> Option<String> {
        self.archived().then(|| archived_message(&self.namespace, &self.name))
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
    let host = url.split("://").nth(1).unwrap_or("").split(['/', '?', '#']).next().unwrap_or("");
    if url.chars().count() > MAX_WEBSITE_CHARS || host.is_empty() || !host.contains('.') || url.chars().any(char::is_whitespace) {
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
        && name.chars().all(|c| !c.is_control() && !matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
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
        let topic: String = topic.trim().to_lowercase().chars().map(|c| if c == ' ' || c == '_' { '-' } else { c }).collect();
        if topic.is_empty() {
            continue;
        }
        let valid = topic.chars().count() <= MAX_TOPIC_CHARS
            && topic.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && topic.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
        if !valid {
            return Err(format!("\"{topic}\" is not a topic: use letters, digits and hyphens, at most {MAX_TOPIC_CHARS} characters."));
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
    /// How it landed; `fast_forward` for one that made no commit.
    #[serde(default = "fast_forward")]
    pub method: crate::rules::MergeMethod,
    /// For `rebase`: the commits made, oldest first, each paired with the
    /// one of the branch it was made from.
    #[serde(default)]
    pub rebased: Vec<(String, String)>,
}

fn fast_forward() -> crate::rules::MergeMethod {
    crate::rules::MergeMethod::FastForward
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
}

/// `update`: changes whichever of a repository's details are given.
/// Members of its workspace only. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    pub actor: User,
    pub path: RepoPath,
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
    /// Whether a private repository may be forked (Admin).
    #[serde(default)]
    pub allow_forking: Option<bool>,
    /// The most branches and tags one push may change (Admin); 0 for no
    /// limit.
    #[serde(default)]
    pub max_ref_updates: Option<u32>,
    /// Where the request came in, for the audit log; g1t.sh when absent.
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `fork`: copies a repository into a workspace the actor may create
/// repositories in, as a new repository whose `parent_id` is the source.
/// Anyone who can read a public repository may fork it; a private one only
/// when its admins allow forking, and its fork stays private. The fork
/// gets the source's code, nothing else: no settings, secrets, rules,
/// webhooks or deployments, and Actions off until turned on. Its project
/// starts with the source project's description. Its stored size counts
/// toward the workspace it goes in. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRepoArgs {
    pub actor: User,
    /// The repository to fork.
    pub path: RepoPath,
    /// The workspace to fork it into.
    pub namespace: String,
    /// The fork's name; the source's when absent.
    #[serde(default)]
    pub name: Option<String>,
    /// Copy only the default branch (the default), or every branch and
    /// tag.
    #[serde(default = "yes")]
    pub default_branch_only: bool,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

fn yes() -> bool {
    true
}

/// `forks`: the forks of a repository the viewer may read, newest first,
/// with `parent` filled in. Returns `Outcome<Vec<Repo>>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForksArgs {
    pub viewer: Viewer,
    pub path: RepoPath,
    /// At most 100; 30 when absent.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `sync_fork`: brings a branch of a fork (its default branch when absent)
/// up to date with the branch of the same name in its parent. A branch
/// that is only behind moves forward; one with commits of its own gets a
/// merge commit, merged line by line where both changed a file, and is
/// left alone (`Conflicted`) when their lines clash. Needs Write on the
/// fork and Read on the parent. Returns `Outcome<SyncedFork>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncForkArgs {
    pub actor: User,
    pub path: RepoPath,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// What `sync_fork` did.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    /// It already had every commit of the parent's branch.
    UpToDate,
    /// It was only behind and now points where the parent's does.
    FastForwarded,
    /// It had commits of its own; a merge commit joins the two.
    Merged,
    /// Both sides changed the same files: nothing was changed. Merge
    /// the parent's branch locally, or open a pull request.
    Conflicted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedFork {
    pub status: SyncStatus,
    pub branch: String,
    /// The branch's head after syncing.
    pub head: String,
    /// Commits the parent's branch had that the fork's did not.
    pub behind: u32,
    /// Commits the fork's branch had that the parent's did not.
    pub ahead: u32,
    /// For `Conflicted`: the files both sides changed (at most 20).
    #[serde(default)]
    pub conflicts: Vec<String>,
}

/// `detach_fork`: makes a fork an ordinary repository with no parent
/// (Admin on the fork). Its pull requests into the parent stay as they
/// are. Returns `Outcome<Repo>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachForkArgs {
    pub actor: User,
    pub path: RepoPath,
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
    /// Empty selects the repository's default branch.
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
    /// Refuse if the source no longer names the commit that was checked.
    #[serde(default)]
    pub expected_commit: Option<String>,
    /// The repository the pull request merges into, when its source is a
    /// fork of it (`Repo::parent_id`, directly or through other forks)
    /// rather than a working copy or the repository itself. Refused when
    /// the source is not in its fork network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// How it lands. Absent is `fast_forward`, as every landing was before
    /// merge methods: the target branch moves to `expected_commit` only if
    /// that contains its head. `merge`, `squash` and `rebase` make new
    /// commits on the target branch's head, merging text line by line
    /// where both sides changed a file, and refuse with `conflict`
    /// (naming the files) when lines clash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<crate::rules::MergeMethod>,
    /// The new commit's message, for `merge` and `squash`: its first line
    /// is the title. Required for those two.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// For `squash`: who the commit is by (the pull request's author); the
    /// committer is `actor`. `actor` when absent. Everyone else whose
    /// commits are squashed is credited with a `Co-authored-by:` trailer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<User>,
    /// Add a `Signed-off-by:` trailer for `actor` to every commit made.
    #[serde(default)]
    pub sign_off: bool,
    /// The pull request being landed, by number: named in the push it
    /// makes (`GitPush::landed_pull`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull: Option<u32>,
}

/// `pushed`: what a push to a branch of a repository brought into it, the
/// commits reachable from `after` and not from `before` (every parent
/// followed, as far as `MAX_ANCESTRY` commits on either side). Services
/// only. Returns `Pushed`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushedArgs {
    pub repo_id: String,
    /// Where the branch pointed before; none for a new branch.
    #[serde(default)]
    pub before: Option<String>,
    pub after: String,
    /// Commits to look for among those brought in: pull requests' heads.
    #[serde(default)]
    pub heads: Vec<String>,
    /// Whether to list the commits brought in, with their messages.
    #[serde(default)]
    pub messages: bool,
    /// The push made the default branch: the repository's first, whose
    /// commits were pushed nowhere before, so their messages count too.
    #[serde(default)]
    pub first: bool,
}

/// What `pushed` found.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    /// Those of `heads` the push brought in.
    pub landed: Vec<String>,
    /// With `messages`: the commits brought in, oldest first, at most
    /// `MAX_PUSHED`.
    pub commits: Vec<PushedCommit>,
}

/// The most commits `pushed` lists.
pub const MAX_PUSHED: usize = 250;

/// A commit a push brought in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushedCommit {
    pub hash: String,
    pub message: String,
    /// Its author's address, for telling a coding agent's commits
    /// (`coding_agents::agent_mark`). Absent from older senders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_email: Option<String>,
}

/// `build_queue_step`: one entry of a merge queue landed, by its method,
/// on a commit of the target that is not a branch's head: the default
/// branch, or the state built for the entries ahead. Makes the commits
/// `land` would make there (`merge`, `squash` and `rebase` new ones; a
/// `fast_forward` none, its head only if that contains `onto`) and points
/// `push_branch` of the target at the result, so that landing it later is
/// a fast-forward to exactly what was tested. The branch it merges into
/// does not move. Returns `Outcome<QueueStep>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildQueueStepArgs {
    /// The repository the queue lands on.
    pub target_id: String,
    /// The commit to build on.
    pub onto: String,
    /// Where the entry's change is: its fork, or the target itself.
    pub source_id: String,
    pub branch: String,
    /// The entry's head as it was queued; refused if the branch moved.
    pub commit: String,
    pub method: crate::rules::MergeMethod,
    /// For `merge` and `squash`: the commit's message. Required for those.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// For `squash`: who the commit is by; `actor` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<User>,
    #[serde(default)]
    pub sign_off: bool,
    /// Whoever queued it: the committer, who must be able to merge.
    pub actor: User,
    /// The queue's branch of the target to point at the result.
    pub push_branch: String,
}

/// What `build_queue_step` made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueueStep {
    /// The state with the entry in it, now at `push_branch`: `onto` itself
    /// when it held the entry's changes already.
    Built {
        commit: String,
        /// For `rebase`: each commit made, with the one it was made from.
        #[serde(default)]
        rebased: Vec<(String, String)>,
    },
    /// Its change clashes with `onto` in these files.
    Conflict { message: String, paths: Vec<String> },
    /// It cannot be built there, and why: a fast-forward that does not
    /// contain `onto`, or more than g1t makes itself.
    Refused { message: String },
}

/// How a pull request's branch is brought up to date with its base
/// (`update_pull_branch`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateMethod {
    /// A merge commit on the branch joins the base's new commits.
    #[default]
    Merge,
    /// The branch's commits are made again on the base's head, and the
    /// branch is moved there (a force push).
    Rebase,
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
    /// True when the file is binary, so no lines are shown and none counted.
    pub binary: bool,
    /// True when the file is text too large to compare (or too much of a
    /// large one changed), so no lines are shown and none counted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub too_large: bool,
    pub hunks: Vec<Hunk>,
    /// True when the comparison reached its limit on lines before this
    /// file, so it is listed without its lines (and with no counts): ask
    /// `compare` again with its path in `paths` to have them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub omitted: bool,
}

/// What changed between two commits.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Comparison {
    /// Null when the head has no earlier commit to compare against.
    pub base: Option<String>,
    pub head: String,
    pub files: Vec<FileDiff>,
    /// True when more files changed than are listed. A listed file whose
    /// lines were left out says so itself (`FileDiff::omitted`).
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
    /// Only these files, with their lines: how a file left out of a large
    /// comparison is read on its own. At most 50.
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// With no `base`: a repository `repo_id` is a fork of (directly or
    /// through other forks) whose branch (`base_branch`, else its default
    /// branch) the head is compared from, as for a pull request from a
    /// fork. Both must be readable by the viewer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
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
    /// True when the history was too long to read in full (too many
    /// commits, or too long to read), so the oldest lines are given to the
    /// oldest commit read that has them.
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
    /// Answer within this many milliseconds with what was found; absent,
    /// within 20 seconds. A walk that stops short keeps its progress, and
    /// the next call goes on from it.
    #[serde(default)]
    pub budget_ms: Option<u64>,
}

/// `path_log`: the commits on the first-parent chain from `ref` (the
/// default branch when absent) that changed `file_path`, a file or a
/// directory, newest first, at most `limit`. Returns `Outcome<PathLog>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathLogArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    pub file_path: String,
    pub limit: u32,
    /// Answer within this many milliseconds with what was found.
    #[serde(default)]
    pub budget_ms: Option<u64>,
}

/// A path's history: `complete` is false when the walk ran out of time or
/// reads before the first commit and before `limit`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathLog {
    pub commits: Vec<Commit>,
    pub complete: bool,
}

/// An entry of a directory and the commit that last changed it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LastCommit {
    pub name: String,
    pub commit: Commit,
}

/// The entries' last commits. `complete` is false when the walk stopped
/// (or the history ran out) before every entry was placed; those entries
/// are left out, and a later call goes on placing them.
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
    /// The repository the pull request merges into, when its source is a
    /// fork of it (`Repo::parent_id`, directly or through other forks)
    /// rather than a working copy or the repository itself. Refused when
    /// the source is not in its fork network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
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
    /// The repository the pull request merges into, when its source is a
    /// fork of it (`Repo::parent_id`, directly or through other forks)
    /// rather than a working copy or the repository itself. Refused when
    /// the source is not in its fork network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// Merge the base in (the default), or rebase the branch onto it.
    #[serde(default)]
    pub method: UpdateMethod,
    /// Refuse if the branch no longer points here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_head: Option<String>,
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
    NeedsAgent { reason: NeedsAgentReason, detail: String, paths: Vec<String> },
}

/// `pull_merge_ref`: points `refs/pull/<number>/head` in the repository a
/// pull request merges into at its head, fetching the head's objects from
/// the fork first when it comes from one, and `refs/pull/<number>/merge`
/// at the commit that merges that head into the base branch's tip, made
/// without a sandbox: what GitHub's `pull_request` runs build. For the
/// actions service, which has already decided the pull request's events
/// may start runs. Returns `PullMergeRef`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullMergeRefArgs {
    /// The repository the pull request merges into.
    pub repo_id: String,
    /// The pull request's fork, or the repository itself for a branch.
    pub source_id: String,
    /// The pull request's head commit.
    pub head: String,
    pub number: u32,
    /// The branch it merges into; the default branch when absent.
    #[serde(default)]
    pub target_branch: Option<String>,
}

/// What came of `pull_merge_ref`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PullMergeRef {
    /// `refs/pull/<number>/merge` is `merge`, whose parents are `base`
    /// (the base branch's tip) and `head`.
    Merged { head: String, base: String, merge: String },
    /// The head and the base branch change the same lines, or the same
    /// binary file, differently: there is no merge commit, and
    /// `refs/pull/<number>/merge` is removed, as on GitHub.
    Conflict { head: String, base: String, paths: Vec<String> },
    /// g1t could not make the merge commit itself (a file renamed on one
    /// side and changed on the other, a very large change, a history it
    /// could not follow), or either side has no commits: `reason` says why.
    Unavailable { reason: String },
}

/// The ref a pull request's head is kept at in the repository it merges
/// into, as on GitHub.
pub fn pull_head_ref(number: u32) -> String {
    format!("refs/pull/{number}/head")
}

/// The ref of a pull request's test merge commit, as on GitHub.
pub fn pull_merge_ref(number: u32) -> String {
    format!("refs/pull/{number}/merge")
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
/// [`G1T_BRANCH_PREFIX`], or `head` must name the commit it points to (a
/// dependency update's branch, which g1t pushed and whose pull request it
/// closed). Never the default branch. For services, which have no viewer.
/// Returns `Outcome<bool>`: whether there was such a branch.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchArgs {
    pub repo_id: String,
    pub branch: String,
    /// The commit the branch must still point to. A branch that moved
    /// since (someone pushed to it) is left alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
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
    /// Add a `Signed-off-by:` trailer for `actor`: required where the
    /// repository asks web commits to be signed off.
    #[serde(default)]
    pub sign_off: bool,
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

/// `commit_days`: how many commits a person pushed each day (UTC) since
/// `since` (`YYYY-MM-DD`), to the default branch or `gh-pages` of
/// repositories the viewer may read (as `readable` decides), for the
/// contribution calendar. Credited to whoever pushed; at most 50 commits a
/// push, counted along the branch's first-parent line. Returns
/// `Vec<crate::work::ContributionDay>`, oldest first, days with none left out.
#[derive(Debug, Serialize, Deserialize)]
pub struct CommitDaysArgs {
    pub user_id: String,
    pub since: String,
    pub viewer: Viewer,
}

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
    /// `blob`, `exec` (executable) or `symlink` (the blob is where it
    /// points); absent for a deleted file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<EntryKind>,
}

/// Files, and whether there were more than were listed.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// The commit the files were read at; null for an empty repository.
    pub commit: Option<String>,
    /// When that commit was made (RFC 3339), what an archive dates its
    /// files by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
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
    /// Symlinks too, for an archive: by default only files whose text can
    /// be read are listed.
    #[serde(default)]
    pub links: bool,
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

/// `archive_link`: a link to download a branch, tag or commit as an
/// archive, for someone who can read the repository: the site's
/// `/<owner>/<repo>/archive/<commit>.tar.gz` (or `.zip`) with `?token=`,
/// good for [`ARCHIVE_LINK_SECONDS`] without a session or an access token.
/// The default branch when `ref` is absent. Returns `Outcome<ArchiveLink>`;
/// refused as `invalid` where the repos service has no `REPOS_KEY`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLinkArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
}

/// How long an archive link lasts.
pub const ARCHIVE_LINK_SECONDS: u64 = 10 * 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveLink {
    pub repo: Repo,
    /// The commit the ref named, which the link downloads.
    pub commit: String,
    /// What the link carries as `?token=`.
    pub token: String,
    /// RFC 3339.
    pub expires_at: String,
}

/// `open_archive_token`: what an archive link's token lets anyone holding
/// it download, when it is for the repository at `path` and has not
/// expired. Returns `Option<ArchiveGrant>`. No viewer: the token is the
/// permission.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArchiveTokenArgs {
    pub path: RepoPath,
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveGrant {
    pub repo_id: String,
    /// The repository's workspace and name as they are now.
    pub namespace: String,
    pub name: String,
    pub commit: String,
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

/// `deleted_repos` takes [`AllIdsArgs`]: every repository that is not a
/// fork and is deleted but not purged yet (so it may still be restored),
/// by id, a page at a time, for work recording where such a repository's
/// work items came from. Returns [`DeletedRepoPage`].
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeletedRepoPage {
    pub repos: Vec<RestorableRepo>,
    /// Where the next page starts; null on the last.
    pub next: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestorableRepo {
    pub id: String,
    /// Its workspace's slug.
    pub namespace: String,
    pub name: String,
    pub is_private: bool,
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
/// work items and pull requests are locked, and agents and workflows do not
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

/// `create_branch`: makes a branch named `name` at `from`: another
/// branch, a tag or a commit (the default branch's head when empty). The
/// actor needs to be able to push, and the rules for creating the branch
/// hold. Restoring a deleted branch is making it again at the commit
/// `remove_branch` answered with. Publishes `git.push`. Returns
/// `Outcome<Branch>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchArgs {
    pub actor: User,
    pub path: RepoPath,
    pub name: String,
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `remove_branch`: deletes a branch for someone who can push, never the
/// default branch; the rules for deleting it hold. `head`, when given, is
/// the commit it must still point to: a branch that moved since is left
/// alone. Publishes `git.deleted`. Returns `Outcome<Branch>`: the branch
/// as it was, so it can be made again at the same commit with
/// `create_branch`. (`delete_branch` is the services' own, with no actor.)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveBranchArgs {
    pub actor: User,
    pub path: RepoPath,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
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
/// own services deciding whether to act on it. An unknown id answers as deleted. Returns `RepoStatus`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StatusByIdArgs {
    pub id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    format!("{namespace}/{name} is archived, so it is read-only. An owner can unarchive it in its settings.")
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

/// What a write from the site (a commit, a merge, a pull request update)
/// is told, as a `Forbidden`, when its workspace's public storage cannot
/// fit it. Work tells it by this from `update_pull_branch`'s refusals of
/// who may push to the branch.
pub const PUBLIC_STORAGE_FULL: &str = "Public repository storage is full. Make room before adding more data.";

// --- Staff only (sudo.g1t.sh): public storage holds ---
//
// A write reserves public storage capacity before it reaches the git
// store, and a native fork locks its source while it copies. One that is
// interrupted keeps its hold, which refuses later writes. These list the
// holds, inspect each with the store's state, release only what is
// provably abandoned (with an audit row), and measure what the store
// holds against what g1t counted. services/repos/src/storage_holds.rs.

/// What holds capacity: `reservation` (a row of the ledger), `unledgered`
/// (bytes reserved by code older than the ledger, by repository) or
/// `copy_lock` (a native fork's lock on its source, by source).
pub const HOLD_KINDS: [&str; 3] = ["reservation", "unledgered", "copy_lock"];

/// `admin_storage_holds`: every hold, oldest first. Returns `StorageHolds`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminStorageHoldsArgs {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `admin_inspect_storage_hold`: one hold and the store's state. Returns
/// `Outcome<StorageHoldInspection>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminStorageHoldArgs {
    /// One of [`HOLD_KINDS`].
    pub kind: String,
    /// A reservation's id; the repository's id for `unledgered`; the
    /// source's id for `copy_lock`.
    pub id: String,
}

/// `admin_release_storage_hold`: releases one hold if it is provably
/// abandoned, inspecting it again first, and records who and why. Returns
/// `Outcome<StorageRecovery>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminReleaseStorageHoldArgs {
    pub kind: String,
    pub id: String,
    /// The staff member, as sudo knows them.
    pub staff: String,
    pub reason: String,
}

/// `admin_storage_recoveries`: holds released, newest first. Returns
/// `Vec<StorageRecovery>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AdminStorageRecoveriesArgs {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `admin_storage_drift`: a sample of repositories measured in the store
/// against `stored_bytes`. Reads only. Returns `StorageDrift`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminStorageDriftArgs {
    /// How many repositories, at most 20 (5 when unset).
    #[serde(default)]
    pub sample: Option<u32>,
    /// Repositories g1t counts as larger than this are passed over (200 MB
    /// when unset), so one call stays within a Worker's time.
    #[serde(default)]
    pub max_bytes: Option<u64>,
    /// Particular repositories, by id, instead of a random sample.
    #[serde(default)]
    pub repo_ids: Vec<String>,
}

/// A repository named by a hold.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHoldRepo {
    pub id: String,
    /// `workspace/name`; `None` once its row is gone.
    pub path: Option<String>,
    pub private: bool,
    /// Deleted and not yet purged.
    pub deleted: bool,
}

/// One hold, with whether it is provably abandoned.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHold {
    /// One of [`HOLD_KINDS`].
    pub kind: String,
    /// What [`AdminStorageHoldArgs::id`] takes for it.
    pub id: String,
    /// The repository charged; a copy lock's source.
    pub repo: StorageHoldRepo,
    /// The repository written; a copy lock's destination.
    pub target: Option<StorageHoldRepo>,
    /// `push`, `commit`, `merge`, `queue`, `update`, `land`, `sync`,
    /// `import` or `fork`; `None` for unledgered bytes.
    pub operation: Option<String>,
    /// Who asked, by user id, when known.
    pub actor: Option<String>,
    /// `held` while it may run, `ended` once it stopped without knowing
    /// whether the store took it; `None` for unledgered bytes and locks.
    pub state: Option<String>,
    pub bytes: u64,
    /// RFC 3339; for unledgered bytes, `None`: they predate the ledger.
    pub since: Option<String>,
    pub age_seconds: Option<u64>,
    /// RFC 3339: when it stops (stopped) sending to the store.
    pub lease_until: Option<String>,
    /// How an ended one ended.
    pub outcome: Option<String>,
    pub abandoned: bool,
    /// Why it is abandoned, or why not yet, in a sentence.
    pub why: String,
    /// RFC 3339: when it will be provably abandoned if nothing changes.
    pub releasable_at: Option<String>,
}

/// Every hold, as `admin_storage_holds` answers.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHolds {
    /// RFC 3339.
    pub now: String,
    /// RFC 3339: when the ledger began. Unledgered bytes are older.
    pub ledger_since: Option<String>,
    pub holds: Vec<StorageHold>,
    /// Holds past `limit`, not listed.
    pub more: u32,
}

/// A ref a write asked the store to move, and where the store has it now.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskedRef {
    pub name: String,
    pub asked: String,
    /// `None` when the store does not have the ref.
    pub now: Option<String>,
}

/// What the git store says about one repository a hold names.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamState {
    /// `charged` (the repository charged), `written` (the one written) or
    /// `source` (where a fork was copied from).
    pub role: String,
    pub repo: StorageHoldRepo,
    /// Whether the store answered.
    pub read: bool,
    /// Why it did not, or that it holds no such repository.
    pub error: Option<String>,
    /// Refs it lists: branches, tags and pull requests' heads.
    pub refs: u32,
    /// The default branch's commit.
    pub head: Option<String>,
    /// For a write that ended, each ref it asked for.
    pub asked: Vec<AskedRef>,
    /// What g1t counts for it: measured and reserved bytes, and how much of
    /// the reservation the ledger accounts for.
    pub stored_bytes: Option<u64>,
    pub reserved_bytes: Option<u64>,
    pub ledger_bytes: Option<u64>,
}

/// One hold looked at closely, as `admin_inspect_storage_hold` answers.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHoldInspection {
    pub hold: StorageHold,
    pub upstream: Vec<UpstreamState>,
    /// Whether `admin_release_storage_hold` would release it now.
    pub releasable: bool,
    /// Why not, when it would not.
    pub refusal: Option<String>,
}

/// A hold staff released, as recorded.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRecovery {
    pub id: String,
    pub kind: String,
    pub repo_id: String,
    pub target_id: Option<String>,
    pub reservation_id: Option<String>,
    pub operation: Option<String>,
    pub actor: Option<String>,
    pub bytes: u64,
    /// RFC 3339.
    pub held_since: Option<String>,
    /// What the inspection found when it was released: the hold and the
    /// store's state ([`StorageHoldInspection`]).
    pub evidence: serde_json::Value,
    pub staff: String,
    pub reason: String,
    /// RFC 3339.
    pub released_at: String,
    /// Its line in sudo's audit log, which the repos service writes from
    /// its outbox (`storage_recovery_audits`). `None` for a release made
    /// before it did, whose line sudo wrote itself.
    #[serde(default)]
    pub audit: Option<StorageRecoveryAudit>,
}

/// Where a release's line in sudo's audit log stands: written once billing
/// confirmed it (`sent_at`), and until then tried again every hour.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageRecoveryAudit {
    /// RFC 3339; `None` while it is still to be written.
    pub sent_at: Option<String>,
    pub attempts: u32,
    /// What billing's last answer was, while it is still to be written.
    pub error: Option<String>,
}

/// One repository measured in the store.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDrift {
    pub repo: StorageHoldRepo,
    /// What g1t counts (`stored_bytes`), its working copies' included.
    pub stored_bytes: u64,
    /// The pack the store sends for every ref, plus what each of its pull
    /// requests' working copies holds beyond it. `None` when not measured.
    pub store_bytes: Option<u64>,
    /// `store_bytes - stored_bytes`: above zero, g1t counts less than the
    /// store holds.
    pub drift_bytes: Option<i64>,
    pub working_copies: u32,
    /// Why it was not measured, or what failed.
    pub note: Option<String>,
}

/// What `admin_storage_drift` measured.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDrift {
    /// RFC 3339.
    pub measured_at: String,
    pub repos: Vec<RepoDrift>,
    /// Over the repositories measured.
    pub stored_bytes: u64,
    pub store_bytes: u64,
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
        let update = PullBranchUpdate::NeedsAgent { reason: NeedsAgentReason::Overlap, detail: "both".into(), paths: vec!["a.rs".into()] };
        assert_eq!(
            serde_json::to_value(&update).unwrap(),
            serde_json::json!({ "outcome": "needs_agent", "reason": "overlap", "detail": "both", "paths": ["a.rs"] })
        );
        let done = PullBranchUpdate::UpToDate { commit: "c".into() };
        assert_eq!(serde_json::to_value(&done).unwrap(), serde_json::json!({ "outcome": "up_to_date", "commit": "c" }));
    }
}
