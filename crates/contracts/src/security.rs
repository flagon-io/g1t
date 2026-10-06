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

/// Why a person dismissed an alert. The first four are for secrets, the
/// rest for vulnerable dependencies; see [`DismissReason::for_secrets`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DismissReason {
    /// Not a secret at all.
    FalsePositive,
    /// A value made for tests or examples.
    UsedInTests,
    /// It was real, and has been revoked or rotated: the alert is fixed.
    Revoked,
    /// Real, and accepted as it is.
    WontFix,
    /// Someone is already upgrading it.
    FixStarted,
    /// Nobody can get to it now.
    NoBandwidth,
    /// The vulnerability does not matter for how this project uses it.
    TolerableRisk,
    /// The advisory is wrong about this package or version.
    Inaccurate,
    /// The vulnerable code is never called.
    NotUsed,
}

impl DismissReason {
    pub const ALL: [DismissReason; 9] = [
        DismissReason::FalsePositive,
        DismissReason::UsedInTests,
        DismissReason::Revoked,
        DismissReason::WontFix,
        DismissReason::FixStarted,
        DismissReason::NoBandwidth,
        DismissReason::TolerableRisk,
        DismissReason::Inaccurate,
        DismissReason::NotUsed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DismissReason::FalsePositive => "false_positive",
            DismissReason::UsedInTests => "used_in_tests",
            DismissReason::Revoked => "revoked",
            DismissReason::WontFix => "wont_fix",
            DismissReason::FixStarted => "fix_started",
            DismissReason::NoBandwidth => "no_bandwidth",
            DismissReason::TolerableRisk => "tolerable_risk",
            DismissReason::Inaccurate => "inaccurate",
            DismissReason::NotUsed => "not_used",
        }
    }

    pub fn parse(text: &str) -> Option<DismissReason> {
        DismissReason::ALL.into_iter().find(|reason| reason.as_str() == text)
    }

    /// For people.
    pub fn label(self) -> &'static str {
        match self {
            DismissReason::FalsePositive => "False positive",
            DismissReason::UsedInTests => "Used in tests",
            DismissReason::Revoked => "Revoked",
            DismissReason::WontFix => "Won't fix",
            DismissReason::FixStarted => "A fix has already been started",
            DismissReason::NoBandwidth => "No bandwidth to fix this",
            DismissReason::TolerableRisk => "Risk is tolerable to this project",
            DismissReason::Inaccurate => "This alert is inaccurate or incorrect",
            DismissReason::NotUsed => "Vulnerable code is not actually used",
        }
    }

    /// Whether it closes a secret alert (the rest close dependency alerts).
    pub fn for_secrets(self) -> bool {
        matches!(
            self,
            DismissReason::FalsePositive | DismissReason::UsedInTests | DismissReason::Revoked | DismissReason::WontFix
        )
    }

    /// The status a secret takes: revoked means fixed (`resolved`); the
    /// others say it is no danger, so pushes carrying it go through
    /// (`allowed`).
    pub fn secret_status(self) -> SecretStatus {
        if self == DismissReason::Revoked { SecretStatus::Resolved } else { SecretStatus::Allowed }
    }
}

/// Where an alert stands, as the Security page's filters and the API put it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertState {
    /// Needs someone: a secret open or blocked, a dependency still vulnerable.
    Open,
    /// Someone said why it can stay.
    Dismissed,
    /// A secret revoked, or a dependency no longer vulnerable.
    Fixed,
}

impl AlertState {
    pub fn as_str(self) -> &'static str {
        match self {
            AlertState::Open => "open",
            AlertState::Dismissed => "dismissed",
            AlertState::Fixed => "fixed",
        }
    }

    pub fn parse(text: &str) -> Option<AlertState> {
        Some(match text {
            "open" => AlertState::Open,
            "dismissed" => AlertState::Dismissed,
            "fixed" => AlertState::Fixed,
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
    /// Who dismissed it (allowed or resolved it).
    pub decided_by: Option<String>,
    /// The comment given when it was dismissed.
    pub reason: Option<String>,
    pub decided_at: Option<String>,
    /// Why it was dismissed. Absent on open alerts, and on alerts decided
    /// before reasons were recorded.
    #[serde(default)]
    pub dismissed_reason: Option<DismissReason>,
    /// Why the value looks made for tests or documentation (a documented
    /// example key, a counting or repeating value), when it does. Such an
    /// alert never stops a push and is never counted as critical.
    #[serde(default)]
    pub test_value: Option<String>,
    /// Open, dismissed or fixed.
    pub state: AlertState,
}

impl SecretStatus {
    /// The alert state a secret in this status is in.
    pub fn state(self) -> AlertState {
        match self {
            SecretStatus::Open | SecretStatus::Blocked => AlertState::Open,
            SecretStatus::Allowed => AlertState::Dismissed,
            SecretStatus::Resolved => AlertState::Fixed,
        }
    }
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
    /// Why it looks like a test value, from `g1t_scan::secrets::test_value`.
    /// Such a secret is recorded but never stops a push.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_value: Option<String>,
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
    /// Where the last page stopped; `from`, or the head of the default
    /// branch, when absent.
    #[serde(default)]
    pub after: Option<String>,
    pub limit: u32,
    /// For a pushed range: its newest commit, on whichever branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// For a pushed range: where the branch was before, which is not
    /// scanned. The page ends there, with no next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
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
    /// Someone said why it can stay. Found again, it stays dismissed until
    /// someone reopens it.
    Dismissed,
}

impl VulnStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            VulnStatus::Open => "open",
            VulnStatus::Fixed => "fixed",
            VulnStatus::Dismissed => "dismissed",
        }
    }

    pub fn parse(text: &str) -> Option<VulnStatus> {
        Some(match text {
            "open" => VulnStatus::Open,
            "fixed" => VulnStatus::Fixed,
            "dismissed" => VulnStatus::Dismissed,
            _ => return None,
        })
    }

    pub fn state(self) -> AlertState {
        match self {
            VulnStatus::Open => AlertState::Open,
            VulnStatus::Fixed => AlertState::Fixed,
            VulnStatus::Dismissed => AlertState::Dismissed,
        }
    }
}

