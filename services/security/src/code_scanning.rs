//! Code scanning: SARIF uploads read into analyses and alerts, and the
//! `Code scanning` check on pull requests.
//!
//! An upload for the default branch opens an alert for each result not
//! seen before (by fingerprint, per tool and category), refreshes those
//! seen again, and fixes the open ones it no longer reports. An upload for
//! a pull request (`refs/pull/<n>/head` or `/merge`) leaves the alerts
//! alone: its results are compared with the default branch's, and those
//! new to the pull request on lines it changes become the check's
//! annotations, as review comments on those lines, failing the check at
//! the repository's chosen threshold. Require the check in branch
//! protection and it gates the merge like any other.

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::repos::{BlobArgs, BlobView, CompareArgs, Comparison, GetArgs, LineKind, Repo, RepoPath};
use g1t_contracts::security::{AlertActivity, AlertState, DismissReason};
use g1t_contracts::security_suite::{
    AlertType, CODE_SCANNING_CHECK, CodeAlert, CodeAlertArgs, CodeAlertDetail, CodeScanning, CodeScanningArgs, PaidFeature,
    PullResult, PullScanning, PullScanningArgs, STARTER_WORKFLOW_PATH, SarifStatusArgs, SarifUpload, SecurityEvent,
    SetCodeAlertStateArgs, UploadSarifArgs,
};
use g1t_contracts::work::{AddCommentArgs, Pull, PullDetail, SetCommitStatusArgs, ViewArgs};
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_scan::sarif::{self, Finding, Gate};
use serde_json::{Value, json};
use worker::Result;

use crate::Security;
use crate::store::{Activity, RepoRow};
use crate::suite::link;
use crate::suite_store::NewCodeAlert;

const SITE: &str = "https://g1t.sh";
/// Review comments one analysis of a pull request leaves, at most.
const MAX_COMMENTS: usize = 10;
/// Alerts an upload announces one by one; past it, the page says the rest.
const MAX_EVENTS: usize = 20;

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// A result as kept with its analysis.
pub fn result_json(finding: &Finding) -> Value {
    json!({
        "ruleId": finding.rule_id,
        "level": finding.level.as_str(),
        "securitySeverity": finding.security_severity.map(|severity| severity.as_str()),
        "severity": finding.severity().as_str(),
        "message": finding.message,
        "path": finding.location.as_ref().map(|location| location.path.clone()),
        "line": finding.location.as_ref().map(|location| location.start_line),
    })
}

/// The pull request a ref names: `refs/pull/12/head` or `/merge`.
pub fn pull_of(git_ref: &str) -> Option<u32> {
    let rest = git_ref.strip_prefix("refs/pull/")?;
    let (number, which) = rest.split_once('/')?;
    matches!(which, "head" | "merge").then(|| number.parse().ok()).flatten()
}

fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// The lines each file gains in a comparison.
pub fn added_lines(comparison: &Comparison) -> BTreeMap<String, BTreeSet<u32>> {
    let mut out: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    for file in &comparison.files {
        for hunk in &file.hunks {
            for line in &hunk.lines {
                if line.kind == LineKind::Add
                    && let Some(number) = line.new
                {
                    out.entry(file.path.clone()).or_default().insert(number);
                }
            }
        }
    }
    out
}

/// A pull request's results, judged: new to it or not, on a line it
/// changes or not, failing the check or not.
pub fn judge_pull(found: &[Finding], on_default: &BTreeSet<String>, changed: &BTreeMap<String, BTreeSet<u32>>, gate: Gate) -> Vec<PullResult> {
    let mut results: Vec<PullResult> = found
        .iter()
        .map(|finding| {
            let location = finding.location.as_ref();
            let new = !on_default.contains(&finding.fingerprint);
            let on_changed_line = location.is_some_and(|location| {
                changed
                    .get(&location.path)
                    .is_some_and(|lines| (location.start_line..=location.end_line).any(|line| lines.contains(&line)))
            });
            PullResult {
                tool: String::new(),
                rule_id: finding.rule_id.clone(),
                level: finding.level.as_str().to_owned(),
                severity: finding.severity().as_str().to_owned(),
                security_severity: finding.security_severity.map(|severity| severity.as_str().to_owned()),
                message: finding.message.clone(),
                path: location.map(|location| location.path.clone()),
                line: location.map(|location| location.start_line),
                new,
                on_changed_line,
                failing: new && on_changed_line && gate.fails(finding),
            }
        })
        .collect();
    results.sort_by_key(|result| (!result.failing, !result.new, !result.on_changed_line));
    results
}

