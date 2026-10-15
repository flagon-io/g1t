//! The repos service: repository metadata, contents, forks, landing, and
//! git over HTTPS.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::repos` for the methods and their arguments. Any other
//! request is treated as git's smart HTTP protocol.

mod about;
mod archive_links;
mod backups;
mod blame;
mod catch_up;
mod coalesce;
mod commit_file;
mod contributors;
mod copy;
mod diff;
mod drift;
mod fallback;
mod forks;
mod git_http;
mod git_ops;
mod hidden_refs;
mod import;
mod land;
mod languages;
mod last_commits;
mod license;
mod lifecycle;
mod limits;
mod listing;
mod merge_methods;
mod meters;
mod moves;
mod namespaces;
mod network;
mod pack_cache;
mod pack_limits;
mod push_checks;
mod push_feedback;
mod push_commits;
mod pushed;
mod refs;
mod refs_cache;
mod registry;
mod resilience;
mod rule_facts;
mod rules;
mod run_access;
mod secret_scan;
mod shards;
mod shared;
mod signatures;
mod stats;
mod store;
mod test_merge;
mod transfer;
mod public_storage;
mod workflow_gate;

use g1t_contracts::events::{
    Event, GitDeleted, GitPush, NewEvent, Publish, RepoCreated, RepoForked, RepoUpdated, WorkspaceDeleted,
    WorkspaceDeleting, WorkspaceRenamed, WorkspaceRestored,
};
use g1t_contracts::access::{self, Capability};
use g1t_contracts::repos::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, Viewer, is_valid_repo_name, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use serde::Serialize;
use worker::{
    Context, Env, Fetcher, MessageBatch, MessageExt, Method, Request, Response, Result, ScheduleContext, ScheduledEvent,
    event,
};

use registry::{Registry, can_read, can_write, store_key};
use store::{ArtifactsStore, GitRepo, GitStore, Scope};

/// Namespace that holds every pull request's fork: `pulls/<pull id>`.
pub(crate) const PULLS_NAMESPACE: &str = "pulls";
const MAX_TEXT_BYTES: usize = 512 * 1024;
/// How far back a pull request may have forked and still be landed.
const MAX_ANCESTRY: u32 = 1000;
/// The highest limit on how many branches and tags one push may change
/// (`UpdateArgs::max_ref_updates`).
const MAX_REF_UPDATES_LIMIT: u32 = 1000;
/// How many forks up a pull request's source is looked for in the fork
/// network of the repository it merges into.
const MAX_FORK_DEPTH: usize = 10;
/// The most files one `compare` asked for by path reads.
const MAX_COMPARED_PATHS: usize = 50;
/// The most tags a repository's Tags page reads and lists.
const MAX_TAGS_READ: usize = 100;
/// Branch heads measured in one `branch_drift` call.
const MAX_DRIFT_HEADS: usize = 100;
/// How long a `last_commits` walk asked without a budget runs before it
/// stops and keeps its progress for the next call. The site asks from a
/// waitUntil, which may run 30 s past its response.
const LAST_COMMITS_WALK_MS: u64 = 20_000;
/// How long a path's history may walk when the caller gives no budget.
const PATH_LOG_WALK_MS: u64 = 10_000;
/// How long a blame walks before it answers with what it has: a page waits
/// on it. A blame cut short is kept only briefly (blame.rs, `cache_control`).
const BLAME_WALK_MS: u64 = 6_000;

/// One path segment, percent-encoded for a cache key.
fn urlencoding_segment(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}
pub(crate) const SOURCE: &str = "repos";
pub(crate) const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

pub(crate) fn not_found<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Repository not found.")
}

/// Decoded text, or `None` when the file is too large or looks binary.
/// Whether a ref is a full commit hash rather than a branch name.
fn is_commit_hash(git_ref: &str) -> bool {
    git_ref.len() == 40 && git_ref.bytes().all(|b| b.is_ascii_hexdigit())
}

fn text_of(bytes: Vec<u8>) -> Option<String> {
    if bytes.len() > MAX_TEXT_BYTES || bytes.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_readme(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "readme" | "readme.md" | "readme.markdown" | "readme.txt"
    )
}

/// Whether `ancestor` is reachable from the newest commit in `history`.
///
/// `history` is the first-parent chain, which is all the store lists; a fork
/// that merged the target branch in has the target's head on a second
/// parent, so the walk follows every parent.
async fn descends_from<R: GitRepo>(repo: &R, history: &[Commit], ancestor: &str) -> Result<bool> {
    let known: HashMap<&str, &[String]> = history
        .iter()
        .map(|commit| (commit.hash.as_str(), commit.parents.as_slice()))
        .collect();
    let mut seen = HashSet::new();
    let mut queue: Vec<String> = history
        .first()
        .map(|c| c.hash.clone())
        .into_iter()
        .collect();
    while let Some(hash) = queue.pop() {
        if hash == ancestor {
            return Ok(true);
        }
        if !seen.insert(hash.clone()) || seen.len() > MAX_ANCESTRY as usize {
            continue;
        }
        match known.get(hash.as_str()) {
            Some(parents) => queue.extend(parents.iter().cloned()),
            None => queue.extend(repo.parents(&hash).await?.unwrap_or_default()),
        }
    }
    Ok(false)
}

/// The commit closest to the newest in `history` that is also in `shared`:
/// where a fork and the repository it came from last agreed.
async fn nearest_ancestor_in<R: GitRepo>(
    repo: &R,
    history: &[Commit],
    shared: &HashSet<String>,
) -> Result<Option<String>> {
    let known: HashMap<&str, &[String]> = history
        .iter()
        .map(|commit| (commit.hash.as_str(), commit.parents.as_slice()))
        .collect();
    let mut seen = HashSet::new();
    let mut queue: VecDeque<String> = history
        .first()
        .map(|c| c.hash.clone())
        .into_iter()
        .collect();
    while let Some(hash) = queue.pop_front() {
        if shared.contains(&hash) {
            return Ok(Some(hash));
        }
        if !seen.insert(hash.clone()) || seen.len() > MAX_ANCESTRY as usize {
            continue;
        }
        match known.get(hash.as_str()) {
            Some(parents) => queue.extend(parents.iter().cloned()),
            None => queue.extend(repo.parents(&hash).await?.unwrap_or_default()),
        }
    }
    Ok(None)
}

thread_local! {
    /// Targets' sides of mergeability, by head (coalesce.rs).
    static TARGETS: std::cell::RefCell<coalesce::Memo<coalesce::TargetKey, Rc<coalesce::TargetSide>>> =
        std::cell::RefCell::new(coalesce::Memo::new(coalesce::TARGET_TTL_MS, 32));
    /// What targets changed between two trees.
    static THEIRS: std::cell::RefCell<coalesce::Memo<coalesce::TheirsKey, (Vec<String>, bool)>> =
        std::cell::RefCell::new(coalesce::Memo::new(coalesce::THEIRS_TTL_MS, 256));
    /// What repositories hold, as read for a push's first request, for the
    /// same push's second: a push's POST does not wait on the database.
    static HELD: std::cell::RefCell<coalesce::Memo<String, u64>> =
        std::cell::RefCell::new(coalesce::Memo::new(60_000, 512));
}

pub(crate) struct Repos<S: GitStore> {
    registry: Registry,
    store: S,
    events: Fetcher,
    /// Asked during a push which secrets have been allowed.
    security: Option<Fetcher>,
    /// Asked whether a workspace is on a plan, for its private storage.
    billing: Option<Fetcher>,
    /// Says which rulesets hold for a change to a branch or tag, and keeps
    /// how they judged it (rules.rs). `None` where it is not deployed: the
    /// old protection flag then holds on push.
    work: Option<Fetcher>,
    /// Told when a repository moves, for the tokens of agents at work on it.
    identity: Option<Fetcher>,
    /// What a free workspace's private repositories may hold.
    free_private_bytes: i64,
    /// Finite public storage allowance, including paid workspaces.
    free_public_bytes: i64,
    /// Days a pull request's working copy is kept after it settles (forks.rs).
    pub(crate) fork_days: u64,
    /// The most a repository may hold (pack_limits.rs), and what happens
    /// to a push too large to scan.
    repo_limit: u64,
    large_pushes: git_http::LargePushes,
    /// Which git store namespace new repositories go in (shards.rs), and
    /// the most each should hold (`GITSTORE_NAMESPACE_LIMITS`).
    placement: shards::Placement,
    limits: HashMap<String, u64>,
    /// What isolates share: answers that list refs (refs_cache.rs).
    shared: Option<Rc<shared::Shared>>,
    /// Packs for fresh clones (pack_cache.rs); `None` without the bucket.
    packs: Option<Rc<pack_cache::Packs>>,
    /// What this request started that need not hold up its answer
    /// (store.rs), handed to its `waitUntil` once it has answered.
    deferred: Rc<store::Deferred>,
}

impl<S: GitStore> Repos<S> {
    /// Records that the refs of the repository with this id changed, once
    /// they have, so that the answers kept that list them go stale (see
    /// refs_cache.rs). Everything that changes a repository's refs calls
    /// this after it (`every_ref_writer_records_the_change` checks). A
    /// failure is logged: the change itself happened, and what was kept
    /// expires within `refs_cache::TTL_SECONDS` regardless.
    pub(crate) async fn refs_moved(&self, repo_id: &str) {
        if let Err(error) = self.registry.refs_moved(repo_id).await {
            worker::console_error!("refs of {repo_id} changed but not recorded: {error}");
        }
    }

    pub(crate) async fn publish<T: Serialize>(&self, event: NewEvent<T>) -> Result<()> {
        g1t_kit::call(
            &self.events,
            "publish",
            &Publish {
                events: vec![event],
            },
        )
        .await
    }

    /// Whether the viewer may read `repo`. A pull request's fork of a
    /// private repository can be read by everyone who can read that
    /// repository, so its members can review and check out the change, as
    /// well as by whoever opened the pull request.
    async fn may_read(&self, repo: &Repo, viewer: &Viewer) -> Result<bool> {
        if can_read(repo, viewer) {
            return Ok(true);
        }
        let Some(source_id) = &repo.fork_of else {
            return Ok(false);
        };
        Ok(self
            .registry
            .by_id(source_id)
            .await?
            .is_some_and(|source| can_read(&source, viewer)))
    }

    /// `repo`, if there is one and the viewer may read it.
    async fn visible(&self, repo: Option<Repo>, viewer: &Viewer) -> Result<Option<Repo>> {
        Ok(match repo {
            Some(repo) if self.may_read(&repo, viewer).await? => Some(repo),
            _ => None,
        })
    }

    /// Resolves a repo the viewer may read; private repos look missing.
    pub(crate) async fn readable(&self, path: &RepoPath, viewer: &Viewer) -> Result<Option<Repo>> {
        self.visible(self.registry.by_path(path).await?, viewer)
            .await
    }

    async fn get(&self, a: GetArgs) -> Result<Outcome<Repo>> {
        Ok(match self.readable(&a.path, &a.viewer).await? {
            Some(repo) => Outcome::Ok(self.with_parent(repo, &a.viewer).await?),
            None => not_found(),
        })
    }

    async fn get_by_id(&self, a: GetByIdArgs) -> Result<Outcome<Repo>> {
        Ok(match self.visible(self.registry.by_id(&a.id).await?, &a.viewer).await? {
            Some(repo) => Outcome::Ok(self.with_parent(repo, &a.viewer).await?),
            None => not_found(),
        })
    }

