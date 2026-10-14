//! Statuses on commits: what workflow runs (and other tools, such as
//! deployments) say about a pull request's head. These are its checks.
//!
//! The rules of the branch a pull request merges into name the checks that
//! must pass (rulesets.rs; `RepoSettings::required_checks` as they stack):
//! a required check that failed, is still running or has not reported
//! refuses the merge, for everyone and for the merge queue (`g1t_rules`
//! says so).

use g1t_contracts::actions::{Job, WorkflowRun};
use g1t_contracts::checks::StatusEvent;
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
    #[serde(default)]
    check_run_id: Option<String>,
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
            check_run_id: row.check_run_id,
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
    /// Missing and pending required checks are not evidence of a passing build.
    pub(crate) fn passed(&self) -> bool {
        self.pending.is_empty() && self.failed.is_empty()
            && self.required.iter().all(|check| check.state == RequiredState::Success)
    }

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

/// One merge-queue attempt (or probe) whose evidence is being read: the
/// commit it built, the branch its `merge_group` runs were started on, when
/// it was claimed, and how many runs its dispatch registered.
pub(crate) struct Attempt<'a> {
    pub(crate) sha: &'a str,
    pub(crate) head_ref: String,
    pub(crate) since: Option<&'a str>,
    pub(crate) runs: u32,
}

/// What reported on the commit for this attempt, and only for it.
pub(crate) struct AttemptEvidence {
    /// Workflow-level statuses of this attempt's runs, and other tools'
    /// statuses set since the attempt was claimed.
    pub(crate) statuses: Vec<CommitStatus>,
    /// This attempt's runs' jobs, as statuses (required checks named for jobs).
    pub(crate) jobs: Vec<CommitStatus>,
    /// Fewer of its runs were found than its dispatch registered.
    pub(crate) runs_missing: bool,
}

/// The same commit can be built by several attempts (a fast-forward merge
/// is the pull request's own head), and statuses are kept per commit and
/// context: an earlier attempt's result, or the pull request's own checks,
/// would otherwise decide this one. Actions' statuses are replaced by this
/// attempt's own runs (started on its own branch); anything else counts
/// only once set after the attempt was claimed.
pub(crate) fn attempt_evidence(
    statuses: &[CommitStatus],
    runs: &[(WorkflowRun, Vec<Job>)],
    attempt: &Attempt<'_>,
) -> AttemptEvidence {
    let mut kept: Vec<CommitStatus> = statuses
        .iter()
        .filter(|status| status.source.as_deref() != Some("actions"))
        .filter(|status| attempt.since.is_none_or(|since| status.updated_at.as_str() >= since))
        .cloned()
        .collect();
    let ours: Vec<(WorkflowRun, Vec<Job>)> = runs
        .iter()
        .filter(|(run, _)| run.sha == attempt.sha && run.git_ref == attempt.head_ref)
        .cloned()
        .collect();
    let latest = g1t_contracts::checks::latest_runs(&ours);
    for (run, _) in &latest {
        let state = match (run.status.as_str(), run.conclusion.as_deref()) {
            ("completed", Some("success" | "skipped" | "neutral")) => "success",
            ("completed", _) => "failure",
            _ => "pending",
        };
        kept.push(CommitStatus {
            context: format!("{} / {}", run.name, run.event),
            state: state.to_owned(),
            description: run.error.clone(),
            target_url: None,
            updated_at: run.finished_at.clone().unwrap_or_else(|| run.created_at.clone()),
            source: Some("actions".to_owned()),
            check_run_id: None,
        });
    }
    AttemptEvidence {
        statuses: kept,
        jobs: g1t_contracts::checks::job_statuses(&ours, attempt.sha),
        runs_missing: (latest.len() as u32) < attempt.runs,
    }
}

