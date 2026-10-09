//! What rules about commits look at, read from a pack: each commit's
//! message, addresses, parents and signature, and the files it adds,
//! changes or deletes with their sizes. A push's pack is read before it is
//! stored; a pull request's commits are fetched as a pack from its source
//! (`inspect_commits`), so both are read by the same code.

use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};

use futures_util::future::{join_all, try_join_all};
use g1t_contracts::rules::{CommitFacts, FileChange, Signature};
use g1t_scan::pack::{ObjectKind, Pack};
use worker::Result;

use crate::secret_scan::Objects;
use crate::store::GitRepo;

/// Who registered each signing key (fingerprint to user id), and who
/// verified each address (to user id and username).
pub type Owners = (HashMap<String, String>, HashMap<String, (String, String)>);

/// The most commits read for one ref.
pub const MAX_COMMITS: usize = 300;
/// The most files listed for one commit; more is not complete.
pub const MAX_FILES: usize = 1000;
/// The most of a message kept.
const MAX_MESSAGE: usize = 4096;

/// A raw commit's headers and message.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CommitText {
    pub tree: String,
    pub parents: Vec<String>,
    pub author_email: Option<String>,
    pub committer_email: Option<String>,
    pub message: String,
}

fn email(value: &str) -> Option<String> {
    let start = value.rfind('<')?;
    let end = start + value[start..].find('>')?;
    Some(value[start + 1..end].trim().to_owned())
}

/// Reads a raw commit object.
pub fn read_commit(data: &[u8]) -> CommitText {
    let text = String::from_utf8_lossy(data);
    let (headers, message) = text.split_once("\n\n").unwrap_or((&text, ""));
    let mut commit = CommitText::default();
    for line in headers.split('\n') {
        if let Some(tree) = line.strip_prefix("tree ") {
            commit.tree = tree.trim().to_owned();
        } else if let Some(parent) = line.strip_prefix("parent ") {
            commit.parents.push(parent.trim().to_owned());
        } else if let Some(author) = line.strip_prefix("author ") {
            commit.author_email = email(author);
        } else if let Some(committer) = line.strip_prefix("committer ") {
            commit.committer_email = email(committer);
        }
    }
    let mut end = message.len().min(MAX_MESSAGE);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    commit.message = message[..end].to_owned();
    commit
}

/// The commits of the pack reachable from `tip` without leaving it,
/// newest first: what a push adds to a ref. `None` past `limit`.
pub fn added(pack: &Pack, tip: &str, limit: usize) -> Option<Vec<String>> {
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([tip.to_owned()]);
    let mut out = Vec::new();
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some((ObjectKind::Commit, data)) = pack.get(&id) else {
            continue;
        };
        out.push(id);
        if out.len() > limit {
            return None;
        }
        queue.extend(read_commit(data).parents);
    }
    Some(out)
}

/// The files that differ between two trees, deletions included, with the
/// size of each new blob the pack holds. Whether the list is complete.
/// Each level of the trees is read at once.
async fn changed<R: GitRepo>(objects: &Objects<'_, R>, old_root: Option<String>, new_root: Option<String>) -> Result<(Vec<FileChange>, bool)> {
    let mut files = Vec::new();
    let mut level: Vec<(String, Option<String>, Option<String>)> = vec![(String::new(), old_root, new_root)];
    while !level.is_empty() {
        let read = try_join_all(level.iter().map(|(_, old, new)| async move {
            let tree = async |id: &Option<String>| match id {
                Some(id) => objects.tree(id).await,
                None => Ok(Vec::new()),
            };
            futures_util::future::try_join(tree(old), tree(new)).await
        }))
        .await?;
        let mut next = Vec::new();
        for ((prefix, _, _), (old_items, new_items)) in level.into_iter().zip(read) {
            for item in &new_items {
                let before = old_items.iter().find(|entry| entry.name == item.name);
                if before.is_some_and(|before| before.id == item.id && before.mode == item.mode) {
                    continue;
                }
                let path = format!("{prefix}{}", item.name);
                if item.is_tree() {
                    next.push((format!("{path}/"), before.filter(|b| b.is_tree()).map(|b| b.id.clone()), Some(item.id.clone())));
                    // A file replaced by a directory is deleted.
                    if before.is_some_and(|b| !b.is_tree()) {
                        files.push(FileChange { path: path.clone(), size: None, deleted: true });
                    }
                } else {
                    let size = match objects.pack.get(&item.id) {
                        Some((ObjectKind::Blob, data)) => Some(data.len() as u64),
                        _ => None,
                    };
                    files.push(FileChange { path, size, deleted: false });
                    if let Some(before) = before.filter(|b| b.is_tree()) {
                        next.push((format!("{prefix}{}/", item.name), Some(before.id.clone()), None));
                    }
                }
            }
            for item in &old_items {
                if new_items.iter().any(|entry| entry.name == item.name) {
                    continue;
                }
                let path = format!("{prefix}{}", item.name);
                if item.is_tree() {
                    next.push((format!("{path}/"), Some(item.id.clone()), None));
                } else {
                    files.push(FileChange { path, size: None, deleted: true });
                }
            }
            if files.len() > MAX_FILES {
                files.truncate(MAX_FILES);
                return Ok((files, false));
            }
        }
        level = next;
    }
    Ok((files, true))
}