    async fn update(&self, a: UpdateArgs) -> Result<Outcome<Repo>> {
        let viewer = Some(a.actor.clone());
        let Some(repo) = self.readable(&a.path, &viewer).await? else {
            return Ok(not_found());
        };
        // Its details take Maintain; its protection, Admin; who can see it,
        // Admin and the member privileges (below). See g1t_contracts::access.
        let protection_changes = a.protected.is_some_and(|protected| protected != repo.protected);
        let forking_changes = a.allow_forking.is_some_and(|allow| allow != repo.allow_forking);
        // 0 clears the limit.
        let max_ref_updates = match a.max_ref_updates {
            Some(0) => None,
            Some(limit) if limit > MAX_REF_UPDATES_LIMIT => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("A push can be limited to at most {MAX_REF_UPDATES_LIMIT} branches and tags; use 0 for no limit."),
                ));
            }
            Some(limit) => Some(limit),
            None => repo.max_ref_updates,
        };
        let limit_changes = max_ref_updates != repo.max_ref_updates;
        let details_change = a.website.is_some() || a.topics.is_some();
        let mut needed = Vec::new();
        if details_change || !(protection_changes || forking_changes || limit_changes) {
            needed.push(Capability::ManageSettings);
        }
        if protection_changes {
            needed.push(Capability::ManageProtection);
        }
        // Who may copy a private repository elsewhere is an admin's to say.
        // So is how much one push may change.
        if forking_changes || limit_changes {
            needed.push(Capability::Administer);
        }
        let full_name = format!("{}/{}", repo.namespace, repo.name);
        if repo.fork_of.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs(Capability::ManageSettings, &full_name)));
        }
        if let Some(missing) = needed.into_iter().find(|capability| !registry::can(&repo, &viewer, *capability)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs(missing, &full_name)));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        if let Some((code, message)) = lifecycle::archived_refusal(&repo) {
            return Ok(Outcome::fail(code, message));
        }
        let website = match a.website.as_deref() {
            Some(text) => match clean_website(text) {
                Ok(website) => website,
                Err(reason) => return Ok(Outcome::fail(FailureCode::Invalid, reason)),
            },
            None => repo.website.clone(),
        };
        // Who can see it is an owner's to change, and a free workspace's
        // storage may not take it private: see lifecycle.rs.
        let wants_private = a.is_private.filter(|private| *private != repo.is_private);
        if wants_private.is_some()
            && let Err((code, message)) = lifecycle::admin_only(
                lifecycle::Asker::on(&a.actor, &repo),
                &repo.namespace,
                "change the visibility of",
                Capability::ChangeVisibility,
            )
        {
            return Ok(Outcome::fail(code, message));
        }
        if let Some(private) = wants_private
            && let Some(why) = lifecycle::visibility_refusal(&a.actor, &repo, private)
        {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        let is_private = repo.is_private;
        let protected = a.protected.unwrap_or(repo.protected);
        let topics = match &a.topics {
            Some(topics) => match clean_topics(topics) {
                Ok(topics) => topics,
                Err(reason) => return Ok(Outcome::fail(FailureCode::Invalid, reason)),
            },
            None => repo.topics.clone(),
        };
        let allow_forking = a.allow_forking.unwrap_or(repo.allow_forking);
        self.registry
            .update(&repo.id, protected, &topics, website.as_deref(), allow_forking, max_ref_updates)
            .await?;
        let updated = Repo {
            is_private,
            protected,
            topics,
            website,
            allow_forking,
            max_ref_updates,
            ..repo
        };
        // Whether the default branch takes only pull requests is now its
        // branch protection ruleset's to say (work's rulesets.rs).
        if let (Some(protected), Some(work)) = (a.protected, &self.work) {
            #[derive(Serialize)]
            struct RequirePullRequest<'a> {
                repo: &'a Repo,
                protected: bool,
                actor: &'a User,
            }
            let set: Result<Outcome<bool>> =
                g1t_kit::call(work, "set_requires_pull_request", &RequirePullRequest { repo: &updated, protected, actor: &a.actor }).await;
            match set {
                Ok(Outcome::Ok(_)) => {}
                Ok(Outcome::Fail(failure)) => return Ok(Outcome::Fail(failure)),
                Err(error) => return Err(error),
            }
        }
        if let Some(private) = wants_private {
            return self.change_visibility(updated, private, &a.actor, a.surface).await;
        }
        let visibility_changed = false;
        // Search and anything else that shows the repository hears of it;
        // a change of visibility is announced on its own as well, so that
        // what was public stops being shown at once.
        self.publish(NewEvent {
            kind: "repo.updated",
            source: SOURCE,
            repo_id: Some(updated.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoUpdated {
                repo_id: updated.id.clone(),
                namespace: updated.namespace.clone(),
                name: updated.name.clone(),
                is_private,
                visibility_changed,
            },
        })
        .await?;
        Ok(Outcome::Ok(updated))
    }

    /// The repository with this id, if it is not a fork, and its store.
    async fn stored(&self, repo_id: &str) -> Result<Option<S::Repo>> {
        match self.registry.by_id(repo_id).await? {
            Some(repo) if repo.fork_of.is_none() => Ok(Some(self.store.open(&store_key(&repo)).await?)),
            _ => Ok(None),
        }
    }

    async fn list_files(&self, a: ListFilesArgs) -> Result<FileList> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await?.filter(|repo| repo.fork_of.is_none()) else {
            return Ok(FileList::default());
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let head = a.git_ref.unwrap_or_else(|| repo.default_branch.clone());
        listing::list(&git, None, &head, &a.skip_dirs, a.limit, a.links).await
    }

    /// A link to download a branch, tag or commit as an archive, good for
    /// a few minutes with no session or token (archive_links.rs).
    async fn archive_link(&self, a: ArchiveLinkArgs, sealer: Option<&g1t_secrets::Sealer>) -> Result<Outcome<ArchiveLink>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let Some(sealer) = sealer else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Archive downloads are not set up on this installation."));
        };
        let git = self.read_git(&repo).await?;
        let git_ref = a.git_ref.filter(|git_ref| !git_ref.is_empty()).unwrap_or_else(|| repo.default_branch.clone());
        let Some(head) = git.log(&git_ref, 1).await?.into_iter().next() else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such branch, tag or commit."));
        };
        let (token, expires) = archive_links::seal(sealer, &repo.id, &head.hash, now_ms());
        Ok(Outcome::Ok(ArchiveLink { repo, commit: head.hash, token, expires_at: rfc3339(expires) }))
    }

    /// What an archive link's token lets its holder download.
    async fn open_archive_token(&self, a: OpenArchiveTokenArgs, sealer: Option<&g1t_secrets::Sealer>) -> Result<Option<ArchiveGrant>> {
        let Some(sealer) = sealer else {
            return Ok(None);
        };
        let Some(repo) = self.registry.by_path(&a.path).await? else {
            return Ok(None);
        };
        let Some(commit) = archive_links::open(sealer, &repo.id, &a.token, now_ms()) else {
            return Ok(None);
        };
        Ok(Some(ArchiveGrant { repo_id: repo.id, namespace: repo.namespace, name: repo.name, commit }))
    }

    async fn changed_files(&self, a: ChangedFilesArgs) -> Result<FileList> {
        let Some(git) = self.stored(&a.repo_id).await? else {
            return Ok(FileList::default());
        };
        listing::list(&git, a.base.as_deref(), &a.head, &a.skip_dirs, a.limit, false).await
    }

    /// Branches and tags with their commits, for g1t's own services.
    async fn refs_of(&self, a: RefsArgs) -> Result<Option<RepoRefs>> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await?.filter(|repo| repo.fork_of.is_none()) else {
            return Ok(None);
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let access = git.access(Scope::Read).await?;
        let refs = refs::heads_and_tags(refs::all(&access).await?)
            .into_iter()
            .map(|(name, commit)| GitRefEntry { name, commit })
            .collect();
        Ok(Some(RepoRefs { repo, refs }))
    }

    async fn raw_file(&self, a: RawFileArgs) -> Result<Option<RawFile>> {
        use base64::Engine;
        let Some(git) = self.stored(&a.repo_id).await? else {
            return Ok(None);
        };
        Ok(git
            .read_file(&a.git_ref, &a.path)
            .await?
            .filter(|bytes| bytes.len() <= a.max_bytes as usize)
            .map(|bytes| RawFile { size: bytes.len() as u64, data: base64::engine::general_purpose::STANDARD.encode(bytes) }))
    }

    async fn raw_blobs(&self, a: RawBlobsArgs) -> Result<Vec<RawBlob>> {
        use base64::Engine;
        let Some(git) = self.stored(&a.repo_id).await? else {
            return Ok(Vec::new());
        };
        let hashes: Vec<&String> = a.hashes.iter().take(MAX_READ_BLOBS).collect();
        let mut out = Vec::with_capacity(hashes.len());
        // A few at a time, as listing::read does: each is a round trip.
        for group in hashes.chunks(8) {
            let read = futures_util::future::try_join_all(group.iter().map(|hash| git.read_blob(hash))).await?;
            for (hash, bytes) in group.iter().zip(read) {
                let size = bytes.as_ref().map_or(0, |bytes| bytes.len() as u64);
                let data = bytes
                    .filter(|bytes| bytes.len() <= a.max_bytes as usize)
                    .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
                out.push(RawBlob { hash: (*hash).clone(), size, data });
            }
        }
        Ok(out)
    }

    async fn read_blobs(&self, a: ReadBlobsArgs) -> Result<Vec<BlobText>> {
        let Some(git) = self.stored(&a.repo_id).await? else {
            return Ok(Vec::new());
        };
        listing::read(&git, &a.hashes, a.max_bytes.min(MAX_TEXT_BYTES as u32)).await
    }

    async fn create(&self, a: CreateArgs) -> Result<Outcome<Repo>> {
        if !a.owner.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let name = a.name.trim().to_lowercase();
        if !is_valid_repo_name(&name) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Use letters, digits, dots, hyphens and underscores only.",
            ));
        }
        let namespace = a.namespace.trim().to_lowercase();
        if namespace.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Say which workspace to create the repository in.",
            ));
        }
        let Some(role) = a.owner.role_in(&namespace) else {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "You are not a member of that workspace.",
            ));
        };
        // Who may create which: the workspace's member privileges. A
        // workspace's own token acts as an owner would.
        let role = if a.owner.kind == PrincipalKind::Workspace { Role::Owner } else { role };
        if let Some(why) = a.owner.privileges_in(&namespace).creation_refusal(role, a.is_private, &namespace) {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        let path = RepoPath { namespace, name };
        match self.registry.by_path_any(&path).await? {
            Some((_, None)) => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "That workspace already has a repository with that name.",
                ));
            }
            Some((_, Some(_))) => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!(
                        "{}/{} was deleted recently and can still be restored, so its name is taken. Restore it, or delete it permanently from the workspace's Recently deleted list.",
                        path.namespace, path.name
                    ),
                ));
            }
            None => {}
        }
        // With a credential (a GitHub App installation's token), everything
        // is copied: every branch and tag. See copy.rs.
        let mut credentialed = None;
        if let (Some(url), Some(token)) = (a.import_url.as_deref(), a.import_token.as_deref()) {
            let Some(url) = import::clean_url(url) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "That is not an https repository address."));
            };
            let source = copy::Endpoint::github(&url, token);
            match copy::probe(&source).await? {
                Ok(advertised) => credentialed = Some((source, advertised)),
                Err(reason) => return Ok(Outcome::fail(FailureCode::Invalid, reason)),
            }
        }
        // An import is fetched before anything is created, so that an
        // address that does not work leaves nothing behind.
        let mut imported = None;
        if let Some(url) = a
            .import_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty() && credentialed.is_none())
        {
            let Some(url) = import::clean_url(url) else {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "Give the https address of a public repository, such as https://github.com/owner/repo.",
                ));
            };
            let remote = match import::discover(&url).await? {
                Ok(remote) => remote,
                Err(reason) => return Ok(Outcome::fail(FailureCode::Invalid, reason)),
            };
            imported = Some((remote, url));
        }
        let now = now_ms();
        let repo = Repo {
            id: new_id("rep", now),
            namespace: path.namespace,
            name: path.name,
            is_private: a.is_private,
            owner_id: a.owner.id.clone(),
            default_branch: imported
                .as_ref()
                .map(|(remote, _)| remote.branch.clone())
                .or_else(|| credentialed.as_ref().and_then(|(_, advertised)| advertised.default_branch()))
                .unwrap_or_else(|| "main".to_owned()),
            fork_of: None,
            parent_id: None,
            forked_from: None,
            parent: None,
            allow_forking: false,
            max_ref_updates: None,
            protected: false,
            created_at: rfc3339(now),
            topics: Vec::new(),
            website: None,
            archived_at: None,
        };
        let namespace = match self.place(&repo).await? {
            Ok(namespace) => namespace,
            Err(unplaced) => return Ok(Outcome::fail(FailureCode::Conflict, unplaced.message())),
        };
        self.registry
            .claim_store_key(&repo, namespace.as_deref(), &self.store.default_namespace())
            .await?;
        self.store
            .create(&store_key(&repo), None, &repo.default_branch)
            .await?;
        self.registry.insert(&repo).await?;
        // A repository that was transferred away from this path stops
        // redirecting here.
        self.registry
            .drop_redirect(&RepoPath {
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
            })
            .await?;
        // Every branch and tag the import made, announced as pushes.
        let mut pushed: Vec<(String, String)> = Vec::new();
        // A public repository, read with no credential: every branch and
        // tag is copied too, the default branch the one its HEAD names.
        if let Some((_, url)) = imported {
            let access = self
                .store
                .open(&store_key(&repo))
                .await?
                .access(Scope::Write)
                .await?;
            let target = copy::Endpoint::bearer(&access.remote, &access.token);
            let copied = copy::copy(&copy::Endpoint::anonymous(&url), &target,
                |bytes| self.registry.reserve_public(&repo, bytes, self.free_public_bytes)).await?;
            self.refs_moved(&repo.id).await;
            match copied {
                Ok(copied) => {
                    self.registry.finish_public(&repo, copied.pack_bytes, copied.pack_bytes).await?;
                    pushed = copy::import_pushes(&copied.updated, &repo.default_branch);
                }
                Err(reason) => {
                    self.store.delete(&store_key(&repo)).await?;
                    self.registry.remove(&repo.id).await?;
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("The repository could not be stored: {reason}"),
                    ));
                }
            }
        }
        if let Some((source, _)) = credentialed {
            let access = self
                .store
                .open(&store_key(&repo))
                .await?
                .access(Scope::Write)
                .await?;
            let target = copy::Endpoint::bearer(&access.remote, &access.token);
            let copied = copy::copy(&source, &target,
                |bytes| self.registry.reserve_public(&repo, bytes, self.free_public_bytes)).await?;
            self.refs_moved(&repo.id).await;
            match copied {
                Ok(copied) => {
                    self.registry.finish_public(&repo, copied.pack_bytes, copied.pack_bytes).await?;
                    pushed = copy::import_pushes(&copied.updated, &repo.default_branch);
                }
                Err(reason) => {
                    self.store.delete(&store_key(&repo)).await?;
                    self.registry.remove(&repo.id).await?;
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("The repository could not be copied: {reason}"),
                    ));
                }
            }
        }
        // Whoever creates a repository is an Admin of it, as a role given
        // to them on it, whatever the workspace's base permission.
        if a.owner.kind == PrincipalKind::User {
            self.grant_creator(&repo, &a.owner.id).await;
        }
        self.publish(NewEvent {
            kind: "repo.created",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor: Some(a.owner.id),
            data: RepoCreated {
                repo_id: repo.id.clone(),
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
                is_private: repo.is_private,
                parent_id: None,
            },
        })
        .await?;
        for (git_ref, head) in &pushed {
            self.publish_push(&repo, git_ref, None, head, None, None).await?;
        }
        Ok(Outcome::Ok(repo))
    }

    /// Makes `user_id` an Admin of `repo`, the repository they created.
    pub(crate) async fn grant_creator(&self, repo: &Repo, user_id: &str) {
        let Some(identity) = &self.identity else { return };
        let granted: Result<bool> = g1t_kit::call(
            identity,
            "grant_creator",
            &g1t_contracts::members::GrantCreatorArgs {
                repo_id: repo.id.clone(),
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
                user_id: user_id.to_owned(),
            },
        )
        .await;
        if let Err(error) = granted {
            worker::console_error!("creator of {} not given Admin: {error}", repo.id);
        }
    }

    /// Where a workspace keeps its data, asked of identity only when an EU
    /// namespace is configured: without one, every workspace's
    /// repositories go anywhere and identity is never asked.
    async fn residency_of(&self, workspace: &str) -> Result<shards::Residency> {
        if self.placement.eu.is_none() {
            return Ok(shards::Residency::Anywhere);
        }
        let Some(identity) = &self.identity else {
            return Ok(shards::Residency::Anywhere);
        };
        let residency: Option<g1t_contracts::identity::DataResidency> = g1t_kit::call(
            identity,
            "workspace_residency",
            &g1t_contracts::identity::SlugArgs { slug: workspace.to_owned() },
        )
        .await?;
        Ok(match residency {
            Some(g1t_contracts::identity::DataResidency::Eu) => shards::Residency::Eu,
            _ => shards::Residency::Anywhere,
        })
    }

    /// How each bound namespace stands (namespaces.rs).
    async fn standings(&self) -> Result<Vec<namespaces::Standing>> {
        let bound = self.store.namespaces();
        let default = self.store.default_namespace();
        let now = now_ms();
        let config = namespaces::Configured {
            bound: &bound,
            default: &default,
            placement: &self.placement,
            limits: &self.limits,
            on_fallback: &|namespace| self.store.on_fallback(&shards::compose(Some(namespace), "x", &default)),
            writable: &|namespace| self.store.writable(namespace),
            breaker_open: &|namespace| resilience::open_now(namespace, now),
        };
        let (held, recent) = futures_util::future::join(namespaces::held(&self.registry.db), namespaces::recent(&self.registry.db, now)).await;
        Ok(namespaces::standings(&config, &held?, &recent?))
    }

    /// The namespace a new repository goes in (shards.rs): its workspace's
    /// residency, then how each namespace stands, read only when there is
    /// a choice to make. `Ok(None)` for the default.
    async fn place(&self, repo: &Repo) -> Result<std::result::Result<Option<String>, shards::Unplaced>> {
        let residency = self.residency_of(&repo.namespace).await?;
        let bound = self.store.namespaces();
        let loads = if residency == shards::Residency::Anywhere && !self.placement.needs_loads(&bound) {
            // One namespace to choose from at most: nothing to read.
            bound
                .iter()
                .map(|namespace| shards::Load {
                    namespace: namespace.clone(),
                    bound: true,
                    writable: self.store.writable(namespace),
                    ..shards::Load::default()
                })
                .collect()
        } else {
            let default = self.store.default_namespace();
            let now = now_ms();
            let config = namespaces::Configured {
                bound: &bound,
                default: &default,
                placement: &self.placement,
                limits: &self.limits,
                on_fallback: &|namespace| self.store.on_fallback(&shards::compose(Some(namespace), "x", &default)),
                writable: &|namespace| self.store.writable(namespace),
                breaker_open: &|namespace| resilience::open_now(namespace, now),
            };
            namespaces::loads(&self.registry.db, &config, now).await?
        };
        Ok(self.placement.choose(&repo.id, residency, &loads))
    }

    /// `storage_options`: what a workspace may choose about where its
    /// repositories are kept.
    fn storage_options(&self) -> StorageOptions {
        let bound = self.store.namespaces();
        StorageOptions { eu_available: self.placement.eu_available(&bound, |namespace| self.store.writable(namespace)) }
    }

    async fn tree(&self, a: TreeArgs) -> Result<Outcome<TreeView>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.read_git(&repo).await?;
        let git_ref = a
            .git_ref
            .clone()
            .unwrap_or_else(|| repo.default_branch.clone());

        let Some(head) = git.log(&git_ref, 1).await?.into_iter().next() else {
            // An unknown ref is an error; a repo with no commits is just empty.
            if a.git_ref.is_some() {
                return Ok(Outcome::fail(
                    FailureCode::NotFound,
                    "No such branch, tag or commit.",
                ));
            }
            return Ok(Outcome::Ok(TreeView {
                repo,
                git_ref,
                path: a.tree_path,
                head: None,
                entries: Vec::new(),
                readme: None,
            }));
        };

        let no_directory = || Outcome::fail(FailureCode::NotFound, "No such directory.");
        let mut entries = git.read_tree(&head.tree_hash).await?;
        for segment in a.tree_path.split('/').filter(|segment| !segment.is_empty()) {
            let next = entries.as_ref().and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.name == segment && entry.kind == EntryKind::Tree)
            });
            let Some(next) = next else {
                return Ok(no_directory());
            };
            entries = git.read_tree(&next.hash).await?;
        }
        let Some(mut entries) = entries else {
            return Ok(no_directory());
        };
        // Directories first, then by name.
        entries.sort_by(|a, b| {
            (b.kind == EntryKind::Tree)
                .cmp(&(a.kind == EntryKind::Tree))
                .then_with(|| a.name.cmp(&b.name))
        });

        let readme_entry = entries
            .iter()
            .find(|entry| entry.kind == EntryKind::Blob && is_readme(&entry.name));
        let readme = match readme_entry {
            Some(entry) => git.read_blob(&entry.hash).await?.map(|bytes| Readme {
                name: entry.name.clone(),
                text: text_of(bytes),
            }),
            None => None,
        };
        Ok(Outcome::Ok(TreeView {
            repo,
            git_ref,
            path: a.tree_path,
            head: Some(head),
            entries,
            readme,
        }))
    }

    async fn blob(&self, a: BlobArgs) -> Result<Outcome<BlobView>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let bytes = if a.file_path.is_empty() {
            None
        } else {
            let git = self.read_git(&repo).await?;
            git.read_file(&a.git_ref, &a.file_path).await?
        };
        let Some(bytes) = bytes else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such file."));
        };
        Ok(Outcome::Ok(BlobView {
            repo,
            git_ref: a.git_ref,
            path: a.file_path,
            size: bytes.len() as u64,
            text: text_of(bytes),
        }))
    }

    async fn blame(&self, a: BlameArgs) -> Result<Outcome<Blame>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.read_git(&repo).await?;
        let git_ref = a.git_ref.unwrap_or_else(|| repo.default_branch.clone());
        // The commit the ref names, so the answer can be kept by it: a
        // blame of a commit and path never changes. Most blames are of a
        // commit already (the site links files by commit, and crawlers
        // follow those links), which needs no read.
        let head = if store::is_commit_hash(&git_ref) {
            git_ref
        } else {
            match git.log(&git_ref, 1).await?.into_iter().next() {
                Some(head) => head.hash,
                None => return Ok(not_found()),
            }
        };
        let url = blame::cache_url(&repo.id, &head, &a.file_path);
        if let Ok(Some(mut kept)) = worker::Cache::default().get(url.as_str(), false).await
            && let Ok(found) = kept.json::<Blame>().await
        {
            return Ok(Outcome::Ok(found));
        }
        let started = now_ms();
        let out_of_time = move || now_ms().saturating_sub(started) > BLAME_WALK_MS;
        let Some(blamed) = blame::blame(&git, &head, &a.file_path, &out_of_time, blame::MAX_READS).await? else {
            return Ok(not_found());
        };
        // Kept once the answer has gone.
        if let Ok(mut response) = worker::Response::from_json(&blamed.blame) {
            let _ = response.headers_mut().set("cache-control", blame::cache_control(&blamed));
            self.deferred.spawn(async move {
                let _ = worker::Cache::default().put(url.as_str(), response).await;
            });
        }
        Ok(Outcome::Ok(blamed.blame))
    }

    async fn log(&self, a: LogArgs) -> Result<Outcome<Vec<Commit>>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.read_git(&repo).await?;
        let git_ref = a.git_ref.unwrap_or_else(|| repo.default_branch.clone());
        Ok(Outcome::Ok(git.log(&git_ref, a.limit).await?))
    }

    /// The commits that changed a file or directory, newest first: the
    /// first-parent chain walked within `PATH_LOG_WALK_MS` (or the caller's
    /// budget) and `last_commits::MAX_READS`.
    async fn path_log(&self, a: g1t_contracts::repos::PathLogArgs) -> Result<Outcome<g1t_contracts::repos::PathLog>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.read_git(&repo).await?;
        let git_ref = a.git_ref.unwrap_or_else(|| repo.default_branch.clone());
        let Some(head) = git.log(&git_ref, 1).await?.into_iter().next() else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such branch, tag or commit."));
        };
        let started = worker::Date::now().as_millis();
        let budget = a.budget_ms.unwrap_or(PATH_LOG_WALK_MS);
        let out_of_time = move || worker::Date::now().as_millis().saturating_sub(started) > budget;
        let limit = a.limit.clamp(1, 100) as usize;
        let (commits, complete) = last_commits::path_log(&git, &head.hash, &a.file_path, limit, &out_of_time, last_commits::MAX_READS).await?;
        Ok(Outcome::Ok(g1t_contracts::repos::PathLog { commits, complete }))
    }

    /// Which commit last changed each entry of a directory. A finished
    /// answer is kept in this colo's cache by repository, head commit and
    /// path: a commit's history never changes, so it is good for as long as
    /// it is kept. Every walk also keeps its progress by ref and path
    /// (last_commits.rs), so the next call goes on from it: from where it
    /// stopped, or for a new head, only back to the old one.
    async fn last_commits(&self, a: g1t_contracts::repos::LastCommitsArgs) -> Result<Outcome<g1t_contracts::repos::LastCommits>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let git = self.read_git(&repo).await?;
        let git_ref = a.git_ref.unwrap_or_else(|| repo.default_branch.clone());
        let Some(head) = git.log(&git_ref, 1).await?.into_iter().next() else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such branch, tag or commit."));
        };
        // v2: v1 kept walks cut short at 300 commits as if finished.
        let key = format!(
            "https://last-commits.g1t.internal/v2/{}/{}/{}",
            repo.id,
            head.hash,
            a.tree_path.split('/').map(urlencoding_segment).collect::<Vec<_>>().join("/")
        );
        if let Ok(Some(mut kept)) = worker::Cache::default().get(key.as_str(), false).await
            && let Ok(found) = kept.json::<g1t_contracts::repos::LastCommits>().await
        {
            return Ok(Outcome::Ok(found));
        }
        let memo = last_commits::Memo::new(&repo.id, &git_ref, &a.tree_path);
        let shared = self.shared.clone();
        let progress = memo.get(shared.as_deref()).await;
        // Asked with a budget, the walk stops past it; without one, past
        // LAST_COMMITS_WALK_MS, well before the caller's waitUntil ends.
        let started = worker::Date::now().as_millis();
        let budget = a.budget_ms.unwrap_or(LAST_COMMITS_WALK_MS);
        let out_of_time = move || worker::Date::now().as_millis().saturating_sub(started) > budget;
        let walk = last_commits::last_commits(&git, &head.hash, &a.tree_path, progress, &out_of_time, last_commits::MAX_READS).await?;
        let settled = walk.progress.settled();
        // What the walk found is kept once the answer has gone: the caller
        // waits on neither write.
        if walk.reads > 0 {
            let progress = walk.progress.clone();
            self.deferred.spawn(async move { memo.keep(shared.as_deref(), &progress).await });
        }
        let found = g1t_contracts::repos::LastCommits { complete: walk.progress.complete(), entries: walk.progress.found };
        if settled && let Ok(mut response) = worker::Response::from_json(&found) {
            let _ = response.headers_mut().set("cache-control", "max-age=604800");
            self.deferred.spawn(async move {
                let _ = worker::Cache::default().put(key.as_str(), response).await;
            });
        }
        Ok(Outcome::Ok(found))
    }

    /// How far each branch head has moved from the default branch's head,
    /// in one call (drift.rs). Each count is kept in this colo's cache by
    /// repository and the pair of hashes, for good: neither history can
    /// change. A head that moved is the only one walked. A failed read is
    /// not kept, and "too far to count" only for a day.
    async fn branch_drift(&self, a: BranchDriftArgs) -> Result<Outcome<BranchDrifts>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        if !store::is_commit_hash(&a.base) {
            return Ok(Outcome::fail(FailureCode::Invalid, "The default branch's head is a full commit hash."));
        }
        let heads: Vec<String> = a.heads.into_iter().take(MAX_DRIFT_HEADS).collect();
        let git = self.read_git(&repo).await?;
        // v2: answers kept before 2026-10-09 said "no count" for every
        // branch whose default branch took a merge since it left (drift.rs).
        let key = |head: &str| format!("https://drift.g1t.internal/v2/{}/{}/{head}", repo.id, a.base);
        let cache = worker::Cache::default();
        let (base, kept) = futures_util::future::join(
            git.log(&a.base, 1),
            futures_util::future::join_all(heads.iter().map(|head| {
                let (cache, url) = (&cache, key(head));
                async move {
                    if !store::is_commit_hash(head) {
                        return None;
                    }
                    let mut found = cache.get(url.as_str(), false).await.ok()??;
                    found.json::<BranchDrift>().await.ok()
                }
            })),
        )
        .await;
        let missing: Vec<String> = heads
            .iter()
            .zip(&kept)
            .filter(|(head, kept)| kept.is_none() && store::is_commit_hash(head))
            .map(|(head, _)| head.clone())
            .collect();
        let measured = drift::measure(&git, &a.base, &missing).await;
        let mut fresh: HashMap<String, BranchDrift> = HashMap::new();
        for (head, found) in missing.into_iter().zip(measured) {
            let answer = BranchDrift { head: head.clone(), commit: found.commit, drift: found.drift };
            if found.settled
                && let Ok(mut response) = worker::Response::from_json(&answer)
            {
                // A count is kept for good; "too far to count" for a day, so
                // a change to how far a walk goes reaches it.
                let max_age = if answer.drift.is_some() { "public, max-age=31536000, immutable" } else { "public, max-age=86400" };
                let _ = response.headers_mut().set("cache-control", max_age);
                let _ = cache.put(key(&head).as_str(), response).await;
            }
            fresh.insert(head, answer);
        }
        let branches = heads
            .iter()
            .zip(kept)
            .map(|(head, kept)| {
                kept.or_else(|| fresh.get(head).cloned())
                    .unwrap_or_else(|| BranchDrift { head: head.clone(), commit: None, drift: None })
            })
            .collect();
        Ok(Outcome::Ok(BranchDrifts { base: base.ok().and_then(|log| log.into_iter().next()), branches }))
    }

    /// The repository's tags, newest commit first, at most 100.
    async fn tags(&self, a: g1t_contracts::repos::TagsArgs) -> Result<Outcome<Vec<g1t_contracts::repos::Tag>>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        // Kept until the refs move, as the branch list is (store.rs): listing
        // the refs is a round trip to the store on every call otherwise.
        let version = refs_cache::usable(registry::refs_state(&repo.id), now_ms()).filter(|_| !self.store.on_fallback(&store_key(&repo)));
        let kept_at = version.map(|version| format!("https://tags.g1t.internal/{}/{version}", repo.id));
        if let Some(url) = &kept_at
            && let Ok(Some(mut kept)) = worker::Cache::default().get(url.as_str(), false).await
            && let Ok(tags) = kept.json::<Vec<g1t_contracts::repos::Tag>>().await
        {
            return Ok(Outcome::Ok(tags));
        }
        let (tags, complete) = self.read_tags(&repo).await?;
        if complete
            && let Some(url) = &kept_at
            && let Ok(mut response) = worker::Response::from_json(&tags)
        {
            let _ = response.headers_mut().set("cache-control", "public, max-age=300");
            let _ = worker::Cache::default().put(url.as_str(), response).await;
        }
        Ok(Outcome::Ok(tags))
    }

    /// The tags, and whether every one's commit was read (only then kept).
    async fn read_tags(&self, repo: &Repo) -> Result<(Vec<g1t_contracts::repos::Tag>, bool)> {
        let git = self.store.open(&store_key(repo)).await?;
        let access = git.access(Scope::Read).await?;
        let named: Vec<(String, String)> = refs::heads_and_tags(refs::all(&access).await?)
            .into_iter()
            .filter_map(|(name, hash)| name.strip_prefix("refs/tags/").map(|tag| (tag.to_owned(), hash)))
            .collect();
        let read = self.read_git(repo).await?;
        let commits = futures_util::future::join_all(named.iter().take(MAX_TAGS_READ).map(|(_, hash)| read.log(hash, 1))).await;
        let complete = commits.iter().all(Result::is_ok);
        let mut tags: Vec<g1t_contracts::repos::Tag> = named
            .into_iter()
            .zip(commits.into_iter().map(|found| found.ok().and_then(|list| list.into_iter().next())).chain(std::iter::repeat(None)))
            .map(|((name, _), commit)| g1t_contracts::repos::Tag { name, commit })
            .collect();
        tags.sort_by(|a, b| {
            let at = |tag: &g1t_contracts::repos::Tag| tag.commit.as_ref().map(|c| c.authored_at.clone()).unwrap_or_default();
            at(b).cmp(&at(a)).then_with(|| b.name.cmp(&a.name))
        });
        tags.truncate(MAX_TAGS_READ);
        Ok((tags, complete))
    }

    /// The repository's branches, default branch first.
    async fn branches(&self, a: BranchesArgs) -> Result<Outcome<Vec<Branch>>> {
        let Some(repo) = self.readable(&a.path, &a.viewer).await? else {
            return Ok(not_found());
        };
        let mut branches = self.read_git(&repo).await?.branches().await?;
        branches.sort_by_key(|branch| branch.name != repo.default_branch);
        Ok(Outcome::Ok(branches))
    }

    /// Whether `source` is a fork of `ancestor_id`: its parent, or its
    /// parent's, and so on, at most [`MAX_FORK_DEPTH`] repositories up. A
    /// detached fork still counts as one of what it was made from
    /// (`forked_from`), so pull requests opened from it still merge.
    pub(crate) async fn forked_from(&self, source: &Repo, ancestor_id: &str) -> Result<bool> {
        let up = |repo: &Repo| repo.parent_id.clone().or_else(|| repo.forked_from.clone());
        let mut parent = up(source);
        for _ in 0..MAX_FORK_DEPTH {
            let Some(id) = parent else {
                return Ok(false);
            };
            if id == ancestor_id {
                return Ok(true);
            }
            parent = self.registry.by_id(&id).await?.and_then(|repo| up(&repo));
        }
        Ok(false)
    }

    /// The repository a pull request whose change is in `source` merges
    /// into. `target_id`, when given and not `source` itself, must be the
    /// repository a working copy was made from or one `source` is a fork of
    /// ([`forked_from`](Self::forked_from)); otherwise none. Without it, a
    /// working copy merges into the repository it was made from, and a
    /// branch into its own.
    pub(crate) async fn pull_target(&self, source: &Repo, target_id: Option<&str>) -> Result<Option<Repo>> {
        match target_id.filter(|id| *id != source.id) {
            Some(id) if source.fork_of.as_deref() == Some(id) || self.forked_from(source, id).await? => {
                self.registry.by_id(id).await
            }
            Some(_) => Ok(None),
            None => match &source.fork_of {
                Some(id) => self.registry.by_id(id).await,
                None => Ok(Some(source.clone())),
            },
        }
    }

    /// Whether a pull request's source lacks commits that the branch it
    /// would merge into has.
    async fn behind(&self, a: BehindArgs) -> Result<bool> {
        let Some(source) = self.registry.by_id(&a.source_id).await? else {
            return Ok(false);
        };
        let target = self.pull_target(&source, a.target_id.as_deref()).await?;
        let Some(target) = target else {
            return Ok(false);
        };
        let branch = a.branch.unwrap_or_else(|| target.default_branch.clone());
        let target_branch = a.target_branch.unwrap_or_else(|| target.default_branch.clone());
        let target_head = self
            .read_git(&target)
            .await?
            .log(&target_branch, 1)
            .await?
            .into_iter()
            .next()
            .map(|commit| commit.hash);
        let Some(target_head) = target_head else {
            return Ok(false);
        };
        let source_git = self.read_git(&source).await?;
        let history = source_git.log(&branch, MAX_ANCESTRY).await?;
        if history.is_empty() {
            return Ok(false);
        }
        Ok(!descends_from(&source_git, &history, &target_head).await?)
    }

    /// The files a pull request's source and the default branch it would
    /// merge into each changed since they last agreed. Where the two lists
    /// share no file, the merge cannot conflict; where they do, it may.
    async fn divergence(&self, a: BehindArgs) -> Result<Option<Divergence>> {
        let Some(source) = self.registry.by_id(&a.source_id).await? else {
            return Ok(None);
        };
        let target = self.pull_target(&source, a.target_id.as_deref()).await?;
        let Some(target) = target else {
            return Ok(None);
        };
        let branch = a.branch.unwrap_or_else(|| target.default_branch.clone());
        let target_branch = a.target_branch.unwrap_or_else(|| target.default_branch.clone());
        let source_git = self.read_git(&source).await?;
        let target_git = self.read_git(&target).await?;
        // The target's side is the same for every pull request into it, and
        // worked out once per head (coalesce.rs).
        let (history, side) = futures_util::future::try_join(
            source_git.log(&branch, MAX_ANCESTRY),
            self.target_side(&target, &target_git, &target_branch),
        )
        .await?;
        let target_history = &side.history;
        let (Some(head), Some(base)) = (history.first(), target_history.first()) else {
            return Ok(None);
        };
        let behind = !descends_from(&source_git, &history, &base.hash).await?;
        let merge_base = nearest_ancestor_in(&source_git, &history, &side.shared).await?;
        let mut divergence = Divergence {
            head: head.hash.clone(),
            base: base.hash.clone(),
            merge_base: merge_base.clone(),
            behind,
            ..Divergence::default()
        };
        let merge_base_tree = match &merge_base {
            Some(hash) => target_history
                .iter()
                .find(|commit| commit.hash == *hash)
                .map(|commit| commit.tree_hash.clone()),
            None => None,
        };
        let Some(merge_base_tree) = merge_base_tree else {
            // No common history to compare from: say nothing is known.
            divergence.truncated = true;
            return Ok(Some(divergence));
        };
        let (ours, truncated_ours) =
            diff::changed_paths(&source_git, Some(&merge_base_tree), &head.tree_hash).await?;
        divergence.ours = ours;
        divergence.truncated = truncated_ours;
        if behind {
            let now = now_ms();
            let key = (target.id.clone(), merge_base_tree.clone(), base.tree_hash.clone());
            let (theirs, truncated_theirs) = match THEIRS.with(|memo| memo.borrow().get(&key, now)) {
                Some(kept) => kept,
                None => {
                    let found = diff::changed_paths(&target_git, Some(&merge_base_tree), &base.tree_hash).await?;
                    THEIRS.with(|memo| memo.borrow_mut().put(key, found.clone(), now));
                    found
                }
            };
            divergence.theirs = theirs;
            divergence.truncated |= truncated_theirs;
        }
        Ok(Some(divergence))
    }

    /// A target branch's history from its head, worked out once per head
    /// for every pull request asking about it (coalesce.rs). The head is
    /// read under the refs version; the history by its hash, which the
    /// object cache keeps for good.
    async fn target_side<R: GitRepo>(&self, target: &Repo, git: &R, branch: &str) -> Result<Rc<coalesce::TargetSide>> {
        let now = now_ms();
        let key = refs_cache::usable(registry::refs_state(&target.id), now)
            .map(|version| (target.id.clone(), branch.to_owned(), version));
        if let Some(key) = &key
            && let Some(side) = TARGETS.with(|memo| memo.borrow().get(key, now))
        {
            return Ok(side);
        }
        let history = match git.log(branch, 1).await?.first() {
            Some(head) => git.log(&head.hash, MAX_ANCESTRY).await?,
            None => Vec::new(),
        };
        let side = coalesce::TargetSide::new(history);
        if let Some(key) = key {
            TARGETS.with(|memo| memo.borrow_mut().put(key, side.clone(), now));
        }
        Ok(side)
    }

    async fn head(&self, a: HeadArgs) -> Result<Option<String>> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(None);
        };
        let branch = if a.branch.is_empty() { &repo.default_branch } else { &a.branch };
        let git = self.read_git(&repo).await?;
        Ok(git
            .log(branch, 1)
            .await?
            .into_iter()
            .next()
            .map(|commit| commit.hash))
    }

    async fn delete_branch(&self, a: DeleteBranchArgs) -> Result<Outcome<bool>> {
        if !deletable_branch(&a.branch, a.head.as_deref()) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only branches g1t made for itself can be deleted this way.",
            ));
        }
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(not_found());
        };
        if a.branch == repo.default_branch {
            return Ok(Outcome::fail(FailureCode::Forbidden, "The default branch is never deleted."));
        }
        let repo = match self.unpaused(repo).await? {
            Ok(repo) => repo,
            Err((code, message)) => return Ok(Outcome::fail(code, message)),
        };
        self.live(&repo).await?;
        let git = self.store.open(&store_key(&repo)).await?;
        let Some(old) = git
            .branches()
            .await?
            .into_iter()
            .find(|branch| branch.name == a.branch)
            .map(|branch| branch.hash)
        else {
            return Ok(Outcome::Ok(false));
        };
        // Moved since the caller looked: someone else's commits are on it.
        if a.head.as_deref().is_some_and(|head| head != old) {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{} moved, so it was left alone.", a.branch)));
        }
        let access = git.access(Scope::Write).await?;
        let deleted = land::delete_ref(&access, &a.branch, &old).await?;
        self.refs_moved(&repo.id).await;
        if let Err(reason) = deleted {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{} could not be deleted: {reason}", a.branch),
            ));
        }
        Ok(Outcome::Ok(true))
    }

    async fn fork_for_pull(&self, a: ForkArgs) -> Result<Outcome<Repo>> {
        let viewer = Some(a.actor.clone());
        let Some(source) = self
            .registry
            .by_id(&a.source_id)
            .await?
            .filter(|repo| can_read(repo, &viewer))
        else {
            return Ok(not_found());
        };
        if let Some((code, message)) = lifecycle::read_only_refusal(&source) {
            return Ok(Outcome::fail(code, message));
        }
        // Its working copy is made in its namespace: not while it moves.
        let source = match self.unpaused(source).await? {
            Ok(source) => source,
            Err((code, message)) => return Ok(Outcome::fail(code, message)),
        };
        let now = now_ms();
        let fork = Repo {
            id: new_id("rep", now),
            namespace: PULLS_NAMESPACE.to_owned(),
            name: a.pull_id.clone(),
            // A fork is exactly as visible as the repo it came from.
            is_private: source.is_private,
            owner_id: a.actor.id.clone(),
            default_branch: source.default_branch.clone(),
            fork_of: Some(source.id.clone()),
            parent_id: None,
            forked_from: None,
            parent: None,
            allow_forking: false,
            max_ref_updates: None,
            protected: false,
            created_at: rfc3339(now),
            topics: Vec::new(),
            website: None,
            archived_at: None,
        };
        // Artifacts forks within a namespace: the copy goes where its
        // repository is.
        let (namespace, _) = store::locate(&store_key(&source));
        self.registry
            .claim_store_key(&fork, Some(&namespace), &self.store.default_namespace())
            .await?;
        self.store
            .open(&store_key(&source))
            .await?
            .fork(&store_key(&fork), true)
            .await?;
        self.registry.insert(&fork).await?;
        self.publish(NewEvent {
            kind: "repo.forked",
            source: SOURCE,
            repo_id: Some(source.id.clone()),
            actor: Some(a.actor.id),
            data: RepoForked {
                repo_id: fork.id.clone(),
                source_repo_id: source.id,
                pull_id: Some(a.pull_id),
            },
        })
        .await?;
        Ok(Outcome::Ok(fork))
    }

    async fn git_access(&self, a: GitAccessArgs) -> Result<Outcome<GitAccess>> {
        let found = self.registry.by_path(&a.path).await?;
        Ok(match self.authorize_git(&a.path, &a.viewer, a.service, found).await? {
            Outcome::Ok(repo) => {
                self.live(&repo).await?;
                let write = a.service == GitService::ReceivePack;
                if write {
                    return Ok(Outcome::fail(FailureCode::Forbidden,
                        "Push through g1t's HTTPS remote so the public storage limit can be enforced."));
                }
                if write {
                    // A push with this credential would not pass through
                    // here, so nothing that lists the refs is kept until it
                    // has expired (see refs_cache.rs).
                    let until = now_ms() + store::CREDENTIAL_LIFE_MS + 60_000;
                    if let Err(error) = self.registry.refs_open(&repo.id, until).await {
                        // Before the column exists nothing is kept anyway.
                        if registry::refs_state(&repo.id).is_some() {
                            return Err(error);
                        }
                    }
                }
                let scope = if write { Scope::Write } else { Scope::Read };
                Outcome::Ok(self.store.handout(&store_key(&repo), scope).await?)
            }
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    /// The repository at `path` (`found`, as just read), if the viewer may
    /// use `service` on it: fetch from it, or push to it. A push to a path
    /// with nothing there makes the repository, in a workspace the pusher
    /// belongs to.
    async fn authorize_git(
        &self,
        path: &RepoPath,
        viewer: &Viewer,
        service: GitService,
        found: Option<Repo>,
    ) -> Result<Outcome<Repo>> {
        let mut a = GitAccessArgs {
            path: path.clone(),
            viewer: viewer.clone(),
            service,
        };
        let write = a.service == GitService::ReceivePack;
        // An access token: pushing needs code:write, reading a private
        // repository code:read. A public repository reads as it would for
        // anyone. Which repositories a token reaches is its owner's, checked
        // below as for anyone.
        if let Some(access) = a.viewer.as_ref().and_then(|user| user.token.as_deref()).cloned() {
            // A workflow job's token, and a deploy key, reach their own
            // repository only; a job's also the working copies of that
            // repository's pull requests, where their heads are.
            let name = format!("{}/{}", path.namespace, path.name);
            let source = match found.as_ref().and_then(|repo| repo.fork_of.as_deref()) {
                Some(source_id) if g1t_contracts::scopes::decide_repo(&access, &name).is_some() => self
                    .registry
                    .by_id(source_id)
                    .await?
                    .map(|source| format!("{}/{}", source.namespace, source.name)),
                _ => None,
            };
            let public = found.as_ref().is_some_and(|repo| !repo.is_private);
            if let Some(why) = git_token_refusal(&access, &name, source.as_deref(), write, public, found.is_some()) {
                return Ok(Outcome::fail(FailureCode::Forbidden, format!("{why}\n")));
            }
            if !write && !access.allows(g1t_contracts::scopes::Scope::CodeRead) {
                a.viewer = None;
            }
        }

        // Anonymous callers are asked to authenticate whether or not the repo
        // exists, so private repos cannot be told apart from missing ones.
        let denied = || match &a.viewer {
            Some(_) => not_found(),
            None => Outcome::fail(FailureCode::Unauthenticated, "Authentication required."),
        };
        // A run's token works through the API only: its sandbox has its
        // own way to push, to its own pull request.
        if a.viewer.as_ref().is_some_and(|user| user.kind == PrincipalKind::Agent) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "A run's token cannot be used with git this way.",
            ));
        }
        if let (true, Some(user)) = (write, &a.viewer)
            && !user.verified
        {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let repo = match found {
            Some(repo) => {
                let allowed = if write {
                    can_write(&repo, &a.viewer)
                } else {
                    self.may_read(&repo, &a.viewer).await?
                };
                if !allowed {
                    return Ok(denied());
                }
                // An archived repository, or a pull request's copy of one,
                // is read-only.
                if write {
                    let archived = match &repo.fork_of {
                        Some(source) => self.registry.by_id(source).await?,
                        None => Some(repo.clone()),
                    };
                    match archived {
                        Some(source) => {
                            if let Some((code, message)) = lifecycle::read_only_refusal(&source) {
                                return Ok(Outcome::fail(code, format!("{message}\n")));
                            }
                        }
                        // The repository it was copied from is deleted.
                        None => return Ok(denied()),
                    }
                }
                repo
            }
            None => {
                // Push to create, in a workspace the pusher belongs to.
                let owner = a
                    .viewer
                    .as_ref()
                    .filter(|user| write && user.is_member(&a.path.namespace.to_lowercase()));
                let Some(owner) = owner else {
                    return Ok(denied());
                };
                let created = self.create(push_to_create(owner, &a.path)).await?;
                match created {
                    Outcome::Ok(repo) => repo,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                }
            }
        };
        // A push, or a credential to push with, waits while the repository
        // moves between namespaces (moves.rs), and goes to where it is now.
        if write {
            return Ok(match self.unpaused(repo).await? {
                Ok(repo) => Outcome::Ok(repo),
                Err((code, message)) => Outcome::fail(code, format!("{message}\n")),
            });
        }
        Ok(Outcome::Ok(repo))
    }

    async fn land(&self, a: LandArgs) -> Result<Outcome<Landed>> {
        let actor: Viewer = Some(a.actor.clone());
        let Some(source) = self.registry.by_id(&a.source_id).await? else {
            return Ok(not_found());
        };
        // A working copy lands on the repository it came from, a fork's
        // branch on the repository named, and a branch on its own.
        let target = self.pull_target(&source, a.target_id.as_deref()).await?;
        let Some(target) = target.filter(|repo| can_read(repo, &actor)) else {
            return Ok(not_found());
        };
        if !registry::can(&target, &actor, Capability::Merge) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                access::needs(Capability::Merge, &format!("{}/{}", target.namespace, target.name)),
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        if let Some((code, message)) = lifecycle::read_only_refusal(&target) {
            return Ok(Outcome::fail(code, message));
        }
        // Moving between namespaces: wait for it (moves.rs). Both are read
        // again once it is done, for their new keys.
        let (source, target) = match (self.unpaused(source).await?, self.unpaused(target).await?) {
            (Ok(source), Ok(target)) => (source, target),
            (Err((code, message)), _) | (_, Err((code, message))) => return Ok(Outcome::fail(code, message)),
        };

        let branch = &a.target_branch.clone().unwrap_or_else(|| target.default_branch.clone());
        let from_fork = source.id != target.id;
        let source_branch = match a.branch.clone() {
            Some(name) if !from_fork && name == *branch => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("{branch} cannot be merged into itself."),
                ));
            }
            Some(name) => name,
            // A working copy holds the change on the branch it merges into.
            None if source.fork_of.is_some() => branch.clone(),
            None => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "Say which branch to merge.",
                ));
            }
        };

        self.live(&source).await?;
        let source_git = self.store.open(&store_key(&source)).await?;
        let target_git = self.store.open(&store_key(&target)).await?;
        let history = source_git.log(&source_branch, MAX_ANCESTRY).await?;
        let Some(new) = history.first().map(|commit| commit.hash.clone()) else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request has no commits to merge.",
            ));
        };
        let Some(new) = land::checked_commit(&new, a.expected_commit.as_deref()) else {
            return Ok(Outcome::fail(FailureCode::Conflict, "The source branch changed after it was checked. Test it again before landing."));
        };
        // Every method but fast-forward makes commits (merge_methods.rs).
        let method = a.method.unwrap_or(g1t_contracts::rules::MergeMethod::FastForward);
        if method != g1t_contracts::rules::MergeMethod::FastForward {
            return self.land_by(method, &a, &target, &source_git, &target_git, branch, &history, new, from_fork).await;
        }
        let old = target_git
            .log(branch, 1)
            .await?
            .into_iter()
            .next()
            .map(|commit| commit.hash);

        if old.as_deref() == Some(new.as_str()) {
            return Ok(Outcome::Ok(Landed {
                commit: new,
                previous: None,
                method,
                rebased: Vec::new(),
            }));
        }
        if a.expected_commit.is_some() && old.is_some() {
            // A prior attempt may have published this exact commit and stopped
            // before recording the merge; another change can already follow it.
            let target_history = target_git.log(branch, MAX_ANCESTRY).await?;
            if descends_from(&target_git, &target_history, &new).await? {
                return Ok(Outcome::Ok(Landed { commit: new, previous: None, method, rebased: Vec::new() }));
            }
        }
        // Moving the branch to a commit that does not descend from its
        // current head would discard whatever landed in between.
        if let Some(old) = &old
            && !descends_from(&source_git, &history, old).await?
        {
            let remedy = if from_fork {
                format!("Pull {branch} into the pull request's fork, push, and merge again.")
            } else {
                format!("Merge {branch} into {source_branch}, push, and merge again.")
            };
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{branch} has moved since this pull request was opened. {remedy}"),
            ));
        }

        // For a branch the objects are already in the target; sending them
        // again is harmless and keeps one way of moving a ref.
        let source_access = source_git.access(Scope::Read).await?;
        let target_access = target_git.access(Scope::Write).await?;
        let pushed =
            land::fast_forward(&source_access, &target_access, branch, old.as_deref(), &new, self.public_quota(&target))
                .await?;
        self.refs_moved(&target.id).await;
        if let Err(reason) = pushed {
            // Most often another pull request landed between the check and the push.
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{branch} could not be updated: {reason}"),
            ));
        }
        self.publish_landing(&target, branch, old.as_deref(), &new, &a, None).await?;
        Ok(Outcome::Ok(Landed {
            commit: new,
            previous: old,
            method,
            rebased: Vec::new(),
        }))
    }

    async fn compare(&self, a: CompareArgs) -> Result<Outcome<Comparison>> {
        let found = self.registry.by_id(&a.repo_id).await?;
        let repo = match self.visible(found.clone(), &a.viewer).await? {
            Some(repo) => Some(repo),
            // A pull request from a private fork is reviewed by those who
            // read the repository it merges into, whether or not they can
            // read the fork: its head, a commit that repository holds as
            // well (`refs/pull/<n>/head`), compared with it, from a base it
            // holds. Nothing else of the fork is read this way.
            None => match (found, a.target_id.as_deref(), a.head.as_deref()) {
                (Some(fork), Some(target_id), Some(head))
                    if is_commit_hash(head) && a.base.as_deref().is_none_or(is_commit_hash) =>
                {
                    match self.visible(self.registry.by_id(target_id).await?, &a.viewer).await? {
                        Some(target) if self.forked_from(&fork, target_id).await? => {
                            let target_git = self.read_git(&target).await?;
                            let mut held = !target_git.log(head, 1).await?.is_empty();
                            if let Some(base) = a.base.as_deref() {
                                held = held && !target_git.log(base, 1).await?.is_empty();
                            }
                            held.then_some(fork)
                        }
                        _ => None,
                    }
                }
                _ => None,
            },
        };
        let Some(repo) = repo else {
            return Ok(not_found());
        };
        let git = self.read_git(&repo).await?;
        let head_ref = a.head.as_deref().unwrap_or(&repo.default_branch);
        // A pull request into another branch is compared from where it
        // left that branch.
        let base_branch = a.base_branch.clone();
        // The head's history is only searched when the base is worked out
        // from another branch.
        let depth = if a.base.is_some() || is_commit_hash(head_ref) { 1 } else { MAX_ANCESTRY };
        let history = git.log(head_ref, depth).await?;
        let Some(head) = history.first() else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "There are no commits to compare.",
            ));
        };

        // Where the head's history meets the default branch of `against`,
        // or the branch asked for.
        let shared_with = async |against: &Repo| -> Result<Option<String>> {
            let against_git = self.read_git(against).await?;
            let branch = base_branch.as_deref().unwrap_or(&against.default_branch);
            let shared: HashSet<String> = against_git
                .log(branch, MAX_ANCESTRY)
                .await?
                .into_iter()
                .map(|commit| commit.hash)
                .collect();
            nearest_ancestor_in(&git, &history, &shared).await
        };
        // A fork's branch, compared from the repository it would merge into.
        let target = match a.target_id.as_deref().filter(|id| a.base.is_none() && *id != repo.id) {
            Some(id) if self.forked_from(&repo, id).await? => {
                match self.visible(self.registry.by_id(id).await?, &a.viewer).await? {
                    Some(target) => Some(target),
                    None => return Ok(not_found()),
                }
            }
            Some(_) => return Ok(not_found()),
            None => None,
        };
        let base = match (a.base, &repo.fork_of) {
            (Some(base), _) => Some(base),
            (None, _) if let Some(target) = &target => shared_with(target).await?,
            // A fork is compared with the last commit it shares with the
            // repository it came from.
            (None, Some(target_id)) => match self.registry.by_id(target_id).await? {
                Some(target) => shared_with(&target).await?,
                None => None,
            },
            // A branch, with the point where it left the default branch.
            // A single commit, with its first parent.
            (None, None) if is_commit_hash(head_ref) => head.parents.first().cloned(),
            (None, None) if head_ref != base_branch.as_deref().unwrap_or(&repo.default_branch) => {
                shared_with(&repo).await?
            }
            (None, None) => head.parents.first().cloned(),
        };
        let base_tree = match &base {
            Some(base) => git
                .log(base, 1)
                .await?
                .into_iter()
                .next()
                .map(|commit| commit.tree_hash),
            None => None,
        };
        // Only a few files of it, when asked: how the files a large
        // comparison lists without their lines are read, as a page reaches them.
        let only = a.paths.as_deref().map(|paths| &paths[..paths.len().min(MAX_COMPARED_PATHS)]);
        let (files, truncated) =
            diff::compare_trees(&git, base_tree.as_deref(), &head.tree_hash, only).await?;
        Ok(Outcome::Ok(Comparison {
            base,
            head: head.hash.clone(),
            files,
            truncated,
        }))
    }

    /// Reports that `git_ref` of `repo` (a full ref) now points to `after`,
    /// moved by `actor` (marked when that was a workflow job's token).
    /// `commits` is how many the move brought, when the caller knows: one
    /// for a file committed on the site or a branch brought up to date.
    async fn publish_push(
        &self,
        repo: &Repo,
        git_ref: &str,
        before: Option<&str>,
        after: &str,
        actor: Option<&User>,
        commits: Option<u32>,
    ) -> Result<()> {
        let caused_by_job = actor.and_then(g1t_contracts::events::job_run_of).map(str::to_owned);
        let agent = actor.and_then(acting_agent);
        self.publish_git_push(repo, git_ref, before, after, actor.map(|user| user.id.clone()), false, caused_by_job, commits, None, agent)
            .await
    }

    /// [`Repos::publish_push`] for a branch moved by landing a pull
    /// request, naming the one landed (`LandArgs::pull`).
    pub(crate) async fn publish_landing(
        &self,
        repo: &Repo,
        branch: &str,
        before: Option<&str>,
        after: &str,
        a: &LandArgs,
        commits: Option<u32>,
    ) -> Result<()> {
        let caused_by_job = g1t_contracts::events::job_run_of(&a.actor).map(str::to_owned);
        self.publish_git_push(
            repo,
            &format!("refs/heads/{branch}"),
            before,
            after,
            Some(a.actor.id.clone()),
            false,
            caused_by_job,
            commits,
            a.pull,
            acting_agent(&a.actor),
        )
        .await
    }

    /// `publish_push`, saying whether the push reached the store without
    /// being scanned for secrets first.
    #[allow(clippy::too_many_arguments)]
    async fn publish_git_push(
        &self,
        repo: &Repo,
        git_ref: &str,
        before: Option<&str>,
        after: &str,
        actor: Option<String>,
        unscanned: bool,
        caused_by_job: Option<String>,
        commits: Option<u32>,
        landed_pull: Option<u32>,
        agent: Option<String>,
    ) -> Result<()> {
        self.publish(NewEvent {
            kind: "git.push",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor,
            data: GitPush {
                repo_id: repo.id.clone(),
                git_ref: git_ref.to_owned(),
                before: before.map(str::to_owned),
                after: after.to_owned(),
                default_branch: git_ref.strip_prefix("refs/heads/")
                    == Some(repo.default_branch.as_str()),
                unscanned,
                caused_by_job,
                commits,
                landed_pull,
                agent,
            },
        })
        .await
    }

    /// Git over HTTPS. Only what decides the answer happens before it:
    /// the repository, who is asking and whether they may, the free
    /// workspace limits, push protection, and the store's own answer. The
    /// audit entry and what a push changed are recorded once git has its
    /// answer. Each answer says how long its steps took (`Server-Timing`).
    async fn git_http(&self, request: Request, env: &Env, ctx: &Context) -> Result<Response> {
        let mut timing = git_http::Timing::start();
        let Some(git) = git_http::parse(&request.url()?) else {
            return Response::error("Not found", 404);
        };
        let response = match self.answer_git(request, &git, env, ctx, &mut timing).await {
            Ok(response) => response,
            // The git store is busy: git hears when to try again.
            Err(error) => match resilience::busy(&error.to_string()) {
                Some(busy) => git_http::busy_response(busy)?,
                None => return Err(error),
            },
        };
        timing.apply(response)
    }

    async fn answer_git(
        &self,
        request: Request,
        git: &git_http::GitRequest,
        env: &Env,
        ctx: &Context,
        timing: &mut git_http::Timing,
    ) -> Result<Response> {
        let write = git.service == GitService::ReceivePack;
        let get = request.method() == Method::Get;
        let identity = env.service("IDENTITY")?;
        // The repository and the caller's credentials, at once. A fetch may
        // go by the row as read a moment ago, for the same clone's next
        // request; a push always reads it. Anonymous callers cost nothing.
        let lookup = async {
            if write {
                self.registry.by_path(&git.path).await
            } else {
                self.registry.by_path_recent(&git.path).await
            }
        };
        let (found, viewer) =
            futures_util::future::join(lookup, git_http::viewer(&request, &identity)).await;
        let mut found = found?;
        timing.mark("repo");
        // A workspace alias staff set (identity's aliases.rs: `g1t` for
        // `flagon-io`) is answered in place, as the repository under the
        // workspace's slug: pushes and some clients do not follow
        // redirects. Everything after this sees only the workspace's slug.
        let aliased = match found {
            Some(_) => None,
            None => git_http::aliased(git, &identity).await?,
        };
        if let Some(aliased) = &aliased {
            found = if write {
                self.registry.by_path(&aliased.path).await?
            } else {
                self.registry.by_path_recent(&aliased.path).await?
            };
            timing.mark("alias");
        }
        let git = aliased.as_ref().unwrap_or(git);
        if found.is_none() {
            // A workspace that was renamed: git follows a redirect when it
            // first asks for refs, and uses the new address from then on.
            // A repository transferred to another workspace: the same, to
            // its new path. Fetches and pushes both follow either.
            let url = request.url()?;
            let (renamed, moved) = futures_util::future::join(
                git_http::renamed(&url, &identity),
                self.registry.resolve_moved(&git.path),
            )
            .await;
            timing.mark("moved");
            if let Some(location) = renamed? {
                return git_http::moved(&location, get);
            }
            if let Some(now) = moved?
                && let Some(location) = git_http::transferred(&url, &now)
            {
                return git_http::moved(&location, get);
            }
        }
        let viewer = viewer?;
        // A person who has not confirmed their email address can do
        // nothing with git until they do: told so, not asked to sign in.
        if viewer.as_ref().is_some_and(g1t_contracts::User::awaits_confirmation) {
            let site = request.url()?.origin().ascii_serialization();
            return git_http::refuse(Outcome::<()>::fail(
                FailureCode::Forbidden,
                g1t_contracts::accounts::confirm_email_first(&site),
            ));
        }
        // A run credential is checked against its grants, then acts as the
        // person it works for. See run_access.rs.
        let (request, viewer, audit) = match self.admit_git(request, git, viewer, found.as_ref()).await? {
            run_access::Admitted::Go { request, viewer, entry } => (request, viewer, entry),
            run_access::Admitted::Refused(response) => return Ok(response),
        };
        let mut after = AfterGit {
            audit,
            status: 0,
            message: None,
            push: None,
        };
        let repo = match self.authorize_git(&git.path, &viewer, git.service, found).await? {
            Outcome::Ok(repo) => repo,
            refused => {
                let why = match &refused {
                    Outcome::Fail(failure) => Some(failure.message.trim_end().to_owned()),
                    Outcome::Ok(_) => None,
                };
                let response = git_http::refuse(refused)?;
                after.ended(response.status_code(), why);
                after.spawn(env, ctx);
                return Ok(response);
            }
        };
        // A pull request's working copy removed after it closed is made
        // again before git uses it (forks.rs).
        self.live(&repo).await?;
        timing.mark("access");
        // Clones check out the default branch g1t keeps, which can have
        // changed since the store made the repository.
        let default_branch = repo.fork_of.is_none().then(|| repo.default_branch.clone());
        let key = store_key(&repo);
        let scope = if write { Scope::Write } else { Scope::Read };
        let mut request = request;
        let protocol = refs_cache::protocol(request.headers().get("git-protocol")?.as_deref());
        // A fetch's POST is read here, to tell an `ls-refs` from a fetch of
        // objects; the store would have it read in full anyway.
        let body = if !write && !get { Some(request.bytes().await?) } else { None };
        // What it asks the store, for the meters (meters.rs).
        let call = git_ops::classify(git.service, git.endpoint, get, body.as_deref());
        // Answers kept from the usual store may name refs the fallback
        // store does not have (fallback.rs): none are used, or kept.
        let fallback = self.store.on_fallback(&key);
        // An answer that lists refs may have been kept: see refs_cache.rs.
        let kept_key = refs_cache::kind(git, get, protocol, body.as_deref())
            .filter(|_| !fallback)
            .zip(refs_cache::usable(registry::refs_state(&repo.id), now_ms()))
            .map(|(kind, version)| {
                refs_cache::Key::new(&repo.id, version, default_branch.as_deref(), protocol, &kind)
            });
        // A fresh clone's pack may have been kept too: see pack_cache.rs.
        // Under the same refs version, so never across a change to them.
        let pack_key = self
            .packs
            .as_ref()
            .filter(|_| !fallback)
            .and_then(|_| {
                let encoding = request.headers().get("content-encoding").ok().flatten();
                pack_cache::cacheable(git, get, protocol, encoding.as_deref(), body.as_deref())
            })
            .zip(refs_cache::usable(registry::refs_state(&repo.id), now_ms()))
            .map(|(normalized, version)| pack_cache::Key::new(&repo.id, version, &normalized));
        // A kept answer and the free workspace limits, with a kept
        // credential and, for a push, what the repository holds looked up
        // alongside. A kept answer goes back without waiting for the
        // credential, which it does not need.
        let pushing = write && !get;
        let ((answer, pack, (limited, held)), kept_access) = {
            let shared = self.shared.as_deref();
            let answer_and_limits = std::pin::pin!(futures_util::future::join3(
                async {
                    match &kept_key {
                        Some(kept_key) => refs_cache::get(shared, kept_key).await,
                        None => None,
                    }
                },
                async {
                    match (&pack_key, self.packs.as_deref()) {
                        (Some(pack_key), Some(packs)) => pack_cache::get(packs, pack_key).await,
                        _ => None,
                    }
                },
                futures_util::future::join(self.git_limits(call, git, &repo, env), async {
                    if pushing { Some(self.held(&repo).await) } else { None }
                }),
            ));
            let kept_access = std::pin::pin!(self.store.kept_access(&key, scope));
            match futures_util::future::select(answer_and_limits, kept_access).await {
                futures_util::future::Either::Left((first, kept_access)) => {
                    let answered = first.0.is_some() || first.1.is_some() || matches!(first.2.0, Ok(Some(_)) | Err(_));
                    (first, if answered { None } else { kept_access.await })
                }
                futures_util::future::Either::Right((kept_access, first)) => (first.await, kept_access),
            }
        };
        timing.mark("kept");
        // A kept pack first: it never reaches the store, so it is never an
        // operation, and a free workspace past its operation cap still gets
        // it. (The other limits are a push's, and a pack is only a fetch.)
        if let Some(kept) = pack {
            timing.note("pack", "hit");
            let sent = body.as_ref().map_or(0, |body| body.len() as u64);
            meters::record(pack_cache::HIT, &key, sent, kept.size);
            after.ended(200, None);
            after.spawn(env, ctx);
            return kept.response();
        }
        if let Some((response, status, message)) = limited? {
            after.ended(status, Some(message.to_owned()));
            after.spawn(env, ctx);
            return Ok(response);
        }
        if pack_key.is_some() {
            timing.note("pack", "miss");
        }
        if let (Some((entry, found)), Some(kept_key)) = (answer, &kept_key) {
            timing.note("refs", found.as_str());
            if found == refs_cache::Found::Shared {
                let (kept_key, entry) = (kept_key.clone(), entry.clone());
                ctx.wait_until(async move { refs_cache::keep_in_colo(&kept_key, &entry).await });
            }
            // Never reached the store: never an operation.
            meters::record(call.cached_meter(), &key, 0, entry.body.len() as u64);
            after.ended(200, None);
            after.spawn(env, ctx);
            return entry.response();
        }
        if kept_key.is_some() {
            timing.note("refs", "miss");
        }
        // An anonymous fetch the store is about to answer: an operation for
        // the repository's workspace, so limited per repository (limits.rs).
        if limits::counts_as_anonymous_fetch(call, viewer.is_none())
            && g1t_kit::limits::check(env, limits::ANONYMOUS_FETCH, repo.id.clone()).await.limited()
        {
            let response = limits::too_many_anonymous_fetches(&format!("{}/{}", repo.namespace, repo.name))?;
            after.ended(429, Some("Too many anonymous fetches.".to_owned()));
            after.spawn(env, ctx);
            return Ok(response);
        }
        // The store's credential: one made a moment ago, here or in another
        // isolate (see store.rs), or a new one.
        let access = match kept_access {
            Some((access, from)) => {
                timing.note("cred", from.as_str());
                access
            }
            None => {
                let access = self.store.mint_access(&key, scope).await?;
                timing.mark("mint");
                timing.note("cred", "mint");
                access
            }
        };
        // Should the store turn a kept credential down, a fetch's first
        // request is tried again with a new one; the requests after it then
        // have that one too.
        let again = if get { Some(request.clone()?) } else { None };
        // A push's checks: workflow files, the rules of the branches and
        // tags it changes, saying which rule and why (rules.rs), and push
        // protection, which refuses a push that adds a secret
        // (secret_scan.rs). See push_checks.rs.
        let checks = async |head: &[u8], whole: bool, scan: bool| self.check_receive(&repo, viewer.as_ref(), head, whole, scan).await;
        // What a push may bring (pack_limits.rs): the repository's size is
        // its own and its pull requests' working copies'.
        let mut limits = if let Some(held) = held {
            git_http::PushLimits {
                held,
                repo_limit: self.repo_limit,
                large: self.large_pushes,
                ..git_http::PushLimits::default()
            }
        } else {
            git_http::PushLimits::default()
        };
        // Reserve an upper bound before any bytes reach the upstream store.
        // No Content-Length is required: chunked pushes reserve the platform
        // body limit. The body walker independently enforces this allowance.
        let public_reserved = if pushing {
            let requested = request.headers().get("content-length")?
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(pack_limits::PLATFORM_BODY_LIMIT_BYTES)
                .min(pack_limits::PLATFORM_BODY_LIMIT_BYTES);
            if !self.registry.reserve_public(&repo, requested, self.free_public_bytes).await? {
                return git_ops::public_storage_full_response(&repo.namespace,
                    self.registry.public_bytes(&repo.namespace).await?, self.free_public_bytes);
            }
            limits.repo_limit = limits.repo_limit.min(limits.held.saturating_add(requested));
            Some(requested)
        } else { None };
        let mut outcome = git_http::forward(
            request,
            body,
            git,
            &access,
            checks,
            default_branch.as_deref(),
            limits,
            timing,
        )
        .await?;
        let turned_down = matches!(
            &outcome,
            git_http::Push::Forwarded(forwarded) if matches!(forwarded.response.status_code(), 401 | 403)
        );
        if turned_down {
            self.store.forget_access(&key).await;
            if let Some(again) = again {
                let access = self.store.mint_access(&key, scope).await?;
                outcome = git_http::forward(
                    again,
                    None,
                    git,
                    &access,
                    async |_: &[u8], _: bool, _: bool| Ok(push_checks::Checks::clear()),
                    default_branch.as_deref(),
                    git_http::PushLimits::default(),
                    timing,
                )
                .await?;
            }
        }
        let forwarded =
            match outcome {
                git_http::Push::Forwarded(forwarded) => forwarded,
                git_http::Push::Refused(response) => {
                    if let Some(reserved) = public_reserved { self.registry.release_public(&repo, reserved).await?; }
                    after.ended(403, Some("The push was declined by rules.".to_owned()));
                    after.spawn(env, ctx);
                    return Ok(response);
                }
                git_http::Push::Blocked(response) => {
                    if let Some(reserved) = public_reserved { self.registry.release_public(&repo, reserved).await?; }
                    after.ended(403, Some("The push adds a secret.".to_owned()));
                    after.spawn(env, ctx);
                    return Ok(response);
                }
                git_http::Push::Declined(response, reason) => {
                    after.ended(403, Some(format!("The push was declined: {reason}.")));
                    after.spawn(env, ctx);
                    return Ok(response);
                }
            };
        if forwarded.from_store {
            let received = forwarded
                .response
                .headers()
                .get("content-length")?
                .and_then(|length| length.parse().ok())
                .unwrap_or(0);
            meters::record(call.meter(), &key, forwarded.sent, received);
        }
        timing.mark("store");
        let mut response = forwarded.response;
        let status = response.status_code();
        if let Some(reserved) = public_reserved {
            // Retain the whole reservation on ambiguous upstream failure.
            // Successful uploads replace it with the actual admitted pack.
            if status == 200 {
                self.registry.finish_public(&repo, reserved, forwarded.pack_bytes).await?;
            }
        }
        if write && !get {
            // A push: the store has moved its refs once it has answered in
            // full, so the answer is read before the change is recorded, and
            // only then goes back. Whoever fetches after it sees the push.
            let headers = response.headers().clone();
            headers.delete("content-length")?;
            let mut report = response.bytes().await?;
            self.refs_moved(&repo.id).await;
            timing.mark("refs");
            if status == 200 {
                push_feedback::add(&mut report, self.security.as_ref(), &repo, &viewer).await;
            }
            response = Response::from_bytes(report)?.with_headers(headers).with_status(status);
        } else if let (Some(kept_key), 200) = (&kept_key, status) {
            // A miss: this answer is kept for the next to ask.
            let headers = response.headers().clone();
            headers.delete("content-length")?;
            let body = response.bytes().await?;
            if let Some(content_type) = headers.get("content-type")? {
                let entry = refs_cache::Entry { content_type, body: body.clone() };
                if entry.keepable() {
                    let shared = self.shared.clone();
                    let kept_key = kept_key.clone();
                    ctx.wait_until(async move { refs_cache::keep(shared.as_deref(), &kept_key, &entry).await });
                }
            }
            response = Response::from_bytes(body)?.with_headers(headers).with_status(status);
        } else if let (Some(pack_key), Some(packs), true) = (&pack_key, &self.packs, forwarded.from_store) {
            // A fresh clone the bucket did not have: counted, and its pack
            // kept as it streams to git, when it is a whole one.
            meters::record(pack_cache::MISS, &key, forwarded.sent, 0);
            // Past the repository's limit on writes to the bucket, the pack
            // goes to git without being kept (limits.rs).
            if status == 200 && !g1t_kit::limits::check(env, limits::PACK_FILL, repo.id.clone()).await.limited() {
                let store_key = key.clone();
                let measured = Box::new(move |bytes: u64| meters::record_bytes(pack_cache::MISS, &store_key, 0, bytes));
                let (teed, filling) = pack_cache::tee(response, packs.clone(), pack_key, measured)?;
                response = teed;
                if let Some(filling) = filling {
                    let pack_key = pack_key.clone();
                    ctx.wait_until(async move {
                        let filled = filling.await;
                        if !matches!(filled, pack_cache::Filled::Kept { .. } | pack_cache::Filled::Abandoned) {
                            worker::console_warn!("pack {} not kept: {filled:?}", pack_key.as_str());
                        }
                    });
                }
            }
        }
        after.ended(status, None);
        if status == 200 && (forwarded.pack_bytes > 0 || !forwarded.pushed.is_empty() || !forwarded.deleted.is_empty()) {
            after.push = Some(PushDone {
                repo,
                pushed: forwarded.pushed,
                deleted: forwarded.deleted,
                pack_bytes: if public_reserved.is_some() { 0 } else { forwarded.pack_bytes },
                caused_by_job: viewer.as_ref().and_then(g1t_contracts::events::job_run_of).map(str::to_owned),
                // The calendar credits people, never a job's, an agent's or a workspace's token.
                credit: viewer
                    .as_ref()
                    .filter(|user| user.kind == PrincipalKind::User && g1t_contracts::events::job_run_of(user).is_none())
                    .map(|user| user.id.clone()),
                agent: viewer.as_ref().and_then(acting_agent),
                actor: viewer.map(|user: User| user.id),
                unscanned: forwarded.unscanned,
            });
        }
        after.spawn(env, ctx);
        Ok(response)
    }

    /// The answer for a request a free workspace's limits stop, or a push
    /// to a full repository, with its status and reason for the audit log;
    /// `None` to go on.
    ///
    /// A clone, fetch or push is a git operation, which the git store
    /// charges g1t for: counted for billing once the answer has gone back
    /// (meters.rs), and a free workspace far past its share is slowed down
    /// rather than charged (see git_ops.rs). Whether it is past it is
    /// decided from counts this isolate already holds: the database is not
    /// asked on the way. A free workspace is never charged for private
    /// storage: once its private repositories hold the free amount, pushes
    /// to them stop, checked when a push begins so that git shows the
    /// reason. So do pushes to a repository at the store's size limit.
    async fn git_limits(
        &self,
        call: git_ops::GitCall,
        git: &git_http::GitRequest,
        repo: &Repo,
        env: &Env,
    ) -> Result<Option<(Response, u16, &'static str)>> {
        let namespace = git.path.namespace.to_lowercase();
        if meters::mapping_now().billable(call.meter()) > 0.0 {
            let now = now_ms();
            let hour = git_ops::hour_key(&rfc3339(now));
            let limits = git_ops::Limits::from_env(env);
            if let Some((month, hour_ops)) = git_ops::standing(&namespace, &hour, now)
                && git_ops::slow_down(month + 1, hour_ops + 1, limits.free_cap, limits.hourly)
                && git_ops::is_free_kept(env.service("BILLING").ok().as_ref(), &namespace).await
            {
                return Ok(Some((
                    git_ops::too_many(&namespace, limits.free_cap, limits.hourly)?,
                    429,
                    "Too many git operations this hour.",
                )));
            }
        }
        if git.service == GitService::ReceivePack && git.endpoint == "info/refs" {
            let held = self.held(repo).await;
            if held >= self.repo_limit {
                let message = format!(
                    "{}/{} holds about {}, the most a repository may hold on g1t, so it takes no more pushes. Delete what you no longer need, or split it: https://docs.g1t.sh/guides/git/#size-limits\n",
                    repo.namespace,
                    repo.name,
                    pack_limits::megabytes(held)
                );
                return Ok(Some((Response::error(message, 403)?, 403, "The repository is full.")));
            }
        }
        if git.service == GitService::ReceivePack && git.endpoint == "info/refs" && repo.is_private {
            let free = git_ops::free_private_bytes(env);
            let held = self.registry.private_bytes(&namespace).await.unwrap_or(0);
            if git_ops::storage_full(held, free)
                && git_ops::is_free(env.service("BILLING").ok().as_ref(), &namespace).await
            {
                return Ok(Some((
                    git_ops::storage_full_response(&namespace, held, free)?,
                    403,
                    "Free private storage is full.",
                )));
            }
        }
        if git.service == GitService::ReceivePack && !repo.is_private {
            let free = git_ops::free_public_bytes(env);
            if free > 0 {
                let held = self.registry.public_bytes(&namespace).await?;
                if git_ops::public_storage_full(held, free) {
                    return Ok(Some((
                        git_ops::public_storage_full_response(&namespace, held, free)?,
                        403,
                        "Free public storage is full.",
                    )));
                }
            }
        }
        Ok(None)
    }

    /// What a repository and its pull requests' working copies hold, as
    /// g1t counts it: read for a push's first request, kept a minute for
    /// the rest of it.
    async fn held(&self, repo: &Repo) -> u64 {
        let root = repo.fork_of.clone().unwrap_or_else(|| repo.id.clone());
        let now = now_ms();
        if let Some(held) = HELD.with(|held| held.borrow().get(&root, now)) {
            return held;
        }
        let held = self.registry.stored_bytes(&root).await.unwrap_or(0).max(0) as u64;
        HELD.with(|kept| kept.borrow_mut().put(root, held, now));
        held
    }

    /// A `git.deleted` event for each branch or tag a push deleted that is
    /// gone from the store: the store can refuse one ref and accept
    /// another. As many as a push announces of tags and branches it moves.
    async fn publish_deleted(
        &self,
        repo: &Repo,
        deleted: &[(String, String)],
        actor: Option<&str>,
        caused_by_job: Option<&str>,
    ) -> Result<()> {
        let stored = self.store.open(&store_key(repo)).await?;
        let is_branch = |git_ref: &str| git_ref.starts_with("refs/heads/");
        let tags = deleted.iter().filter(|(git_ref, _)| !is_branch(git_ref)).count();
        let announced = deleted
            .iter()
            .filter(|(git_ref, _)| is_branch(git_ref))
            .take(MAX_PUSH_BRANCH_EVENTS)
            .chain(deleted.iter().filter(|(git_ref, _)| !is_branch(git_ref) && tags <= MAX_PUSH_TAG_EVENTS));
        for (git_ref, before) in announced {
            let named = git_ref.strip_prefix("refs/heads/").unwrap_or(git_ref);
            let gone = match stored.log(named, 1).await {
                Ok(head) => head.is_empty(),
                Err(error) => {
                    worker::console_error!("whether {git_ref} of {} was deleted is not known: {error}", repo.name);
                    false
                }
            };
            if !gone {
                continue;
            }
            self.publish(NewEvent {
                kind: "git.deleted",
                source: SOURCE,
                repo_id: Some(repo.id.clone()),
                actor: actor.map(str::to_owned),
                data: GitDeleted {
                    repo_id: repo.id.clone(),
                    git_ref: git_ref.clone(),
                    before: before.clone(),
                    caused_by_job: caused_by_job.map(str::to_owned),
                },
            })
            .await?;
        }
        Ok(())
    }

    /// What a push changed, recorded once git has its answer.
    async fn record_push(&self, push: PushDone) -> Result<()> {
        let PushDone {
            repo,
            pushed,
            deleted,
            pack_bytes,
            actor,
            unscanned,
            caused_by_job,
            credit,
            agent,
        } = push;
        // What the push stored, for billing's storage meter. A failure only
        // leaves the count short.
        if pack_bytes > 0
            && let Err(error) = self.registry.add_stored_bytes(&repo, pack_bytes).await
        {
            worker::console_error!("stored bytes for {} not counted: {error}", repo.name);
        }
        if !deleted.is_empty() {
            self.publish_deleted(&repo, &deleted, actor.as_deref(), caused_by_job.as_deref()).await?;
        }
        if pushed.is_empty() {
            return Ok(());
        }
        // Artifacts' own push notifications are per repository, which does
        // not fit a repo per pull request, so the front end reports pushes
        // itself: one event for each branch that moved.
        let stored = self.store.open(&store_key(&repo)).await?;
        let announced = announced_refs(&pushed, &repo.default_branch);
        if announced.len() < pushed.len() {
            worker::console_log!(
                "push to {}: {} of {} refs announced",
                repo.name,
                announced.len(),
                pushed.len()
            );
        }
        for pushed in announced {
            // The store can refuse one ref and accept another, so each
            // branch is checked against where it actually is. A tag the
            // store cannot read back is taken as pushed.
            let moved = match pushed.branch() {
                Some(branch) => stored
                    .log(branch, 1)
                    .await?
                    .first()
                    .is_some_and(|commit| commit.hash == pushed.after),
                None => stored.log(&pushed.git_ref, 1).await.map_or(true, |head| {
                    head.first().is_none_or(|commit| commit.hash == pushed.after)
                }),
            };
            // How many commits a branch push brought (push_commits.rs), for
            // the event and the person's contribution calendar. A log the
            // store cannot read leaves the event without a count and the
            // day short.
            let commits = match (moved, pushed.branch()) {
                (true, Some(_)) => match stored.log(&pushed.after, push_commits::MOST_PER_PUSH + 1).await {
                    Ok(log) => Some(push_commits::new_commits(&log, pushed.before.as_deref())),
                    Err(error) => {
                        worker::console_error!("commits pushed to {} not counted: {error}", repo.name);
                        None
                    }
                },
                _ => None,
            };
            if let (Some(commits), Some(user_id), Some(branch)) = (commits, credit.as_deref(), pushed.branch())
                && push_commits::counts(branch, &repo.default_branch)
                && let Err(error) =
                    push_commits::record(&self.registry.db, user_id, &repo.id, &rfc3339(now_ms())[..10], commits).await
            {
                worker::console_error!("commits pushed to {} not credited: {error}", repo.name);
            }
            if moved {
                self.publish_git_push(
                    &repo,
                    &pushed.git_ref,
                    pushed.before.as_deref(),
                    &pushed.after,
                    actor.clone(),
                    unscanned,
                    caused_by_job.clone(),
                    commits,
                    None,
                    agent.clone(),
                )
                .await?;
            }
        }
        Ok(())
    }
}

