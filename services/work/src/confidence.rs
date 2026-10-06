//! How sure g1t is of a change an agent made.
//!
//! Worked out from what g1t can observe, never from how the agent sounds:
//! whether the checks the default branch requires pass on it (and whether
//! the branch requires any), whether it failed in the merge queue, how
//! many times the agent was sent back, the reviewer agent's verdict and how
//! much it had to say, whether tests were added or changed, how large the
//! change is and whether it reached outside the files its plan expected,
//! whether it touched paths that run or configure things (CI, secrets,
//! infrastructure), how close its runs came to their guardrails, and what
//! it asked other agents without an answer.
//!
//! The agent can say how sure it is too, at the end of its run
//! (`report_confidence`). That is combined with the signals by taking the
//! lower of the two: what g1t observes can lower what the agent says, never
//! raise it.
//!
//! [`score`] is pure and tested on its own; [`Work::assess_confidence`]
//! gathers the signals for a pull request, and records the result on it
//! and on the run that left it so. Where a repository asks for it
//! (`hold_low_confidence`), a low-confidence change waits for a person
//! instead of merging by itself (lifecycle.rs).

use futures_util::future::try_join;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{
    ChangedFile, Confidence, ConfidenceLevel, Pull, ReportConfidenceArgs, RequiredCheck, RequiredState, Verdict,
};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::checks::hash;
use crate::reviews::AGENT_ID;
use crate::prefetch::Slot;
use crate::rows::NumberRow;

/// At this many points, low; at none, high; medium between.
const LOW_AT: u32 = 3;
/// The most reasons a confidence gives.
const MAX_REASONS: usize = 4;
/// The most a self-report's list of doubts keeps, and of each.
const MAX_UNCERTAIN: usize = 5;
const MAX_UNCERTAIN_CHARS: usize = 160;
/// A share of a run's cap past which it was close to it.
const NEAR_CAP: f64 = 0.8;

/// Where the checks the default branch requires stand on a change's head,
/// taken together.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum RequiredSignal {
    /// The branch requires no checks: nothing has to pass.
    #[default]
    NoneRequired,
    Passing,
    Failing,
    Running,
    /// Required, and nothing has reported them on the head.
    NotRun,
}

impl RequiredSignal {
    pub(crate) fn of(required: &[RequiredCheck]) -> RequiredSignal {
        let any = |state: RequiredState| required.iter().any(|check| check.state == state);
        if required.is_empty() {
            RequiredSignal::NoneRequired
        } else if any(RequiredState::Failure) {
            RequiredSignal::Failing
        } else if any(RequiredState::Pending) {
            RequiredSignal::Running
        } else if any(RequiredState::Expected) {
            RequiredSignal::NotRun
        } else {
            RequiredSignal::Passing
        }
    }
}

/// Everything confidence is worked out from.
#[derive(Clone, Debug, Default)]
pub(crate) struct Signals {
    /// Where the required checks stand on its head.
    pub required: RequiredSignal,
    /// The merge queue took it out: it failed together with what was ahead.
    pub queue_failed: bool,
    /// A recorded run errored, or failed and then passed on the same
    /// commit: they pass, but not reliably.
    pub flaky_checks: bool,
    /// How many times the agent was sent back.
    pub revisions: u32,
    /// Whether a second agent reviews changes here.
    pub agent_review: bool,
    /// The verdict of the latest review of the change as it is now.
    pub review: Option<Verdict>,
    /// How many comments on lines that review left.
    pub review_comments: u32,
    pub files: Vec<ChangedFile>,
    /// The files the issue's plan expected it to change; empty when it was
    /// not planned.
    pub expected: Vec<String>,
    /// `budget` or `time` when a run was stopped at a cap.
    pub halted: Option<String>,
    /// The latest run's cost as a share of its cost cap.
    pub budget_share: Option<f64>,
    /// The latest run's time as a share of its time cap.
    pub time_share: Option<f64>,
    /// Commands and tools the guardrails refused while it worked.
    pub denials: u32,
    /// Questions and handoffs it sent other agents that have no answer.
    pub unanswered: u32,
    /// What the agent said of its own change.
    pub self_reported: Option<ConfidenceLevel>,
    pub uncertain_about: Vec<String>,
}

/// Test files, by the names test runners look for.
pub(crate) fn is_test(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let file = lower.rsplit('/').next().unwrap_or(&lower);
    lower.split('/').any(|dir| matches!(dir, "test" | "tests" | "__tests__" | "spec" | "specs" | "testdata"))
        || [".test.", ".spec.", "_test.", "-test.", "_spec."].iter().any(|mark| file.contains(mark))
        || file.starts_with("test_")
}

