//! Statuses on commits: what workflow runs (and other tools, such as
//! deployments) say about a pull request's head. These are its checks.
//!
//! The rules of the branch a pull request merges into name the checks that
//! must pass (rulesets.rs; `RepoSettings::required_checks` as they stack):
//! a required check that failed, is still running or has not reported
//! refuses the merge, for everyone and for the merge queue (`g1t_rules`
//! says so). Where g1t sees an agent's pull request through,
//! any check that failed sends the agent back to fix it, with what the
//! failing jobs printed; once it is out of revisions, only a required
//! check holds the pull request for a person.

use g1t_contracts::events::ChecksEvent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{
    CommitStatus, RequiredCheck, RequiredState, SeenCheck, SeenChecksArgs, SetCommitStatusArgs, check_name,
    required_checks,
};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

#[derive(Deserialize)]
struct StatusRow {
    context: String,
    state: String,
    description: Option<String>,
    target_url: Option<String>,
    updated_at: String,
    #[serde(default)]
    source: Option<String>,
}

impl From<StatusRow> for CommitStatus {
    fn from(row: StatusRow) -> Self {
        CommitStatus {
            context: row.context,
            state: row.state,
            description: row.description,
            target_url: row.target_url,
            updated_at: row.updated_at,
            source: row.source,
        }
    }
}

#[derive(Deserialize)]
struct HeadRow {
    id: String,
    number: u32,
}

/// What a commit's checks say: every status still running and every one
/// that failed, by context, and where each required check stands.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct WorkflowFacts {
    pub(crate) pending: Vec<String>,
    pub(crate) failed: Vec<String>,
    pub(crate) required: Vec<RequiredCheck>,
}

impl WorkflowFacts {
    /// `required` names the checks the default branch's protection requires.
    pub(crate) fn of(statuses: &[CommitStatus], required: &[String]) -> WorkflowFacts {
        WorkflowFacts {
            pending: statuses.iter().filter(|s| s.state == "pending").map(|s| s.context.clone()).collect(),
            failed: statuses.iter().filter(|s| s.state == "failure" || s.state == "error").map(|s| s.context.clone()).collect(),
            required: required_checks(required, statuses),
        }
    }

    fn required_in(&self, state: RequiredState) -> Vec<String> {
        self.required.iter().filter(|check| check.state == state).map(|check| check.name.clone()).collect()
    }

    /// The required checks that failed, by name.
    pub(crate) fn required_failed(&self) -> Vec<String> {
        self.required_in(RequiredState::Failure)
    }

    /// The required checks nothing has reported on the commit yet.
    pub(crate) fn expected(&self) -> Vec<String> {
        self.required_in(RequiredState::Expected)
    }
}

/// The check names in `(context, last reported)` rows, most recent first:
/// each name once, with the events it was reported for.
pub(crate) fn seen(rows: Vec<(String, String)>) -> Vec<SeenCheck> {
    let mut rows = rows;
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    let mut out: Vec<SeenCheck> = Vec::new();
    for (context, at) in rows {
        let (name, event) = check_name(&context);
        match out.iter_mut().find(|seen| seen.name.eq_ignore_ascii_case(name)) {
            Some(seen) => {
                if let Some(event) = event
                    && !seen.events.iter().any(|known| known == event)
                {
                    seen.events.push(event.to_owned());
                }
            }
            None => out.push(SeenCheck {
                name: name.to_owned(),
                events: event.map(|event| vec![event.to_owned()]).unwrap_or_default(),
                last_seen: at,
            }),
        }
    }
    out
}

/// How far back `seen_checks` looks, and the most contexts it reads.
const SEEN_DAYS: u64 = 30;
const SEEN_LIMIT: u32 = 200;

#[derive(Deserialize)]
struct SeenRow {
    context: String,
    at: String,
}

pub(crate) fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

impl Work {
    /// Where a commit's checks stand, against the repository's required ones.
    pub(crate) async fn facts(&self, repo_id: &str, sha: Option<&str>) -> Result<WorkflowFacts> {
        let (statuses, settings) =
            futures_util::future::try_join(self.statuses(repo_id, sha), self.settings_by_id(repo_id)).await?;
        Ok(WorkflowFacts::of(&statuses, &settings.required_checks))
    }