/// The most tags one push announces: a push of more (`git push --tags`
/// into a new repository, say) announces none of them, so it starts no
/// workflows or package reads, one per tag.
const MAX_PUSH_TAG_EVENTS: usize = 3;
/// The most branches one push announces. A push of more announces only
/// the default branch, if it moved, which the rest of g1t reads from.
const MAX_PUSH_BRANCH_EVENTS: usize = 1000;

/// The refs of a push that are announced with a `git.push` event each.
/// Every ref is stored whatever this says; only the events are capped.
fn announced_refs<'a>(pushed: &'a [git_http::Pushed], default_branch: &str) -> Vec<&'a git_http::Pushed> {
    let (branches, tags): (Vec<&git_http::Pushed>, Vec<&git_http::Pushed>) =
        pushed.iter().partition(|pushed| pushed.branch().is_some());
    let mut announced = if branches.len() > MAX_PUSH_BRANCH_EVENTS {
        branches.into_iter().filter(|pushed| pushed.branch() == Some(default_branch)).collect()
    } else {
        branches
    };
    if tags.len() <= MAX_PUSH_TAG_EVENTS {
        announced.extend(tags);
    }
    announced
}

/// How long after a push's answer its About may still be reading: the
/// waitUntil it runs in ends 30 s after the answer, and what it worked out
/// must still be written.
const PUSH_ABOUT_BY_MS: u64 = 24_000;
/// Less time left than this after recording a push, and its About is left
/// for the next view to start.
const MIN_PUSH_ABOUT_MS: u64 = 5_000;

