//! Whether a pull request merges cleanly into the branch it targets, worked
//! out ahead of time, as GitHub does, rather than discovered when a merge
//! or the merge queue trips over it.
//!
//! It is worked out whenever the pull request's head or its target branch
//! moves, once per pair of commits. The first pass needs no sandbox: if the
//! files the pull request changed since it and the branch last agreed share
//! none with the files the branch changed since then, the merge cannot
//! conflict. Otherwise a `pull.mergecheck` event asks the runner for a short
//! probe in a sandbox, which merges the two without an agent and reports the
//! files that conflict. Only so many probes run at once per repository; the
//! rest wait their turn and start as earlier ones report.

use std::collections::HashSet;

use g1t_contracts::repos::{BehindArgs, Divergence, GetByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;
use crate::checks::{hash, new_token};
use crate::rows::{NumberRow, ValueRow};

/// How long a probe is waited for before it is asked for again.
const PROBE_MINUTES: u64 = 10;
/// How many probes one repository may have running at once.
const MAX_PROBES: u32 = 3;
/// How many conflicting files are kept.
const MAX_CONFLICTS: usize = 100;
/// How many open pull requests are looked at when their target moves.
const MAX_TARGETING: u32 = 100;

#[derive(Deserialize)]
struct MergeRow {
    mergeable: Option<String>,
    conflicts: Option<String>,
    mergeable_key: Option<String>,
    mergeable_until: Option<String>,
}

#[derive(Deserialize)]
struct ProbeRow {
    id: String,
    repo_id: String,
    mergeable_key: Option<String>,
    mergeable_token_hash: Option<String>,
}

/// The pair of commits an answer is for.
fn key(divergence: &Divergence) -> String {
    format!("{}..{}", divergence.head, divergence.base)
}

/// Whether the cheap first pass leaves the question open, so that a probe
/// has to merge the two. It is settled when the branch has not moved, or
/// when the two sides changed no file in common.
pub(crate) fn needs_probe(divergence: &Divergence) -> bool {
    if !divergence.behind {
        return false;
    }
    if divergence.truncated {
        return true;
    }
    let ours: HashSet<&str> = divergence.ours.iter().map(String::as_str).collect();
    divergence.theirs.iter().any(|path| ours.contains(path.as_str()))
}

/// Paths as a sandbox reported them, tidied: trimmed, without duplicates,
/// and no more than are useful.
pub(crate) fn tidy(paths: Vec<String>) -> Vec<String> {
    let mut tidy: Vec<String> = Vec::new();
    for path in paths {
        let path = path.trim().to_owned();
        if !path.is_empty() && !tidy.contains(&path) {
            tidy.push(path);
        }
        if tidy.len() == MAX_CONFLICTS {
            break;
        }
    }
    tidy
}

impl Work {
    async fn merge_row(&self, pull_id: &str) -> Result<Option<MergeRow>> {
        self.db
            .prepare(
                "SELECT mergeable, conflicts, mergeable_key, mergeable_until
                 FROM pulls WHERE id = ?",
            )
            .bind(&[pull_id.into()])?
            .first::<MergeRow>(None)
            .await
    }

    /// Works out whether a pull request merges cleanly as it and its target
    /// are now, unless that pair of commits was already worked out or is
    /// being. Settles it at once where it can, and asks for a probe where
    /// it cannot.
    pub(crate) async fn assess_mergeability(&self, pull: &Pull) -> Result<()> {
        if !pull.status.is_active() {
            return Ok(());
        }
        let divergence: Option<Divergence> = g1t_kit::call(
            &self.repos,
            "divergence",
            &BehindArgs {
                source_id: pull.fork_repo_id.clone().unwrap_or_else(|| pull.repo_id.clone()),
                branch: pull.branch.clone(),
            },
        )
        .await?;
        // Nothing pushed yet.
        let Some(divergence) = divergence else {
            return Ok(());
        };
        let key = key(&divergence);
        let now = now_ms();
        let row = self.merge_row(&pull.id).await?;
        if let Some(row) = &row
            && row.mergeable_key.as_deref() == Some(key.as_str())
        {
            let settled = match row.mergeable.as_deref() {
                Some("clean" | "conflicting" | "unknown") => true,
                // A probe that is still being waited for.
                Some("checking") => row
                    .mergeable_until
                    .as_deref()
                    .is_some_and(|until| until > rfc3339(now).as_str()),
                _ => false,
            };
            if settled {
                return Ok(());
            }
        }
        if !needs_probe(&divergence) {
            self.db
                .prepare(
                    "UPDATE pulls
                     SET mergeable = 'clean', conflicts = '[]', mergeable_key = ?,
                         mergeable_token_hash = NULL, mergeable_until = NULL
                     WHERE id = ?",
                )
                .bind(&[key.as_str().into(), pull.id.as_str().into()])?
                .run()
                .await?;
            // It may have been conflicting before this push.
            if row.is_some_and(|row| row.mergeable.as_deref() == Some("conflicting")) {
                self.announce_mergeability(pull).await?;
            }
            return Ok(());
        }
        self.db
            .prepare(
                "UPDATE pulls
                 SET mergeable = 'checking', conflicts = '[]', mergeable_key = ?,
                     mergeable_token_hash = NULL, mergeable_until = ?
                 WHERE id = ?",
            )
            .bind(&[
                key.as_str().into(),
                rfc3339(now + PROBE_MINUTES * 60 * 1000).into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.ask_for_probe(pull, &divergence.head).await
    }

    async fn ask_for_probe(&self, pull: &Pull, head: &str) -> Result<()> {
        self.publish_as(
            "pull.mergecheck",
            &pull.repo_id,
            None,
            g1t_contracts::events::PullEvent {
                commit: Some(head.to_owned()),
                ..Self::pull_event(pull)
            },
        )
        .await
    }

    /// Says that a pull request's mergeability settled, so that the runner
    /// looks again at one g1t is seeing through: a conflict is the agent's
    /// to resolve.
    async fn announce_mergeability(&self, pull: &Pull) -> Result<()> {
        self.publish_as("pull.mergeability", &pull.repo_id, None, Self::pull_event(pull))
            .await
    }

    /// Works out mergeability again after a push: for the pull requests
    /// whose heads it moved, and, when it moved a repository's default
    /// branch, for every open pull request into it. A failure is logged and
    /// not passed on, so that it never holds up the rest of the push.
    pub(crate) async fn after_push(&self, repo_id: &str, default_branch: bool, moved: &[String]) {
        let mut ids: Vec<String> = moved.to_vec();
        if default_branch {
            match self.targeting(repo_id).await {
                Ok(targeting) => {
                    for id in targeting {
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                }
                Err(error) => worker::console_warn!("mergeability: {error}"),
            }
        }
        for id in ids {
            let assessed = async {
                if let Some(pull) = self.pull_by_id(&id).await? {
                    self.assess_mergeability(&pull).await?;
                }
                Ok::<_, worker::Error>(())
            };
            if let Err(error) = assessed.await {
                worker::console_warn!("mergeability of {id}: {error}");
            }
        }
    }

    /// The open pull requests into a repository, most recently active first.
    async fn targeting(&self, repo_id: &str) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare(
                "SELECT id AS value FROM pulls
                 WHERE repo_id = ? AND status IN ('draft', 'open')
                 ORDER BY updated_at DESC LIMIT ?",
            )
            .bind(&[repo_id.into(), MAX_TARGETING.into()])?
            .all()
            .await?
            .results::<ValueRow>()?
            .into_iter()
            .map(|row| row.value)
            .collect())
    }

    /// Where a pull request's mergeability stands, for showing it. One that
    /// was never worked out, or whose probe was given up on, is worked out
    /// now. A conflict found for an older head is not shown as one.
    pub(crate) async fn mergeability(&self, pull: &Pull) -> Result<(Mergeable, Vec<String>)> {
        if !pull.status.is_active() || pull.head_commit.is_none() {
            return Ok((Mergeable::Unknown, Vec::new()));
        }
        let row = self.merge_row(&pull.id).await?;
        let now = rfc3339(now_ms());
        let stale = row.as_ref().is_none_or(|row| {
            row.mergeable_key.is_none()
                || (row.mergeable.as_deref() == Some("checking")
                    && row.mergeable_until.as_deref().is_none_or(|until| until < now.as_str()))
        });
        let row = if stale {
            if let Err(error) = self.assess_mergeability(pull).await {
                worker::console_warn!("mergeability of {}: {error}", pull.id);
            }
            self.merge_row(&pull.id).await?
        } else {
            row
        };
        let Some(row) = row else {
            return Ok((Mergeable::Unknown, Vec::new()));
        };
        let current = row
            .mergeable_key
            .as_deref()
            .and_then(|key| key.split_once(".."))
            .is_some_and(|(head, _)| Some(head) == pull.head_commit.as_deref());
        let state = Mergeable::parse(row.mergeable.as_deref());
        if state == Mergeable::Conflicting && !current {
            return Ok((Mergeable::Checking, Vec::new()));
        }
        let conflicts = if state == Mergeable::Conflicting {
            row.conflicts
                .as_deref()
                .and_then(|conflicts| serde_json::from_str(conflicts).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok((state, conflicts))
    }

    /// The files that conflict, if the pull request as it is now is known
    /// to conflict with its target as it is now.
    pub(crate) async fn conflicting_files(&self, pull: &Pull) -> Result<Option<Vec<String>>> {
        let Some(row) = self.merge_row(&pull.id).await? else {
            return Ok(None);
        };
        if row.mergeable.as_deref() != Some("conflicting") {
            return Ok(None);
        }
        let current = row
            .mergeable_key
            .as_deref()
            .and_then(|key| key.split_once(".."))
            .is_some_and(|(head, _)| Some(head) == pull.head_commit.as_deref());
        if !current {
            return Ok(None);
        }
        Ok(Some(
            row.conflicts
                .as_deref()
                .and_then(|conflicts| serde_json::from_str(conflicts).ok())
                .unwrap_or_default(),
        ))
    }

    /// Claims the probe a `pull.mergecheck` event asked for, and returns
    /// what a sandbox needs to carry it out.
    pub(crate) async fn start_mergecheck(&self, a: StartMergecheckArgs) -> Result<Outcome<MergecheckJob>> {
        let Some(pull) = self.pull_by_id(&a.pull_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found."));
        };
        if !pull.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This pull request is already {}.", pull.status.as_str()),
            ));
        }
        let Some(row) = self.merge_row(&pull.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found."));
        };
        let Some((head, base)) = row
            .mergeable_key
            .as_deref()
            .filter(|_| row.mergeable.as_deref() == Some("checking"))
            .and_then(|key| key.split_once(".."))
            .map(|(head, base)| (head.to_owned(), base.to_owned()))
        else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "Nothing is waiting to be checked for this pull request.",
            ));
        };
        let now = now_ms();
        let timestamp = rfc3339(now);
        let running = self
            .db
            .prepare(
                "SELECT count(*) AS n FROM pulls
                 WHERE repo_id = ? AND id != ? AND mergeable = 'checking'
                   AND mergeable_token_hash IS NOT NULL AND mergeable_until > ?",
            )
            .bind(&[pull.repo_id.as_str().into(), pull.id.as_str().into(), timestamp.as_str().into()])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n);
        if running >= MAX_PROBES {
            // It waits, and starts when one of those reports.
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This repository has as many merge checks running as it may.",
            ));
        }
        let token = new_token();
        let claimed = self
            .db
            .prepare(
                "UPDATE pulls SET mergeable_token_hash = ?, mergeable_until = ?
                 WHERE id = ? AND mergeable = 'checking' AND mergeable_key = ?
                   AND (mergeable_token_hash IS NULL OR mergeable_until < ?)
                 RETURNING id AS value",
            )
            .bind(&[
                hash(&token).into(),
                rfc3339(now + PROBE_MINUTES * 60 * 1000).into(),
                pull.id.as_str().into(),
                format!("{head}..{base}").into(),
                timestamp.as_str().into(),
            ])?
            .first::<ValueRow>(None)
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request is already being checked.",
            ));
        }
        // Its author can read both the repository and the change.
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: self.author_viewer(&pull).await?,
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found."));
        };
        let path = RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        };
        Ok(Outcome::Ok(MergecheckJob {
            pull_id: pull.id.clone(),
            token,
            source: pull.fork.clone().unwrap_or_else(|| path.clone()),
            branch: pull.branch.clone().unwrap_or_else(|| repo.default_branch.clone()),
            repo: path,
            number: pull.number,
            default_branch: repo.default_branch,
            base,
            head,
            author: pull.author,
        }))
    }

    /// Records what a probe found. Its token is the only credential, and a
    /// probe for a pair of commits that has since moved on is refused.
    pub(crate) async fn report_mergecheck(&self, a: ReportMergecheckArgs) -> Result<Outcome<Mergeable>> {
        let row = self
            .db
            .prepare("SELECT id, repo_id, mergeable_key, mergeable_token_hash FROM pulls WHERE id = ?")
            .bind(&[a.pull_id.as_str().into()])?
            .first::<ProbeRow>(None)
            .await?;
        let Some(row) = row.filter(|row| row.mergeable_token_hash.as_deref() == Some(hash(&a.token).as_str())) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Merge check not found."));
        };
        let conflicts = tidy(a.conflicts);
        let state = if a.error.is_some() {
            Mergeable::Unknown
        } else if conflicts.is_empty() {
            Mergeable::Clean
        } else {
            Mergeable::Conflicting
        };
        if let Some(error) = &a.error {
            worker::console_warn!("merge check of {} could not run: {error}", row.id);
        }
        self.db
            .prepare(
                "UPDATE pulls
                 SET mergeable = ?, conflicts = ?, mergeable_token_hash = NULL, mergeable_until = NULL
                 WHERE id = ? AND mergeable_key IS ? AND mergeable_token_hash = ?",
            )
            .bind(&[
                state.as_str().into(),
                serde_json::to_string(&conflicts)?.into(),
                row.id.as_str().into(),
                crate::optional(&row.mergeable_key),
                hash(&a.token).into(),
            ])?
            .run()
            .await?;
        if let Some(pull) = self.pull_by_id(&row.id).await? {
            self.announce_mergeability(&pull).await?;
        }
        // The next one waiting its turn in this repository.
        let waiting = self
            .db
            .prepare(
                "SELECT id AS value FROM pulls
                 WHERE repo_id = ? AND mergeable = 'checking' AND mergeable_token_hash IS NULL
                   AND status IN ('draft', 'open')
                 ORDER BY updated_at DESC LIMIT 1",
            )
            .bind(&[row.repo_id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        if let Some(waiting) = waiting
            && let Some(pull) = self.pull_by_id(&waiting.value).await?
        {
            let head = pull.head_commit.clone().unwrap_or_default();
            self.ask_for_probe(&pull, &head).await?;
        }
        Ok(Outcome::Ok(state))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn divergence(behind: bool, ours: &[&str], theirs: &[&str]) -> Divergence {
        Divergence {
            head: "h".into(),
            base: "b".into(),
            merge_base: Some("m".into()),
            behind,
            ours: ours.iter().map(|path| (*path).to_owned()).collect(),
            theirs: theirs.iter().map(|path| (*path).to_owned()).collect(),
            truncated: false,
        }
    }

    #[test]
    fn a_branch_that_has_not_moved_cannot_conflict() {
        assert!(!needs_probe(&divergence(false, &["a.rs"], &[])));
    }

    #[test]
    fn changes_to_different_files_cannot_conflict() {
        assert!(!needs_probe(&divergence(true, &["a.rs", "b.rs"], &["c.rs"])));
    }

    #[test]
    fn changes_to_the_same_file_are_probed() {
        assert!(needs_probe(&divergence(true, &["a.rs", "b.rs"], &["b.rs"])));
    }

    #[test]
    fn a_comparison_cut_short_is_probed() {
        let cut = Divergence {
            truncated: true,
            ..divergence(true, &["a.rs"], &["c.rs"])
        };
        assert!(needs_probe(&cut));
    }

    #[test]
    fn reported_paths_are_tidied() {
        let paths = vec![" src/a.rs ".to_owned(), "src/a.rs".to_owned(), String::new(), "b.rs".to_owned()];
        assert_eq!(tidy(paths), ["src/a.rs", "b.rs"]);
        let many: Vec<String> = (0..150).map(|n| format!("f{n}")).collect();
        assert_eq!(tidy(many).len(), MAX_CONFLICTS);
    }
}
