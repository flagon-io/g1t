//! Memory that fills itself. Kept by the work service, beside memory.
//!
//! What agents and people learn arrives as a **candidate**: from what an
//! agent reports learning at the end of a run, a person's correction in a
//! review of an agent's pull request, a merged pull request's decision, or
//! a project's own docs and manifests. A candidate is given to no agent
//! until it is **kept**: by a member in the Review queue, or by g1t when
//! two independent sources say the same thing, or a doc says it with high
//! confidence ([`promotes`]). Nothing that looks like a secret is stored.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::agents::{Memory, MemoryKind, MemoryScope, MemoryStatus};
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// The confidence at or above which a doc's word is kept without review.
pub const DOC_CONFIDENCE: f64 = 0.85;
/// How many independent sources keep a candidate without review.
pub const INDEPENDENT_SOURCES: usize = 2;
/// The most items one capture takes.
pub const MAX_CAPTURE: usize = 50;
/// The most an agent reports learning in one run.
pub const MAX_LEARNED: usize = 8;
/// The longest piece of evidence kept, in characters.
pub const MAX_EVIDENCE_CHARS: usize = 400;

/// Where a captured memory came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureSource {
    /// An agent's run, reporting what it learned.
    Run,
    /// A person's review of an agent's pull request.
    Review,
    /// A merged pull request.
    Pr,
    /// A project's README, AGENTS.md, docs or manifests.
    Doc,
    /// Written by a person.
    Manual,
}

impl CaptureSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureSource::Run => "run",
            CaptureSource::Review => "review",
            CaptureSource::Pr => "pr",
            CaptureSource::Doc => "doc",
            CaptureSource::Manual => "manual",
        }
    }
}

/// Whether a candidate is kept without anyone reviewing it: said by
/// `sources` independent sources, or by a doc with `confidence` at or above
/// [`DOC_CONFIDENCE`].
pub fn promotes(sources: usize, kind: CaptureSource, confidence: Option<f64>) -> bool {
    sources >= INDEPENDENT_SOURCES
        || (kind == CaptureSource::Doc && confidence.is_some_and(|c| c >= DOC_CONFIDENCE))
}

/// A memory's text folded for comparing: lowercase words and digits, one
/// space apart, so wording that differs only in case, punctuation or
/// spacing is the same memory.
pub fn fingerprint(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// One thing learned, as a source reports it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureItem {
    pub scope: MemoryScope,
    /// For a project's memory: its repository's id.
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub kind: MemoryKind,
    pub text: String,
    /// 0 to 1.
    #[serde(default)]
    pub confidence: Option<f64>,
    pub source: CaptureSource,
    /// What it came from: `run:<id>`, `comment:<id>`, `pull:<repo id>#<n>`,
    /// `doc:<repo id>:<path>`. Two items with the same reference are one
    /// source, however often they arrive.
    pub reference: String,
    /// What it was learned from, quoted.
    #[serde(default)]
    pub evidence: Option<String>,
    /// The pull request it was learned on.
    #[serde(default)]
    pub number: Option<u32>,
    /// The agent run it was learned in.
    #[serde(default)]
    pub run_id: Option<String>,
}

/// `capture_memories`: candidates from a service (the context service's
/// backfill and doc reading). Called by services only. Returns `Captured`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMemoriesArgs {
    /// The workspace's slug.
    pub workspace: String,
    pub items: Vec<CaptureItem>,
    /// Who it is recorded as written by, such as `g1t`.
    #[serde(default)]
    pub by: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    /// New candidates.
    pub added: u32,
    /// Ones that matched a memory already there, as another sighting.
    pub merged: u32,
    /// Ones kept by the promotion rule, new or merged.
    pub kept: u32,
    /// Ones refused: empty, too long, or holding something like a secret.
    pub refused: u32,
}

/// What an agent says it learned, as the harness reports it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedItem {
    /// `fact`, `convention`, `decision` or `gotcha`.
    #[serde(default)]
    pub kind: Option<String>,
    /// `project` or `workspace`.
    #[serde(default)]
    pub scope: Option<String>,
    pub text: String,
    /// What showed it: a command's output, a file, a failing test.
    #[serde(default)]
    pub evidence: Option<String>,
}

/// `report_learned`: a sandbox reporting what its agent learned, with the
/// run's token. Each item arrives as a candidate from the run. Returns
/// `Outcome<Captured>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportLearnedArgs {
    pub run_id: String,
    pub token: String,
    pub items: Vec<LearnedItem>,
}

/// `list_candidates`: memory waiting for review in a workspace and, with
/// `repo`, only that project's. Members only. Returns `Outcome<Vec<Memory>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListCandidatesArgs {
    pub viewer: Viewer,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Keep,
    Dismiss,
}

/// `review_memory`: a member keeps a candidate, edited or as it is, or
/// dismisses it. A dismissed memory is not suggested again from the same
/// wording. Returns `Outcome<Memory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewMemoryArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
    pub decision: ReviewDecision,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub kind: Option<MemoryKind>,
}

/// `memories_by_id`: memories as the context service indexes them, in any
/// status, so a dismissed one can be taken out of search. Services only.
/// Returns `Vec<Memory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoriesByIdArgs {
    pub workspace: String,
    pub ids: Vec<String>,
}

/// `search_memories`: kept memories in a workspace whose text has every
/// word of `query`, pinned first; with `repo_ids`, only the workspace's own
/// and those projects'. Services only: the caller has decided the viewer
/// may read the workspace's memory. Returns `Vec<Memory>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemoriesArgs {
    pub workspace: String,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub repo_ids: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<MemoryStatus>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `seed_from_pulls`: decision candidates from a repository's last merged
/// pull requests, and convention candidates from people's reviews of its
/// agents' ones. Services only (the backfill). Returns `Captured`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedFromPullsArgs {
    pub repo_id: String,
    /// At most 50; 20 if not given.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Memories, newest first, for listing a review queue.
pub type Candidates = Vec<Memory>;

/// The `memory.changed` event: a memory was added, changed, reviewed or
/// forgotten. Carries no text; a subscriber asks for the memory by id. Its
/// `repo_id` is the project's for a project's memory, none for the
/// workspace's.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryChanged {
    pub memory_id: String,
    pub workspace: String,
    /// `candidate`, `kept` or `dismissed`; `deleted` once forgotten.
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_independent_sources_keep_a_candidate() {
        assert!(!promotes(1, CaptureSource::Run, Some(0.9)));
        assert!(promotes(2, CaptureSource::Run, None));
        assert!(promotes(3, CaptureSource::Review, Some(0.1)));
    }

    #[test]
    fn a_confident_doc_is_kept_and_a_doubtful_one_waits() {
        assert!(promotes(1, CaptureSource::Doc, Some(0.9)));
        assert!(promotes(1, CaptureSource::Doc, Some(DOC_CONFIDENCE)));
        assert!(!promotes(1, CaptureSource::Doc, Some(0.6)));
        assert!(!promotes(1, CaptureSource::Doc, None));
        // Only a doc's confidence counts on its own.
        assert!(!promotes(1, CaptureSource::Pr, Some(1.0)));
    }

    #[test]
    fn fingerprints_ignore_case_punctuation_and_spacing() {
        assert_eq!(fingerprint("Use  pnpm, never npm!"), "use pnpm never npm");
        assert_eq!(fingerprint("use pnpm never NPM"), fingerprint("Use pnpm; never npm."));
        assert_ne!(fingerprint("use pnpm"), fingerprint("use npm"));
    }
}
