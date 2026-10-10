//! The security service's paid suite, beside what [`crate::security`]
//! holds: custom secret patterns, push protection bypasses and their
//! review, validity checks, code scanning from SARIF uploads, the
//! dependency graph with its SBOM and pull request review, and the
//! workspace's security overview.
//!
//! What is free and what is paid: secret scanning, push protection,
//! vulnerability alerts and security updates are free everywhere. On a
//! public repository everything here is free too. On a private one, the
//! features in [`PaidFeature`] come with the g1t plan (billing's
//! `Feature::Security`, which has no price of its own: its scans are
//! metered like everything else); a refusal is a `PaymentRequired` failure
//! whose message says how to start the plan.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::repos::RepoPath;
use crate::security::{AlertActivity, AlertState, DismissReason, SecretFinding, SeverityCounts};

/// A feature of the suite that a private repository needs the activation
/// for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaidFeature {
    CustomPatterns,
    ValidityChecks,
    DelegatedBypass,
    CodeScanning,
    DependencyReview,
    SecurityOverview,
}

impl PaidFeature {
    pub const ALL: [PaidFeature; 6] = [
        PaidFeature::CustomPatterns,
        PaidFeature::ValidityChecks,
        PaidFeature::DelegatedBypass,
        PaidFeature::CodeScanning,
        PaidFeature::DependencyReview,
        PaidFeature::SecurityOverview,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PaidFeature::CustomPatterns => "custom_patterns",
            PaidFeature::ValidityChecks => "validity_checks",
            PaidFeature::DelegatedBypass => "delegated_bypass",
            PaidFeature::CodeScanning => "code_scanning",
            PaidFeature::DependencyReview => "dependency_review",
            PaidFeature::SecurityOverview => "security_overview",
        }
    }

    /// For a sentence: "Custom patterns".
    pub fn title(self) -> &'static str {
        match self {
            PaidFeature::CustomPatterns => "Custom patterns",
            PaidFeature::ValidityChecks => "Validity checks",
            PaidFeature::DelegatedBypass => "Delegated bypass",
            PaidFeature::CodeScanning => "Code scanning",
            PaidFeature::DependencyReview => "Dependency review",
            PaidFeature::SecurityOverview => "The security overview",
        }
    }
}

/// What a refusal for want of the plan says.
pub fn needs_activation(feature: PaidFeature, workspace: &str) -> String {
    format!(
        "{} on private repositories comes with the g1t plan, which {workspace} does not have; its scans are charged at cost plus 20%. \
         An owner can start the plan at /{workspace}/-/billing. Public repositories have it free.",
        feature.title()
    )
}

/// The alert types, as the API and webhooks name them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertType {
    SecretScanning,
    CodeScanning,
    Vulnerability,
}

impl AlertType {
    pub const ALL: [AlertType; 3] = [AlertType::SecretScanning, AlertType::CodeScanning, AlertType::Vulnerability];

    pub fn as_str(self) -> &'static str {
        match self {
            AlertType::SecretScanning => "secret_scanning",
            AlertType::CodeScanning => "code_scanning",
            AlertType::Vulnerability => "vulnerability",
        }
    }

    pub fn parse(text: &str) -> Option<AlertType> {
        AlertType::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// Which type an alert id is: `sec_…`, `cod_…` or `vul_…`.
    pub fn of_id(id: &str) -> Option<AlertType> {
        match id.split('_').next()? {
            "sec" => Some(AlertType::SecretScanning),
            "cod" => Some(AlertType::CodeScanning),
            "vul" => Some(AlertType::Vulnerability),
            _ => None,
        }
    }

    /// The webhook event prefix: `secret_scanning_alert`.
    pub fn event_prefix(self) -> &'static str {
        match self {
            AlertType::SecretScanning => "secret_scanning_alert",
            AlertType::CodeScanning => "code_scanning_alert",
            AlertType::Vulnerability => "vulnerability_alert",
        }
    }
}

// --- Settings ---------------------------------------------------------------