/// How long a push's About may read, `elapsed` after the push's answer:
/// what is left before [`PUSH_ABOUT_BY_MS`], or `None` when that is too
/// little to be worth starting.
fn push_about_budget(elapsed: u64) -> Option<u64> {
    let left = PUSH_ABOUT_BY_MS.saturating_sub(elapsed);
    (left >= MIN_PUSH_ABOUT_MS).then_some(left)
}

/// The repository whose About a push should work out: one that has an
/// About, when the push moved its default branch.
fn about_after_push(push: &PushDone) -> Option<Repo> {
    let moved_default = push.pushed.iter().any(|pushed| pushed.branch() == Some(push.repo.default_branch.as_str()));
    (stats::has_about(&push.repo) && moved_default).then(|| push.repo.clone())
}

/// A push the store accepted, to be recorded once git has its answer.
struct PushDone {
    repo: Repo,
    pushed: Vec<git_http::Pushed>,
    /// The branches and tags it asked to delete, each with the commit it
    /// pointed to.
    deleted: Vec<(String, String)>,
    pack_bytes: u64,
    actor: Option<String>,
    /// Too large to scan for secrets before it was stored.
    unscanned: bool,
    /// The run whose job's token pushed, if one did: its push starts no
    /// workflows.
    caused_by_job: Option<String>,
    /// The person credited with the push's commits on their contribution
    /// calendar: whoever pushed, when that is a person (push_commits.rs).
    credit: Option<String>,
    /// The agent that pushed for the person, when one did (GitPush::agent).
    agent: Option<String>,
}