/// Files that change nothing that runs: prose and pictures.
fn is_prose(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".md", ".mdx", ".txt", ".rst", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]
        .iter()
        .any(|extension| lower.ends_with(extension))
        || lower.starts_with("docs/")
        || lower.rsplit('/').next().is_some_and(|file| file == "license" || file == "changelog")
}

/// Paths that run, configure or guard things rather than being the code
/// itself: CI, repository automation, secrets, infrastructure, ownership.
/// A change that reaches them deserves a person's eyes.
pub(crate) fn sensitive(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    let file = lower.rsplit('/').next().unwrap_or(&lower);
    if lower.starts_with(".github/workflows/") || lower.starts_with(".gitlab-ci") || lower.starts_with(".circleci/") {
        return Some("CI workflows");
    }
    if lower.starts_with(".g1t/") || lower.starts_with(".github/") {
        return Some("repository automation");
    }
    if file == "codeowners" {
        return Some("CODEOWNERS");
    }
    if file.starts_with(".env") || file.ends_with(".pem") || file.ends_with(".key") || file.contains("secret") {
        return Some("secrets");
    }
    if file.ends_with(".tf")
        || file.ends_with(".tfvars")
        || file == "dockerfile"
        || file.starts_with("docker-compose")
        || file.starts_with("wrangler.")
    {
        return Some("infrastructure");
    }
    None
}

