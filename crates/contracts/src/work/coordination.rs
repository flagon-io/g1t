//! Coordinating work between agents and people: sessions, claims and
//! dependencies.
//!
//! The issue is the unit of work. A **session** is one run of someone's
//! own harness (a Claude Code session, a Codex run) on a repository, by a
//! person's token, optionally attached to an issue, a pull request and a
//! branch. A **claim** is an advisory, expiring "I'm working on #N": never
//! a lock, so two can stand on one issue, and the second claimant is told
//! about the first. An issue's `blocked_by` names the issues that have to
//! land first.
//!
//! Hooks and telemetry are evidence, never truth: what git and g1t record
//! is. So sessions tolerate missed heartbeats, reconnects and duplicate
//! events: starting one is idempotent on the harness's own session id,
//! entries are idempotent on their `key`, and a session or claim that
//! went quiet is read as idle, ended or expired when it is next looked at.

use serde::{Deserialize, Serialize};

use super::{CheckStatus, Issue, Mergeable, NewSessionEntry, Overlap, PullStatus, QueueState, RequiredCheck, SessionEntry, State};
use crate::credentials::Principal;
use crate::events::Event;
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// A session with no heartbeat for this long reads as idle.
pub const SESSION_IDLE_MS: u64 = 15 * 60 * 1000;
/// A session with no heartbeat for this long has ended (`timed_out`).
pub const SESSION_TIMEOUT_MS: u64 = 2 * 60 * 60 * 1000;
/// How long a claim lasts unless renewed, in minutes.
pub const CLAIM_DEFAULT_MINUTES: u32 = 30;
/// The longest a claim may be asked to last, in minutes.
pub const CLAIM_MAX_MINUTES: u32 = 240;
/// The most issues one issue can be blocked by.
pub const MAX_BLOCKED_BY: usize = 50;
/// The most characters a session's title, a claim's note or a reason keeps.
pub const MAX_NOTE_CHARS: usize = 500;
/// The most characters an entry's idempotency key may have.
pub const MAX_KEY_CHARS: usize = 200;

/// The event types about coordinating work, which `get_work` lists as an
/// issue's recent activity (with the merge queue's, once it sends them).
pub const COORDINATION_EVENTS: [&str; 11] = [
    "session.started",
    "session.ended",
    "work.claimed",
    "work.released",
    "work.claim_expired",
    "work.handoff_requested",
    "dependency.changed",
    "overlap.detected",
    "integration.failed",
    "integration.passed",
    "decision.recorded",
];

/// The harness a session runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    ClaudeCode,
    Codex,
    Cursor,
    Copilot,
    Other,
}

impl Harness {
    pub const ALL: [Harness; 5] = [Harness::ClaudeCode, Harness::Codex, Harness::Cursor, Harness::Copilot, Harness::Other];

    pub fn as_str(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude_code",
            Harness::Codex => "codex",
            Harness::Cursor => "cursor",
            Harness::Copilot => "copilot",
            Harness::Other => "other",
        }
    }

    /// From its name, in either case, with `-` for `_`.
    pub fn parse(name: &str) -> Option<Harness> {
        let name = name.trim().to_ascii_lowercase().replace('-', "_");
        Harness::ALL.into_iter().find(|harness| harness.as_str() == name)
    }
}

/// Where a session stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// Heard from in the last 15 minutes.
    Active,
    /// Not heard from for 15 minutes; it may still come back.
    Idle,
    /// Ended, or not heard from for 2 hours (`end_reason` `timed_out`).
    Ended,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Active => "active",
            SessionState::Idle => "idle",
            SessionState::Ended => "ended",
        }
    }

    pub fn parse(name: &str) -> Option<SessionState> {
        match name.trim().to_ascii_lowercase().as_str() {
            "active" => Some(SessionState::Active),
            "idle" => Some(SessionState::Idle),
            "ended" => Some(SessionState::Ended),
            _ => None,
        }
    }

    /// A session as it reads at `now`: `ended` when it was ended or has
    /// been quiet for [`SESSION_TIMEOUT_MS`], `idle` after
    /// [`SESSION_IDLE_MS`], else `active`.
    pub fn at(ended: bool, last_seen_ms: u64, now_ms: u64) -> SessionState {
        let quiet = now_ms.saturating_sub(last_seen_ms);
        if ended || quiet >= SESSION_TIMEOUT_MS {
            SessionState::Ended
        } else if quiet >= SESSION_IDLE_MS {
            SessionState::Idle
        } else {
            SessionState::Active
        }
    }
}

