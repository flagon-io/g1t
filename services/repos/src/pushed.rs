//! `pushed`: what a push to a branch brought into it. Work asks after each
//! push, to mark merged the pull requests whose heads it brought in, as a
//! merge from the site would, and to land the work items its commits' messages
//! name after a closing keyword (work's pushed.rs).
//!
//! One walk from the new head, every parent followed, stopping at what the
//! branch held before: its first-parent line and those commits' parents,
//! read in one `log`. A commit off that line that the branch already held
//! (a side branch merged long ago) can be taken for new when the push
//! merges it again; the pull request heads found are therefore checked
//! against the old head exactly before they are said to have landed.

use std::collections::{HashMap, HashSet, VecDeque};

use g1t_contracts::repos::{Commit, MAX_PUSHED, Pushed, PushedArgs, PushedCommit};
use worker::Result;

use crate::store::{GitRepo, GitStore};
use crate::{MAX_ANCESTRY, Repos, descends_from};

/// How many commits of a side line one read brings: a merged branch's
/// commits come in one `log` rather than one read each.
const SIDE_READ: u32 = 50;

impl<S: GitStore> Repos<S> {
    pub(crate) async fn pushed(&self, a: PushedArgs) -> Result<Pushed> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(Pushed::default());
        };
        let git = self.read_git(&repo).await?;
        brought_in(&git, a).await
    }
}

/// The commit a pushed branch or tag is announced at, once the store has
/// the push: `None` when the store kept it elsewhere (it can refuse one
/// ref and accept another).
///
/// A branch must be at the commit the push named. A tag reads back as the
/// commit it leads to, which for an annotated tag is not the tag object
/// the push named (`cli-v0.3.6`: tag accae3e8, commit 42a29574), so a tag
/// whose commit differs is taken as pushed unless what the push named is a
/// commit itself, and is announced at that commit, as `git.push` says its
/// `after` is. A tag the store cannot read back is taken as pushed.
///
/// Artifacts does not read an annotated tag's ref back at all, so the push
/// of `cli-v0.3.7` was announced at its tag object (a41bb238) and Actions
/// found no workflows there. With the store's ref advertisement
/// (`advertised`, refs.rs `all`), a tag is where the advertisement has it
/// and is announced at its peeled line (`refs/tags/v1^{}`), the commit.
pub(crate) async fn pushed_to<R: GitRepo>(
    git: &R,
    pushed: &crate::git_http::Pushed,
    advertised: Option<&[(String, String)]>,
) -> Result<Option<String>> {
    if let Some(branch) = pushed.branch() {
        let head = git.log(branch, 1).await?;
        return Ok(head.first().filter(|commit| commit.hash == pushed.after).map(|_| pushed.after.clone()));
    }
    if let Some(refs) = advertised {
        let at = |name: &str| refs.iter().find(|(advertised, _)| advertised == name).map(|(_, hash)| hash.clone());
        match at(&pushed.git_ref) {
            Some(hash) if hash == pushed.after => {
                return Ok(Some(at(&format!("{}^{{}}", pushed.git_ref)).or_else(|| pushed.peeled.clone()).unwrap_or(hash)));
            }
            // Left elsewhere: the store refused it.
            Some(_) => return Ok(None),
            // Not advertised yet, right after the push (v0.0.0-tagtest2):
            // the pack's own tag object says where it leads.
            None => {
                if let Some(commit) = &pushed.peeled {
                    return Ok(Some(commit.clone()));
                }
            }
        }
    } else if let Some(commit) = &pushed.peeled {
        return Ok(Some(commit.clone()));
    }
    let Ok(head) = git.log(&pushed.git_ref, 1).await else {
        return Ok(Some(pushed.after.clone()));
    };
    let Some(commit) = head.into_iter().next() else {
        return Ok(Some(pushed.after.clone()));
    };
    if commit.hash == pushed.after {
        return Ok(Some(commit.hash));
    }
    // A lightweight tag the store left at another commit.
    if let Ok(Some(_)) = git.parents(&pushed.after).await {
        return Ok(None);
    }
    Ok(Some(commit.hash))
}

