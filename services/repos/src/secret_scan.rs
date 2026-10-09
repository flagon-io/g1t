//! Looking for secrets in git: in what a push adds, before it is stored
//! (push protection), and in a repository's history, a page at a time, for
//! the security service. Also finds the lockfiles it reads dependencies
//! from. What counts as a secret is `g1t_scan`'s business.
//!
//! Push protection also keeps a person's private address out of what they
//! push, when they asked g1t to (see [`exposed_address`]).
//!
//! Custom patterns (the security suite's) are looked for alongside the
//! built-in formats, in pushes, history and files committed through g1t
//! itself; the security service says which apply ([`Repos::patterns_for`]).
//! It can also run a pattern over the default branch for a dry run
//! ([`Repos::match_pattern`]), and ask a landed secret's issuer whether it
//! still works ([`Repos::check_secret`]), without the value ever leaving
//! this service except to that issuer.

use std::cell::Cell;
use std::collections::{HashSet, VecDeque};

use futures_util::future::try_join_all;
use g1t_contracts::User;
use g1t_contracts::accounts::{CommitIdentityArgs, PushEmailGuard, mask_email};
use g1t_contracts::repos::{EntryKind, Repo, RepoPath};
use g1t_contracts::security::{
    FindLockfilesArgs, HistoryPage, LockfileText, Lockfiles, NewSecret, PushBlockedArgs, PushVerdict,
    ScanHistoryArgs,
};
use g1t_contracts::security_suite::{CheckSecretArgs, MatchPatternArgs, PatternMatch, PatternMatches, PatternSpec, PatternsForArgs, SecretValidity};
use g1t_scan::custom::{self, Compiled};
use g1t_scan::lockfiles::Lockfile;
use g1t_scan::pack::{ObjectKind, Pack, TreeItem, encode_tree};
use g1t_scan::protection::{self, Blocked};
use worker::Result;

use crate::registry::store_key;
use crate::store::{GitRepo, GitStore};

/// Where people allow a secret: the project's Security page.
const SITE: &str = "https://g1t.sh";
/// A push adding more commits than this is scanned for this many of them.
const MAX_PUSH_COMMITS: usize = 300;
/// Files compared per commit, at most.
const MAX_FILES_PER_COMMIT: usize = 300;
/// Bases fetched from the store for a thin pack, at most, in all rounds
/// together. Each is one or two store reads, each with a Cache API look.
const MAX_BASES: usize = 200;
/// Bases asked for at a time (two reads each when the pack does not say
/// whether a base is a blob or a tree).
const BASES_AT_ONCE: usize = 16;
/// The largest push that is read whole and scanned. A larger one is
/// declined, since it cannot be checked (git_http.rs `LargePushes`).
pub const MAX_SCANNED_PUSH: usize = 24 * 1024 * 1024;
/// What marks an error as a push too large to scan.
const UNSCANNABLE: &str = "push-unscannable:";

/// Whether an error says the push was too large to scan.
pub fn unscannable(error: &worker::Error) -> bool {
    error.to_string().contains(UNSCANNABLE)
}
const READS_AT_ONCE: usize = 16;
/// Directories never searched for lockfiles.
const SKIPPED_DIRECTORIES: [&str; 8] = ["node_modules", "vendor", "target", ".git", "dist", "build", "third_party", ".venv"];
const MAX_LOCKFILES: usize = 40;
const MAX_LOCKFILE_DEPTH: usize = 4;
const MAX_LOCKFILE_BYTES: usize = 16 * 1024 * 1024;

fn mode(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Tree => "40000",
        EntryKind::Blob => "100644",
        EntryKind::Exec => "100755",
        EntryKind::Symlink => "120000",
        EntryKind::Gitlink => "160000",
    }
}

/// Objects for a walk: the pushed pack's first, then the repository's.
pub(crate) struct Objects<'a, R: GitRepo> {
    pub(crate) pack: &'a Pack,
    pub(crate) repo: &'a R,
    pub(crate) reads: Cell<u32>,
}

impl<R: GitRepo> Objects<'_, R> {
    pub(crate) async fn tree(&self, id: &str) -> Result<Vec<TreeItem>> {
        if let Some(items) = self.pack.tree(id) {
            return Ok(items);
        }
        self.reads.set(self.reads.get() + 1);
        Ok(self
            .repo
            .read_tree(id)
            .await?
            .unwrap_or_default()
            .into_iter()
            .map(|entry| TreeItem { mode: mode(entry.kind).to_owned(), name: entry.name, id: entry.hash })
            .collect())
    }

    async fn blob(&self, id: &str) -> Result<Option<Vec<u8>>> {
        if let Some(bytes) = self.pack.blob(id) {
            return Ok(Some(bytes.to_vec()));
        }
        self.reads.set(self.reads.get() + 1);
        self.repo.read_blob(id).await
    }

    pub(crate) async fn commit_tree(&self, id: &str) -> Result<Option<String>> {
        if let Some(commit) = self.pack.commit(id) {
            return Ok(Some(commit.tree));
        }
        self.reads.set(self.reads.get() + 1);
        Ok(self.repo.log(id, 1).await?.into_iter().next().map(|commit| commit.tree_hash))
    }
}

/// A file that differs between two trees: its path, the blob it was and
/// the blob it is.
struct Change {
    path: String,
    old: Option<String>,
    new: String,
}

/// The regular files whose content differs between two trees. Each level
/// is read at once; identical subtrees are skipped by id.
async fn changed_files<R: GitRepo>(objects: &Objects<'_, R>, old_root: Option<String>, new_root: String) -> Result<Vec<Change>> {
    let mut changes = Vec::new();
    let mut level = vec![(String::new(), old_root, new_root)];
    while !level.is_empty() && changes.len() < MAX_FILES_PER_COMMIT {
        let read = try_join_all(level.iter().map(|(_, old, new)| async move {
            let old = match old {
                Some(old) => objects.tree(old).await?,
                None => Vec::new(),
            };
            Ok::<_, worker::Error>((old, objects.tree(new).await?))
        }))
        .await?;
        let mut next = Vec::new();
        for ((prefix, _, _), (old, new)) in level.iter().zip(read) {
            for item in &new {
                let before = old.iter().find(|entry| entry.name == item.name);
                if before.is_some_and(|before| before.id == item.id) {
                    continue;
                }
                let path = format!("{prefix}{}", item.name);
                if item.is_tree() {
                    next.push((format!("{path}/"), before.filter(|b| b.is_tree()).map(|b| b.id.clone()), item.id.clone()));
                } else if item.is_file() && changes.len() < MAX_FILES_PER_COMMIT {
                    changes.push(Change {
                        path,
                        old: before.filter(|b| b.is_file()).map(|b| b.id.clone()),
                        new: item.id.clone(),
                    });
                }
            }
        }
        level = next;
    }
    Ok(changes)
}