/// The agent a viewer acts as for a person: g1t, for a session it started.
fn acting_agent(user: &User) -> Option<String> {
    user.acting.as_deref().map(|acting| acting.agent.clone())
}

/// What a git request leaves for after its answer: its audit entry, with
/// how the request ended, and what a push changed.
struct AfterGit {
    audit: Option<Box<run_access::GitEntry>>,
    status: u16,
    message: Option<String>,
    push: Option<PushDone>,
}

impl AfterGit {
    fn ended(&mut self, status: u16, message: Option<String>) {
        self.status = status;
        self.message = message;
    }

    /// Does the work once the response is on its way. A failure is logged:
    /// git has already been told how its request went.
    fn spawn(self, env: &Env, ctx: &Context) {
        if self.audit.is_none() && self.push.is_none() {
            return;
        }
        let env = env.clone();
        // A push that moved the default branch has its About worked out
        // now, so the next view finds it current rather than starting the
        // run itself (about.rs, `refresh`).
        let about = self.push.as_ref().and_then(about_after_push);
        let started = now_ms();
        ctx.wait_until(async move {
            let repos = match service(&env) {
                Ok(repos) => repos,
                Err(error) => {
                    worker::console_error!("git request not recorded: {error}");
                    return;
                }
            };
            repos.finish_git(self.audit, self.status, self.message).await;
            if let Some(push) = self.push
                && let Err(error) = repos.record_push(push).await
            {
                worker::console_error!("push not recorded: {error}");
            }
            repos.deferred.settle().await;
            if let Some(repo) = about
                && let Some(budget) = push_about_budget(now_ms().saturating_sub(started))
            {
                repos.refresh(&repo, budget).await;
                repos.deferred.settle().await;
            }
        });
    }
}

