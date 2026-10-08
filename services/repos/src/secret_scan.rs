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
use g1t_scan::pack::{ObjectKind, Pack, TreeItem, encode_tree, pack_start};
use g1t_scan::protection::{self, Blocked};
use worker::{Response, Result};

use crate::registry::store_key;
use crate::store::{GitRepo, GitStore};

/// Where people allow a secret: the project's Security page.
const SITE: &str = "https://g1t.sh";
/// A push adding more commits than this is scanned for this many of them.
const MAX_PUSH_COMMITS: usize = 300;
/// Files compared per commit, at most.
const MAX_FILES_PER_COMMIT: usize = 300;
/// Bases fetched from the store for a thin pack, at most.
const MAX_BASES: usize = 500;
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
struct Objects<'a, R: GitRepo> {
    pack: &'a Pack,
    repo: &'a R,
    reads: Cell<u32>,
}

impl<R: GitRepo> Objects<'_, R> {
    async fn tree(&self, id: &str) -> Result<Vec<TreeItem>> {
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

    async fn commit_tree(&self, id: &str) -> Result<Option<String>> {
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
        let read = try_join_all(batch.iter().map(|change| async move {
            let new = objects.blob(&change.new).await?;
            let old = match (&change.old, &new) {
                (Some(old), Some(_)) => objects.blob(old).await?,
                _ => None,
            };
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

/// Fetches what a thin pack's deltas are based on from the repository.
async fn supply_bases<R: GitRepo>(pack: &mut Pack, repo: &R) -> Result<()> {
    for _ in 0..3 {
        let missing = pack.missing_bases();
        if missing.is_empty() {
            return Ok(());
        }
        let found = try_join_all(missing.iter().take(MAX_BASES).map(|id| async move {
            // A base is nearly always a blob; failing that, a tree.
            if let Ok(Some(bytes)) = repo.read_blob(id).await {
                return Ok::<_, worker::Error>(Some((ObjectKind::Blob, bytes)));
            }
            Ok(repo.read_tree(id).await.ok().flatten().map(|entries| {
                let items: Vec<TreeItem> = entries
                    .into_iter()
                    .map(|entry| TreeItem { mode: mode(entry.kind).to_owned(), name: entry.name, id: entry.hash })
                    .collect();
                (ObjectKind::Tree, encode_tree(&items))
            }))
        }))
        .await?;
        let mut progress = false;
        for (id, object) in missing.iter().zip(found) {
            if let Some((kind, data)) = object {
                pack.supply(id, kind, data);
                progress = true;
            }
        }
        if !progress {
            return Ok(());
        }
    }
    Ok(())
}

/// The secrets the commits in a push add, each secret once. A push too
/// large to read is an error ([`unscannable`]): it is declined, never let
/// through unread. A pack that cannot be read for another reason is let
/// through, and said so in the logs; the store will judge it.
pub async fn scan_push<R: GitRepo>(repo: &R, body: &[u8], patterns: &[Compiled]) -> Result<Vec<NewSecret>> {
    if body.len() > MAX_SCANNED_PUSH {
        return Err(worker::Error::RustError(format!("{UNSCANNABLE} {} bytes", body.len())));
    }
    let Some(start) = pack_start(body) else {
        return Ok(Vec::new());
    };
    let mut pack = match Pack::parse(&body[start..]) {
        Ok(pack) => pack,
        Err(problem) if problem.contains("too large") => {
            return Err(worker::Error::RustError(format!("{UNSCANNABLE} {problem}")));
        }
        Err(problem) => {
            worker::console_error!("push not scanned for secrets: {problem}");
            return Ok(Vec::new());
        }
    };
    supply_bases(&mut pack, repo).await?;
    if pack.unresolved() > 0 {
        worker::console_error!("{} objects of a push could not be resolved for scanning", pack.unresolved());
    }
    let objects = Objects { pack: &pack, repo, reads: Cell::new(0) };
    let commits: Vec<String> = pack.commits().iter().take(MAX_PUSH_COMMITS).cloned().collect();
    let mut found = Vec::new();
    let mut seen_blobs = HashSet::new();
    let mut seen_secrets = HashSet::new();
    for id in commits {
        let Some(commit) = pack.commit(&id) else { continue };
        let old_tree = match commit.parents.first() {
            Some(parent) => objects.commit_tree(parent).await?,
            None => None,
        };
        // Only content the push brings is new; a blob the repository has
        // was looked at when it arrived.
        let changes: Vec<Change> = changed_files(&objects, old_tree, commit.tree)
            .await?
            .into_iter()
            .filter(|change| pack.contains(&change.new) && seen_blobs.insert((change.path.clone(), change.new.clone())))
            .collect();
        for secret in scan_changes(&objects, &id, changes, patterns).await? {
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
pub fn exposed_address(body: &[u8], guard: &PushEmailGuard) -> Option<(String, String)> {
    if body.len() > MAX_SCANNED_PUSH {
        return None;
    }
    let pack = Pack::parse(&body[pack_start(body)?..]).ok()?;
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
    async fn push_email_guard(&self, pusher: Option<&User>) -> Option<PushEmailGuard> {
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

    /// Push protection: the response refusing a push that adds secrets
    /// nobody has allowed, or that would publish the pusher's private
    /// address, or `None` to let it through.
    /// `repo` is the repository pushed to, as the request read it.
    pub(crate) async fn protect(&self, repo: &Repo, pusher: Option<&User>, body: &[u8]) -> Result<Option<Response>> {
        // A pull request's findings belong to the repository it was made from.
        let owner = match &repo.fork_of {
            Some(id) => self.registry.by_id(id).await?.unwrap_or(repo.clone()),
            None => repo.clone(),
        };
        // Asking identity about the pusher's address and scanning the push
        // do not depend on each other, so they happen at once.
        let scan = async {
            let patterns = compiled(&self.patterns_for(&owner).await);
            let git = self.store.open(&store_key(repo)).await?;
            scan_push(&git, body, &patterns).await
        };
        let (guard, found) = futures_util::future::join(self.push_email_guard(pusher), scan).await;
        if let Some(guard) = guard
            && let Some((commit, email)) = exposed_address(body, &guard)
        {
            return Ok(Some(crate::git_http::declined(
                body,
                "push would publish a private email",
                &exposed_message(&commit, &email, &guard.noreply),
            )?));
        }
        let found = match found {
            Err(error) if unscannable(&error) => {
                let (reason, messages) = crate::git_http::size_refusal(&crate::git_http::SizeViolation::Unscannable {
                    size: body.len() as u64,
                    cap: MAX_SCANNED_PUSH,
                });
                return Ok(Some(crate::git_http::declined(body, &reason, &messages)?));
            }
            found => found?,
        };
        if found.is_empty() {
            return Ok(None);
        }
        let blocked = self.blocked(&owner, pusher, found).await;
        if blocked.is_empty() {
            return Ok(None);
        }
        Ok(Some(crate::git_http::declined(
            body,
            &protection::reason(&blocked),
            &protection::explain(&blocked),
        )?))
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
    }

    impl GitRepo for FakeRepo {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, _limit: u32) -> Result<Vec<Commit>> {
            Ok(self.commits.get(git_ref).cloned().into_iter().collect())
        }
        async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(self.commits.get(commit_hash).map(|commit| commit.parents.clone()))
        }
        async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
            Ok(self.trees.get(tree_hash).cloned())
        }
        async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
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
