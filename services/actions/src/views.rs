//! Reading: workflows, runs (any attempt), a run's jobs, a job's log and
//! its steps' summaries.

use g1t_actions::workflow::{self, Severity};
use g1t_contracts::access::Capability;
use g1t_contracts::checks::{ActionsChecksArgs, MAX_COMMITS};
use g1t_contracts::actions::{
    Annotation, Job, JobLog, JobLogText, JobLogTextArgs, JobSummary, LogChunk, LogsArgs, MAX_RUN_LOG_BYTES, RunArgs, RunAttempt, RunDetail,
    RunLogsArgs, RunsArgs, SetWorkflowEnabledArgs, StepState, StepSummary, SummariesArgs, Workflow, WorkflowNote, WorkflowRun, WorkflowsArgs,
};
use g1t_contracts::{FailureCode, Outcome};
use serde::Deserialize;
use worker::Result;

use crate::plan::{JobRow, RunRow};
use crate::sync::WorkflowRow;
use crate::{Actions, check, fail};

const RUNS_SHOWN: u32 = 50;

fn notes(source: &str) -> Vec<WorkflowNote> {
    workflow::parse(source)
        .map(|w| {
            w.notes
                .into_iter()
                .map(|note| WorkflowNote {
                    severity: match note.severity {
                        Severity::Info => "info",
                        Severity::Warning => "warning",
                        Severity::Unsupported => "unsupported",
                    }
                    .to_owned(),
                    job: note.job,
                    message: note.message,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A job of an earlier attempt, as it ended (migration 0009).
#[derive(Clone, Deserialize)]
pub struct AttemptJobRow {
    pub id: String,
    pub run_id: String,
    pub log_id: String,
    pub key: String,
    pub name: String,
    pub needs: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub steps: String,
    pub annotations: String,
    pub reason: Option<String>,
    pub environment: Option<String>,
    pub labels: Option<String>,
    pub runner_name: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

fn attempt_job_view(row: AttemptJobRow) -> Job {
    Job {
        needs: serde_json::from_str(&row.needs).unwrap_or_default(),
        id: row.id,
        run_id: row.run_id,
        key: row.key,
        name: row.name,
        status: row.status,
        conclusion: row.conclusion,
        steps: serde_json::from_str::<Vec<StepState>>(&row.steps).unwrap_or_default(),
        annotations: serde_json::from_str::<Vec<Annotation>>(&row.annotations).unwrap_or_default(),
        reason: row.reason,
        started_at: row.started_at,
        finished_at: row.finished_at,
        environment: row.environment,
        self_hosted: row.labels.is_some(),
        runner: row.runner_name,
        cancelling: false,
    }
}

/// An earlier attempt of a run, as it ended.
#[derive(Clone, Deserialize)]
struct AttemptRow {
    attempt: u64,
    conclusion: Option<String>,
    actor: Option<String>,
    debug: u32,
    started_at: Option<String>,
    finished_at: Option<String>,
}

/// One attempt's jobs, each with where its logs and summary are kept.
struct AttemptJobs {
    jobs: Vec<Job>,
    log_ids: Vec<String>,
}

fn job_view(row: JobRow) -> Job {
    let needs = row.needs();
    let cancelling = row.cancel_requested_at.is_some() && row.status != "completed";
    Job {
        cancelling,
        id: row.id,
        run_id: row.run_id,
        key: row.key,
        name: row.name,
        needs,
        status: row.status,
        conclusion: row.conclusion,
        steps: serde_json::from_str::<Vec<StepState>>(&row.steps).unwrap_or_default(),
        annotations: serde_json::from_str::<Vec<Annotation>>(&row.annotations).unwrap_or_default(),
        reason: row.reason,
        started_at: row.started_at,
        finished_at: row.finished_at,
        environment: row.environment,
        self_hosted: row.labels.is_some(),
        runner: row.runner_name,
    }
}

impl Actions {
    async fn summary(&self, row: &WorkflowRow) -> Result<Workflow> {
        let last_run = self
            .db
            .prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY id DESC LIMIT 1")
            .bind(&[row.id.as_str().into()])?
            .first::<RunRow>(None)
            .await?
            .map(|run| run.summary());
        let parsed = workflow::parse(&row.source).ok();
        Ok(Workflow {
            id: row.id.clone(),
            path: row.path.clone(),
            name: row.name.clone(),
            events: serde_json::from_str(&row.events).unwrap_or_default(),
            state: row.state.clone(),
            error: row.error.clone(),
            notes: notes(&row.source),
            dispatch: parsed
                .as_ref()
                .filter(|_| row.error.is_none())
                .and_then(|w| w.trigger("workflow_dispatch"))
                .map(|t| serde_json::Value::Object(t.inputs.clone())),
            last_run,
        })
    }

    pub async fn workflows(&self, a: WorkflowsArgs) -> Result<Outcome<Vec<Workflow>>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        if !self.synced(&repo.id).await?
            && let Some(ws) = self.workspace_actor(&repo.namespace).await?
        {
            self.sync(&repo, &ws).await?;
        }
        // A file that is gone stays listed while it has runs, unless one in
        // the folder now has its name: then it would read as a second copy.
        // Files outside the folder are from before g1t stopped reading
        // `.github`; their runs stay under All workflows.
        let rows = self
            .db
            .prepare(
                "SELECT * FROM workflows w WHERE w.repo_id = ?1 AND w.path LIKE ?2
                   AND (w.error IS NULL OR w.error NOT LIKE 'Its file is%'
                        OR (w.id IN (SELECT workflow_id FROM runs WHERE repo_id = ?1)
                            AND NOT EXISTS (SELECT 1 FROM workflows o WHERE o.repo_id = ?1 AND o.id <> w.id
                                            AND o.name = w.name AND (o.error IS NULL OR o.error NOT LIKE 'Its file is%'))))
                 ORDER BY w.name",
            )
            .bind(&[repo.id.as_str().into(), format!("{}/%", g1t_actions::workflow::FOLDER).into()])?
            .all()
            .await?
            .results::<WorkflowRow>()?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(self.summary(row).await?);
        }
        Ok(Outcome::Ok(out))
    }

    pub async fn runs(&self, a: RunsArgs) -> Result<Outcome<Vec<WorkflowRun>>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        let mut sql = "SELECT * FROM runs WHERE repo_id = ?".to_owned();
        let mut binds: Vec<worker::wasm_bindgen::JsValue> = vec![repo.id.as_str().into()];
        if let Some(workflow) = &a.workflow {
            sql.push_str(" AND (workflow_id = ? OR path = ? OR path = ?)");
            binds.push(workflow.as_str().into());
            binds.push(workflow.as_str().into());
            binds.push(format!("{}/{workflow}", g1t_actions::workflow::FOLDER).into());
        }
        if let Some(branch) = &a.branch {
            sql.push_str(" AND (git_ref = ? OR json_extract(info, '$.headRef') = ?)");
            binds.push(format!("refs/heads/{branch}").into());
            binds.push(branch.as_str().into());
        }
        if let Some(event) = &a.event {
            sql.push_str(" AND event = ?");
            binds.push(event.as_str().into());
        }
        if let Some(pull) = a.pull {
            sql.push_str(" AND pull = ?");
            binds.push(pull.into());
        }
        if let Some(sha) = &a.sha {
            sql.push_str(" AND sha = ?");
            binds.push(sha.as_str().into());
        }
        sql.push_str(" ORDER BY id DESC LIMIT ?");
        binds.push(a.limit.unwrap_or(RUNS_SHOWN).clamp(1, 100).into());
        let rows = self.db.prepare(sql).bind(&binds)?.all().await?.results::<RunRow>()?;
        Ok(Outcome::Ok(rows.iter().map(RunRow::summary).collect()))
    }

    /// Every attempt of a run, oldest first, the current one last.
    async fn attempts_of(&self, run: &RunRow) -> Result<Vec<RunAttempt>> {
        let mut attempts: Vec<RunAttempt> = self
            .db
            .prepare("SELECT attempt, conclusion, actor, debug, started_at, finished_at FROM run_attempts WHERE run_id = ? ORDER BY attempt")
            .bind(&[run.id.as_str().into()])?
            .all()
            .await?
            .results::<AttemptRow>()?
            .into_iter()
            .filter(|row| row.attempt < run.attempt)
            .map(|row| RunAttempt {
                attempt: row.attempt,
                status: "completed".to_owned(),
                conclusion: row.conclusion,
                actor: row.actor,
                debug: row.debug != 0,
                started_at: row.started_at,
                finished_at: row.finished_at,
            })
            .collect();
        attempts.push(RunAttempt {
            attempt: run.attempt,
            status: run.status.clone(),
            conclusion: run.conclusion.clone().filter(|_| run.status == "completed"),
            actor: run.triggering_actor.clone().or_else(|| run.actor.clone()),
            debug: run.debug != 0,
            started_at: run.started_at.clone(),
            finished_at: run.finished_at.clone(),
        });
        Ok(attempts)
    }

    /// The jobs of one attempt: the live ones for the current attempt, the
    /// kept ones for an earlier attempt. None for an attempt it never had.
    async fn attempt_jobs(&self, run: &RunRow, attempt: Option<u64>) -> Result<Option<AttemptJobs>> {
        match attempt.filter(|n| *n != run.attempt) {
            None => {
                let jobs: Vec<Job> = self.job_rows(&run.id).await?.into_iter().map(job_view).collect();
                let log_ids = jobs.iter().map(|job| job.id.clone()).collect();
                Ok(Some(AttemptJobs { jobs, log_ids }))
            }
            Some(n) if n == 0 || n > run.attempt => Ok(None),
            Some(n) => {
                let rows = self
                    .db
                    .prepare("SELECT * FROM job_attempts WHERE run_id = ? AND attempt = ? ORDER BY rowid")
                    .bind(&[run.id.as_str().into(), (n as f64).into()])?
                    .all()
                    .await?
                    .results::<AttemptJobRow>()?;
                let log_ids = rows.iter().map(|row| row.log_id.clone()).collect();
                Ok(Some(AttemptJobs { jobs: rows.into_iter().map(attempt_job_view).collect(), log_ids }))
            }
        }
    }

    pub async fn run(&self, a: RunArgs) -> Result<Outcome<RunDetail>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        let Some(AttemptJobs { jobs, .. }) = self.attempt_jobs(&run, a.attempt).await? else {
            return Ok(fail(FailureCode::NotFound, format!("This run has no attempt {}.", a.attempt.unwrap_or_default())));
        };
        let attempts = self.attempts_of(&run).await?;
        let mut summary = run.summary();
        // An earlier attempt: as it ended, and nothing waits for it.
        if let Some(earlier) = a.attempt.filter(|n| *n != run.attempt).and_then(|n| attempts.iter().find(|at| at.attempt == n)) {
            summary.attempt = earlier.attempt;
            summary.status = "completed".to_owned();
            summary.conclusion = earlier.conclusion.clone();
            summary.started_at = earlier.started_at.clone();
            summary.finished_at = earlier.finished_at.clone();
            return Ok(Outcome::Ok(RunDetail {
                notes: notes(&run.source),
                run: summary,
                jobs,
                approval: run.approval(),
                pending_deployments: Vec::new(),
                attempts,
            }));
        }
        let pending_deployments = self.pending_for(&run, &a.viewer).await?;
        // Jobs held at an environment's rules: the run waits, as on GitHub.
        if matches!(summary.status.as_str(), "queued" | "in_progress") && jobs.iter().any(|job| job.status == "pending") {
            summary.status = "waiting".to_owned();
        }
        Ok(Outcome::Ok(RunDetail {
            notes: notes(&run.source),
            run: summary,
            jobs,
            approval: run.approval(),
            pending_deployments,
            attempts,
        }))
    }

    /// A job of the repository's runs by the id a run's page gives it: a
    /// live job, or one of an earlier attempt. Its name, steps, where its
    /// logs and summary are kept, and whether it has finished.
    async fn job_for_log(&self, repo: &g1t_contracts::repos::RepoPath, id: &str) -> Result<Option<(Job, String, bool)>> {
        let full = format!("{}/{}", repo.namespace, repo.name);
        let live = self
            .db
            .prepare("SELECT jobs.* FROM jobs JOIN runs ON runs.id = jobs.run_id WHERE jobs.id = ? AND lower(runs.repo) = lower(?)")
            .bind(&[id.into(), full.as_str().into()])?
            .first::<JobRow>(None)
            .await?;
        if let Some(job) = live {
            let done = job.status == "completed";
            let view = job_view(job);
            let log_id = view.id.clone();
            return Ok(Some((view, log_id, done)));
        }
        let kept = self
            .db
            .prepare(
                "SELECT job_attempts.* FROM job_attempts JOIN runs ON runs.id = job_attempts.run_id
                 WHERE job_attempts.id = ? AND lower(runs.repo) = lower(?)",
            )
            .bind(&[id.into(), full.as_str().into()])?
            .first::<AttemptJobRow>(None)
            .await?;
        Ok(kept.map(|row| {
            let log_id = row.log_id.clone();
            (attempt_job_view(row), log_id, true)
        }))
    }

    async fn log_chunks(&self, log_id: &str, after: u64, limit: u32) -> Result<Vec<LogChunk>> {
        #[derive(Deserialize)]
        struct Row {
            seq: u64,
            step: u32,
            text: String,
        }
        Ok(self
            .db
            .prepare("SELECT seq, step, text FROM logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?")
            .bind(&[log_id.into(), (after as f64).into(), limit.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| LogChunk { seq: row.seq, step: row.step, text: row.text })
            .collect())
    }

    /// Every chunk of a job's log, a page at a time.
    async fn whole_log(&self, log_id: &str) -> Result<Vec<LogChunk>> {
        let mut chunks: Vec<LogChunk> = Vec::new();
        loop {
            let after = chunks.last().map_or(0, |chunk| chunk.seq);
            let page = self.log_chunks(log_id, after, 500).await?;
            let more = page.len() == 500;
            chunks.extend(page);
            if !more {
                return Ok(chunks);
            }
        }
    }

    pub async fn logs(&self, a: LogsArgs) -> Result<Outcome<JobLog>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let Some((_, log_id, done)) = self.job_for_log(&a.repo, &a.job).await? else {
            return Ok(fail(FailureCode::NotFound, "No such job."));
        };
        let chunks = self.log_chunks(&log_id, a.after, 500).await?;
        Ok(Outcome::Ok(JobLog { chunks, done }))
    }

    /// `job_log_text`: a job's whole log, to download.
    pub async fn job_log_text(&self, a: JobLogTextArgs) -> Result<Outcome<JobLogText>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let Some((job, log_id, done)) = self.job_for_log(&a.repo, &a.job).await? else {
            return Ok(fail(FailureCode::NotFound, "No such job."));
        };
        let chunks = self.whole_log(&log_id).await?;
        Ok(Outcome::Ok(JobLogText { job_id: job.id, name: job.name, steps: job.steps, chunks, done, omitted: false }))
    }

    /// `run_logs`: every job's whole log for one attempt, to download as one
    /// archive.
    pub async fn run_logs(&self, a: RunLogsArgs) -> Result<Outcome<Vec<JobLogText>>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        let Some(AttemptJobs { jobs, log_ids }) = self.attempt_jobs(&run, a.attempt).await? else {
            return Ok(fail(FailureCode::NotFound, format!("This run has no attempt {}.", a.attempt.unwrap_or_default())));
        };
        let mut out = Vec::with_capacity(jobs.len());
        let mut total = 0usize;
        for (job, log_id) in jobs.into_iter().zip(log_ids) {
            let done = job.status == "completed";
            let omitted = total >= MAX_RUN_LOG_BYTES;
            let chunks = if omitted { Vec::new() } else { self.whole_log(&log_id).await? };
            total += chunks.iter().map(|chunk| chunk.text.len()).sum::<usize>();
            out.push(JobLogText { job_id: job.id, name: job.name, steps: job.steps, chunks, done, omitted });
        }
        Ok(Outcome::Ok(out))
    }

    /// `summaries`: what each job's steps wrote to `$GITHUB_STEP_SUMMARY`.
    pub async fn summaries(&self, a: SummariesArgs) -> Result<Outcome<Vec<JobSummary>>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        let Some(AttemptJobs { jobs, log_ids }) = self.attempt_jobs(&run, a.attempt).await? else {
            return Ok(fail(FailureCode::NotFound, format!("This run has no attempt {}.", a.attempt.unwrap_or_default())));
        };
        #[derive(Deserialize)]
        struct Row {
            job_id: String,
            step: u32,
            markdown: String,
        }
        let rows = self
            .db
            .prepare("SELECT job_id, step, markdown FROM job_summaries WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY step")
            .bind(&[serde_json::to_string(&log_ids)?.into()])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(Outcome::Ok(
            jobs.into_iter()
                .zip(log_ids)
                .filter_map(|(job, log_id)| {
                    let steps: Vec<StepSummary> = rows
                        .iter()
                        .filter(|row| row.job_id == log_id)
                        .map(|row| StepSummary { step: row.step, markdown: row.markdown.clone() })
                        .collect();
                    (!steps.is_empty()).then_some(JobSummary { job_id: job.id, name: job.name, steps })
                })
                .collect(),
        ))
    }

    pub async fn set_workflow_enabled(&self, a: SetWorkflowEnabledArgs) -> Result<Outcome<Workflow>> {
        if let Outcome::Fail(refused) = self.may(&a.actor, &a.repo, Capability::ManageSettings).await? {
            return Ok(Outcome::Fail(refused));
        }
        let wanted = a.workflow.trim_start_matches(".g1t/workflows/");
        let row = self
            .db
            .prepare("SELECT * FROM workflows WHERE lower(repo) = lower(?) AND (id = ? OR path = ?)")
            .bind(&[
                format!("{}/{}", a.repo.namespace, a.repo.name).into(),
                a.workflow.as_str().into(),
                format!("{}/{wanted}", g1t_actions::workflow::FOLDER).into(),
            ])?
            .first::<WorkflowRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(fail(FailureCode::NotFound, "No such workflow."));
        };
        let state = if a.enabled { "active" } else { "disabled" };
        self.db.prepare("UPDATE workflows SET state = ? WHERE id = ?").bind(&[state.into(), row.id.as_str().into()])?.run().await?;
        let row = WorkflowRow { state: state.to_owned(), ..row };
        Ok(Outcome::Ok(self.summary(&row).await?))
    }

    /// `check_runs`: workflow runs with their jobs, by commits, by a run's
    /// id or by one of its jobs' ids, newest first, for the work service to
    /// show as check suites and check runs. It decides who may see them.
    pub async fn check_runs(&self, a: ActionsChecksArgs) -> Result<Vec<RunDetail>> {
        let runs: Vec<RunRow> = if let Some(job) = &a.job_id {
            self.db
                .prepare("SELECT runs.* FROM runs JOIN jobs ON jobs.run_id = runs.id WHERE jobs.id = ? AND runs.repo_id = ?")
                .bind(&[job.as_str().into(), a.repo_id.as_str().into()])?
                .all()
                .await?
                .results::<RunRow>()?
        } else if let Some(run) = &a.run_id {
            self.db
                .prepare("SELECT * FROM runs WHERE id = ? AND repo_id = ?")
                .bind(&[run.as_str().into(), a.repo_id.as_str().into()])?
                .all()
                .await?
                .results::<RunRow>()?
        } else if a.shas.is_empty() {
            Vec::new()
        } else {
            let shas: Vec<&String> = a.shas.iter().take(MAX_COMMITS).collect();
            let marks = vec!["?"; shas.len()].join(", ");
            let mut binds: Vec<worker::wasm_bindgen::JsValue> = vec![a.repo_id.as_str().into()];
            binds.extend(shas.iter().map(|sha| sha.as_str().into()));
            binds.push(CHECK_RUNS_LIMIT.into());
            self.db
                .prepare(format!("SELECT * FROM runs WHERE repo_id = ? AND sha IN ({marks}) ORDER BY id DESC LIMIT ?"))
                .bind(&binds)?
                .all()
                .await?
                .results::<RunRow>()?
        };
        if runs.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; runs.len()].join(", ");
        let ids: Vec<worker::wasm_bindgen::JsValue> = runs.iter().map(|run| run.id.as_str().into()).collect();
        let jobs = self
            .db
            .prepare(format!("SELECT * FROM jobs WHERE run_id IN ({marks}) ORDER BY rowid"))
            .bind(&ids)?
            .all()
            .await?
            .results::<JobRow>()?;
        let mut by_run: std::collections::HashMap<String, Vec<Job>> = std::collections::HashMap::new();
        for job in jobs {
            by_run.entry(job.run_id.clone()).or_default().push(job_view(job));
        }
        Ok(runs
            .iter()
            .map(|run| RunDetail {
                run: run.summary(),
                jobs: by_run.remove(&run.id).unwrap_or_default(),
                notes: Vec::new(),
                approval: run.approval(),
                pending_deployments: Vec::new(),
                attempts: Vec::new(),
            })
            .collect())
    }
}

/// The most runs `check_runs` reads for a set of commits.
const CHECK_RUNS_LIMIT: u32 = 200;