/// The scanner's custom patterns, compiled; any that no longer compile are
/// skipped.
pub fn compiled(patterns: &[PatternSpec]) -> Vec<Compiled> {
    let specs: Vec<custom::PatternSpec> = patterns
        .iter()
        .map(|spec| custom::PatternSpec {
            id: spec.id.clone(),
            name: spec.name.clone(),
            pattern: spec.pattern.clone(),
            before: spec.before.clone(),
            after: spec.after.clone(),
        })
        .collect();
    custom::compile_all(&specs)
}

/// What a custom pattern found, as the security service records it.
fn custom_secret(hit: custom::CustomHit, path: &str, commit: &str) -> NewSecret {
    NewSecret {
        fingerprint: hit.fingerprint(),
        kind: custom::KIND.to_owned(),
        path: path.to_owned(),
        line: hit.line,
        commit: commit.to_owned(),
        preview: hit.preview(),
        test_value: None,
        pattern_id: Some(hit.pattern_id),
        pattern_name: Some(hit.pattern_name),
    }
}

/// How a sentence names a secret found: its format, or its pattern.
pub fn secret_label(secret: &NewSecret) -> Option<String> {
    if secret.kind == custom::KIND {
        return Some(custom::label(secret.pattern_name.as_deref().unwrap_or("custom")));
    }
    g1t_scan::secrets::SecretKind::parse(&secret.kind).map(|kind| kind.label().to_owned())
}

/// The secrets a new file holds, built-in and custom, for a commit made
/// through g1t rather than pushed.
pub fn scan_file(path: &str, bytes: &[u8], commit: &str, patterns: &[Compiled]) -> Vec<NewSecret> {
    let mut found: Vec<NewSecret> = protection::scan_change(path, None, bytes)
        .into_iter()
        .map(|hit| NewSecret {
            fingerprint: hit.fingerprint(),
            kind: hit.kind.id().to_owned(),
            path: path.to_owned(),
            line: hit.line,
            commit: commit.to_owned(),
            preview: hit.preview(),
            test_value: hit.test_value().map(str::to_owned),
            pattern_id: None,
            pattern_name: None,
        })
        .collect();
    found.extend(protection::scan_change_custom(path, None, bytes, patterns).into_iter().map(|hit| custom_secret(hit, path, commit)));
    found
}

/// The secrets each change adds, found `READS_AT_ONCE` files at a time.
async fn scan_changes<R: GitRepo>(objects: &Objects<'_, R>, commit: &str, changes: Vec<Change>, patterns: &[Compiled]) -> Result<Vec<NewSecret>> {
    let mut found = Vec::new();
    let changes: Vec<Change> = changes
        .into_iter()
        .filter(|change| !g1t_scan::secrets::skipped_path(&change.path))
        .collect();
    for batch in changes.chunks(READS_AT_ONCE) {
        // A change's old and new contents at once: the new is nearly always
        // in the pack, the old in the repository.
        let read = try_join_all(batch.iter().map(|change| async move {
            let old = async {
                match &change.old {
                    Some(old) => objects.blob(old).await,
                    None => Ok(None),
                }
            };
            let (new, old) = futures_util::future::try_join(objects.blob(&change.new), old).await?;
            Ok::<_, worker::Error>((new, old))
        }))
        .await?;
        for (change, (new, old)) in batch.iter().zip(read) {
            let Some(new) = new else { continue };
            for hit in protection::scan_change(&change.path, old.as_deref(), &new) {
                found.push(NewSecret {
                    fingerprint: hit.fingerprint(),
                    kind: hit.kind.id().to_owned(),
                    path: change.path.clone(),
                    line: hit.line,
                    commit: commit.to_owned(),
                    preview: hit.preview(),
                    test_value: hit.test_value().map(str::to_owned),
                    pattern_id: None,
                    pattern_name: None,
                });
            }
            for hit in protection::scan_change_custom(&change.path, old.as_deref(), &new, patterns) {
                found.push(custom_secret(hit, &change.path, commit));
            }
        }
    }
    Ok(found)
}

/// What [`supply_bases`] did for a pack.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bases {
    /// Bases the pack's deltas needed from outside it when it arrived: 0
    /// for a pack sent whole, as g1t asks for (`no-thin`, git_http.rs).
    pub missing: usize,
    /// Bases asked of the store, in every round.
    pub asked: usize,
    /// Bases still missing at the end: objects that stay unresolved.
    pub left: usize,
}

impl Bases {
    /// Whether the pack came thin, its deltas based on objects outside it.
    pub fn thin(&self) -> bool {
        self.missing > 0
    }
}

/// Fetches what a thin pack's deltas are based on from the repository.
/// A base the pack's own trees name is read as what they say it is; any
/// other is asked for as a blob and as a tree together, and whichever it
/// is answers.
///
/// g1t asks for packs without outside bases (`no-thin`), so this is for
/// clients that send thin ones anyway, and it is bounded: [`MAX_BASES`] in
/// all, over up to three rounds for delta chains, [`BASES_AT_ONCE`] at a
/// time. Asking for hundreds at once made a large thin push fan out into
/// as many store reads, and Cache API looks beside them, all in flight
/// together; the reads that failed were tried again and counted against
/// the store's breaker (store.rs `invoke`), which then turned every read
/// after them away, so the push was answered 503. A store that says it is
/// busy stops the reading here. Bases left missing leave their objects
/// unresolved, and the checks go on without them, as for any pack the
/// store cannot complete.
pub(crate) async fn supply_bases<R: GitRepo>(pack: &mut Pack, repo: &R) -> Result<Bases> {
    let mut bases = Bases { missing: pack.missing_bases().len(), ..Bases::default() };
    let mut busy = false;
    for _ in 0..3 {
        let missing = pack.missing_bases();
        if missing.is_empty() || busy || bases.asked >= MAX_BASES {
            break;
        }
        let named = pack.named_kinds();
        // A read that fails is a base not found, unless the store is busy,
        // which ends the reading.
        let settle = |read: Result<Option<(ObjectKind, Vec<u8>)>>| match read {
            Ok(found) => Ok(found),
            Err(error) if crate::resilience::busy(&error.to_string()).is_some() => Err(()),
            Err(_) => Ok(None),
        };
        let blob = async |id: &str| settle(repo.read_blob(id).await.map(|found| found.map(|bytes| (ObjectKind::Blob, bytes))));
        let tree = async |id: &str| {
            settle(repo.read_tree(id).await.map(|found| {
                found.map(|entries| {
                    let items: Vec<TreeItem> = entries
                        .into_iter()
                        .map(|entry| TreeItem { mode: mode(entry.kind).to_owned(), name: entry.name, id: entry.hash })
                        .collect();
                    (ObjectKind::Tree, encode_tree(&items))
                })
            }))
        };
        let wanted: Vec<&String> = missing.iter().take(MAX_BASES - bases.asked).collect();
        let mut progress = false;
        for batch in wanted.chunks(BASES_AT_ONCE) {
            let found = futures_util::future::join_all(batch.iter().map(|id| async {
                match named.get(id.as_str()) {
                    Some(ObjectKind::Tree) => tree(id).await,
                    Some(_) => blob(id).await,
                    None => {
                        let (as_blob, as_tree) = futures_util::future::join(blob(id), tree(id)).await;
                        match (as_blob, as_tree) {
                            (Ok(Some(found)), _) | (_, Ok(Some(found))) => Ok(Some(found)),
                            (Err(()), _) | (_, Err(())) => Err(()),
                            _ => Ok(None),
                        }
                    }
                }
            }))
            .await;
            bases.asked += batch.len();
            for (id, object) in batch.iter().zip(found) {
                match object {
                    Ok(Some((kind, data))) => {
                        pack.supply(id, kind, data);
                        progress = true;
                    }
                    Ok(None) => {}
                    Err(()) => busy = true,
                }
            }
            if busy {
                break;
            }
        }
        if !progress {
            break;
        }
    }
    bases.left = pack.missing_bases().len();
    Ok(bases)
}