/// A repository's security settings beyond security updates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSecuritySettings {
    /// When a pull request's code scanning check fails: `none`, `errors`,
    /// or new results of `critical`, `high`, `medium` or `any` security
    /// severity (and errors). The check is `Code scanning`; require it in
    /// branch protection to block merges.
    pub code_scanning_gate: String,
    /// Whether pull requests get the `Dependency review` check.
    pub dependency_review: bool,
    /// The lowest severity of a known vulnerability in an added package
    /// that fails it: `critical`, `high`, `medium`, `low`, or `none`.
    pub review_fail_on: String,
    /// SPDX license ids an added package may not have.
    pub review_deny_licenses: Vec<String>,
    /// Whether the review also comments its summary on the pull request.
    pub review_comment: bool,
}

impl Default for RepoSecuritySettings {
    fn default() -> Self {
        RepoSecuritySettings {
            code_scanning_gate: "high".to_owned(),
            dependency_review: true,
            review_fail_on: "high".to_owned(),
            review_deny_licenses: Vec::new(),
            review_comment: true,
        }
    }
}

/// A workspace's security settings.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSecuritySettings {
    /// Push protection bypasses need an owner's (or the repository's
    /// admins') approval: a person with Write requests one instead.
    pub delegated_bypass: bool,
    /// Ask each secret's issuer whether it still works, where that can be
    /// done safely.
    pub validity_checks: bool,
}

/// `security_settings`: a repository's settings, what its workspace sets,
/// and whether the paid features are on for it. Write and up.
#[derive(Debug, Serialize, Deserialize)]
pub struct SecuritySettingsArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettingsView {
    pub settings: RepoSecuritySettings,
    pub workspace: WorkspaceSecuritySettings,
    /// Whether the repository is private.
    pub private: bool,
    /// Whether the paid features are on: a public repository, or the
    /// workspace has the activation (or is comped).
    pub entitled: bool,
    /// Security updates.
    pub upkeep: bool,
}

/// `set_security_settings`: Admin on the repository.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetSecuritySettingsArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub settings: RepoSecuritySettings,
}

/// `workspace_security_settings`: members only. Returns
/// `Outcome<WorkspaceSecurityView>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceSecuritySettingsArgs {
    pub viewer: Option<User>,
    pub workspace: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSecurityView {
    pub settings: WorkspaceSecuritySettings,
    /// Whether the workspace has the activation (or is comped).
    pub activated: bool,
}

/// `set_workspace_security_settings`: owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetWorkspaceSecuritySettingsArgs {
    pub actor: User,
    pub workspace: String,
    pub settings: WorkspaceSecuritySettings,
}

// --- Custom patterns --------------------------------------------------------

/// A pattern as push protection and scans use it: see `g1t_scan::custom`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternSpec {
    pub id: String,
    pub name: String,
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// A custom pattern, as people manage it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPattern {
    /// `pat_…`.
    pub id: String,
    /// `repository` or `workspace`.
    pub scope: String,
    pub workspace: String,
    /// The repository's name, for a repository's own pattern.
    pub repo: Option<String>,
    pub name: String,
    pub pattern: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub test_strings: Vec<String>,
    /// `draft` (saved, not used) or `published` (push protection and scans
    /// use it).
    pub state: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_by: String,
    pub updated_at: String,
    /// Open alerts it has found.
    pub open_alerts: u32,
}

/// `custom_patterns`: a repository's patterns and those it inherits from
/// its workspace (with `repo`), or the workspace's own. Write and up for a
/// repository, members for a workspace. Returns `Outcome<PatternList>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CustomPatternsArgs {
    pub viewer: Option<User>,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternList {
    pub patterns: Vec<CustomPattern>,
    pub entitled: bool,
}

/// `save_custom_pattern`: creates (no `id`) or changes a pattern. Admin on
/// the repository, or an owner for a workspace's. Publishing one rescans
/// the default branch's history with it. Returns `Outcome<SavedPattern>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCustomPatternArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub pattern: String,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub test_strings: Vec<String>,
    /// Publish it (push protection and scans use it), or keep it a draft.
    #[serde(default)]
    pub publish: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPattern {
    pub pattern: CustomPattern,
    /// For each test string, where the pattern matched it (start and end,
    /// in characters), or nothing.
    pub tests: Vec<Option<(u32, u32)>>,
}