/// One run of someone's own harness on a repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// `ses_…`.
    pub id: String,
    pub repo_id: String,
    /// The issue it works on, if it said.
    pub issue: Option<u32>,
    /// The pull request it works on, if it said.
    pub pull: Option<u32>,
    pub branch: Option<String>,
    /// Whose token started it.
    pub actor: Principal,
    pub harness: Harness,
    /// The harness's own id for the session, which makes starting it again
    /// return this one.
    pub harness_session_id: Option<String>,
    pub title: Option<String>,
    pub state: SessionState,
    /// The commit it last said it was at.
    pub head_commit: Option<String>,
    /// RFC 3339.
    pub started_at: String,
    /// RFC 3339: its last heartbeat or change.
    pub last_seen_at: String,
    /// RFC 3339, once ended.
    pub ended_at: Option<String>,
    /// Why it ended: what the harness said, or `timed_out`.
    pub end_reason: Option<String>,
}

/// Where a claim stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimState {
    Active,
    Released,
    Expired,
    HandedOff,
}

impl ClaimState {
    pub fn as_str(self) -> &'static str {
        match self {
            ClaimState::Active => "active",
            ClaimState::Released => "released",
            ClaimState::Expired => "expired",
            ClaimState::HandedOff => "handed_off",
        }
    }

    pub fn parse(name: &str) -> Option<ClaimState> {
        match name.trim().to_ascii_lowercase().as_str() {
            "active" => Some(ClaimState::Active),
            "released" => Some(ClaimState::Released),
            "expired" => Some(ClaimState::Expired),
            "handed_off" => Some(ClaimState::HandedOff),
            _ => None,
        }
    }
}

/// An advisory, expiring "I'm working on #N". Never a lock.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    /// `clm_…`.
    pub id: String,
    pub repo_id: String,
    /// The issue it is on.
    pub issue: u32,
    /// The session it was made from, whose heartbeats renew it.
    pub session_id: Option<String>,
    pub actor: Principal,
    pub harness: Option<Harness>,
    pub note: Option<String>,
    pub state: ClaimState,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339: when it lapses unless renewed.
    pub expires_at: String,
    /// RFC 3339, once it stopped being active.
    pub ended_at: Option<String>,
    pub end_reason: Option<String>,
    /// For a hand-off: the username it was handed to; none for anyone.
    pub handoff_to: Option<String>,
}

/// How long a claim lasts, in minutes: the default when none was asked,
/// at least one and at most [`CLAIM_MAX_MINUTES`].
pub fn claim_minutes(asked: Option<u32>) -> u32 {
    asked.unwrap_or(CLAIM_DEFAULT_MINUTES).clamp(1, CLAIM_MAX_MINUTES)
}

