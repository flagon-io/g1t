//! Pull requests opened from a branch of someone's fork of a repository
//! (`Pull::head_repo`): a repository whose `parent_id` chain reaches the one
//! it merges into. Not a working copy (`Pull::fork`, namespace `pulls`),
//! which g1t makes for one pull request and which knows its own target.

use std::future::Future;

use g1t_contracts::repos::{GetByIdArgs, Repo, RepoPath};
use g1t_contracts::{FailureCode, Outcome, User};
use worker::Result;

use crate::Work;

/// The open pull request from branch `?2` (of repository `?1` itself when
/// `?3` is null, else of the fork `?3`) into `?1`'s branch `?4` (null for
/// its default branch), if there is one: there is at most one.
pub(crate) const OPEN_FROM_BRANCH: &str = "SELECT number AS n FROM pulls
     WHERE repo_id = ? AND source_branch = ? AND head_repo_id IS ?
       AND fork_repo_id IS NULL AND status IN ('draft', 'open')
       AND base_branch IS ?";

/// The pull requests whose change is on a branch a push to repository `?`
/// (bound twice) moved, branch `?`: those of the repository's own branch,
/// and those opened from it as a fork of another repository.
pub(crate) const ON_BRANCH: &str = "((repo_id = ? AND head_repo_id IS NULL) OR head_repo_id = ?)
       AND source_branch = ? AND fork_repo_id IS NULL";

/// A fork renamed or transferred: the pull requests opened from it name it
/// where it is now (see `g1t_kit::transfer`; `?3` its workspace now, `?5`
/// its id, `?6` its name now).
pub(crate) const TRANSFERRED: &[&str] = &["UPDATE pulls SET head_namespace = ?3, head_name = ?6 WHERE head_repo_id = ?5"];

/// How many forks up a fork's parents are followed to find the repository
/// a pull request from it merges into.
pub(crate) const MAX_FORK_DEPTH: usize = 10;

/// Whether following parents from `parent` (a repository's `parent_id`)
/// reaches `ancestor_id` within [`MAX_FORK_DEPTH`] steps. `parent_of` reads
/// a repository's own parent, `None` when it has none or cannot be read.
pub(crate) async fn reaches<F, Fut>(mut parent: Option<String>, ancestor_id: &str, mut parent_of: F) -> Result<bool>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Option<String>>>,
{
    for _ in 0..MAX_FORK_DEPTH {
        let Some(id) = parent else {
            return Ok(false);
        };
        if id == ancestor_id {
            return Ok(true);
        }
        parent = parent_of(id).await?;
    }
    Ok(false)
}

/// How a pull request's source is named to people: `branch` for one of
/// the repository's own, `owner/name:branch` for a fork's.
pub(crate) fn source_label(head_repo: Option<&RepoPath>, branch: &str) -> String {
    match head_repo {
        Some(fork) => format!("{}/{}:{branch}", fork.namespace, fork.name),
        None => branch.to_owned(),
    }
}

/// Why a repository cannot hold a pull request's branch for `target`, if
/// it cannot: a working copy, or a repository that is not a fork of it.
/// `in_network`: whether its parents reach `target`.
pub(crate) fn head_repo_refusal(head: &Repo, target: &Repo, in_network: bool) -> Option<String> {
    let name = format!("{}/{}", head.namespace, head.name);
    let target_name = format!("{}/{}", target.namespace, target.name);
    if head.fork_of.is_some() {
        return Some(format!("{name} is a pull request's working copy. Open the pull request from a branch."));
    }
    if !in_network {
        return Some(format!("{name} is not a fork of {target_name}."));
    }
    None
}

impl Work {
    /// Whether `repo` is a fork of `ancestor_id`, directly or through other
    /// forks, as `actor` can read them.
    pub(crate) async fn forked_from(&self, repo: &Repo, ancestor_id: &str, actor: &User) -> Result<bool> {
        reaches(repo.parent_id.clone(), ancestor_id, |id| async move {
            let found: Outcome<Repo> = g1t_kit::call(&self.repos, "get_by_id", &GetByIdArgs { id, viewer: Some(actor.clone()) }).await?;
            Ok(found.into_result().ok().and_then(|repo| repo.parent_id))
        })
        .await
    }