/// `delete_custom_pattern`: with the roles of saving one. Its alerts stay.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteCustomPatternArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    pub id: String,
}

/// `dry_run_pattern`: runs a pattern over the default branch of the
/// repository (or, for a workspace, up to ten of its repositories, or
/// those named) without saving anything. Returns `Outcome<DryRun>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunPatternArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// For a workspace: repository names; empty is the first ten.
    #[serde(default)]
    pub repos: Vec<String>,
    pub pattern: String,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRun {
    pub repos: Vec<DryRunRepo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunRepo {
    pub name: String,
    #[serde(flatten)]
    pub result: PatternMatches,
}

/// `match_pattern` (repos): runs `pattern` over the files of the default
/// branch, up to its limits. Returns `PatternMatches`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchPatternArgs {
    pub repo_id: String,
    pub pattern: PatternSpec,
    /// Matches returned, at most.
    pub limit: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternMatches {
    pub files_scanned: u32,
    pub matches: Vec<PatternMatch>,
    /// More files or matches than were looked at.
    pub truncated: bool,
    /// The commit read.
    pub commit: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternMatch {
    pub path: String,
    pub line: u32,
    /// The line with the match masked but for its first characters.
    pub preview: String,
}

/// `patterns_for` (called by repos during a push): the published custom
/// patterns a repository is scanned with, its own and its workspace's,
/// when it is entitled to them. Returns `Vec<PatternSpec>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternsForArgs {
    pub repo_id: String,
    pub namespace: String,
    #[serde(default)]
    pub private: Option<bool>,
}

// --- Secret alerts: locations, bypasses, validity ---------------------------

/// Why a person pushed past push protection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BypassReason {
    /// It is not a secret: the alert is closed as a false positive.
    FalsePositive,
    /// It is a value for tests: the alert is closed as used in tests.
    UsedInTests,
    /// It is real: the alert stays open, to be rotated.
    WillFixLater,
}

impl BypassReason {
    pub const ALL: [BypassReason; 3] = [BypassReason::FalsePositive, BypassReason::UsedInTests, BypassReason::WillFixLater];

    pub fn as_str(self) -> &'static str {
        match self {
            BypassReason::FalsePositive => "false_positive",
            BypassReason::UsedInTests => "used_in_tests",
            BypassReason::WillFixLater => "will_fix_later",
        }
    }

    pub fn parse(text: &str) -> Option<BypassReason> {
        BypassReason::ALL.into_iter().find(|reason| reason.as_str() == text)
    }

    pub fn label(self) -> &'static str {
        match self {
            BypassReason::FalsePositive => "It's a false positive",
            BypassReason::UsedInTests => "It's used in tests",
            BypassReason::WillFixLater => "I'll fix it later",
        }
    }

    /// The dismissal it amounts to, when it closes the alert.
    pub fn dismissal(self) -> Option<DismissReason> {
        match self {
            BypassReason::FalsePositive => Some(DismissReason::FalsePositive),
            BypassReason::UsedInTests => Some(DismissReason::UsedInTests),
            BypassReason::WillFixLater => None,
        }
    }
}

/// A push protection bypass, made or asked for.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bypass {
    pub reason: BypassReason,
    pub comment: Option<String>,
    /// Who pushed past it.
    pub by: String,
    pub at: String,
    /// Who approved it, when delegated bypass asked for approval.
    pub approved_by: Option<String>,
}

/// Where a secret was found: each file, line and commit it is in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretLocation {
    pub path: String,
    pub line: u32,
    pub commit: String,
    /// `push` or `history`.
    pub source: String,
    pub found_at: String,
}

