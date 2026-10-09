//! Checks on commits: statuses and check runs that CI, integrations and
//! tokens report through the API, and g1t Actions' jobs read as check runs.
//!
//! A check run reported here is kept in `commit_check_runs`, grouped per
//! reporter and commit in `commit_check_suites`, and also stands as a
//! status of its name (`commit_statuses.check_run_id`), so required checks
//! and rulesets are met by either (statuses.rs `store_status`). A g1t
//! Actions job is not kept here: the actions service's runs and jobs are
//! read as suites and check runs (`g1t_contracts::checks::job_check_run`).

use std::collections::{BTreeMap, HashMap};

use g1t_contracts::access::Capability;
use g1t_contracts::actions::{RunActionArgs, RunDetail};
use g1t_contracts::checks::*;
use g1t_contracts::repos::{Commit, LogArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{CommitStatus, SetCommitStatusArgs};
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Work, allowed};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

fn invalid<T>(message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(FailureCode::Invalid, message)
}

fn no_check_run<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Check run not found.")
}

fn no_suite<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Check suite not found.")
}

/// `owner/name`, as pages on the site name it.
fn full_name(repo: &Repo) -> String {
    format!("{}/{}", repo.namespace, repo.name)
}

/// A check run's page on the site.
fn page(repo: &Repo, id: &str) -> String {
    format!("/{}/checks/{id}", full_name(repo))
}

/// What a check run's status says, as a status's description can hold it.
fn description_of(title: Option<&str>, summary: Option<&str>) -> Option<String> {
    let text = title.filter(|title| !title.trim().is_empty()).or(summary)?;
    let line = text.lines().find(|line| !line.trim().is_empty())?.trim();
    let mut out: String = line.chars().take(MAX_DESCRIPTION_CHARS).collect();
    if line.chars().count() > MAX_DESCRIPTION_CHARS {
        out = out.chars().take(MAX_DESCRIPTION_CHARS - 1).collect::<String>() + "…";
    }
    Some(out)
}

#[derive(Deserialize)]
struct RunRow {
    id: String,
    suite_id: String,
    head_sha: String,
    name: String,
    status: String,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    details_url: Option<String>,
    external_id: Option<String>,
    title: Option<String>,
    summary: Option<String>,
    text: Option<String>,
    annotations_count: u32,
    actions: String,
    app_slug: String,
    app_name: String,
    created_at: String,
}

impl RunRow {
    fn view(self, repo: &Repo) -> CommitCheckRun {
        CommitCheckRun {
            html_url: page(repo, &self.id),
            id: self.id,
            name: self.name,
            head_sha: self.head_sha,
            status: self.status,
            conclusion: self.conclusion,
            started_at: self.started_at,
            completed_at: self.completed_at,
            details_url: self.details_url,
            external_id: self.external_id,
            output: CheckOutput { title: self.title, summary: self.summary, text: self.text, annotations_count: self.annotations_count },
            actions: serde_json::from_str(&self.actions).unwrap_or_default(),
            check_suite: SuiteRef { id: self.suite_id },
            app: CheckApp { slug: self.app_slug, name: self.app_name },
            workflow: None,
            created_at: self.created_at,
        }
    }
}

#[derive(Deserialize)]
struct SuiteRow {
    id: String,
    head_sha: String,
    head_branch: Option<String>,
    status: String,
    conclusion: Option<String>,
    app_slug: String,
    app_name: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    runs: u32,
}