/// Where the security update for a vulnerable package stands: the pull
/// request g1t opens itself to upgrade it, on the branch
/// `g1t/security/<package>-<version>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    /// A sandbox is making the change.
    Requested,
    /// Its pull request is open, going through the required checks.
    Open,
    Merged,
    /// Closed without merging, by a person.
    Closed,
    /// A newer security update replaced it, or the package is no longer
    /// vulnerable; g1t closed it.
    Superseded,
    /// The version could not be raised without changing code: an issue
    /// was opened for g1t instead.
    NeedsCode,
    /// It could not be made; why is in `error`.
    Failed,
}

impl UpdateState {
    pub const ALL: [UpdateState; 7] = [
        UpdateState::Requested,
        UpdateState::Open,
        UpdateState::Merged,
        UpdateState::Closed,
        UpdateState::Superseded,
        UpdateState::NeedsCode,
        UpdateState::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            UpdateState::Requested => "requested",
            UpdateState::Open => "open",
            UpdateState::Merged => "merged",
            UpdateState::Closed => "closed",
            UpdateState::Superseded => "superseded",
            UpdateState::NeedsCode => "needs_code",
            UpdateState::Failed => "failed",
        }
    }

    pub fn parse(text: &str) -> Option<UpdateState> {
        UpdateState::ALL.into_iter().find(|state| state.as_str() == text)
    }

    /// Whether g1t is still working on it.
    pub fn in_progress(self) -> bool {
        matches!(self, UpdateState::Requested | UpdateState::Open | UpdateState::NeedsCode)
    }
}

/// The security update for one package.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityUpdate {
    pub state: UpdateState,
    /// The version it upgrades to.
    pub target: String,
    /// `g1t/security/<package>-<version>`.
    pub branch: Option<String>,
    /// The pull request g1t opened.
    pub pull: Option<u32>,
    /// The issue opened for g1t, when the upgrade needs code changes.
    pub issue: Option<u32>,
    /// Why it failed, when it did.
    pub error: Option<String>,
    /// RFC 3339.
    pub updated_at: String,
}

/// The prefix every security update's branch starts with.
pub const UPDATE_BRANCH_PREFIX: &str = "g1t/security/";

/// The branch a security update is made on: `g1t/security/<package>-<version>`,
/// with anything a branch name cannot hold (a scope's `@` and `/`) as `-`.
pub fn update_branch(package: &str, version: &str) -> String {
    let clean = |text: &str| -> String {
        let mut out = String::new();
        for c in text.chars() {
            let c = if c.is_ascii_alphanumeric() || matches!(c, '.' | '_') { c } else { '-' };
            if !(c == '-' && out.ends_with('-')) {
                out.push(c);
            }
        }
        out.trim_matches(['-', '.']).to_owned()
    };
    format!("{UPDATE_BRANCH_PREFIX}{}-{}", clean(package), clean(version))
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
    /// The issue opened to upgrade the package, when g1t was put on
    /// it: the upgrade needs code changes, or predates security updates.
    pub issue: Option<u32>,
    /// RFC 3339.
    pub found_at: String,
    pub fixed_at: Option<String>,
    /// Open, dismissed or fixed.
    pub state: AlertState,
    /// Who dismissed it, why, with what comment, and when.
    #[serde(default)]
    pub dismissed_by: Option<String>,
    #[serde(default)]
    pub dismissed_reason: Option<DismissReason>,
    #[serde(default)]
    pub dismissed_comment: Option<String>,
    #[serde(default)]
    pub dismissed_at: Option<String>,
    /// The security update for its package, if g1t has started one.
    #[serde(default)]
    pub update: Option<SecurityUpdate>,
}

/// Open alerts by severity: vulnerabilities open and not dismissed, and
/// secrets in the history that look real, as critical. A blocked secret
/// never landed and a likely test value is no danger, so neither counts.
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

/// Secret alerts by where they stand.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretCounts {
    /// In the history and looking real: rotate these.
    pub open: u32,
    /// Stopped at a push, so never landed, and looking real.
    pub blocked: u32,
    /// Open or blocked, but likely test values.
    pub test_values: u32,
    pub dismissed: u32,
    pub fixed: u32,
}

