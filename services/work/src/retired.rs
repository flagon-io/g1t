//! Repositories that are archived, deleted or purged, and branches
//! renamed: what issues, pull requests and agents do about each.
//!
//! An archived repository is read-only: its issues and pull requests are
//! locked and nothing new starts on it. A deleted one looks missing (repos
//! hides it) and keeps its rows for a restore. A purged one is gone, and
//! every row kept for it goes with it.

use g1t_contracts::events::{BranchRenamed, Event, RepoArchived, RepoDeleted};
use g1t_contracts::repos::{Repo, RepoStatus, StatusByIdArgs, archived_message};
use g1t_contracts::{FailureCode, Outcome};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::Work;

/// `Ok` when `repo` may be changed; refused, saying why, when it is
/// archived.
pub(crate) fn writable(repo: &Repo) -> Outcome<()> {
    if repo.archived() {
        Outcome::fail(FailureCode::Forbidden, archived_message(&repo.namespace, &repo.name))
    } else {
        Outcome::Ok(())
    }
}

/// `repo` as found, unless it is archived: then refused, as [`writable`]
/// says. For the steps g1t starts by itself, which stop on a refusal.
pub(crate) fn unless_archived(repo: Outcome<Repo>) -> Outcome<Repo> {
    match repo {
        Outcome::Ok(repo) => match writable(&repo) {
            Outcome::Ok(()) => Outcome::Ok(repo),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        },
        failed => failed,
    }
}

/// `repo.purged`: every row kept for the repository, `?1` its id. Rows
/// kept by pull request go first, while the pull requests still name them.
pub(crate) const PURGED: &[&str] = &[
    "DELETE FROM session_entries WHERE pull_id IN (SELECT id FROM pulls WHERE repo_id = ?1)",
    "DELETE FROM check_runs WHERE pull_id IN (SELECT id FROM pulls WHERE repo_id = ?1)",
    "DELETE FROM review_runs WHERE pull_id IN (SELECT id FROM pulls WHERE repo_id = ?1)",
    "DELETE FROM agent_messages WHERE repo_id = ?1 OR pull_id IN (SELECT id FROM pulls WHERE repo_id = ?1)",
    "DELETE FROM queue_entries WHERE repo_id = ?1",
    "DELETE FROM agent_mentions WHERE repo_id = ?1",
    "DELETE FROM agent_rules WHERE repo_id = ?1",
    "DELETE FROM agent_runs WHERE repo_id = ?1",
    "DELETE FROM commit_statuses WHERE repo_id = ?1",
    "DELETE FROM plans WHERE repo_id = ?1",
    "DELETE FROM comments WHERE repo_id = ?1",
    "DELETE FROM pulls WHERE repo_id = ?1",
    "DELETE FROM issues WHERE repo_id = ?1",
    "DELETE FROM counters WHERE repo_id = ?1",
    "DELETE FROM repo_settings WHERE repo_id = ?1",
    "DELETE FROM memories WHERE scope = 'project' AND scope_key = ?1",
    "DELETE FROM guardrails WHERE scope <> 'workspace' AND scope_key = ?1",
];

/// A repository renamed or transferred (see `g1t_kit::transfer`): runs
/// waiting for an agent slot name it by path in their payload, at `$.repo`
/// or `$.job.repo`; they follow it, into its workspace's queue now.
pub(crate) const WAITS_MOVED: &[&str] = &[
    "UPDATE agent_waits SET workspace = lower(?3),
       payload = json_set(payload, '$.repo.namespace', ?3, '$.repo.name', ?6)
     WHERE json_valid(payload)
       AND lower(json_extract(payload, '$.repo.namespace')) = lower(?4)
       AND lower(json_extract(payload, '$.repo.name')) = lower(?7)",
    "UPDATE agent_waits SET workspace = lower(?3),
       payload = json_set(payload, '$.job.repo.namespace', ?3, '$.job.repo.name', ?6)
     WHERE json_valid(payload)
       AND lower(json_extract(payload, '$.job.repo.namespace')) = lower(?4)
       AND lower(json_extract(payload, '$.job.repo.name')) = lower(?7)",
];

/// What a run stopped because its repository was archived or deleted says
/// as its last step; [`Work::runs_in_repo`] finds such runs by it.
const STOPPED_STEP: &str = "Stopped: the repository was archived or deleted.";