/// A request to bypass push protection, when delegated bypass is on.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassRequest {
    /// `byp_…`.
    pub id: String,
    pub repo_id: String,
    pub workspace: String,
    pub repo: String,
    pub secret_id: String,
    /// "an AWS access key".
    pub label: String,
    pub path: String,
    pub line: u32,
    pub preview: String,
    pub requester: String,
    pub reason: BypassReason,
    pub comment: Option<String>,
    /// `pending`, `approved`, `denied` or `cancelled`.
    pub state: String,
    pub reviewer: Option<String>,
    pub review_comment: Option<String>,
    pub created_at: String,
    pub reviewed_at: Option<String>,
}

/// `secret_alert`: one secret alert with every place it was found, what
/// happened to it and its bypass requests. Write and up. Returns
/// `Outcome<SecretAlertDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SecretAlertArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAlertDetail {
    pub secret: SecretFinding,
    pub locations: Vec<SecretLocation>,
    pub activity: Vec<AlertActivity>,
    pub requests: Vec<BypassRequest>,
    /// Whether this kind of secret can be checked with its issuer.
    pub checkable: bool,
    /// Whether the viewer may bypass it directly, may only ask, or neither.
    pub can_bypass: bool,
    pub can_request_bypass: bool,
}

/// `bypass`: lets a blocked secret through push protection with a reason,
/// recorded on the alert and in the audit log. Write and up; with
/// delegated bypass on, only those who review requests (owners and the
/// repository's admins) bypass directly, and anyone else's call makes a
/// request instead. Returns `Outcome<BypassResult>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BypassArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub reason: BypassReason,
    #[serde(default)]
    pub comment: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassResult {
    pub secret: SecretFinding,
    /// The request made, when delegated bypass needs approval.
    pub request: Option<BypassRequest>,
}

/// `bypass_requests`: a workspace's requests (or one repository's), newest
/// first. Members see their own; reviewers see all. Returns
/// `Outcome<Vec<BypassRequest>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BypassRequestsArgs {
    pub viewer: Option<User>,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// `pending`, `approved`, `denied`, `cancelled`; all when absent.
    #[serde(default)]
    pub state: Option<String>,
}

/// `review_bypass`: approves or denies a request (owners and the
/// repository's admins), or cancels one's own. Returns
/// `Outcome<BypassRequest>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewBypassArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
    /// `approve`, `deny` or `cancel`.
    pub decision: String,
    #[serde(default)]
    pub comment: String,
}

/// `check_validity`: asks the issuer whether a secret still works.
/// Write and up; needs validity checks on for the workspace. Returns
/// `Outcome<SecretFinding>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CheckValidityArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
}

/// `check_secret` (repos): finds the secret with `fingerprint` at
/// `commit`:`path` near `line` and asks its issuer about it. The value
/// never leaves the repos service except to the issuer's own API.
/// Returns `SecretValidity`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSecretArgs {
    pub repo_id: String,
    pub commit: String,
    pub path: String,
    pub line: u32,
    pub kind: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValidity {
    /// `active`, `inactive`, `unknown` or `unsupported`.
    pub validity: String,
    /// Why it is unknown, when it is.
    pub detail: Option<String>,
}

// --- Code scanning ----------------------------------------------------------

/// A code scanning alert: one problem a tool reports on the default
/// branch, the same alert across analyses by its fingerprint.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAlert {
    /// `cod_…`.
    pub id: String,
    /// Per repository, from 1.
    pub number: u32,
    pub repo_id: String,
    pub tool: String,
    pub category: String,
    pub rule_id: String,
    pub rule_name: Option<String>,
    pub rule_description: Option<String>,
    pub help: Option<String>,
    pub help_uri: Option<String>,
    pub tags: Vec<String>,
    /// `error`, `warning`, `note` or `none`.
    pub level: String,
    /// `critical`, `high`, `medium` or `low`, for security rules.
    pub security_severity: Option<String>,
    /// What lists sort by: the security severity, else from the level.
    pub severity: String,
    pub message: String,
    pub path: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub start_column: Option<u32>,
    pub end_column: Option<u32>,
    pub state: AlertState,
    pub fingerprint: String,
    pub first_commit: String,
    pub last_commit: String,
    pub created_at: String,
    pub updated_at: String,
    pub fixed_at: Option<String>,
    pub dismissed_by: Option<String>,
    pub dismissed_reason: Option<DismissReason>,
    pub dismissed_comment: Option<String>,
    pub dismissed_at: Option<String>,
    /// The issue g1t was put on to fix it.
    pub issue: Option<u32>,
}

