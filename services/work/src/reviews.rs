//! What g1t adds around a pull request for many agents working at once:
//! which files it changes, which other pull requests are changing the same
//! files, whether it has fallen behind, and reviews written by a g1t agent.

use std::collections::HashSet;

use g1t_contracts::events::ReviewEvent;
use g1t_contracts::repos::{BehindArgs, Comparison, GetByIdArgs, HeadArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::rows::{PULL_COLUMNS, PullRow};
use crate::{Work, optional_number};

/// Beyond this a change is too large for per-file bookkeeping to be useful.
const MAX_FILES: usize = 300;
const MAX_REVIEW_COMMENTS: usize = 30;
const MAX_REVIEW_CHARS: usize = 20_000;
/// Who reviews by g1t's agent are attributed to: shown as `g1t`, which
/// nobody can register or sign in as.
pub(crate) use g1t_contracts::identity::{AGENT_ID, AGENT_NAME};

#[derive(Deserialize)]
struct OtherRow {
    number: u32,
    title: String,
    issue_number: Option<u32>,
    files: Option<String>,
}

#[derive(Deserialize)]
struct ReviewRunRow {
    id: String,
    pull_id: String,
    token_hash: String,
    finished_at: Option<String>,
}

fn hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl Work {
    pub(crate) async fn pull_by_id(&self, id: &str) -> Result<Option<Pull>> {
        Ok(self
            .db
            .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE id = ?"))
            .bind(&[id.into()])?
            .first::<PullRow>(None)
            .await?
            .map(Pull::from))
    }

    /// Works out which files a pull request changes and records them, so
    /// that overlaps between pull requests can be found without comparing
    /// every one of them each time.
    pub(crate) async fn refresh_files(&self, pull: &Pull) -> Result<Vec<ChangedFile>> {
        // Its author can read both the repository and the pull request's source.
        let viewer = self.author_viewer(pull).await?;
        let compared: Outcome<Comparison> =
            g1t_kit::call(&self.repos, "compare", &pull.comparison(&viewer)).await?;
        let files: Vec<ChangedFile> = match compared {
            Outcome::Ok(comparison) => comparison
                .files
                .into_iter()
                .take(MAX_FILES)
                .map(|file| ChangedFile {
                    path: file.path,
                    additions: file.additions,
                    deletions: file.deletions,
                })
                .collect(),
            // Nothing pushed yet, or nothing to compare against.
            Outcome::Fail(_) => Vec::new(),
        };
        self.db
            .prepare("UPDATE pulls SET files = ? WHERE id = ?")
            .bind(&[
                serde_json::to_string(&files)?.into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(files)
    }

    /// Other pull requests in progress that change files this one changes.
    pub(crate) async fn overlaps(&self, pull: &Pull) -> Result<Vec<Overlap>> {
        if pull.files.is_empty() {
            return Ok(Vec::new());
        }
        let mine: HashSet<&str> = pull.files.iter().map(|file| file.path.as_str()).collect();
        let others = match self.prefetched_pull(&pull.id) {
            Some(found) => found.rows::<OtherRow>(crate::prefetch::Slot::Others)?,
            None => self.other_pulls(pull).await?,
        };
        Ok(others
            .into_iter()
            .filter_map(|other| {
                let files: Vec<ChangedFile> =
                    serde_json::from_str(other.files.as_deref().unwrap_or("[]")).ok()?;
                let paths: Vec<String> = files
                    .into_iter()
                    .map(|file| file.path)
                    .filter(|path| mine.contains(path.as_str()))
                    .collect();
                (!paths.is_empty()).then_some(Overlap {
                    number: other.number,
                    title: other.title,
                    issue: other.issue_number,
                    paths,
                })
            })
            .collect())
    }

    /// The other pull requests in progress in its repository.
    async fn other_pulls(&self, pull: &Pull) -> Result<Vec<OtherRow>> {
        self
            .db
            .prepare(
                "SELECT number, title, issue_number, files FROM pulls
                 WHERE repo_id = ? AND id != ? AND status IN ('draft', 'open')
                 ORDER BY number LIMIT 200",
            )
            .bind(&[pull.repo_id.as_str().into(), pull.id.as_str().into()])?
            .all()
            .await?
            .results::<OtherRow>()
    }

    /// Whether the branch a pull request would merge into has commits the
    /// pull request does not, so that it must catch up before it can merge.
    pub(crate) async fn is_behind(&self, repo_id: &str, pull: &Pull) -> Result<bool> {
        if !pull.status.is_active() || pull.head_commit.is_none() {
            return Ok(false);
        }
        let asked = BehindArgs {
            source_id: pull
                .fork_repo_id
                .clone()
                .unwrap_or_else(|| repo_id.to_owned()),
            branch: pull.branch.clone(),
        };
        self.timing.rpc(g1t_kit::call(&self.repos, "behind", &asked)).await
    }

    pub(crate) async fn review_pending(&self, pull_id: &str) -> Result<bool> {
        if let Some(found) = self.prefetched_pull(pull_id) {
            return Ok(found.first::<crate::rows::ValueRow>(crate::prefetch::Slot::ReviewPending)?.is_some());
        }
        Ok(self
            .db
            .prepare(
                "SELECT id AS value FROM review_runs
                 WHERE pull_id = ? AND finished_at IS NULL AND created_at > ? LIMIT 1",
            )
            // A sandbox that never reported is forgotten after a while.
            .bind(&[
                pull_id.into(),
                rfc3339(now_ms().saturating_sub(crate::prefetch::REVIEW_PENDING_MS)).into(),
            ])?
            .first::<crate::rows::ValueRow>(None)
            .await?
            .is_some())
    }

    /// Begins a review of a pull request by a g1t agent and returns what a
    /// sandbox needs to carry it out.
    pub(crate) async fn start_review(&self, a: StartReviewArgs) -> Result<Outcome<ReviewJob>> {
        let Some(pull) = self.pull_by_id(&a.pull_id).await? else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "Pull request not found.",
            ));
        };
        if pull.status != PullStatus::Open {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "A pull request can be reviewed once it is ready for review.",
            ));
        }
        let viewer = self.author_viewer(&pull).await?;
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer,
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "Pull request not found.",
            ));
        };
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
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request has no commits to review.",
            ));
        };
        let issue = match pull.issue {
            Some(number) => self.issue(&pull.repo_id, number).await?,
            None => None,
        };

        let now = now_ms();
        let run_id = new_id("rvw", now);
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("no source of randomness");
        let token = hex::encode(bytes);
        self.db
            .prepare(
                "INSERT INTO review_runs (id, pull_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
            )
            .bind(&[
                run_id.as_str().into(),
                pull.id.as_str().into(),
                hash(&token).into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;

        let path = RepoPath {
            namespace: repo.namespace,
            name: repo.name,
        };
        let mut sensitive: Vec<String> = Vec::new();
        for kind in pull.files.iter().filter_map(|file| crate::confidence::sensitive(&file.path)) {
            if !sensitive.iter().any(|seen| seen == kind) {
                sensitive.push(kind.to_owned());
            }
        }
        Ok(Outcome::Ok(ReviewJob {
            run_id,
            token,
            source: pull.fork.clone().unwrap_or_else(|| path.clone()),
            commit,
            repo: path,
            default_branch: repo.default_branch,
            number: pull.number,
            title: pull.title,
            description: pull.body.unwrap_or_default(),
            issue,
            author: pull.author,
            files: pull.files,
            sensitive,
        }))
    }

    /// Records the review a sandbox's agent wrote: its verdict, its summary
    /// and its comments on lines. The run's token is the only credential.
    pub(crate) async fn report_review(&self, a: ReportReviewArgs) -> Result<Outcome<bool>> {
        let run = self
            .db
            .prepare("SELECT id, pull_id, token_hash, finished_at FROM review_runs WHERE id = ?")
            .bind(&[a.run_id.as_str().into()])?
            .first::<ReviewRunRow>(None)
            .await?;
        let Some(run) = run.filter(|run| run.token_hash == hash(&a.token)) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Review not found."));
        };
        if run.finished_at.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This review has already been reported.",
            ));
        }
        let Some(pull) = self.pull_by_id(&run.pull_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Review not found."));
        };

        let now = now_ms();
        let timestamp = rfc3339(now);
        let signature = a
            .model
            .as_deref()
            .map(|model| format!("\n\n_Reviewed by g1t on {model}._"))
            .unwrap_or_default();
        let summary = match &a.error {
            Some(error) => format!("The review could not be completed: {error}"),
            None => {
                let body: String = a.body.trim().chars().take(MAX_REVIEW_CHARS).collect();
                format!("{body}{signature}")
            }
        };
        // A failed review carries no verdict.
        let verdict = a.verdict.filter(|_| a.error.is_none());
        let known: HashSet<&str> = pull.files.iter().map(|file| file.path.as_str()).collect();

        let insert = "INSERT INTO comments
               (id, repo_id, number, author_id, author_name, body, path, line, verdict, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        let mut statements = Vec::new();
        // Line comments first, so the summary and verdict read as the conclusion.
        for comment in a
            .comments
            .iter()
            .filter(|comment| a.error.is_none() && !comment.body.trim().is_empty())
            // A line in a file the pull request does not change is not a review of it.
            .filter(|comment| known.is_empty() || known.contains(comment.path.as_str()))
            .take(MAX_REVIEW_COMMENTS)
        {
            let body: String = comment.body.trim().chars().take(MAX_REVIEW_CHARS).collect();
            statements.push(self.db.prepare(insert).bind(&[
                new_id("cmt", now).into(),
                pull.repo_id.as_str().into(),
                pull.number.into(),
                AGENT_ID.into(),
                AGENT_NAME.into(),
                body.into(),
                comment.path.as_str().into(),
                optional_number(Some(comment.line).filter(|line| *line > 0)),
                JsValue::NULL,
                timestamp.as_str().into(),
            ])?);
        }
        statements.push(self.db.prepare(insert).bind(&[
            new_id("cmt", now).into(),
            pull.repo_id.as_str().into(),
            pull.number.into(),
            AGENT_ID.into(),
            AGENT_NAME.into(),
            summary.into(),
            JsValue::NULL,
            JsValue::NULL,
            verdict.map_or(JsValue::NULL, |verdict| verdict.as_str().into()),
            timestamp.as_str().into(),
        ])?);
        statements.push(
            self.db
                .prepare("UPDATE review_runs SET finished_at = ?, verdict = ? WHERE id = ?")
                .bind(&[
                    timestamp.as_str().into(),
                    verdict.map_or(JsValue::NULL, |verdict| verdict.as_str().into()),
                    run.id.as_str().into(),
                ])?,
        );
        statements.push(
            self.db
                .prepare("UPDATE pulls SET updated_at = ? WHERE id = ?")
                .bind(&[timestamp.as_str().into(), pull.id.as_str().into()])?,
        );
        // The review g1t asked for itself is no longer under way.
        statements.push(
            self.db
                .prepare(
                    "UPDATE pulls SET working_on = NULL, working_until = NULL
                     WHERE id = ? AND working_on = 'review'",
                )
                .bind(&[pull.id.as_str().into()])?,
        );
        self.db.batch(statements).await?;
        self.publish_as(
            "review.completed",
            &pull.repo_id,
            None,
            ReviewEvent {
                pull_id: pull.id.clone(),
                repo_id: pull.repo_id.clone(),
                number: pull.number,
                verdict: verdict.map(Verdict::as_str),
            },
        )
        .await?;
        Ok(Outcome::Ok(true))
    }
}
