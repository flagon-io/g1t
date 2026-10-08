//! Reading: workflows, runs, a run's jobs, and a job's log.

use g1t_actions::workflow::{self, Severity};
use g1t_contracts::access::Capability;
use g1t_contracts::checks::{ActionsChecksArgs, MAX_COMMITS};
use g1t_contracts::actions::{
    Annotation, Job, JobLog, LogChunk, LogsArgs, RunArgs, RunDetail, RunsArgs, SetWorkflowEnabledArgs, StepState, Workflow, WorkflowNote,
    WorkflowRun, WorkflowsArgs,
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

fn job_view(row: JobRow) -> Job {
    let needs = row.needs();
    Job {
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

    pub async fn run(&self, a: RunArgs) -> Result<Outcome<RunDetail>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        let jobs: Vec<Job> = self.job_rows(&run.id).await?.into_iter().map(job_view).collect();
        let pending_deployments = self.pending_for(&run, &a.viewer).await?;
        let mut summary = run.summary();
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
        }))
    }

    pub async fn logs(&self, a: LogsArgs) -> Result<Outcome<JobLog>> {
        if self.visible_repo(&a.repo, &a.viewer).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        }
        let job = self
            .db
            .prepare("SELECT jobs.* FROM jobs JOIN runs ON runs.id = jobs.run_id WHERE jobs.id = ? AND lower(runs.repo) = lower(?)")
            .bind(&[a.job.as_str().into(), format!("{}/{}", a.repo.namespace, a.repo.name).into()])?
            .first::<JobRow>(None)
            .await?;
        let Some(job) = job else {
            return Ok(fail(FailureCode::NotFound, "No such job."));
        };
        #[derive(Deserialize)]
        struct Row {
            seq: u64,
            step: u32,
            text: String,
        }
        let chunks = self
            .db
            .prepare("SELECT seq, step, text FROM logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT 500")
            .bind(&[job.id.as_str().into(), (a.after as f64).into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| LogChunk { seq: row.seq, step: row.step, text: row.text })
            .collect();
        Ok(Outcome::Ok(JobLog {
            chunks,
            done: job.status == "completed",
        }))
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
            })
            .collect())
    }
}

/// The most runs `check_runs` reads for a set of commits.
const CHECK_RUNS_LIMIT: u32 = 200;