/// One commit of the pack, read as rules look at it. `signature` is what
/// was made of its signature, when one was asked for.
pub async fn facts<R: GitRepo>(objects: &Objects<'_, R>, id: &str, signature: Option<Signature>) -> Result<Option<CommitFacts>> {
    let Some((ObjectKind::Commit, data)) = objects.pack.get(id) else {
        return Ok(None);
    };
    let commit = read_commit(data);
    let old_tree = match commit.parents.first() {
        Some(parent) => objects.commit_tree(parent).await?,
        None => None,
    };
    let (files, files_complete) = changed(objects, old_tree, Some(commit.tree.clone())).await?;
    Ok(Some(CommitFacts {
        sha: id.to_owned(),
        message: commit.message,
        author_email: commit.author_email,
        committer_email: commit.committer_email,
        parents: commit.parents.len() as u32,
        signature: signature.unwrap_or_default(),
        files,
        files_complete,
    }))
}

/// Whether `old` is in the history of `new`: a fast-forward. Walks the
/// pack's commits, then the repository's history from where it leaves it,
/// reading the histories from each place it leaves at once.
pub async fn contains<R: GitRepo>(pack: &Pack, repo: &R, new: &str, old: &str, depth: u32) -> Result<bool> {
    if new == old {
        return Ok(true);
    }
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([new.to_owned()]);
    let mut boundary = Vec::new();
    while let Some(id) = queue.pop_front() {
        if id == old {
            return Ok(true);
        }
        if !seen.insert(id.clone()) || seen.len() > 5000 {
            continue;
        }
        match pack.get(&id) {
            Some((ObjectKind::Commit, data)) => queue.extend(read_commit(data).parents),
            _ => boundary.push(id),
        }
    }
    let histories = join_all(boundary.iter().take(20).map(|start| repo.log(start, depth))).await;
    if found_in(&histories, old) {
        return Ok(true);
    }
    // Merges: the history is first-parent only, so look along the second
    // parents it names too.
    let seconds: Vec<&String> = histories
        .iter()
        .flatten()
        .flat_map(|history| history.iter().filter(|commit| commit.parents.len() > 1).take(10))
        .flat_map(|commit| commit.parents.iter().skip(1))
        .collect();
    if seconds.iter().any(|parent| *parent == old) {
        return Ok(true);
    }
    let further = join_all(seconds.iter().map(|parent| repo.log(parent, depth))).await;
    if found_in(&further, old) {
        return Ok(true);
    }
    // Not found: a history that could not be read may have held it.
    for history in histories.into_iter().chain(further) {
        history?;
    }
    Ok(false)
}

/// Whether any history read holds `old`.
fn found_in(histories: &[Result<Vec<g1t_contracts::repos::Commit>>], old: &str) -> bool {
    histories.iter().flatten().any(|history| history.iter().any(|commit| commit.hash == old))
}

/// The signature fingerprints and committer addresses of commits, for
/// looking up who owns them.
pub fn signing_facts(pack: &Pack, ids: &[String]) -> (Vec<String>, Vec<String>) {
    let mut fingerprints = Vec::new();
    let mut emails = Vec::new();
    for id in ids {
        let Some((ObjectKind::Commit, data)) = pack.get(id) else { continue };
        if let Some(fingerprint) = crate::signatures::fingerprint(data)
            && !fingerprints.contains(&fingerprint)
        {
            fingerprints.push(fingerprint);
            if let Some(email) = read_commit(data).committer_email.map(|email| email.to_lowercase())
                && !emails.contains(&email)
            {
                emails.push(email);
            }
        }
    }
    (fingerprints, emails)
}

