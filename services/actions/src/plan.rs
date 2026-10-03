//! A run's life: made, its jobs waiting on the jobs they need, each job
//! skipped or expanded into its matrix and queued, started in a sandbox
//! when its workspace has room, reporting its steps and logs as it goes,
//! and finished; the run finishes with its last job.

use g1t_actions::events::{RunInfo, runner_context};
use g1t_actions::expr::{self, Scope, Status};
use g1t_actions::matrix;
use g1t_actions::workflow::{self, Workflow};
use g1t_contracts::actions::{JobCallArgs, RunActionArgs, StartJobArgs, WorkflowRun};
use g1t_contracts::identity::{CreateAccessTokenArgs, CreatedAccessToken};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use g1t_secrets::{random_hex, same, sha256_hex};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::sync::WorkflowRow;
use crate::{Actions, Count, MAX_TIMEOUT_MINUTES, RUNNING_PER_WORKSPACE, SILENT_MS, SITE, check, fail, optional, repo_path};

/// The most log one job keeps, in bytes; past it, the log says so and stops.
const MAX_LOG_BYTES: usize = 4 * 1024 * 1024;
/// The most a single log report may add.
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_ANNOTATIONS: usize = 50;

pub struct NewRun {
    pub repo: Repo,
    pub path: String,
    pub source: String,
    pub workflow: Workflow,
    pub info: RunInfo,
    pub action: Option<String>,
    pub pull: Option<u32>,
    pub title: String,
    pub inputs: Map<String, Value>,
    pub event_key: String,
    pub actor_id: Option<String>,
    pub actor: Option<String>,
    pub trusted: bool,
}

#[derive(Clone, Deserialize)]
pub struct RunRow {
    pub id: String,
    pub workflow_id: String,
    pub repo_id: String,
    pub repo: String,
    pub path: String,
    pub name: String,
    pub title: String,
    pub number: u64,
    pub attempt: u64,
    pub event: String,
    pub action: Option<String>,
    pub git_ref: String,
    pub sha: String,
    pub pull: Option<u32>,
    pub status: String,
    pub conclusion: Option<String>,
    pub error: Option<String>,
    pub actor: Option<String>,
    pub actor_id: Option<String>,
    pub source: String,
    pub info: String,
    pub inputs: String,
    pub trusted: u32,
    pub concurrency_group: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl RunRow {
    pub fn info(&self) -> RunInfo {
        let mut info: RunInfo = serde_json::from_str(&self.info).unwrap_or_default();
        info.run_id = self.id.clone();
        info.run_number = self.number;
        info.run_attempt = self.attempt;
        info.workflow_path = self.path.clone();
        if info.workflow.is_empty() {
            info.workflow = self.name.clone();
        }
        info
    }

    pub fn inputs(&self) -> Map<String, Value> {
        serde_json::from_str(&self.inputs).unwrap_or_default()
    }

    pub fn summary(&self) -> WorkflowRun {
        WorkflowRun {
            id: self.id.clone(),
            workflow_id: self.workflow_id.clone(),
            path: self.path.clone(),
            name: self.name.clone(),
            title: self.title.clone(),
            number: self.number,
            attempt: self.attempt,
            event: self.event.clone(),
            git_ref: self.git_ref.clone(),
            sha: self.sha.clone(),
            pull: self.pull,
            status: self.status.clone(),
            conclusion: self.conclusion.clone(),
            error: self.error.clone(),
            actor: self.actor.clone(),
            created_at: self.created_at.clone(),
            started_at: self.started_at.clone(),
            finished_at: self.finished_at.clone(),
        }
    }
}

#[derive(Clone, Deserialize)]
pub struct JobRow {
    pub id: String,
    pub run_id: String,
    pub repo_id: String,
    pub namespace: String,
    pub key: String,
    pub ordinal: u32,
    pub name: String,
    pub needs: String,
    pub matrix: Option<String>,
    pub status: String,
    pub conclusion: Option<String>,
    pub steps: String,
    pub annotations: String,
    pub outputs: String,
    pub reason: Option<String>,
    pub token_hash: Option<String>,
    pub timeout_minutes: u32,
    pub continue_on_error: u32,
    pub max_parallel: Option<u32>,
    /// Set for a job that calls a reusable workflow, and for that
    /// workflow's jobs (see migration 0002).
    pub call: Option<String>,
    pub seen_at: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl JobRow {
    pub fn needs(&self) -> Vec<String> {
        serde_json::from_str(&self.needs).unwrap_or_default()
    }

    pub fn call(&self) -> Option<Value> {
        self.call.as_deref().and_then(|call| serde_json::from_str(call).ok())
    }

    /// For a job of a called workflow: that workflow, the job's own id in
    /// it, and the job.
    pub fn callee(&self) -> Option<(Workflow, workflow::Job, Value)> {
        let call = self.call().filter(|call| call["role"] == "callee")?;
        let called = workflow::parse(call["source"].as_str()?).ok()?;
        let job = called.jobs.iter().find(|job| call["job"].as_str() == Some(job.id.as_str()))?.clone();
        Some((called, job, call))
    }
}

/// A job to decide on: its key, its definition, and what it needs, as
/// (name in `needs`, key of the jobs).
type Unit = (String, workflow::Job, Vec<(String, String)>);

/// How deep reusable workflows may call one another, as on GitHub.
const MAX_CALL_DEPTH: u64 = 4;

/// What the jobs of one key came to, for `needs.<key>`.
fn key_result(rows: &[&JobRow]) -> &'static str {
    let failed = |row: &&&JobRow| row.conclusion.as_deref() == Some("failure") && row.continue_on_error == 0;
    if rows.iter().any(|row| failed(&row)) {
        "failure"
    } else if rows.iter().any(|row| row.conclusion.as_deref() == Some("cancelled")) {
        "cancelled"
    } else if rows.iter().all(|row| row.conclusion.as_deref() == Some("skipped")) {
        "skipped"
    } else {
        "success"
    }
}

fn now() -> String {
    rfc3339(now_ms())
}

impl Actions {
    pub async fn run_row(&self, id: &str) -> Result<Option<RunRow>> {
        self.db.prepare("SELECT * FROM runs WHERE id = ?").bind(&[id.into()])?.first::<RunRow>(None).await
    }

    pub async fn job_rows(&self, run_id: &str) -> Result<Vec<JobRow>> {
        self.db
            .prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY rowid")
            .bind(&[run_id.into()])?
            .all()
            .await?
            .results::<JobRow>()
    }

    pub async fn run_summary(&self, id: &str) -> Result<Outcome<WorkflowRun>> {
        Ok(match self.run_row(id).await? {
            Some(row) => Outcome::Ok(row.summary()),
            None => fail(FailureCode::NotFound, "No such run."),
        })
    }

    /// The contexts every expression outside a job's steps may use.
    fn base_contexts(run: &RunRow, vars: &Map<String, Value>, job: &str) -> Map<String, Value> {
        let mut contexts = Map::new();
        contexts.insert("github".into(), run.info().context(job, "", run.action.as_deref()));
        contexts.insert("inputs".into(), Value::Object(run.inputs()));
        contexts.insert("vars".into(), Value::Object(vars.clone()));
        contexts.insert("needs".into(), json!({}));
        contexts.insert("runner".into(), runner_context());
        contexts
    }