    /// The check names reported on a repository's commits lately, for
    /// choosing which to require.
    pub(crate) async fn seen_checks(&self, a: SeenChecksArgs) -> Result<Outcome<Vec<SeenCheck>>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let since = rfc3339(now_ms().saturating_sub(SEEN_DAYS * 24 * 60 * 60 * 1000));
        let rows = self
            .db
            .prepare(
                "SELECT context, MAX(updated_at) AS at FROM commit_statuses
                 WHERE repo_id = ? AND updated_at >= ? GROUP BY context ORDER BY at DESC LIMIT ?",
            )
            .bind(&[repo.id.as_str().into(), since.into(), SEEN_LIMIT.into()])?
            .all()
            .await?
            .results::<SeenRow>()?;
        Ok(Outcome::Ok(seen(rows.into_iter().map(|row| (row.context, row.at)).collect())))
    }

    pub(crate) async fn statuses(&self, repo_id: &str, sha: Option<&str>) -> Result<Vec<CommitStatus>> {
        let Some(sha) = sha else { return Ok(Vec::new()) };
        if let Some(found) = self.prefetched_repo(repo_id).filter(|found| found.head.as_deref() == Some(sha)) {
            return Ok(found
                .rows::<StatusRow>(crate::prefetch::Slot::Statuses)?
                .into_iter()
                .map(CommitStatus::from)
                .collect());
        }
        Ok(self
            .db
            .prepare("SELECT context, state, description, target_url, updated_at, source FROM commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY context")
            .bind(&[repo_id.into(), sha.into()])?
            .all()
            .await?
            .results::<StatusRow>()?
            .into_iter()
            .map(CommitStatus::from)
            .collect())
    }

    pub(crate) async fn set_commit_status(&self, a: SetCommitStatusArgs) -> Result<Outcome<bool>> {
        if !matches!(a.state.as_str(), "pending" | "success" | "failure" | "error") {
            return Ok(Outcome::fail(FailureCode::Invalid, "`state` is pending, success, failure or error."));
        }
        self.db
            .prepare(
                "INSERT INTO commit_statuses (repo_id, sha, context, state, description, target_url, updated_at, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id, sha, context) DO UPDATE SET
                   state = excluded.state, description = excluded.description,
                   target_url = excluded.target_url, updated_at = excluded.updated_at,
                   source = excluded.source",
            )
            .bind(&[
                a.repo_id.as_str().into(),
                a.sha.as_str().into(),
                a.context.as_str().into(),
                a.state.as_str().into(),
                a.description.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                a.target_url.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                rfc3339(now_ms()).into(),
                a.source.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
            ])?
            .run()
            .await?;
        if a.state == "pending" {
            return Ok(Outcome::Ok(true));
        }
        // Once every workflow on a pull request's head has finished, its
        // lifecycle moves on, as it does when its checks finish.
        let facts = self.facts(&a.repo_id, Some(&a.sha)).await?;
        if !facts.pending.is_empty() {
            return Ok(Outcome::Ok(true));
        }
        // A merge queue state waiting on its merge_group workflows.
        self.merge_group_finished(&a.repo_id, &a.sha, &facts).await?;
        let heads = self
            .db
            .prepare("SELECT id, number FROM pulls WHERE repo_id = ? AND head_commit = ? AND status IN ('draft', 'open')")
            .bind(&[a.repo_id.as_str().into(), a.sha.as_str().into()])?
            .all()
            .await?
            .results::<HeadRow>()?;
        for head in heads {
            // A pull request g1t stopped on picks back up once what stopped
            // it passes: its workflows, and its checks if it has any. The
            // lifecycle then decides again, within its usual limits.
            if facts.failed.is_empty() {
                let resumed = self
                    .db
                    .prepare(
                        "UPDATE pulls SET stalled = NULL WHERE id = ? AND managed = 1 AND stalled IS NOT NULL
                           AND (check_status IS NULL OR check_status = 'passed') RETURNING id AS value",
                    )
                    .bind(&[head.id.as_str().into()])?
                    .first::<crate::rows::ValueRow>(None)
                    .await?;
                if resumed.is_some() {
                    self.announce_resumed(&head.id, None).await?;
                    self.note(
                        &a.repo_id,
                        head.number,
                        (crate::lifecycle::POLICY_ACTOR_ID, crate::lifecycle::POLICY_ACTOR_NAME),
                        "picked this back up: its workflows pass now",
                    )
                    .await?;
                }
            }
            self.publish_as(
                "checks.completed",
                &a.repo_id,
                None,
                ChecksEvent {
                    pull_id: head.id,
                    repo_id: a.repo_id.clone(),
                    number: head.number,
                    status: if facts.failed.is_empty() { "passed" } else { "failed" },
                    commit: a.sha.clone(),
                },
            )
            .await?;
        }
        Ok(Outcome::Ok(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(context: &str, state: &str) -> CommitStatus {
        CommitStatus {
            context: context.into(),
            state: state.into(),
            description: None,
            target_url: None,
            updated_at: String::new(),
            source: None,
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn only_required_checks_hold_a_merge() {
        let statuses = [status("CI / push", "pending"), status("Lint / pull_request", "failure"), status("Docs", "success")];
        // Nothing required: nothing holds it, whatever failed.
        let free = WorkflowFacts::of(&statuses, &[]);
        assert_eq!(free.pending, ["CI / push"]);
        assert_eq!(free.failed, ["Lint / pull_request"]);
        assert!(free.required_failed().is_empty() && free.expected().is_empty());
        let both = WorkflowFacts::of(&statuses, &names(&["CI", "Lint"]));
        assert_eq!(both.required_failed(), ["Lint"]);
        assert!(WorkflowFacts::of(&[status("Docs", "success")], &names(&["Docs"])).required_failed().is_empty());
    }

    #[test]
    fn a_required_check_nothing_reported_is_expected() {
        let facts = WorkflowFacts::of(&[status("CI / pull_request", "success")], &names(&["CI", "Deploy"]));
        assert_eq!(facts.expected(), ["Deploy"]);
    }

    #[test]
    fn seen_checks_are_named_once_with_their_events() {
        let rows = vec![
            ("CI / push".to_owned(), "2026-10-01T00:00:00Z".to_owned()),
            ("CI / pull_request".to_owned(), "2026-10-03T00:00:00Z".to_owned()),
            ("g1t / deploy".to_owned(), "2026-10-02T00:00:00Z".to_owned()),
        ];
        let seen = seen(rows);
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].name, "CI");
        assert_eq!(seen[0].events, ["pull_request", "push"]);
        assert_eq!(seen[0].last_seen, "2026-10-03T00:00:00Z");
        assert_eq!(seen[1].name, "g1t / deploy");
        assert!(seen[1].events.is_empty());
    }
}