impl From<SuiteRow> for CommitCheckSuite {
    fn from(row: SuiteRow) -> Self {
        CommitCheckSuite {
            id: row.id,
            head_sha: row.head_sha,
            head_branch: row.head_branch,
            status: row.status,
            conclusion: row.conclusion,
            app: CheckApp { slug: row.app_slug, name: row.app_name },
            name: None,
            latest_check_runs_count: row.runs,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Deserialize)]
struct AnnotationRow {
    path: String,
    start_line: u32,
    end_line: u32,
    start_column: Option<u32>,
    end_column: Option<u32>,
    annotation_level: String,
    message: String,
    title: Option<String>,
    raw_details: Option<String>,
}

#[derive(Deserialize)]
struct StatusRow {
    sha: String,
    context: String,
    state: String,
    description: Option<String>,
    target_url: Option<String>,
    updated_at: String,
    source: Option<String>,
    check_run_id: Option<String>,
}

impl StatusRow {
    fn status(self) -> (String, CommitStatus) {
        (
            self.sha,
            CommitStatus {
                context: self.context,
                state: self.state,
                description: self.description,
                target_url: self.target_url,
                updated_at: self.updated_at,
                source: self.source,
                check_run_id: self.check_run_id,
            },
        )
    }
}

const RUN_COLUMNS: &str = "id, suite_id, head_sha, name, status, conclusion, started_at, completed_at, details_url, external_id,
  title, summary, text, annotations_count, actions, app_slug, app_name, created_at";

const SUITE_COLUMNS: &str = "s.id, s.head_sha, s.head_branch, s.status, s.conclusion, s.app_slug, s.app_name, s.created_at, s.updated_at,
  (SELECT count(DISTINCT name) FROM commit_check_runs r WHERE r.suite_id = s.id) AS runs";

/// `?, ?, ?` for `count` values.
fn marks(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// Each name's latest check run, of runs newest first.
fn latest_by_name(runs: Vec<CommitCheckRun>) -> Vec<CommitCheckRun> {
    let mut seen: Vec<(String, String)> = Vec::new();
    runs.into_iter()
        .filter(|run| {
            let key = (run.check_suite.id.clone(), run.name.clone());
            if seen.contains(&key) {
                false
            } else {
                seen.push(key);
                true
            }
        })
        .collect()
}

/// The check runs of g1t Actions jobs in `details`, newest run first:
/// with `all`, every run's; otherwise the latest of each workflow and
/// event.
fn job_runs(repo: &Repo, details: &[RunDetail], all: bool) -> Vec<CommitCheckRun> {
    let pairs: Vec<(g1t_contracts::actions::WorkflowRun, &RunDetail)> =
        details.iter().map(|detail| (detail.run.clone(), detail)).collect();
    let chosen: Vec<&(g1t_contracts::actions::WorkflowRun, &RunDetail)> =
        if all { pairs.iter().collect() } else { latest_runs(&pairs) };
    let name = full_name(repo);
    chosen
        .into_iter()
        .flat_map(|(run, detail)| detail.jobs.iter().map(|job| job_check_run(&name, run, job)).collect::<Vec<_>>())
        .collect()
}

impl Work {
    /// The repository, if `viewer` may see it.
    async fn readable(&self, path: &RepoPath, viewer: &Viewer) -> Result<Outcome<Repo>> {
        self.repo(path, viewer).await
    }

    /// The repository, if `actor` may report checks on it: the Write role,
    /// and not archived.
    async fn reportable(&self, path: &RepoPath, actor: &User) -> Result<Outcome<Repo>> {
        let repo = check!(self.repo(path, &Some(actor.clone())).await?);
        check!(allowed(Some(actor), &repo, Capability::Push));
        check!(crate::retired::not_archived(&repo));
        Ok(Outcome::Ok(repo))
    }

    /// The commit `git_ref` names: a full SHA as it is, a branch, tag or
    /// short SHA as the repository resolves it.
    async fn commit_of(&self, path: &RepoPath, viewer: &Viewer, git_ref: &str) -> Result<Outcome<String>> {
        let git_ref = git_ref.trim();
        if is_full_sha(git_ref) {
            return Ok(Outcome::Ok(git_ref.to_ascii_lowercase()));
        }
        if git_ref.is_empty() {
            return Ok(invalid("Name a commit, branch or tag."));
        }
        let found: Outcome<Vec<Commit>> = g1t_kit::call(
            &self.repos,
            "log",
            &LogArgs { path: path.clone(), viewer: viewer.clone(), git_ref: Some(git_ref.to_owned()), limit: 1 },
        )
        .await?;
        Ok(match found {
            Outcome::Ok(commits) => match commits.into_iter().next() {
                Some(commit) => Outcome::Ok(commit.hash),
                None => Outcome::fail(FailureCode::NotFound, format!("No commit, branch or tag {git_ref}.")),
            },
            Outcome::Fail(_) => Outcome::fail(FailureCode::NotFound, format!("No commit, branch or tag {git_ref}.")),
        })
    }

    /// g1t Actions' runs and jobs, by commits, by a run or by a job.
    async fn actions_runs(&self, args: ActionsChecksArgs) -> Result<Vec<RunDetail>> {
        // Without the actions service a commit's other checks still show.
        Ok(g1t_kit::call(&self.actions, "check_runs", &args).await.unwrap_or_default())
    }

    async fn stored_run(&self, repo: &Repo, id: &str) -> Result<Option<CommitCheckRun>> {
        Ok(self
            .db
            .prepare(format!("SELECT {RUN_COLUMNS} FROM commit_check_runs WHERE id = ? AND repo_id = ?"))
            .bind(&[id.into(), repo.id.as_str().into()])?
            .first::<RunRow>(None)
            .await?
            .map(|row| row.view(repo)))
    }

    /// A check run by id: one reported here, or a g1t Actions job.
    async fn any_run(&self, repo: &Repo, id: &str) -> Result<Option<(CommitCheckRun, Option<RunDetail>)>> {
        if id.starts_with("job_") {
            let details = self.actions_runs(ActionsChecksArgs { repo_id: repo.id.clone(), job_id: Some(id.to_owned()), ..Default::default() }).await?;
            let found = details.into_iter().find_map(|detail| {
                let job = detail.jobs.iter().find(|job| job.id == id)?.clone();
                Some((job_check_run(&full_name(repo), &detail.run, &job), detail))
            });
            return Ok(found.map(|(run, detail)| (run, Some(detail))));
        }
        Ok(self.stored_run(repo, id).await?.map(|run| (run, None)))
    }

    /// Sets the status a check run stands as, which moves on whatever
    /// waits for the commit's checks.
    async fn project(&self, repo: &Repo, run: &CommitCheckRun, previous_name: Option<&str>) -> Result<()> {
        if let Some(previous) = previous_name.filter(|previous| *previous != run.name) {
            self.db
                .prepare("DELETE FROM commit_statuses WHERE repo_id = ? AND sha = ? AND context = ? AND check_run_id = ?")
                .bind(&[repo.id.as_str().into(), run.head_sha.as_str().into(), previous.into(), run.id.as_str().into()])?
                .run()
                .await?;
        }
        let stored = self
            .store_status(
                SetCommitStatusArgs {
                    repo_id: repo.id.clone(),
                    sha: run.head_sha.clone(),
                    context: run.name.clone(),
                    state: status_state_of(&run.status, run.conclusion.as_deref()).to_owned(),
                    description: description_of(run.output.title.as_deref(), run.output.summary.as_deref()),
                    target_url: Some(run.details_url.clone().unwrap_or_else(|| run.html_url.clone())),
                    source: Some("api".to_owned()),
                },
                Some(&run.id),
            )
            .await?;
        if let Outcome::Fail(failure) = stored {
            worker::console_error!("work: a check run's status was not set: {}", failure.message);
        }
        Ok(())
    }

    /// Works a suite's status out again from its latest check runs; says
    /// when it has just completed.
    async fn refresh_suite(&self, repo: &Repo, suite_id: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct Latest {
            name: String,
            status: String,
            conclusion: Option<String>,
        }
        let rows = self
            .db
            .prepare("SELECT name, status, conclusion FROM commit_check_runs WHERE suite_id = ? ORDER BY created_at DESC, id DESC")
            .bind(&[suite_id.into()])?
            .all()
            .await?
            .results::<Latest>()?;
        let mut names: Vec<String> = Vec::new();
        let mut latest: Vec<(String, Option<String>)> = Vec::new();
        for row in rows {
            if !names.contains(&row.name) {
                names.push(row.name);
                latest.push((row.status, row.conclusion));
            }
        }
        let (status, conclusion) = suite_state(&latest);
        let changed = self
            .db
            .prepare(
                "UPDATE commit_check_suites SET status = ?, conclusion = ?, updated_at = ?
                 WHERE id = ? AND (status IS NOT ? OR conclusion IS NOT ?) RETURNING status AS value",
            )
            .bind(&[status.into(), optional(conclusion), rfc3339(now_ms()).into(), suite_id.into(), status.into(), optional(conclusion)])?
            .first::<crate::rows::ValueRow>(None)
            .await?;
        if changed.is_some() && status == "completed"
            && let Some(suite) = self.stored_suite(repo, suite_id).await?
        {
            self.publish_as("check_suite.completed", &repo.id, None, CheckSuiteEvent { repo_id: repo.id.clone(), check_suite: suite }).await?;
        }
        Ok(())
    }

    async fn stored_suite(&self, repo: &Repo, id: &str) -> Result<Option<CommitCheckSuite>> {
        Ok(self
            .db
            .prepare(format!("SELECT {SUITE_COLUMNS} FROM commit_check_suites s WHERE s.id = ? AND s.repo_id = ?"))
            .bind(&[id.into(), repo.id.as_str().into()])?
            .first::<SuiteRow>(None)
            .await?
            .map(CommitCheckSuite::from))
    }

    /// Adds annotations after the ones a check run has, up to the most it
    /// keeps. Returns how many it has now.
    async fn annotate(&self, run_id: &str, had: u32, annotations: &[CheckAnnotation]) -> Result<u32> {
        let room = MAX_ANNOTATIONS.saturating_sub(had) as usize;
        let mut statements = Vec::new();
        for (index, annotation) in annotations.iter().take(room).enumerate() {
            let seq = had + u32::try_from(index).unwrap_or(0);
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO commit_check_annotations (run_id, seq, path, start_line, end_line, start_column, end_column,
                           annotation_level, message, title, raw_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        run_id.into(),
                        seq.into(),
                        annotation.path.trim().into(),
                        annotation.start_line.into(),
                        annotation.end_line.into(),
                        annotation.start_column.map_or(JsValue::NULL, JsValue::from),
                        annotation.end_column.map_or(JsValue::NULL, JsValue::from),
                        annotation.annotation_level.as_str().into(),
                        annotation.message.as_str().into(),
                        optional(annotation.title.as_deref()),
                        optional(annotation.raw_details.as_deref()),
                    ])?,
            );
        }
        let added = u32::try_from(statements.len()).unwrap_or(0);
        if !statements.is_empty() {
            self.db.batch(statements).await?;
        }
        Ok(had + added)
    }

