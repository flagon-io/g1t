//! What the merge queue learns when it combines pull requests, and who it
//! tells.
//!
//! **Blame.** Entries are tested speculatively: entry *i* on the default
//! branch with every entry ahead of it merged in. A combined state that
//! fails while an entry ahead of it is still being tested is *held*: if
//! that entry fails too, the held one is tested again without it and is
//! not blamed; once every entry ahead has passed, the held one answers for
//! the failure. So a broken change is blamed on itself, never on those
//! queued behind it.
//!
//! **Bisection.** An entry whose own checks pass but whose combined state
//! fails breaks *with* some of the entries ahead of it. With more than one
//! ahead, g1t builds smaller combinations, the default branch with half of
//! the suspects and the entry, verifying complements before excluding them, within
//! [`PROBE_BUDGET`] extra builds (built and checked as the queue's states
//! are, by the `merge_group` workflows, and never landed). What is left is
//! reported as `suspects`.
//!
//! **A default branch that moved.** An entry that fails with nothing ahead
//! of it, though its own checks pass on its head, fails on the default
//! branch as it is now: something landed there since it branched. g1t looks
//! up the pull requests merged into the default branch whose commits the
//! entry's history does not hold, newest first and at most [`MAX_LANDED`],
//! and reports them as `landed`. The entry still answers for the failure
//! (it is the one that must adapt); one landed pull request is named as the
//! likely cause.
//!
//! **Telling the work.** The answer goes on the pull request's and its
//! work item's timelines, into the pull request's session, as a decision
//! record (`integration_failure`, tested) and as `integration.failed`. A
//! passing combination is `integration.passed`, and a decision too.
//!
//! **Rejoining.** An entry the queue took out keeps its merge request: once
//! a new commit is pushed and its checks pass, it is merged again (into the
//! queue) as whoever queued it, by the branch's rules as they are then.

use g1t_contracts::decisions::{DecisionConfidence, DecisionKind, FailedCheck, IntegrationFailed, IntegrationPassed};
use g1t_contracts::events::SessionAppended;
use g1t_contracts::repos::{Commit, GetByIdArgs, LogArgs, PathByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::json;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Work, items};
use crate::checks::{hash, new_token};
use crate::decisions::NewDecision;
use crate::queue::{BRANCH_PREFIX, Built, EntryRow};
use crate::rows::ValueRow;

/// The most extra combinations built to narrow down one failure.
pub(crate) const PROBE_BUDGET: u32 = 3;

pub(crate) const RESOLVE_HELD: &str = "UPDATE queue_entries SET state = 'failed', held = NULL, finished_at = ?1
    WHERE id = ?2 AND state = 'testing' AND held = ?3 AND attempt_id IS ?4 RETURNING id AS value";

pub(crate) const REPORT_PROBE: &str = "UPDATE queue_probes SET combined_commit = ?1, token_hash = NULL, dispatching = 1
    WHERE id = ?2 AND state = 'testing' AND token_hash = ?3 RETURNING id AS value";

pub(crate) const OPEN_PROBE: &str = "UPDATE queue_probes SET dispatching = 0, workflow_runs = ?1
    WHERE id = ?2 AND state = 'testing' AND combined_commit = ?3 AND token_hash IS NULL";

pub(crate) const FINISH_PROBE: &str = "UPDATE queue_probes SET state = ?1, token_hash = NULL, error = ?2, finished_at = ?3
    WHERE id = ?4 AND state = ?5 AND state IN ('waiting', 'testing')
      AND token_hash IS ?6 AND combined_commit IS ?7 RETURNING id AS value";

/// A recorded stack, if it is the combination the entry's failure is about:
/// the entries ahead in order, then the entry itself.
pub(crate) fn recorded_stack(stack: Vec<QueueStackItem>, number: u32, ahead: &[u32]) -> Option<Vec<QueueStackItem>> {
    let numbers: Vec<u32> = stack.iter().map(|item| item.number).collect();
    let mut expected = ahead.to_vec();
    expected.push(number);
    (numbers == expected).then_some(stack)
}

/// The most pull requests reported as landed since an entry branched.
pub(crate) const MAX_LANDED: usize = 10;

/// How far back the entry's own history is read to tell what it holds.
const LANDED_HISTORY: u32 = 1000;

/// How many of the latest merged pull requests are looked at.
const LANDED_CANDIDATES: u32 = 50;

/// What kind of failure a combined state had.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FailureKind {
    /// A check failed on it.
    Checks,
    /// The changes did not merge cleanly.
    Conflict,
    /// A required check never reported on it.
    Missing,
    /// It could not be built or checked.
    Build,
}

/// What failed a combined state, as kept while it is held and while the
/// failure is narrowed down.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Failure {
    pub(crate) kind: FailureKind,
    pub(crate) check: FailedCheck,
    #[serde(default)]
    pub(crate) error: Option<String>,
    #[serde(default)]
    pub(crate) conflict_with: Option<u32>,
    #[serde(default)]
    pub(crate) conflicts: Vec<String>,
    #[serde(default)]
    pub(crate) results: Vec<CheckResult>,
    #[serde(default)]
    pub(crate) combined_commit: Option<String>,
}

impl Failure {
    /// What was reported for a state that failed. `unchecked` is set
    /// when the state was built but nothing could check it.
    pub(crate) fn of_report(report: &ReportQueueArgs, unchecked: Option<&[String]>) -> Failure {
        let (kind, check) = if report.conflict_with.is_some() || !report.conflicts.is_empty() {
            (FailureKind::Conflict, check("merge", "conflict", None))
        } else if let Some(missing) = unchecked {
            (FailureKind::Missing, check(&crate::statuses::list(missing), "missing", None))
        } else if report.error.is_some() {
            (FailureKind::Build, check("build", "error", None))
        } else {
            let name = report
                .results
                .iter()
                .find(|result| !result.passed)
                .map_or("checks", |result| result.command.as_str());
            (FailureKind::Checks, check(name, "failure", None))
        };
        Failure {
            kind,
            check,
            error: report.error.clone(),
            conflict_with: report.conflict_with,
            conflicts: report.conflicts.clone(),
            results: report.results.clone(),
            combined_commit: report.combined_commit.clone(),
        }
    }

    /// What its `merge_group` workflows said: the first that failed, or the
    /// required checks that failed or never reported.
    pub(crate) fn of_workflows(
        commit: &str,
        failed: &[String],
        required_failed: &[String],
        missing: &[String],
        error: String,
        url: impl Fn(&str) -> Option<String>,
    ) -> Failure {
        let (kind, check) = match (failed.first(), required_failed.first()) {
            (Some(name), _) | (None, Some(name)) => (FailureKind::Checks, check(name, "failure", url(name))),
            (None, None) => (FailureKind::Missing, check(&crate::statuses::list(missing), "missing", None)),
        };
        Failure {
            kind,
            check,
            error: Some(error),
            conflict_with: None,
            conflicts: Vec::new(),
            results: Vec::new(),
            combined_commit: Some(commit.to_owned()),
        }
    }

