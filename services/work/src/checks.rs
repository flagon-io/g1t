//! Check runs: the record of the merge queue taking a pull request out,
//! and of commands written on issues, which g1t ran before a pull
//! request's checks were the workflows run on it. Those runs are kept so
//! their history still reads; a sandbox still finishing one reports
//! through the API with the job's one-time token.

use g1t_contracts::events::ChecksEvent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::rows::{PULL_COLUMNS, PullRow};
use crate::{Work, optional};

const MAX_OUTPUT_CHARS: usize = 16_000;
const MAX_RESULTS: usize = 20;
/// How many earlier runs a pull request shows.
const EARLIER_RUNS: u32 = 10;

#[derive(Deserialize)]
struct RunRow {
    id: String,
    pull_id: String,
    head_commit: String,
    status: CheckStatus,
    /// JSON array of results.
    results: String,
    error: Option<String>,
    token_hash: String,
    created_at: String,
    finished_at: Option<String>,
}

impl From<RunRow> for CheckRun {
    fn from(row: RunRow) -> Self {
        CheckRun {
            id: row.id,
            head_commit: row.head_commit,
            status: row.status,
            results: serde_json::from_str(&row.results).unwrap_or_default(),
            error: row.error,
            created_at: row.created_at,
            finished_at: row.finished_at,
        }
    }
}

pub(crate) fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub(crate) fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("no source of randomness");
    hex::encode(bytes)
}

fn refused<T>(message: &str) -> Outcome<T> {
    Outcome::fail(FailureCode::Conflict, message)
}

impl Work {
    /// The most recent check run of a pull request.
    pub(crate) async fn latest_checks(&self, pull_id: &str) -> Result<Option<CheckRun>> {
        Ok(self
            .db
            .prepare("SELECT * FROM check_runs WHERE pull_id = ? ORDER BY id DESC LIMIT 1")
            .bind(&[pull_id.into()])?
            .first::<RunRow>(None)
            .await?
            .map(CheckRun::from))
    }

    /// The runs before the latest, newest first, without what each command
    /// printed: enough to see how the checks went over time.
    pub(crate) async fn earlier_checks(&self, pull_id: &str) -> Result<Vec<CheckRun>> {
        let rows = self
            .db
            .prepare(
                "SELECT * FROM check_runs WHERE pull_id = ? ORDER BY id DESC LIMIT ? OFFSET 1",
            )
            .bind(&[pull_id.into(), EARLIER_RUNS.into()])?
            .all()
            .await?
            .results::<RunRow>()?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let mut run = CheckRun::from(row);
                for result in &mut run.results {
                    result.output = String::new();
                }
                run
            })
            .collect())
    }

    /// Commands written on issues are no longer run: a pull request's
    /// checks are the workflows run on it, and the default branch's
    /// protection says which must pass. Refused, for a runner from before.
    pub(crate) async fn start_checks(&self, _: StartChecksArgs) -> Result<Outcome<CheckJob>> {
        Ok(refused(
            "Checks are the workflows run on a pull request; there are no commands to run.",
        ))
    }

    /// Records what a sandbox reports for its run: that it has started, its
    /// results, that it could not run, or that the run should be forgotten.
    /// The run's token is the only credential, and a finished run accepts
    /// nothing more.
    pub(crate) async fn report_checks(&self, a: ReportChecksArgs) -> Result<Outcome<CheckRun>> {
        let run = self
            .db
            .prepare("SELECT * FROM check_runs WHERE id = ?")
            .bind(&[a.run_id.as_str().into()])?
            .first::<RunRow>(None)
            .await?;
        let Some(run) = run.filter(|run| run.token_hash == hash(&a.token)) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Check run not found."));
        };
        if run.finished_at.is_some() {
            return Ok(refused("This check run has already finished."));
        }
        let latest = "id = ? AND check_run_id = ?";
        let pull_keys =
            || -> [JsValue; 2] { [run.pull_id.as_str().into(), run.id.as_str().into()] };

        if a.skip {
            self.db
                .batch(vec![
                    self.db
                        .prepare("DELETE FROM check_runs WHERE id = ?")
                        .bind(&[run.id.as_str().into()])?,
                    self.db
                        .prepare(format!(
                            "UPDATE pulls SET check_status = NULL, check_run_id = NULL WHERE {latest}"
                        ))
                        .bind(&pull_keys())?,
                ])
                .await?;
            return Ok(Outcome::Ok(run.into()));
        }

        let results: Vec<CheckResult> = a
            .results
            .into_iter()
            .take(MAX_RESULTS)
            .map(|mut result| {
                // Keep the end of long output: that is where failures are.
                let length = result.output.chars().count();
                if length > MAX_OUTPUT_CHARS {
                    result.output = result
                        .output
                        .chars()
                        .skip(length - MAX_OUTPUT_CHARS)
                        .collect();
                }
                result
            })
            .collect();
        let status = if a.error.is_some() {
            CheckStatus::Errored
        } else if results.is_empty() {
            CheckStatus::Running
        } else if results.iter().all(|result| result.passed) {
            CheckStatus::Passed
        } else {
            CheckStatus::Failed
        };
        let finished = (status != CheckStatus::Running).then(|| rfc3339(now_ms()));
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE check_runs SET status = ?, results = ?, error = ?, finished_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[
                        status.as_str().into(),
                        serde_json::to_string(&results)?.into(),
                        optional(&a.error),
                        optional(&finished),
                        run.id.as_str().into(),
                    ])?,
                self.db
                    .prepare(format!("UPDATE pulls SET check_status = ? WHERE {latest}"))
                    .bind(&[
                        status.as_str().into(),
                        run.pull_id.as_str().into(),
                        run.id.as_str().into(),
                    ])?,
            ])
            .await?;

        if finished.is_some() {
            let pull = self
                .db
                .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE id = ?"))
                .bind(&[run.pull_id.as_str().into()])?
                .first::<PullRow>(None)
                .await?
                .map(Pull::from);
            if let Some(pull) = pull {
                self.publish_as(
                    "checks.completed",
                    &pull.repo_id,
                    None,
                    ChecksEvent {
                        pull_id: pull.id.clone(),
                        repo_id: pull.repo_id.clone(),
                        number: pull.number,
                        status: status.as_str(),
                        commit: run.head_commit.clone(),
                    },
                )
                .await?;
            }
        }
        Ok(Outcome::Ok(CheckRun {
            status,
            results,
            error: a.error,
            finished_at: finished,
            ..run.into()
        }))
    }
}