impl AttemptEvidence {
    /// Where the attempt stands against the required checks. Runs its
    /// dispatch registered but that cannot be found are still to come.
    pub(crate) fn facts(&self, required: &[String]) -> WorkflowFacts {
        let mut facts = WorkflowFacts::of(&self.statuses, required);
        if !required.is_empty() {
            let mut all = self.statuses.clone();
            all.extend(self.jobs.iter().cloned());
            facts.required = required_checks(required, &all);
        }
        if self.runs_missing {
            facts.pending.push("merge_group workflows".to_owned());
        }
        facts
    }

    /// Everything the attempt's rules are judged against.
    pub(crate) fn all(&self) -> Vec<CommitStatus> {
        let mut all = self.statuses.clone();
        all.extend(self.jobs.iter().cloned());
        all
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
        self.workflow_facts(repo_id, sha, &statuses, &settings.required_checks).await
    }

    /// What `statuses`, a commit's, say, with each required check also met
    /// by the g1t Actions jobs of its name ([`Work::with_job_checks`]). Jobs
    /// count only toward required checks: whether workflows are running or
    /// failed is their runs' statuses' to say.
    pub(crate) async fn workflow_facts(
        &self,
        repo_id: &str,
        sha: Option<&str>,
        statuses: &[CommitStatus],
        required: &[String],
    ) -> Result<WorkflowFacts> {
        let mut facts = WorkflowFacts::of(statuses, required);
        if !required.is_empty() {
            facts.required = required_checks(required, &self.with_job_checks(repo_id, sha, statuses.to_vec()).await?);
        }
        Ok(facts)
    }

    /// This attempt's evidence on its commit ([`attempt_evidence`]).
    pub(crate) async fn attempt_statuses(&self, repo_id: &str, attempt: &Attempt<'_>) -> Result<AttemptEvidence> {
        let (statuses, runs) = futures_util::future::try_join(
            self.statuses(repo_id, Some(attempt.sha)),
            self.actions_runs(g1t_contracts::checks::ActionsChecksArgs {
                repo_id: repo_id.to_owned(),
                shas: vec![attempt.sha.to_owned()],
                ..Default::default()
            }),
        )
        .await?;
        let runs: Vec<_> = runs.into_iter().map(|detail| (detail.run, detail.jobs)).collect();
        Ok(attempt_evidence(&statuses, &runs, attempt))
    }

    /// Where one attempt stands against the default branch's required checks.
    pub(crate) async fn attempt_facts(&self, repo_id: &str, attempt: &Attempt<'_>) -> Result<WorkflowFacts> {
        let (evidence, settings) =
            futures_util::future::try_join(self.attempt_statuses(repo_id, attempt), self.settings_by_id(repo_id)).await?;
        Ok(evidence.facts(&settings.required_checks))
    }