/// `blocked_by` as asked for `number`, de-duplicated in the order given,
/// or why it cannot be: one names `number` itself or is not an issue of
/// the repository (`issues`), there are too many, or it would close a
/// cycle through the blockers already recorded (`graph`: each issue's
/// `blocked_by`).
pub fn check_blocked_by(
    number: u32,
    asked: &[u32],
    issues: &std::collections::HashSet<u32>,
    graph: &std::collections::HashMap<u32, Vec<u32>>,
) -> Result<Vec<u32>, String> {
    let mut wanted: Vec<u32> = Vec::new();
    for blocker in asked {
        if !wanted.contains(blocker) {
            wanted.push(*blocker);
        }
    }
    if wanted.len() > MAX_BLOCKED_BY {
        return Err(format!("An issue can be blocked by at most {MAX_BLOCKED_BY} issues."));
    }
    if wanted.contains(&number) {
        return Err(format!("#{number} cannot be blocked by itself."));
    }
    if let Some(missing) = wanted.iter().find(|blocker| !issues.contains(blocker)) {
        return Err(format!("#{missing} is not an issue in this repository."));
    }
    // A cycle: some blocker is itself, through what blocks it, blocked by
    // `number`.
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<(u32, Vec<u32>)> = wanted.iter().map(|blocker| (*blocker, vec![number, *blocker])).collect();
    while let Some((at, path)) = stack.pop() {
        if !seen.insert(at) {
            continue;
        }
        for next in graph.get(&at).into_iter().flatten() {
            let mut longer = path.clone();
            longer.push(*next);
            if *next == number {
                let chain = longer.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(" → ");
                return Err(format!("That would make a cycle: {chain}, where each is blocked by the next."));
            }
            stack.push((*next, longer));
        }
    }
    Ok(wanted)
}

/// The items of an issue's "Definition of done" section: each bulleted or
/// numbered line under the heading, up to the next heading.
pub fn definition_of_done(body: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut inside = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            inside = trimmed.trim_start_matches('#').trim().eq_ignore_ascii_case("definition of done");
            continue;
        }
        if !inside {
            continue;
        }
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.split_once(". ").filter(|(n, _)| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty()).map(|(_, rest)| rest));
        if let Some(item) = item {
            let item = item.trim_start_matches("[ ] ").trim_start_matches("[x] ").trim_start_matches("[X] ").trim();
            if !item.is_empty() {
                items.push(item.to_owned());
            }
        }
    }
    items
}

/// The pairs of pull requests that overlap now, against those already
/// announced: which are new (to announce) and which cleared (to forget, so
/// that they are announced again if they come back).
pub fn overlap_changes(current: &[u32], announced: &[u32]) -> (Vec<u32>, Vec<u32>) {
    let new = current.iter().filter(|number| !announced.contains(number)).copied().collect();
    let cleared = announced.iter().filter(|number| !current.contains(number)).copied().collect();
    (new, cleared)
}

// --- Arguments --------------------------------------------------------------

/// `start_session`. Returns `Outcome<Session>`: a new one, or the one
/// already started with the same `harness_session_id` (which then takes
/// the issue, pull request, branch, title and head given).
#[derive(Debug, Serialize, Deserialize)]
pub struct StartSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub harness: Harness,
    #[serde(default)]
    pub harness_session_id: Option<String>,
    #[serde(default)]
    pub issue: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
}

/// `update_session`: changes whichever fields are given; with none, it is a
/// heartbeat. Either way it renews the session's active claims. Returns
/// `Outcome<Session>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub issue: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

/// `end_session`. Returns `Outcome<Session>`; ending one already ended
/// returns it as it is.
#[derive(Debug, Serialize, Deserialize)]
pub struct EndSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `get_work_session`: a session and its entries after `after_seq`.
/// Returns `Outcome<SessionDetail>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkSessionArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub after_seq: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionDetail {
    pub session: Session,
    /// Oldest first, numbered within the session.
    pub entries: Vec<SessionEntry>,
}

/// `list_work_sessions`: a repository's sessions, most recently heard from
/// first. Returns `Outcome<Vec<Session>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListWorkSessionsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(default)]
    pub state: Option<SessionState>,
    #[serde(default)]
    pub issue: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
}

/// An entry to record in a session. `key` makes recording it again a no-op.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyedSessionEntry {
    #[serde(flatten)]
    pub entry: NewSessionEntry,
    #[serde(default)]
    pub key: Option<String>,
}

