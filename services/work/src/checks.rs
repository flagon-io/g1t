//! Check runs: an issue's acceptance checks, run against a pull request's
//! head in a clean sandbox.
//!
//! This service keeps the record. The runner service starts the sandbox:
//! it asks for a job with `start_checks`, and the sandbox reports back
//! through the API with the job's one-time token. Nothing else can write a
//! result, including the agent whose work is being checked.

use g1t_contracts::events::ChecksEvent;
use g1t_contracts::repos::{GetByIdArgs, HeadArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::rows::PullRow;
use crate::{Work, optional};

const MAX_OUTPUT_CHARS: usize = 16_000;
const MAX_RESULTS: usize = 20;

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

    /// Begins a check run for a pull request that is ready for review, and
    /// returns what a sandbox needs to carry it out. Any run still in
    /// progress for the pull request is abandoned.
    pub(crate) async fn start_checks(&self, a: StartChecksArgs) -> Result<Outcome<CheckJob>> {
        let pull = self
            .db
            .prepare("SELECT * FROM pulls WHERE id = ?")
            .bind(&[a.pull_id.as_str().into()])?
            .first::<PullRow>(None)
            .await?
            .map(Pull::from);
        let Some(pull) = pull else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "Pull request not found.",
            ));
        };
        if pull.status != PullStatus::Open {
            return Ok(refused(
                "Checks run once a pull request is ready for review.",
            ));
        }
        let issue = match pull.issue {
            Some(number) => self.issue(&pull.repo_id, number).await?,
            None => None,
        };
        let Some(issue) = issue.filter(|issue| !issue.checks.is_empty()) else {
            return Ok(refused(
                "This pull request's issue has no acceptance checks.",
            ));
        };

        // The author can read both the repository and the pull request's source.
        let viewer = Some(pull.author.clone());
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer,
            },
        )
        .await?;
        let Outcome::Ok(repo) = repo else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "Pull request not found.",
            ));
        };
        // Asked of the store, since the recorded head can lag a push.
        let head: Option<String> = g1t_kit::call(
            &self.repos,
            "head",
            &HeadArgs {
                repo_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                branch: pull
                    .branch
                    .clone()
                    .unwrap_or_else(|| repo.default_branch.clone()),
            },
        )
        .await?;
        let Some(commit) = head else {
            return Ok(refused("This pull request has no commits to check."));
        };

        let now = now_ms();
        let timestamp = rfc3339(now);
        let run_id = new_id("chk", now);
        let token = new_token();
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE check_runs
                         SET status = 'errored', error = 'Replaced by a newer run.', finished_at = ?
                         WHERE pull_id = ? AND finished_at IS NULL",
                    )
                    .bind(&[timestamp.as_str().into(), pull.id.as_str().into()])?,
                self.db
                    .prepare(
                        "INSERT INTO check_runs (id, pull_id, head_commit, token_hash, created_at)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        run_id.as_str().into(),
                        pull.id.as_str().into(),
                        commit.as_str().into(),
                        hash(&token).into(),
                        timestamp.as_str().into(),
                    ])?,
                self.db
                    .prepare(
                        "UPDATE pulls SET check_status = 'queued', check_run_id = ?, head_commit = ?
                         WHERE id = ?",
                    )
                    .bind(&[
                        run_id.as_str().into(),
                        commit.as_str().into(),
                        pull.id.as_str().into(),
                    ])?,
            ])
            .await?;

        Ok(Outcome::Ok(CheckJob {
            run_id,
            token,
            commands: issue.checks,
            source: pull.fork.clone().unwrap_or(RepoPath {
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
            }),
            commit,
            author: pull.author,
            requested_by: issue.author.username,
            repo: RepoPath {
                namespace: repo.namespace,
                name: repo.name,
            },
            number: pull.number,
        }))
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
                .prepare("SELECT * FROM pulls WHERE id = ?")
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