/// One upload's run of one tool on one commit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// `ana_…`.
    pub id: String,
    pub repo_id: String,
    pub sarif_id: String,
    pub tool: String,
    pub tool_version: Option<String>,
    pub category: String,
    pub commit_sha: String,
    /// `refs/heads/main`, `refs/pull/3/head`.
    pub git_ref: String,
    /// The pull request it is for, if any.
    pub pull: Option<u32>,
    pub results: u32,
    /// Alerts it opened, and fixed (on the default branch only).
    pub new_alerts: u32,
    pub fixed_alerts: u32,
    /// Results past the limit, not kept.
    pub dropped: u32,
    pub created_at: String,
}

/// `upload_sarif`: reads a SARIF upload into analyses and alerts. Write
/// and up (a workflow's token can). Returns `Outcome<SarifUpload>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSarifArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub commit_sha: String,
    /// `refs/heads/<branch>` or `refs/pull/<number>/head` (or `/merge`).
    pub git_ref: String,
    /// The SARIF document, gzipped and base64-encoded.
    pub sarif: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Where the files were checked out, to make absolute paths relative.
    #[serde(default)]
    pub checkout_uri: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SarifUpload {
    /// `sar_…`.
    pub id: String,
    /// `complete` or `failed`.
    pub processing_status: String,
    pub analyses: Vec<String>,
    pub errors: Vec<String>,
    pub commit_sha: String,
    pub git_ref: String,
    pub created_at: String,
}

/// `sarif_status`: one upload. Returns `Outcome<SarifUpload>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SarifStatusArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub id: String,
}

/// `code_scanning`: a repository's alerts (newest 1,000) and recent
/// analyses. Write and up. Returns `Outcome<CodeScanning>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CodeScanningArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeScanning {
    pub alerts: Vec<CodeAlert>,
    pub analyses: Vec<Analysis>,
    pub entitled: bool,
    pub private: bool,
    /// Whether a starter workflow is on the default branch.
    pub configured: bool,
}

/// `code_alert`: one alert by number, with its activity and the pull
/// requests that reported it. Returns `Outcome<CodeAlertDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CodeAlertArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub number: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAlertDetail {
    pub alert: CodeAlert,
    pub activity: Vec<AlertActivity>,
    /// Analyses that reported it, newest first.
    pub analyses: Vec<Analysis>,
}

/// `set_code_alert_state`: dismisses (with `false_positive`, `wont_fix` or
/// `used_in_tests`) or reopens a code scanning alert. Write and up.
/// Returns `Outcome<CodeAlert>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetCodeAlertStateArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    /// `dismissed` or `open`.
    pub state: AlertState,
    #[serde(default)]
    pub reason: Option<DismissReason>,
    #[serde(default)]
    pub comment: String,
}

/// `pull_code_scanning`: what code scanning found on a pull request's head,
/// for its Security results page. Returns `Outcome<PullScanning>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct PullScanningArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub number: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullScanning {
    pub commit: Option<String>,
    pub results: Vec<PullResult>,
    pub review: Option<DependencyReview>,
    /// The check's state and line, as the pull request shows it.
    pub code_status: Option<String>,
    pub code_description: Option<String>,
}

/// A result on a pull request's head.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub tool: String,
    pub rule_id: String,
    pub level: String,
    pub severity: String,
    pub security_severity: Option<String>,
    pub message: String,
    pub path: Option<String>,
    pub line: Option<u32>,
    /// Not open on the default branch: this pull request brings it.
    pub new: bool,
    /// On a line the pull request adds.
    pub on_changed_line: bool,
    /// Whether it fails the check.
    pub failing: bool,
}

