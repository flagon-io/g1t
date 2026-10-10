//! Repository backups: a nightly `git bundle` of every repository whose
//! refs changed, kept outside the git store.
//!
//! The repos service decides what is due and keeps the bundles and their
//! manifests (services/repos/src/backups.rs). It cannot run git, so the
//! bundle is cut where git runs: a sandbox the runner starts, which only
//! ever calls out, as a merge check does.
//!
//! 1. Each night the repos service queues the repositories whose refs
//!    moved since their last backup.
//! 2. The runner's sweep claims a few at a time (`claim_backups`) and starts
//!    a sandbox for each, with the job's id and token and nothing else.
//! 3. The sandbox asks for its job (`POST api.g1t.sh/backups/{job}/spec`):
//!    a read-only git credential for the repository, minutes long, and the
//!    commits the last bundle ended at. It clones, cuts the bundle, sends
//!    it in parts (`PUT .../parts/{n}`), and says what it holds
//!    (`POST .../complete`), or why it could not (`POST .../fail`).
//!
//! The job's token, in the `x-g1t-backup-token` header, is the only
//! credential the sandbox holds for g1t; it lasts as long as the job.
//!
//! What the runner and the repos service exchange is camelCase, as between
//! every service. What the sandbox sends and is sent is snake_case: it is
//! the API's.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;

/// A bundle is sent in parts of this size; the last may be smaller.
pub const PART_BYTES: u64 = 32 * 1024 * 1024;
/// The header the sandbox sends its job's token in.
pub const TOKEN_HEADER: &str = "x-g1t-backup-token";

/// `claim_backups`: up to `limit` queued backups, so long as no more than
/// `max_running` are then running. Returns `Vec<BackupClaim>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimBackupsArgs {
    pub limit: u32,
    pub max_running: u32,
}

/// One backup to start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupClaim {
    pub job_id: String,
    /// Lets the sandbox, and nothing else, do this job.
    pub token: String,
    pub repo_id: String,
    /// Where the repository is now: for the sandbox's name and the logs.
    pub path: RepoPath,
}

/// What kind of bundle a job cuts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupKind {
    /// Everything the repository has.
    Full,
    /// What is new since the last bundle: its prerequisites are the commits
    /// the last bundle's refs pointed to.
    Incremental,
}

impl BackupKind {
    /// How a bundle's file name says what it is.
    pub fn suffix(self) -> &'static str {
        match self {
            BackupKind::Full => "full",
            BackupKind::Incremental => "incr",
        }
    }
}

/// `backup_spec`, `backup_part` and the job's other calls: which job, and
/// its token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupJobArgs {
    pub job_id: String,
    pub token: String,
}

/// The job, as the sandbox is given it. `Outcome<BackupSpec>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupSpec {
    pub kind: BackupKind,
    /// The repository in the git store, and a read-only credential for it
    /// that lasts minutes (sent as `Authorization: Bearer`).
    pub remote: String,
    pub git_token: String,
    /// For an incremental bundle: the commits it may leave out, and every
    /// commit they reach. Empty for a full one.
    pub prerequisites: Vec<String>,
    /// The refs the last bundle held. When the clone has exactly these,
    /// nothing has changed and no bundle is cut.
    pub previous_refs: BTreeMap<String, String>,
    pub part_bytes: u64,
}

/// A part the repos service has kept: what completing the upload needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupPart {
    pub number: u16,
    pub etag: String,
}

/// `backup_complete`: the bundle is cut and sent. `Outcome<bool>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupComplete {
    pub job_id: String,
    pub token: String,
    /// Every ref the bundle holds (`git for-each-ref` of the clone, and
    /// `HEAD`), by name.
    pub refs: BTreeMap<String, String>,
    /// The bundle's size; 0 when there was nothing new to bundle.
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub parts: Vec<BackupPart>,
    /// What the clone read from the git store, for its meters.
    #[serde(default)]
    pub fetched_bytes: u64,
}

/// `backup_fail`: the job could not be done. `Outcome<bool>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupFail {
    pub job_id: String,
    pub token: String,
    pub error: String,
    #[serde(default)]
    pub fetched_bytes: u64,
}