/// `repo.deleted` and `repo.archived`: the repository's agent runs that
/// are queued or running stop, `?1` the step they end on, `?2` the time,
/// `?3` its id.
const STOP_RUNS: &str = "UPDATE agent_runs SET status = 'stopped', step = ?1, finished_at = ?2, updated_at = ?2
     WHERE repo_id = ?3 AND status IN ('queued', 'running')";

/// And runs waiting for an agent slot in it are dropped: `?1` its
/// workspace, `?2` its name, as the payload names it (see [`WAITS_MOVED`]).
const DROP_WAITS: &[&str] = &[
    "DELETE FROM agent_waits WHERE json_valid(payload)
       AND lower(json_extract(payload, '$.repo.namespace')) = lower(?1)
       AND lower(json_extract(payload, '$.repo.name')) = lower(?2)",
    "DELETE FROM agent_waits WHERE json_valid(payload)
       AND lower(json_extract(payload, '$.job.repo.namespace')) = lower(?1)
       AND lower(json_extract(payload, '$.job.repo.name')) = lower(?2)",
];

/// `runs_in_repo` (internal, for the runner): the agent runs of a
/// repository whose sandboxes should be stopped: those queued or running,
/// and those work stopped in the last hour because the repository was
/// archived or deleted. Takes `{ "repoId" }`; returns `[RepoRun]`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunsInRepoArgs {
    pub repo_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoRun {
    pub run_id: String,
    pub sandbox: String,
    pub kind: String,
    pub status: String,
    pub pull_id: Option<String>,
}

/// The repository, by id and path, that `event` says was deleted or
/// archived (not unarchived): its runs stop.
fn stopping(event: &Event) -> Option<(String, String, String)> {
    let data = event.data.clone();
    match event.kind.as_str() {
        "repo.deleted" => serde_json::from_value::<RepoDeleted>(data).ok().map(|e| (e.repo_id, e.namespace, e.name)),
        "repo.archived" => serde_json::from_value::<RepoArchived>(data)
            .ok()
            .filter(|e| e.archived)
            .map(|e| (e.repo_id, e.namespace, e.name)),
        _ => None,
    }
}

/// `branch.renamed`: open pull requests from `?2` in repository `?1`
/// come from `?3` now. A fork carries its change on its own default
/// branch, so only branches of the repository itself are named.
const BRANCH_RENAMED: &str = "UPDATE pulls SET source_branch = ?3
     WHERE repo_id = ?1 AND source_branch = ?2 AND fork_repo_id IS NULL
       AND status IN ('draft', 'open')";

impl Work {
    /// Whether work may start on the repository: neither archived nor
    /// deleted. When repos cannot say, it is taken as active, and the
    /// repos calls that follow (which hide deleted repositories) decide.
    pub(crate) async fn repo_active(&self, repo_id: &str) -> Result<bool> {
        let status: Result<RepoStatus> = g1t_kit::call(
            &self.repos,
            "status_by_id",
            &StatusByIdArgs {
                id: repo_id.to_owned(),
            },
        )
        .await;
        Ok(match status {
            Ok(status) => status.active(),
            Err(error) => {
                worker::console_error!("status_by_id {repo_id}: {error}");
                true
            }
        })
    }

    /// See [`RunsInRepoArgs`].
    pub(crate) async fn runs_in_repo(&self, a: RunsInRepoArgs) -> Result<Vec<RepoRun>> {
        let hour_ago = rfc3339(now_ms().saturating_sub(60 * 60 * 1000));
        self.db
            .prepare(
                "SELECT id AS run_id, sandbox, kind, status, pull_id FROM agent_runs
                 WHERE repo_id = ?1 AND (status IN ('queued', 'running')
                   OR (status = 'stopped' AND step = ?2 AND finished_at >= ?3))
                 ORDER BY created_at LIMIT 200",
            )
            .bind(&[a.repo_id.as_str().into(), STOPPED_STEP.into(), hour_ago.as_str().into()])?
            .all()
            .await?
            .results::<RepoRun>()
    }

    /// `repo.deleted` and `repo.archived`: its agent runs stop (the runner
    /// stops their sandboxes, see [`RunsInRepoArgs`]) and runs waiting for
    /// a slot in it are dropped. Rows are kept, for a restore.
    async fn stop_runs_in(&self, repo_id: &str, namespace: &str, name: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        let mut batch = vec![self
            .db
            .prepare(STOP_RUNS)
            .bind(&[STOPPED_STEP.into(), now.as_str().into(), repo_id.into()])?];
        if !namespace.is_empty() && !name.is_empty() {
            for sql in DROP_WAITS {
                batch.push(self.db.prepare(*sql).bind(&[namespace.into(), name.into()])?);
            }
        }
        self.db.batch(batch).await?;
        Ok(())
    }