/// Every commit of `ids` read, with its signature decided against who
/// owns the keys and addresses (`owners`, when signatures matter). The
/// commits are read at once.
pub async fn read_all<R: GitRepo>(
    pack: &Pack,
    repo: &R,
    ids: &[String],
    owners: Option<&Owners>,
) -> Result<Vec<CommitFacts>> {
    let objects = Objects { pack, repo, reads: Cell::new(0) };
    let objects = &objects;
    let read = try_join_all(ids.iter().map(|id| async move {
        let signature = owners.and_then(|(keys, emails)| {
            let (_, data) = pack.get(id)?;
            let committer = read_commit(data).committer_email;
            Some(crate::signatures::decide(data, committer.as_deref(), keys, emails))
        });
        facts(objects, id, signature).await
    }))
    .await?;
    Ok(read.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_commit_reads_its_parents_addresses_and_message() {
        let raw = b"tree aaaa\nparent bbbb\nparent cccc\nauthor Ada Lovelace <ada@acme.com> 1 +0000\ncommitter G <noreply@g1t.sh> 1 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nfeat: rules\n\nWith a body.\n";
        let commit = read_commit(raw);
        assert_eq!(commit.tree, "aaaa");
        assert_eq!(commit.parents, vec!["bbbb", "cccc"]);
        assert_eq!(commit.author_email.as_deref(), Some("ada@acme.com"));
        assert_eq!(commit.committer_email.as_deref(), Some("noreply@g1t.sh"));
        assert_eq!(commit.message, "feat: rules\n\nWith a body.\n");
    }

    #[test]
    fn a_long_message_is_cut_on_a_character() {
        let message = "é".repeat(5000);
        let raw = format!("tree a\n\n{message}");
        assert!(read_commit(raw.as_bytes()).message.len() <= MAX_MESSAGE);
    }

    #[test]
    fn the_commits_a_push_adds_are_those_its_pack_holds() {
        use g1t_scan::pack::write_pack;
        let first = b"tree t\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\none\n".to_vec();
        let first_id = g1t_scan::pack::object_id(ObjectKind::Commit, &first);
        let second = format!("tree t\nparent {first_id}\nparent {}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\ntwo\n", "f".repeat(40)).into_bytes();
        let second_id = g1t_scan::pack::object_id(ObjectKind::Commit, &second);
        let pack = Pack::parse(&write_pack(&[(ObjectKind::Commit, first), (ObjectKind::Commit, second)])).unwrap();
        assert_eq!(added(&pack, &second_id, 10), Some(vec![second_id.clone(), first_id.clone()]));
        assert_eq!(added(&pack, &second_id, 1), None, "past the limit");
        assert_eq!(added(&pack, &"0".repeat(40), 10), Some(Vec::new()), "a tip the pack does not hold adds nothing");
    }

    /// Histories by where they start; a start missing from it fails.
    struct Histories(HashMap<String, Vec<g1t_contracts::repos::Commit>>);

    impl GitRepo for Histories {
        async fn access(&self, _scope: crate::store::Scope) -> Result<g1t_contracts::repos::GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<g1t_contracts::repos::Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, _limit: u32) -> Result<Vec<g1t_contracts::repos::Commit>> {
            self.0.get(git_ref).cloned().ok_or_else(|| worker::Error::RustError(format!("no history from {git_ref}")))
        }
        async fn parents(&self, _commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(None)
        }
        async fn read_tree(&self, _tree_hash: &str) -> Result<Option<Vec<g1t_contracts::repos::TreeEntry>>> {
            Ok(None)
        }
        async fn read_blob(&self, _blob_hash: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str) -> Result<()> {
            Ok(())
        }
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        let waker = std::task::Waker::noop();
        match std::pin::pin!(future).as_mut().poll(&mut std::task::Context::from_waker(waker)) {
            std::task::Poll::Ready(output) => output,
            std::task::Poll::Pending => panic!("the fake store never waits"),
        }
    }

    fn at(hash: &str, parents: &[&str]) -> g1t_contracts::repos::Commit {
        g1t_contracts::repos::Commit {
            hash: hash.to_owned(),
            tree_hash: String::new(),
            message: String::new(),
            author: g1t_contracts::repos::Signature { name: "A".into(), email: "a@x".into() },
            parents: parents.iter().map(|parent| (*parent).to_owned()).collect(),
            authored_at: String::new(),
        }
    }

    #[test]
    fn a_fast_forward_is_found_along_the_history_and_its_merges() {
        use g1t_scan::pack::write_pack;
        // The push brings one commit on top of `base`; `base` merged `side`,
        // whose history holds `old`.
        let (base, side, old) = ("b".repeat(40), "5".repeat(40), "0".repeat(40));
        let tip = format!("tree t
parent {base}
author A <a@x> 1 +0000
committer A <a@x> 1 +0000

tip
").into_bytes();
        let tip_id = g1t_scan::pack::object_id(ObjectKind::Commit, &tip);
        let pack = Pack::parse(&write_pack(&[(ObjectKind::Commit, tip)])).unwrap();
        let mut histories = HashMap::new();
        histories.insert(base.clone(), vec![at(&base, &["1".repeat(40).as_str(), side.as_str()])]);
        histories.insert(side.clone(), vec![at(&side, &[]), at(&old, &[])]);
        let repo = Histories(histories);
        assert!(run(contains(&pack, &repo, &tip_id, &old, 100)).unwrap());
        assert!(run(contains(&pack, &repo, &tip_id, &side, 100)).unwrap(), "a second parent itself");
        assert!(!run(contains(&pack, &repo, &tip_id, &"9".repeat(40), 100)).unwrap());
        // A history that cannot be read does not hide one found elsewhere,
        // and is an error only when nothing was found.
        let mut histories = repo.0;
        histories.remove(&side);
        let repo = Histories(histories);
        assert!(run(contains(&pack, &repo, &tip_id, &side, 100)).unwrap());
        assert!(run(contains(&pack, &repo, &tip_id, &old, 100)).is_err());
    }
}