/// The check's state and line for a pull request's results.
pub fn verdict(results: &[PullResult]) -> (&'static str, String) {
    let failing = results.iter().filter(|result| result.failing).count();
    let new = results.iter().filter(|result| result.new && result.on_changed_line).count();
    if failing > 0 {
        let plural = if failing == 1 { "result" } else { "results" };
        return ("failure", format!("{failing} new {plural} at or above the threshold"));
    }
    match new {
        0 => ("success", "No new results".to_owned()),
        1 => ("success", "1 new result, below the threshold".to_owned()),
        n => ("success", format!("{n} new results, below the threshold")),
    }
}

/// A review comment for a result on a line the pull request changes.
pub fn comment_text(tool: &str, finding: &PullResult, alert_page: &str) -> String {
    let severity = finding.security_severity.as_deref().unwrap_or(&finding.level);
    format!(
        "**{tool}: `{}`** ({severity})\n\n{}\n\n[See the results for this pull request]({alert_page}). Fix it here, or dismiss it on the alert once it lands if it is not a real problem.",
        finding.rule_id, finding.message
    )
}

/// The event that tells of a code scanning alert.
pub fn code_event(repo: &RepoRow, alert: &CodeAlert) -> SecurityEvent {
    SecurityEvent {
        repo_id: repo.repo_id.clone(),
        alert_id: alert.id.clone(),
        alert_type: AlertType::CodeScanning.as_str().to_owned(),
        alert_number: Some(alert.number),
        severity: alert.severity.clone(),
        title: format!(
            "{}: {}{}",
            alert.tool,
            alert.rule_name.as_deref().unwrap_or(&alert.rule_id),
            alert.path.as_deref().map(|path| format!(" in {path}")).unwrap_or_default()
        ),
        link: link(repo, &format!("code-scanning/{}", alert.number)),
        path: alert.path.clone(),
        line: alert.start_line,
        state: alert.state.as_str().to_owned(),
        ..SecurityEvent::default()
    }
}

