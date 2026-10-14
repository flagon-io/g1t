//! Decision records, what the merge queue learns when changes are combined,
//! and why a line of code is the way it is.
//!
//! A decision record is a structured reason with a confidence: `claimed`
//! when an agent or a person said so, `tested` when a check or a combination
//! of pull requests proved it, `approved` when a person approved it. The
//! work service records the tested and approved ones itself (integration
//! results, approvals, merges); `record_decision` records claimed ones.

use serde::{Deserialize, Serialize};

use crate::repos::{Commit, RepoPath};
use crate::work::SessionEntry;
use crate::{User, Viewer};

/// What a decision is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    /// Why a change is made the way it is.
    Proposal,
    /// Something said to be true about the work, such as what it fixes.
    Claim,
    /// The merge queue found that a combination of pull requests fails.
    IntegrationFailure,
    /// The merge queue found that a combination of pull requests passes.
    IntegrationPassed,
    /// What was changed to fix a failure.
    Fix,
    /// A person approved the pull request.
    Approval,
    /// It was merged.
    Merge,
    /// Anything else worth keeping.
    Note,
}

impl DecisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionKind::Proposal => "proposal",
            DecisionKind::Claim => "claim",
            DecisionKind::IntegrationFailure => "integration_failure",
            DecisionKind::IntegrationPassed => "integration_passed",
            DecisionKind::Fix => "fix",
            DecisionKind::Approval => "approval",
            DecisionKind::Merge => "merge",
            DecisionKind::Note => "note",
        }
    }

    pub fn parse(kind: &str) -> Option<DecisionKind> {
        serde_json::from_value(serde_json::Value::String(kind.to_owned())).ok()
    }

    /// The kinds `record_decision` takes. The others are what g1t saw
    /// happen, and only g1t records them.
    pub const RECORDABLE: [DecisionKind; 4] =
        [DecisionKind::Proposal, DecisionKind::Claim, DecisionKind::Fix, DecisionKind::Note];
}

/// How sure the record is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionConfidence {
    /// Someone said so.
    Claimed,
    /// A check or a combination of pull requests proved it.
    Tested,
    /// A person approved it.
    Approved,
}

impl DecisionConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionConfidence::Claimed => "claimed",
            DecisionConfidence::Tested => "tested",
            DecisionConfidence::Approved => "approved",
        }
    }
}

/// One decision record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    /// The issue it is about, when known.
    pub issue: Option<u32>,
    /// The pull request it is about, when known.
    pub pull: Option<u32>,
    /// The session it was recorded in, if one was named.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Username of who recorded it; absent when g1t did.
    pub actor: Option<String>,
    pub kind: DecisionKind,
    pub confidence: DecisionConfidence,
    pub summary: String,
    /// What it rests on, as an object: the commit, the check (`name`,
    /// `conclusion`, `url`), the `combination` of pull requests tested
    /// together, `other_pulls`, `suspects`, `bisected`, and for a failure
    /// with nothing ahead, `landed`.
    pub evidence: serde_json::Value,
    /// RFC 3339.
    pub created_at: String,
}

/// `record_decision`: an agent's or a person's decision on a pull request,
/// recorded as `claimed`. Returns `Outcome<Decision>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDecisionArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// The pull request's number.
    pub number: u32,
    pub kind: DecisionKind,
    pub summary: String,
    #[serde(default)]
    pub evidence: Option<serde_json::Value>,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// `list_decisions`: the decisions on an issue (and on its pull requests)
/// or on a pull request, oldest first. Returns `Outcome<Vec<Decision>>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDecisionsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    /// An issue's or a pull request's number: they share a sequence.
    pub number: u32,
}

/// The check that failed a combined state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedCheck {
    /// The check's name, such as `CI / merge_group`; `merge` for a merge
    /// conflict, `build` when the state could not be built.
    pub name: String,
    /// `failure`, `error`, `missing` (a required check never reported),
    /// or `conflict`.
    pub conclusion: String,
    /// Where to see it, such as the workflow run's page.
    #[serde(default)]
    pub url: Option<String>,
}

/// `integration.failed`: a combined state in the merge queue failed, and
/// g1t worked out which pull request answers for it and which others it
/// breaks with.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationFailed {
    pub repo_id: String,
    pub pull_id: String,
    /// The responsible pull request, as `pull`.
    pub number: u32,
    pub pull: u32,
    /// Its issue, if it has one.
    pub issue: Option<u32>,
    /// The pull requests tested together, in queue order; the last is
    /// `pull`.
    pub combination: Vec<u32>,
    pub check: FailedCheck,
    /// Whether smaller combinations were built to narrow `suspects` down.
    pub bisected: bool,
    /// The pull requests ahead of it that it fails with. Empty when it
    /// fails by itself.
    pub suspects: Vec<u32>,
    /// The other pull requests in `combination`.
    pub other_pulls: Vec<u32>,
    /// With nothing ahead of it, though its own checks pass on its head:
    /// the pull requests merged into the default branch since it branched,
    /// newest first and at most ten, any of which may be what it now fails
    /// with. It still answers for the failure. Empty otherwise.
    #[serde(default)]
    pub landed: Vec<u32>,
    /// The combined state that failed.
    pub commit: Option<String>,
}