fn service(env: &Env) -> Result<Repos<ArtifactsStore>> {
    let shared = shared::Shared::from_env(env).map(Rc::new);
    let deferred = Rc::new(store::Deferred::default());
    Ok(Repos {
        registry: Registry { db: Rc::new(env.d1("DB")?) },
        store: ArtifactsStore::new(env, shared.clone(), deferred.clone())?,
        deferred,
        shared,
        packs: pack_cache::Packs::from_env(env).map(Rc::new),
        events: env.service("EVENTS")?,
        security: env.service("SECURITY").ok(),
        billing: env.service("BILLING").ok(),
        identity: env.service("IDENTITY").ok(),
        work: env.service("WORK").ok(),
        free_private_bytes: git_ops::free_private_bytes(env),
        free_public_bytes: git_ops::free_public_bytes(env),
        fork_days: forks::retention_days(env),
        repo_limit: env
            .var("REPO_STORAGE_LIMIT_BYTES")
            .ok()
            .and_then(|value| value.to_string().parse().ok())
            .unwrap_or(pack_limits::DEFAULT_REPO_LIMIT_BYTES),
        large_pushes: git_http::LargePushes::from_var(env.var("LARGE_PUSHES").ok().map(|value| value.to_string()).as_deref()),
        placement: shards::Placement::from_vars(
            env.var("GITSTORE_NEW_REPOS").ok().map(|value| value.to_string()).as_deref(),
            env.var("GITSTORE_EU_NAMESPACE").ok().map(|value| value.to_string()).as_deref(),
        ),
        limits: shards::limits(env.var("GITSTORE_NAMESPACE_LIMITS").ok().map(|value| value.to_string()).as_deref()),
    })
}

/// Writes what this isolate metered once the answer has gone back, every
/// few seconds at most: now, or once it is due, waiting in this request's
/// `wait_until` so nothing counted is left for a request that may never
/// come (meters.rs).
fn flush_later(env: &Env, ctx: &Context) {
    let Some(wait) = meters::plan_flush() else {
        return;
    };
    if let Ok(db) = env.d1("DB") {
        ctx.wait_until(async move { meters::flush_after(&db, wait).await });
    }
}

/// `/backups/<job id>/parts/<number>`: the job and the part's number.
fn backup_part_path(path: &str) -> Option<(String, u16)> {
    let rest = path.strip_prefix("/backups/")?;
    let (job, number) = rest.split_once("/parts/")?;
    let number = number.parse::<u16>().ok()?;
    (!job.is_empty() && !job.contains('/')).then(|| (job.to_owned(), number))
}