/// [`Repos::pushed`] on one repository's commits.
pub(crate) async fn brought_in<R: GitRepo>(git: &R, a: PushedArgs) -> Result<Pushed> {
    let before = match &a.before {
        Some(before) => git.log(before, MAX_ANCESTRY).await?,
        None => Vec::new(),
    };
    // What the branch held: its line, and where each commit on it came from.
    let mut held: HashSet<&str> = HashSet::new();
    for commit in &before {
        held.insert(commit.hash.as_str());
        held.extend(commit.parents.iter().map(String::as_str));
    }
    let mut known: HashMap<String, Commit> = git
        .log(&a.after, MAX_PUSHED as u32 + 1)
        .await?
        .into_iter()
        .map(|commit| (commit.hash.clone(), commit))
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut new: Vec<Commit> = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::from([a.after.clone()]);
    while let Some(hash) = queue.pop_front() {
        if held.contains(hash.as_str()) || !seen.insert(hash.clone()) {
            continue;
        }
        if new.len() >= MAX_ANCESTRY as usize {
            break;
        }
        if !known.contains_key(&hash) {
            for commit in git.log(&hash, SIDE_READ).await? {
                known.entry(commit.hash.clone()).or_insert(commit);
            }
        }
        let Some(commit) = known.get(&hash) else { continue };
        queue.extend(commit.parents.iter().cloned());
        new.push(commit.clone());
    }
    let brought: HashSet<&str> = new.iter().map(|commit| commit.hash.as_str()).collect();
    let mut landed = Vec::new();
    for head in &a.heads {
        if landed.contains(head) || !brought.contains(head.as_str()) {
            continue;
        }
        // Taken for new, but held all along off the old line.
        if !before.is_empty() && descends_from(git, &before, head).await? {
            continue;
        }
        landed.push(head.clone());
    }
    // A new branch brought nothing to tell anyone about: its commits were
    // pushed elsewhere first. The default branch's first push is the
    // exception: nothing was pushed before it.
    let commits = if a.messages && (a.before.is_some() || a.first) {
        new.iter()
            .take(MAX_PUSHED)
            .rev()
            .map(|commit| PushedCommit { hash: commit.hash.clone(), message: commit.message.clone() })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Pushed { landed, commits })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, GitAccess, Signature, TreeEntry};

    use super::*;
    use crate::store::Scope;

    fn run<F: Future>(future: F) -> F::Output {
        match pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the fake store never waits"),
        }
    }

    fn commit(hash: &str, parents: &[&str]) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: format!("t{hash}"),
            message: format!("commit {hash}"),
            author: Signature { name: "a".into(), email: "a@example.com".into() },
            parents: parents.iter().map(|&p| p.to_owned()).collect(),
            authored_at: "2026-10-14T00:00:00.000Z".into(),
        }
    }

    /// Commits by hash; `log` follows first parents only, as the store
    /// does, and `parents` answers for any commit. Counts `log` reads.
    #[derive(Default)]
    struct Fake {
        commits: HashMap<String, Commit>,
        /// Branches and tags by name, at the commit each leads to, as the
        /// store reads them back.
        refs: HashMap<String, String>,
        logs: RefCell<u32>,
    }

    impl Fake {
        fn with(commits: Vec<Commit>) -> Fake {
            Fake { commits: commits.into_iter().map(|c| (c.hash.clone(), c)).collect(), ..Fake::default() }
        }
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: Scope) -> Result<GitAccess> {
            unimplemented!()
        }
        async fn branches(&self) -> Result<Vec<Branch>> {
            Ok(Vec::new())
        }
        async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
            *self.logs.borrow_mut() += 1;
            let mut out = Vec::new();
            let git_ref = self.refs.get(git_ref).map_or(git_ref, String::as_str);
            let mut at = self.commits.get(git_ref);
            while let Some(commit) = at {
                if out.len() as u32 >= limit {
                    break;
                }
                out.push(commit.clone());
                at = commit.parents.first().and_then(|parent| self.commits.get(parent));
            }
            Ok(out)
        }
        async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
            Ok(self.commits.get(commit_hash).map(|commit| commit.parents.clone()))
        }
        async fn read_tree(&self, _tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
            Ok(None)
        }
        async fn read_blob(&self, _blob_hash: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn read_file(&self, _git_ref: &str, _path: &str) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        async fn fork(&self, _target_key: &str, _default_branch_only: bool) -> Result<()> {
            Ok(())
        }
    }

    fn args(before: Option<&str>, after: &str, heads: &[&str]) -> PushedArgs {
        PushedArgs {
            repo_id: "rep_1".into(),
            before: before.map(str::to_owned),
            after: after.into(),
            heads: heads.iter().map(|&h| h.to_owned()).collect(),
            messages: true,
            first: false,
        }
    }

    fn hashes(pushed: &Pushed) -> Vec<&str> {
        pushed.commits.iter().map(|c| c.hash.as_str()).collect()
    }

    /// m1 ← m2 on main; f1 ← f2 a branch off m2.
    fn history() -> Vec<Commit> {
        vec![commit("m1", &[]), commit("m2", &["m1"]), commit("f1", &["m2"]), commit("f2", &["f1"])]
    }

    #[test]
    fn a_fast_forward_brings_in_the_branch_and_its_head() {
        let git = Fake::with(history());
        let pushed = run(brought_in(&git, args(Some("m2"), "f2", &["f2", "f1", "m2"]))).unwrap();
        // f1 is a head too (a pull request stacked under the other).
        assert_eq!(pushed.landed, vec!["f2", "f1"]);
        assert_eq!(hashes(&pushed), vec!["f1", "f2"]);
    }

    #[test]
    fn a_merge_commit_brings_in_its_second_parent() {
        let mut commits = history();
        commits.extend([commit("m3", &["m2"]), commit("x", &["m3", "f2"])]);
        let git = Fake::with(commits);
        let pushed = run(brought_in(&git, args(Some("m3"), "x", &["f2"]))).unwrap();
        assert_eq!(pushed.landed, vec!["f2"]);
        assert_eq!(hashes(&pushed), vec!["f1", "f2", "x"]);
    }

    #[test]
    fn a_head_the_branch_already_held_did_not_land() {
        // g ← h merged into main long ago (m3); main went on to m4. A pull
        // request whose head is still g, and a push that merges g again.
        let commits = vec![
            commit("m1", &[]),
            commit("g", &["m1"]),
            commit("h", &["g"]),
            commit("m2", &["m1"]),
            commit("m3", &["m2", "h"]),
            commit("m4", &["m3"]),
            commit("y", &["m4", "g"]),
        ];
        let git = Fake::with(commits);
        let pushed = run(brought_in(&git, args(Some("m4"), "y", &["g", "m4"]))).unwrap();
        assert!(pushed.landed.is_empty());
        // A head that was never pushed elsewhere is not looked for at all.
        assert!(!hashes(&pushed).contains(&"m4"));
    }

    #[test]
    fn nothing_new_lands_nothing() {
        let git = Fake::with(history());
        let pushed = run(brought_in(&git, args(Some("f2"), "f2", &["f2"]))).unwrap();
        assert!(pushed.landed.is_empty() && pushed.commits.is_empty());
        // Moving back (a force push to an older commit) brings nothing in.
        let back = run(brought_in(&git, args(Some("f2"), "m2", &["m2"]))).unwrap();
        assert!(back.landed.is_empty() && back.commits.is_empty());
    }

    #[test]
    fn a_new_branch_lists_no_messages() {
        let git = Fake::with(history());
        let pushed = run(brought_in(&git, args(None, "f2", &["f2"]))).unwrap();
        assert_eq!(pushed.landed, vec!["f2"]);
        assert!(pushed.commits.is_empty());
    }

    #[test]
    fn the_default_branchs_first_push_lists_its_messages() {
        // An empty repository's first push: its `Closes #1` closes #1.
        let git = Fake::with(vec![commit("m1", &[]), commit("m2", &["m1"])]);
        let pushed = run(brought_in(&git, PushedArgs { first: true, ..args(None, "m2", &[]) })).unwrap();
        assert_eq!(hashes(&pushed), vec!["m1", "m2"]);
    }

    #[test]
    fn a_merged_branch_is_read_in_one_go() {
        // Twenty commits on a side branch merged in: one read of main and
        // one of the side line, not one per commit.
        let mut commits = vec![commit("m1", &[]), commit("m2", &["m1"])];
        commits.push(commit("s1", &["m1"]));
        for i in 2..=20 {
            commits.push(commit(&format!("s{i}"), &[&format!("s{}", i - 1)]));
        }
        commits.push(commit("x", &["m2", "s20"]));
        let git = Fake::with(commits);
        let pushed = run(brought_in(&git, args(Some("m2"), "x", &[]))).unwrap();
        assert_eq!(pushed.commits.len(), 21);
        assert_eq!(*git.logs.borrow(), 3);
    }

    fn push(git_ref: &str, before: Option<&str>, after: &str) -> crate::git_http::Pushed {
        crate::git_http::Pushed { git_ref: git_ref.into(), before: before.map(str::to_owned), after: after.into(), peeled: None }
    }

    #[test]
    fn an_annotated_tag_not_yet_advertised_is_announced_at_the_commit_its_pack_names() {
        // `git push origin v0.0.0-tagtest2`: the store neither logs nor
        // advertises the new tag yet; its object in the pack names main.
        let git = with_refs(&[("main", "m2")]);
        let refs = advertised(&[("refs/heads/main", "m2")]);
        let tag = crate::git_http::Pushed { peeled: Some("m2".into()), ..push("refs/tags/v0.0.0-tagtest2", None, "430024c2") };
        assert_eq!(run(pushed_to(&git, &tag, Some(&refs))).unwrap().as_deref(), Some("m2"));
        assert_eq!(run(pushed_to(&git, &tag, None)).unwrap().as_deref(), Some("m2"));
    }

    fn with_refs(refs: &[(&str, &str)]) -> Fake {
        Fake { refs: refs.iter().map(|&(name, at)| (name.to_owned(), at.to_owned())).collect(), ..Fake::with(history()) }
    }

    #[test]
    fn an_annotated_tag_is_announced_at_its_commit() {
        // `git push g1t cli-v0.3.6`: the push names the tag object, and the
        // store reads the tag back as the commit it leads to, main's head.
        let git = with_refs(&[("main", "m2"), ("refs/tags/cli-v0.3.6", "m2")]);
        let tag = push("refs/tags/cli-v0.3.6", None, "accae3e8");
        assert_eq!(run(pushed_to(&git, &tag, None)).unwrap().as_deref(), Some("m2"));
        // Moved by a new tag object.
        let moved = push("refs/tags/cli-v0.3.6", Some("accae3e8"), "b0b0b0b0");
        assert_eq!(run(pushed_to(&git, &moved, None)).unwrap().as_deref(), Some("m2"));
    }

    fn advertised(refs: &[(&str, &str)]) -> Vec<(String, String)> {
        refs.iter().map(|&(name, hash)| (name.to_owned(), hash.to_owned())).collect()
    }

    #[test]
    fn an_annotated_tag_the_store_cannot_log_is_announced_at_its_peeled_commit() {
        // `git push g1t cli-v0.3.7`: Artifacts logs nothing for the tag's
        // ref, and its advertisement has the tag object and the peeled commit.
        let git = with_refs(&[("main", "m2")]);
        let refs = advertised(&[("refs/heads/main", "m2"), ("refs/tags/cli-v0.3.7", "a41bb238"), ("refs/tags/cli-v0.3.7^{}", "m1")]);
        let tag = push("refs/tags/cli-v0.3.7", None, "a41bb238");
        assert_eq!(run(pushed_to(&git, &tag, Some(&refs))).unwrap().as_deref(), Some("m1"));
        // A lightweight tag has no peeled line: it is its commit.
        let refs = advertised(&[("refs/tags/v1", "f2")]);
        assert_eq!(run(pushed_to(&git, &push("refs/tags/v1", None, "f2"), Some(&refs))).unwrap().as_deref(), Some("f2"));
        // Left elsewhere: refused.
        assert_eq!(run(pushed_to(&git, &push("refs/tags/v1", Some("f2"), "m1"), Some(&refs))).unwrap(), None);
        // Not advertised yet, with nothing peeled: the log decides, as before.
        assert_eq!(run(pushed_to(&git, &push("refs/tags/v2", None, "m1"), Some(&refs))).unwrap().as_deref(), Some("m1"));
    }

    #[test]
    fn a_lightweight_tag_is_announced_where_the_store_has_it() {
        let git = with_refs(&[("refs/tags/v1", "f2")]);
        assert_eq!(run(pushed_to(&git, &push("refs/tags/v1", None, "f2"), None)).unwrap().as_deref(), Some("f2"));
        // The push named a commit the store did not move the tag to.
        assert_eq!(run(pushed_to(&git, &push("refs/tags/v1", Some("f2"), "m1"), None)).unwrap(), None);
        // A tag the store cannot read back is taken as pushed.
        assert_eq!(run(pushed_to(&git, &push("refs/tags/v2", None, "m1"), None)).unwrap().as_deref(), Some("m1"));
    }

    #[test]
    fn a_branch_is_announced_only_at_the_commit_pushed() {
        let git = with_refs(&[("main", "m2")]);
        assert_eq!(run(pushed_to(&git, &push("refs/heads/main", Some("m1"), "m2"), None)).unwrap().as_deref(), Some("m2"));
        assert_eq!(run(pushed_to(&git, &push("refs/heads/main", Some("m2"), "f2"), None)).unwrap(), None);
        assert_eq!(run(pushed_to(&git, &push("refs/heads/gone", None, "f2"), None)).unwrap(), None);
    }
}