/// `fix_alert`: puts g1t on an issue to fix a code scanning alert, a
/// vulnerable dependency or a leaked secret (removing it from the code;
/// rotating it stays with you). Write and up, and agents allowed to run.
/// The agent's work is billed as agent usage. Returns
/// `Outcome<AlertFix>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct FixAlertArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// `cod_…`, `vul_…` or `sec_…`.
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertFix {
    pub issue: u32,
    /// Whether an agent was started on it.
    pub started: bool,
    pub message: Option<String>,
}

// --- Supply chain -----------------------------------------------------------

/// One package in the dependency graph.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDependency {
    /// `npm`, `crates.io`, `Go`, `PyPI`.
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub manifest: String,
    /// `direct`, `transitive` or `unknown`.
    pub relationship: String,
    pub development: bool,
    pub license: Option<String>,
    pub purl: String,
    /// Open vulnerability alerts on it.
    pub vulnerabilities: u32,
}

/// `dependency_graph`: the packages the lockfiles on the default branch
/// resolve. Write and up. Returns `Outcome<DependencyGraph>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyGraphArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGraph {
    pub commit: Option<String>,
    pub manifests: Vec<GraphManifest>,
    pub dependencies: Vec<GraphDependency>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphManifest {
    pub path: String,
    pub ecosystem: String,
    pub dependencies: u32,
    pub direct: u32,
}

/// `sbom`: the dependency graph as an SPDX 2.3 JSON document. Returns
/// `Outcome<serde_json::Value>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SbomArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
}

/// `dependency_review`: compares the dependencies at `base` and `head`
/// (commits, branches or tags). Returns `Outcome<DependencyReview>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyReviewArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub base: String,
    pub head: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReview {
    pub base: String,
    pub head: String,
    pub changes: Vec<ReviewChange>,
    pub passed: bool,
    pub headline: String,
    /// The policy it was judged by.
    pub fail_on: String,
    pub deny_licenses: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChange {
    /// `added` or `removed`.
    pub change_type: String,
    pub manifest: String,
    pub ecosystem: String,
    pub name: String,
    pub version: String,
    pub relationship: String,
    pub development: bool,
    pub license: Option<String>,
    pub purl: String,
    pub vulnerabilities: Vec<ReviewVulnerability>,
    pub denied_license: bool,
    /// Whether it fails the review.
    pub failing: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVulnerability {
    pub advisory: String,
    pub osv_id: String,
    pub summary: String,
    pub severity: String,
    pub fixed_version: Option<String>,
    pub url: String,
}

// --- The workspace's overview ------------------------------------------------

/// `security_overview`: totals, trends, coverage and the repositories most
/// in need, across a workspace. Members only; private repositories count
/// only with the activation. Returns `Outcome<WorkspaceOverview>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceOverviewArgs {
    pub viewer: Option<User>,
    pub workspace: String,
    /// Days of trend, 7 to 90.
    #[serde(default)]
    pub days: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOverview {
    pub activated: bool,
    /// Private repositories left out for want of the activation.
    pub private_hidden: u32,
    pub totals: Vec<TypeTotals>,
    pub trend: Vec<TrendPoint>,
    pub repos: Vec<RepoCoverage>,
}

/// Open alerts of one type, and how many opened and closed lately.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTotals {
    pub alert_type: String,
    pub open: SeverityCounts,
    pub opened: u32,
    pub closed: u32,
}

/// Open alerts by type on one day.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    /// `YYYY-MM-DD`.
    pub day: String,
    pub secret_scanning: u32,
    pub code_scanning: u32,
    pub vulnerability: u32,
}

/// One repository: what is on, and what is open.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCoverage {
    pub repo_id: String,
    pub name: String,
    pub private: bool,
    pub custom_patterns: u32,
    pub validity_checks: bool,
    /// When code scanning last reported, if ever.
    pub code_scanning_at: Option<String>,
    pub dependency_review: bool,
    pub security_updates: bool,
    pub lockfiles: u32,
    pub secrets: SeverityCounts,
    pub code: SeverityCounts,
    pub vulnerabilities: SeverityCounts,
}

/// `workspace_alerts`: alerts of one type across a workspace, for the API.
/// Returns `Outcome<Vec<WorkspaceAlert>>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAlertsArgs {
    pub viewer: Option<User>,
    pub workspace: String,
    pub alert_type: AlertType,
}