/// The secrets the commits in a push add, each secret once. A push too
/// large to read is an error ([`unscannable`]): it is declined, never let
/// through unread. A pack that cannot be read for another reason is let
/// through, and said so in the logs; the store will judge it.
#[cfg(test)]
pub async fn scan_push<R: GitRepo>(repo: &R, body: &[u8], patterns: &[Compiled]) -> Result<Vec<NewSecret>> {
    if body.len() > MAX_SCANNED_PUSH {
        return Err(worker::Error::RustError(format!("{UNSCANNABLE} {} bytes", body.len())));
    }
    let mut pack = crate::push_checks::read_pack(body);
    if let Ok(pack) = &mut pack {
        supply_bases(pack, repo).await?;
    }
    scan_pack(repo, body.len(), &pack, patterns).await
}

/// [`scan_push`] for a push of `size` bytes whose pack was read already,
/// with its bases supplied (push_checks.rs).
pub(crate) async fn scan_pack<R: GitRepo>(repo: &R, size: usize, pack: &std::result::Result<Pack, String>, patterns: &[Compiled]) -> Result<Vec<NewSecret>> {
    if size > MAX_SCANNED_PUSH {
        return Err(worker::Error::RustError(format!("{UNSCANNABLE} {size} bytes")));
    }
    let pack = match pack {
        Ok(pack) => pack,
        Err(problem) if problem.contains("too large") => {
            return Err(worker::Error::RustError(format!("{UNSCANNABLE} {problem}")));
        }
        Err(problem) => {
            worker::console_error!("push not scanned for secrets: {problem}");
            return Ok(Vec::new());
        }
    };
    if pack.unresolved() > 0 {
        worker::console_error!("{} objects of a push could not be resolved for scanning", pack.unresolved());
    }
    let objects = Objects { pack, repo, reads: Cell::new(0) };
    let objects = &objects;
    let commits: Vec<(String, g1t_scan::pack::CommitInfo)> = pack
        .commits()
        .iter()
        .take(MAX_PUSH_COMMITS)
        .filter_map(|id| Some((id.clone(), pack.commit(id)?)))
        .collect();
    // The trees of the parents the pack does not hold, all read up front:
    // usually the one commit the push builds on.
    let mut outside: Vec<&String> = commits
        .iter()
        .filter_map(|(_, commit)| commit.parents.first())
        .filter(|parent| !pack.contains(parent))
        .collect();
    outside.sort();
    outside.dedup();
    let outside_trees: std::collections::HashMap<&String, Option<String>> = outside
        .iter()
        .copied()
        .zip(try_join_all(outside.iter().map(|parent| objects.commit_tree(parent))).await?)
        .collect();
    let outside_trees = &outside_trees;
    // What each commit changes, all read at once.
    let changed = try_join_all(commits.iter().map(|(_, commit)| async move {
        let old_tree = match commit.parents.first() {
            Some(parent) => match outside_trees.get(parent) {
                Some(tree) => tree.clone(),
                None => objects.commit_tree(parent).await?,
            },
            None => None,
        };
        changed_files(objects, old_tree, commit.tree.clone()).await
    }))
    .await?;
    let mut found = Vec::new();
    let mut seen_blobs = HashSet::new();
    let mut seen_secrets = HashSet::new();
    for ((id, _), changes) in commits.iter().zip(changed) {
        // Only content the push brings is new; a blob the repository has
        // was looked at when it arrived.
        let changes: Vec<Change> = changes
            .into_iter()
            .filter(|change| pack.contains(&change.new) && seen_blobs.insert((change.path.clone(), change.new.clone())))
            .collect();
        for secret in scan_changes(objects, id, changes, patterns).await? {
            if seen_secrets.insert(secret.fingerprint.clone()) {
                found.push(secret);
            }
        }
    }
    Ok(found)
}

/// A commit in a push that would publish one of the pusher's own
/// addresses while they keep it private: its id and the address. Only the
/// commits the push adds are read; anyone else's address is no concern
/// here. A pack that cannot be read is let through.
#[cfg(test)]
pub fn exposed_address(body: &[u8], guard: &PushEmailGuard) -> Option<(String, String)> {
    if body.len() > MAX_SCANNED_PUSH {
        return None;
    }
    exposed_in(&Pack::parse(&body[g1t_scan::pack::pack_start(body)?..]).ok()?, guard)
}

/// [`exposed_address`] for a pack read already.
pub(crate) fn exposed_in(pack: &Pack, guard: &PushEmailGuard) -> Option<(String, String)> {
    pack.commits().iter().find_map(|id| {
        let commit = pack.commit(id)?;
        [commit.author_email, commit.committer_email]
            .into_iter()
            .flatten()
            .find(|email| guard.exposes(email))
            .map(|email| (id.clone(), email))
    })
}

/// What git shows a person whose push would publish their private address.
pub fn exposed_message(commit: &str, email: &str, noreply: &str) -> Vec<String> {
    let short: String = commit.chars().take(7).collect();
    vec![
        format!(
            "push declined: commit {short} would publish {} while your email is private.",
            mask_email(&email.to_lowercase())
        ),
        format!("Commit with {noreply} (git config user.email {noreply}) and amend,"),
        format!("or change this in {}/settings/emails.", SITE.trim_start_matches("https://")),
    ]
}

