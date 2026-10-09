//! Workflow files: a token adds, changes or deletes files under
//! `.g1t/workflows/` or `.github/workflows/` only with the
//! `workflow_files:write` scope (a token's Workflow files: write
//! permission). A workflow job's token never may. Without the gate, a token
//! that can push code could write a workflow that runs with the
//! repository's secrets and a stronger token than its own.
//!
//! A push is checked commit by commit: every commit it adds is compared
//! with its first parent, looking only at the two workflow directories, so
//! the check is complete however many other files a commit changes. A push
//! too large to be read whole is refused for such a token, since what it
//! holds cannot be checked. A signed-in person (no token) is never refused
//! here, and neither is a token that has the scope: their roles and the
//! repository's rules decide.

use std::cell::Cell;

use g1t_contracts::User;
use g1t_contracts::scopes::{TokenAccess, WORKFLOW_DIRS, decide_workflow_files};
use g1t_scan::pack::{ObjectKind, Pack, TreeItem};
use worker::Result;

use crate::rule_facts::{self, MAX_COMMITS};
use crate::secret_scan::Objects;
use crate::store::GitRepo;

/// The token behind a push or an edit, when it is one this gate checks:
/// any token without `workflow_files:write`, and every job's token.
pub(crate) fn gated(actor: Option<&User>) -> Option<&TokenAccess> {
    let token = actor?.token.as_deref()?;
    decide_workflow_files(Some(token), [WORKFLOW_DIRS[0]]).map(|_| token)
}

/// The id of the tree at `dir` (such as `.github/workflows/`) under the
/// tree `root`, if there is one.
async fn subtree<R: GitRepo>(objects: &Objects<'_, R>, root: &str, dir: &str) -> Result<Option<String>> {
    let mut id = root.to_owned();
    for part in dir.trim_end_matches('/').split('/') {
        let items = objects.tree(&id).await?;
        match items.into_iter().find(|item| item.name == part && item.is_tree()) {
            Some(item) => id = item.id,
            None => return Ok(None),
        }
    }
    Ok(Some(id))
}

/// The first entry that differs between two listings of one directory.
fn first_difference(old: &[TreeItem], new: &[TreeItem]) -> Option<String> {
    new.iter()
        .find(|item| !old.iter().any(|before| before.name == item.name && before.id == item.id && before.mode == item.mode))
        .or_else(|| old.iter().find(|item| !new.iter().any(|after| after.name == item.name)))
        .map(|item| item.name.clone())
}

/// The first workflow file that differs between two root trees (`None`
/// for a commit with no parent), as a path.
pub(crate) async fn changed_between<R: GitRepo>(objects: &Objects<'_, R>, old_root: Option<&str>, new_root: &str) -> Result<Option<String>> {
    for dir in WORKFLOW_DIRS {
        let old = match old_root {
            Some(root) => subtree(objects, root, dir).await?,
            None => None,
        };
        let new = subtree(objects, new_root, dir).await?;
        if old == new {
            continue;
        }
        let old_items = match &old {
            Some(id) => objects.tree(id).await?,
            None => Vec::new(),
        };
        let new_items = match &new {
            Some(id) => objects.tree(id).await?,
            None => Vec::new(),
        };
        let name = first_difference(&old_items, &new_items).unwrap_or_default();
        return Ok(Some(format!("{dir}{name}")));
    }
    Ok(None)
}