    /// `create_commit_status`.
    pub(crate) async fn create_commit_status(&self, a: CreateStatusArgs) -> Result<Outcome<CommitStatus>> {
        let context = a.context.as_deref().map(str::trim).filter(|context| !context.is_empty()).unwrap_or("default").to_owned();
        let description = a.description.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
        let target_url = a.target_url.as_deref().map(str::trim).filter(|url| !url.is_empty()).map(str::to_owned);
        if let Err(message) = validate_status(&a.state, &context, description.as_deref(), target_url.as_deref()) {
            return Ok(invalid(message));
        }
        let repo = check!(self.reportable(&a.repo, &a.actor).await?);
        let sha = check!(self.commit_of(&a.repo, &Some(a.actor.clone()), &a.sha).await?);
        check!(
            self.store_status(
                SetCommitStatusArgs {
                    repo_id: repo.id.clone(),
                    sha: sha.clone(),
                    context: context.clone(),
                    state: a.state.clone(),
                    description: description.clone(),
                    target_url: target_url.clone(),
                    source: Some("api".to_owned()),
                },
                None,
            )
            .await?
        );
        self.publish(
            "status.created",
            &repo.id,
            &a.actor,
            StatusEvent { repo_id: repo.id.clone(), sha: sha.clone(), context: context.clone(), state: a.state.clone(), description: description.clone(), target_url: target_url.clone() },
        )
        .await?;
        Ok(Outcome::Ok(CommitStatus {
            context,
            state: a.state,
            description,
            target_url,
            updated_at: rfc3339(now_ms()),
            source: Some("api".to_owned()),
            check_run_id: None,
        }))
    }