    /// The report the queue ejects an entry with.
    pub(crate) fn report(&self, entry_id: &str) -> ReportQueueArgs {
        ReportQueueArgs {
            entry_id: entry_id.to_owned(),
            token: String::new(),
            combined_commit: self.combined_commit.clone(),
            results: self.results.clone(),
            error: self.error.clone(),
            conflict_with: self.conflict_with,
            conflicts: self.conflicts.clone(),
        }
    }
}

fn check(name: &str, conclusion: &str, url: Option<String>) -> FailedCheck {
    FailedCheck {
        name: name.to_owned(),
        conclusion: conclusion.to_owned(),
        url,
    }
}

/// Whether every entry ahead has passed (or landed, and so left the
/// queue). `active` is the queue's entries now, as (number, state).
pub(crate) fn ahead_settled(ahead: &[u32], active: &[(u32, QueueState)]) -> bool {
    ahead.iter().all(|number| {
        active
            .iter()
            .find(|(n, _)| n == number)
            .is_none_or(|(_, state)| *state == QueueState::Passed)
    })
}

/// Who answers for a failed combined state, before any extra builds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    /// These entries ahead are what it fails with; none when it fails by
    /// itself.
    Blame(Vec<u32>),
    /// It fails with some of the entries ahead: narrow them down.
    Bisect,
    /// Nothing is ahead and it passes its checks on its own, yet it fails
    /// on the default branch as it is now: it answers for it, and what
    /// landed there since it branched is looked up.
    BaseMoved,
}

/// Decides who answers for a failure of the entry tested with `ahead`
/// merged in first. `passed_alone`: its own checks pass on its head.
pub(crate) fn plan(ahead: &[u32], failure: &Failure, passed_alone: bool) -> Plan {
    if ahead.is_empty() {
        return if failure.kind == FailureKind::Checks && passed_alone {
            Plan::BaseMoved
        } else {
            Plan::Blame(Vec::new())
        };
    }
    match failure.kind {
        // The build names the entry ahead that changed the same files.
        FailureKind::Conflict => Plan::Blame(failure.conflict_with.filter(|n| ahead.contains(n)).into_iter().collect()),
        // Neither is about how the changes combine.
        FailureKind::Missing | FailureKind::Build => Plan::Blame(Vec::new()),
        FailureKind::Checks if !passed_alone => Plan::Blame(Vec::new()),
        FailureKind::Checks if ahead.len() == 1 => Plan::Blame(ahead.to_vec()),
        FailureKind::Checks => Plan::Bisect,
    }
}

/// A pull request merged into the default branch, as looked at for what
/// landed since an entry branched.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct MergedRow {
    pub(crate) number: u32,
    /// The commit it landed as.
    pub(crate) head_commit: Option<String>,
    pub(crate) merged_at: Option<String>,
}

/// The pull requests among `merged` (newest first) that landed since the
/// entry branched: those whose commit `history`, the entry's own, does not
/// hold. When that history was cut short, `oldest` is the time of its
/// oldest commit, and a pull request merged before it is not counted, as
/// its commit may be further back. Newest first, at most [`MAX_LANDED`].
pub(crate) fn landed_since(merged: &[MergedRow], history: &[Commit], oldest: Option<&str>) -> Vec<u32> {
    merged
        .iter()
        .filter(|pull| {
            pull.head_commit
                .as_deref()
                .is_some_and(|commit| !history.iter().any(|known| known.hash == commit))
        })
        .filter(|pull| match (oldest, pull.merged_at.as_deref()) {
            (Some(oldest), Some(at)) => at >= oldest,
            (Some(_), None) => false,
            (None, _) => true,
        })
        .map(|pull| pull.number)
        .take(MAX_LANDED)
        .collect()
}

/// The suspects to build with the entry next, the first half of them, or
/// none when one is left or the budget is spent.
pub(crate) fn next_probe(suspects: &[u32], builds: u32) -> Option<Vec<u32>> {
    if suspects.len() < 2 || builds >= PROBE_BUDGET {
        return None;
    }
    Some(suspects[..suspects.len().div_ceil(2)].to_vec())
}

/// The suspects left once a build with `tested` and the entry `broke` or
/// passed: those tested when it broke, the others when it passed.
pub(crate) fn narrow(suspects: &[u32], tested: &[u32], broke: bool) -> Vec<u32> {
    suspects
        .iter()
        .filter(|n| tested.contains(n) == broke)
        .copied()
        .collect()
}

/// The pull requests in a combination, `#11, #12 and #14`.
pub(crate) fn numbers(list: &[u32]) -> String {
    let named: Vec<String> = list.iter().map(|n| format!("#{n}")).collect();
    match named.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// What failed, as the start of a sentence.
fn what_failed(check: &FailedCheck) -> String {
    match check.conclusion.as_str() {
        "conflict" => "it did not merge cleanly".to_owned(),
        "missing" => format!("the required {} never reported", check.name),
        "error" if check.name == "build" => "the combined state could not be built".to_owned(),
        _ => format!("`{}` failed", check.name),
    }
}

/// The note on the pull request, as the rest of a sentence starting with
/// `g1t`.
pub(crate) fn pull_note(ahead: &[u32], suspects: &[u32], bisected: bool, landed: &[u32], check: &FailedCheck) -> String {
    let what = what_failed(check);
    let rejoin = "Push a fix: once its checks pass on the new commit, it rejoins the merge queue by itself.";
    if suspects.is_empty() && ahead.is_empty() && !landed.is_empty() {
        return format!(
            "traced its merge queue failure to the default branch as it is now: {what} with this change merged into it, though this passes its checks on its own. Since this branched, {}. Bring it up to date with the default branch, fix what breaks, and push. {rejoin}",
            landed_clause(landed),
        );
    }
    if suspects.is_empty() {
        let on = if ahead.is_empty() {
            "on the default branch as it is now".to_owned()
        } else {
            format!("with {} merged in ahead of it", numbers(ahead))
        };
        return format!("observed a merge queue failure for this change: {what} {on}. No other change has been isolated as the cause. {rejoin}");
    }
    let narrowed = if bisected && suspects.len() < ahead.len() {
        format!(" (narrowed down from {} by building smaller combinations)", numbers(ahead))
    } else {
        String::new()
    };
    format!(
        "traced its merge queue failure to how it combines with {}{narrowed}: {what} when they were merged together, though this passes its checks on its own. Bring it up to date with the default branch once {} {} landed, fix what breaks, and push. {rejoin}",
        numbers(suspects),
        numbers(suspects),
        if suspects.len() == 1 { "has" } else { "have" },
    )
}

/// What landed on the default branch since the entry branched, as a
/// clause: one is named as the likely cause.
fn landed_clause(landed: &[u32]) -> String {
    match landed {
        [one] => format!("#{one} landed and is the likely cause"),
        _ => format!("{} landed and may be what it conflicts with", numbers(landed)),
    }
}

/// The note on its work item, and the one-line summary of the decision.
pub(crate) fn summary(number: u32, suspects: &[u32], landed: &[u32], check: &FailedCheck) -> String {
    let what = what_failed(check);
    if suspects.is_empty() && !landed.is_empty() {
        format!(
            "#{number} failed in the merge queue on the default branch as it is now: {what}, though #{number} passes its checks on its own; since it branched, {}.",
            landed_clause(landed),
        )
    } else if suspects.is_empty() {
        format!("#{number} failed in the merge queue: {what}. No other change has been isolated as the cause.")
    } else {
        format!("#{number} failed in the merge queue together with {}: {what} when they were combined.", numbers(suspects))
    }
}

/// What the queue is working out about a failed entry, kept on it as
/// JSON while smaller combinations are built.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Diagnosis {
    pub(crate) base_commit: String,
    /// The entries ahead, in queue order, then the entry: each as it was
    /// tested.
    pub(crate) stack: Vec<QueueStackItem>,
    pub(crate) suspects: Vec<u32>,
    pub(crate) builds: u32,
    pub(crate) failure: Failure,
    #[serde(default)]
    pub(crate) done: bool,
    /// A passing subset does not prove its complement fails. Test that
    /// complement before discarding any member of the last failing set.
    #[serde(default)]
    pub(crate) complement: Option<Vec<u32>>,
}