/// An alert of any type, with its repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAlert {
    pub repo: String,
    #[serde(default)]
    pub secret: Option<SecretFinding>,
    #[serde(default)]
    pub code: Option<CodeAlert>,
    #[serde(default)]
    pub vulnerability: Option<crate::security::Vulnerability>,
}

// --- Events ------------------------------------------------------------------

/// What every security event carries (`secret_scanning_alert.created`,
/// `code_scanning_alert.fixed`, `vulnerability_alert.dismissed`,
/// `secret_scanning.bypass_requested`, …), for webhooks and the inbox.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityEvent {
    pub repo_id: String,
    pub alert_id: String,
    /// `secret_scanning`, `code_scanning` or `vulnerability`.
    pub alert_type: String,
    /// A code scanning alert's number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert_number: Option<u32>,
    pub severity: String,
    /// One line: "An AWS access key in config/prod.env".
    pub title: String,
    /// The alert's page, from the site's root: `/acme/rocket/security/…`.
    pub link: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// `open`, `dismissed` or `fixed`.
    pub state: String,
    /// A dismissal's or bypass's reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// For a blocked push: who pushed it, by username.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pusher: Option<String>,
    /// People to tell besides the repository's security watchers: its
    /// workspace's owners, for a new alert or a bypass request, and the
    /// requester, for a reviewed one. Usernames.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notify: Vec<String>,
    /// A bypass request's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// The security event types, as webhooks list them.
pub const EVENT_TYPES: [&str; 14] = [
    "secret_scanning_alert.created",
    "secret_scanning_alert.fixed",
    "secret_scanning_alert.dismissed",
    "secret_scanning_alert.reopened",
    "secret_scanning.bypass_requested",
    "secret_scanning.bypass_reviewed",
    "code_scanning_alert.created",
    "code_scanning_alert.fixed",
    "code_scanning_alert.dismissed",
    "code_scanning_alert.reopened",
    "vulnerability_alert.created",
    "vulnerability_alert.fixed",
    "vulnerability_alert.dismissed",
    "vulnerability_alert.reopened",
];

/// The checks the suite reports on pull requests, as commit statuses:
/// require them in branch protection to gate merges.
pub const CODE_SCANNING_CHECK: &str = "Code scanning";
pub const DEPENDENCY_REVIEW_CHECK: &str = "Dependency review";

/// The starter workflow "Set up code scanning" opens a pull request with.
pub const STARTER_WORKFLOW_PATH: &str = ".g1t/workflows/code-scanning.yml";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alert_ids_say_their_type() {
        assert_eq!(AlertType::of_id("sec_1"), Some(AlertType::SecretScanning));
        assert_eq!(AlertType::of_id("cod_1"), Some(AlertType::CodeScanning));
        assert_eq!(AlertType::of_id("vul_1"), Some(AlertType::Vulnerability));
        assert_eq!(AlertType::of_id("x"), None);
        for kind in AlertType::ALL {
            assert_eq!(AlertType::parse(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn every_alert_type_has_its_four_events() {
        for kind in AlertType::ALL {
            for action in ["created", "fixed", "dismissed", "reopened"] {
                assert!(EVENT_TYPES.contains(&format!("{}.{action}", kind.event_prefix()).as_str()));
            }
        }
    }

    #[test]
    fn a_bypass_for_a_real_secret_leaves_the_alert_open() {
        assert_eq!(BypassReason::WillFixLater.dismissal(), None);
        assert_eq!(BypassReason::UsedInTests.dismissal(), Some(DismissReason::UsedInTests));
        assert_eq!(BypassReason::parse("false_positive"), Some(BypassReason::FalsePositive));
    }

    #[test]
    fn the_refusal_says_how_to_start_the_plan() {
        let message = needs_activation(PaidFeature::CodeScanning, "acme");
        assert!(message.starts_with("Code scanning on private repositories comes with the g1t plan"));
        assert!(message.contains("/acme/-/billing") && message.contains("Public repositories have it free"));
    }
}
