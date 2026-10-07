//! One file, committed on a new branch without a sandbox: how g1t proposes
//! a change on someone's behalf, such as a starter workflow, which then
//! becomes a pull request they can read, change and merge.
//!
//! The new tree is the default branch's head with the file put in place.
//! Only the trees on the way to it are rewritten (as catching up does), and
//! the blob, those trees and one commit by the person asking are pushed as
//! a pack to a branch that must not exist yet.

use std::collections::{BTreeSet, HashMap};

use g1t_contracts::access::Capability;
use g1t_contracts::audit::{AuditActor, NewAuditEntry, Surface};
use g1t_contracts::credentials::Decision;
use g1t_contracts::repos::{CommitFileArgs, CommittedFile, EntryKind, TreeEntry, is_valid_branch_name};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use g1t_scan::pack::{ObjectKind, object_id, write_pack};
use worker::Result;

use crate::catch_up::{Change, Signature, ancestors, commit_object, merge_tree, read_dirs};
use crate::registry::{can_write, store_key};
use crate::store::{GitRepo, GitStore, Scope};
use crate::{Repos, UNVERIFIED, land, not_found};

/// The largest file this writes.
const MAX_CONTENT_BYTES: usize = 64 * 1024;

/// Whether `path` is somewhere a file can be written: relative, without
/// empty, `.` or `..` parts, and not inside `.git`.
pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 400
        && !path.starts_with('/')
        && !path.ends_with('/')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && part != ".git")
        && !path.chars().any(|c| c.is_control() || c == '\\')
}

impl<S: GitStore> Repos<S> {
    pub(crate) async fn commit_file(&self, a: CommitFileArgs) -> Result<Outcome<CommittedFile>> {
        let actor = Some(a.actor.clone());
        let Some(repo) = self.readable(&a.repo, &actor).await? else {
            return Ok(not_found());
        };
        if !can_write(&repo, &actor) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                g1t_contracts::access::needs(Capability::Push, &format!("{}/{}", repo.namespace, repo.name)),
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        if let Some((code, message)) = crate::lifecycle::archived_refusal(&repo) {
            return Ok(Outcome::fail(code, message));
        }
        // Moving between namespaces: wait for it (moves.rs).
        let repo = match self.unpaused(repo).await? {
            Ok(repo) => repo,
            Err((code, message)) => return Ok(Outcome::fail(code, message)),
        };
        if !is_valid_branch_name(&a.branch) || a.branch == repo.default_branch {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{} cannot be the new branch's name.", a.branch)));
        }
        if !valid_path(&a.path) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{} is not a path a file can be written to.", a.path)));
        }
        if a.content.len() > MAX_CONTENT_BYTES {
            return Ok(Outcome::fail(FailureCode::Invalid, "The file is too large to write this way."));
        }
        let message = a.message.trim();
        if message.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "A commit needs a message."));
        }

        let git = self.store.open(&store_key(&repo)).await?;
        if git.branches().await?.iter().any(|branch| branch.name == a.branch) {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("A branch named {} already exists.", a.branch)));
        }
        let history = git.log(&repo.default_branch, 1).await?;
        let Some(head) = history.first() else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{} has no commits yet. Push a first commit, then try again.", repo.default_branch),
            ));
        };
        let dirs: BTreeSet<String> = ancestors(&a.path).map(str::to_owned).collect();
        let read = read_dirs(&git, &head.tree_hash, &dirs).await?;
        let (parent, name) = a.path.rsplit_once('/').unwrap_or(("", a.path.as_str()));
        let exists = read
            .get(parent)
            .is_some_and(|(_, entries)| entries.iter().any(|entry| entry.name == name));
        if exists {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{} already exists on {}.", a.path, repo.default_branch)));
        }

        let blob = a.content.clone().into_bytes();
        let blob_id = object_id(ObjectKind::Blob, &blob);
        let trees: HashMap<String, Vec<TreeEntry>> = read.into_values().collect();
        let change = Change {
            path: a.path.clone(),
            entry: Some((EntryKind::Blob, blob_id)),
        };
        let merged = match merge_tree(&head.tree_hash, &trees, &[change]) {
            Ok(merged) => merged,
            Err(why) => {
                return Ok(Outcome::fail(FailureCode::Conflict, format!("g1t could not write {}: {why}.", a.path)));
            }
        };

        let author = self.commit_identity(&a.actor).await;
        let commit = commit_object(
            &merged.tree,
            &[&head.hash],
            &Signature {
                name: &author.name,
                email: &author.email,
                seconds: now_ms() / 1000,
            },
            message,
        );
        let commit_id = object_id(ObjectKind::Commit, &commit);
        let mut objects: Vec<(ObjectKind, Vec<u8>)> = vec![(ObjectKind::Blob, blob)];
        objects.extend(merged.objects.into_iter().map(|bytes| (ObjectKind::Tree, bytes)));
        objects.push((ObjectKind::Commit, commit));
        let access = git.access(Scope::Write).await?;
        // Only if the branch is still not there.
        let pushed = land::push_pack(&access, &a.branch, None, &commit_id, write_pack(&objects)).await?;
        self.refs_moved(&repo.id).await;

        let git_ref = format!("refs/heads/{}", a.branch);
        let mut target = self.audit_target(&a.repo).await?;
        target.git_ref = Some(git_ref.clone());
        let mut entry = NewAuditEntry::new(
            AuditActor::of(&a.actor),
            "git.push",
            Surface::Git,
            target,
            &Decision::allow("person"),
            g1t_contracts::new_id("req", now_ms()),
        );
        if let Err(reason) = pushed {
            entry.result = Some("conflict".to_owned());
            entry.message = Some(reason.clone());
            self.record_git(entry).await;
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{} could not be created: {reason}", a.branch)));
        }
        entry.result = Some("ok".to_owned());
        self.record_git(entry).await;
        self.publish_push(&repo, &git_ref, None, &commit_id, Some(a.actor.id.clone())).await?;
        Ok(Outcome::Ok(CommittedFile {
            branch: a.branch,
            commit: commit_id,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::valid_path;

    #[test]
    fn only_plain_relative_paths_are_written() {
        assert!(valid_path(".g1t/workflows/ci.yml"));
        assert!(valid_path("README.md"));
        for path in ["", "/etc/passwd", "a/../b", "a//b", ".git/config", "a/./b", "dir/", "a\\b"] {
            assert!(!valid_path(path), "{path}");
        }
    }
}