/// `record_session_entries`. Returns `Outcome<Recorded>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RecordEntriesArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub entries: Vec<KeyedSessionEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Recorded {
    /// Entries newly recorded.
    pub recorded: u32,
    /// Entries skipped because one with the same key was recorded before.
    pub duplicates: u32,
}

/// `claim_issue`. Returns `Outcome<Claimed>`. Claiming an issue you hold
/// renews your claim (and changes its note or session when given).
#[derive(Debug, Serialize, Deserialize)]
pub struct ClaimArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub ttl_minutes: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claimed {
    pub claim: Claim,
    /// Other active claims on the issue: someone else is on it too.
    pub others: Vec<Claim>,
    /// What the issue is blocked by, and where each stands.
    pub blocked_by: Vec<Blocker>,
}

/// `release_claim`: gives up your active claim on an issue. Returns
/// `Outcome<Claim>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReleaseArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `hand_off_issue`: ends your active claim on an issue as handed off, to
/// someone (`to`, a username) or anyone, with a note on where it stands.
/// Returns `Outcome<Claim>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct HandOffArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    #[serde(default)]
    pub to: Option<String>,
    pub note: String,
}

/// `list_claims`: a repository's claims, newest first; active ones unless
/// `state` says otherwise. Returns `Outcome<Vec<Claim>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListClaimsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(default)]
    pub state: Option<ClaimState>,
    #[serde(default)]
    pub issue: Option<u32>,
}

/// `get_work`: everything an agent needs to pick up an issue. Returns
/// `Outcome<WorkContext>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetWorkArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub number: u32,
}

/// An issue in brief.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IssueBrief {
    pub number: u32,
    pub title: String,
    pub state: State,
}

/// A pull request in brief.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PullBrief {
    pub number: u32,
    pub title: String,
    pub status: PullStatus,
}

/// An issue another is blocked by, and where it stands.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Blocker {
    pub number: u32,
    pub title: String,
    pub state: State,
    /// Active claims on it.
    pub claims: Vec<Claim>,
    /// Its pull requests.
    pub pulls: Vec<PullBrief>,
}

/// A pull request's place in the merge queue.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueuePlace {
    pub state: QueueState,
    /// 1 for the front of the queue.
    pub position: u32,
}

/// One of an issue's pull requests, with where it stands.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPull {
    pub number: u32,
    pub title: String,
    pub status: PullStatus,
    pub branch: Option<String>,
    pub head_commit: Option<String>,
    pub author: Principal,
    /// `failed` when the merge queue took it out, until its head moves.
    pub check_status: Option<CheckStatus>,
    /// The checks the branch it merges into requires, as they stand on its
    /// head.
    pub required_checks: Vec<RequiredCheck>,
    pub mergeable: Mergeable,
    /// Other pull requests in progress changing the same files.
    pub overlaps: Vec<Overlap>,
    /// Its place in the merge queue, while it is in it.
    pub queue: Option<QueuePlace>,
}

/// Everything about an issue an agent needs to pick it up: the one call to
/// make before starting.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkContext {
    pub issue: Issue,
    /// The items under its "Definition of done" heading.
    pub definition_of_done: Vec<String>,
    /// The checks every pull request into the default branch must pass.
    pub required_checks: Vec<String>,
    /// Active claims on it.
    pub claims: Vec<Claim>,
    /// Sessions on it or its pull requests, most recently heard from first.
    pub sessions: Vec<Session>,
    pub pulls: Vec<WorkPull>,
    /// What it is blocked by, and where each stands.
    pub blocked_by: Vec<Blocker>,
    /// The issues it blocks.
    pub blocks: Vec<IssueBrief>,
    /// Decision records on it and its pull requests, newest first.
    #[serde(default)]
    pub decisions: Vec<crate::decisions::Decision>,
    /// The latest `integration_failure` decision on it or its pull
    /// requests, if any: which combination failed, and the check.
    #[serde(default)]
    pub last_integration_failure: Option<crate::decisions::Decision>,
    /// The latest coordination events about it, newest first.
    pub recent: Vec<Event>,
}