    /// Makes a run and its jobs, and starts what can start. `None` when the
    /// event already started this workflow.
    pub async fn create_run(&self, new: NewRun) -> Result<Option<String>> {
        let workflow_row = self.workflow_row(&new.repo, &new.path, &new.workflow.display_name(&new.path), &new.source).await?;
        let numbered = self
            .db
            .prepare("UPDATE workflows SET run_count = run_count + 1 WHERE id = ? RETURNING run_count AS n")
            .bind(&[workflow_row.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(1, |count| count.n);
        let id = new_id("run", now_ms());
        let mut info = new.info.clone();
        info.workflow = new.workflow.display_name(&new.path);
        info.workflow_path = new.path.clone();
        info.run_id = id.clone();
        info.run_number = u64::from(numbered);
        let vars = self.variables_for(&new.repo.id, &new.repo.namespace).await?;

        // run-name and the concurrency group read github, inputs and vars.
        let mut contexts = Map::new();
        contexts.insert("github".into(), info.context("", "", new.action.as_deref()));
        contexts.insert("inputs".into(), Value::Object(new.inputs.clone()));
        contexts.insert("vars".into(), Value::Object(vars));
        let scope = Scope {
            contexts: &contexts,
            status: Status::Success,
            hash_files: None,
        };
        let title = new
            .workflow
            .run_name
            .as_deref()
            .and_then(|run_name| expr::interpolate(run_name, &scope).ok())
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(new.title.clone());
        let group = new.workflow.concurrency.as_ref().and_then(|c| expr::interpolate(&c.group, &scope).ok());
        let cancel_in_progress = new
            .workflow
            .concurrency
            .as_ref()
            .and_then(|c| expr::interpolate_value(&c.cancel_in_progress, &scope).ok())
            .is_some_and(|value| expr::truthy(&value));

        let inserted = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO runs (id, workflow_id, repo_id, repo, path, name, title, number, event, action, git_ref, sha,
                   pull, status, actor, actor_id, source, info, inputs, trusted, concurrency_group, event_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(&[
                id.as_str().into(),
                workflow_row.id.as_str().into(),
                new.repo.id.as_str().into(),
                format!("{}/{}", new.repo.namespace, new.repo.name).into(),
                new.path.as_str().into(),
                info.workflow.as_str().into(),
                title.as_str().into(),
                numbered.into(),
                info.event_name.as_str().into(),
                optional(new.action.as_deref()),
                info.git_ref.as_str().into(),
                info.sha.as_str().into(),
                new.pull.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                optional(new.actor.as_deref()),
                optional(new.actor_id.as_deref()),
                new.source.as_str().into(),
                serde_json::to_string(&info)?.into(),
                serde_json::to_string(&new.inputs)?.into(),
                u32::from(new.trusted).into(),
                optional(group.as_deref()),
                new.event_key.as_str().into(),
                now().into(),
            ])?
            .first::<Value>(None)
            .await?;
        if inserted.is_none() {
            return Ok(None);
        }
        if let Some(run) = self.run_row(&id).await? {
            self.report_pending(&run).await?;
        }

        // Every job, waiting; each is expanded when the jobs it needs are done.
        let mut statements = Vec::new();
        for job in &new.workflow.jobs {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO jobs (id, run_id, repo_id, namespace, key, name, needs, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')",
                    )
                    .bind(&[
                        new_id("job", now_ms()).into(),
                        id.as_str().into(),
                        new.repo.id.as_str().into(),
                        new.repo.namespace.as_str().into(),
                        job.id.as_str().into(),
                        job.name.clone().filter(|n| !expr::has_expression(n)).unwrap_or(job.id.clone()).into(),
                        serde_json::to_string(&job.needs)?.into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;

        // One run at a time per concurrency group.
        if let Some(group) = &group {
            let others = self
                .db
                .prepare("SELECT * FROM runs WHERE repo_id = ? AND concurrency_group = ? AND id != ? AND status != 'completed' ORDER BY id")
                .bind(&[new.repo.id.as_str().into(), group.as_str().into(), id.as_str().into()])?
                .all()
                .await?
                .results::<RunRow>()?;
            for other in &others {
                if cancel_in_progress || other.status == "pending" {
                    // A newer run replaces a waiting one, as on GitHub.
                    self.cancel_run(other, "A newer run in the same concurrency group replaced it.").await?;
                }
            }
            if !cancel_in_progress && others.iter().any(|other| other.status != "pending") {
                self.db
                    .prepare("UPDATE runs SET status = 'pending' WHERE id = ?")
                    .bind(&[id.as_str().into()])?
                    .run()
                    .await?;
                return Ok(Some(id));
            }
        }
        self.advance(&id).await?;
        Ok(Some(id))
    }

    /// A run that could not start, such as for a workflow file that does not read.
    #[allow(clippy::too_many_arguments)]
    pub async fn record_failed_run(
        &self,
        row: &WorkflowRow,
        git_ref: &str,
        sha: &str,
        event_key: &str,
        actor_id: Option<&str>,
        actor: &str,
        problem: &str,
    ) -> Result<()> {
        let numbered = self
            .db
            .prepare("UPDATE workflows SET run_count = run_count + 1 WHERE id = ? RETURNING run_count AS n")
            .bind(&[row.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(1, |count| count.n);
        let at = now();
        self.db
            .prepare(
                "INSERT OR IGNORE INTO runs (id, workflow_id, repo_id, repo, path, name, title, number, event, git_ref, sha, status,
                   conclusion, error, actor, actor_id, source, info, event_key, created_at, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'push', ?, ?, 'completed', 'failure', ?, ?, ?, ?, '{}', ?, ?, ?)",
            )
            .bind(&[
                new_id("run", now_ms()).into(),
                row.id.as_str().into(),
                row.repo_id.as_str().into(),
                row.repo.as_str().into(),
                row.path.as_str().into(),
                row.path.as_str().into(),
                "Invalid workflow file".into(),
                numbered.into(),
                git_ref.into(),
                sha.into(),
                problem.into(),
                actor.into(),
                optional(actor_id),
                row.source.as_str().into(),
                event_key.into(),
                at.as_str().into(),
                at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Moves a run along: jobs whose needs are done are decided on, and
    /// jobs that can start are started.
    pub async fn advance(&self, run_id: &str) -> Result<()> {
        // Each pass may finish jobs (skipped ones), which may free others.
        for _ in 0..20 {
            let Some(run) = self.run_row(run_id).await? else { return Ok(()) };
            if run.status == "completed" || run.status == "pending" {
                return Ok(());
            }
            let workflow = match workflow::parse(&run.source) {
                Ok(workflow) => workflow,
                Err(problem) => {
                    self.finish_run(&run, Some(&problem)).await?;
                    return Ok(());
                }
            };
            let jobs = self.job_rows(run_id).await?;
            let mut changed = false;
            // What to decide on: the workflow's jobs, and the jobs of the
            // workflows they call, each with its needs as (name, key).
            let mut units: Vec<Unit> = workflow
                .jobs
                .iter()
                .map(|job| (job.id.clone(), job.clone(), job.needs.iter().map(|n| (n.clone(), n.clone())).collect()))
                .collect();
            let mut seen = std::collections::HashSet::new();
            for row in &jobs {
                if !seen.insert(row.key.clone()) {
                    continue;
                }
                if let Some((_, job, call)) = row.callee() {
                    let parent = call["parent"].as_str().unwrap_or_default().to_owned();
                    let needs = job.needs.iter().map(|n| (n.clone(), format!("{parent}/{n}"))).collect();
                    units.push((row.key.clone(), job, needs));
                }
            }
            for (key, job, needs) in &units {
                let rows: Vec<&JobRow> = jobs.iter().filter(|row| &row.key == key).collect();
                if rows.is_empty() || !rows.iter().all(|row| row.status == "waiting") {
                    continue;
                }
                let needed: Vec<(&String, Vec<&JobRow>)> =
                    needs.iter().map(|(name, need)| (name, jobs.iter().filter(|row| &row.key == need).collect())).collect();
                if !needed.iter().all(|(_, rows)| rows.iter().all(|row| row.status == "completed")) {
                    continue;
                }
                self.decide(&run, job, rows[0], &needed).await?;
                changed = true;
            }
            // A job that called a workflow finishes with that workflow's jobs.
            for row in jobs.iter().filter(|row| row.status == "calling") {
                let children: Vec<&JobRow> = jobs
                    .iter()
                    .filter(|child| child.call().is_some_and(|call| call["role"] == "callee" && call["parent"].as_str() == Some(row.key.as_str())))
                    .collect();
                if !children.is_empty() && children.iter().all(|child| child.status == "completed") {
                    self.finish_call(row, &children).await?;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        self.start_queued().await?;
        self.finish_if_done(run_id).await
    }

    /// Decides on one job whose needs are done: skip it, fail it, or expand
    /// it into its matrix and queue it.
    async fn decide(&self, run: &RunRow, job: &workflow::Job, row: &JobRow, needed: &[(&String, Vec<&JobRow>)]) -> Result<()> {
        let vars = self.variables_for(&run.repo_id, &repo_path(&run.repo).namespace).await?;
        let mut contexts = Self::base_contexts(run, &vars, &job.id);
        // A called workflow's jobs read the inputs they were called with.
        let call = row.call();
        let parent = call.as_ref().filter(|c| c["role"] == "callee").and_then(|c| c["parent"].as_str().map(str::to_owned));
        if let Some(call) = call.as_ref().filter(|c| c["role"] == "callee") {
            contexts.insert("inputs".into(), call["inputs"].clone());
        }
        let mut needs = Map::new();
        let mut status = if run.conclusion.as_deref() == Some("cancelled") { Status::Cancelled } else { Status::Success };
        for (key, rows) in needed {
            let result = key_result(rows);
            let mut outputs = Map::new();
            for row in rows {
                if let Ok(Value::Object(more)) = serde_json::from_str::<Value>(&row.outputs) {
                    outputs.extend(more);
                }
            }
            if result != "success" && status == Status::Success {
                status = Status::Failure;
            }
            needs.insert((*key).clone(), json!({ "result": result, "outputs": outputs }));
        }
        contexts.insert("needs".into(), Value::Object(needs));
        let scope = Scope {
            contexts: &contexts,
            status,
            hash_files: None,
        };
        let condition = job.condition.as_deref().unwrap_or_default();
        match expr::condition(condition, &scope) {
            Ok(true) => {}
            Ok(false) => return self.skip_job(row, None).await,
            Err(problem) => return self.fail_job(row, &format!("Its `if` does not read: {problem}")).await,
        }
        if let Some(uses) = &job.uses {
            return self.call_workflow(run, job, row, uses, &scope).await;
        }

        // Its matrix, which may come from a needed job's outputs.
        let combinations = match &job.matrix {
            None => vec![Map::new()],
            Some(matrix) => {
                let value = match expr::interpolate_value(matrix, &scope) {
                    Ok(value) => value,
                    Err(problem) => return self.fail_job(row, &format!("Its matrix does not read: {problem}")).await,
                };
                match matrix::expand(&value) {
                    Ok(combinations) if !combinations.is_empty() => combinations,
                    Ok(_) => return self.fail_job(row, "Its matrix makes no jobs.").await,
                    Err(problem) => return self.fail_job(row, &problem).await,
                }
            }
        };
        let total = combinations.len();
        let raw = job.raw.as_object().cloned().unwrap_or_default();
        let mut statements = Vec::new();
        for (index, combination) in combinations.iter().enumerate() {
            let mut contexts = contexts.clone();
            contexts.insert("matrix".into(), Value::Object(combination.clone()));
            contexts.insert(
                "strategy".into(),
                json!({ "fail-fast": job.fail_fast, "job-index": index, "job-total": total, "max-parallel": job.max_parallel.unwrap_or(total as u32) }),
            );
            let scope = Scope {
                contexts: &contexts,
                status: Status::Success,
                hash_files: None,
            };
            let base_name = job.name.clone().unwrap_or(job.id.clone());
            // A called workflow's job is shown under the job that called it.
            let base_name = match &parent {
                Some(parent) => format!("{} / {base_name}", parent.replace('/', " / ")),
                None => base_name,
            };
            let name = if expr::has_expression(&base_name) {
                expr::interpolate(&base_name, &scope).unwrap_or(base_name)
            } else if job.matrix.is_some() {
                matrix::job_name(&base_name, combination)
            } else {
                base_name
            };
            let runs_on = expr::interpolate_value(&job.runs_on, &scope).unwrap_or(Value::Null);
            let labels = match &runs_on {
                Value::String(label) => vec![label.clone()],
                Value::Array(labels) => labels.iter().map(expr::to_text).collect(),
                Value::Object(spec) => spec.get("labels").map(|l| match l {
                    Value::Array(labels) => labels.iter().map(expr::to_text).collect(),
                    other => vec![expr::to_text(other)],
                }).unwrap_or_default(),
                _ => Vec::new(),
            };
            let reason = labels
                .iter()
                .find(|label| {
                    let lower = label.to_ascii_lowercase();
                    lower.contains("windows") || lower.contains("macos")
                })
                .map(|label| format!("`runs-on: {label}`: g1t runs jobs on Linux only."));
            let timeout = raw
                .get("timeout-minutes")
                .and_then(|value| expr::interpolate_value(value, &scope).ok())
                .and_then(|value| value.as_f64().or_else(|| expr::to_text(&value).parse().ok()))
                .map_or(MAX_TIMEOUT_MINUTES, |minutes| (minutes.ceil() as u32).clamp(1, MAX_TIMEOUT_MINUTES));
            let continue_on_error = raw
                .get("continue-on-error")
                .and_then(|value| expr::interpolate_value(value, &scope).ok())
                .is_some_and(|value| expr::truthy(&value));
            let (status, conclusion, finished) = match &reason {
                Some(_) => ("completed", Some("failure"), Some(now())),
                None => ("queued", None, None),
            };
            let values: Vec<worker::wasm_bindgen::JsValue> = vec![
                name.into(),
                serde_json::to_string(combination)?.into(),
                status.into(),
                optional(conclusion),
                optional(reason.as_deref()),
                timeout.into(),
                u32::from(continue_on_error).into(),
                job.max_parallel.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                optional(finished.as_deref()),
            ];
            if index == 0 {
                let mut bound = values;
                bound.push(row.id.as_str().into());
                statements.push(
                    self.db
                        .prepare(
                            "UPDATE jobs SET name = ?, matrix = ?, status = ?, conclusion = ?, reason = ?, timeout_minutes = ?,
                               continue_on_error = ?, max_parallel = ?, finished_at = ? WHERE id = ?",
                        )
                        .bind(&bound)?,
                );
            } else {
                let mut bound: Vec<worker::wasm_bindgen::JsValue> = vec![
                    new_id("job", now_ms()).into(),
                    row.run_id.as_str().into(),
                    row.repo_id.as_str().into(),
                    row.namespace.as_str().into(),
                    row.key.as_str().into(),
                    (index as u32).into(),
                    row.needs.as_str().into(),
                    optional(row.call.as_deref()),
                ];
                bound.extend(values);
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO jobs (id, run_id, repo_id, namespace, key, ordinal, needs, call, name, matrix, status, conclusion, reason,
                               timeout_minutes, continue_on_error, max_parallel, finished_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(&bound)?,
                );
            }
        }
        self.db.batch(statements).await?;
        Ok(())
    }

    /// A job that calls a reusable workflow in the repository: that
    /// workflow's jobs join the run under it, with the inputs it passes.
    async fn call_workflow(&self, run: &RunRow, job: &workflow::Job, row: &JobRow, uses: &str, scope: &Scope<'_>) -> Result<()> {
        let Some(local) = uses.strip_prefix("./") else {
            return self
                .fail_job(row, "Reusable workflows from other repositories are not called on g1t yet; ones in this repository (`./.g1t/workflows/…`) are.")
                .await;
        };
        let depth = row.call().and_then(|c| c["depth"].as_u64()).unwrap_or(0) + 1;
        if depth > MAX_CALL_DEPTH {
            return self.fail_job(row, &format!("Reusable workflows call each other more than {MAX_CALL_DEPTH} deep.")).await;
        }
        let local = local.split('@').next().unwrap_or(local).to_owned();
        let path = repo_path(&run.repo);
        let Some(ws) = self.workspace_actor(&path.namespace).await? else {
            return self.fail_job(row, "The workspace is gone.").await;
        };
        // A repository moved from GitHub keeps saying `.github/…`.
        let mut found = self.read_file(&path, &ws, &run.sha, &local).await?.map(|text| (local.clone(), text));
        if found.is_none()
            && let Some(rest) = local.strip_prefix(".github/")
        {
            let moved = format!(".g1t/{rest}");
            found = self.read_file(&path, &ws, &run.sha, &moved).await?.map(|text| (moved, text));
        }
        let Some((file, source)) = found else {
            return self.fail_job(row, &format!("`{uses}` is not in the repository at this commit.")).await;
        };
        let called = match workflow::parse(&source) {
            Ok(called) => called,
            Err(problem) => return self.fail_job(row, &format!("`{file}` does not read: {problem}")).await,
        };
        let Some(trigger) = called.trigger("workflow_call") else {
            return self.fail_job(row, &format!("`{file}` cannot be called: it has no `on: workflow_call`.")).await;
        };
        // Inputs: what the caller passes, else the called workflow's defaults.
        let given = match job.raw.get("with") {
            Some(with) => match expr::interpolate_value(with, scope) {
                Ok(Value::Object(given)) => given,
                Ok(_) => Map::new(),
                Err(problem) => return self.fail_job(row, &format!("Its `with` does not read: {problem}")).await,
            },
            None => Map::new(),
        };
        let mut inputs = Map::new();
        for (name, spec) in &trigger.inputs {
            let value = given.get(name).cloned().or_else(|| spec.get("default").cloned()).unwrap_or(Value::Null);
            if value.is_null() && spec.get("required").and_then(Value::as_bool) == Some(true) {
                return self.fail_job(row, &format!("`{file}` needs the input `{name}`.")).await;
            }
            inputs.insert(name.clone(), value);
        }
        for (name, value) in given {
            inputs.entry(name).or_insert(value);
        }
        let mut statements = Vec::new();
        for called_job in &called.jobs {
            let needs: Vec<String> = called_job.needs.iter().map(|n| format!("{}/{n}", row.key)).collect();
            let call = json!({
                "role": "callee", "parent": row.key, "job": called_job.id, "path": file,
                "source": source, "inputs": inputs, "depth": depth,
            });
            statements.push(
                self.db
                    .prepare("INSERT INTO jobs (id, run_id, repo_id, namespace, key, name, needs, status, call) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)")
                    .bind(&[
                        new_id("job", now_ms()).into(),
                        row.run_id.as_str().into(),
                        row.repo_id.as_str().into(),
                        row.namespace.as_str().into(),
                        format!("{}/{}", row.key, called_job.id).into(),
                        format!("{} / {}", row.name, called_job.name.clone().unwrap_or(called_job.id.clone())).into(),
                        serde_json::to_string(&needs)?.into(),
                        serde_json::to_string(&call)?.into(),
                    ])?,
            );
        }
        statements.push(
            self.db
                .prepare("UPDATE jobs SET status = 'calling', call = ?, reason = ?, started_at = ? WHERE id = ?")
                .bind(&[
                    serde_json::to_string(&json!({ "role": "caller", "path": file, "source": source }))?.into(),
                    format!("Calls `{file}`.").into(),
                    now().into(),
                    row.id.as_str().into(),
                ])?,
        );
        self.db.batch(statements).await?;
        Ok(())
    }

    /// A job that called a workflow, finished with its jobs: their result,
    /// and the outputs the workflow declares.
    async fn finish_call(&self, row: &JobRow, children: &[&JobRow]) -> Result<()> {
        let call = row.call().unwrap_or_default();
        let called = call["source"].as_str().and_then(|s| workflow::parse(s).ok());
        let mut jobs_context = Map::new();
        let mut by_key: std::collections::BTreeMap<String, Vec<&JobRow>> = std::collections::BTreeMap::new();
        for child in children {
            by_key.entry(child.key.clone()).or_default().push(child);
        }
        for (key, rows) in &by_key {
            let mut outputs = Map::new();
            for child in rows {
                if let Ok(Value::Object(more)) = serde_json::from_str::<Value>(&child.outputs) {
                    outputs.extend(more);
                }
            }
            let id = key.rsplit('/').next().unwrap_or(key);
            jobs_context.insert(id.to_owned(), json!({ "result": key_result(rows), "outputs": outputs }));
        }
        let inputs = children.first().and_then(|c| c.call()).map(|c| c["inputs"].clone()).unwrap_or(json!({}));
        let mut contexts = Map::new();
        contexts.insert("jobs".into(), Value::Object(jobs_context));
        contexts.insert("inputs".into(), inputs);
        let scope = Scope { contexts: &contexts, status: Status::Success, hash_files: None };
        let mut outputs = Map::new();
        if let Some(Value::Object(declared)) = called.as_ref().map(|w| {
            let on = w.raw.get("on").or_else(|| w.raw.get("true")).cloned().unwrap_or(Value::Null);
            on.get("workflow_call").and_then(|c| c.get("outputs")).cloned().unwrap_or(Value::Null)
        }) {
            for (name, spec) in declared {
                if let Some(value) = spec.get("value") {
                    let value = expr::interpolate_value(value, &scope).unwrap_or(Value::Null);
                    outputs.insert(name, Value::String(expr::to_text(&value)));
                }
            }
        }
        let conclusion = key_result(children);
        self.db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = ?, outputs = ?, finished_at = ? WHERE id = ? AND status = 'calling'")
            .bind(&[conclusion.into(), serde_json::to_string(&outputs)?.into(), now().into(), row.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A file's text at a commit, if it is there.
    async fn read_file(&self, path: &RepoPath, ws: &g1t_contracts::User, sha: &str, file: &str) -> Result<Option<String>> {
        let blob: Outcome<g1t_contracts::repos::BlobView> = g1t_kit::call(
            &self.repos,
            "blob",
            &g1t_contracts::repos::BlobArgs {
                path: path.clone(),
                viewer: Some(ws.clone()),
                git_ref: sha.to_owned(),
                file_path: file.to_owned(),
            },
        )
        .await?;
        Ok(match blob {
            Outcome::Ok(view) => view.text,
            Outcome::Fail(_) => None,
        })
    }

    async fn skip_job(&self, row: &JobRow, reason: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = 'skipped', reason = ?, finished_at = ? WHERE id = ?")
            .bind(&[optional(reason), now().into(), row.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    async fn fail_job(&self, row: &JobRow, reason: &str) -> Result<()> {
        self.db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = 'failure', reason = ?, finished_at = ? WHERE id = ? AND status != 'completed'")
            .bind(&[reason.into(), now().into(), row.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Starts queued jobs, oldest first, while their workspace has room.
    pub async fn start_queued(&self) -> Result<()> {
        let queued = self
            .db
            .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY rowid LIMIT 50")
            .all()
            .await?
            .results::<JobRow>()?;
        let mut running: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for job in queued {
            let in_workspace = match running.get(&job.namespace) {
                Some(n) => *n,
                None => {
                    let n = self
                        .db
                        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'in_progress' AND namespace = ?")
                        .bind(&[job.namespace.as_str().into()])?
                        .first::<Count>(None)
                        .await?
                        .map_or(0, |count| count.n);
                    running.insert(job.namespace.clone(), n);
                    n
                }
            };
            if in_workspace >= RUNNING_PER_WORKSPACE {
                continue;
            }
            if let Some(max) = job.max_parallel {
                let siblings = self
                    .db
                    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ? AND key = ? AND status = 'in_progress'")
                    .bind(&[job.run_id.as_str().into(), job.key.as_str().into()])?
                    .first::<Count>(None)
                    .await?
                    .map_or(0, |count| count.n);
                if siblings >= max {
                    continue;
                }
            }
            let token = random_hex(24);
            let at = now();
            let claimed = self
                .db
                .prepare(
                    "UPDATE jobs SET status = 'in_progress', token_hash = ?, started_at = ?, seen_at = ? WHERE id = ? AND status = 'queued' RETURNING id",
                )
                .bind(&[sha256_hex(&token).into(), at.as_str().into(), at.as_str().into(), job.id.as_str().into()])?
                .first::<Value>(None)
                .await?;
            if claimed.is_none() {
                continue;
            }
            running.insert(job.namespace.clone(), in_workspace + 1);
            self.db
                .prepare("UPDATE runs SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'")
                .bind(&[at.as_str().into(), job.run_id.as_str().into()])?
                .run()
                .await?;
            let run = self.run_row(&job.run_id).await?;
            let repo: RepoPath = run.as_ref().map(|run| repo_path(&run.repo)).unwrap_or(RepoPath {
                namespace: job.namespace.clone(),
                name: String::new(),
            });
            let started: Outcome<Value> = g1t_kit::call(
                &self.runner,
                "start_actions_job",
                &StartJobArgs {
                    job: job.id.clone(),
                    token,
                    repo,
                    timeout_minutes: job.timeout_minutes,
                },
            )
            .await
            .unwrap_or_else(|error| fail(FailureCode::Conflict, format!("The runner could not be reached: {error}")));
            if let Outcome::Fail(refused) = started {
                Box::pin(self.finish_job(&job.id, "failure", Some(&refused.message), None)).await?;
            }
        }
        Ok(())
    }

    /// Finishes a job and moves its run along.
    pub async fn finish_job(&self, job_id: &str, conclusion: &str, reason: Option<&str>, outputs: Option<&Map<String, Value>>) -> Result<()> {
        let finished = self
            .db
            .prepare(
                "UPDATE jobs SET status = 'completed', conclusion = ?, reason = COALESCE(?, reason), outputs = COALESCE(?, outputs),
                   finished_at = ?, token_hash = NULL WHERE id = ? AND status != 'completed' RETURNING *",
            )
            .bind(&[
                conclusion.into(),
                optional(reason),
                outputs.map(|o| serde_json::to_string(o).unwrap_or_default()).as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                now().into(),
                job_id.into(),
            ])?
            .first::<JobRow>(None)
            .await?;
        let Some(job) = finished else { return Ok(()) };
        // Steps still marked as going are not going any more.
        let mut steps: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
        let mut touched = false;
        for step in steps.iter_mut() {
            if step["status"] != "completed" {
                let was_running = step["status"] == "in_progress";
                step["status"] = json!("completed");
                step["conclusion"] = json!(if was_running { conclusion } else { "skipped" });
                touched = true;
            }
        }
        if touched {
            self.db
                .prepare("UPDATE jobs SET steps = ? WHERE id = ?")
                .bind(&[serde_json::to_string(&steps)?.into(), job.id.as_str().into()])?
                .run()
                .await?;
        }
        // fail-fast: one failed combination stops the rest of its matrix.
        if conclusion == "failure" && job.continue_on_error == 0 && job.matrix.as_deref().is_some_and(|m| m != "{}") {
            let run = self.run_row(&job.run_id).await?;
            let fail_fast = run
                .as_ref()
                .and_then(|run| workflow::parse(&run.source).ok())
                .and_then(|workflow| workflow.jobs.into_iter().find(|j| j.id == job.key))
                .is_none_or(|j| j.fail_fast);
            if fail_fast {
                let siblings = self
                    .db
                    .prepare("SELECT * FROM jobs WHERE run_id = ? AND key = ? AND status != 'completed'")
                    .bind(&[job.run_id.as_str().into(), job.key.as_str().into()])?
                    .all()
                    .await?
                    .results::<JobRow>()?;
                for sibling in siblings {
                    self.stop_job(&sibling, "Another job of its matrix failed, and the matrix is fail-fast.").await?;
                }
            }
        }
        Box::pin(self.advance(&job.run_id)).await
    }

    /// Cancels a job, stopping its sandbox if it has one.
    async fn stop_job(&self, job: &JobRow, reason: &str) -> Result<()> {
        if job.status == "in_progress" {
            let _: Result<Value> = g1t_kit::call(&self.runner, "stop_actions_job", &json!({ "job": job.id })).await;
        }
        self.db
            .prepare("UPDATE jobs SET status = 'completed', conclusion = 'cancelled', reason = ?, finished_at = ?, token_hash = NULL WHERE id = ? AND status != 'completed'")
            .bind(&[reason.into(), now().into(), job.id.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Finishes the run when every job has.
    async fn finish_if_done(&self, run_id: &str) -> Result<()> {
        let Some(run) = self.run_row(run_id).await? else { return Ok(()) };
        if run.status == "completed" || run.status == "pending" {
            return Ok(());
        }
        let jobs = self.job_rows(run_id).await?;
        if !jobs.iter().all(|job| job.status == "completed") {
            return Ok(());
        }
        self.finish_run(&run, None).await
    }

    async fn finish_run(&self, run: &RunRow, error: Option<&str>) -> Result<()> {
        let jobs = self.job_rows(&run.id).await?;
        let rows: Vec<&JobRow> = jobs.iter().collect();
        let conclusion = if error.is_some() {
            "failure"
        } else if run.conclusion.as_deref() == Some("cancelled") {
            "cancelled"
        } else if rows.is_empty() {
            "skipped"
        } else {
            key_result(&rows)
        };
        let done = self
            .db
            .prepare("UPDATE runs SET status = 'completed', conclusion = ?, error = COALESCE(?, error), finished_at = ? WHERE id = ? AND status != 'completed' RETURNING id")
            .bind(&[conclusion.into(), optional(error), now().into(), run.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if done.is_none() {
            return Ok(());
        }
        self.report_status(run, conclusion).await?;
        let published: Result<()> = g1t_kit::call(
            &self.events,
            "publish",
            &g1t_contracts::events::Publish {
                events: vec![g1t_contracts::events::NewEvent {
                    kind: "workflow.completed",
                    source: "actions",
                    repo_id: Some(run.repo_id.clone()),
                    actor: run.actor_id.clone(),
                    data: g1t_contracts::events::WorkflowEvent {
                        run_id: run.id.clone(),
                        repo_id: run.repo_id.clone(),
                        workflow: run.name.clone(),
                        path: run.path.clone(),
                        number: run.number,
                        event: run.event.clone(),
                        conclusion: conclusion.to_owned(),
                        git_ref: run.git_ref.clone(),
                        sha: run.sha.clone(),
                        pull: run.pull,
                    },
                }],
            },
        )
        .await;
        if let Err(error) = published {
            worker::console_error!("actions: could not publish workflow.completed: {error}");
        }
        // The next run waiting in its concurrency group.
        if let Some(group) = &run.concurrency_group {
            let next = self
                .db
                .prepare("SELECT * FROM runs WHERE repo_id = ? AND concurrency_group = ? AND status = 'pending' ORDER BY id LIMIT 1")
                .bind(&[run.repo_id.as_str().into(), group.as_str().into()])?
                .first::<RunRow>(None)
                .await?;
            if let Some(next) = next {
                self.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").bind(&[next.id.as_str().into()])?.run().await?;
                Box::pin(self.advance(&next.id)).await?;
            }
        }
        Ok(())
    }

    /// Tells the pull request (or commit) how the run went, as a status.
    async fn report_status(&self, run: &RunRow, conclusion: &str) -> Result<()> {
        let state = match conclusion {
            "success" | "skipped" => "success",
            "cancelled" => "error",
            _ => "failure",
        };
        let _: Result<Value> = g1t_kit::call(
            &self.work,
            "set_commit_status",
            &json!({
                "repoId": run.repo_id,
                "sha": run.sha,
                "context": format!("{} / {}", run.name, run.event),
                "state": state,
                "description": format!("{} {}", run.name, match conclusion {
                    "success" => "passed",
                    "skipped" => "was skipped",
                    "cancelled" => "was cancelled",
                    _ => "failed",
                }),
                "targetUrl": format!("{SITE}/{}/actions/runs/{}", run.repo, run.id),
            }),
        )
        .await;
        Ok(())
    }

    /// Tells the pull request a run has started on its head.
    pub async fn report_pending(&self, run: &RunRow) -> Result<()> {
        let _: Result<Value> = g1t_kit::call(
            &self.work,
            "set_commit_status",
            &json!({
                "repoId": run.repo_id,
                "sha": run.sha,
                "context": format!("{} / {}", run.name, run.event),
                "state": "pending",
                "description": format!("{} is running", run.name),
                "targetUrl": format!("{SITE}/{}/actions/runs/{}", run.repo, run.id),
            }),
        )
        .await;
        Ok(())
    }

    /// Cancels a run: its waiting and queued jobs, and stops its running ones.
    pub async fn cancel_run(&self, run: &RunRow, reason: &str) -> Result<()> {
        self.db
            .prepare("UPDATE runs SET conclusion = 'cancelled' WHERE id = ? AND status != 'completed'")
            .bind(&[run.id.as_str().into()])?
            .run()
            .await?;
        for job in self.job_rows(&run.id).await?.iter().filter(|job| job.status != "completed") {
            self.stop_job(job, reason).await?;
        }
        if run.status == "pending" {
            self.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").bind(&[run.id.as_str().into()])?.run().await?;
        }
        self.advance(&run.id).await
    }

    pub async fn cancel(&self, a: RunActionArgs) -> Result<Outcome<WorkflowRun>> {
        if let Some(Outcome::Fail(refused)) = Self::member(&a.actor, &a.repo) {
            return Ok(Outcome::Fail(refused));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        if run.status == "completed" {
            return Ok(fail(FailureCode::Conflict, "The run has already finished."));
        }
        self.cancel_run(&run, &format!("{} cancelled the run.", a.actor.username)).await?;
        self.run_summary(&run.id).await
    }

    /// Runs again: every job, or with `failed_only` those that did not
    /// succeed and the jobs that need them.
    pub async fn rerun(&self, a: RunActionArgs) -> Result<Outcome<WorkflowRun>> {
        if let Some(Outcome::Fail(refused)) = Self::member(&a.actor, &a.repo) {
            return Ok(Outcome::Fail(refused));
        }
        let run = check!(self.run_in(&a.repo, &a.id).await?);
        if run.status != "completed" {
            return Ok(fail(FailureCode::Conflict, "The run is still going: cancel it first."));
        }
        if run.error.is_some() {
            return Ok(fail(FailureCode::Conflict, "This run never started: fix the workflow file and push again."));
        }
        let jobs = self.job_rows(&run.id).await?;
        let workflow = workflow::parse(&run.source).ok();
        // Which keys run again: failed ones and, transitively, those needing them.
        let mut again: Vec<String> = Vec::new();
        for key in workflow.as_ref().map(|w| w.job_order()).unwrap_or_default() {
            let rows: Vec<&JobRow> = jobs.iter().filter(|j| j.key == key).collect();
            let failed = rows.iter().any(|row| row.conclusion.as_deref() != Some("success"));
            let needs_again = rows.first().is_some_and(|row| row.needs().iter().any(|need| again.contains(need)));
            if !a.failed_only || failed || needs_again {
                again.push(key.to_owned());
            }
        }
        if again.is_empty() {
            return Ok(fail(FailureCode::Conflict, "Every job succeeded: there is nothing to run again."));
        }
        let mut statements = Vec::new();
        for key in &again {
            statements.push(self.db.prepare("DELETE FROM logs WHERE job_id IN (SELECT id FROM jobs WHERE run_id = ? AND key = ?)").bind(&[run.id.as_str().into(), key.as_str().into()])?);
            statements.push(self.db.prepare("DELETE FROM jobs WHERE run_id = ? AND key = ? AND ordinal > 0").bind(&[run.id.as_str().into(), key.as_str().into()])?);
            // The jobs of a workflow it called are made again when it calls it again.
            statements.push(
                self.db
                    .prepare("DELETE FROM logs WHERE job_id IN (SELECT id FROM jobs WHERE run_id = ? AND key LIKE ?)")
                    .bind(&[run.id.as_str().into(), format!("{key}/%").into()])?,
            );
            statements.push(
                self.db
                    .prepare("DELETE FROM jobs WHERE run_id = ? AND key LIKE ?")
                    .bind(&[run.id.as_str().into(), format!("{key}/%").into()])?,
            );
            statements.push(
                self.db
                    .prepare(
                        "UPDATE jobs SET status = 'waiting', conclusion = NULL, steps = '[]', annotations = '[]', outputs = '{}', reason = NULL,
                           matrix = NULL, call = NULL, token_hash = NULL, seen_at = NULL, started_at = NULL, finished_at = NULL WHERE run_id = ? AND key = ?",
                    )
                    .bind(&[run.id.as_str().into(), key.as_str().into()])?,
            );
        }
        statements.push(
            self.db
                .prepare("UPDATE runs SET status = 'queued', conclusion = NULL, attempt = attempt + 1, started_at = NULL, finished_at = NULL WHERE id = ?")
                .bind(&[run.id.as_str().into()])?,
        );
        self.db.batch(statements).await?;
        if let Some(run) = self.run_row(&run.id).await? {
            self.report_pending(&run).await?;
        }
        self.advance(&run.id).await?;
        self.run_summary(&run.id).await
    }

    pub async fn run_in(&self, repo: &RepoPath, id: &str) -> Result<Outcome<RunRow>> {
        let row = self
            .db
            .prepare("SELECT * FROM runs WHERE id = ? AND lower(repo) = lower(?)")
            .bind(&[id.into(), format!("{}/{}", repo.namespace, repo.name).into()])?
            .first::<RunRow>(None)
            .await?;
        Ok(row.map_or_else(|| fail(FailureCode::NotFound, "No such run."), Outcome::Ok))
    }

    // --- The sandbox's side -----------------------------------------------------

    async fn job_for_token(&self, a: &JobCallArgs) -> Result<Outcome<JobRow>> {
        let job = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[a.job.as_str().into()])?.first::<JobRow>(None).await?;
        Ok(match job {
            Some(job) if job.status == "in_progress" && job.token_hash.as_deref().is_some_and(|hash| same(hash, &sha256_hex(&a.token))) => {
                Outcome::Ok(job)
            }
            _ => fail(FailureCode::Unauthenticated, "That job is not running, or the token is not its."),
        })
    }

    /// `job_auth`: which run and repository a running job's token is for,
    /// so the API can keep its artifacts and cache.
    pub async fn job_auth(&self, a: JobCallArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_token(&a).await?);
        Ok(Outcome::Ok(json!({ "run": job.run_id, "repoId": job.repo_id })))
    }

    /// `job_spec`: everything the sandbox needs to run the job.
    pub async fn job_spec(&self, a: JobCallArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_token(&a).await?);
        let Some(run) = self.run_row(&job.run_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such run."));
        };
        let Ok(caller) = workflow::parse(&run.source) else {
            return Ok(fail(FailureCode::Invalid, "The workflow no longer reads."));
        };
        // A called workflow's job runs as that workflow defines it.
        let callee = job.callee();
        let (workflow, spec, call_inputs) = match callee {
            Some((called, spec, call)) => (called, spec, Some(call["inputs"].clone())),
            None => match caller.jobs.iter().find(|j| j.id == job.key) {
                Some(spec) => (caller.clone(), spec.clone(), None),
                None => return Ok(fail(FailureCode::NotFound, "The job is not in the workflow.")),
            },
        };
        let spec = &spec;
        let repo = repo_path(&run.repo);
        let trusted = run.trusted != 0;
        // GITHUB_TOKEN: the workspace's, for as long as the job may run.
        let token = if trusted {
            match self.workspace_actor(&repo.namespace).await? {
                Some(workspace) => {
                    let created: CreatedAccessToken = g1t_kit::call(
                        &self.identity,
                        "create_access_token",
                        &CreateAccessTokenArgs {
                            user: workspace,
                            name: format!("GITHUB_TOKEN for {} run {}", run.repo, run.number),
                            ttl_seconds: Some(u64::from(job.timeout_minutes) * 60 + 600),
                        },
                    )
                    .await?;
                    created.token
                }
                None => String::new(),
            }
        } else {
            String::new()
        };
        let mut secrets = if trusted { self.secrets_for(&run.repo_id, &repo.namespace).await? } else { Map::new() };
        secrets.insert("GITHUB_TOKEN".into(), Value::String(token.clone()));
        let masks: Vec<String> = secrets.values().filter_map(|v| v.as_str()).filter(|v| v.len() >= 4).map(str::to_owned).collect();
        let vars = self.variables_for(&run.repo_id, &repo.namespace).await?;

        let jobs = self.job_rows(&run.id).await?;
        let mut needs = Map::new();
        // In a called workflow, its jobs' keys sit under the job that called it.
        let parent = job.call().filter(|c| c["role"] == "callee").and_then(|c| c["parent"].as_str().map(str::to_owned));
        for need in &spec.needs {
            let key = match &parent {
                Some(parent) => format!("{parent}/{need}"),
                None => need.clone(),
            };
            let rows: Vec<&JobRow> = jobs.iter().filter(|row| row.key == key).collect();
            let mut outputs = Map::new();
            for row in &rows {
                if let Ok(Value::Object(more)) = serde_json::from_str::<Value>(&row.outputs) {
                    outputs.extend(more);
                }
            }
            needs.insert(need.clone(), json!({ "result": key_result(&rows), "outputs": outputs }));
        }
        let siblings = jobs.iter().filter(|row| row.key == job.key).count();
        let matrix: Value = job.matrix.as_deref().and_then(|m| serde_json::from_str(m).ok()).unwrap_or(json!({}));
        let info = run.info();
        let mut github = info.context(&job.key, &token, run.action.as_deref());
        github["token"] = json!(token);

        // Where to check out: a pull request's fork, or the repository.
        let clone_url = match run.pull {
            Some(number) if run.event.starts_with("pull_request") && run.event != "pull_request_target" => {
                let located: Outcome<g1t_contracts::work::PullDetail> = g1t_kit::call(
                    &self.work,
                    "get_pull",
                    &g1t_contracts::work::ViewArgs {
                        repo: repo.clone(),
                        number,
                        viewer: self.workspace_actor(&repo.namespace).await?,
                        after_seq: 0,
                    },
                )
                .await?;
                match located {
                    Outcome::Ok(detail) => match detail.pull.fork {
                        Some(fork) => format!("{SITE}/{}/{}.git", fork.namespace, fork.name),
                        None => format!("{SITE}/{}.git", run.repo),
                    },
                    Outcome::Fail(_) => format!("{SITE}/{}.git", run.repo),
                }
            }
            _ => format!("{SITE}/{}.git", run.repo),
        };

        Ok(Outcome::Ok(json!({
            "job": job.id,
            "run": run.id,
            "key": job.key,
            "name": job.name,
            "spec": spec.raw,
            "workflow": {
                "env": workflow.env,
                "defaults": workflow.raw.get("defaults").cloned().unwrap_or(Value::Null),
            },
            "github": github,
            "variables": info.variables(&job.key),
            "event": info.event,
            "contexts": {
                "vars": vars,
                "secrets": secrets,
                "inputs": call_inputs.unwrap_or_else(|| Value::Object(run.inputs())),
                "matrix": matrix,
                "needs": needs,
                "strategy": {
                    "fail-fast": spec.fail_fast,
                    "job-index": job.ordinal,
                    "job-total": siblings,
                    "max-parallel": spec.max_parallel.unwrap_or(siblings as u32),
                },
                "runner": runner_context(),
            },
            "checkout": {
                "repository": run.repo,
                "url": clone_url,
                "sha": run.sha,
                "ref": run.git_ref,
                "token": token,
            },
            "timeoutMinutes": job.timeout_minutes,
            "masks": masks,
        })))
    }

    /// `job_report`: the sandbox telling how the job is going.
    pub async fn job_report(&self, a: JobCallArgs) -> Result<Outcome<Value>> {
        let job = check!(self.job_for_token(&a).await?);
        let report = &a.report;
        let at = now();
        match report["kind"].as_str().unwrap_or_default() {
            "steps" => {
                // The list can grow as the job goes (post steps), so steps
                // already reported keep where they stand.
                let known: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
                let steps: Vec<Value> = report["steps"]
                    .as_array()
                    .map(|names| {
                        names
                            .iter()
                            .enumerate()
                            .map(|(i, name)| match known.get(i) {
                                Some(step) if step["status"] != "queued" => step.clone(),
                                _ => json!({ "number": i + 1, "name": expr::to_text(name), "status": "queued", "conclusion": null, "startedAt": null, "finishedAt": null }),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.db
                    .prepare("UPDATE jobs SET steps = ?, seen_at = ? WHERE id = ?")
                    .bind(&[serde_json::to_string(&steps)?.into(), at.as_str().into(), job.id.as_str().into()])?
                    .run()
                    .await?;
            }
            "step" => {
                let number = report["number"].as_u64().unwrap_or(0) as usize;
                let mut steps: Vec<Value> = serde_json::from_str(&job.steps).unwrap_or_default();
                if let Some(step) = number.checked_sub(1).and_then(|i| steps.get_mut(i)) {
                    let status = report["status"].as_str().unwrap_or("in_progress");
                    step["status"] = json!(status);
                    if status == "in_progress" {
                        step["startedAt"] = json!(at);
                    }
                    if status == "completed" {
                        step["finishedAt"] = json!(at);
                        step["conclusion"] = report["conclusion"].clone();
                    }
                    if let Some(name) = report["name"].as_str() {
                        step["name"] = json!(name);
                    }
                }
                self.db
                    .prepare("UPDATE jobs SET steps = ?, seen_at = ? WHERE id = ?")
                    .bind(&[serde_json::to_string(&steps)?.into(), at.as_str().into(), job.id.as_str().into()])?
                    .run()
                    .await?;
            }
            "log" => {
                let mut text = report["text"].as_str().unwrap_or_default().to_owned();
                if text.len() > MAX_CHUNK_BYTES {
                    let mut cut = MAX_CHUNK_BYTES;
                    while !text.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    text.truncate(cut);
                }
                #[derive(Deserialize)]
                struct Size {
                    n: Option<f64>,
                    seq: Option<f64>,
                }
                let size = self
                    .db
                    .prepare("SELECT SUM(LENGTH(text)) AS n, MAX(seq) AS seq FROM logs WHERE job_id = ?")
                    .bind(&[job.id.as_str().into()])?
                    .first::<Size>(None)
                    .await?;
                let (used, seq) = size.map_or((0, 0.0), |s| (s.n.unwrap_or(0.0) as usize, s.seq.unwrap_or(0.0)));
                if used < MAX_LOG_BYTES {
                    if used + text.len() >= MAX_LOG_BYTES {
                        text.push_str("\n… The log reached its limit of 4 MB; the rest is not kept.\n");
                    }
                    self.db
                        .prepare("INSERT INTO logs (job_id, seq, step, text) VALUES (?, ?, ?, ?)")
                        .bind(&[job.id.as_str().into(), // Numbers go to D1 as f64: a u64 would be a BigInt, which it refuses.
                            (seq + 1.0).into(), (report["step"].as_u64().unwrap_or(0) as u32).into(), text.into()])?
                        .run()
                        .await?;
                }
                self.db.prepare("UPDATE jobs SET seen_at = ? WHERE id = ?").bind(&[at.into(), job.id.as_str().into()])?.run().await?;
            }
            "annotation" => {
                let mut annotations: Vec<Value> = serde_json::from_str(&job.annotations).unwrap_or_default();
                if annotations.len() < MAX_ANNOTATIONS {
                    annotations.push(json!({
                        "level": report["level"].as_str().unwrap_or("notice"),
                        "message": report["message"].as_str().unwrap_or_default().chars().take(4000).collect::<String>(),
                        "title": report["title"],
                        "file": report["file"],
                        "line": report["line"],
                    }));
                    self.db
                        .prepare("UPDATE jobs SET annotations = ?, seen_at = ? WHERE id = ?")
                        .bind(&[serde_json::to_string(&annotations)?.into(), at.as_str().into(), job.id.as_str().into()])?
                        .run()
                        .await?;
                }
            }
            "done" => {
                let conclusion = report["conclusion"]
                    .as_str()
                    .filter(|c| matches!(*c, "success" | "failure" | "cancelled"))
                    .unwrap_or("failure");
                let outputs = report["outputs"].as_object().cloned();
                Box::pin(self.finish_job(&job.id, conclusion, report["reason"].as_str(), outputs.as_ref())).await?;
            }
            other => return Ok(fail(FailureCode::Invalid, format!("There is no report called `{other}`."))),
        }
        Ok(Outcome::Ok(json!({ "ok": true })))
    }

    // --- Every minute ---------------------------------------------------------------

    pub async fn on_minute(&self, now_ms: u64) -> Result<()> {
        let minute = now_ms / 60_000 * 60_000;
        if let Err(error) = self.run_schedules(minute).await {
            worker::console_error!("actions: schedules failed: {error}");
        }
        // Jobs whose sandbox went quiet or ran past their time.
        let running = self.db.prepare("SELECT * FROM jobs WHERE status = 'in_progress'").all().await?.results::<JobRow>()?;
        for job in running {
            // Times in g1t's format compare as text.
            let before = |ms: u64| rfc3339(now_ms.saturating_sub(ms));
            let silent = job.seen_at.as_deref().is_some_and(|seen| seen < before(SILENT_MS).as_str());
            let limit = (u64::from(job.timeout_minutes) * 60 + 120) * 1000;
            let over = job.started_at.as_deref().is_some_and(|started| started < before(limit).as_str());
            if over {
                let reason = format!("It ran longer than its time limit of {} minutes.", job.timeout_minutes);
                let _: Result<Value> = g1t_kit::call(&self.runner, "stop_actions_job", &json!({ "job": job.id })).await;
                self.finish_job(&job.id, "failure", Some(&reason), None).await?;
            } else if silent {
                self.finish_job(&job.id, "failure", Some("The runner stopped answering."), None).await?;
            }
        }
        self.start_queued().await
    }
}