    /// The fork named by `open_pull`'s `head_repo`, read as `actor`:
    /// `None` when it is the target itself; refused unless it is a fork of
    /// `target`.
    pub(crate) async fn head_repo_for(&self, path: &RepoPath, target: &Repo, actor: &User) -> Result<Outcome<Option<Repo>>> {
        let found: Outcome<Repo> = self.repo(path, &Some(actor.clone())).await?;
        let head = match found {
            Outcome::Ok(head) => head,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if head.id == target.id {
            return Ok(Outcome::Ok(None));
        }
        let in_network = head.fork_of.is_none() && self.forked_from(&head, &target.id, actor).await?;
        if let Some(message) = head_repo_refusal(&head, target, in_network) {
            return Ok(Outcome::fail(FailureCode::Invalid, message));
        }
        Ok(Outcome::Ok(Some(head)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::collections::HashMap;

    fn walk(parents: &HashMap<&str, &str>, start: &str, ancestor: &str) -> bool {
        let start = parents.get(start).map(|id| id.to_string());
        reaches(start, ancestor, |id| {
            let parent = parents.get(id.as_str()).map(|id| id.to_string());
            async move { Ok(parent) }
        })
        .now_or_never()
        .unwrap()
        .unwrap()
    }

    #[test]
    fn a_fork_reaches_its_parent_and_theirs() {
        let parents = HashMap::from([("fork", "base"), ("fork_of_fork", "fork")]);
        assert!(walk(&parents, "fork", "base"));
        assert!(walk(&parents, "fork_of_fork", "base"));
        assert!(walk(&parents, "fork_of_fork", "fork"));
        assert!(!walk(&parents, "base", "fork"), "a parent is not its fork's fork");
        assert!(!walk(&parents, "fork", "other"));
    }

    #[test]
    fn a_loop_or_a_long_chain_stops() {
        let looped = HashMap::from([("a", "b"), ("b", "a")]);
        assert!(!walk(&looped, "a", "c"));
        let names: Vec<String> = (0..=MAX_FORK_DEPTH + 1).map(|n| format!("r{n}")).collect();
        let chain: HashMap<&str, &str> = names.windows(2).map(|pair| (pair[0].as_str(), pair[1].as_str())).collect();
        assert!(walk(&chain, "r0", &names[MAX_FORK_DEPTH]));
        assert!(!walk(&chain, "r0", &names[MAX_FORK_DEPTH + 1]), "too far up");
    }

    #[test]
    fn a_fork_branch_is_named_with_its_fork() {
        let fork = RepoPath { namespace: "ana".into(), name: "g1t".into() };
        assert_eq!(source_label(Some(&fork), "fix"), "ana/g1t:fix");
        assert_eq!(source_label(None, "fix"), "fix");
    }

    fn database() -> rusqlite::Connection {
        let db = crate::migrated::database();
        // In flagon/g1t (rep_1): #1 from its own branch fix, #2 from ana's
        // fork's (rep_2) branch fix, #3 from a working copy.
        db.execute_batch(
            "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at,
                                status, source_branch, head_repo_id, head_namespace, head_name, fork_repo_id)
             VALUES ('pr_1', 'rep_1', 1, 't', 'ana', 'external', 'usr_1', 'ana', '', '', 'open', 'fix', NULL, NULL, NULL, NULL),
                    ('pr_2', 'rep_1', 2, 't', 'ana', 'external', 'usr_1', 'ana', '', '', 'open', 'fix', 'rep_2', 'ana', 'g1t', NULL),
                    ('pr_3', 'rep_1', 3, 't', 'g1t', 'hosted', 'usr_1', 'ana', '', '', 'draft', NULL, NULL, NULL, NULL, 'rep_3');",
        )
        .unwrap();
        db
    }

    fn numbers(db: &rusqlite::Connection, sql: &str, params: impl rusqlite::Params) -> Vec<u32> {
        let mut statement = db.prepare(sql).unwrap();
        statement.query_map(params, |row| row.get(0)).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn one_open_pull_request_per_branch_of_each_repository() {
        let db = database();
        let open = |head: Option<&str>| numbers(&db, OPEN_FROM_BRANCH, rusqlite::params!["rep_1", "fix", head, None::<String>]);
        assert_eq!(open(None), vec![1], "the repository's own branch");
        assert_eq!(open(Some("rep_2")), vec![2], "the fork's branch of the same name is another");
        assert!(open(Some("rep_4")).is_empty(), "another fork's is free");
    }

    #[test]
    fn a_push_moves_the_pull_requests_of_the_branch_it_moved() {
        let db = database();
        let on = |repo: &str| {
            numbers(&db, &format!("SELECT number FROM pulls WHERE {ON_BRANCH} ORDER BY number"), rusqlite::params![repo, repo, "fix"])
        };
        assert_eq!(on("rep_1"), vec![1], "not the fork's branch of the same name");
        assert_eq!(on("rep_2"), vec![2], "a push to the fork moves the pull request into its parent");
        assert!(on("rep_3").is_empty(), "a working copy is moved by its default branch");
    }

    fn repo(id: &str, namespace: &str) -> Repo {
        serde_json::from_value(serde_json::json!({
            "id": id, "namespace": namespace, "name": "g1t", "isPrivate": false,
            "ownerId": "usr_1", "defaultBranch": "main", "forkOf": null, "protected": false,
            "createdAt": "", "updatedAt": ""
        }))
        .unwrap()
    }

    #[test]
    fn only_forks_hold_a_pull_requests_branch() {
        let target = repo("rep_1", "flagon");
        let fork = repo("rep_2", "ana");
        assert_eq!(head_repo_refusal(&fork, &target, true), None);
        assert_eq!(head_repo_refusal(&fork, &target, false).as_deref(), Some("ana/g1t is not a fork of flagon/g1t."));
        let mut copy = repo("rep_3", "pulls");
        copy.fork_of = Some("rep_1".into());
        assert!(head_repo_refusal(&copy, &target, true).unwrap().contains("working copy"));
    }
}