impl Diagnosis {
    fn next_subset(&self) -> Option<Vec<u32>> {
        if self.done || self.builds >= PROBE_BUDGET {
            None
        } else {
            self.complement.clone().or_else(|| next_probe(&self.suspects, self.builds))
        }
    }

    fn observed(&mut self, tested: &[u32], broke: bool) {
        self.builds += 1;
        if broke {
            self.suspects = narrow(&self.suspects, tested, true);
            self.complement = None;
        } else if self.complement.is_some() {
            // Both halves pass: retain the failing combination. This may
            // be a multi-way interaction or a non-deterministic failure.
            self.done = true;
            self.complement = None;
        } else {
            self.complement = Some(narrow(&self.suspects, tested, false));
        }
    }
}

/// How one smaller combination came out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeResult {
    /// The entry broke with these suspects.
    Broke,
    /// It passed with them.
    Passed,
    /// It could not be built or checked: narrowing stops here.
    Stopped,
}

#[derive(Clone, Deserialize)]
pub(crate) struct ProbeRow {
    id: String,
    repo_id: String,
    entry_id: String,
    number: u32,
    subset: String,
    state: String,
    #[serde(default)]
    tested_at: Option<String>,
    #[serde(default)]
    token_hash: Option<String>,
    #[serde(default)]
    combined_commit: Option<String>,
    #[serde(default)]
    workflow_runs: u32,
}

impl ProbeRow {
    fn subset(&self) -> Vec<u32> {
        serde_json::from_str(&self.subset).unwrap_or_default()
    }

    fn branch(&self) -> String {
        format!("{BRANCH_PREFIX}{}", self.id)
    }
}

impl Work {
    // --- Blame ---------------------------------------------------------------

    /// Whether an entry ahead of `row` has not passed yet.
    pub(crate) async fn ahead_unsettled(&self, row: &EntryRow) -> Result<bool> {
        let ahead = row.ahead();
        if ahead.is_empty() {
            return Ok(false);
        }
        let active = self.entries(&row.repo_id, true).await?;
        let states: Vec<(u32, QueueState)> = active.iter().map(|other| (other.number, other.state())).collect();
        Ok(!ahead_settled(&ahead, &states))
    }

    /// Blames each held entry whose entries ahead have all passed by now:
    /// it leaves the queue, and the failure is worked out.
    pub(crate) async fn resolve_held(&self, repo_id: &str) -> Result<()> {
        for _ in 0..16 {
            let active = self.entries(repo_id, true).await?;
            let states: Vec<(u32, QueueState)> = active.iter().map(|row| (row.number, row.state())).collect();
            let Some(row) = active
                .iter()
                .find(|row| row.held.is_some() && ahead_settled(&row.ahead(), &states))
            else {
                return Ok(());
            };
            let claimed = self
                .db
                .prepare(RESOLVE_HELD)
                .bind(&[
                    rfc3339(now_ms()).into(), row.id.as_str().into(),
                    row.held.as_deref().map_or(JsValue::NULL, JsValue::from),
                    row.attempt_id.as_deref().map_or(JsValue::NULL, JsValue::from),
                ])?
                .first::<ValueRow>(None)
                .await?;
            if claimed.is_none() {
                continue;
            }
            let Some(failure) = row.held.as_deref().and_then(|held| serde_json::from_str::<Failure>(held).ok()) else {
                continue;
            };
            self.eject(row, &failure.report(&row.id)).await?;
            self.diagnose(row, failure).await?;
        }
        Ok(())
    }

    /// Whether the entry's own checks pass on the commit it was queued at.
    async fn passed_alone(&self, row: &EntryRow) -> Result<bool> {
        let facts = self.facts(&row.repo_id, row.head_commit.as_deref()).await?;
        Ok(facts.passed())
    }