impl Security {
    pub(crate) async fn repo_record(&self, repo: &RepoRow) -> Result<Option<Repo>> {
        let found: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get",
            &GetArgs { path: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() }, viewer: Some(User::system(&repo.namespace)) },
        )
        .await?;
        Ok(found.into_result().ok())
    }

    pub(crate) async fn upload_sarif(&self, a: UploadSarifArgs) -> Result<Outcome<SarifUpload>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Some(refusal) = self.gate(&repo, PaidFeature::CodeScanning).await? {
            return Ok(refusal);
        }
        if !is_sha(&a.commit_sha) {
            return Ok(fail(FailureCode::Invalid, "commit_sha is a full commit hash."));
        }
        if !a.git_ref.starts_with("refs/") {
            return Ok(fail(FailureCode::Invalid, "ref is a full ref: refs/heads/<branch> or refs/pull/<number>/head."));
        }
        let Some(record) = self.repo_record(&repo).await? else {
            return Ok(fail(FailureCode::NotFound, "Repository not found."));
        };
        let default_ref = format!("refs/heads/{}", record.default_branch);
        let pull = pull_of(&a.git_ref);
        let id = self.store.add_upload(&repo.repo_id, &a.commit_sha, &a.git_ref, &a.actor.username).await?;
        let parsed = sarif::decode_upload(&a.sarif).and_then(|text| sarif::parse(&text, a.category.as_deref(), a.checkout_uri.as_deref()));
        let mut runs = match parsed {
            Ok(runs) => runs,
            Err(problem) => {
                self.store.finish_upload(&id, true, std::slice::from_ref(&problem), &[]).await?;
                return Ok(Outcome::Ok(self.upload_view(&repo, &id).await?.unwrap_or_else(|| failed_upload(&id, &a, problem))));
            }
        };
        if let (Some(name), [run]) = (a.tool_name.as_deref().map(str::trim).filter(|name| !name.is_empty()), runs.as_mut_slice()) {
            if run.category == run.tool {
                run.category = name.to_owned();
            }
            run.tool = name.to_owned();
        }
        let mut analyses = Vec::new();
        let mut errors = Vec::new();
        for run in &runs {
            if run.dropped > 0 {
                errors.push(format!("{} results past the first {} of {} were not kept.", run.dropped, sarif::MAX_RESULTS, run.tool));
            }
            if a.git_ref == default_ref {
                let live = self.store.live_fingerprints(&repo.repo_id, &run.tool, &run.category).await?;
                let (_, fixed) = sarif::reconcile(&live, &run.findings);
                let items: Vec<NewCodeAlert> = run
                    .findings
                    .iter()
                    .map(|finding| NewCodeAlert { tool: &run.tool, category: &run.category, finding, commit: &a.commit_sha })
                    .collect();
                let opened = self.store.upsert_code_alerts(&repo.repo_id, &items).await?;
                let fixed = self.store.fix_code_alerts(&repo.repo_id, &run.tool, &run.category, &fixed).await?;
                analyses.push(
                    self.store
                        .add_analysis(&repo.repo_id, &id, run, &a.commit_sha, &a.git_ref, None, opened.len() as u32, fixed.len() as u32)
                        .await?,
                );
                for (ids, action) in [(&opened, "created"), (&fixed, "fixed")] {
                    for alert_id in ids.iter().take(MAX_EVENTS) {
                        if let Some(alert) = self.store.code_alert_by_id(&repo.repo_id, alert_id).await? {
                            self.alert_event(AlertType::CodeScanning, action, &repo, code_event(&repo, &alert), Some(a.actor.id.clone())).await;
                        }
                    }
                }
            } else {
                analyses.push(self.store.add_analysis(&repo.repo_id, &id, run, &a.commit_sha, &a.git_ref, pull, 0, 0).await?);
            }
        }
        self.store.finish_upload(&id, false, &errors, &analyses).await?;
        if let Some(number) = pull
            && let Err(error) = self.code_pull_check(&repo, number, &a.commit_sha, &runs).await
        {
            worker::console_error!("security: code scanning check on #{number} of {}: {error}", repo.repo_id);
        }
        Ok(Outcome::Ok(self.upload_view(&repo, &id).await?.unwrap_or_else(|| failed_upload(&id, &a, "not recorded".to_owned()))))
    }

    async fn upload_view(&self, repo: &RepoRow, id: &str) -> Result<Option<SarifUpload>> {
        Ok(self.store.upload(&repo.repo_id, id).await?.map(|row| SarifUpload {
            id: row.id,
            processing_status: row.status,
            analyses: serde_json::from_str(&row.analyses).unwrap_or_default(),
            errors: serde_json::from_str(&row.errors).unwrap_or_default(),
            commit_sha: row.commit_sha,
            git_ref: row.git_ref,
            created_at: row.created_at,
        }))
    }

    pub(crate) async fn sarif_status(&self, a: SarifStatusArgs) -> Result<Outcome<SarifUpload>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(match self.upload_view(&repo, &a.id).await? {
            Some(upload) => Outcome::Ok(upload),
            None => fail(FailureCode::NotFound, "No such upload."),
        })
    }

    pub(crate) async fn code_scanning(&self, a: CodeScanningArgs) -> Result<Outcome<CodeScanning>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let (_, private) = self.store.repo_settings(&repo.repo_id).await?;
        let default_branch = self.repo_record(&repo).await?.map(|record| record.default_branch).unwrap_or_else(|| "main".to_owned());
        let starter: Outcome<BlobView> = g1t_kit::call(
            &self.repos,
            "blob",
            &BlobArgs {
                path: a.repo.clone(),
                viewer: Some(User::system(&repo.namespace)),
                git_ref: default_branch,
                file_path: STARTER_WORKFLOW_PATH.to_owned(),
            },
        )
        .await
        .unwrap_or_else(|_| fail(FailureCode::NotFound, "unread"));
        Ok(Outcome::Ok(CodeScanning {
            alerts: self.store.code_alerts(&repo.repo_id).await?,
            analyses: self.store.analyses(&repo.repo_id, 50).await?,
            entitled: self.entitled(&repo).await?,
            private,
            configured: matches!(starter, Outcome::Ok(_)),
        }))
    }

    pub(crate) async fn code_alert(&self, a: CodeAlertArgs) -> Result<Outcome<CodeAlertDetail>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(alert) = self.store.code_alert(&repo.repo_id, a.number).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        let activity: Vec<AlertActivity> =
            self.store.activity(&repo.repo_id, 500).await?.into_iter().filter(|item| item.alert_id == alert.id).collect();
        Ok(Outcome::Ok(CodeAlertDetail {
            analyses: self.store.analyses_reporting(&repo.repo_id, &alert.fingerprint).await?,
            activity,
            alert,
        }))
    }

    pub(crate) async fn set_code_alert_state(&self, a: SetCodeAlertStateArgs) -> Result<Outcome<CodeAlert>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let Some(alert) = self.store.code_alert(&repo.repo_id, a.number).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        let comment: String = a.comment.trim().chars().take(500).collect();
        let comment = (!comment.is_empty()).then_some(comment);
        let action = match a.state {
            AlertState::Dismissed => {
                let Some(reason) = a.reason.filter(|reason| {
                    matches!(reason, DismissReason::FalsePositive | DismissReason::WontFix | DismissReason::UsedInTests)
                }) else {
                    return Ok(fail(FailureCode::Invalid, "A code scanning alert is dismissed as false_positive, wont_fix or used_in_tests."));
                };
                if alert.state != AlertState::Open {
                    return Ok(fail(FailureCode::Conflict, "This alert is not open."));
                }
                self.store.set_code_alert(&repo.repo_id, &alert.id, Some((reason, comment.as_deref(), &a.actor.username))).await?;
                self.store
                    .record(&repo.repo_id, &[Activity {
                        alert_id: &alert.id,
                        action: "dismissed",
                        actor: Some(&a.actor.username),
                        reason: Some(reason),
                        comment: comment.as_deref(),
                        number: None,
                    }])
                    .await?;
                "dismissed"
            }
            AlertState::Open => {
                if alert.state != AlertState::Dismissed {
                    return Ok(fail(FailureCode::Conflict, "Only a dismissed alert can be reopened; a fixed one reopens when it is found again."));
                }
                self.store.set_code_alert(&repo.repo_id, &alert.id, None).await?;
                self.store
                    .record(&repo.repo_id, &[Activity {
                        alert_id: &alert.id,
                        action: "reopened",
                        actor: Some(&a.actor.username),
                        reason: None,
                        comment: None,
                        number: None,
                    }])
                    .await?;
                "reopened"
            }
            AlertState::Fixed => return Ok(fail(FailureCode::Invalid, "An alert is fixed by an analysis that no longer reports it.")),
        };
        let Some(alert) = self.store.code_alert(&repo.repo_id, a.number).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        let event = SecurityEvent { reason: a.reason.map(|reason| reason.as_str().to_owned()), ..code_event(&repo, &alert) };
        self.alert_event(AlertType::CodeScanning, action, &repo, event, Some(a.actor.id.clone())).await;
        Ok(Outcome::Ok(alert))
    }

    pub(crate) async fn pull_by_number(&self, repo: &RepoRow, number: u32) -> Result<Option<Pull>> {
        let found: Outcome<PullDetail> = g1t_kit::call(
            &self.work,
            "get_pull",
            &ViewArgs {
                repo: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                number,
                viewer: Some(User::system(&repo.namespace)),
                after_seq: 0,
            },
        )
        .await?;
        Ok(found.into_result().ok().map(|detail| detail.pull))
    }

    /// What a pull request changes, as the repository compares it: its
    /// branch (or fork) against where it left the branch it merges into.
    pub(crate) async fn pull_comparison(&self, repo: &RepoRow, pull: &Pull) -> Result<Option<Comparison>> {
        let (repo_id, head) = match &pull.fork_repo_id {
            Some(fork) => (fork.clone(), None),
            None => (repo.repo_id.clone(), pull.branch.clone()),
        };
        let compared: Outcome<Comparison> = g1t_kit::call(
            &self.repos,
            "compare",
            &CompareArgs { repo_id, viewer: Some(User::system(&repo.namespace)), base: None, head, base_branch: pull.base.clone() },
        )
        .await?;
        Ok(compared.into_result().ok())
    }

    pub(crate) async fn set_status(&self, repo: &RepoRow, sha: &str, context: &str, state: &str, description: &str, number: u32) {
        let set: Result<Outcome<bool>> = g1t_kit::call(
            &self.work,
            "set_commit_status",
            &SetCommitStatusArgs {
                repo_id: repo.repo_id.clone(),
                sha: sha.to_owned(),
                context: context.to_owned(),
                state: state.to_owned(),
                description: Some(description.chars().take(140).collect()),
                target_url: Some(format!("{SITE}/{}/{}/security/pulls/{number}", repo.namespace, repo.name)),
            },
        )
        .await;
        if let Err(error) = set {
            worker::console_error!("security: {context} status on {sha}: {error}");
        }
    }

    /// Judges a pull request's code scanning results and reports the check.
    async fn code_pull_check(&self, repo: &RepoRow, number: u32, commit: &str, runs: &[sarif::Run]) -> Result<()> {
        let Some(pull) = self.pull_by_number(repo, number).await? else { return Ok(()) };
        let (settings, _) = self.store.repo_settings(&repo.repo_id).await?;
        let gate = Gate::parse(&settings.code_scanning_gate).unwrap_or(Gate::AtLeast(g1t_scan::osv::Severity::High));
        let changed = match self.pull_comparison(repo, &pull).await? {
            Some(comparison) => added_lines(&comparison),
            None => BTreeMap::new(),
        };
        let on_default = self.store.open_code_fingerprints(&repo.repo_id).await?;
        // This upload's runs, joined with what earlier uploads for the same
        // commit found with other tools.
        let previous = self.store.pull_check(&repo.repo_id, number, "code").await?;
        let mut results: Vec<PullResult> = Vec::new();
        let tools: BTreeSet<&str> = runs.iter().map(|run| run.tool.as_str()).collect();
        if let Some(previous) = &previous
            && previous.commit_sha == commit
        {
            let kept: Vec<PullResult> = serde_json::from_str::<Value>(&previous.detail)
                .ok()
                .and_then(|detail| serde_json::from_value(detail["results"].clone()).ok())
                .unwrap_or_default();
            results.extend(kept.into_iter().filter(|result| !tools.contains(result.tool.as_str())));
        }
        for run in runs {
            for mut result in judge_pull(&run.findings, &on_default, &changed, gate) {
                result.tool = run.tool.clone();
                results.push(result);
            }
        }
        let (state, description) = verdict(&results);
        // Review comments on changed lines for results new to the pull
        // request, each once.
        let mut commented: Vec<String> = previous
            .as_ref()
            .and_then(|row| serde_json::from_str(&row.commented).ok())
            .unwrap_or_default();
        let page = format!("{SITE}/{}/{}/security/pulls/{number}", repo.namespace, repo.name);
        let system = User::system(&repo.namespace);
        let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        let mut left = 0;
        for result in results.iter().filter(|result| result.new && result.on_changed_line) {
            let key = format!("{}|{}|{}|{}", result.tool, result.rule_id, result.path.as_deref().unwrap_or(""), result.line.unwrap_or(0));
            if commented.contains(&key) || left == MAX_COMMENTS {
                continue;
            }
            let _: Result<Outcome<Value>> = g1t_kit::call(
                &self.work,
                "add_comment",
                &AddCommentArgs {
                    actor: system.clone(),
                    repo: path.clone(),
                    number,
                    body: comment_text(&result.tool, result, &page),
                    path: result.path.clone(),
                    line: result.line,
                    verdict: None,
                },
            )
            .await;
            commented.push(key);
            left += 1;
        }
        self.store
            .set_pull_check(&repo.repo_id, number, "code", commit, state, &description, &json!({ "results": results }), &commented)
            .await?;
        self.set_status(repo, commit, CODE_SCANNING_CHECK, state, &description, number).await;
        Ok(())
    }

    pub(crate) async fn pull_code_scanning(&self, a: PullScanningArgs) -> Result<Outcome<PullScanning>> {
        let repo = match self.member_repo(&a.repo, &a.viewer, crate::SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let code = self.store.pull_check(&repo.repo_id, a.number, "code").await?;
        let review = self.store.pull_check(&repo.repo_id, a.number, "review").await?;
        Ok(Outcome::Ok(PullScanning {
            commit: code.as_ref().or(review.as_ref()).map(|row| row.commit_sha.clone()),
            results: code
                .as_ref()
                .and_then(|row| serde_json::from_str::<Value>(&row.detail).ok())
                .and_then(|detail| serde_json::from_value(detail["results"].clone()).ok())
                .unwrap_or_default(),
            review: review.as_ref().and_then(|row| serde_json::from_str(&row.detail).ok()),
            code_status: code.as_ref().map(|row| row.state.clone()),
            code_description: code.as_ref().map(|row| row.description.clone()),
        }))
    }
}

