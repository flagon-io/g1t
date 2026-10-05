//! The security service: secrets found in what is pushed and in history,
//! vulnerable dependencies, and the upgrades g1t opens for them.
//!
//! The repos service reads git for it (`scan_history`, `find_lockfiles`)
//! and asks it, during a push, which secrets have been allowed
//! (`push_blocked`). Members of a workspace see and act on its findings;
//! nobody else does, whether or not the repository is public.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::repos::RepoPath;

/// Where a secret stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretStatus {
    /// In the repository's history: it has to be rotated, then resolved.
    Open,
    /// A push carrying it was refused, so it never landed.
    Blocked,
    /// Someone said it is not a real secret; pushes carrying it go through.
    Allowed,
    /// Someone rotated or removed it.
    Resolved,
}

impl SecretStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SecretStatus::Open => "open",
            SecretStatus::Blocked => "blocked",
            SecretStatus::Allowed => "allowed",
            SecretStatus::Resolved => "resolved",
        }
    }

    pub fn parse(text: &str) -> Option<SecretStatus> {
        Some(match text {
            "open" => SecretStatus::Open,
            "blocked" => SecretStatus::Blocked,
            "allowed" => SecretStatus::Allowed,
            "resolved" => SecretStatus::Resolved,
            _ => return None,
        })
    }
}

/// A secret found in a repository. The secret itself is never kept: only
/// a fingerprint, to know it again, and a preview a person recognises.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFinding {
    pub id: String,
    pub repo_id: String,
    /// `aws_access_key`, `github_token`, …
    pub kind: String,
    /// "an AWS access key".
    pub label: String,
    pub path: String,
    pub line: u32,
    pub commit: String,
    pub preview: String,
    pub status: SecretStatus,
    /// `push` or `history`.
    pub source: String,
    /// Who pushed it, for a push.
    pub found_by: Option<String>,
    /// RFC 3339.
    pub found_at: String,
    /// Who allowed or resolved it, and why.
    pub decided_by: Option<String>,
    pub reason: Option<String>,
    pub decided_at: Option<String>,
}

/// A secret as the repos service finds it, before it is stored.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSecret {
    pub fingerprint: String,
    pub kind: String,
    pub path: String,
    pub line: u32,
    pub commit: String,
    pub preview: String,
}

/// `push_blocked`: the secrets a push would add. Those allowed before are
/// returned; the rest are recorded as blocked. Called by the repos service.
/// Returns `PushVerdict`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushBlockedArgs {
    /// The repository the findings belong to: for a pull request's fork,
    /// the repository it was made from.
    pub repo_id: String,
    pub path: RepoPath,
    pub pusher: Option<String>,
    pub secrets: Vec<NewSecret>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushVerdict {
    /// Fingerprints that were allowed and so do not stop the push.
    pub allowed: Vec<String>,
    /// The finding recorded for each fingerprint that stops it.
    pub ids: Vec<(String, String)>,
}

/// `scan_history` (repos): looks for secrets in a page of the default
/// branch's history, newest first, each commit against its first parent.
/// Returns `HistoryPage`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHistoryArgs {
    pub repo_id: String,
    /// Where the last page stopped; the head of the default branch when absent.
    #[serde(default)]
    pub after: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub secrets: Vec<NewSecret>,
    pub commits: u32,
    /// Where the next page starts; none when the history is done.
    pub next: Option<String>,
    /// How many objects were read from the store: what the scan cost.
    pub reads: u32,
}

/// `find_lockfiles` (repos): the lockfiles on the default branch.
/// Returns `Lockfiles`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindLockfilesArgs {
    pub repo_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lockfiles {
    /// The commit they were read at; none for an empty repository.
    pub commit: Option<String>,
    pub files: Vec<LockfileText>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LockfileText {
    pub path: String,
    pub text: String,
}

/// Where a vulnerable dependency stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VulnStatus {
    Open,
    /// The version in use is no longer affected.
    Fixed,
}

/// One advisory against one package at the version a lockfile resolves.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vulnerability {
    pub id: String,
    pub repo_id: String,
    /// `npm`, `crates.io`, `Go`, `PyPI`.
    pub ecosystem: String,
    pub package: String,
    pub version: String,
    /// The lockfile that resolves it.
    pub manifest: String,
    /// The id people know it by (its GHSA id when it has one).
    pub advisory: String,
    pub osv_id: String,
    pub summary: String,
    /// `critical`, `high`, `medium`, `low` or `unknown`.
    pub severity: String,
    pub fixed_version: Option<String>,
    pub status: VulnStatus,
    /// The issue opened to upgrade the package.
    pub issue: Option<u32>,
    /// RFC 3339.
    pub found_at: String,
    pub fixed_at: Option<String>,
}

/// Open findings by severity.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SeverityCounts {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
}

/// How a repository's history scan stands.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanState {
    /// `pending`, `running`, `done` or `stopped` (over the workspace's limit).
    pub history: String,
    pub commits_scanned: u32,
    /// RFC 3339.
    pub history_finished_at: Option<String>,
    pub dependencies_scanned_at: Option<String>,
    /// Why the last dependency scan failed, if it did.
    pub dependencies_error: Option<String>,
    pub lockfiles: Vec<String>,
}

/// Everything the Security page shows for one repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityOverview {
    pub repo_id: String,
    /// Open vulnerabilities by severity. Open and blocked secrets are
    /// counted as critical: a leaked key is the worst thing a repository
    /// can hold.
    pub counts: SeverityCounts,
    pub secrets: Vec<SecretFinding>,
    pub vulnerabilities: Vec<Vulnerability>,
    pub scan: ScanState,
    /// Whether g1t opens upgrade issues and puts its agent on them.
    pub upkeep: bool,
}

/// `overview`: members of the workspace only. Returns
/// `Outcome<SecurityOverview>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OverviewArgs {
    pub repo: RepoPath,
    pub viewer: Option<User>,
}

/// `decide_secret`: allows a secret (not a real one, or accepted), marks it
/// resolved (rotated or removed), or opens it again. Members only; a reason
/// is required to allow or resolve. Returns `Outcome<SecretFinding>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DecideSecretArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    /// `allow`, `resolve` or `reopen`.
    pub decision: String,
    #[serde(default)]
    pub reason: String,
}

/// `rescan`: scans the dependencies again now, and the history from the
/// start. Members only. Returns `Outcome<ScanState>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RescanArgs {
    pub actor: User,
    pub repo: RepoPath,
}

/// `set_upkeep`: whether g1t opens upgrade issues for this repository and
/// puts its agent on them. Members only. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetUpkeepArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub enabled: bool,
}

/// `workspace`: every repository of a workspace that has findings, for
/// its members. Returns `Outcome<Vec<RepoSecurity>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceArgs {
    pub workspace: String,
    pub viewer: Option<User>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSecurity {
    pub repo_id: String,
    pub name: String,
    pub counts: SeverityCounts,
    pub secrets: u32,
    pub vulnerabilities: u32,
    pub upkeep: bool,
    pub dependencies_scanned_at: Option<String>,
}