/// One thing that happened to an alert, for its activity log.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertActivity {
    pub id: String,
    /// The secret's or vulnerability's id.
    pub alert_id: String,
    /// `dismissed`, `reopened`, `update_requested`, `update_opened`,
    /// `update_merged`, `update_closed`, `update_superseded`,
    /// `update_needs_code` or `update_failed`.
    pub action: String,
    /// Who did it: a person's username, or `g1t`.
    pub actor: Option<String>,
    pub reason: Option<DismissReason>,
    pub comment: Option<String>,
    /// The pull request or issue it concerns.
    pub number: Option<u32>,
    /// RFC 3339.
    pub at: String,
}

/// What `.g1t/dependencies.yml` asks for: version updates, which keep
/// dependencies current whether or not they are vulnerable.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionUpdatesState {
    /// Whether the file is on the default branch.
    pub found: bool,
    /// What is wrong with it, if anything.
    pub error: Option<String>,
    /// Each entry under `updates`, as read.
    pub updates: Vec<VersionUpdateEntry>,
    /// When it was last read, RFC 3339.
    pub read_at: Option<String>,
}

/// One entry of `.g1t/dependencies.yml`'s `updates`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionUpdateEntry {
    /// `npm`, `cargo`, `go` or `pip`.
    pub ecosystem: String,
    /// Where its manifest is, from the repository's root: `/`, `/web`.
    pub directory: String,
    /// `daily`, `weekly` or `monthly`.
    pub interval: String,
    /// Groups, each a name and the package patterns it gathers.
    pub groups: Vec<UpdateGroup>,
    /// Packages never updated, or not to these versions.
    pub ignore: Vec<UpdateIgnore>,
    /// Version update pull requests open at once, at most.
    pub open_pull_requests_limit: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateGroup {
    pub name: String,
    /// Package names, with `*` for any run of characters.
    pub patterns: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateIgnore {
    /// A package name, with `*` for any run of characters.
    pub dependency: String,
    /// Version requirements to skip, such as `>=5`; all when empty.
    pub versions: Vec<String>,
}

/// Everything the Security page shows for one repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityOverview {
    pub repo_id: String,
    /// Open alerts by severity; see [`SeverityCounts`].
    pub counts: SeverityCounts,
    pub secret_counts: SecretCounts,
    pub secrets: Vec<SecretFinding>,
    pub vulnerabilities: Vec<Vulnerability>,
    /// What happened to the alerts, newest first.
    pub activity: Vec<AlertActivity>,
    pub scan: ScanState,
    /// Security updates: whether g1t opens a pull request to upgrade each
    /// vulnerable dependency that has a fix.
    pub upkeep: bool,
    pub version_updates: VersionUpdatesState,
}

/// `overview`: members of the workspace only. Returns
/// `Outcome<SecurityOverview>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OverviewArgs {
    pub repo: RepoPath,
    pub viewer: Option<User>,
}

/// `dismiss`: closes an alert with a reason and an optional comment. A
/// secret takes Admin on the repository (a dismissed secret is let through
/// push protection, unless it was revoked); a vulnerable dependency takes
/// Write. Returns `Outcome<AlertChange>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DismissArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// A secret's id (`sec_…`) or a vulnerability's (`vul_…`).
    pub id: String,
    pub reason: DismissReason,
    #[serde(default)]
    pub comment: String,
}

/// `reopen`: opens a dismissed alert again, with the same roles as
/// `dismiss`. Returns `Outcome<AlertChange>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReopenArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
}

/// The alert `dismiss` or `reopen` changed, as it is now: one of the two.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertChange {
    pub secret: Option<SecretFinding>,
    pub vulnerability: Option<Vulnerability>,
}

/// `rescan`: scans the dependencies again now, and the history from the
/// start. Members only. Returns `Outcome<ScanState>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RescanArgs {
    pub actor: User,
    pub repo: RepoPath,
}

/// `set_upkeep`: security updates on or off: whether g1t opens a pull
/// request to upgrade each vulnerable dependency that has a fix. Maintain
/// and up. Returns `Outcome<bool>`.
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

/// `bump` (runner): makes a security update in a sandbox. It clones the
/// default branch, raises `package` to `version` in each lockfile with the
/// ecosystem's own tool (`npm`, `cargo`, `go`, `pip`), commits that as g1t
/// (`g1t <g1t@users.noreply.g1t.sh>`) and pushes it to `branch`, which must
/// start with [`UPDATE_BRANCH_PREFIX`]. The push is what tells the security
/// service to open the pull request. Returns `Outcome<bool>`: whether the
/// sandbox started.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BumpArgs {
    pub repo: RepoPath,
    /// OSV's name for the ecosystem: `npm`, `crates.io`, `Go` or `PyPI`.
    pub ecosystem: String,
    pub package: String,
    pub version: String,
    /// The lockfiles that resolve a vulnerable version, from the root.
    pub lockfiles: Vec<String>,
    pub branch: String,
    /// The commit's message.
    pub message: String,
}