fn backups_off<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::Conflict, "Backups are off on this installation: it has no storage for them.")
}

/// One part of a backup's bundle, with the job's token in its header.
async fn backup_part(request: &mut Request, env: &Env, repos: &Repos<ArtifactsStore>, job_id: String, number: u16) -> Result<Response> {
    let Some(blobs) = backups::storage(env) else {
        return reply(&backups_off::<()>());
    };
    let token = request.headers().get(g1t_contracts::backups::TOKEN_HEADER)?.unwrap_or_default();
    let bytes = request.bytes().await?;
    let job = g1t_contracts::backups::BackupJobArgs { job_id, token };
    reply(&backups::part(&repos.registry.db, &blobs, &job, number, bytes).await?)
}

#[cfg(test)]
mod backup_path_tests {
    use super::backup_part_path;

    #[test]
    fn a_part_is_named_by_its_job_and_number() {
        assert_eq!(backup_part_path("/backups/bkp_1/parts/3"), Some(("bkp_1".to_owned(), 3)));
        assert_eq!(backup_part_path("/backups/bkp_1/parts/x"), None);
        assert_eq!(backup_part_path("/backups//parts/1"), None);
        assert_eq!(backup_part_path("/acme/rocket.git/info/refs"), None);
    }
}

/// Read methods whose answer is an `Outcome`: when the git store is busy,
/// the site is told so in words instead of failing the page.
const OUTCOME_READS: [&str; 7] = ["tree", "blob", "log", "branches", "blame", "compare", "branch_drift"];

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    let mut repos = service(&env)?;
    // A part of a backup's bundle, as the API passes it on from the
    // sandbox: bytes, not JSON (backups.rs).
    if request.method() == Method::Put
        && let Some((job_id, number)) = backup_part_path(&request.path())
    {
        let answered = backup_part(&mut request, &env, &repos, job_id, number).await;
        repos.deferred.hand_over(&ctx);
        flush_later(&env, &ctx);
        return answered;
    }
    let Some(method) = rpc_method(&request) else {
        let answered = repos.git_http(request, &env, &ctx).await;
        repos.deferred.hand_over(&ctx);
        flush_later(&env, &ctx);
        return answered;
    };
    let started = now_ms();
    // A replica near the caller when it asks for one (crates/kit/src/d1.rs).
    // Git over HTTPS above always reads the primary.
    let (db, served) = g1t_kit::d1::open(&env, "DB", &request)?;
    repos.registry.db = db.into();
    let body: serde_json::Value = request.json().await?;

    let answered = async { match method.as_str() {
        "get" => reply(&repos.get(args(body)?).await?),
        "get_by_id" => reply(&repos.get_by_id(args(body)?).await?),
        "readable" => {
            let a: ReadableArgs = args(body)?;
            reply(&repos.registry.readable(&a.ids, &a.viewer).await?)
        }
        // Work's contribution calendar: the commits a person pushed each
        // day, in repositories the viewer may read (push_commits.rs).
        "commit_days" => {
            let a: g1t_contracts::repos::CommitDaysArgs = args(body)?;
            reply(&push_commits::days(&repos.registry, &a.user_id, &a.since, &a.viewer).await?)
        }
        "public_namespaces" => {
            let a: PublicNamespacesArgs = args(body)?;
            reply(&repos.registry.public_namespaces(&a.owner_id).await?)
        }
        "path_by_id" => {
            let a: PathByIdArgs = args(body)?;
            reply(
                &repos
                    .registry
                    .by_id(&a.id)
                    .await?
                    .filter(|repo| repo.fork_of.is_none())
                    .map(|repo| RepoPath {
                        namespace: repo.namespace,
                        name: repo.name,
                    }),
            )
        }
        "list" => {
            let a: ListArgs = args(body)?;
            reply(
                &repos
                    .registry
                    .list(
                        &a.viewer,
                        a.query.as_deref(),
                        a.namespace.as_deref(),
                        a.member_only,
                    )
                    .await?,
            )
        }
        "create" => reply(&repos.create(args(body)?).await?),
        "transfer" => reply(&repos.transfer(args(body)?).await?),
        // A repository's lifecycle: see lifecycle.rs.
        "delete" => reply(&repos.delete(args(body)?).await?),
        "deleted" => reply(&repos.deleted(args(body)?).await?),
        "restore" => reply(&repos.restore(args(body)?).await?),
        "purge" => reply(&repos.purge(args(body)?).await?),
        "purge_due" => reply(&repos.purge_due(args(body)?).await?),
        "rename" => reply(&repos.rename(args(body)?).await?),
        "archive" => reply(&repos.archive(args(body)?).await?),
        "set_visibility" => reply(&repos.set_visibility(args(body)?).await?),
        "set_default_branch" => reply(&repos.set_default_branch(args(body)?).await?),
        "rename_branch" => reply(&repos.rename_branch(args(body)?).await?),
        "create_branch" => reply(&repos.create_branch(args(body)?).await?),
        "remove_branch" => reply(&repos.remove_branch(args(body)?).await?),
        "resolve_branch" => reply(&repos.resolve_branch(args(body)?).await?),
        "status_by_id" => reply(&repos.status_by_id(args(body)?).await?),
        "resolve_path" => {
            let a: ResolvePathArgs = args(body)?;
            reply(&repos.registry.resolve_moved(&a.path).await?)
        }
        "namespace_count" => {
            let a: NamespaceCountArgs = args(body)?;
            reply(&repos.registry.count_in(&a.namespace).await?)
        }
        "update" => reply(&repos.update(args(body)?).await?),
        "tree" => reply(&repos.tree(args(body)?).await?),
        "blob" => reply(&repos.blob(args(body)?).await?),
        "log" => reply(&repos.log(args(body)?).await?),
        "blame" => reply(&repos.blame(args(body)?).await?),
        "fork_for_pull" => reply(&repos.fork_for_pull(args(body)?).await?),
        // Forks people make into their workspaces: see network.rs.
        "fork" => reply(&repos.fork(args(body)?).await?),
        "forks" => reply(&repos.forks(args(body)?).await?),
        "sync_fork" => reply(&repos.sync_fork(args(body)?).await?),
        "detach_fork" => reply(&repos.detach_fork(args(body)?).await?),
        "git_access" => reply(&repos.git_access(args(body)?).await?),
        "branches" => reply(&repos.branches(args(body)?).await?),
        "last_commits" => reply(&repos.last_commits(args(body)?).await?),
        "path_log" => reply(&repos.path_log(args(body)?).await?),
        "branch_drift" => reply(&repos.branch_drift(args(body)?).await?),
        "tags" => reply(&repos.tags(args(body)?).await?),
        // The About: what the Files page shows beside the files (about.rs).
        // What is kept behind the head is worked out again after the answer.
        "about" => {
            let (answer, refresh) = repos.about(args(body)?).await?;
            about::refresh_later(&env, &ctx, refresh);
            reply(&answer)
        }
        "languages" => {
            let (answer, refresh) = repos.languages(args(body)?).await?;
            about::refresh_later(&env, &ctx, refresh);
            reply(&answer)
        }
        "contributors" => {
            let (answer, refresh) = repos.contributors(args(body)?).await?;
            about::refresh_later(&env, &ctx, refresh);
            reply(&answer)
        }
        "license" => {
            let (answer, refresh) = repos.license(args(body)?).await?;
            about::refresh_later(&env, &ctx, refresh);
            reply(&answer)
        }
        "stars" => reply(&repos.stars(args(body)?).await?),
        "star" => reply(&repos.star(args(body)?).await?),
        "stargazers" => reply(&repos.stargazers(args(body)?).await?),
        "starred" => reply(&repos.starred(args(body)?).await?),
        "releases" => reply(&repos.releases(args(body)?).await?),
        "release" => reply(&repos.release(args(body)?).await?),
        "create_release" => reply(&repos.create_release(args(body)?).await?),
        "update_release" => reply(&repos.update_release(args(body)?).await?),
        "delete_release" => reply(&repos.delete_release(args(body)?).await?),
        "head" => reply(&repos.head(args(body)?).await?),
        "behind" => reply(&repos.behind(args(body)?).await?),
        "divergence" => reply(&repos.divergence(args(body)?).await?),
        "land" => reply(&repos.land(args(body)?).await?),
        // Services only: what a push brought into a branch (pushed.rs).
        "pushed" => reply(&repos.pushed(args(body)?).await?),
        "build_queue_step" => reply(&repos.build_queue_step(args(body)?).await?),
        "update_pull_branch" => reply(&repos.update_pull_branch(args(body)?).await?),
        // Services only: a pull request's test merge commit (test_merge.rs).
        "pull_merge_ref" => reply(&repos.pull_merge_ref(args(body)?).await?),
        "delete_branch" => reply(&repos.delete_branch(args(body)?).await?),
        "commit_file" => reply(&repos.commit_file(args(body)?).await?),
        "compare" => reply(&repos.compare(args(body)?).await?),
        // Services only: a pull request's commits, as rules look at them (rules.rs).
        "inspect_commits" => reply(&repos.inspect_commits(args(body)?).await?),
        "scan_history" => reply(&repos.scan_history(args(body)?).await?),
        "find_lockfiles" => reply(&repos.find_lockfiles(args(body)?).await?),
        "match_pattern" => reply(&repos.match_pattern(args(body)?).await?),
        "check_secret" => reply(&repos.check_secret(args(body)?).await?),
        "list_files" => reply(&repos.list_files(args(body)?).await?),
        // The API's tarball and zipball links, and the site opening them (archive_links.rs).
        "archive_link" => {
            let sealer = env.secret("REPOS_KEY").ok().and_then(|key| g1t_secrets::Sealer::new(&key.to_string()));
            reply(&repos.archive_link(args(body)?, sealer.as_ref()).await?)
        }
        "open_archive_token" => {
            let sealer = env.secret("REPOS_KEY").ok().and_then(|key| g1t_secrets::Sealer::new(&key.to_string()));
            reply(&repos.open_archive_token(args(body)?, sealer.as_ref()).await?)
        }
        "changed_files" => reply(&repos.changed_files(args(body)?).await?),
        "read_blobs" => reply(&repos.read_blobs(args(body)?).await?),
        // Services only: what the Composer registry builds packages from.
        "refs" => reply(&repos.refs_of(args(body)?).await?),
        "raw_file" => reply(&repos.raw_file(args(body)?).await?),
        "raw_blobs" => reply(&repos.raw_blobs(args(body)?).await?),
        "visibility" => {
            let a: g1t_contracts::repos::VisibilityArgs = args(body)?;
            reply(&repos.registry.visibility(&a.paths).await?)
        }
        "storage" => reply(&repos.registry.storage().await?),
        "git_operations" => {
            let a: GitOperationsArgs = args(body)?;
            reply(&git_ops::totals(&repos.registry.db, &a.month, a.since.as_deref(), a.namespace.as_deref().map(str::to_lowercase).as_deref()).await?)
        }
        // Identity, once: who created each repository (members.rs there).
        "repo_creators" => {
            let a: AllIdsArgs = args(body)?;
            let limit = a.limit.clamp(1, 500);
            let repos = repos.registry.creators_after(a.after.as_deref(), limit).await?;
            let next = (repos.len() == limit as usize).then(|| repos.last().map(|repo| repo.id.clone())).flatten();
            reply(&CreatorPage { repos, next })
        }
        "all_ids" => {
            let a: AllIdsArgs = args(body)?;
            let limit = a.limit.clamp(1, 500);
            let ids = repos.registry.ids_after(a.after.as_deref(), limit).await?;
            let next = (ids.len() == limit as usize).then(|| ids.last().cloned()).flatten();
            reply(&IdPage { ids, next })
        }
        // The raw meters of the git store, for reconciling with Cloudflare
        // (meters.rs, scripts/ops/gitstore-usage.mjs).
        "artifacts_usage" => {
            let a: meters::UsageArgs = args(body)?;
            reply(&meters::usage(&repos.registry.db, &a).await?)
        }
        "operation_mapping" => reply(&meters::read_mapping(&repos.registry.db).await?),
        // Billing: the workspace each pull request's working copy is counted
        // for, so Cloudflare's own count of `pulls--<id>` shares out too.
        "pull_owners" => {
            #[derive(serde::Deserialize)]
            struct PullOwnersArgs {
                pulls: Vec<String>,
            }
            let a: PullOwnersArgs = args(body)?;
            let pulls: Vec<String> = a.pulls.into_iter().take(500).collect();
            reply(&serde_json::json!({ "owners": meters::pull_owners(&repos.registry.db, &pulls).await? }))
        }
        // Services only: which meters are operations, changed without a deploy.
        "set_operation_mapping" => {
            let row: meters::MappingRow = args(body)?;
            meters::set_mapping(&repos.registry.db, &row, &rfc3339(now_ms())).await?;
            reply(&meters::read_mapping(&repos.registry.db).await?)
        }
        // Backups (backups.rs): the runner's sweep claims queued ones, and
        // each sandbox, through the API, asks for its job and says how it went.
        "claim_backups" => {
            let a: g1t_contracts::backups::ClaimBackupsArgs = args(body)?;
            let blobs = backups::storage(&env);
            reply(&backups::claim(&repos.registry.db, blobs.as_ref(), &a, now_ms()).await?)
        }
        "backup_spec" => match backups::storage(&env) {
            Some(blobs) => {
                let a: g1t_contracts::backups::BackupJobArgs = args(body)?;
                let every = backups::Settings::from_env(&env).full_every;
                reply(&backups::spec(&repos.registry, &blobs, &repos.store, &a, every, now_ms()).await?)
            }
            None => reply(&backups_off::<bool>()),
        },
        "backup_complete" => match backups::storage(&env) {
            Some(blobs) => reply(&backups::complete(&repos.registry, &blobs, &args(body)?, now_ms()).await?),
            None => reply(&backups_off::<bool>()),
        },
        "backup_fail" => match backups::storage(&env) {
            Some(blobs) => reply(&backups::fail(&repos.registry.db, &blobs, &args(body)?).await?),
            None => reply(&backups_off::<bool>()),
        },
        // How the git store has been answering, for the status page.
        "store_health" => {
            let a: meters::HealthArgs = args(body)?;
            reply(&meters::health(&repos.registry.db, &a).await?)
        }
        // Where repositories may be kept, for a workspace's settings.
        "storage_options" => reply(&repos.storage_options()),
        // Services and operators only: how each namespace stands, and
        // moving a repository between them (namespaces.rs, moves.rs).
        "namespaces" => reply(&repos.standings().await?),
        "move_repository" => reply(&repos.move_repository(args(body)?).await?),
        "repository_moves" => {
            let a: moves::ListMovesArgs = args(body)?;
            reply(&repos.registry.moves(a.limit.unwrap_or(50)).await?)
        }
        _ => Response::error("Unknown method", 404),
    } }
    .await;
    // The git store is busy: said in words, with when to try again.
    let answered = match answered {
        Err(error) => match resilience::busy(&error.to_string()) {
            Some(busy) if OUTCOME_READS.contains(&method.as_str()) => {
                reply(&Outcome::<()>::fail(FailureCode::Conflict, busy.message().trim()))
            }
            Some(busy) => {
                let response = Response::error(busy.message(), 503)?;
                response.headers().set("retry-after", &busy.retry_after.to_string())?;
                Ok(response)
            }
            None => Err(error),
        },
        answered => answered,
    };
    repos.deferred.hand_over(&ctx);
    flush_later(&env, &ctx);
    slow_answer(&method, now_ms().saturating_sub(started));
    served.finish(answered)
}

/// RPC answers this slow are logged with how long the answer took.
const SLOW_RPC_MS: u64 = 1_000;

/// Logs an RPC answer that took [`SLOW_RPC_MS`] or more, as a JSON line
/// Workers Logs keeps as fields (`rpc`, `answered_ms`). An invocation's
/// wall time there also counts what `ctx.wait_until` does after the
/// answer, which here includes waiting up to `meters::FLUSH_EVERY_MS` to
/// write the meters (`flush_later`), so it reads as seconds for answers
/// that took milliseconds; `answered_ms` is the time the caller waited,
/// as the `svc` entry of the answer's `server-timing` says.
fn slow_answer(method: &str, took: u64) {
    if took >= SLOW_RPC_MS {
        worker::console_log!("{}", serde_json::json!({ "rpc": method, "answered_ms": took }));
    }
}

/// The nightly cron in wrangler.jsonc: tonight's backups are queued.
const BACKUP_CRON: &str = "53 2 * * *";

