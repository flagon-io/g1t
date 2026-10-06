//! Pull requests' working copies after their pull request is done.
//!
//! Every pull request made from an issue works in its own copy of the
//! repository in the git store (`pulls--<pull id>`, `fork_for_pull`).
//! Cloudflare does not say whether a fork shares objects with its source,
//! and storage is billed and capped per account (1 TB), so copies are not
//! kept forever: [`retention_days`] after the pull request merges or
//! closes (`pull.merged`, `pull.closed`), the hourly sweep removes the
//! copy's git data. Reopened within the window (`pull.reopened`), it stays.
//!
//! Nothing is lost. Before the copy goes, its head is kept in the
//! repository it came from as `refs/pull/<pull id>/head` (only the
//! objects the repository lacks travel), and the row stays, with that
//! commit. Reads of the copy (the pull request's changes, its files) are
//! answered from the repository ([`Viewed`]). Anything that writes to it
//! (a push, git access, catching up, landing) makes it again first, from
//! that ref ([`Repos::live`]).

use g1t_contracts::repos::{Branch, Commit, GitAccess, Repo, TreeEntry};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use worker::wasm_bindgen::JsValue;
use worker::{Env, Result};

use crate::registry::{Registry, RepoRow, store_key};
use crate::store::{GitRepo, GitStore, Scope};
use crate::{PULLS_NAMESPACE, Repos, land, refs};

/// Days a working copy is kept after its pull request merges or closes,
/// unless `FORK_RETENTION_DAYS` says otherwise.
pub const DEFAULT_RETENTION_DAYS: u64 = 7;
/// How many working copies one sweep removes.
const RETIRES_PER_SWEEP: u32 = 25;