/// `integration.passed`: a combined state in the merge queue passed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationPassed {
    pub repo_id: String,
    pub pull_id: String,
    pub number: u32,
    pub pull: u32,
    pub issue: Option<u32>,
    pub combination: Vec<u32>,
    pub commit: Option<String>,
}

/// `decision.recorded`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecorded {
    pub repo_id: String,
    /// The pull request it is about, or else its issue.
    pub number: u32,
    pub issue: Option<u32>,
    pub decision: Decision,
}

/// The pull request a line arrived in, as `why` shows it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhyPull {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub agent: String,
    pub merged_by: Option<String>,
    pub merged_at: Option<String>,
}

/// The issue that pull request was for.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhyIssue {
    pub number: u32,
    pub title: String,
    pub state: String,
    /// Its description, cut short when long.
    pub body: String,
}

/// The commit `why` names. Its author is named as git wrote them and by the
/// g1t account their address belongs to, when one does; the address itself
/// is never shown.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhyCommit {
    pub hash: String,
    pub tree_hash: String,
    pub message: String,
    pub author: WhyAuthor,
    pub parents: Vec<String>,
    /// RFC 3339.
    pub authored_at: String,
}

/// Who wrote a commit, without their address.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WhyAuthor {
    pub name: String,
    /// The g1t account the author's address belongs to: a confirmed or
    /// noreply address of one, or g1t's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

impl WhyCommit {
    /// `commit` as `why` shows it, its author's account `username` when known.
    pub fn of(commit: Commit, username: Option<String>) -> WhyCommit {
        WhyCommit {
            hash: commit.hash,
            tree_hash: commit.tree_hash,
            message: commit.message,
            author: WhyAuthor { name: commit.author.name, username },
            parents: commit.parents,
            authored_at: commit.authored_at,
        }
    }
}

/// `why`: why a line is the way it is. The commit that last changed it,
/// the merged pull request it arrived in, that pull request's issue, the
/// decisions recorded on them, and the session entries behind the commit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Why {
    pub path: String,
    pub line: u32,
    pub commit: WhyCommit,
    pub pull: Option<WhyPull>,
    pub issue: Option<WhyIssue>,
    pub decisions: Vec<Decision>,
    pub sessions: Vec<SessionEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn why_names_an_author_by_account_never_by_address() {
        let commit = Commit {
            hash: "7d3e".into(),
            tree_hash: "c1d2".into(),
            message: "Read retry_limit".into(),
            author: crate::repos::Signature { name: "Chase Pierce".into(), email: "syntaqx@gmail.com".into() },
            parents: vec![],
            authored_at: "2026-10-14T00:00:00Z".into(),
        };
        let known = serde_json::to_value(WhyCommit::of(commit.clone(), Some("syntaqx".into()))).unwrap();
        assert_eq!(known["author"], serde_json::json!({ "name": "Chase Pierce", "username": "syntaqx" }));
        let unknown = serde_json::to_value(WhyCommit::of(commit, None)).unwrap();
        assert_eq!(unknown["author"], serde_json::json!({ "name": "Chase Pierce" }));
        assert!(!known.to_string().contains("gmail") && !unknown.to_string().contains("gmail"));
    }


    #[test]
    fn kinds_read_and_write_as_their_names() {
        for kind in [
            DecisionKind::Proposal,
            DecisionKind::Claim,
            DecisionKind::IntegrationFailure,
            DecisionKind::IntegrationPassed,
            DecisionKind::Fix,
            DecisionKind::Approval,
            DecisionKind::Merge,
            DecisionKind::Note,
        ] {
            assert_eq!(DecisionKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        assert_eq!(DecisionKind::parse("merged"), None);
        assert!(!DecisionKind::RECORDABLE.contains(&DecisionKind::IntegrationFailure));
        assert!(!DecisionKind::RECORDABLE.contains(&DecisionKind::Approval));
        assert_eq!(serde_json::to_value(DecisionConfidence::Tested).unwrap(), "tested");
    }

    #[test]
    fn an_integration_failure_carries_number_and_issue_for_filters() {
        let event = IntegrationFailed {
            repo_id: "rep_1".into(),
            pull_id: "pr_1".into(),
            number: 14,
            pull: 14,
            issue: Some(9),
            combination: vec![11, 12, 14],
            check: FailedCheck { name: "CI / merge_group".into(), conclusion: "failure".into(), url: None },
            bisected: true,
            suspects: vec![12],
            other_pulls: vec![11, 12],
            landed: Vec::new(),
            commit: Some("abc".into()),
        };
        let sent = serde_json::to_value(&event).unwrap();
        assert_eq!(sent["number"], 14);
        assert_eq!(sent["issue"], 9);
        assert_eq!(sent["otherPulls"], serde_json::json!([11, 12]));
        assert_eq!(sent["check"]["conclusion"], "failure");
        assert_eq!(sent["landed"], serde_json::json!([]));
        // An event from before `landed` was sent still reads.
        let mut older = sent.clone();
        older.as_object_mut().unwrap().remove("landed");
        let read: IntegrationFailed = serde_json::from_value(older).unwrap();
        assert!(read.landed.is_empty());
    }
}