// --- Events -----------------------------------------------------------------

/// `session.started` and `session.ended`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub repo_id: String,
    /// The pull request it works on, else its issue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<u32>,
    pub session: Session,
}

impl SessionEvent {
    pub fn of(session: &Session) -> SessionEvent {
        SessionEvent {
            repo_id: session.repo_id.clone(),
            number: session.pull.or(session.issue),
            issue: session.issue,
            session: session.clone(),
        }
    }
}

/// `work.claimed`, `work.released`, `work.claim_expired` and
/// `work.handoff_requested`: `number` and `issue` are the issue claimed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEvent {
    pub repo_id: String,
    pub number: u32,
    pub issue: u32,
    pub claim: Claim,
    /// On `work.claimed`: the other active claims on the issue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub others: Option<Vec<Claim>>,
    /// On `work.claimed`, when it takes over a claim handed off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub took_over: Option<String>,
    /// On `work.released`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// On `work.handoff_requested`: who handed it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// On `work.handoff_requested`: who it is for; absent for anyone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ClaimEvent {
    pub fn of(claim: &Claim) -> ClaimEvent {
        ClaimEvent {
            repo_id: claim.repo_id.clone(),
            number: claim.issue,
            issue: claim.issue,
            claim: claim.clone(),
            others: None,
            took_over: None,
            reason: None,
            from: None,
            to: None,
            note: None,
        }
    }
}

/// `dependency.changed`: an issue's `blocked_by` changed, or one of the
/// issues it is blocked by closed or had its pull request merged.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyChanged {
    pub repo_id: String,
    /// The issue whose dependencies changed.
    pub number: u32,
    pub issue: u32,
    /// What it is blocked by now.
    pub blocked_by: Vec<u32>,
    /// Added to `blocked_by`.
    pub added: Vec<u32>,
    /// Taken out of `blocked_by`.
    pub removed: Vec<u32>,
    /// Blockers that just closed or had a pull request merged.
    pub cleared: Vec<u32>,
    /// Those of `blocked_by` still open: none means it is unblocked.
    pub remaining: Vec<u32>,
    /// When a merge cleared it: the pull request merged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_pull: Option<u32>,
}