impl<S: GitStore> crate::Repos<S> {
    /// What a push by `pusher` must not publish: their own addresses, when
    /// they keep them private and block such pushes. An agent's push is
    /// its person's. `None` when nothing is guarded, or identity cannot say.
    pub(crate) async fn push_email_guard(&self, pusher: Option<&User>) -> Option<PushEmailGuard> {
        let pusher = pusher?;
        let person = pusher.acting.as_ref().map_or(pusher.id.clone(), |acting| acting.on_behalf_of.id.clone());
        let identity = self.identity.as_ref()?;
        g1t_kit::call::<_, Option<PushEmailGuard>>(identity, "push_email_guard", &CommitIdentityArgs { user_id: person })
            .await
            .unwrap_or_else(|error| {
                worker::console_error!("push_email_guard failed: {error}");
                None
            })
    }

    /// The custom patterns the security service says `repo` is scanned
    /// with; none when it cannot say.
    pub(crate) async fn patterns_for(&self, repo: &Repo) -> Vec<PatternSpec> {
        let Some(security) = &self.security else { return Vec::new() };
        g1t_kit::call(
            security,
            "patterns_for",
            &PatternsForArgs { repo_id: repo.id.clone(), namespace: repo.namespace.clone(), private: Some(repo.is_private) },
        )
        .await
        .unwrap_or_else(|error| {
            worker::console_error!("patterns_for failed: {error}");
            Vec::new()
        })
    }

    /// Of `found` in a change to `owner`, the secrets nobody let through:
    /// the security service records them all and says which were allowed.
    pub(crate) async fn blocked(&self, owner: &Repo, pusher: Option<&User>, found: Vec<NewSecret>) -> Vec<Blocked> {
        let owner_path = RepoPath { namespace: owner.namespace.clone(), name: owner.name.clone() };
        let verdict = match &self.security {
            Some(security) => g1t_kit::call::<_, PushVerdict>(
                security,
                "push_blocked",
                &PushBlockedArgs {
                    repo_id: owner.id.clone(),
                    path: owner_path.clone(),
                    pusher: pusher.map(|user| user.username.clone()),
                    secrets: found.clone(),
                    private: Some(owner.is_private),
                },
            )
            .await
            .unwrap_or_else(|error| {
                worker::console_error!("push_blocked failed: {error}");
                PushVerdict::default()
            }),
            None => PushVerdict::default(),
        };
        found
            .iter()
            .filter(|secret| !verdict.allowed.contains(&secret.fingerprint))
            // A likely test value is recorded, never a reason to refuse.
            .filter(|secret| secret.test_value.is_none())
            .filter_map(|secret| {
                let label = secret_label(secret)?;
                let id = verdict.ids.iter().find(|(fingerprint, _)| *fingerprint == secret.fingerprint);
                Some(Blocked {
                    label,
                    path: secret.path.clone(),
                    line: secret.line,
                    commit: secret.commit.clone(),
                    // Where it can be bypassed with a reason, or allowed.
                    allow_url: id.map(|(_, id)| {
                        format!("{SITE}/{}/{}/security/secret-scanning/{id}", owner_path.namespace, owner_path.name)
                    }),
                })
            })
            .collect()
    }

    /// Push protection for a file committed through g1t (`commit_file`):
    /// the refusal, naming each secret and where to bypass it, or `None`.
    pub(crate) async fn protect_file(&self, repo: &Repo, actor: &User, path: &str, content: &[u8], commit: &str) -> Option<String> {
        let patterns = compiled(&self.patterns_for(repo).await);
        let found = scan_file(path, content, commit, &patterns);
        if found.is_empty() {
            return None;
        }
        let blocked = self.blocked(repo, Some(actor), found).await;
        if blocked.is_empty() {
            return None;
        }
        Some(protection::explain(&blocked).join("\n"))
    }