pub fn retention_days(env: &Env) -> u64 {
    env.var("FORK_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.to_string().parse().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS)
}

/// When a working copy whose pull request settled at `now` is removed.
pub fn retire_after(now: u64, days: u64) -> String {
    rfc3339(now + days * 24 * 3600 * 1000)
}

/// Where a pull request's head is kept in its repository.
pub fn pull_ref(pull_id: &str) -> String {
    format!("refs/pull/{pull_id}/head")
}

/// What a pull request event means for its working copy.
#[derive(Debug, PartialEq, Eq)]
pub enum PullChange {
    /// Merged or closed: remove it after the window.
    Settled,
    /// Open again: keep it, or make it again.
    Reopened,
}

pub fn pull_change(kind: &str) -> Option<PullChange> {
    match kind {
        "pull.merged" | "pull.closed" => Some(PullChange::Settled),
        "pull.reopened" => Some(PullChange::Reopened),
        _ => None,
    }
}

/// The pull request an event is about.
pub fn pull_id_of(data: &serde_json::Value) -> Option<String> {
    data.get("pullId").or_else(|| data.get("pull_id")).and_then(|id| id.as_str()).map(str::to_owned)
}

/// A repository as reads see it: a working copy that was removed reads
/// as the repository it came from, with its branch at the head it had.
pub struct Viewed<R> {
    inner: R,
    /// The copy's branch, and the commit it pointed to.
    alias: Option<(String, String)>,
}

impl<R> Viewed<R> {
    pub fn plain(inner: R) -> Self {
        Viewed { inner, alias: None }
    }

    pub fn retired(inner: R, branch: &str, head: &str) -> Self {
        Viewed { inner, alias: Some((branch.to_owned(), head.to_owned())) }
    }

    /// `git_ref`, or the head a removed copy's branch pointed to.
    fn resolve<'a>(&'a self, git_ref: &'a str) -> &'a str {
        match &self.alias {
            Some((branch, head)) if aliases(git_ref, branch) => head,
            _ => git_ref,
        }
    }
}

/// Whether `git_ref` names `branch`, or HEAD.
fn aliases(git_ref: &str, branch: &str) -> bool {
    git_ref == branch || git_ref == "HEAD" || git_ref.strip_prefix("refs/heads/") == Some(branch)
}

impl<R: GitRepo> GitRepo for Viewed<R> {
    async fn access(&self, scope: Scope) -> Result<GitAccess> {
        self.inner.access(scope).await
    }

    async fn branches(&self) -> Result<Vec<Branch>> {
        match &self.alias {
            Some((branch, head)) => Ok(vec![Branch { name: branch.clone(), hash: head.clone() }]),
            None => self.inner.branches().await,
        }
    }

    async fn log(&self, git_ref: &str, limit: u32) -> Result<Vec<Commit>> {
        self.inner.log(self.resolve(git_ref), limit).await
    }

    async fn parents(&self, commit_hash: &str) -> Result<Option<Vec<String>>> {
        self.inner.parents(commit_hash).await
    }

    async fn read_tree(&self, tree_hash: &str) -> Result<Option<Vec<TreeEntry>>> {
        self.inner.read_tree(tree_hash).await
    }

    async fn read_blob(&self, blob_hash: &str) -> Result<Option<Vec<u8>>> {
        self.inner.read_blob(blob_hash).await
    }

    async fn read_file(&self, git_ref: &str, path: &str) -> Result<Option<Vec<u8>>> {
        self.inner.read_file(self.resolve(git_ref), path).await
    }

    async fn fork(&self, target_key: &str) -> Result<()> {
        if self.alias.is_some() {
            return Err(worker::Error::RustError("a removed working copy is not forked".into()));
        }
        self.inner.fork(target_key).await
    }

    fn at_refs_version(&mut self, version: Option<u64>) {
        self.inner.at_refs_version(version);
    }
}

impl Registry {
    /// The working copy of a pull request, if it has one.
    pub async fn pull_fork(&self, pull_id: &str) -> Result<Option<Repo>> {
        Ok(self
            .db
            .prepare("SELECT * FROM repos WHERE namespace = ? AND name = ? AND fork_of IS NOT NULL AND deleted_at IS NULL")
            .bind(&[PULLS_NAMESPACE.into(), pull_id.to_lowercase().into()])?
            .first::<RepoRow>(None)
            .await?
            .map(Repo::from))
    }

    /// Sets, or with `None` clears, when a working copy is removed.
    pub async fn set_retire_after(&self, id: &str, after: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET retire_after = ? WHERE id = ? AND retired_at IS NULL")
            .bind(&[after.map_or(JsValue::NULL, JsValue::from), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Working copies whose time has come, oldest first.
    pub async fn retiring(&self, now: &str, limit: u32) -> Result<Vec<Repo>> {
        Ok(self
            .db
            .prepare(
                "SELECT * FROM repos
                 WHERE retire_after IS NOT NULL AND retire_after <= ? AND retired_at IS NULL
                   AND fork_of IS NOT NULL AND deleted_at IS NULL
                 ORDER BY retire_after LIMIT ?",
            )
            .bind(&[now.into(), limit.into()])?
            .all()
            .await?
            .results::<RepoRow>()?
            .into_iter()
            .map(Repo::from)
            .collect())
    }

    /// Records that a working copy's git data is gone, and the head it had;
    /// `None` puts it back as it was, for a removal that failed.
    pub async fn set_retired(&self, id: &str, retired: Option<(&str, Option<&str>)>) -> Result<()> {
        let (at, head) = match retired {
            Some((at, head)) => (JsValue::from(at), head.map_or(JsValue::NULL, JsValue::from)),
            None => (JsValue::NULL, JsValue::NULL),
        };
        self.db
            .prepare("UPDATE repos SET retired_at = ?, retired_head = ? WHERE id = ?")
            .bind(&[at, head, id.into()])?
            .run()
            .await?;
        crate::registry::note_retired(id, retired.and_then(|(_, head)| head));
        Ok(())
    }

    /// Records that a working copy was made again; `retire_after`, when to
    /// remove it next.
    pub async fn revived(&self, id: &str, retire_after: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET retired_at = NULL, retired_head = NULL, retire_after = ? WHERE id = ?")
            .bind(&[retire_after.map_or(JsValue::NULL, JsValue::from), id.into()])?
            .run()
            .await?;
        crate::registry::note_retired(id, None);
        Ok(())
    }
}

impl<S: GitStore> Repos<S> {
    /// The repository's store as reads see it: a removed working copy
    /// reads from the repository it came from. Reads by branch are kept
    /// under its refs version (store.rs).
    pub(crate) async fn read_git(&self, repo: &Repo) -> Result<Viewed<S::Repo>> {
        let now = now_ms();
        if let (Some(head), Some(parent_id)) = (crate::registry::retired(&repo.id), &repo.fork_of)
            && let Some(parent) = self.registry.by_id(parent_id).await?
        {
            let mut git = self.store.open(&store_key(&parent)).await?;
            git.at_refs_version(crate::refs_cache::usable(crate::registry::refs_state(&parent.id), now));
            return Ok(Viewed::retired(git, &repo.default_branch, &head));
        }
        let mut git = self.store.open(&store_key(repo)).await?;
        git.at_refs_version(crate::refs_cache::usable(crate::registry::refs_state(&repo.id), now));
        Ok(Viewed::plain(git))
    }

    /// Makes a removed working copy again before anything writes to it.
    /// Its pull request is still settled, so it is removed again after the
    /// window unless the pull request reopens.
    pub(crate) async fn live(&self, repo: &Repo) -> Result<()> {
        if crate::registry::retired(&repo.id).is_none() {
            return Ok(());
        }
        self.revive(repo, Some(retire_after(now_ms(), self.fork_days))).await
    }

    /// `pull.merged` or `pull.closed`: the working copy goes in `days`.
    pub(crate) async fn pull_settled(&self, pull_id: &str) -> Result<()> {
        if let Some(fork) = self.registry.pull_fork(pull_id).await? {
            self.registry.set_retire_after(&fork.id, Some(&retire_after(now_ms(), self.fork_days))).await?;
        }
        Ok(())
    }

    /// `pull.reopened`: the working copy stays, made again if it had gone.
    pub(crate) async fn pull_reopened(&self, pull_id: &str) -> Result<()> {
        let Some(fork) = self.registry.pull_fork(pull_id).await? else {
            return Ok(());
        };
        if crate::registry::retired(&fork.id).is_some() {
            return self.revive(&fork, None).await;
        }
        self.registry.set_retire_after(&fork.id, None).await
    }

    /// The sweep: removes the working copies whose time has come.
    pub(crate) async fn retire_due(&self) -> Result<u32> {
        let due = self.registry.retiring(&rfc3339(now_ms()), RETIRES_PER_SWEEP).await?;
        let mut retired = 0;
        for fork in due {
            match self.retire(&fork).await {
                Ok(()) => retired += 1,
                Err(error) => worker::console_error!("working copy {} not removed: {error}", fork.id),
            }
        }
        Ok(retired)
    }

    /// Keeps a working copy's head in its repository, then removes its git
    /// data. A failure before the removal leaves everything as it was.
    async fn retire(&self, fork: &Repo) -> Result<()> {
        let key = store_key(fork);
        let parent = match &fork.fork_of {
            Some(id) => self.registry.by_id(id).await?,
            None => None,
        };
        // Already gone from the store: it says so when first asked.
        let read = match self.store.open(&key).await {
            Ok(git) => git.log(&fork.default_branch, 1).await,
            Err(error) => Err(error),
        };
        let head = match read {
            Ok(commits) => commits.into_iter().next().map(|commit| commit.hash),
            Err(error) if error.to_string().contains("NOT_FOUND") => None,
            Err(error) => return Err(error),
        };
        if let (Some(parent), Some(head)) = (&parent, &head) {
            self.keep_head(fork, parent, head).await?;
        }
        let now = rfc3339(now_ms());
        self.registry.set_retired(&fork.id, Some((&now, head.as_deref()))).await?;
        if let Err(error) = self.store.delete(&key).await {
            // Back as it was, for the next sweep.
            self.registry.set_retired(&fork.id, None).await?;
            return Err(error);
        }
        Ok(())
    }

    /// Points `refs/pull/<pull id>/head` in `parent` at `head`, sending
    /// only the objects the parent lacks.
    async fn keep_head(&self, fork: &Repo, parent: &Repo, head: &str) -> Result<()> {
        let parent_git = self.store.open(&store_key(parent)).await?;
        let reference = pull_ref(&fork.name);
        let parent_read = parent_git.access(Scope::Read).await?;
        let refs = refs::all(&parent_read).await?;
        let existing = refs.iter().find(|(name, _)| *name == reference).map(|(_, hash)| hash.clone());
        if existing.as_deref() == Some(head) {
            return Ok(());
        }
        let has_it = !parent_git.log(head, 1).await?.is_empty();
        let pack = if has_it {
            land::EMPTY_PACK.to_vec()
        } else {
            let base = refs.iter().find(|(name, _)| *name == format!("refs/heads/{}", parent.default_branch)).map(|(_, hash)| hash.clone());
            let fork_read = self.store.open(&store_key(fork)).await?.access(Scope::Read).await?;
            land::fetch_pack(&fork_read, head, base.as_deref()).await?
        };
        let parent_write = parent_git.access(Scope::Write).await?;
        let kept = land::push_ref(&parent_write, &reference, existing.as_deref(), head, Some(pack)).await;
        self.refs_moved(&parent.id).await;
        kept?.map_err(|reason| worker::Error::RustError(format!("{reference} not kept in {}: {reason}", parent.id)))
    }

    /// Makes a removed working copy again: a fork of its repository, with
    /// its branch moved back to the head it had.
    async fn revive(&self, fork: &Repo, retire_after: Option<String>) -> Result<()> {
        let head = crate::registry::retired(&fork.id);
        let parent = match &fork.fork_of {
            Some(id) => self.registry.by_id(id).await?,
            None => None,
        };
        let (Some(head), Some(parent)) = (head, parent) else {
            return Err(worker::Error::RustError(format!(
                "working copy {} cannot be made again: its repository or head is gone",
                fork.id
            )));
        };
        let key = store_key(fork);
        let parent_git = self.store.open(&store_key(&parent)).await?;
        parent_git.fork(&key).await?;
        let git = self.store.open(&key).await?;
        let current = git.log(&fork.default_branch, 1).await?.into_iter().next().map(|commit| commit.hash);
        if current.as_deref() != Some(head.as_str()) {
            let pack = land::fetch_pack(&parent_git.access(Scope::Read).await?, &head, current.as_deref()).await?;
            let moved = land::push_ref(
                &git.access(Scope::Write).await?,
                &format!("refs/heads/{}", fork.default_branch),
                current.as_deref(),
                &head,
                Some(pack),
            )
            .await;
            self.refs_moved(&fork.id).await;
            moved?.map_err(|reason| worker::Error::RustError(format!("working copy {} made again, but not at {head}: {reason}", fork.id)))?;
        }
        self.registry.revived(&fork.id, retire_after.as_deref()).await?;
        self.refs_moved(&fork.id).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_is_removed_days_after_its_pull_request_settles() {
        let settled = 1_791_936_000_000; // 2026-10-14T00:00:00Z
        assert_eq!(retire_after(settled, 7), "2026-10-21T00:00:00.000Z");
        assert_eq!(retire_after(settled, 0), "2026-10-14T00:00:00.000Z");
        // The sweep compares these as text, which orders like time.
        assert!(retire_after(settled, 7) > retire_after(settled, 6));
        assert_eq!(pull_change("pull.merged"), Some(PullChange::Settled));
        assert_eq!(pull_change("pull.closed"), Some(PullChange::Settled));
        assert_eq!(pull_change("pull.reopened"), Some(PullChange::Reopened));
        assert_eq!(pull_change("pull.updated"), None);
        assert_eq!(pull_id_of(&serde_json::json!({ "pullId": "pul_1", "number": 3 })).as_deref(), Some("pul_1"));
        assert_eq!(pull_id_of(&serde_json::json!({ "pull_id": "pul_2" })).as_deref(), Some("pul_2"));
        assert_eq!(pull_id_of(&serde_json::json!({})), None);
        assert_eq!(pull_ref("pul_1"), "refs/pull/pul_1/head");
    }

    #[test]
    fn a_removed_copy_reads_its_branch_at_the_head_it_had() {
        let viewed = Viewed::retired((), "main", &"a".repeat(40));
        assert_eq!(viewed.resolve("main"), "a".repeat(40));
        assert_eq!(viewed.resolve("refs/heads/main"), "a".repeat(40));
        assert_eq!(viewed.resolve("HEAD"), "a".repeat(40));
        // Anything else is read from the repository as it is.
        assert_eq!(viewed.resolve("dev"), "dev");
        assert_eq!(viewed.resolve(&"b".repeat(40)), "b".repeat(40));
        let plain = Viewed::plain(());
        assert_eq!(plain.resolve("main"), "main");
    }
}