/// `overlap.detected`: a pull request's latest push makes it change files
/// another open or draft pull request changes. Sent once for each side
/// when a pair starts overlapping, and again only after it stopped.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlapDetected {
    pub repo_id: String,
    /// The pull request this event is about: `pull`.
    pub number: u32,
    pub pull: u32,
    pub other_pull: u32,
    /// The files both change.
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_issue: Option<u32>,
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;

    fn issues(numbers: &[u32]) -> HashSet<u32> {
        numbers.iter().copied().collect()
    }

    #[test]
    fn a_session_goes_idle_then_ends_without_heartbeats() {
        let start = 1_000_000;
        assert_eq!(SessionState::at(false, start, start), SessionState::Active);
        assert_eq!(SessionState::at(false, start, start + SESSION_IDLE_MS - 1), SessionState::Active);
        assert_eq!(SessionState::at(false, start, start + SESSION_IDLE_MS), SessionState::Idle);
        assert_eq!(SessionState::at(false, start, start + SESSION_TIMEOUT_MS), SessionState::Ended);
        assert_eq!(SessionState::at(true, start, start), SessionState::Ended);
        // A clock behind the last heartbeat reads as just heard from.
        assert_eq!(SessionState::at(false, start, start - 5), SessionState::Active);
    }

    #[test]
    fn claims_last_thirty_minutes_up_to_four_hours() {
        assert_eq!(claim_minutes(None), 30);
        assert_eq!(claim_minutes(Some(0)), 1);
        assert_eq!(claim_minutes(Some(90)), 90);
        assert_eq!(claim_minutes(Some(10_000)), 240);
    }

    #[test]
    fn harnesses_are_named_one_way() {
        assert_eq!(Harness::parse("claude-code"), Some(Harness::ClaudeCode));
        assert_eq!(Harness::parse("Codex"), Some(Harness::Codex));
        assert_eq!(Harness::parse("vim"), None);
        assert_eq!(serde_json::to_value(Harness::ClaudeCode).unwrap(), "claude_code");
        assert_eq!(serde_json::to_value(ClaimState::HandedOff).unwrap(), "handed_off");
    }

    #[test]
    fn blocked_by_is_issues_of_the_repository_never_itself() {
        let graph = HashMap::new();
        assert_eq!(check_blocked_by(5, &[3, 4, 3], &issues(&[3, 4, 5]), &graph), Ok(vec![3, 4]));
        assert_eq!(check_blocked_by(5, &[], &issues(&[5]), &graph), Ok(vec![]));
        assert!(check_blocked_by(5, &[5], &issues(&[5]), &graph).unwrap_err().contains("itself"));
        assert!(check_blocked_by(5, &[9], &issues(&[5]), &graph).unwrap_err().contains("#9 is not an issue"));
        let many: Vec<u32> = (100..100 + MAX_BLOCKED_BY as u32 + 1).collect();
        assert!(check_blocked_by(5, &many, &many.iter().copied().collect(), &graph).is_err());
    }

    #[test]
    fn blocked_by_never_makes_a_cycle() {
        // 3 is blocked by 4, which is blocked by 5.
        let graph: HashMap<u32, Vec<u32>> = [(3, vec![4]), (4, vec![5])].into_iter().collect();
        let all = issues(&[3, 4, 5, 6]);
        let refused = check_blocked_by(5, &[3], &all, &graph).unwrap_err();
        assert!(refused.contains("#5 → #3 → #4 → #5"), "{refused}");
        // A diamond is not a cycle.
        let diamond: HashMap<u32, Vec<u32>> = [(3, vec![5]), (4, vec![5])].into_iter().collect();
        assert_eq!(check_blocked_by(6, &[3, 4], &all, &diamond), Ok(vec![3, 4]));
        // Replacing 5's own blockers is judged without them.
        let graph: HashMap<u32, Vec<u32>> = [(5, vec![3]), (3, vec![4])].into_iter().collect();
        assert_eq!(check_blocked_by(5, &[4], &all, &graph), Ok(vec![4]));
    }

    #[test]
    fn the_definition_of_done_is_read_from_its_section() {
        let body = "Make it greet.\n\n## Definition of done\n\n- `npm test` passes.\n- [ ] Docs say so\n1. Works offline\n\n## Notes\n- not this";
        assert_eq!(definition_of_done(body), ["`npm test` passes.", "Docs say so", "Works offline"]);
        assert!(definition_of_done("No section").is_empty());
    }

    #[test]
    fn an_overlap_is_announced_once_until_it_clears() {
        assert_eq!(overlap_changes(&[7, 9], &[]), (vec![7, 9], vec![]));
        // Pushing again with the same overlaps announces nothing.
        assert_eq!(overlap_changes(&[7, 9], &[7, 9]), (vec![], vec![]));
        // 9 stopped overlapping: forgotten, so a later overlap is new again.
        assert_eq!(overlap_changes(&[7], &[7, 9]), (vec![], vec![9]));
        assert_eq!(overlap_changes(&[7, 9], &[7]), (vec![9], vec![]));
    }

    #[test]
    fn events_name_the_issue_or_pull_request_they_are_about() {
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "ses_1", "repoId": "rep_1", "issue": 4, "pull": 9, "branch": null,
            "actor": { "id": "usr_1", "username": "ana" }, "harness": "claude_code",
            "harnessSessionId": null, "title": null, "state": "active", "headCommit": null,
            "startedAt": "", "lastSeenAt": "", "endedAt": null, "endReason": null
        }))
        .unwrap();
        let event = serde_json::to_value(SessionEvent::of(&session)).unwrap();
        assert_eq!((event["number"].as_u64(), event["issue"].as_u64()), (Some(9), Some(4)));
    }
}