    /// Works out who answers for an entry's failure, after it left the
    /// queue: at once, or by building smaller combinations first.
    pub(crate) async fn diagnose(&self, row: &EntryRow, failure: Failure) -> Result<()> {
        let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
            return Ok(());
        };
        let ahead = row.ahead();
        // Only a check failure asks whether it fails alone.
        let passed_alone = failure.kind != FailureKind::Checks || self.passed_alone(row).await?;
        match plan(&ahead, &failure, passed_alone) {
            Plan::Blame(suspects) => self.integration_failed(row, &pull, &failure, false, &suspects, &[]).await,
            Plan::BaseMoved => {
                // What landed is context: without it, the failure is still told.
                let landed = self.landed_since_branched(row, &pull).await.unwrap_or_default();
                self.integration_failed(row, &pull, &failure, false, &[], &landed).await
            }
            Plan::Bisect => {
                let Some(stack) = Self::tested_stack(row, &pull, &ahead) else {
                    // What was tested can no longer be found: say what is known.
                    return self.integration_failed(row, &pull, &failure, false, &ahead, &[]).await;
                };
                let diagnosis = Diagnosis {
                    base_commit: row.base_commit.clone().unwrap_or_default(),
                    stack,
                    suspects: ahead,
                    builds: 0,
                    failure,
                    done: false,
                    complement: None,
                };
                self.go_on(row, None, diagnosis).await
            }
        }
    }

    /// The pull requests merged into the default branch since `pull`'s
    /// entry branched from it and before it was tested, newest first: the
    /// latest merged ones whose commits the entry's history does not hold.
    async fn landed_since_branched(&self, row: &EntryRow, pull: &Pull) -> Result<Vec<u32>> {
        let (Some(head), Some(tested_at)) = (row.head_commit.clone(), row.tested_at.clone()) else {
            return Ok(Vec::new());
        };
        let viewer = Some(pull.owner().clone());
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs { id: row.repo_id.clone(), viewer: viewer.clone() },
        )
        .await?;
        let Outcome::Ok(repo) = repo else { return Ok(Vec::new()) };
        let path = pull.source_path(&RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        });
        let merged = async {
            self.db
                .prepare(
                    "SELECT number, head_commit, merged_at FROM pulls
                     WHERE repo_id = ? AND status = 'merged' AND id != ? AND merged_at <= ?
                       AND (base_branch IS NULL OR base_branch = '' OR base_branch = ?)
                     ORDER BY merged_at DESC LIMIT ?",
                )
                .bind(&[
                    row.repo_id.as_str().into(),
                    pull.id.as_str().into(),
                    tested_at.as_str().into(),
                    repo.default_branch.as_str().into(),
                    LANDED_CANDIDATES.into(),
                ])?
                .all()
                .await?
                .results::<MergedRow>()
        };
        let log = LogArgs { path, viewer, git_ref: Some(head), limit: LANDED_HISTORY };
        let history = g1t_kit::call::<_, Outcome<Vec<Commit>>>(&self.repos, "log", &log);
        let (merged, history) = futures_util::future::try_join(merged, history).await?;
        let Outcome::Ok(history) = history else { return Ok(Vec::new()) };
        // A history cut short holds only what is newer than its oldest commit.
        let oldest = (history.len() >= LANDED_HISTORY as usize)
            .then(|| history.iter().map(|commit| commit.authored_at.as_str()).min())
            .flatten();
        Ok(landed_since(&merged, &history, oldest))
    }

    /// Each entry ahead and then `row`'s, exactly as this attempt built
    /// them: recorded when it was claimed (queue.rs). Never rebuilt from the
    /// pull requests' heads now, which may have moved on since.
    fn tested_stack(row: &EntryRow, pull: &Pull, ahead: &[u32]) -> Option<Vec<QueueStackItem>> {
        recorded_stack(row.tested_stack()?, pull.number, ahead)
    }

    /// Builds the next smaller combination, or reports what is known when
    /// there is none to build. `before` is the diagnosis as last kept, so
    /// that only one result moves it on.
    async fn go_on(&self, row: &EntryRow, before: Option<&str>, mut diagnosis: Diagnosis) -> Result<()> {
        let subset = diagnosis.next_subset();
        diagnosis.done = subset.is_none();
        if !self.keep_diagnosis(&row.id, before, &diagnosis).await? {
            return Ok(());
        }
        let Some(subset) = subset else {
            let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
                return Ok(());
            };
            return self
                .integration_failed(row, &pull, &diagnosis.failure, narrowed(&diagnosis), &diagnosis.suspects, &[])
                .await;
        };
        let now = now_ms();
        self.db
            .prepare(
                "INSERT INTO queue_probes (id, repo_id, entry_id, number, subset, state, created_at)
                 VALUES (?, ?, ?, ?, ?, 'waiting', ?)",
            )
            .bind(&[
                new_id("qpr", now).into(),
                row.repo_id.as_str().into(),
                row.id.as_str().into(),
                row.number.into(),
                serde_json::to_string(&subset)?.into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        self.changed(&row.repo_id).await
    }

    /// Keeps the diagnosis on its entry if it is still as `before` was.
    /// Whether it was kept.
    async fn keep_diagnosis(&self, entry_id: &str, before: Option<&str>, diagnosis: &Diagnosis) -> Result<bool> {
        let kept = self
            .db
            .prepare("UPDATE queue_entries SET diagnosis = ? WHERE id = ? AND diagnosis IS ? RETURNING id AS value")
            .bind(&[
                serde_json::to_string(diagnosis)?.into(),
                entry_id.into(),
                before.map_or(JsValue::NULL, JsValue::from),
            ])?
            .first::<ValueRow>(None)
            .await?;
        Ok(kept.is_some())
    }

    // --- Smaller combinations -------------------------------------------------

    /// Builds each smaller combination waiting to be built, and ends any
    /// that took too long.
    pub(crate) async fn build_probes(&self, repo_id: &str) -> Result<()> {
        let probes = self
            .db
            .prepare("SELECT * FROM queue_probes WHERE repo_id = ? AND state IN ('waiting', 'testing')")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<ProbeRow>()?;
        if probes.is_empty() {
            return Ok(());
        }
        let rule = self.queue_rule(repo_id).await?;
        let stale = rfc3339(now_ms().saturating_sub(u64::from(rule.check_response_timeout_minutes.max(1)) * 60 * 1000));
        for probe in probes {
            if probe.state == "testing" {
                if probe.tested_at.as_deref().is_none_or(|at| at < stale.as_str()) {
                    self.probe_result(&probe, ProbeResult::Stopped, Some("It took too long.")).await?;
                }
                continue;
            }
            self.build_probe(&probe).await?;
        }
        Ok(())
    }

    /// Builds a smaller combination as the queue builds a state: from the
    /// base it was tested on, each entry landed by its method on the one
    /// before, every step pushed to the probe's branch; then reports it.
    async fn build_probe(&self, probe: &ProbeRow) -> Result<()> {
        let found = match self.entry_by_id(&probe.entry_id).await? {
            Some(row) => {
                let diagnosis = row
                    .diagnosis
                    .as_deref()
                    .and_then(|text| serde_json::from_str::<Diagnosis>(text).ok())
                    .filter(|diagnosis| !diagnosis.done);
                let pull = self.pull_by_id(&row.pull_id).await?;
                match (diagnosis, pull, row.actor()) {
                    (Some(diagnosis), Some(pull), Some(actor)) => Some((diagnosis, pull, actor)),
                    _ => None,
                }
            }
            None => None,
        };
        // Nothing is waiting on it any more.
        let Some((diagnosis, _, actor)) = found else {
            self.probe_result(probe, ProbeResult::Stopped, Some("Its failure was already reported.")).await?;
            return Ok(());
        };
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: probe.repo_id.clone(),
                viewer: Some(actor.clone()),
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            self.probe_result(probe, ProbeResult::Stopped, Some("The repository is archived.")).await?;
            return Ok(());
        };
        let subset = probe.subset();
        let mut stack = Vec::new();
        for item in &diagnosis.stack {
            if item.number != probe.number && !subset.contains(&item.number) {
                continue;
            }
            let mut item = item.clone();
            // A pull request that landed since may have lost its branch;
            // its commit is in the default branch's history now.
            if let Some(other) = self.pull(&repo.id, item.number).await?
                && other.status == PullStatus::Merged
            {
                item.source = RepoPath {
                    namespace: repo.namespace.clone(),
                    name: repo.name.clone(),
                };
                item.branch = repo.default_branch.clone();
            }
            if item.branch.is_empty() {
                item.branch = repo.default_branch.clone();
            }
            stack.push(item);
        }
        let token = new_token();
        let claimed = self
            .db
            .prepare(
                "UPDATE queue_probes SET state = 'testing', token_hash = ?, tested_at = ?
                 WHERE id = ? AND state = 'waiting' RETURNING id AS value",
            )
            .bind(&[hash(&token).into(), rfc3339(now_ms()).into(), probe.id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        if claimed.is_none() {
            return Ok(());
        }
        let sign_off = self.settings(&repo.id).await?.require_web_commit_sign_off;
        let mut report = ReportQueueArgs {
            entry_id: probe.id.clone(),
            token,
            combined_commit: None,
            results: Vec::new(),
            error: None,
            conflict_with: None,
            conflicts: Vec::new(),
        };
        let mut onto = diagnosis.base_commit.clone();
        for item in &stack {
            match self.build_step(&repo, &onto, item, &probe.branch(), &actor, sign_off).await? {
                Built::State(commit) => onto = commit,
                Built::Conflict { message, paths } => {
                    report.error = Some(message);
                    report.conflicts = paths;
                    break;
                }
                // A probe that cannot be built, for now or at all, stops:
                // it narrows nothing down either way.
                Built::Failed(message) | Built::Unavailable(message) => {
                    report.error = Some(message);
                    break;
                }
            }
        }
        if report.error.is_none() {
            report.combined_commit = Some(onto);
        }
        self.report_probe(report).await?;
        Ok(())
    }

    /// The result of building a smaller combination: built, it waits for
    /// its `merge_group` workflows as a queue state does.
    pub(crate) async fn report_probe(&self, a: ReportQueueArgs) -> Result<Outcome<QueueState>> {
        let probe = self
            .db
            .prepare("SELECT * FROM queue_probes WHERE id = ? AND token_hash = ?")
            .bind(&[a.entry_id.as_str().into(), hash(&a.token).into()])?
            .first::<ProbeRow>(None)
            .await?;
        let Some(mut probe) = probe else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such queue entry."));
        };
        if probe.state != "testing" {
            return Ok(Outcome::fail(FailureCode::Conflict, "This state is no longer being tested."));
        }
        if a.conflict_with.is_some() || !a.conflicts.is_empty() {
            self.probe_result(&probe, ProbeResult::Broke, None).await?;
            return Ok(Outcome::Ok(QueueState::Failed));
        }
        let built = a.error.is_none() && a.results.iter().all(|result| result.passed);
        let Some(commit) = a.combined_commit.as_deref().filter(|_| built) else {
            self.probe_result(&probe, ProbeResult::Stopped, a.error.as_deref()).await?;
            return Ok(Outcome::Ok(QueueState::Failed));
        };
        let Some(row) = self.entry_by_id(&probe.entry_id).await? else {
            return Ok(Outcome::Ok(QueueState::Removed));
        };
        let base = row
            .diagnosis
            .as_deref()
            .and_then(|text| serde_json::from_str::<Diagnosis>(text).ok())
            .map(|diagnosis| diagnosis.base_commit);
        let accepted = self.db
            .prepare(REPORT_PROBE)
            .bind(&[commit.into(), probe.id.as_str().into(), hash(&a.token).into()])?
            .first::<ValueRow>(None)
            .await?;
        if accepted.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This probe attempt is no longer being tested."));
        }
        probe.token_hash = None;
        probe.combined_commit = Some(commit.to_owned());
        let runs = self
            .run_merge_group(&probe.repo_id, &probe.id, &probe.branch(), base.as_deref(), probe.number, &probe.subset(), commit)
            .await?;
        if runs == 0 {
            self.probe_result(&probe, ProbeResult::Stopped, Some("No workflow runs on merge_group events.")).await?;
            return Ok(Outcome::Ok(QueueState::Failed));
        }
        self.db.prepare(OPEN_PROBE)
            .bind(&[runs.into(), probe.id.as_str().into(), commit.into()])?.run().await?;
        // A run may have finished while dispatching was fenced.
        self.probe_finished(&probe.repo_id, commit).await?;
        Ok(Outcome::Ok(QueueState::Testing))
    }

    /// The `merge_group` workflows on a smaller combination finished.
    /// Whether `commit` was one.
    pub(crate) async fn probe_finished(&self, repo_id: &str, commit: &str) -> Result<bool> {
        let probe = self
            .db
            .prepare(
                "SELECT * FROM queue_probes
                 WHERE repo_id = ? AND combined_commit = ? AND state = 'testing' AND token_hash IS NULL AND dispatching = 0",
            )
            .bind(&[repo_id.into(), commit.into()])?
            .first::<ProbeRow>(None)
            .await?;
        let Some(probe) = probe else { return Ok(false) };
        // Judged on its own runs only: the same commit may have been built
        // before, by the queue or another probe.
        let attempt = crate::statuses::Attempt {
            sha: commit,
            head_ref: format!("refs/heads/{}", probe.branch()),
            since: probe.tested_at.as_deref(),
            runs: probe.workflow_runs,
        };
        let facts = self.attempt_facts(repo_id, &attempt).await?;
        if !facts.pending.is_empty() {
            return Ok(false);
        }
        let result = if facts.passed() { ProbeResult::Passed } else { ProbeResult::Broke };
        self.probe_result(&probe, result, None).await?;
        Ok(true)
    }

    /// Narrows the suspects by how a smaller combination came out, and
    /// builds the next one or reports.
    async fn probe_result(&self, probe: &ProbeRow, result: ProbeResult, error: Option<&str>) -> Result<()> {
        let state = match result {
            ProbeResult::Broke => "failed",
            ProbeResult::Passed => "passed",
            ProbeResult::Stopped => "stopped",
        };
        let claimed = self
            .db
            .prepare(FINISH_PROBE)
            .bind(&[
                state.into(),
                error.map_or(JsValue::NULL, JsValue::from),
                rfc3339(now_ms()).into(),
                probe.id.as_str().into(),
                probe.state.as_str().into(),
                probe.token_hash.as_deref().map_or(JsValue::NULL, JsValue::from),
                probe.combined_commit.as_deref().map_or(JsValue::NULL, JsValue::from),
            ])?
            .first::<ValueRow>(None)
            .await?;
        if claimed.is_none() {
            return Ok(());
        }
        self.drop_branch_named(&probe.repo_id, &probe.branch()).await;
        let Some(row) = self.entry_by_id(&probe.entry_id).await? else {
            return Ok(());
        };
        let Some(before) = row.diagnosis.clone() else { return Ok(()) };
        let Ok(mut diagnosis) = serde_json::from_str::<Diagnosis>(&before) else {
            return Ok(());
        };
        if diagnosis.done {
            return Ok(());
        }
        match result {
            ProbeResult::Stopped => {
                // Nothing more can be learned: report what is known.
                diagnosis.done = true;
                if !self.keep_diagnosis(&row.id, Some(&before), &diagnosis).await? {
                    return Ok(());
                }
                let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
                    return Ok(());
                };
                self.integration_failed(&row, &pull, &diagnosis.failure, narrowed(&diagnosis), &diagnosis.suspects, &[])
                    .await
            }
            ProbeResult::Broke | ProbeResult::Passed => {
                diagnosis.observed(&probe.subset(), result == ProbeResult::Broke);
                self.go_on(&row, Some(&before), diagnosis).await
            }
        }
    }

    // --- Telling the work -------------------------------------------------------

    /// Tells the pull request, its work item, its session and anyone following
    /// that its combined state failed, and who it failed with. `landed`:
    /// with nothing ahead, the pull requests merged into the default branch
    /// since it branched.
    pub(crate) async fn integration_failed(
        &self,
        row: &EntryRow,
        pull: &Pull,
        failure: &Failure,
        bisected: bool,
        suspects: &[u32],
        landed: &[u32],
    ) -> Result<()> {
        let ahead = row.ahead();
        let mut combination = ahead.clone();
        combination.push(pull.number);
        let g1t = ("g1t", "g1t");
        let note = pull_note(&ahead, suspects, bisected, landed, &failure.check);
        self.note(&row.repo_id, pull.number, g1t, &note).await?;
        let summary = summary(pull.number, suspects, landed, &failure.check);
        let item = self.pull_item_id(&pull.id).await?;
        if let Some(item) = &item {
            items::note(self, item, g1t, &format!("noted: {summary}")).await?;
        }
        self.session_note(pull, &format!("g1t {note}")).await?;
        self.keep_decision_quietly(
            &row.repo_id,
            NewDecision {
                item,
                pull: Some(pull.number),
                session_id: None,
                actor: None,
                kind: DecisionKind::IntegrationFailure,
                confidence: DecisionConfidence::Tested,
                summary,
                evidence: json!({
                    "commit": failure.combined_commit,
                    "check": failure.check,
                    "combination": combination,
                    "other_pulls": ahead,
                    "suspects": suspects,
                    "bisected": bisected,
                    "landed": landed,
                }),
            },
        )
        .await;
        // Named by the attempt and the commit it tested, so a result told
        // twice reaches each session once.
        let key = format!("{}:{}:{}", row.id, row.attempt_id.as_deref().unwrap_or(""), failure.combined_commit.as_deref().unwrap_or(""));
        let data = serde_json::to_value(IntegrationFailed {
            repo_id: row.repo_id.clone(),
            pull_id: pull.id.clone(),
            number: pull.number,
            pull: pull.number,
            item: pull.item,
            combination,
            check: failure.check.clone(),
            bisected,
            suspects: suspects.to_vec(),
            other_pulls: ahead,
            landed: landed.to_vec(),
            commit: failure.combined_commit.clone(),
        })?;
        self.publish_keyed("integration.failed", &row.repo_id, None, data, &key).await
    }

    /// Tells anyone following that an entry's combined state passed.
    pub(crate) async fn integration_passed(&self, row: &EntryRow, commit: Option<&str>) -> Result<()> {
        let Some(pull) = self.pull_by_id(&row.pull_id).await? else {
            return Ok(());
        };
        let ahead = row.ahead();
        let mut combination = ahead.clone();
        combination.push(pull.number);
        let summary = if ahead.is_empty() {
            format!("#{} passed in the merge queue on the default branch as it is.", pull.number)
        } else {
            format!("#{} passed in the merge queue combined with {}.", pull.number, numbers(&ahead))
        };
        self.keep_decision_quietly(
            &row.repo_id,
            NewDecision {
                item: self.pull_item_id(&pull.id).await?,
                pull: Some(pull.number),
                session_id: None,
                actor: None,
                kind: DecisionKind::IntegrationPassed,
                confidence: DecisionConfidence::Tested,
                summary,
                evidence: json!({ "commit": commit, "combination": combination, "other_pulls": ahead }),
            },
        )
        .await;
        let key = format!("{}:{}:{}", row.id, row.attempt_id.as_deref().unwrap_or(""), commit.unwrap_or(""));
        let data = serde_json::to_value(IntegrationPassed {
            repo_id: row.repo_id.clone(),
            pull_id: pull.id.clone(),
            number: pull.number,
            pull: pull.number,
            item: pull.item,
            combination,
            commit: commit.map(str::to_owned),
        })?;
        self.publish_keyed("integration.passed", &row.repo_id, None, data, &key).await
    }

    /// Appends a note by g1t to a pull request's session, and to the
    /// harness sessions working on it or its work item (coordination/).
    pub(crate) async fn session_note(&self, pull: &Pull, text: &str) -> Result<()> {
        self.note_sessions(pull, text).await;
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO session_entries (pull_id, seq, kind, text, tool, \"commit\", at)
                 SELECT ?, COALESCE(MAX(seq), 0) + 1, 'note', ?, NULL, ?, ?
                 FROM session_entries WHERE pull_id = ?",
            )
            .bind(&[
                pull.id.as_str().into(),
                text.into(),
                pull.head_commit.as_deref().map_or(JsValue::NULL, JsValue::from),
                now.as_str().into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.publish_as(
            "session.appended",
            &pull.repo_id,
            None,
            SessionAppended {
                pull_id: pull.id.clone(),
                repo_id: pull.repo_id.clone(),
                number: pull.number,
                count: 1,
            },
        )
        .await
    }

    // --- Rejoining ---------------------------------------------------------------

    /// Puts a pull request the queue took out back in, once a new commit's
    /// checks pass: merged again as whoever queued it, so the branch's
    /// rules are checked as they are now. A refusal is noted.
    pub(crate) async fn requeue_if_fixed(&self, pull_id: &str, sha: &str) -> Result<()> {
        let row = self
            .db
            .prepare(
                "SELECT * FROM queue_entries WHERE pull_id = ? AND requeue = 1 AND state = 'failed'
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&[pull_id.into()])?
            .first::<EntryRow>(None)
            .await?;
        let Some(row) = row else { return Ok(()) };
        // The commit that failed: nothing has been fixed yet.
        if row.head_commit.as_deref() == Some(sha) {
            return Ok(());
        }
        let claimed = self
            .db
            .prepare("UPDATE queue_entries SET requeue = 0 WHERE id = ? AND requeue = 1 RETURNING id AS value")
            .bind(&[row.id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        let (Some(_), Some(actor), Some(pull)) = (claimed, row.actor(), self.pull_by_id(pull_id).await?) else {
            return Ok(());
        };
        if pull.status != PullStatus::Open || pull.head_commit.as_deref() != Some(sha) {
            return Ok(());
        }
        let path: Option<RepoPath> = g1t_kit::call(
            &self.repos,
            "path_by_id",
            &PathByIdArgs { id: pull.repo_id.clone() },
        )
        .await?;
        let Some(repo) = path else { return Ok(()) };
        let merged = self
            .merge_pull(PullActionArgs {
                actor,
                repo,
                number: pull.number,
                summary: String::new(),
                keep_item_open: row.keep_item_open != 0,
                ignore_checks: false,
                bypass_rules: false,
                merge_method: None,
                commit_title: None,
                commit_message: None,
                expected_head: None,
                delete_branch: None,
                update_method: None,
            })
            .await?;
        let short = &sha[..sha.len().min(12)];
        let text = match merged {
            Outcome::Ok(_) => format!("put this back in the merge queue: its checks pass on {short}, pushed after it was taken out"),
            Outcome::Fail(failure) => format!(
                "could not put this back in the merge queue though its checks pass on {short}: {} Merge it again when that is dealt with.",
                failure.message
            ),
        };
        self.note(&pull.repo_id, pull.number, ("g1t", "g1t"), &text).await
    }

    async fn entry_by_id(&self, id: &str) -> Result<Option<EntryRow>> {
        self.db
            .prepare("SELECT * FROM queue_entries WHERE id = ?")
            .bind(&[id.into()])?
            .first::<EntryRow>(None)
            .await
    }
}

/// Whether the suspects were narrowed by any build.
fn narrowed(diagnosis: &Diagnosis) -> bool {
    let ahead = diagnosis.stack.len().saturating_sub(1);
    diagnosis.suspects.len() < ahead
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(kind: FailureKind) -> Failure {
        Failure {
            kind,
            check: check("CI / merge_group", "failure", Some("https://g1t.sh/a/b/actions/runs/1".into())),
            error: None,
            conflict_with: None,
            conflicts: Vec::new(),
            results: Vec::new(),
            combined_commit: Some("c0ffee".into()),
        }
    }

    #[test]
    fn a_failure_waits_for_the_entries_ahead_of_it() {
        use QueueState::*;
        let active = [(11, Passed), (12, Testing), (14, Testing)];
        assert!(!ahead_settled(&[11, 12], &active), "#12 is still being tested");
        assert!(ahead_settled(&[11], &active));
        // #10 landed and left the queue.
        assert!(ahead_settled(&[10, 11], &active));
        assert!(ahead_settled(&[], &active));
    }

    #[test]
    fn who_answers_for_a_failure() {
        let checks = failure(FailureKind::Checks);
        // Tested alone on the default branch, failing there though it
        // passes on its own: the default branch moved under it.
        assert_eq!(plan(&[], &checks, true), Plan::BaseMoved);
        // Alone, and failing on its own too: it is the cause.
        assert_eq!(plan(&[], &checks, false), Plan::Blame(vec![]));
        // Alone, but not a check failure: nothing to look up.
        for kind in [FailureKind::Conflict, FailureKind::Missing, FailureKind::Build] {
            assert_eq!(plan(&[], &failure(kind), true), Plan::Blame(vec![]), "{kind:?}");
        }
        // Its own checks fail too: still the cause.
        assert_eq!(plan(&[11, 12], &checks, false), Plan::Blame(vec![]));
        // One entry ahead: that one, without building anything.
        assert_eq!(plan(&[11], &checks, true), Plan::Blame(vec![11]));
        // More: narrow them down.
        assert_eq!(plan(&[11, 12, 13], &checks, true), Plan::Bisect);
        // A conflict names the entry it collided with.
        let conflict = Failure { conflict_with: Some(12), ..failure(FailureKind::Conflict) };
        assert_eq!(plan(&[11, 12], &conflict, true), Plan::Blame(vec![12]));
        // A required check that never reports is not about combining.
        assert_eq!(plan(&[11, 12], &failure(FailureKind::Missing), true), Plan::Blame(vec![]));
        assert_eq!(plan(&[11, 12], &failure(FailureKind::Build), true), Plan::Blame(vec![]));
    }

    /// Plays a bisection through against `breaks`, the suspects the entry
    /// really fails with: how many builds it took and what was left.
    fn bisect(ahead: &[u32], breaks: u32) -> (u32, Vec<u32>) {
        let mut diagnosis = diagnosis(ahead);
        while let Some(tested) = diagnosis.next_subset() {
            diagnosis.observed(&tested, tested.contains(&breaks));
        }
        (diagnosis.builds, diagnosis.suspects)
    }

    fn diagnosis(ahead: &[u32]) -> Diagnosis {
        Diagnosis { base_commit: "base".into(), stack: vec![], suspects: ahead.to_vec(), builds: 0,
            failure: failure(FailureKind::Checks), done: false, complement: None }
    }

    #[test]
    fn passing_halves_do_not_falsely_identify_a_single_cause() {
        let mut diagnosis = diagnosis(&[11, 12]);
        assert_eq!(diagnosis.next_subset(), Some(vec![11]));
        diagnosis.observed(&[11], false);
        assert_eq!(diagnosis.suspects, [11, 12]);
        assert_eq!(diagnosis.next_subset(), Some(vec![12]));
        diagnosis.observed(&[12], false);
        assert_eq!(diagnosis.next_subset(), None);
        assert_eq!(diagnosis.suspects, [11, 12]);
    }

    #[test]
    fn exhausted_budget_keeps_the_last_demonstrably_failing_combination() {
        let mut diagnosis = diagnosis(&[11, 12]);
        diagnosis.builds = PROBE_BUDGET - 1;
        diagnosis.observed(&[11], false);
        assert_eq!(diagnosis.next_subset(), None);
        assert_eq!(diagnosis.suspects, [11, 12]);
    }

    #[test]
    fn bisection_halves_the_suspects_within_the_budget() {
        assert_eq!(next_probe(&[11, 12, 13], 0), Some(vec![11, 12]));
        assert_eq!(next_probe(&[11, 12], 0), Some(vec![11]));
        assert_eq!(next_probe(&[11], 0), None);
        assert_eq!(next_probe(&[11, 12], PROBE_BUDGET), None);
        assert_eq!(narrow(&[11, 12, 13], &[11, 12], true), vec![11, 12]);
        assert_eq!(narrow(&[11, 12, 13], &[11, 12], false), vec![13]);
        // Complementary probes also consume the bounded budget.
        assert_eq!(bisect(&[11, 12, 13], 11), (2, vec![11]));
        assert_eq!(bisect(&[11, 12, 13], 12), (3, vec![12]));
        assert_eq!(bisect(&[11, 12, 13], 13), (2, vec![13]));
        // Never exclude the cause merely to fit the budget.
        let eight: Vec<u32> = (1..=8).collect();
        for breaks in 1..=8 {
            let (builds, suspects) = bisect(&eight, breaks);
            assert!(builds <= PROBE_BUDGET);
            assert!(suspects.contains(&breaks));
        }
        // More than the budget can narrow to one: what is left is reported.
        let twelve: Vec<u32> = (1..=12).collect();
        let (builds, left) = bisect(&twelve, 1);
        assert_eq!(builds, PROBE_BUDGET);
        assert_eq!(left, vec![1, 2]);
    }

    #[test]
    fn the_notes_name_the_other_changes_and_the_check() {
        let check = failure(FailureKind::Checks).check;
        let note = pull_note(&[11, 12, 13], &[12], true, &[], &check);
        assert!(note.starts_with("traced its merge queue failure to how it combines with #12 (narrowed down from #11, #12 and #13"), "{note}");
        assert!(note.contains("`CI / merge_group` failed"));
        assert!(note.contains("once #12 has landed"));
        let own = pull_note(&[], &[], false, &[], &check);
        assert!(own.contains("on the default branch as it is now. No other change has been isolated as the cause"), "{own}");
        let conflict = pull_note(&[11], &[11], false, &[], &FailedCheck { name: "merge".into(), conclusion: "conflict".into(), url: None });
        assert!(conflict.contains("it did not merge cleanly"), "{conflict}");
        assert!(!conflict.contains("narrowed"));
        assert_eq!(summary(14, &[11, 12], &[], &check), "#14 failed in the merge queue together with #11 and #12: `CI / merge_group` failed when they were combined.");
        assert_eq!(numbers(&[]), "");
    }

    #[test]
    fn the_notes_name_what_landed_since_it_branched() {
        let check = failure(FailureKind::Checks).check;
        // One landed: named as the likely cause.
        let one = pull_note(&[], &[], false, &[1], &check);
        assert_eq!(
            one,
            "traced its merge queue failure to the default branch as it is now: `CI / merge_group` failed with this change merged into it, though this passes its checks on its own. Since this branched, #1 landed and is the likely cause. Bring it up to date with the default branch, fix what breaks, and push. Push a fix: once its checks pass on the new commit, it rejoins the merge queue by itself."
        );
        assert_eq!(
            summary(14, &[], &[1], &check),
            "#14 failed in the merge queue on the default branch as it is now: `CI / merge_group` failed, though #14 passes its checks on its own; since it branched, #1 landed and is the likely cause."
        );
        // Several: listed, newest first, as possible causes.
        let several = pull_note(&[], &[], false, &[7, 5, 1], &check);
        assert!(several.contains("Since this branched, #7, #5 and #1 landed and may be what it conflicts with."), "{several}");
        assert!(!several.contains("the change is the cause"));
        assert!(summary(14, &[], &[7, 5], &check).ends_with("since it branched, #7 and #5 landed and may be what it conflicts with."));
        // No attribution evidence is not proof that the change itself caused it.
        assert_eq!(summary(14, &[], &[], &check), "#14 failed in the merge queue: `CI / merge_group` failed. No other change has been isolated as the cause.");
    }

    fn commit(hash: &str, at: &str) -> Commit {
        Commit {
            hash: hash.into(),
            tree_hash: format!("t{hash}"),
            message: String::new(),
            author: g1t_contracts::repos::Signature { name: "a".into(), email: "a@example.com".into() },
            parents: Vec::new(),
            authored_at: at.into(),
        }
    }

    fn merged(number: u32, commit: &str, at: &str) -> MergedRow {
        MergedRow { number, head_commit: Some(commit.into()), merged_at: Some(at.into()) }
    }

    #[test]
    fn what_landed_is_what_its_history_does_not_hold() {
        // #3 and #2 landed after it branched from #1's commit.
        let pulls = [
            merged(3, "c3", "2026-10-12T12:00:00.000Z"),
            merged(2, "c2", "2026-10-12T11:00:00.000Z"),
            merged(1, "c1", "2026-10-12T10:00:00.000Z"),
        ];
        let history = [commit("mine", "2026-10-12T10:30:00Z"), commit("c1", "2026-10-12T10:00:00Z"), commit("c0", "2026-10-11T00:00:00Z")];
        assert_eq!(landed_since(&pulls, &history, None), vec![3, 2]);
        // Brought up to date with #2 since: only #3 is new to it.
        let updated = [commit("merge", "2026-10-12T11:30:00Z"), commit("c2", "2026-10-12T11:00:00Z"), commit("c1", "2026-10-12T10:00:00Z")];
        assert_eq!(landed_since(&pulls, &updated, None), vec![3]);
        // A history cut short does not count what is older than it.
        let short = [commit("mine", "2026-10-12T11:30:00Z"), commit("x", "2026-10-12T10:30:00Z")];
        assert_eq!(landed_since(&pulls, &short, Some("2026-10-12T10:30:00Z")), vec![3, 2]);
        // A merged pull request with no recorded commit is not counted.
        let unknown = [MergedRow { number: 9, head_commit: None, merged_at: None }];
        assert!(landed_since(&unknown, &history, None).is_empty());
        // At most MAX_LANDED, newest first.
        let many: Vec<MergedRow> = (1..=15).rev().map(|n| merged(n, &format!("m{n}"), "2026-10-12T12:00:00.000Z")).collect();
        let found = landed_since(&many, &history, None);
        assert_eq!(found.len(), MAX_LANDED);
        assert_eq!(found.first(), Some(&15));
    }

    #[test]
    fn failures_are_read_from_what_was_reported() {
        let conflict = ReportQueueArgs {
            entry_id: "qen_1".into(),
            token: String::new(),
            combined_commit: None,
            results: Vec::new(),
            error: Some("conflict".into()),
            conflict_with: Some(12),
            conflicts: vec!["src/a.rs".into()],
        };
        let read = Failure::of_report(&conflict, None);
        assert_eq!(read.kind, FailureKind::Conflict);
        assert_eq!(read.check.name, "merge");
        let back = read.report("qen_1");
        assert_eq!((back.conflict_with, back.conflicts.len()), (Some(12), 1));
        let missing = Failure::of_report(&ReportQueueArgs { conflict_with: None, conflicts: Vec::new(), ..conflict }, Some(&["CI".to_owned()]));
        assert_eq!((missing.kind, missing.check.conclusion.as_str()), (FailureKind::Missing, "missing"));
        let workflows = Failure::of_workflows("abc", &["CI / merge_group".into()], &[], &[], "the workflow failed".into(), |name| Some(format!("https://x/{name}")));
        assert_eq!(workflows.kind, FailureKind::Checks);
        assert_eq!(workflows.check.url.as_deref(), Some("https://x/CI / merge_group"));
        let never = Failure::of_workflows("abc", &[], &[], &["CI".into()], "missing".into(), |_| None);
        assert_eq!(never.kind, FailureKind::Missing);
        // A held failure survives being kept as JSON.
        let kept: Failure = serde_json::from_str(&serde_json::to_string(&workflows).unwrap()).unwrap();
        assert_eq!(kept.check, workflows.check);
    }
}