/// Whether `path` is where the plan said the work would be: one of its
/// files, or beside one, in the same directory or below it.
fn expected(path: &str, planned: &[String]) -> bool {
    planned.iter().any(|file| {
        let file = file.trim().trim_start_matches("./");
        if path == file {
            return true;
        }
        let dir = file.rsplit_once('/').map_or("", |(dir, _)| dir);
        // A plan that names a directory, or a file at the root, covers less.
        let dir = if file.ends_with('/') { file.trim_end_matches('/') } else { dir };
        !dir.is_empty() && path.starts_with(&format!("{dir}/"))
    })
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What lowered confidence: how much, and in a few words. `None` points
/// makes it low on its own.
struct Mark {
    points: Option<u32>,
    reason: String,
}

fn sink(reason: impl Into<String>) -> Mark {
    Mark { points: None, reason: reason.into() }
}

fn points(points: u32, reason: impl Into<String>) -> Mark {
    Mark { points: Some(points), reason: reason.into() }
}

/// How sure g1t is of a change, from `signals`. Each signal that tells
/// against it adds points, or makes it low outright; no points is high,
/// one or two medium, three or more low. The agent's own word, when it
/// gave one, can only make it lower.
pub(crate) fn score(signals: &Signals) -> (ConfidenceLevel, Vec<String>) {
    let mut marks: Vec<Mark> = Vec::new();

    if signals.queue_failed {
        marks.push(sink("failed in the merge queue"));
    }
    match signals.required {
        RequiredSignal::Failing => marks.push(sink("required checks failing")),
        RequiredSignal::Running => marks.push(points(1, "required checks not finished")),
        RequiredSignal::NotRun => marks.push(points(1, "required checks not run")),
        RequiredSignal::NoneRequired => marks.push(points(1, "branch has no required checks")),
        RequiredSignal::Passing => {}
    }
    if signals.flaky_checks && signals.required == RequiredSignal::Passing {
        marks.push(points(1, "checks passed only on a retry"));
    }

    match signals.revisions {
        0 => {}
        n @ (1 | 2) => marks.push(points(n, plural(n, "revision", "revisions"))),
        n => marks.push(points(3, plural(n, "revision", "revisions"))),
    }

    match signals.review {
        Some(Verdict::RequestChanges) => marks.push(sink("reviewer asked for changes")),
        Some(Verdict::Approve) if signals.review_comments >= 3 => {
            marks.push(points(1, format!("reviewer left {} comments", signals.review_comments)));
        }
        Some(Verdict::Approve) => {}
        None if signals.agent_review => marks.push(points(1, "not reviewed yet")),
        None => marks.push(points(1, "no review")),
    }

    let code: Vec<&ChangedFile> = signals
        .files
        .iter()
        .filter(|file| !is_test(&file.path) && !is_prose(&file.path))
        .collect();
    let tests = signals.files.iter().filter(|file| is_test(&file.path)).count();
    if !code.is_empty() && tests == 0 {
        marks.push(points(1, "tests not added"));
    }

    let lines: u32 = signals.files.iter().map(|file| file.additions + file.deletions).sum();
    if lines > 1000 {
        marks.push(points(2, format!("large change ({lines} lines)")));
    } else if lines > 400 {
        marks.push(points(1, format!("{lines} lines changed")));
    }
    let files = signals.files.len() as u32;
    if files > 30 {
        marks.push(points(1, format!("{files} files changed")));
    }
    if !signals.expected.is_empty() {
        let outside = signals
            .files
            .iter()
            .filter(|file| !is_test(&file.path) && !is_prose(&file.path))
            .filter(|file| !expected(&file.path, &signals.expected))
            .count() as u32;
        if outside > 0 {
            marks.push(points(
                if outside >= 4 { 2 } else { 1 },
                format!("{} outside the planned area", plural(outside, "file", "files")),
            ));
        }
    }
    let mut touched: Vec<&str> = signals.files.iter().filter_map(|file| sensitive(&file.path)).collect();
    touched.dedup();
    if let Some(first) = touched.first() {
        marks.push(points(2, format!("touches {first}")));
    }

    match signals.halted.as_deref() {
        Some("budget") => marks.push(sink("stopped at its cost cap")),
        Some("time") => marks.push(sink("stopped at its time cap")),
        _ => {
            if signals.budget_share.is_some_and(|share| share >= NEAR_CAP) {
                let share = (signals.budget_share.unwrap_or_default() * 100.0).round() as u32;
                marks.push(points(1, format!("used {}% of its cost cap", share.min(100))));
            }
            if signals.time_share.is_some_and(|share| share >= NEAR_CAP) {
                let share = (signals.time_share.unwrap_or_default() * 100.0).round() as u32;
                marks.push(points(1, format!("used {}% of its time cap", share.min(100))));
            }
        }
    }
    if signals.denials > 0 {
        marks.push(points(
            if signals.denials >= 3 { 2 } else { 1 },
            format!("{} by guardrails", plural(signals.denials, "step refused", "steps refused")),
        ));
    }
    if signals.unanswered > 0 {
        marks.push(points(
            2,
            plural(signals.unanswered, "question unanswered", "questions unanswered"),
        ));
    }
    if !signals.uncertain_about.is_empty() {
        marks.push(points(1, format!("agent unsure about {}", signals.uncertain_about[0])));
    }

    let sunk = marks.iter().any(|mark| mark.points.is_none());
    let total: u32 = marks.iter().filter_map(|mark| mark.points).sum();
    let observed = if sunk || total >= LOW_AT {
        ConfidenceLevel::Low
    } else if total > 0 {
        ConfidenceLevel::Medium
    } else {
        ConfidenceLevel::High
    };
    let level = signals.self_reported.map_or(observed, |said| said.min(observed));

    // Most telling first: what makes it low on its own, then by weight.
    marks.sort_by_key(|mark| std::cmp::Reverse(mark.points.unwrap_or(u32::MAX)));
    let mut reasons: Vec<String> = Vec::new();
    if let Some(said) = signals.self_reported.filter(|said| *said < observed) {
        reasons.push(format!("agent says {}", said.as_str()));
    }
    reasons.extend(marks.into_iter().map(|mark| mark.reason));
    if reasons.is_empty() {
        // High: what it rests on.
        if signals.required == RequiredSignal::Passing {
            reasons.push("required checks pass".to_owned());
        }
        if signals.review == Some(Verdict::Approve) {
            reasons.push(if signals.revisions == 0 { "approved on first review" } else { "review approved" }.to_owned());
        }
        if tests > 0 {
            reasons.push("tests added".to_owned());
        }
        if lines > 0 && lines <= 100 {
            reasons.push("small change".to_owned());
        }
    }
    reasons.truncate(MAX_REASONS);
    (level, reasons)
}

/// A self-report's doubts, tidied: short, distinct, a few.
fn tidy(uncertain: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in uncertain {
        let line = item.split_whitespace().collect::<Vec<_>>().join(" ");
        let line: String = line.chars().take(MAX_UNCERTAIN_CHARS).collect();
        if !line.is_empty() && !out.contains(&line) {
            out.push(line);
        }
        if out.len() == MAX_UNCERTAIN {
            break;
        }
    }
    out
}

#[derive(Deserialize)]
struct CheckRow {
    head_commit: String,
    status: String,
}

#[derive(Deserialize)]
struct LatestRun {
    id: String,
    cost_usd: Option<f64>,
    budget_usd: Option<f64>,
    time_cap_minutes: Option<u32>,
    minutes: Option<f64>,
    self_level: Option<String>,
    uncertain_about: Option<String>,
}

#[derive(Deserialize)]
struct Halted {
    halted: Option<String>,
}

#[derive(Deserialize)]
struct PlannedFiles {
    files: Option<String>,
}

#[derive(Deserialize)]
struct RunTicket {
    repo_id: String,
    pull_id: Option<String>,
    token_hash: String,
}

/// Whether a list of check runs, oldest first, shows checks that pass but
/// not reliably: one errored, or failed and later passed on the same commit.
pub(crate) fn flaky(runs: &[(String, String)]) -> bool {
    runs.iter().any(|(_, status)| status == "errored")
        || runs.iter().enumerate().any(|(index, (commit, status))| {
            status == "failed" && runs[index + 1..].iter().any(|(later, status)| later == commit && status == "passed")
        })
}

impl Work {
    /// Whether the repository asks a person before merging a low-confidence
    /// change. On unless someone turned it off.
    pub(crate) async fn holds_low_confidence(&self, repo_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT hold_low AS n FROM confidence_rules WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<NumberRow>(None)
            .await?
            .is_none_or(|row| row.n != 0))
    }

    /// Records whether the repository holds low-confidence changes.
    pub(crate) async fn set_hold_low_confidence(&self, repo_id: &str, hold: bool, by: &str, at: &str) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO confidence_rules (repo_id, hold_low, updated_by, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (repo_id) DO UPDATE SET
                   hold_low = excluded.hold_low, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
            )
            .bind(&[repo_id.into(), u32::from(hold).into(), by.into(), at.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// The signals for a pull request a g1t agent has finished, besides the
    /// ones its lifecycle already knows (`known`).
    async fn signals(&self, pull: &Pull, known: Signals) -> Result<(Signals, Option<String>)> {
        let (runs, ((latest, halted), (denials, unanswered, expected))) = match self.prefetched_pull(&pull.id) {
            Some(found) => (
                found
                    .rows::<CheckRow>(Slot::RunHistory)?
                    .into_iter()
                    .map(|row| (row.head_commit, row.status))
                    .collect::<Vec<_>>(),
                (
                    (
                        found.first::<LatestRun>(Slot::LatestRun)?,
                        found.first::<Halted>(Slot::Halted)?.and_then(|row| row.halted),
                    ),
                    (
                        found.first::<NumberRow>(Slot::Denials)?.map_or(0, |row| row.n),
                        found.first::<NumberRow>(Slot::Unanswered)?.map_or(0, |row| row.n),
                        found
                            .first::<PlannedFiles>(Slot::Planned)?
                            .and_then(|row| row.files)
                            .and_then(|files| serde_json::from_str::<Vec<String>>(&files).ok())
                            .unwrap_or_default(),
                    ),
                ),
            ),
            None => self.read_signals(pull).await?,
        };
        Ok(Self::signals_from(pull, known, runs, latest, halted, denials, unanswered, expected))
    }

    /// The rows [`Self::signals`] works from, read one query at a time.
    #[allow(clippy::type_complexity)]
    async fn read_signals(
        &self,
        pull: &Pull,
    ) -> Result<(Vec<(String, String)>, ((Option<LatestRun>, Option<String>), (u32, u32, Vec<String>)))> {
        let checks = async {
            let rows = self
                .db
                .prepare("SELECT head_commit, status FROM check_runs WHERE pull_id = ? ORDER BY id LIMIT 50")
                .bind(&[pull.id.as_str().into()])?
                .all()
                .await?
                .results::<CheckRow>()?;
            Ok::<_, worker::Error>(rows.into_iter().map(|row| (row.head_commit, row.status)).collect::<Vec<_>>())
        };
        let run = async {
            // The latest run that worked on the change, and what its agent
            // said of it.
            let latest = self
                .db
                .prepare(
                    "SELECT r.id, r.cost_usd, r.budget_usd, r.time_cap_minutes,
                       (julianday(COALESCE(r.finished_at, r.updated_at)) - julianday(COALESCE(r.started_at, r.created_at))) * 1440 AS minutes,
                       c.self_level, c.uncertain_about
                     FROM agent_runs r LEFT JOIN run_confidence c ON c.run_id = r.id
                     WHERE r.pull_id = ? AND r.kind IN ('implement', 'revise')
                     ORDER BY r.created_at DESC LIMIT 1",
                )
                .bind(&[pull.id.as_str().into()])?
                .first::<LatestRun>(None)
                .await?;
            // Any run on it stopped at a cap.
            let halted = self
                .db
                .prepare(
                    "SELECT halted FROM agent_runs WHERE pull_id = ? AND halted IS NOT NULL
                     ORDER BY created_at DESC LIMIT 1",
                )
                .bind(&[pull.id.as_str().into()])?
                .first::<Halted>(None)
                .await?
                .and_then(|row| row.halted);
            Ok::<_, worker::Error>((latest, halted))
        };
        let counts = async {
            let denials = self
                .db
                .prepare(
                    "SELECT count(*) AS n FROM session_entries
                     WHERE pull_id = ? AND kind = 'note' AND text LIKE 'Denied:%'",
                )
                .bind(&[pull.id.as_str().into()])?
                .first::<NumberRow>(None)
                .await?
                .map_or(0, |row| row.n);
            let unanswered = self
                .db
                .prepare(
                    "SELECT count(*) AS n FROM agent_messages
                     WHERE repo_id = ? AND from_number = ? AND kind IN ('question', 'handoff')
                       AND answered_at IS NULL",
                )
                .bind(&[pull.repo_id.as_str().into(), pull.number.into()])?
                .first::<NumberRow>(None)
                .await?
                .map_or(0, |row| row.n);
            let planned = match pull.issue {
                Some(number) => self
                    .db
                    .prepare(
                        "SELECT json_extract(planned.value, '$.files') AS files
                         FROM plans, json_each(plans.issues) AS planned
                         WHERE plans.repo_id = ? AND plans.status = 'applied'
                           AND json_extract(planned.value, '$.number') = ?
                         LIMIT 1",
                    )
                    .bind(&[pull.repo_id.as_str().into(), number.into()])?
                    .first::<PlannedFiles>(None)
                    .await?
                    .and_then(|row| row.files)
                    .and_then(|files| serde_json::from_str::<Vec<String>>(&files).ok())
                    .unwrap_or_default(),
                None => Vec::new(),
            };
            Ok::<_, worker::Error>((denials, unanswered, planned))
        };
        try_join(checks, try_join(run, counts)).await
    }

    #[allow(clippy::too_many_arguments)]
    fn signals_from(
        pull: &Pull,
        known: Signals,
        runs: Vec<(String, String)>,
        latest: Option<LatestRun>,
        halted: Option<String>,
        denials: u32,
        unanswered: u32,
        expected: Vec<String>,
    ) -> (Signals, Option<String>) {
        let run_id = latest.as_ref().map(|run| run.id.clone());
        let share = |used: Option<f64>, cap: Option<f64>| match (used, cap) {
            (Some(used), Some(cap)) if cap > 0.0 => Some(used / cap),
            _ => None,
        };
        let signals = Signals {
            flaky_checks: flaky(&runs),
            files: pull.files.clone(),
            expected,
            halted,
            budget_share: latest.as_ref().and_then(|run| share(run.cost_usd, run.budget_usd)),
            time_share: latest
                .as_ref()
                .and_then(|run| share(run.minutes, run.time_cap_minutes.map(f64::from))),
            denials,
            unanswered,
            self_reported: latest
                .as_ref()
                .and_then(|run| run.self_level.as_deref())
                .and_then(ConfidenceLevel::parse),
            uncertain_about: latest
                .as_ref()
                .and_then(|run| run.uncertain_about.as_deref())
                .and_then(|items| serde_json::from_str::<Vec<String>>(items).ok())
                .unwrap_or_default(),
            ..known
        };
        (signals, run_id)
    }

    /// Works out how sure g1t is of a pull request a g1t agent has finished
    /// (`known` holds what its lifecycle already read), and records it on
    /// the pull request and on the run that left it so when it changed.
    pub(crate) async fn assess_confidence(&self, pull: &Pull, known: Signals) -> Result<Confidence> {
        let (signals, run_id) = self.signals(pull, known).await?;
        let (level, reasons) = score(&signals);
        let unchanged = pull.confidence.as_ref().filter(|was| {
            was.level == level
                && was.reasons == reasons
                && was.self_reported == signals.self_reported
                && was.uncertain_about == signals.uncertain_about
                && was.run_id == run_id
        });
        if let Some(was) = unchanged {
            return Ok(was.clone());
        }
        let now = rfc3339(now_ms());
        let confidence = Confidence {
            level,
            reasons,
            self_reported: signals.self_reported,
            uncertain_about: signals.uncertain_about,
            run_id: run_id.clone(),
            assessed_at: now.clone(),
        };
        let detail = serde_json::to_string(&confidence)?;
        self.db
            .prepare(
                "INSERT INTO pull_confidence (pull_id, repo_id, level, detail, updated_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (pull_id) DO UPDATE SET
                   level = excluded.level, detail = excluded.detail, updated_at = excluded.updated_at",
            )
            .bind(&[
                pull.id.as_str().into(),
                pull.repo_id.as_str().into(),
                level.as_str().into(),
                detail.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        if let Some(run_id) = &run_id {
            self.db
                .prepare(
                    "INSERT INTO run_confidence (run_id, pull_id, repo_id, detail, updated_at) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (run_id) DO UPDATE SET detail = excluded.detail, updated_at = excluded.updated_at",
                )
                .bind(&[
                    run_id.as_str().into(),
                    pull.id.as_str().into(),
                    pull.repo_id.as_str().into(),
                    detail.as_str().into(),
                    now.as_str().into(),
                ])?
                .run()
                .await?;
        }
        Ok(confidence)
    }

    /// What the agent of a run said of its own change, with the run's token.
    pub(crate) async fn report_confidence(&self, a: ReportConfidenceArgs) -> Result<Outcome<bool>> {
        let run = self
            .db
            .prepare("SELECT repo_id, pull_id, token_hash FROM agent_runs WHERE id = ?")
            .bind(&[a.run_id.as_str().into()])?
            .first::<RunTicket>(None)
            .await?
            .filter(|run| !a.token.is_empty() && run.token_hash == hash(&a.token));
        let Some(run) = run else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Run not found."));
        };
        let Some(level) = ConfidenceLevel::parse(&a.confidence) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "confidence is high, medium or low."));
        };
        let uncertain = serde_json::to_string(&tidy(&a.uncertain_about))?;
        self.db
            .prepare(
                "INSERT INTO run_confidence (run_id, pull_id, repo_id, self_level, uncertain_about, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (run_id) DO UPDATE SET
                   self_level = excluded.self_level, uncertain_about = excluded.uncertain_about,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                a.run_id.as_str().into(),
                run.pull_id.as_deref().map_or(JsValue::NULL, JsValue::from),
                run.repo_id.as_str().into(),
                level.as_str().into(),
                uncertain.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// How many comments on lines a review by g1t's agent left, which it
    /// records at the moment it finished.
    pub(crate) async fn review_comments(&self, pull: &Pull, finished_at: &str) -> Result<u32> {
        // Read for this request against the latest finished review, which
        // is the one asked about whenever it is asked.
        if let Some(found) = self.prefetched_pull(&pull.id) {
            return Ok(found.first::<NumberRow>(Slot::ReviewComments)?.map_or(0, |row| row.n));
        }
        Ok(self
            .db
            .prepare(
                "SELECT count(*) AS n FROM comments
                 WHERE repo_id = ? AND number = ? AND author_id = ? AND created_at = ? AND path IS NOT NULL",
            )
            .bind(&[
                pull.repo_id.as_str().into(),
                pull.number.into(),
                AGENT_ID.into(),
                finished_at.into(),
            ])?
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n))
    }

    /// Whether a person other than the author approved the change since the
    /// agent last revised it: someone has looked, so a hold is lifted.
    pub(crate) async fn person_approved(&self, pull: &Pull, revised_at: Option<&str>) -> Result<bool> {
        #[derive(Deserialize)]
        struct Latest {
            verdict: String,
            created_at: String,
        }
        #[derive(Deserialize)]
        struct ByAuthor {
            author_id: String,
            verdict: String,
            created_at: String,
        }
        let rows = match self.prefetched_pull(&pull.id) {
            Some(found) => found
                .rows::<ByAuthor>(Slot::Verdicts)?
                .into_iter()
                .rev()
                .filter(|row| {
                    row.author_id != pull.author.id
                        && row.author_id != AGENT_ID
                        && row.author_id != crate::lifecycle::POLICY_ACTOR_ID
                })
                .take(20)
                .map(|row| Latest { verdict: row.verdict, created_at: row.created_at })
                .collect::<Vec<_>>(),
            None => self
                .db
                .prepare(
                    "SELECT verdict, created_at FROM comments
                     WHERE repo_id = ? AND number = ? AND verdict IS NOT NULL
                       AND author_id != ? AND author_id != ? AND author_id != ?
                     ORDER BY id DESC LIMIT 20",
                )
                .bind(&[
                    pull.repo_id.as_str().into(),
                    pull.number.into(),
                    pull.author.id.as_str().into(),
                    AGENT_ID.into(),
                    crate::lifecycle::POLICY_ACTOR_ID.into(),
                ])?
                .all()
                .await?
                .results::<Latest>()?,
        };
        Ok(rows
            .first()
            .is_some_and(|latest| latest.verdict == "approve" && revised_at.is_none_or(|revised| latest.created_at.as_str() > revised)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, lines: u32) -> ChangedFile {
        ChangedFile { path: path.to_owned(), additions: lines, deletions: 0 }
    }

    /// A clean change: required checks pass, approved on the first
    /// review, a test beside the code, small.
    fn clean() -> Signals {
        Signals {
            required: RequiredSignal::Passing,
            agent_review: true,
            review: Some(Verdict::Approve),
            files: vec![file("src/retry.ts", 40), file("src/retry.test.ts", 30)],
            ..Signals::default()
        }
    }

    #[test]
    fn signals_score_as_the_table_says() {
        use ConfidenceLevel::*;
        let cases: Vec<(&str, Signals, ConfidenceLevel, &[&str])> = vec![
            ("clean", clean(), High, &["required checks pass", "approved on first review", "tests added", "small change"]),
            (
                "failing required checks",
                Signals { required: RequiredSignal::Failing, ..clean() },
                Low,
                &["required checks failing"],
            ),
            (
                "required checks not run",
                Signals { required: RequiredSignal::NotRun, ..clean() },
                Medium,
                &["required checks not run"],
            ),
            (
                "required checks still running",
                Signals { required: RequiredSignal::Running, ..clean() },
                Medium,
                &["required checks not finished"],
            ),
            (
                "failed in the merge queue",
                Signals { queue_failed: true, ..clean() },
                Low,
                &["failed in the merge queue"],
            ),
            ("one revision", Signals { revisions: 1, ..clean() }, Medium, &["1 revision"]),
            ("three revisions", Signals { revisions: 3, ..clean() }, Low, &["3 revisions"]),
            (
                "no tests and three revisions",
                Signals { revisions: 3, files: vec![file("src/retry.ts", 40)], ..clean() },
                Low,
                &["3 revisions", "tests not added"],
            ),
            (
                "no tests",
                Signals { files: vec![file("src/retry.ts", 40)], ..clean() },
                Medium,
                &["tests not added"],
            ),
            (
                "docs need no tests",
                Signals { files: vec![file("README.md", 40), file("docs/guide.md", 10)], ..clean() },
                High,
                &["required checks pass", "approved on first review", "small change"],
            ),
            (
                "the reviewer asks for changes",
                Signals { review: Some(Verdict::RequestChanges), ..clean() },
                Low,
                &["reviewer asked for changes"],
            ),
            (
                "a review with much to say",
                Signals { review_comments: 4, ..clean() },
                Medium,
                &["reviewer left 4 comments"],
            ),
            ("no review yet", Signals { review: None, ..clean() }, Medium, &["not reviewed yet"]),
            (
                "no reviewer agent and no required checks",
                Signals { review: None, agent_review: false, required: RequiredSignal::NoneRequired, ..clean() },
                Medium,
                &["branch has no required checks", "no review"],
            ),
            (
                "a large change",
                Signals { files: vec![file("src/a.ts", 900), file("src/a.test.ts", 300)], ..clean() },
                Medium,
                &["large change (1200 lines)"],
            ),
            (
                "outside the planned area",
                Signals {
                    expected: vec!["src/retry.ts".to_owned()],
                    files: vec![file("src/retry.ts", 10), file("lib/billing/charge.ts", 10), file("src/retry.test.ts", 5)],
                    ..clean()
                },
                Medium,
                &["1 file outside the planned area"],
            ),
            (
                "beside the planned files is inside",
                Signals {
                    expected: vec!["src/webhooks/retry.ts".to_owned()],
                    files: vec![file("src/webhooks/backoff.ts", 10), file("src/webhooks/retry.test.ts", 5)],
                    ..clean()
                },
                High,
                &["required checks pass", "approved on first review", "tests added", "small change"],
            ),
            (
                "a CI workflow",
                Signals { files: vec![file(".github/workflows/ci.yml", 5), file("src/a.test.ts", 5)], ..clean() },
                Medium,
                &["touches CI workflows"],
            ),
            (
                "a CI workflow and a revision",
                Signals { revisions: 1, files: vec![file(".github/workflows/ci.yml", 5), file("src/a.test.ts", 5)], ..clean() },
                Low,
                &["touches CI workflows", "1 revision"],
            ),
            ("stopped at a cap", Signals { halted: Some("budget".to_owned()), ..clean() }, Low, &["stopped at its cost cap"]),
            (
                "near its cost cap",
                Signals { budget_share: Some(0.92), ..clean() },
                Medium,
                &["used 92% of its cost cap"],
            ),
            (
                "flaky checks",
                Signals { flaky_checks: true, ..clean() },
                Medium,
                &["checks passed only on a retry"],
            ),
            (
                "unanswered questions",
                Signals { unanswered: 2, ..clean() },
                Medium,
                &["2 questions unanswered"],
            ),
            (
                "guardrails refused a lot",
                Signals { denials: 3, revisions: 1, ..clean() },
                Low,
                &["3 steps refused by guardrails", "1 revision"],
            ),
            (
                "the agent says low",
                Signals { self_reported: Some(Low), ..clean() },
                Low,
                &["agent says low"],
            ),
            (
                "the agent cannot raise it",
                Signals { self_reported: Some(High), revisions: 1, ..clean() },
                Medium,
                &["1 revision"],
            ),
            (
                "the agent's doubts count",
                Signals { self_reported: Some(High), uncertain_about: vec!["the retry limit".to_owned()], ..clean() },
                Medium,
                &["agent unsure about the retry limit"],
            ),
        ];
        for (name, signals, level, reasons) in cases {
            let (got, why) = score(&signals);
            assert_eq!(got, level, "{name}: {why:?}");
            assert_eq!(why, reasons.iter().map(|r| (*r).to_owned()).collect::<Vec<_>>(), "{name}");
        }
    }

    #[test]
    fn reasons_are_few_and_the_worst_come_first() {
        let signals = Signals {
            required: RequiredSignal::Failing,
            revisions: 2,
            files: vec![file("src/a.ts", 600), file(".env.example", 1)],
            unanswered: 1,
            ..clean()
        };
        let (level, reasons) = score(&signals);
        assert_eq!(level, ConfidenceLevel::Low);
        assert_eq!(reasons.len(), MAX_REASONS);
        assert_eq!(reasons[0], "required checks failing");
    }

    #[test]
    fn checks_that_pass_on_a_retry_are_flaky() {
        let runs = |list: &[(&str, &str)]| list.iter().map(|(c, s)| ((*c).to_owned(), (*s).to_owned())).collect::<Vec<_>>();
        assert!(!flaky(&runs(&[("a", "failed"), ("b", "passed")])));
        assert!(flaky(&runs(&[("a", "failed"), ("a", "passed")])));
        assert!(flaky(&runs(&[("a", "errored"), ("b", "passed")])));
        assert!(!flaky(&runs(&[("a", "passed")])));
    }

    #[test]
    fn tests_prose_and_sensitive_paths_are_told_apart() {
        for path in ["src/__tests__/a.ts", "tests/test_api.py", "pkg/api_test.go", "src/a.spec.tsx", "crates/x/tests/it.rs"] {
            assert!(is_test(path), "{path}");
        }
        for path in ["src/testing.ts", "src/contest.rs", "attest/a.rs"] {
            assert!(!is_test(path), "{path}");
        }
        assert!(is_prose("docs/setup.md") && is_prose("README.md") && !is_prose("src/readme.ts"));
        assert_eq!(sensitive(".github/workflows/ci.yml"), Some("CI workflows"));
        assert_eq!(sensitive("apps/web/wrangler.jsonc"), Some("infrastructure"));
        assert_eq!(sensitive("config/.env.production"), Some("secrets"));
        assert_eq!(sensitive("src/env.ts"), None);
    }

    #[test]
    fn doubts_are_tidied() {
        let items = vec!["  the   retry limit ".to_owned(), "the retry limit".to_owned(), String::new(), "x".repeat(400)];
        let tidied = tidy(&items);
        assert_eq!(tidied.len(), 2);
        assert_eq!(tidied[0], "the retry limit");
        assert_eq!(tidied[1].chars().count(), MAX_UNCERTAIN_CHARS);
    }
}