    async fn statuses_of(&self, repo: &Repo, shas: &[String], own_only: bool) -> Result<Vec<(String, CommitStatus)>> {
        if shas.is_empty() {
            return Ok(Vec::new());
        }
        let mut binds: Vec<JsValue> = vec![repo.id.as_str().into()];
        binds.extend(shas.iter().map(|sha| JsValue::from(sha.as_str())));
        let own = if own_only { " AND check_run_id IS NULL" } else { "" };
        Ok(self
            .db
            .prepare(format!(
                "SELECT sha, context, state, description, target_url, updated_at, source, check_run_id FROM commit_statuses
                 WHERE repo_id = ? AND sha IN ({}){own} ORDER BY updated_at DESC, context",
                marks(shas.len())
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<StatusRow>()?
            .into_iter()
            .map(StatusRow::status)
            .collect())
    }

    /// `commit_statuses`: a commit's statuses, newest first, without the
    /// ones check runs stand as.
    pub(crate) async fn commit_statuses(&self, a: RefArgs) -> Result<Outcome<Vec<CommitStatus>>> {
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        let sha = check!(self.commit_of(&a.repo, &a.viewer, &a.git_ref).await?);
        Ok(Outcome::Ok(self.statuses_of(&repo, &[sha], true).await?.into_iter().map(|(_, status)| status).collect()))
    }

    /// `combined_status`.
    pub(crate) async fn combined_status(&self, a: RefArgs) -> Result<Outcome<CombinedStatus>> {
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        let sha = check!(self.commit_of(&a.repo, &a.viewer, &a.git_ref).await?);
        let mut statuses: Vec<CommitStatus> =
            self.statuses_of(&repo, std::slice::from_ref(&sha), true).await?.into_iter().map(|(_, status)| status).collect();
        statuses.sort_by(|a, b| a.context.cmp(&b.context));
        Ok(Outcome::Ok(CombinedStatus {
            state: combined_state(&statuses).to_owned(),
            sha,
            total_count: u32::try_from(statuses.len()).unwrap_or(u32::MAX),
            statuses,
        }))
    }

    /// `create_check_run`.
    pub(crate) async fn create_check_run(&self, a: CreateCheckRunArgs) -> Result<Outcome<CommitCheckRun>> {
        if let Err(message) = validate_run(&a.run, true) {
            return Ok(invalid(message));
        }
        let repo = check!(self.reportable(&a.repo, &a.actor).await?);
        let head = a.run.head_sha.as_deref().unwrap_or_default();
        let sha = check!(self.commit_of(&a.repo, &Some(a.actor.clone()), head).await?);
        let app = CheckApp::of(&a.actor, a.app.as_deref());
        let now = rfc3339(now_ms());
        // The reporter's suite for the commit, made the first time.
        self.db
            .prepare(
                "INSERT INTO commit_check_suites (id, repo_id, head_sha, head_branch, app_slug, app_name, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (repo_id, head_sha, app_slug) DO NOTHING",
            )
            .bind(&[
                new_id("cs", now_ms()).into(),
                repo.id.as_str().into(),
                sha.as_str().into(),
                optional((!is_full_sha(head)).then_some(head.trim())),
                app.slug.as_str().into(),
                app.name.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        let suite = self
            .db
            .prepare("SELECT id AS value FROM commit_check_suites WHERE repo_id = ? AND head_sha = ? AND app_slug = ?")
            .bind(&[repo.id.as_str().into(), sha.as_str().into(), app.slug.as_str().into()])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .map(|row| row.value)
            .unwrap_or_default();
        let input = &a.run;
        let status = match (&input.status, &input.conclusion) {
            (_, Some(_)) => "completed",
            (Some(status), None) => status.as_str(),
            (None, None) => "queued",
        };
        let started_at = input.started_at.clone().or_else(|| (status != "queued").then(|| now.clone()));
        let completed_at = (status == "completed").then(|| input.completed_at.clone().unwrap_or_else(|| now.clone()));
        let output = input.output.clone().unwrap_or_default();
        let actions = input.actions.clone().unwrap_or_default();
        let id = new_id("cr", now_ms());
        self.db
            .prepare(
                "INSERT INTO commit_check_runs (id, repo_id, suite_id, head_sha, name, status, conclusion, started_at, completed_at,
                   details_url, external_id, title, summary, text, actions, app_slug, app_name, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                suite.as_str().into(),
                sha.as_str().into(),
                input.name.as_deref().unwrap_or_default().trim().into(),
                status.into(),
                optional(input.conclusion.as_deref()),
                optional(started_at.as_deref()),
                optional(completed_at.as_deref()),
                optional(input.details_url.as_deref().filter(|url| !url.is_empty())),
                optional(input.external_id.as_deref()),
                optional(output.title.as_deref()),
                optional(output.summary.as_deref()),
                optional(output.text.as_deref()),
                serde_json::to_string(&actions)?.into(),
                app.slug.as_str().into(),
                app.name.as_str().into(),
                a.actor.id.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        if !output.annotations.is_empty() {
            let count = self.annotate(&id, 0, &output.annotations).await?;
            self.db
                .prepare("UPDATE commit_check_runs SET annotations_count = ? WHERE id = ?")
                .bind(&[count.into(), id.as_str().into()])?
                .run()
                .await?;
        }
        let Some(run) = self.stored_run(&repo, &id).await? else {
            return Ok(no_check_run());
        };
        self.project(&repo, &run, None).await?;
        self.refresh_suite(&repo, &suite).await?;
        let event = CheckRunEvent { repo_id: repo.id.clone(), check_run: run.clone(), requested_action: None };
        self.publish("check_run.created", &repo.id, &a.actor, event.clone()).await?;
        if run.status == "completed" {
            self.publish("check_run.completed", &repo.id, &a.actor, event).await?;
        }
        Ok(Outcome::Ok(run))
    }

    /// `update_check_run`.
    pub(crate) async fn update_check_run(&self, a: UpdateCheckRunArgs) -> Result<Outcome<CommitCheckRun>> {
        if let Err(message) = validate_run(&a.run, false) {
            return Ok(invalid(message));
        }
        let repo = check!(self.reportable(&a.repo, &a.actor).await?);
        if a.id.starts_with("job_") {
            return Ok(invalid("That is a g1t Actions job: its workflow reports it, and it cannot be changed through the API."));
        }
        let Some(before) = self.stored_run(&repo, &a.id).await? else {
            return Ok(no_check_run());
        };
        let input = &a.run;
        let now = rfc3339(now_ms());
        let status = match (&input.status, &input.conclusion) {
            (_, Some(_)) => "completed".to_owned(),
            (Some(status), None) => status.clone(),
            (None, None) => before.status.clone(),
        };
        let conclusion = if status == "completed" { input.conclusion.clone().or_else(|| before.conclusion.clone()) } else { None };
        if status == "completed" && conclusion.is_none() {
            return Ok(invalid("A completed check run needs a `conclusion`."));
        }
        let started_at = input
            .started_at
            .clone()
            .or_else(|| before.started_at.clone())
            .or_else(|| (status != "queued").then(|| now.clone()));
        let completed_at = (status == "completed")
            .then(|| input.completed_at.clone().or_else(|| before.completed_at.clone()).unwrap_or_else(|| now.clone()));
        let output = input.output.clone().unwrap_or_default();
        let title = output.title.clone().or_else(|| before.output.title.clone());
        let summary = output.summary.clone().or_else(|| before.output.summary.clone());
        let text = output.text.clone().or_else(|| before.output.text.clone());
        let actions = input.actions.clone().unwrap_or_else(|| before.actions.clone());
        let name = input.name.as_deref().map(str::trim).unwrap_or(&before.name).to_owned();
        let details_url = match input.details_url.as_deref() {
            Some("") => None,
            Some(url) => Some(url.to_owned()),
            None => before.details_url.clone(),
        };
        let count = if output.annotations.is_empty() {
            before.output.annotations_count
        } else {
            self.annotate(&before.id, before.output.annotations_count, &output.annotations).await?
        };
        self.db
            .prepare(
                "UPDATE commit_check_runs SET name = ?, status = ?, conclusion = ?, started_at = ?, completed_at = ?, details_url = ?,
                   external_id = ?, title = ?, summary = ?, text = ?, actions = ?, annotations_count = ?, updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                name.as_str().into(),
                status.as_str().into(),
                optional(conclusion.as_deref()),
                optional(started_at.as_deref()),
                optional(completed_at.as_deref()),
                optional(details_url.as_deref()),
                optional(input.external_id.as_deref().or(before.external_id.as_deref())),
                optional(title.as_deref()),
                optional(summary.as_deref()),
                optional(text.as_deref()),
                serde_json::to_string(&actions)?.into(),
                count.into(),
                now.as_str().into(),
                before.id.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(run) = self.stored_run(&repo, &before.id).await? else {
            return Ok(no_check_run());
        };
        self.project(&repo, &run, Some(&before.name)).await?;
        self.refresh_suite(&repo, &run.check_suite.id).await?;
        if before.status != "completed" && run.status == "completed" {
            let event = CheckRunEvent { repo_id: repo.id.clone(), check_run: run.clone(), requested_action: None };
            self.publish("check_run.completed", &repo.id, &a.actor, event).await?;
        }
        Ok(Outcome::Ok(run))
    }

    /// `get_check_run`.
    pub(crate) async fn get_check_run(&self, a: CheckIdArgs) -> Result<Outcome<CommitCheckRun>> {
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        Ok(match self.any_run(&repo, &a.id).await? {
            Some((run, _)) => Outcome::Ok(run),
            None => no_check_run(),
        })
    }

    /// `check_run_annotations`, in the order they were reported.
    pub(crate) async fn check_run_annotations(&self, a: CheckIdArgs) -> Result<Outcome<Vec<CheckAnnotation>>> {
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        let Some((run, detail)) = self.any_run(&repo, &a.id).await? else {
            return Ok(no_check_run());
        };
        if let Some(detail) = detail {
            let job = detail.jobs.iter().find(|job| job.id == run.id);
            return Ok(Outcome::Ok(job.map(job_annotations).unwrap_or_default()));
        }
        let rows = self
            .db
            .prepare(
                "SELECT path, start_line, end_line, start_column, end_column, annotation_level, message, title, raw_details
                 FROM commit_check_annotations WHERE run_id = ? ORDER BY seq",
            )
            .bind(&[run.id.as_str().into()])?
            .all()
            .await?
            .results::<AnnotationRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| CheckAnnotation {
                    path: row.path,
                    start_line: row.start_line,
                    end_line: row.end_line,
                    start_column: row.start_column,
                    end_column: row.end_column,
                    annotation_level: row.annotation_level,
                    message: row.message,
                    title: row.title,
                    raw_details: row.raw_details,
                })
                .collect(),
        ))
    }

    /// The check runs reported here on `shas`, newest first.
    async fn stored_runs(&self, repo: &Repo, shas: &[String]) -> Result<Vec<CommitCheckRun>> {
        if shas.is_empty() {
            return Ok(Vec::new());
        }
        let mut binds: Vec<JsValue> = vec![repo.id.as_str().into()];
        binds.extend(shas.iter().map(|sha| JsValue::from(sha.as_str())));
        Ok(self
            .db
            .prepare(format!(
                "SELECT {RUN_COLUMNS} FROM commit_check_runs WHERE repo_id = ? AND head_sha IN ({}) ORDER BY created_at DESC, id DESC",
                marks(shas.len())
            ))
            .bind(&binds)?
            .all()
            .await?
            .results::<RunRow>()?
            .into_iter()
            .map(|row| row.view(repo))
            .collect())
    }

    /// `ref_check_runs`.
    pub(crate) async fn ref_check_runs(&self, a: RefCheckRunsArgs) -> Result<Outcome<CheckRunList>> {
        let all = match a.filter.as_deref().unwrap_or("latest") {
            "latest" => false,
            "all" => true,
            _ => return Ok(invalid("`filter` is latest or all.")),
        };
        if let Some(status) = a.status.as_deref()
            && !STATUSES.contains(&status)
        {
            return Ok(invalid("`status` is queued, in_progress or completed."));
        }
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        let sha = check!(self.commit_of(&a.repo, &a.viewer, &a.git_ref).await?);
        let shas = [sha.clone()];
        let (stored, details) = futures_util::future::try_join(
            self.stored_runs(&repo, &shas),
            self.actions_runs(ActionsChecksArgs { repo_id: repo.id.clone(), shas: vec![sha], ..Default::default() }),
        )
        .await?;
        let stored = if all { stored } else { latest_by_name(stored) };
        let mut runs: Vec<CommitCheckRun> = stored.into_iter().chain(job_runs(&repo, &details, all)).collect();
        runs.retain(|run| {
            a.check_name.as_deref().is_none_or(|name| run.name == name)
                && a.status.as_deref().is_none_or(|status| run.status == status)
                && a.app.as_deref().is_none_or(|app| run.app.slug == app)
        });
        Ok(Outcome::Ok(CheckRunList { total_count: u32::try_from(runs.len()).unwrap_or(u32::MAX), check_runs: runs }))
    }

    /// `ref_check_suites`.
    pub(crate) async fn ref_check_suites(&self, a: RefCheckSuitesArgs) -> Result<Outcome<CheckSuiteList>> {
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        let sha = check!(self.commit_of(&a.repo, &a.viewer, &a.git_ref).await?);
        let stored = self
            .db
            .prepare(format!("SELECT {SUITE_COLUMNS} FROM commit_check_suites s WHERE s.repo_id = ? AND s.head_sha = ? ORDER BY s.created_at DESC"))
            .bind(&[repo.id.as_str().into(), sha.as_str().into()])?
            .all()
            .await?
            .results::<SuiteRow>()?;
        let names: HashMap<String, Vec<String>> = match &a.check_name {
            Some(_) => {
                let mut by_suite: HashMap<String, Vec<String>> = HashMap::new();
                for run in self.stored_runs(&repo, std::slice::from_ref(&sha)).await? {
                    by_suite.entry(run.check_suite.id).or_default().push(run.name);
                }
                by_suite
            }
            None => HashMap::new(),
        };
        let details = self.actions_runs(ActionsChecksArgs { repo_id: repo.id.clone(), shas: vec![sha], ..Default::default() }).await?;
        let mut suites: Vec<CommitCheckSuite> = stored
            .into_iter()
            .map(CommitCheckSuite::from)
            .filter(|suite| a.check_name.as_ref().is_none_or(|name| names.get(&suite.id).is_some_and(|list| list.contains(name))))
            .collect();
        suites.extend(
            details
                .iter()
                .filter(|detail| a.check_name.as_ref().is_none_or(|name| detail.jobs.iter().any(|job| job.name == *name)))
                .map(|detail| run_check_suite(&detail.run, &detail.jobs)),
        );
        suites.retain(|suite| a.app.as_deref().is_none_or(|app| suite.app.slug == app));
        Ok(Outcome::Ok(CheckSuiteList { total_count: u32::try_from(suites.len()).unwrap_or(u32::MAX), check_suites: suites }))
    }

    /// `get_check_suite`.
    pub(crate) async fn get_check_suite(&self, a: CheckIdArgs) -> Result<Outcome<CommitCheckSuite>> {
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        if a.id.starts_with("run_") {
            let details = self.actions_runs(ActionsChecksArgs { repo_id: repo.id.clone(), run_id: Some(a.id.clone()), ..Default::default() }).await?;
            return Ok(match details.first() {
                Some(detail) => Outcome::Ok(run_check_suite(&detail.run, &detail.jobs)),
                None => no_suite(),
            });
        }
        Ok(match self.stored_suite(&repo, &a.id).await? {
            Some(suite) => Outcome::Ok(suite),
            None => no_suite(),
        })
    }

    /// Runs a g1t Actions workflow run again, for a job or the run asked for.
    async fn rerun_actions(&self, actor: &User, repo: &RepoPath, run_id: &str) -> Result<Outcome<bool>> {
        let rerun: Outcome<Value> = g1t_kit::call(
            &self.actions,
            "rerun",
            &RunActionArgs { actor: actor.clone(), repo: repo.clone(), id: run_id.to_owned(), failed_only: false, job: None, debug: false, force: false },
        )
        .await?;
        Ok(match rerun {
            Outcome::Ok(_) => Outcome::Ok(true),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    /// `rerequest_check_run`.
    pub(crate) async fn rerequest_check_run(&self, a: RerequestArgs) -> Result<Outcome<bool>> {
        let repo = check!(self.reportable(&a.repo, &a.actor).await?);
        let Some((run, detail)) = self.any_run(&repo, &a.id).await? else {
            return Ok(no_check_run());
        };
        if let Some(detail) = detail {
            return self.rerun_actions(&a.actor, &a.repo, &detail.run.id).await;
        }
        let event = CheckRunEvent { repo_id: repo.id.clone(), check_run: run, requested_action: None };
        self.publish("check_run.rerequested", &repo.id, &a.actor, event).await?;
        Ok(Outcome::Ok(true))
    }

    /// `rerequest_check_suite`.
    pub(crate) async fn rerequest_check_suite(&self, a: RerequestArgs) -> Result<Outcome<bool>> {
        let repo = check!(self.reportable(&a.repo, &a.actor).await?);
        if a.id.starts_with("run_") {
            return self.rerun_actions(&a.actor, &a.repo, &a.id).await;
        }
        let Some(suite) = self.stored_suite(&repo, &a.id).await? else {
            return Ok(no_suite());
        };
        self.publish("check_suite.rerequested", &repo.id, &a.actor, CheckSuiteEvent { repo_id: repo.id.clone(), check_suite: suite }).await?;
        Ok(Outcome::Ok(true))
    }

    /// `request_check_action`.
    pub(crate) async fn request_check_action(&self, a: RequestActionArgs) -> Result<Outcome<bool>> {
        let repo = check!(self.reportable(&a.repo, &a.actor).await?);
        let Some(run) = self.stored_run(&repo, &a.id).await? else {
            return Ok(no_check_run());
        };
        if !run.actions.iter().any(|action| action.identifier == a.identifier) {
            return Ok(invalid("This check run offers no such action."));
        }
        let event = CheckRunEvent { repo_id: repo.id.clone(), check_run: run, requested_action: Some(a.identifier) };
        self.publish("check_run.requested_action", &repo.id, &a.actor, event).await?;
        Ok(Outcome::Ok(true))
    }

    /// `commit_checks`: every check on each commit, in one read of each
    /// kind for all of them.
    pub(crate) async fn commit_checks(&self, a: CommitChecksArgs) -> Result<Outcome<BTreeMap<String, CommitChecks>>> {
        let mut shas: Vec<String> = Vec::new();
        for sha in a.shas.iter().map(|sha| sha.trim().to_ascii_lowercase()) {
            if is_full_sha(&sha) && !shas.contains(&sha) {
                shas.push(sha);
            }
        }
        if shas.len() > MAX_COMMITS {
            return Ok(invalid(format!("At most {MAX_COMMITS} commits at a time.")));
        }
        let repo = check!(self.readable(&a.repo, &a.viewer).await?);
        if shas.is_empty() {
            return Ok(Outcome::Ok(BTreeMap::new()));
        }
        let (statuses, stored, details) = futures_util::future::try_join3(
            self.statuses_of(&repo, &shas, false),
            self.stored_runs(&repo, &shas),
            self.actions_runs(ActionsChecksArgs { repo_id: repo.id.clone(), shas: shas.clone(), ..Default::default() }),
        )
        .await?;
        let stored = latest_by_name(stored);
        let pairs: Vec<(g1t_contracts::actions::WorkflowRun, &RunDetail)> =
            details.iter().map(|detail| (detail.run.clone(), detail)).collect();
        let latest = latest_runs(&pairs);
        let mut out = BTreeMap::new();
        for sha in shas {
            let mut runs: Vec<CommitCheckRun> = stored.iter().filter(|run| run.head_sha == sha).cloned().collect();
            let mut job_contexts = Vec::new();
            for (run, detail) in latest.iter().filter(|(run, _)| run.sha == sha) {
                if !detail.jobs.is_empty() {
                    job_contexts.push(format!("{} / {}", run.name, run.event));
                }
                runs.extend(detail.jobs.iter().map(|job| job_check_run(&full_name(&repo), run, job)));
            }
            let mine: Vec<CommitStatus> =
                statuses.iter().filter(|(of, _)| *of == sha).map(|(_, status)| status.clone()).collect();
            let summary = summarize(&runs, &mine, &job_contexts);
            if summary.total > 0 {
                out.insert(sha, summary);
            }
        }
        Ok(Outcome::Ok(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_runs_status_says_what_its_title_says_in_a_line() {
        assert_eq!(description_of(Some("3 problems"), Some("long")), Some("3 problems".to_owned()));
        assert_eq!(description_of(None, Some("\n## Coverage 81%\nmore")), Some("## Coverage 81%".to_owned()));
        assert_eq!(description_of(Some(" "), None), None);
        let long = "x".repeat(300);
        let cut = description_of(Some(&long), None).unwrap();
        assert_eq!(cut.chars().count(), MAX_DESCRIPTION_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn only_each_names_latest_run_counts() {
        let run = |id: &str, suite: &str, name: &str| CommitCheckRun {
            id: id.into(),
            name: name.into(),
            check_suite: SuiteRef { id: suite.into() },
            ..CommitCheckRun::default()
        };
        let kept = latest_by_name(vec![run("cr_3", "cs_1", "lint"), run("cr_2", "cs_1", "lint"), run("cr_1", "cs_2", "lint")]);
        let ids: Vec<&str> = kept.iter().map(|run| run.id.as_str()).collect();
        assert_eq!(ids, ["cr_3", "cr_1"]);
    }
}