    /// `repo.purged`, `repo.deleted`, `repo.archived` and `branch.renamed`.
    /// Says whether `event` was one this handles completely.
    pub(crate) async fn on_retired(&self, event: &Event) -> Result<bool> {
        if g1t_kit::lifecycle::on_purged(&self.db, event, PURGED).await? {
            return Ok(true);
        }
        if let Some((repo_id, namespace, name)) = stopping(event) {
            self.stop_runs_in(&repo_id, &namespace, &name).await?;
            return Ok(true);
        }
        if event.kind != "branch.renamed" {
            return Ok(false);
        }
        let Ok(renamed) = serde_json::from_value::<BranchRenamed>(event.data.clone()) else {
            worker::console_error!("branch.renamed {} could not be read", event.id);
            return Ok(true);
        };
        if renamed.from == renamed.to {
            return Ok(true);
        }
        self.db
            .prepare(BRANCH_RENAMED)
            .bind(&[
                renamed.repo_id.as_str().into(),
                renamed.from.as_str().into(),
                renamed.to.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(archived_at: Option<&str>) -> Repo {
        Repo {
            id: "rep_1".into(),
            namespace: "acme".into(),
            name: "web".into(),
            description: None,
            is_private: false,
            owner_id: "usr_1".into(),
            default_branch: "main".into(),
            fork_of: None,
            protected: false,
            created_at: "2026-10-05T00:00:00Z".into(),
            topics: Vec::new(),
            website: None,
            archived_at: archived_at.map(str::to_owned),
        }
    }

    #[test]
    fn an_archived_repository_refuses_changes() {
        assert!(matches!(writable(&repo(None)), Outcome::Ok(())));
        match writable(&repo(Some("2026-10-05T00:00:00Z"))) {
            Outcome::Fail(failure) => {
                assert_eq!(failure.code, FailureCode::Forbidden);
                assert!(failure.message.contains("acme/web is archived"));
            }
            Outcome::Ok(()) => panic!("an archived repository was writable"),
        }
    }

    #[test]
    fn purging_takes_only_the_repository_id() {
        for sql in PURGED {
            assert_eq!(g1t_kit::transfer::parameters(sql), 1, "{sql}");
        }
        // Rows kept by pull request go before the pull requests do.
        let pulls = PURGED.iter().position(|sql| sql.starts_with("DELETE FROM pulls")).unwrap();
        for table in ["session_entries", "check_runs", "review_runs", "agent_messages"] {
            let at = PURGED.iter().position(|sql| sql.contains(&format!("FROM {table} "))).unwrap();
            assert!(at < pulls, "{table}");
        }
    }

    fn event(kind: &str, data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "repos".into(),
            time: "2026-10-05T00:00:00Z".into(),
            repo_id: Some("rep_1".into()),
            actor: None,
            data,
        }
    }

    #[test]
    fn deleting_or_archiving_stops_runs_and_unarchiving_does_not() {
        let named = Some(("rep_1".to_owned(), "acme".to_owned(), "web".to_owned()));
        let data = serde_json::json!({ "repoId": "rep_1", "namespace": "acme", "name": "web", "archived": true });
        assert_eq!(stopping(&event("repo.deleted", data.clone())), named);
        assert_eq!(stopping(&event("repo.archived", data)), named);
        let unarchived = serde_json::json!({ "repoId": "rep_1", "namespace": "acme", "name": "web", "archived": false });
        assert_eq!(stopping(&event("repo.unarchived", unarchived.clone())), None);
        assert_eq!(stopping(&event("repo.archived", unarchived)), None);
        assert_eq!(STOP_RUNS.matches('?').count(), 4);
        for sql in DROP_WAITS {
            assert_eq!(g1t_kit::transfer::parameters(sql), 2, "{sql}");
        }
    }

    #[test]
    fn waiting_runs_follow_with_the_names_they_bind() {
        for sql in WAITS_MOVED {
            assert_eq!(g1t_kit::transfer::parameters(sql), 7, "{sql}");
        }
        assert_eq!(g1t_kit::transfer::parameters(BRANCH_RENAMED), 3);
    }
}