/// The first workflow file one of `ids` (commits the pack holds) changes
/// against its first parent.
pub(crate) async fn changed_in_commits<R: GitRepo>(pack: &Pack, repo: &R, ids: &[String]) -> Result<Option<String>> {
    let objects = Objects { pack, repo, reads: Cell::new(0) };
    for id in ids {
        let Some((ObjectKind::Commit, data)) = pack.get(id) else {
            continue;
        };
        let commit = rule_facts::read_commit(data);
        let old_root = match commit.parents.first() {
            Some(parent) => objects.commit_tree(parent).await?,
            None => None,
        };
        if let Some(path) = changed_between(&objects, old_root.as_deref(), &commit.tree).await? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Why a push is refused, as the reason git shows beside each ref and the
/// lines it prints, when `token` may not change workflow files and the
/// push (`body`, read `whole` or not) does or cannot be checked.
#[cfg(test)]
pub(crate) async fn judge_push<R: GitRepo>(token: &TokenAccess, body: &[u8], whole: bool, git: &R) -> Result<Option<(&'static str, Vec<String>)>> {
    let mut pack = whole.then(|| crate::push_checks::read_pack(body));
    if let Some(Ok(pack)) = &mut pack {
        crate::secret_scan::supply_bases(pack, git).await?;
    }
    judge_pack(token, body, pack.as_ref(), git).await
}

/// [`judge_push`] for a push whose pack was read already, with its bases
/// supplied (push_checks.rs); `None` when it was not read whole.
pub(crate) async fn judge_pack<R: GitRepo>(
    token: &TokenAccess,
    body: &[u8],
    pack: Option<&std::result::Result<Pack, String>>,
    git: &R,
) -> Result<Option<(&'static str, Vec<String>)>> {
    let updates = crate::git_http::ref_updates(body);
    if updates.iter().all(|(_, _, new)| new.is_none()) {
        return Ok(None);
    }
    let too_large = |line: String| Ok(Some(("push too large to check for workflow files", vec![line, "Push in smaller parts, or with a token that has the workflow_files:write scope.".to_owned()])));
    let Some(pack) = pack else {
        return too_large("This push is too large for g1t to check whether it changes workflow files, and this token may not change them.".to_owned());
    };
    // A push with no pack moves refs to commits the repository has: an
    // empty pack, which changes nothing.
    let pack = match pack {
        Ok(pack) => pack,
        Err(problem) => {
            worker::console_error!("a push's pack could not be read for workflow files: {problem}");
            return Ok(Some(("push could not be checked for workflow files", vec!["g1t could not read this push to check it for workflow files. Push again.".to_owned()])));
        }
    };
    for (_, _, new) in updates {
        let Some(new) = new else { continue };
        let Some(ids) = rule_facts::added(pack, &new, MAX_COMMITS) else {
            return too_large(format!("This push adds more than {MAX_COMMITS} commits to one ref, too many for g1t to check for workflow files, and this token may not change them."));
        };
        if let Some(path) = changed_in_commits(pack, git, &ids).await? {
            let reason = decide_workflow_files(Some(token), [path.as_str()])
                .and_then(|decision| decision.reason)
                .unwrap_or_else(|| format!("This access token cannot change the workflow file {path}."));
            return Ok(Some((
                "workflow files need the workflow_files:write scope",
                vec![reason, "Push with a token that has the workflow_files:write scope, or make the change signed in on g1t.sh.".to_owned()],
            )));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use g1t_contracts::repos::{Branch, Commit, EntryKind, GitAccess, Signature, TreeEntry};
    use g1t_contracts::scopes::{JobToken, Scope};
    use g1t_scan::pack::{encode_tree, object_id, write_pack};

    use super::*;
    use crate::store::Scope as StoreScope;

    fn run<F: Future>(future: F) -> F::Output {
        match pin!(future).as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the fake store never waits"),
        }
    }

    /// The repository before the push: one commit, with its trees.
    #[derive(Default)]
    struct Fake {
        trees: HashMap<String, Vec<TreeEntry>>,
        commits: HashMap<String, Commit>,
    }

    impl GitRepo for Fake {
        async fn access(&self, _scope: StoreScope) -> Result<GitAccess> {
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

    fn item(mode: &str, name: &str, id: &str) -> TreeItem {
        TreeItem { mode: mode.into(), name: name.into(), id: id.into() }
    }

    /// Objects for one tree layout: a root with `dir/workflows/<file>`
    /// holding `content`, and `README.md`.
    struct Layout {
        objects: Vec<(ObjectKind, Vec<u8>)>,
        root: String,
    }

    fn layout(dir: &str, file: &str, content: &str, readme: &str) -> Layout {
        let mut objects = Vec::new();
        let mut add = |kind: ObjectKind, data: Vec<u8>| {
            let id = object_id(kind, &data);
            objects.push((kind, data));
            id
        };
        let workflow = add(ObjectKind::Blob, content.as_bytes().to_vec());
        let readme = add(ObjectKind::Blob, readme.as_bytes().to_vec());
        let workflows = add(ObjectKind::Tree, encode_tree(&[item("100644", file, &workflow)]));
        let parent = add(ObjectKind::Tree, encode_tree(&[item("40000", "workflows", &workflows)]));
        let root = add(ObjectKind::Tree, encode_tree(&[item("40000", dir, &parent), item("100644", "README.md", &readme)]));
        Layout { objects, root }
    }

    fn commit(tree: &str, parent: Option<&str>) -> (String, Vec<u8>) {
        let parent = parent.map(|parent| format!("parent {parent}\n")).unwrap_or_default();
        let data = format!("tree {tree}\n{parent}author A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nchange\n").into_bytes();
        (object_id(ObjectKind::Commit, &data), data)
    }

    /// The first workflow file a push of `after` on top of `before` changes.
    fn check(before: &Layout, after: &Layout) -> Option<String> {
        // The repository holds `before` and its commit; the pack, `after`.
        let mut repo = Fake::default();
        let base = Pack::parse(&write_pack(&before.objects)).unwrap();
        for (kind, data) in &before.objects {
            if *kind == ObjectKind::Tree {
                let id = object_id(*kind, data);
                let entries = base
                    .tree(&id)
                    .unwrap()
                    .into_iter()
                    .map(|item| TreeEntry { name: item.name.clone(), hash: item.id.clone(), kind: if item.is_tree() { EntryKind::Tree } else { EntryKind::Blob } })
                    .collect();
                repo.trees.insert(id, entries);
            }
        }
        let (base_id, _) = commit(&before.root, None);
        repo.commits.insert(
            base_id.clone(),
            Commit { hash: base_id.clone(), tree_hash: before.root.clone(), message: String::new(), author: Signature { name: String::new(), email: String::new() }, parents: Vec::new(), authored_at: String::new() },
        );
        let (tip, data) = commit(&after.root, Some(&base_id));
        let mut objects = after.objects.clone();
        objects.push((ObjectKind::Commit, data));
        let pack = Pack::parse(&write_pack(&objects)).unwrap();
        run(changed_in_commits(&pack, &repo, &[tip])).unwrap()
    }

    #[test]
    fn a_push_that_changes_a_workflow_is_named_by_its_file() {
        let before = layout(".github", "ci.yml", "on: push", "hello");
        let changed = layout(".github", "ci.yml", "on: [push, pull_request]", "hello");
        assert_eq!(check(&before, &changed).as_deref(), Some(".github/workflows/ci.yml"));
        let added = layout(".github", "deploy.yml", "on: push", "hello");
        assert!(check(&before, &added).unwrap().starts_with(".github/workflows/"));
        // The g1t directory too, added where there was none.
        let g1t = layout(".g1t", "ci.yml", "on: push", "hello");
        assert_eq!(check(&before, &g1t).as_deref(), Some(".g1t/workflows/ci.yml"));
    }

    /// A receive-pack request moving `main` from `old` to `new`, with the pack.
    fn receive_pack(old: &str, new: &str, pack: &[u8]) -> Vec<u8> {
        let command = format!("{old} {new} refs/heads/main\0report-status side-band-64k\n");
        let mut body = format!("{:04x}", command.len() + 4).into_bytes();
        body.extend_from_slice(command.as_bytes());
        body.extend_from_slice(b"0000");
        body.extend_from_slice(pack);
        body
    }

    /// The repository holding `before` at its commit, and a push of `after`
    /// on top of it: the refusal, if any, for `pusher`'s token.
    fn push(before: &Layout, after: &Layout, pusher: &User, whole: bool) -> Option<(&'static str, Vec<String>)> {
        let mut repo = Fake::default();
        let base = Pack::parse(&write_pack(&before.objects)).unwrap();
        for (kind, data) in &before.objects {
            if *kind == ObjectKind::Tree {
                let id = object_id(*kind, data);
                let entries = base
                    .tree(&id)
                    .unwrap()
                    .into_iter()
                    .map(|item| TreeEntry { name: item.name.clone(), hash: item.id.clone(), kind: if item.is_tree() { EntryKind::Tree } else { EntryKind::Blob } })
                    .collect();
                repo.trees.insert(id, entries);
            }
        }
        let (base_id, _) = commit(&before.root, None);
        repo.commits.insert(
            base_id.clone(),
            Commit { hash: base_id.clone(), tree_hash: before.root.clone(), message: String::new(), author: Signature { name: String::new(), email: String::new() }, parents: Vec::new(), authored_at: String::new() },
        );
        let (tip, data) = commit(&after.root, Some(&base_id));
        let mut objects = after.objects.clone();
        objects.push((ObjectKind::Commit, data));
        let body = receive_pack(&base_id, &tip, &write_pack(&objects));
        let token = gated(Some(pusher))?;
        run(judge_push(token, &body, whole, &repo)).unwrap()
    }

    #[test]
    fn a_git_push_of_a_workflow_change_is_declined_for_a_token_without_the_scope() {
        let before = layout(".github", "ci.yml", "on: push", "hello");
        let changed = layout(".github", "ci.yml", "on: [push, pull_request]\njobs: {}", "hello");
        let (reason, lines) = push(&before, &changed, &token(&[Scope::CodeWrite]), true).expect("declined");
        assert_eq!(reason, "workflow files need the workflow_files:write scope");
        assert!(lines[0].contains(".github/workflows/ci.yml"), "{lines:?}");
        assert!(lines[0].contains("workflow_files:write"), "{lines:?}");
        // With the scope, or full access, it goes through.
        assert!(push(&before, &changed, &token(&[Scope::CodeWrite, Scope::WorkflowFilesWrite]), true).is_none());
        // A push that changes other files goes through without it.
        let readme = layout(".github", "ci.yml", "on: push", "hello, world");
        assert!(push(&before, &readme, &token(&[Scope::CodeWrite]), true).is_none());
        // One too large to read whole cannot be checked, so it is declined.
        let (reason, _) = push(&before, &readme, &token(&[Scope::CodeWrite]), false).expect("declined");
        assert_eq!(reason, "push too large to check for workflow files");
    }

    #[test]
    fn a_job_token_never_pushes_workflow_changes() {
        let before = layout(".g1t", "ci.yml", "on: push", "hello");
        let changed = layout(".g1t", "ci.yml", "on: workflow_dispatch", "hello");
        let mut job = token(&[Scope::CodeWrite, Scope::WorkflowFilesWrite]);
        job.token.as_mut().unwrap().job = Some(JobToken { run_id: "run_1".into(), job_id: "job_1".into(), pull_requests: false });
        let (_, lines) = push(&before, &changed, &job, true).expect("declined");
        assert!(lines[0].contains("workflow job's token"), "{lines:?}");
    }

    #[test]
    fn a_push_that_leaves_workflows_alone_passes() {
        let before = layout(".github", "ci.yml", "on: push", "hello");
        let readme = layout(".github", "ci.yml", "on: push", "hello, world");
        assert_eq!(check(&before, &readme), None);
    }

    fn token(scopes: &[Scope]) -> User {
        User {
            token: Some(Box::new(TokenAccess {
                token_id: "tok_1".into(),
                scopes: Some(scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
                ..TokenAccess::default()
            })),
            ..User::default()
        }
    }

    #[test]
    fn who_the_gate_checks() {
        assert!(gated(None).is_none(), "nobody");
        assert!(gated(Some(&User::default())).is_none(), "a signed-in person");
        assert!(gated(Some(&token(&[Scope::CodeWrite]))).is_some(), "a token that may push code only");
        assert!(gated(Some(&token(&[Scope::CodeWrite, Scope::WorkflowFilesWrite]))).is_none());
        let full = User { token: Some(Box::new(TokenAccess::full())), ..User::default() };
        assert!(gated(Some(&full)).is_none(), "full access includes workflow files");
        let mut job = token(&[Scope::CodeWrite, Scope::WorkflowFilesWrite]);
        job.token.as_mut().unwrap().job = Some(JobToken { run_id: "run_1".into(), job_id: "job_1".into(), pull_requests: false });
        assert!(gated(Some(&job)).is_some(), "a job's token, whatever it holds");
    }

    #[test]
    fn the_first_difference_names_added_changed_and_removed_entries() {
        let a = item("100644", "a.yml", "1");
        let b = item("100644", "b.yml", "2");
        assert_eq!(first_difference(&[a.clone()], &[a.clone(), b.clone()]).as_deref(), Some("b.yml"));
        assert_eq!(first_difference(&[a.clone(), b.clone()], &[a.clone()]).as_deref(), Some("b.yml"));
        assert_eq!(first_difference(&[a.clone()], &[item("100644", "a.yml", "3")]).as_deref(), Some("a.yml"));
        assert_eq!(first_difference(&[a.clone()], &[a]), None);
    }
}