    /// `statuses` and, for each g1t Actions job on `sha`, the status its
    /// check run stands as (`g1t_contracts::checks::job_statuses`), so a
    /// required check named for a job, as GitHub's are, is met by it.
    pub(crate) async fn with_job_checks(&self, repo_id: &str, sha: Option<&str>, mut statuses: Vec<CommitStatus>) -> Result<Vec<CommitStatus>> {
        let Some(sha) = sha else { return Ok(statuses) };
        let details = self
            .actions_runs(g1t_contracts::checks::ActionsChecksArgs { repo_id: repo_id.to_owned(), shas: vec![sha.to_owned()], ..Default::default() })
            .await?;
        let runs: Vec<_> = details.into_iter().map(|detail| (detail.run, detail.jobs)).collect();
        statuses.extend(g1t_contracts::checks::job_statuses(&runs, sha));
        Ok(statuses)
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
            .prepare("SELECT context, state, description, target_url, updated_at, source, check_run_id FROM commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY context")
            .bind(&[repo_id.into(), sha.into()])?
            .all()
            .await?
            .results::<StatusRow>()?
            .into_iter()
            .map(CommitStatus::from)
            .collect())
    }

    /// A status from another part of g1t: a workflow run, a deploy, a scan.
    /// Published as `status.created`, as one set through the API is, so
    /// webhooks hear it.
    /// Publishing is best effort: the status is kept either way.
    pub(crate) async fn set_commit_status(&self, a: SetCommitStatusArgs) -> Result<Outcome<bool>> {
        let event = StatusEvent {
            repo_id: a.repo_id.clone(),
            sha: a.sha.clone(),
            context: a.context.clone(),
            state: a.state.clone(),
            description: a.description.clone(),
            target_url: a.target_url.clone(),
        };
        let repo_id = a.repo_id.clone();
        let stored = self.store_status(a, None).await?;
        if matches!(stored, Outcome::Ok(_))
            && let Err(error) = self.publish_as("status.created", &repo_id, None, event).await
        {
            worker::console_error!("status.created not published: {error}");
        }
        Ok(stored)
    }

    /// Sets a status, standing for check run `check_run_id` if it does,
    /// and moves on what was waiting for the commit's checks.
    pub(crate) async fn store_status(&self, a: SetCommitStatusArgs, check_run_id: Option<&str>) -> Result<Outcome<bool>> {
        if !matches!(a.state.as_str(), "pending" | "success" | "failure" | "error") {
            return Ok(Outcome::fail(FailureCode::Invalid, "`state` is pending, success, failure or error."));
        }
        self.db
            .prepare(
                "INSERT INTO commit_statuses (repo_id, sha, context, state, description, target_url, updated_at, source, check_run_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id, sha, context) DO UPDATE SET
                   state = excluded.state, description = excluded.description,
                   target_url = excluded.target_url, updated_at = excluded.updated_at,
                   source = excluded.source, check_run_id = excluded.check_run_id",
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
                check_run_id.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
            ])?
            .run()
            .await?;
        if a.state == "pending" {
            return Ok(Outcome::Ok(true));
        }
        // A merge queue state waiting on its merge_group workflows: judged
        // on its own attempt's evidence, whatever else is pending on the
        // commit (the pull request's own checks, an earlier attempt's).
        self.merge_group_finished(&a.repo_id, &a.sha).await?;
        // Once every workflow on a pull request's head has finished, its
        // lifecycle moves on, as it does when its checks finish.
        let facts = self.facts(&a.repo_id, Some(&a.sha)).await?;
        if !facts.pending.is_empty() {
            return Ok(Outcome::Ok(true));
        }
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
            // A pull request the merge queue took out rejoins once a new
            // commit's checks all pass (integration.rs).
            if facts.failed.is_empty() && facts.required_failed().is_empty() && facts.expected().is_empty() {
                self.requeue_if_fixed(&head.id, &a.sha).await?;
            }
            self.publish_as(
                "checks.completed",
                &a.repo_id,
                None,
                ChecksEvent {
                    pull_id: head.id.clone(),
                    repo_id: a.repo_id.clone(),
                    number: head.number,
                    status: if facts.failed.is_empty() { "passed" } else { "failed" },
                    commit: a.sha.clone(),
                },
            )
            .await?;
            // A merge that brought it up to date and waits for its required
            // checks on this commit lands, or stops on one that failed. The
            // status is kept either way.
            if let Err(error) = self.land_when_checked(&head.id).await {
                worker::console_error!("landing {} after its checks: {error}", head.id);
            }
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
            check_run_id: None,
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    fn run(id: &str, git_ref: &str, event: &str, status: &str, conclusion: Option<&str>) -> (WorkflowRun, Vec<Job>) {
        let run: WorkflowRun = serde_json::from_value(serde_json::json!({
            "id": id, "workflowId": "wf", "path": ".g1t/workflows/ci.yml", "name": "CI", "title": "t",
            "number": 1, "attempt": 1, "event": event, "ref": git_ref, "sha": "same", "pull": null,
            "status": status, "conclusion": conclusion, "error": null, "actor": null,
            "createdAt": "2026-10-14T10:00:00.000Z", "startedAt": null, "finishedAt": null,
        }))
        .unwrap();
        let job: Job = serde_json::from_value(serde_json::json!({
            "id": format!("job_{id}"), "runId": id, "key": "test", "name": "test", "needs": [],
            "status": status, "conclusion": conclusion, "steps": [], "annotations": [],
            "reason": null, "startedAt": null, "finishedAt": null,
        }))
        .unwrap();
        (run, vec![job])
    }

    fn attempt(head_ref: &str, runs: u32) -> Attempt<'static> {
        Attempt { sha: "same", head_ref: head_ref.into(), since: Some("2026-10-14T10:00:00.000Z"), runs }
    }

    #[test]
    fn a_retry_on_the_same_commit_is_not_decided_by_the_earlier_attempt() {
        const OLD: &str = "refs/heads/g1t-queue/qen_1-old";
        const NEW: &str = "refs/heads/g1t-queue/qen_1-new";
        let required = names(&["CI"]);
        // The commit's statuses: the flaky earlier attempt's failure under
        // the shared context, and the pull request's own passing checks.
        let mut flaky = status("CI / merge_group", "failure");
        flaky.source = Some("actions".into());
        let mut own = status("CI / pull_request", "success");
        own.source = Some("actions".into());
        let statuses = [flaky, own];
        let old = run("run_old", OLD, "merge_group", "completed", Some("failure"));
        let pr = run("run_pr", "refs/heads/feature", "pull_request", "completed", Some("success"));
        // Read right after the retry's dispatch: its run is still going.
        let going = run("run_new", NEW, "merge_group", "in_progress", None);
        let runs = [going.clone(), pr.clone(), old.clone()];
        let facts = attempt_evidence(&statuses, &runs, &attempt(NEW, 1)).facts(&required);
        assert!(facts.failed.is_empty(), "the earlier attempt's failure is not this one's: {facts:?}");
        assert!(!facts.pending.is_empty() && !facts.passed());
        // Nor does the pull request's own run satisfy the required check.
        let none = attempt_evidence(&statuses, &[pr.clone(), old.clone()], &attempt(NEW, 0)).facts(&required);
        assert!(!none.passed());
        assert_eq!(none.expected(), ["CI"]);
        let done = run("run_new", NEW, "merge_group", "completed", Some("success"));
        let facts = attempt_evidence(&statuses, &[done, pr, old], &attempt(NEW, 1)).facts(&required);
        assert!(facts.passed(), "{facts:?}");
    }

    #[test]
    fn runs_the_dispatch_registered_but_cannot_be_read_are_still_pending() {
        // The actions service could not be read: no runs at all.
        let facts = attempt_evidence(&[], &[], &attempt("refs/heads/g1t-queue/x", 2)).facts(&[]);
        assert!(!facts.passed(), "never a pass from missing evidence");
        assert!(!facts.pending.is_empty());
        let one = run("run_a", "refs/heads/g1t-queue/x", "merge_group", "completed", Some("success"));
        assert!(!attempt_evidence(&[], &[one.clone()], &attempt("refs/heads/g1t-queue/x", 2)).facts(&[]).passed());
        assert!(attempt_evidence(&[], &[one], &attempt("refs/heads/g1t-queue/x", 1)).facts(&[]).passed());
    }

    #[test]
    fn other_tools_count_only_once_set_after_the_attempt_was_claimed() {
        let mut before = status("deploy / preview", "failure");
        before.updated_at = "2026-10-14T09:59:59.999Z".into();
        let mut after = status("lint", "success");
        after.updated_at = "2026-10-14T10:00:00.000Z".into();
        let evidence = attempt_evidence(&[before, after], &[], &attempt("refs/heads/g1t-queue/x", 0));
        let contexts: Vec<&str> = evidence.statuses.iter().map(|status| status.context.as_str()).collect();
        assert_eq!(contexts, ["lint"]);
    }

    #[test]
    fn integration_evidence_requires_completed_checks() {
        let required = names(&["CI"]);
        assert!(!WorkflowFacts::of(&[], &required).passed());
        assert!(!WorkflowFacts::of(&[status("CI", "pending")], &required).passed());
        assert!(!WorkflowFacts::of(&[status("CI", "failure")], &required).passed());
        assert!(WorkflowFacts::of(&[status("CI", "success")], &required).passed());
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