/// The hourly sweep: deleted repositories whose time to be restored has
/// passed are purged. See lifecycle.rs. And, at [`BACKUP_CRON`], the
/// repositories whose refs moved are queued for a backup (backups.rs).
#[event(scheduled)]
async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let repos = match service(&env) {
        Ok(repos) => repos,
        Err(error) => {
            worker::console_error!("repos: the sweep could not start: {error}");
            return;
        }
    };
    if event.cron() == BACKUP_CRON {
        let Some(blobs) = backups::storage(&env) else { return };
        match backups::nightly(&repos.registry.db, &blobs, backups::Settings::from_env(&env), now_ms()).await {
            Ok(night) => worker::console_log!("repos: queued {} backups, removed {} of purged repositories", night.queued, night.pruned),
            Err(error) => worker::console_error!("repos: backups could not be queued: {error}"),
        }
        return;
    }
    match repos.purge_due(PurgeDueArgs::default()).await {
        Ok(0) => {}
        Ok(count) => worker::console_log!("repos: purged {count} deleted repositories"),
        Err(error) => worker::console_error!("repos: the purge sweep failed: {error}"),
    }
    // Pull requests' working copies whose time has come (forks.rs).
    match repos.retire_due().await {
        Ok(0) => {}
        Ok(count) => worker::console_log!("repos: removed {count} pull request working copies"),
        Err(error) => worker::console_error!("repos: the working copy sweep failed: {error}"),
    }
    // Private forks whose makers can no longer read where they came from
    // (network.rs).
    match repos.check_private_forks().await {
        Ok(0) => {}
        Ok(count) => worker::console_log!("repos: deleted {count} private forks their makers can no longer read the source of"),
        Err(error) => worker::console_error!("repos: the private fork sweep failed: {error}"),
    }
    // Repositories moving between namespaces, and old copies (moves.rs).
    match repos.run_moves().await {
        Ok(0) => {}
        Ok(count) => worker::console_log!("repos: moved {count} repositories between namespaces"),
        Err(error) => worker::console_error!("repos: the move sweep failed: {error}"),
    }
    meters::flush(&repos.registry.db).await;
}

/// Events from the bus. A workspace's rename: its repositories move to the
/// workspace's current slug, asked of identity by id, so a repeated or late
/// delivery lands in the same place; their git store keys stay as they
/// were. A workspace's deletion: its repositories are deleted with it,
/// restored with it, or purged with it.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, ctx: Context) -> Result<()> {
    let registry = Registry { db: Rc::new(env.d1("DB")?) };
    let identity = env.service("IDENTITY")?;
    let handled = handle_events(&batch, &env, &registry, &identity).await;
    flush_later(&env, &ctx);
    handled
}

/// Each event is acknowledged or retried on its own, so one that fails is
/// tried again without the others before and after it running twice.
async fn handle_events(batch: &MessageBatch<Event>, env: &Env, registry: &Registry, identity: &Fetcher) -> Result<()> {
    for message in batch.messages()? {
        match handle_event(message.body(), env, registry, identity).await {
            Ok(()) => message.ack(),
            Err(error) => {
                worker::console_error!("repos: event {} failed: {error}", message.body().id);
                message.retry();
            }
        }
    }
    Ok(())
}

async fn handle_event(event: &Event, env: &Env, registry: &Registry, identity: &Fetcher) -> Result<()> {
    // A pull request merged, closed or reopened: its working copy is
    // kept or let go (forks.rs).
    if let Some(change) = forks::pull_change(&event.kind) {
        let Some(pull_id) = forks::pull_id_of(&event.data) else {
            worker::console_error!("{} {} names no pull request", event.kind, event.id);
            return Ok(());
        };
        let repos = service(env)?;
        match change {
            forks::PullChange::Settled => repos.pull_settled(&pull_id).await?,
            forks::PullChange::Reopened => repos.pull_reopened(&pull_id).await?,
        }
        return Ok(());
    }
    // A workspace deleted, restored or purged: its repositories go with
    // it, come back with it, or are purged with it (lifecycle.rs).
    if event.kind == "workspace.deleting" {
        match serde_json::from_value::<WorkspaceDeleting>(event.data.clone()) {
            Ok(deleting) => service(env)?.delete_with_workspace(&deleting, &protected_workspaces(env)).await?,
            Err(_) => worker::console_error!("workspace.deleting {} could not be read", event.id),
        }
        return Ok(());
    }
    if event.kind == "workspace.restored" {
        match serde_json::from_value::<WorkspaceRestored>(event.data.clone()) {
            Ok(restored) => service(env)?.restore_with_workspace(&restored).await?,
            Err(_) => worker::console_error!("workspace.restored {} could not be read", event.id),
        }
        return Ok(());
    }
    if event.kind == "workspace.deleted" {
        match serde_json::from_value::<WorkspaceDeleted>(event.data.clone()) {
            Ok(deleted) => service(env)?.purge_workspace(&deleted, &protected_workspaces(env)).await?,
            Err(_) => worker::console_error!("workspace.deleted {} could not be read", event.id),
        }
        return Ok(());
    }
    // An account deleted or restored: kept contributors that name it
    // (or ghost, for a restore) are worked out again, so it shows as
    // ghost for its 30 days, and as itself again if restored.
    if let Some(needle) = stats::shown_differently(&event.kind, &event.data) {
        let db = env.d1("DB")?;
        if let Err(error) = stats::rework_naming(&db, &needle).await {
            worker::console_error!("{} {}: contributors not marked to be counted again: {error}", event.kind, event.id);
        }
        return Ok(());
    }
    if event.kind != "workspace.renamed" {
        return Ok(());
    }
    let Ok(renamed) = serde_json::from_value::<WorkspaceRenamed>(event.data.clone()) else {
        worker::console_error!("workspace.renamed {} could not be read", event.id);
        return Ok(());
    };
    let names: HashMap<String, String> = g1t_kit::call(
        identity,
        "usernames",
        &g1t_contracts::identity::UsernamesArgs {
            ids: vec![renamed.workspace_id.clone()],
        },
    )
    .await?;
    let current = names
        .get(&renamed.workspace_id)
        .cloned()
        .unwrap_or_else(|| renamed.to.clone());
    let left = registry
        .rename_namespace(&renamed.stale_slugs(&current), &current)
        .await?;
    if left > 0 {
        worker::console_error!(
            "{left} repositories stayed under {} or {}: {current} already has repositories of the same names",
            renamed.from,
            renamed.to
        );
    }
    Ok(())
}

/// The workspaces whose repositories never go with a deletion, whatever is
/// published: `PROTECTED_WORKSPACES` if set here, and Flagon's always.
fn protected_workspaces(env: &Env) -> Vec<String> {
    let configured = env.var("PROTECTED_WORKSPACES").ok().map(|v| v.to_string());
    g1t_contracts::identity::protected_names(configured.as_deref())
}

/// What a token's own limits say about git on the repository `repo`
/// (`owner/name`), before anyone's role is asked: why it is refused, or
/// `None`. `source` is the repository a pull request's working copy at
/// `repo` belongs to, which a workflow job's token reaches too. `public`
/// is whether anyone may read it, and `exists` whether there is one.
///
/// A job's token and a deploy key reach their own repository only. Its
/// scopes decide the rest: `code:read` to read a private repository,
/// `code:write` to push, which a read-only deploy key never has. A deploy
/// key never makes a repository by pushing to an empty address.
pub(crate) fn git_token_refusal(
    access: &g1t_contracts::scopes::TokenAccess,
    repo: &str,
    source: Option<&str>,
    write: bool,
    public: bool,
    exists: bool,
) -> Option<String> {
    if let Some(refused) = g1t_contracts::scopes::decide_repo(access, repo)
        && !source.is_some_and(|source| access.reaches(source))
    {
        return Some(refused.reason.unwrap_or_default());
    }
    let decision = g1t_contracts::scopes::decide_git(access, write, public);
    if !decision.allowed {
        return Some(decision.reason.unwrap_or_default());
    }
    if access.deploy_key.is_some() && !exists {
        return Some(format!("This deploy key is for {repo}, which is not there any more."));
    }
    // A token narrowed to chosen repositories, or to another workspace, never
    // makes one outside them by pushing to an empty address.
    if write
        && !exists
        && let Some(reach) = &access.reach
    {
        let namespace = repo.split('/').next().unwrap_or_default();
        let all = reach.repositories == g1t_contracts::scopes::RepositorySelection::All;
        if !all || !reach.workspace.as_deref().is_some_and(|w| w.eq_ignore_ascii_case(namespace)) {
            return Some(format!(
                "This access token cannot create {repo}: it reaches only the repositories chosen for it. Create the repository on g1t.sh, then add it to the token."
            ));
        }
    }
    None
}

/// The repository a push to a path that does not exist yet creates: private,
/// so nothing pushed by mistake is published. An owner makes it public on
/// purpose (`POST /repos/{owner}/{repo}/visibility`).
fn push_to_create(owner: &User, path: &RepoPath) -> CreateArgs {
    CreateArgs {
        owner: owner.clone(),
        namespace: path.namespace.clone(),
        name: path.name.clone(),
        is_private: true,
        import_url: None,
        import_token: None,
    }
}

/// Whether `delete_branch` may remove `branch`: one of g1t's own
/// (`g1t-…`), or one whose tip the caller names, such as a dependency
/// update's branch after its pull request closed.
fn deletable_branch(branch: &str, head: Option<&str>) -> bool {
    !branch.is_empty() && (branch.starts_with(G1T_BRANCH_PREFIX) || head.is_some_and(|head| !head.is_empty()))
}

#[cfg(test)]
mod delete_branch_tests {
    use super::deletable_branch;

    #[test]
    fn only_g1t_branches_or_a_named_tip_are_deleted() {
        assert!(deletable_branch("g1t-queue-12", None));
        assert!(!deletable_branch("g1t/security/sharp-0.35.5", None));
        assert!(deletable_branch("g1t/security/sharp-0.35.5", Some("abc123")));
        assert!(!deletable_branch("feature", Some("")));
        assert!(!deletable_branch("", Some("abc123")));
    }
}

#[cfg(test)]
mod announced_refs_tests {
    use super::*;

    fn pushed(git_ref: String) -> git_http::Pushed {
        git_http::Pushed { git_ref, before: None, after: "abc".into() }
    }

    fn refs(announced: Vec<&git_http::Pushed>) -> Vec<&str> {
        announced.into_iter().map(|pushed| pushed.git_ref.as_str()).collect()
    }

    #[test]
    fn a_few_tags_are_announced_and_many_are_not() {
        let few: Vec<_> = (1..=3).map(|n| pushed(format!("refs/tags/v{n}"))).chain([pushed("refs/heads/main".into())]).collect();
        assert_eq!(refs(announced_refs(&few, "main")), ["refs/heads/main", "refs/tags/v1", "refs/tags/v2", "refs/tags/v3"]);
        let many: Vec<_> = (1..=10_000).map(|n| pushed(format!("refs/tags/v{n}"))).chain([pushed("refs/heads/main".into())]).collect();
        assert_eq!(refs(announced_refs(&many, "main")), ["refs/heads/main"]);
    }

    #[test]
    fn past_the_branch_cap_only_the_default_branch_is_announced() {
        let at_cap: Vec<_> = (0..MAX_PUSH_BRANCH_EVENTS).map(|n| pushed(format!("refs/heads/b{n}"))).collect();
        assert_eq!(announced_refs(&at_cap, "main").len(), MAX_PUSH_BRANCH_EVENTS);
        let over: Vec<_> = (0..=MAX_PUSH_BRANCH_EVENTS)
            .map(|n| pushed(format!("refs/heads/b{n}")))
            .chain([pushed("refs/heads/main".into())])
            .collect();
        assert_eq!(refs(announced_refs(&over, "main")), ["refs/heads/main"]);
        assert!(announced_refs(&over, "trunk").is_empty());
    }
}

#[cfg(test)]
mod push_about_tests {
    use super::*;

    fn push(refs: &[&str], fork_of: Option<&str>) -> PushDone {
        let repo: Repo = serde_json::from_value(serde_json::json!({
            "id": "rep_1", "namespace": "acme", "name": "web", "isPrivate": false,
            "ownerId": "usr_1", "defaultBranch": "main", "forkOf": fork_of, "createdAt": ""
        }))
        .unwrap();
        PushDone {
            repo,
            pushed: refs.iter().map(|git_ref| git_http::Pushed { git_ref: (*git_ref).into(), before: None, after: "abc".into() }).collect(),
            deleted: Vec::new(),
            pack_bytes: 0,
            actor: None,
            unscanned: false,
            caused_by_job: None,
            credit: None,
            agent: None,
        }
    }

    #[test]
    fn a_push_to_the_default_branch_works_out_the_about() {
        assert!(about_after_push(&push(&["refs/heads/main"], None)).is_some());
        assert!(about_after_push(&push(&["refs/heads/topic", "refs/heads/main"], None)).is_some());
        assert!(about_after_push(&push(&["refs/heads/topic"], None)).is_none());
        assert!(about_after_push(&push(&["refs/tags/main"], None)).is_none());
        // A pull request's working copy has no About.
        assert!(about_after_push(&push(&["refs/heads/main"], Some("rep_0"))).is_none());
    }

    #[test]
    fn a_push_about_reads_only_within_what_is_left() {
        assert_eq!(push_about_budget(0), Some(PUSH_ABOUT_BY_MS));
        assert_eq!(push_about_budget(4_000), Some(PUSH_ABOUT_BY_MS - 4_000));
        assert_eq!(push_about_budget(PUSH_ABOUT_BY_MS - MIN_PUSH_ABOUT_MS), Some(MIN_PUSH_ABOUT_MS));
        assert_eq!(push_about_budget(PUSH_ABOUT_BY_MS - MIN_PUSH_ABOUT_MS + 1), None);
        assert_eq!(push_about_budget(60_000), None);
    }
}

#[cfg(test)]
mod push_to_create_tests {
    use super::*;

    #[test]
    fn a_pushed_repository_starts_private() {
        let owner: User = serde_json::from_value(serde_json::json!({ "id": "usr_1", "username": "ada" })).unwrap();
        let args = push_to_create(&owner, &RepoPath { namespace: "acme".into(), name: "site".into() });
        assert!(args.is_private);
        assert_eq!((args.namespace.as_str(), args.name.as_str()), ("acme", "site"));
    }

    fn token(repositories: &str, workspace: Option<&str>) -> g1t_contracts::scopes::TokenAccess {
        serde_json::from_value(serde_json::json!({
            "token_id": "tok_1",
            "scopes": ["code:read", "code:write"],
            "fine_grained": { "workspace": workspace, "repositories": repositories, "repo_ids": ["rep_plugins"] },
        }))
        .unwrap()
    }

    #[test]
    fn a_token_for_chosen_repositories_never_creates_one_by_pushing() {
        let why = git_token_refusal(&token("selected", Some("acme")), "acme/new", None, true, false, false).unwrap();
        assert!(why.contains("cannot create acme/new"), "{why}");
        // It still pushes to a repository that is there; its selection is
        // the role check's.
        assert_eq!(git_token_refusal(&token("selected", Some("acme")), "acme/plugins", None, true, false, true), None);
    }

    #[test]
    fn a_token_for_all_of_a_workspace_creates_there_and_nowhere_else() {
        assert_eq!(git_token_refusal(&token("all", Some("acme")), "Acme/new", None, true, false, false), None);
        assert!(git_token_refusal(&token("all", Some("acme")), "other/new", None, true, false, false).is_some());
        assert!(git_token_refusal(&token("public", Some("acme")), "acme/new", None, true, false, false).is_some());
        assert!(git_token_refusal(&token("all", None), "acme/new", None, true, false, false).is_some());
    }

    #[test]
    fn a_token_without_a_reach_creates_as_its_owner_would() {
        let wide: g1t_contracts::scopes::TokenAccess =
            serde_json::from_value(serde_json::json!({ "token_id": "tok_1", "scopes": ["code:write"] })).unwrap();
        assert_eq!(git_token_refusal(&wide, "acme/new", None, true, false, false), None);
    }
}

#[cfg(test)]
mod deploy_key_git_tests {
    use super::*;
    use g1t_contracts::deploy_keys;

    fn key(read_only: bool) -> User {
        deploy_keys::principal("wsp_acme", "acme", deploy_keys::access("dk_1", "CI", "acme/rocket", read_only))
    }

    fn rocket(private: bool) -> Repo {
        serde_json::from_value(serde_json::json!({
            "id": "rep_rocket",
            "namespace": "acme",
            "name": "rocket",
            "isPrivate": private,
            "ownerId": "usr_owner",
            "defaultBranch": "main",
            "forkOf": null,
            "protected": false,
            "createdAt": "",
        }))
        .unwrap()
    }

    fn refusal(user: &User, repo: &str, write: bool, exists: bool) -> Option<String> {
        git_token_refusal(user.token.as_deref().unwrap(), repo, None, write, false, exists)
    }

    #[test]
    fn a_read_only_deploy_key_clones_its_repository_and_never_pushes() {
        let user = key(true);
        assert_eq!(refusal(&user, "acme/rocket", false, true), None);
        assert!(refusal(&user, "acme/rocket", true, true).unwrap().contains("read-only"));
        // Its role is a workspace token's: it reads a private repository.
        assert!(registry::can_read(&rocket(true), &Some(user)));
    }

    #[test]
    fn a_deploy_key_with_write_access_pushes_to_its_repository() {
        let user = key(false);
        assert_eq!(refusal(&user, "acme/rocket", true, true), None);
        assert!(registry::can_write(&rocket(true), &Some(user)));
    }

    #[test]
    fn a_deploy_key_reaches_no_other_repository() {
        let user = key(false);
        for other in ["acme/booster", "other/rocket"] {
            for write in [false, true] {
                let why = refusal(&user, other, write, true).expect(other);
                assert!(why.contains("deploy key is for acme/rocket"), "{why}");
            }
        }
        // Not even a pull request's working copy of another repository.
        let token = user.token.as_deref().unwrap();
        assert!(git_token_refusal(token, "pulls/pr_1", Some("acme/booster"), false, false, true).is_some());
    }

    #[test]
    fn a_deploy_key_never_creates_a_repository() {
        let why = refusal(&key(false), "acme/rocket", true, false).unwrap();
        assert!(why.contains("not there"), "{why}");
    }
}