fn failed_upload(id: &str, a: &UploadSarifArgs, problem: String) -> SarifUpload {
    SarifUpload {
        id: id.to_owned(),
        processing_status: "failed".to_owned(),
        analyses: Vec::new(),
        errors: vec![problem],
        commit_sha: a.commit_sha.clone(),
        git_ref: a.git_ref.clone(),
        created_at: crate::store::now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::{DiffLine, FileDiff, FileStatus, Hunk};
    use g1t_scan::osv::Severity;

    const CODEQL: &str = include_str!("../../../crates/scan/fixtures/codeql.sarif");

    #[test]
    fn pull_refs_name_their_pull_request() {
        assert_eq!(pull_of("refs/pull/12/head"), Some(12));
        assert_eq!(pull_of("refs/pull/12/merge"), Some(12));
        assert_eq!(pull_of("refs/heads/main"), None);
        assert_eq!(pull_of("refs/pull/x/head"), None);
        assert!(is_sha("4807077b296e6edbf410d55e72749d3e1170c291") && !is_sha("main"));
    }

    fn comparison() -> Comparison {
        let line = |kind, new| DiffLine { kind, old: None, new, text: String::new() };
        Comparison {
            base: Some("a".into()),
            head: "b".into(),
            truncated: false,
            files: vec![FileDiff {
                path: "src/server.js".into(),
                status: FileStatus::Modified,
                additions: 1,
                deletions: 0,
                binary: false,
                hunks: vec![Hunk { lines: vec![line(LineKind::Context, Some(11)), line(LineKind::Add, Some(12)), line(LineKind::Delete, None)] }],
            }],
        }
    }

    #[test]
    fn only_new_results_on_changed_lines_fail_the_check() {
        let runs = sarif::parse(CODEQL, None, None).unwrap();
        let findings = &runs[0].findings;
        let changed = added_lines(&comparison());
        assert_eq!(changed["src/server.js"], BTreeSet::from([12]));
        // Nothing on the default branch yet: the injection on line 12 is new
        // and on a changed line, and high, so it fails.
        let results = judge_pull(findings, &BTreeSet::new(), &changed, Gate::AtLeast(Severity::High));
        let injection = results.iter().find(|result| result.rule_id == "js/sql-injection").unwrap();
        assert!(injection.new && injection.on_changed_line && injection.failing);
        // The logging result is new but on a line the pull request did not touch.
        let logging = results.iter().find(|result| result.rule_id == "js/clear-text-logging").unwrap();
        assert!(logging.new && !logging.on_changed_line && !logging.failing);
        assert_eq!(verdict(&results), ("failure", "1 new result at or above the threshold".to_owned()));
        // Already open on the default branch: not this pull request's.
        let known: BTreeSet<String> = findings.iter().map(|finding| finding.fingerprint.clone()).collect();
        let results = judge_pull(findings, &known, &changed, Gate::AtLeast(Severity::High));
        assert!(results.iter().all(|result| !result.new && !result.failing));
        assert_eq!(verdict(&results).0, "success");
        // A gate of none never fails.
        let results = judge_pull(findings, &BTreeSet::new(), &changed, Gate::None);
        assert_eq!(verdict(&results), ("success", "1 new result, below the threshold".to_owned()));
    }

    #[test]
    fn a_comment_names_the_tool_rule_and_severity() {
        let result = PullResult {
            tool: "CodeQL".into(),
            rule_id: "js/sql-injection".into(),
            level: "error".into(),
            severity: "high".into(),
            security_severity: Some("high".into()),
            message: "This query string depends on a user-provided value.".into(),
            path: Some("src/server.js".into()),
            line: Some(12),
            new: true,
            on_changed_line: true,
            failing: true,
        };
        let text = comment_text("CodeQL", &result, "https://g1t.sh/acme/rocket/security/pulls/3");
        assert!(text.starts_with("**CodeQL: `js/sql-injection`** (high)"));
        assert!(text.contains("depends on a user-provided value") && text.contains("/security/pulls/3"));
    }
}