    /// A page of the default branch's history, scanned for secrets.
    pub(crate) async fn scan_history(&self, a: ScanHistoryArgs) -> Result<HistoryPage> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(HistoryPage::default());
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let limit = a.limit.clamp(1, 100);
        // A page of a pushed range starts at its newest commit, and the
        // history of the default branch at its head.
        let start = a.after.or(a.from).unwrap_or_else(|| repo.default_branch.clone());
        let mut commits = git.log(&start, limit + 1).await?;
        let mut next = (commits.len() > limit as usize).then(|| commits.pop().map(|commit| commit.hash)).flatten();
        // A range ends where the branch was before the push.
        if let Some(until) = a.until.as_deref()
            && let Some(at) = commits.iter().position(|commit| commit.hash == until)
        {
            commits.truncate(at);
            next = None;
        }
        if a.until.is_some() && next.as_deref() == a.until.as_deref() {
            next = None;
        }
        let empty = Pack::default();
        let objects = Objects { pack: &empty, repo: &git, reads: Cell::new(1) };
        let patterns = compiled(&a.patterns);
        let mut page = HistoryPage { next, ..HistoryPage::default() };
        let mut seen = HashSet::new();
        for (index, commit) in commits.iter().enumerate() {
            let old_tree = match commit.parents.first() {
                Some(parent) => match commits.get(index + 1).filter(|older| older.hash == *parent) {
                    Some(older) => Some(older.tree_hash.clone()),
                    None => objects.commit_tree(parent).await?,
                },
                None => None,
            };
            let changes = changed_files(&objects, old_tree, commit.tree_hash.clone()).await?;
            for secret in scan_changes(&objects, &commit.hash, changes, &patterns).await? {
                if seen.insert(secret.fingerprint.clone()) {
                    page.secrets.push(secret);
                }
            }
            page.commits += 1;
        }
        page.reads = objects.reads.get();
        Ok(page)
    }

    /// The lockfiles on the default branch, outside vendored directories.
    pub(crate) async fn find_lockfiles(&self, a: FindLockfilesArgs) -> Result<Lockfiles> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(Lockfiles::default());
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let at = a.git_ref.as_deref().unwrap_or(&repo.default_branch);
        let Some(head) = git.log(at, 1).await?.into_iter().next() else {
            return Ok(Lockfiles::default());
        };
        let mut found = Vec::new();
        let mut queue = VecDeque::from([(String::new(), head.tree_hash.clone(), 0usize)]);
        while let Some((prefix, tree, depth)) = queue.pop_front() {
            for entry in git.read_tree(&tree).await?.unwrap_or_default() {
                match entry.kind {
                    EntryKind::Tree if depth < MAX_LOCKFILE_DEPTH && !SKIPPED_DIRECTORIES.contains(&entry.name.as_str()) => {
                        queue.push_back((format!("{prefix}{}/", entry.name), entry.hash, depth + 1));
                    }
                    EntryKind::Blob if Lockfile::for_path(&entry.name).is_some() && found.len() < MAX_LOCKFILES => {
                        found.push((format!("{prefix}{}", entry.name), entry.hash));
                    }
                    _ => {}
                }
            }
        }
        let texts = try_join_all(found.iter().map(|(_, hash)| git.read_blob(hash))).await?;
        let files = found
            .into_iter()
            .zip(texts)
            .filter_map(|((path, _), bytes)| {
                let bytes = bytes.filter(|bytes| bytes.len() <= MAX_LOCKFILE_BYTES)?;
                Some(LockfileText { path, text: String::from_utf8(bytes).ok()? })
            })
            .collect();
        Ok(Lockfiles { commit: Some(head.hash), files })
    }

    /// A dry run of a custom pattern over the default branch's files, up to
    /// [`MATCH_FILES`] files and [`MATCH_BYTES`] of text, skipping what
    /// secret scanning skips. Nothing is recorded.
    pub(crate) async fn match_pattern(&self, a: MatchPatternArgs) -> Result<PatternMatches> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(PatternMatches::default());
        };
        let patterns = compiled(std::slice::from_ref(&a.pattern));
        let Some(pattern) = patterns.first() else {
            return Ok(PatternMatches::default());
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let Some(head) = git.log(&repo.default_branch, 1).await?.into_iter().next() else {
            return Ok(PatternMatches::default());
        };
        let mut result = PatternMatches { commit: Some(head.hash.clone()), ..PatternMatches::default() };
        let mut files = Vec::new();
        let mut queue = VecDeque::from([(String::new(), head.tree_hash.clone())]);
        while let Some((prefix, tree)) = queue.pop_front() {
            for entry in git.read_tree(&tree).await?.unwrap_or_default() {
                let path = format!("{prefix}{}", entry.name);
                match entry.kind {
                    EntryKind::Tree if !SKIPPED_DIRECTORIES.contains(&entry.name.as_str()) => queue.push_back((format!("{path}/"), entry.hash)),
                    EntryKind::Blob | EntryKind::Exec if !g1t_scan::secrets::skipped_path(&path) => {
                        if files.len() == MATCH_FILES {
                            result.truncated = true;
                        } else {
                            files.push((path, entry.hash));
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut bytes = 0usize;
        let limit = a.limit.clamp(1, 200) as usize;
        for batch in files.chunks(READS_AT_ONCE) {
            if bytes > MATCH_BYTES || result.matches.len() >= limit {
                result.truncated = true;
                break;
            }
            let read = try_join_all(batch.iter().map(|(_, hash)| git.read_blob(hash))).await?;
            for ((path, _), blob) in batch.iter().zip(read) {
                let Some(blob) = blob else { continue };
                bytes += blob.len();
                result.files_scanned += 1;
                let Some(text) = protection::text_of(path, &blob) else { continue };
                let lines: Vec<&str> = text.lines().collect();
                for hit in custom::scan_lines(text, std::slice::from_ref(pattern), |_| true) {
                    if result.matches.len() >= limit {
                        result.truncated = true;
                        break;
                    }
                    let line = lines.get(hit.line as usize - 1).copied().unwrap_or_default();
                    result.matches.push(PatternMatch { path: path.clone(), line: hit.line, preview: custom::masked_line(line, &hit.value) });
                }
            }
        }
        Ok(result)
    }

    /// Asks a landed secret's issuer whether it still works: finds it again
    /// by its fingerprint at `commit`:`path` near `line`, and makes the
    /// issuer's own read-only check over HTTPS. The value goes nowhere else.
    pub(crate) async fn check_secret(&self, a: CheckSecretArgs) -> Result<SecretValidity> {
        let unknown = |detail: &str| SecretValidity { validity: "unknown".to_owned(), detail: Some(detail.to_owned()) };
        let Some(kind) = g1t_scan::secrets::SecretKind::parse(&a.kind) else {
            return Ok(SecretValidity { validity: "unsupported".to_owned(), detail: None });
        };
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(unknown("no such repository"));
        };
        let git = self.store.open(&store_key(&repo)).await?;
        let Some(bytes) = git.read_file(&a.commit, &a.path).await? else {
            return Ok(unknown("the file is not at that commit"));
        };
        let Some(text) = protection::text_of(&a.path, &bytes) else {
            return Ok(unknown("the file cannot be read as text"));
        };
        let near = |line: u32| line + 2 >= a.line && line <= a.line + 2;
        let Some(hit) = g1t_scan::secrets::scan_lines(text, near).into_iter().find(|hit| hit.fingerprint() == a.fingerprint) else {
            return Ok(unknown("the secret is no longer where it was found"));
        };
        let Some(probe) = g1t_scan::validity::check_for(kind, &hit.value) else {
            return Ok(SecretValidity { validity: "unsupported".to_owned(), detail: None });
        };
        let headers = worker::Headers::new();
        headers.set("user-agent", "g1t secret validity check (+https://docs.g1t.sh/guides/security/secret-protection/)")?;
        for (name, value) in &probe.headers {
            headers.set(name, value)?;
        }
        let mut init = worker::RequestInit::new();
        init.with_method(if probe.method == "POST" { worker::Method::Post } else { worker::Method::Get }).with_headers(headers);
        if let Some(body) = &probe.body {
            init.with_body(Some(body.clone().into()));
        }
        let answer = async {
            let mut response = worker::Fetch::Request(worker::Request::new_with_init(probe.url, &init)?).send().await?;
            let status = response.status_code();
            let body = if probe.reader == g1t_scan::validity::Reader::SlackOk { response.text().await.unwrap_or_default() } else { String::new() };
            Ok::<_, worker::Error>((status, body))
        }
        .await;
        Ok(match answer {
            Ok((status, body)) => {
                let validity = g1t_scan::validity::read(probe.reader, kind, status, &body);
                SecretValidity {
                    validity: validity.as_str().to_owned(),
                    detail: (validity == g1t_scan::validity::Validity::Unknown).then(|| format!("the issuer answered {status}")),
                }
            }
            Err(error) => unknown(&format!("the issuer could not be reached: {error}")),
        })
    }
}

/// Files a dry run reads, at most, and text in all.
const MATCH_FILES: usize = 2_000;
const MATCH_BYTES: usize = 20 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, Commit, GitAccess, Signature, TreeEntry};
    use g1t_scan::pack::{ObjectKind, TreeItem, encode_tree, object_id};

    use super::*;
    use crate::store::Scope;

    /// Runs a future that never waits, as every call to the fake store is.
    fn run<F: Future>(future: F) -> F::Output {
        match pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the fake store never waits"),
        }
    }

    /// A repository held in memory.
    #[derive(Default)]
    struct FakeRepo {
        blobs: HashMap<String, Vec<u8>>,
        trees: HashMap<String, Vec<TreeEntry>>,
        commits: HashMap<String, Commit>,
        /// How often each kind of read was asked for.
        blob_reads: Cell<u32>,
        tree_reads: Cell<u32>,
        log_reads: Cell<u32>,
        /// Each read waits once before it answers, as a store's does, so
        /// that reads asked for together are in flight together.
        waits: bool,
        in_flight: Cell<u32>,
        most_in_flight: Cell<u32>,
        /// Every read fails as a busy store's does.
        busy: bool,
    }

    impl FakeRepo {
        async fn reading(&self) -> Result<()> {
            if self.busy {
                return Err(crate::resilience::Busy { rate_limited: true, retry_after: 5, read_only: false }.error("readBlob"));
            }
            if self.waits {
                self.in_flight.set(self.in_flight.get() + 1);
                self.most_in_flight.set(self.most_in_flight.get().max(self.in_flight.get()));
                YieldOnce(false).await;
                self.in_flight.set(self.in_flight.get() - 1);
            }
            Ok(())
        }
    }

    /// Waits once, then is ready.
    struct YieldOnce(bool);

    impl Future for YieldOnce {
        type Output = ();
        fn poll(mut self: std::pin::Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
            if self.0 {
                return Poll::Ready(());
            }
            self.0 = true;
            context.waker().wake_by_ref();
            Poll::Pending
        }
    }

    /// Runs a future to its end, polling it until it is ready.
    fn run_waiting<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
                return output;
            }
        }
    }

    impl GitRepo for FakeRepo {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, _limit: u32) -> Result<Vec<Commit>> {
            self.log_reads.set(self.log_reads.get() + 1);
            Ok(self.commits.get(git_ref).cloned().into_iter().collect())
        }
        async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(self.commits.get(commit_hash).map(|commit| commit.parents.clone()))
        }
        async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
            self.tree_reads.set(self.tree_reads.get() + 1);
            self.reading().await?;
            Ok(self.trees.get(tree_hash).cloned())
        }
        async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
            self.blob_reads.set(self.blob_reads.get() + 1);
            self.reading().await?;
            Ok(self.blobs.get(blob_hash).cloned())
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str) -> Result<()> {
            Ok(())
        }
    }

    /// Zlib with one stored (uncompressed) block, which is all a pack needs.
    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x78, 0x01, 0x01];
        let length = data.len() as u16;
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&(!length).to_le_bytes());
        out.extend_from_slice(data);
        let (mut a, mut b) = (1u32, 0u32);
        for byte in data {
            a = (a + u32::from(*byte)) % 65521;
            b = (b + a) % 65521;
        }
        out.extend_from_slice(&((b << 16) | a).to_be_bytes());
        out
    }

    fn header(code: u8, size: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut byte = (code << 4) | (size & 15) as u8;
        let mut rest = size >> 4;
        while rest > 0 {
            out.push(byte | 0x80);
            byte = (rest & 0x7f) as u8;
            rest >>= 7;
        }
        out.push(byte);
        out
    }

    fn raw_id(id: &str) -> Vec<u8> {
        id.as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    enum Entry {
        Whole(ObjectKind, Vec<u8>),
        /// A ref-delta: base id and delta.
        Delta(String, Vec<u8>),
    }

    /// A receive-pack request: one command, then the pack.
    fn push(entries: &[Entry]) -> Vec<u8> {
        let command = b"0000000000000000000000000000000000000000 4807077b296e6edbf410d55e72749d3e1170c291 refs/heads/main\0report-status side-band-64k\n";
        let mut body = format!("{:04x}", command.len() + 4).into_bytes();
        body.extend_from_slice(command);
        body.extend_from_slice(b"0000PACK");
        body.extend_from_slice(&2u32.to_be_bytes());
        body.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for entry in entries {
            match entry {
                Entry::Whole(kind, data) => {
                    let code = match kind {
                        ObjectKind::Commit => 1,
                        ObjectKind::Tree => 2,
                        ObjectKind::Blob => 3,
                        ObjectKind::Tag => 4,
                    };
                    body.extend(header(code, data.len()));
                    body.extend(zlib(data));
                }
                Entry::Delta(base, delta) => {
                    body.extend(header(7, delta.len()));
                    body.extend(raw_id(base));
                    body.extend(zlib(delta));
                }
            }
        }
        body.extend_from_slice(&[0u8; 20]);
        body
    }

    fn key() -> String {
        format!("AK{}", "IAZ7Q4N2XWLM3KDTRV")
    }

    fn commit(tree: &str, parent: Option<&str>) -> Vec<u8> {
        let parent = parent.map(|parent| format!("parent {parent}\n")).unwrap_or_default();
        format!("tree {tree}\n{parent}author A <a@example.com> 0 +0000\ncommitter A <a@example.com> 0 +0000\n\nchange\n").into_bytes()
    }

    #[test]
    fn a_first_push_with_a_secret_is_found_by_file_and_line() {
        let blob = format!("REGION=eu\nAWS_KEY={}\n", key()).into_bytes();
        let blob_id = object_id(ObjectKind::Blob, &blob);
        let tree = encode_tree(&[TreeItem { mode: "100644".into(), name: "config.env".into(), id: blob_id }]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let body = push(&[
            Entry::Whole(ObjectKind::Commit, commit(&tree_id, None)),
            Entry::Whole(ObjectKind::Tree, tree),
            Entry::Whole(ObjectKind::Blob, blob),
        ]);
        let found = run(scan_push(&FakeRepo::default(), &body, &[])).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].path.as_str(), found[0].line, found[0].kind.as_str()), ("config.env", 2, "aws_access_key"));
        assert!(found[0].preview.starts_with("AKIA") && !found[0].preview.contains(&key()));
    }

    #[test]
    fn a_thin_push_reports_only_the_lines_it_adds() {
        // The repository already has a file with a key in it (decided on
        // before); the push appends a line holding a second key.
        let old = format!("first={}\n", key()).into_bytes();
        let old_id = object_id(ObjectKind::Blob, &old);
        let second = format!("AK{}", "IAQ9W8E7R6T5Y4U3I2");
        let new = [old.clone(), format!("second={second}\n").into_bytes()].concat();
        let base_tree = vec![TreeEntry { name: "app.env".into(), hash: old_id.clone(), kind: EntryKind::Blob }];
        let base_tree_id = object_id(ObjectKind::Tree, &encode_tree(&[TreeItem { mode: "100644".into(), name: "app.env".into(), id: old_id.clone() }]));
        let parent_id = "c71546fcd893ef8b0f57388b65e620d759705dda".to_owned();
        let mut repo = FakeRepo::default();
        repo.blobs.insert(old_id.clone(), old.clone());
        repo.trees.insert(base_tree_id.clone(), base_tree);
        repo.commits.insert(
            parent_id.clone(),
            Commit {
                hash: parent_id.clone(),
                tree_hash: base_tree_id,
                message: String::new(),
                author: Signature { name: "A".into(), email: "a@example.com".into() },
                parents: Vec::new(),
                authored_at: String::new(),
            },
        );
        // A delta: copy the old file whole, then insert the new line.
        let added = format!("second={second}\n").into_bytes();
        let mut delta = vec![old.len() as u8, new.len() as u8, 0x80 | 0x10, old.len() as u8, added.len() as u8];
        delta.extend_from_slice(&added);
        let new_id = object_id(ObjectKind::Blob, &new);
        let tree = encode_tree(&[TreeItem { mode: "100644".into(), name: "app.env".into(), id: new_id }]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let body = push(&[
            Entry::Whole(ObjectKind::Commit, commit(&tree_id, Some(&parent_id))),
            Entry::Whole(ObjectKind::Tree, tree),
            Entry::Delta(old_id, delta),
        ]);
        let found = run(scan_push(&repo, &body, &[])).unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!((found[0].path.as_str(), found[0].line), ("app.env", 2));
    }

    #[test]
    fn a_base_is_asked_for_as_what_the_pack_names_it_or_both_ways_at_once() {
        // A file's old version, which no tree in the pack names: asked for
        // as a blob and as a tree together, and found as a blob.
        let old = b"one
".to_vec();
        let old_id = object_id(ObjectKind::Blob, &old);
        let mut repo = FakeRepo::default();
        repo.blobs.insert(old_id.clone(), old.clone());
        let mut delta = vec![old.len() as u8, (old.len() + 4) as u8, 0x80 | 0x10, old.len() as u8, 4];
        delta.extend_from_slice(b"two
");
        let body = push(&[Entry::Delta(old_id.clone(), delta)]);
        let mut pack = crate::push_checks::read_pack(&body).unwrap();
        run(supply_bases(&mut pack, &repo)).unwrap();
        assert_eq!(pack.unresolved(), 0);
        assert_eq!((repo.blob_reads.get(), repo.tree_reads.get()), (1, 1));

        // A directory the pack's root tree names as a tree: read as one.
        let file = object_id(ObjectKind::Blob, b"x");
        let listed = [TreeItem { mode: "100644".into(), name: "a".into(), id: file.clone() }];
        let sub = encode_tree(&listed);
        let sub_id = object_id(ObjectKind::Tree, &sub);
        let mut repo = FakeRepo::default();
        repo.trees.insert(sub_id.clone(), vec![TreeEntry { name: "a".into(), hash: file, kind: EntryKind::Blob }]);
        let root = encode_tree(&[TreeItem { mode: "40000".into(), name: "src".into(), id: sub_id.clone() }]);
        let delta = vec![sub.len() as u8, sub.len() as u8, 0x80 | 0x10, sub.len() as u8];
        let body = push(&[Entry::Whole(ObjectKind::Tree, root), Entry::Delta(sub_id, delta)]);
        let mut pack = crate::push_checks::read_pack(&body).unwrap();
        run(supply_bases(&mut pack, &repo)).unwrap();
        assert_eq!(pack.unresolved(), 0);
        assert_eq!((repo.blob_reads.get(), repo.tree_reads.get()), (0, 1));
    }

    #[test]
    fn a_pack_sent_whole_is_checked_without_reading_a_base() {
        // What git sends when told `no-thin`: a delta's base is in the pack
        // with it. Here the second file is a delta on the first.
        let first = b"REGION=eu
".to_vec();
        let first_id = object_id(ObjectKind::Blob, &first);
        let added = format!("AWS_KEY={}
", key()).into_bytes();
        let second = [first.clone(), added.clone()].concat();
        let mut delta = vec![first.len() as u8, second.len() as u8, 0x80 | 0x10, first.len() as u8, added.len() as u8];
        delta.extend_from_slice(&added);
        let tree = encode_tree(&[
            TreeItem { mode: "100644".into(), name: "a.env".into(), id: first_id.clone() },
            TreeItem { mode: "100644".into(), name: "b.env".into(), id: object_id(ObjectKind::Blob, &second) },
        ]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let body = push(&[
            Entry::Whole(ObjectKind::Commit, commit(&tree_id, None)),
            Entry::Whole(ObjectKind::Tree, tree),
            Entry::Whole(ObjectKind::Blob, first),
            Entry::Delta(first_id, delta),
        ]);
        let repo = FakeRepo::default();
        let mut pack = crate::push_checks::read_pack(&body).unwrap();
        let bases = run(supply_bases(&mut pack, &repo)).unwrap();
        assert_eq!(bases, Bases::default());
        assert!(!bases.thin());
        assert_eq!(pack.unresolved(), 0);
        let found = run(scan_pack(&repo, body.len(), &Ok(pack), &[])).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].path.as_str(), found[0].line), ("b.env", 2));
        // Nothing was read from the store: not a base, not a file.
        assert_eq!((repo.blob_reads.get(), repo.tree_reads.get(), repo.log_reads.get()), (0, 0, 0));
    }

    /// A pack of `count` deltas, each on a different base outside it.
    fn thin_pack(count: usize) -> Pack {
        let entries: Vec<Entry> = (1..=count)
            .map(|at| Entry::Delta(format!("{at:040x}"), vec![1, 2, 0x02, b'h', b'i']))
            .collect();
        crate::push_checks::read_pack(&push(&entries)).unwrap()
    }

    #[test]
    fn a_large_thin_push_reads_a_bounded_number_of_bases_a_few_at_a_time() {
        // 300 bases the store does not have, none named by a tree: before,
        // each round asked for 500 at once, two reads each, three rounds.
        let mut pack = thin_pack(300);
        let repo = FakeRepo { waits: true, ..FakeRepo::default() };
        let bases = run_waiting(supply_bases(&mut pack, &repo)).unwrap();
        assert_eq!(bases, Bases { missing: 300, asked: MAX_BASES, left: 300 });
        assert!(bases.thin());
        // Asked once each, as a blob and as a tree, and never more at once
        // than a batch's.
        assert_eq!((repo.blob_reads.get(), repo.tree_reads.get()), (MAX_BASES as u32, MAX_BASES as u32));
        assert_eq!(repo.most_in_flight.get(), 2 * BASES_AT_ONCE as u32);
    }

    #[test]
    fn a_busy_store_stops_the_reading_of_bases() {
        let mut pack = thin_pack(100);
        let repo = FakeRepo { busy: true, ..FakeRepo::default() };
        let bases = run(supply_bases(&mut pack, &repo)).unwrap();
        // One batch, then no more: the checks go on, and the store's own
        // answer to them says it is busy.
        assert_eq!(bases, Bases { missing: 100, asked: BASES_AT_ONCE, left: 100 });
        assert_eq!(repo.blob_reads.get(), BASES_AT_ONCE as u32);
    }

    #[test]
    fn the_commit_a_push_builds_on_is_read_once_however_many_commits_build_on_it() {
        // Two branches pushed at once, each one commit on the same parent.
        let parent_id = "c71546fcd893ef8b0f57388b65e620d759705dda".to_owned();
        let base_tree_id = object_id(ObjectKind::Tree, &[]);
        let mut repo = FakeRepo::default();
        repo.trees.insert(base_tree_id.clone(), Vec::new());
        repo.commits.insert(
            parent_id.clone(),
            Commit {
                hash: parent_id.clone(),
                tree_hash: base_tree_id,
                message: String::new(),
                author: Signature { name: "A".into(), email: "a@example.com".into() },
                parents: Vec::new(),
                authored_at: String::new(),
            },
        );
        let mut entries = Vec::new();
        for (name, line) in [("a.env", format!("KEY={}
", key())), ("b.txt", "nothing here
".to_owned())] {
            let blob = line.into_bytes();
            let tree = encode_tree(&[TreeItem { mode: "100644".into(), name: name.into(), id: object_id(ObjectKind::Blob, &blob) }]);
            entries.push(Entry::Whole(ObjectKind::Commit, commit(&object_id(ObjectKind::Tree, &tree), Some(&parent_id))));
            entries.push(Entry::Whole(ObjectKind::Tree, tree));
            entries.push(Entry::Whole(ObjectKind::Blob, blob));
        }
        let found = run(scan_push(&repo, &push(&entries), &[])).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "a.env");
        assert_eq!(repo.log_reads.get(), 1);
    }

    #[test]
    fn a_push_too_large_to_read_is_never_let_through_unread() {
        let body = vec![0u8; MAX_SCANNED_PUSH + 1];
        let error = run(scan_push(&FakeRepo::default(), &body, &[])).unwrap_err();
        assert!(unscannable(&error));
        let (reason, messages) = crate::git_http::size_refusal(&crate::git_http::SizeViolation::Unscannable {
            size: body.len() as u64,
            cap: MAX_SCANNED_PUSH,
        });
        assert_eq!(reason, "the push is too large to check for secrets");
        assert!(messages.iter().any(|line| line.contains("100.0 MB")));
        assert!(messages.iter().any(|line| line.contains("Push in parts")));
    }

    #[test]
    fn a_push_without_secrets_or_a_pack_finds_nothing() {
        let blob = b"fn main() {}\n".to_vec();
        let blob_id = object_id(ObjectKind::Blob, &blob);
        let tree = encode_tree(&[TreeItem { mode: "100644".into(), name: "main.rs".into(), id: blob_id }]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let body = push(&[
            Entry::Whole(ObjectKind::Commit, commit(&tree_id, None)),
            Entry::Whole(ObjectKind::Tree, tree),
            Entry::Whole(ObjectKind::Blob, blob),
        ]);
        assert!(run(scan_push(&FakeRepo::default(), &body, &[])).unwrap().is_empty());
        // A deletion sends commands and no pack.
        assert!(run(scan_push(&FakeRepo::default(), b"0000", &[])).unwrap().is_empty());
    }

    #[test]
    fn custom_patterns_are_found_in_a_push_and_a_committed_file() {
        let patterns = compiled(&[PatternSpec {
            id: "pat_1".into(),
            name: "Acme key".into(),
            pattern: "acme_[0-9a-f]{16}".into(),
            before: None,
            after: None,
        }]);
        let blob = b"token: acme_0123456789abcdef\n".to_vec();
        let blob_id = object_id(ObjectKind::Blob, &blob);
        let tree = encode_tree(&[TreeItem { mode: "100644".into(), name: "deploy.yml".into(), id: blob_id }]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let body = push(&[
            Entry::Whole(ObjectKind::Commit, commit(&tree_id, None)),
            Entry::Whole(ObjectKind::Tree, tree),
            Entry::Whole(ObjectKind::Blob, blob.clone()),
        ]);
        let found = run(scan_push(&FakeRepo::default(), &body, &patterns)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].kind.as_str(), found[0].pattern_id.as_deref(), found[0].line), ("custom_pattern", Some("pat_1"), 1));
        assert_eq!(secret_label(&found[0]).unwrap(), "a match for the custom pattern \"Acme key\"");
        assert!(!found[0].preview.contains("0123456789abcdef"));
        // Without the pattern, nothing.
        assert!(run(scan_push(&FakeRepo::default(), &body, &[])).unwrap().is_empty());
        // A file committed through g1t is scanned for both.
        let file = format!("{blob}AWS={}\n", key(), blob = String::from_utf8(blob).unwrap());
        let found = scan_file(".g1t/workflows/deploy.yml", file.as_bytes(), "c0ffee", &patterns);
        let kinds: Vec<&str> = found.iter().map(|secret| secret.kind.as_str()).collect();
        assert_eq!(kinds, ["aws_access_key", "custom_pattern"]);
    }

    #[test]
    fn a_push_carrying_the_pushers_private_address_is_declined_with_a_masked_address() {
        let tree = encode_tree(&[]);
        let tree_id = object_id(ObjectKind::Tree, &tree);
        let mine = format!("tree {tree_id}
author S <Sam@Gmail.com> 0 +0000
committer S <sam@gmail.com> 0 +0000

x
").into_bytes();
        let mine_id = object_id(ObjectKind::Commit, &mine);
        let guard = PushEmailGuard { emails: vec!["sam@gmail.com".into()], noreply: "1abc2def+sam@users.noreply.g1t.sh".into() };
        let body = push(&[Entry::Whole(ObjectKind::Commit, mine), Entry::Whole(ObjectKind::Tree, tree.clone())]);
        let (found, email) = exposed_address(&body, &guard).unwrap();
        assert_eq!(found, mine_id);
        let message = exposed_message(&found, &email, &guard.noreply);
        assert!(message[0].starts_with(&format!("push declined: commit {} would publish s***@gmail.com", &mine_id[..7])));
        assert!(message[1].contains("git config user.email 1abc2def+sam@users.noreply.g1t.sh"));
        assert!(message[2].contains("g1t.sh/settings/emails"));
        // Someone else's commits, and no pack at all, go through.
        let theirs = push(&[Entry::Whole(ObjectKind::Commit, commit(&tree_id, None)), Entry::Whole(ObjectKind::Tree, tree)]);
        assert_eq!(exposed_address(&theirs, &guard), None);
        assert_eq!(exposed_address(b"0000", &guard), None);
    }
}
