//! Coordinating work between agents and people: sessions, claims and
//! dependencies.
//!
//! The work item is the unit of work. A **session** is one run of
//! someone's own harness (a Claude Code session, a Codex run) on a
//! repository, by a person's token, optionally attached to a work item of
//! the repository's workspace, a pull request and a branch. A **claim** is
//! an advisory, expiring "I'm working on #N": never a lock, so two can
//! stand on one work item, and the second claimant is told about the
//! first. A work item's `blocked_by` names the work items that have to
//! land first.
//!
//! Hooks and telemetry are evidence, never truth: what git and g1t record
//! is. So sessions tolerate missed heartbeats, reconnects and duplicate
//! events: starting one is idempotent on the harness's own session id,
//! entries are idempotent on their `key`, and a session or claim that
//! went quiet is read as idle, ended or expired when it is next looked at.

use serde::{Deserialize, Serialize};

use super::{
    CheckStatus, ItemRepo, Mergeable, NewSessionEntry, Overlap, PullStatus, QueueState, RequiredCheck, SessionEntry, State,
    WorkItem,
};
use crate::credentials::Principal;
use crate::events::Event;
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// A session with no heartbeat for this long reads as idle.
pub const SESSION_IDLE_MS: u64 = 15 * 60 * 1000;
/// A session with no heartbeat for this long has ended (`timed_out`); a
/// heartbeat brings it back, so this only says when it stops showing as live.
pub const SESSION_TIMEOUT_MS: u64 = 30 * 60 * 1000;
/// How long a claim lasts unless renewed, in minutes.
pub const CLAIM_DEFAULT_MINUTES: u32 = 30;
/// The longest a claim may be asked to last, in minutes.
pub const CLAIM_MAX_MINUTES: u32 = 240;
/// The most work items one work item can be blocked by.
pub const MAX_BLOCKED_BY: usize = 50;
/// The most characters a session's title, a claim's note or a reason keeps.
pub const MAX_NOTE_CHARS: usize = 500;
/// The most characters an entry's idempotency key may have.
pub const MAX_KEY_CHARS: usize = 200;

/// The event types about coordinating work, which `get_work` lists as a
/// work item's recent activity (with the merge queue's, once it sends them).
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
    /// A session g1t started on Claude Managed Agents with the workspace's
    /// own Anthropic key (`start_agent_session`).
    ClaudeManagedAgents,
    Codex,
    Cursor,
    Copilot,
    Other,
}

impl Harness {
    pub const ALL: [Harness; 6] = [
        Harness::ClaudeCode,
        Harness::ClaudeManagedAgents,
        Harness::Codex,
        Harness::Cursor,
        Harness::Copilot,
        Harness::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude_code",
            Harness::ClaudeManagedAgents => "claude_managed_agents",
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
    /// Ended, or not heard from for 30 minutes (`end_reason` `timed_out`).
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
    /// The work item it works on, if it said: by number in the
    /// repository's workspace.
    pub item: Option<u32>,
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
    /// For a subagent: the session that started it (`ses_…`).
    #[serde(default)]
    pub parent_id: Option<String>,
    /// For a subagent: its kind, as the harness names it (`Explore`,
    /// `security-reviewer`, a Managed Agents thread's agent).
    #[serde(default)]
    pub agent_type: Option<String>,
    /// For a subagent: the task it was given, in a few words.
    #[serde(default)]
    pub task: Option<String>,
    /// For a subagent: the prompt its parent gave it, cut to
    /// [`MAX_PROMPT_CHARS`].
    #[serde(default)]
    pub prompt: Option<String>,
    /// What it reported when it finished (a subagent's final message), cut to
    /// [`MAX_RESULT_CHARS`]: its parent's evidence, never a tool's output.
    #[serde(default)]
    pub result: Option<String>,
    /// The model it ran on, when the harness said.
    #[serde(default)]
    pub model: Option<String>,
    /// How many subagents it started.
    #[serde(default)]
    pub subagents: u32,
    /// For a session with no title, in a list: the start of the first
    /// prompt it recorded (up to [`MAX_FIRST_PROMPT_CHARS`]), for saying
    /// what it is for until it has a title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    /// Where its title came from; none for one with no title, or one from
    /// before titles said.
    #[serde(default)]
    pub title_source: Option<TitleSource>,
    /// RFC 3339: when its title was last settled (by g1t, its agent or a
    /// person).
    #[serde(default)]
    pub title_settled_at: Option<String>,
    /// What it cost, estimated at Anthropic's list price from the token
    /// usage its harness reported ([`crate::model_prices`]), in US dollars;
    /// none until it reports usage for a model with a known price.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Whether some of its usage was for models priced as unknown, which
    /// [`Session::cost_usd`] leaves out.
    #[serde(default)]
    pub cost_partial: bool,
}

/// Where a session's title came from. g1t settles a title from the
/// session's whole record (coordination/titles.rs in services/work): a
/// [`TitleSource::Prompt`] title is provisional until it does, a
/// [`TitleSource::Person`] one is pinned and never replaced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    /// What its first prompt was for: provisional.
    Prompt,
    /// Its harness or agent named it (`g1t session attach --title`). Kept,
    /// unless the session went on to other work items or pull requests
    /// after it was named, when it is settled again as it ends.
    Agent,
    /// A person named it from the site: pinned.
    Person,
    /// The title of the work item it works on.
    Item,
    /// The title of the pull request it opened or works on.
    Pull,
    /// g1t named the whole of its work: with the workspace's AI provider,
    /// or from its most telling prompt.
    Summary,
}

impl TitleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TitleSource::Prompt => "prompt",
            TitleSource::Agent => "agent",
            TitleSource::Person => "person",
            TitleSource::Item => "item",
            TitleSource::Pull => "pull",
            TitleSource::Summary => "summary",
        }
    }

    pub fn parse(name: &str) -> Option<TitleSource> {
        match name.trim() {
            "prompt" => Some(TitleSource::Prompt),
            "agent" => Some(TitleSource::Agent),
            "person" => Some(TitleSource::Person),
            "item" => Some(TitleSource::Item),
            "pull" => Some(TitleSource::Pull),
            "summary" => Some(TitleSource::Summary),
            _ => None,
        }
    }

    /// Whether g1t settled it from the session's record.
    pub fn settled(self) -> bool {
        matches!(self, TitleSource::Item | TitleSource::Pull | TitleSource::Summary)
    }
}

/// `title_session`: a person names a session from the site, pinning its
/// title: g1t never replaces it, nor does its agent. No `title` unpins
/// it: g1t names it again from its record. Whoever runs the session may,
/// and anyone with write access to the repository. Returns
/// `Outcome<Session>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TitleSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// The most characters a session's title keeps.
pub const MAX_SESSION_TITLE_CHARS: usize = 200;

/// The most characters of an untitled session's first prompt a list gives.
pub const MAX_FIRST_PROMPT_CHARS: usize = 300;

/// The most characters a subagent's task keeps.
pub const MAX_TASK_CHARS: usize = 200;
/// The most characters of a subagent's prompt kept.
pub const MAX_PROMPT_CHARS: usize = 4_000;
/// The most characters of a session's result kept.
pub const MAX_RESULT_CHARS: usize = 8_000;
/// The most things one call says a session touched.
pub const MAX_TOUCHES: usize = 200;
/// The most characters a touched path, branch or commit keeps.
pub const MAX_TOUCH_CHARS: usize = 500;

/// The harness's id for a subagent of the harness session `parent`: what
/// its start is idempotent on. Claude Code's `agent_id` arrives as
/// `agent-abc` in hooks and `abc` in the Agent tool's answer, so the prefix
/// is dropped.
pub fn subagent_harness_id(parent: &str, agent_id: &str) -> String {
    let agent = agent_id.trim();
    let agent = agent.strip_prefix("agent-").unwrap_or(agent);
    format!("{}/agent/{agent}", parent.trim())
}

/// What kind of thing a session touched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TouchKind {
    /// A file it wrote or edited, relative to the repository's root.
    File,
    /// A commit it made.
    Commit,
    /// A branch it made or pushed.
    Branch,
    /// A pull request it opened.
    Pull,
    /// A work item it named, by number in the repository's workspace.
    Item,
}

impl TouchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TouchKind::File => "file",
            TouchKind::Commit => "commit",
            TouchKind::Branch => "branch",
            TouchKind::Pull => "pull",
            TouchKind::Item => "item",
        }
    }

    pub fn parse(name: &str) -> Option<TouchKind> {
        [TouchKind::File, TouchKind::Commit, TouchKind::Branch, TouchKind::Pull, TouchKind::Item]
            .into_iter()
            .find(|kind| kind.as_str() == name.trim())
    }
}

/// Something a session says it touched, to record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewTouch {
    pub kind: TouchKind,
    /// The path, commit, branch, or number (`12`) for a pull request or
    /// work item.
    pub value: String,
}

/// Something a session touched: recorded once per session, kind and value.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTouch {
    pub session_id: String,
    pub kind: TouchKind,
    pub value: String,
    /// RFC 3339: when it was first said.
    pub at: String,
}

/// Touches as given, tidied: trimmed, cut, numbers for pull requests and
/// work items, empty and repeated ones dropped, at most [`MAX_TOUCHES`].
pub fn tidy_touches(touches: &[NewTouch]) -> Vec<NewTouch> {
    let mut out: Vec<NewTouch> = Vec::new();
    for touch in touches {
        let mut value: String = touch.value.trim().chars().take(MAX_TOUCH_CHARS).collect();
        match touch.kind {
            TouchKind::Pull | TouchKind::Item => {
                match value.trim_start_matches('#').parse::<u32>() {
                    Ok(number) if number > 0 => value = number.to_string(),
                    _ => continue,
                }
            }
            TouchKind::Commit => {
                if value.len() < 7 || !value.chars().all(|c| c.is_ascii_hexdigit()) {
                    continue;
                }
                value = value.to_ascii_lowercase();
            }
            TouchKind::Branch => value = value.trim_start_matches("refs/heads/").to_owned(),
            TouchKind::File => value = value.replace('\\', "/"),
        }
        if value.is_empty() || out.iter().any(|seen| seen.kind == touch.kind && seen.value == value) {
            continue;
        }
        out.push(NewTouch { kind: touch.kind, value });
        if out.len() == MAX_TOUCHES {
            break;
        }
    }
    out
}

/// The numbers bare `#N` in text names, in order, once each: `#12`,
/// `(#12)`, `fixes #12`, never `a#12`, `&#12;` or `#12abc`. What each names
/// is read as [`super::refs`] says.
pub fn refs_in(text: &str) -> Vec<u32> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(offset) = text[at..].find('#') {
        let hash = at + offset;
        at = hash + 1;
        let before = hash.checked_sub(1).map(|i| bytes[i]);
        if before.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'&' || b == b'/' || b == b'_') {
            continue;
        }
        let digits: String = text[at..].chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() || digits.len() > 7 {
            continue;
        }
        let after = text[at + digits.len()..].chars().next();
        if after.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == ';') {
            continue;
        }
        if let Ok(number) = digits.parse::<u32>()
            && number > 0
            && !found.contains(&number)
        {
            found.push(number);
        }
    }
    found
}

/// The sessions a commit message names in `G1t-Session: ses_…` trailers.
pub fn session_trailers(message: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in message.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("g1t-session") {
            continue;
        }
        let id = value.trim();
        if id.starts_with("ses_") && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !found.iter().any(|f| f == id) {
            found.push(id.to_owned());
        }
    }
    found
}

/// How a session was tied to a work item or pull request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkVia {
    /// The session said it works on it (start or update).
    Attached,
    /// It claimed the work item.
    Claim,
    /// It pushed the pull request's branch.
    Branch,
    /// It made the pull request's head commit.
    Commit,
    /// A commit on the pull request's branch names it in a `G1t-Session:`
    /// trailer.
    Trailer,
    /// It opened the pull request.
    Opened,
    /// Its prompt, task or a subagent's named it (`#12`).
    Ref,
}

impl LinkVia {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkVia::Attached => "attached",
            LinkVia::Claim => "claim",
            LinkVia::Branch => "branch",
            LinkVia::Commit => "commit",
            LinkVia::Trailer => "trailer",
            LinkVia::Opened => "opened",
            LinkVia::Ref => "ref",
        }
    }

    pub fn parse(name: &str) -> Option<LinkVia> {
        [LinkVia::Attached, LinkVia::Claim, LinkVia::Branch, LinkVia::Commit, LinkVia::Trailer, LinkVia::Opened, LinkVia::Ref]
            .into_iter()
            .find(|via| via.as_str() == name)
    }
}

/// Work item or pull request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Item,
    Pull,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Item => "item",
            LinkKind::Pull => "pull",
        }
    }
}

/// A work item or pull request a session, or one of its subagents, worked
/// on. A work item's `number` is its number in the workspace.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub kind: LinkKind,
    pub number: u32,
    pub title: String,
    /// The work item's state (`open`, `closed`) or the pull request's status.
    pub state: String,
    /// How it was tied, strongest first.
    pub via: Vec<LinkVia>,
    /// The sessions of the tree it was tied through.
    pub session_ids: Vec<String>,
}

/// One tie of a session to a work item or pull request, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRecord {
    pub session_id: String,
    pub kind: LinkKind,
    pub number: u32,
    pub via: LinkVia,
}

/// The links a session tree's ties make: one per work item or pull
/// request, its ways gathered strongest first, the pull requests first,
/// then the work items, each by number. `known` gives each one's title and
/// state; a tie
/// to anything it does not know (deleted, or a `#N` that names nothing) is
/// left out.
pub fn gather_links(records: &[LinkRecord], known: &std::collections::HashMap<(LinkKind, u32), (String, String)>) -> Vec<SessionLink> {
    let mut links: Vec<SessionLink> = Vec::new();
    for record in records {
        let Some((title, state)) = known.get(&(record.kind, record.number)) else {
            continue;
        };
        let link = match links.iter_mut().find(|link| link.kind == record.kind && link.number == record.number) {
            Some(link) => link,
            None => {
                links.push(SessionLink {
                    kind: record.kind,
                    number: record.number,
                    title: title.clone(),
                    state: state.clone(),
                    via: Vec::new(),
                    session_ids: Vec::new(),
                });
                links.last_mut().expect("just pushed")
            }
        };
        if !link.via.contains(&record.via) {
            link.via.push(record.via);
            link.via.sort();
        }
        if !link.session_ids.contains(&record.session_id) {
            link.session_ids.push(record.session_id.clone());
        }
    }
    links.sort_by_key(|link| (std::cmp::Reverse(link.kind), link.number));
    links
}

/// A skill a session used (Claude Code's Skill tool): its name only.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkill {
    pub session_id: String,
    pub name: String,
    /// How many times it was used.
    pub uses: u32,
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
    /// The repository of the checkout it was made from, if it was made
    /// from one.
    pub repo_id: Option<String>,
    /// The workspace of the work item it is on.
    pub workspace: String,
    /// The work item it is on, by number.
    pub item: u32,
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

/// Whether a claim (made by `claim_actor` from `claim_session`) is the
/// caller's own (`actor`, acting from `session`): theirs, and from the same
/// session when both name one. Two sessions of one person, such as sibling
/// subagents, hold claims of their own and are told of each other's.
pub fn claim_is_mine(claim_actor: &str, claim_session: Option<&str>, actor: &str, session: Option<&str>) -> bool {
    claim_actor == actor
        && match (claim_session, session) {
            (Some(held), Some(asking)) => held == asking,
            _ => true,
        }
}

/// How long a claim lasts, in minutes: the default when none was asked,
/// at least one and at most [`CLAIM_MAX_MINUTES`].
pub fn claim_minutes(asked: Option<u32>) -> u32 {
    asked.unwrap_or(CLAIM_DEFAULT_MINUTES).clamp(1, CLAIM_MAX_MINUTES)
}

/// `blocked_by` as asked for `number`, de-duplicated in the order given,
/// or why it cannot be: one names `number` itself or is not a work item of
/// the workspace (`items`), there are too many, or it would close a cycle
/// through the blockers already recorded (`graph`: each work item's
/// `blocked_by`).
pub fn check_blocked_by(
    number: u32,
    asked: &[u32],
    items: &std::collections::HashSet<u32>,
    graph: &std::collections::HashMap<u32, Vec<u32>>,
) -> Result<Vec<u32>, String> {
    let mut wanted: Vec<u32> = Vec::new();
    for blocker in asked {
        if !wanted.contains(blocker) {
            wanted.push(*blocker);
        }
    }
    if wanted.len() > MAX_BLOCKED_BY {
        return Err(format!("A work item can be blocked by at most {MAX_BLOCKED_BY} work items."));
    }
    if wanted.contains(&number) {
        return Err(format!("#{number} cannot be blocked by itself."));
    }
    if let Some(missing) = wanted.iter().find(|blocker| !items.contains(blocker)) {
        return Err(format!("#{missing} is not a work item in this workspace."));
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

/// The items of a work item's "Definition of done" section: each bulleted or
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
/// the work item, pull request, branch, title and head given).
#[derive(Debug, Serialize, Deserialize)]
pub struct StartSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub harness: Harness,
    #[serde(default)]
    pub harness_session_id: Option<String>,
    /// A work item of the repository's workspace, by number.
    #[serde(default)]
    pub item: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    /// For a subagent: the session that started it, one of the actor's on
    /// the repository. Its `harness_session_id` should be
    /// [`subagent_harness_id`] of the parent's.
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
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
    pub item: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head_commit: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    /// The session's token usage so far, per model, as its harness counts
    /// it: cumulative, so it replaces what was reported before.
    #[serde(default)]
    pub usage: Option<Vec<crate::model_prices::ModelUsage>>,
}

/// `end_session`. Returns `Outcome<Session>`; ending one already ended
/// returns it as it is (taking `result` if it had none). Ending a session
/// ends its subagents still going. Whoever runs a session ends it, and so
/// may anyone with write access to the repository, for one left behind
/// (its harness killed, or never told to end): see [`may_end_session`] and
/// [`session_end_reason`].
#[derive(Debug, Serialize, Deserialize)]
pub struct EndSessionArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// What it reported when it finished.
    #[serde(default)]
    pub result: Option<String>,
    /// Ended by a person from the site, not by its harness: recorded as
    /// [`ended_by_hand`] whatever `reason` says.
    #[serde(default)]
    pub by_hand: bool,
}

/// How every [`ended_by_hand`] reason starts.
pub const ENDED_BY_HAND: &str = "ended by hand by @";

/// The `end_reason` of a session a person ended by hand (from the site,
/// or someone else's): `ended by hand by @name`.
pub fn ended_by_hand(username: &str) -> String {
    format!("{ENDED_BY_HAND}{username}")
}

/// Whether a session that ended for `end_reason` comes back when its
/// harness is heard from again (an update, a record, a start): one that
/// timed out, or one a person ended by hand, which is a soft close for a
/// session left behind. One its harness ended itself stays ended.
pub fn revives(end_reason: Option<&str>) -> bool {
    end_reason.is_some_and(|reason| reason == "timed_out" || reason.starts_with(ENDED_BY_HAND))
}

/// Whether `actor` may end a session `owner` runs: their own, or anyone's
/// when they have write access (`can_push`) to the repository.
pub fn may_end_session(owner: &str, actor: &str, can_push: bool) -> bool {
    owner == actor || can_push
}

/// Why a session ended, as `end_session` records it: [`ended_by_hand`]
/// when a person ended it by hand or it was not theirs (so it never reads
/// as its harness's own words), else what the harness said, or `ended`.
pub fn session_end_reason(own: bool, by_hand: bool, actor: &str, given: Option<&str>) -> String {
    if by_hand || !own {
        return ended_by_hand(actor);
    }
    given.map(str::trim).filter(|reason| !reason.is_empty()).map_or_else(|| "ended".to_owned(), str::to_owned)
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
pub struct SessionUpdate {
    pub id: String,
    pub kind: String,
    pub data: serde_json::Value,
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionDetail {
    /// Oldest pending coordination updates, at most 100. Reading does not acknowledge them.
    #[serde(default)]
    pub updates: Vec<SessionUpdate>,
    pub session: Session,
    /// Oldest first, numbered within the session.
    pub entries: Vec<SessionEntry>,
    /// Its subagents, and theirs, in the order they started: each names its
    /// parent in `parent_id`.
    #[serde(default)]
    pub children: Vec<Session>,
    /// What it and its subagents touched, in the order first said.
    #[serde(default)]
    pub touched: Vec<SessionTouch>,
    /// The work items and pull requests it and its subagents worked on.
    #[serde(default)]
    pub links: Vec<SessionLink>,
    /// The skills it and its subagents used, by name.
    #[serde(default)]
    pub skills: Vec<SessionSkill>,
    /// For a subagent: the session at the top of its tree.
    #[serde(default)]
    pub root: Option<Session>,
    /// The viewer is not a member of the repository's workspace: they see
    /// that the session runs, who runs it and what it is tied to, and
    /// nothing of what it recorded, touched or was asked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub limited: bool,
}

/// `pull_sessions`: the harness sessions tied to some of a repository's
/// pull requests (`numbers`, at most 100) any way a session is tied to
/// one, for Home's marks on what landed. Returns
/// `Outcome<Vec<PullSessions>>`, one entry for each pull request that has
/// any, its top-level sessions first: a subagent counts as the session
/// that started it.
#[derive(Debug, Serialize, Deserialize)]
pub struct PullSessionsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub numbers: Vec<u32>,
}

/// The sessions tied to one pull request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullSessions {
    pub number: u32,
    pub sessions: Vec<SessionRef>,
}

/// A session, as a mark on something it made: its id and harness.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub id: String,
    pub harness: Harness,
}

/// `list_work_sessions`: a repository's sessions, most recently heard from
/// first. Returns `Outcome<Vec<Session>>`. Subagents are left out unless
/// `subagents`; with `item` (a work item of its workspace) or `pull`, the
/// sessions tied to it any way (attached, a claim, its branch or commits,
/// a trailer, opened, named) are listed, and with `subagents` their
/// subagents too.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListWorkSessionsArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(default)]
    pub state: Option<SessionState>,
    #[serde(default)]
    pub item: Option<u32>,
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub subagents: bool,
    /// Only sessions that touched this file, or any under it when it ends
    /// in `/`.
    #[serde(default)]
    pub path: Option<String>,
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
    /// Exact update IDs this session has considered. Repeated acknowledgements are harmless.
    #[serde(default)]
    pub acknowledge: Vec<String>,
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub entries: Vec<KeyedSessionEntry>,
    /// What it touched: files, commits, branches, pull requests opened,
    /// work items named. Recorded once each; pull requests and work items
    /// tie the session to them.
    #[serde(default)]
    pub touched: Vec<NewTouch>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Recorded {
    /// Entries newly recorded.
    pub recorded: u32,
    /// Entries skipped because one with the same key was recorded before.
    pub duplicates: u32,
    /// Of the `acknowledge` IDs given, how many name an update of this
    /// session (acknowledged now or before). Fewer than given means some
    /// IDs were mistyped or belong to another session.
    #[serde(default)]
    pub acknowledged: u32,
}

/// `claim_work_item`. Returns `Outcome<Claimed>`. Claiming a work item you
/// hold renews your claim (and changes its note or session when given).
/// With no number and a `title`, it opens the work item first (filed from
/// `repo`, when given) and attaches the session to it; `Claimed::item` is
/// the work item it opened.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClaimArgs {
    pub actor: User,
    /// The workspace; empty for `repo`'s.
    #[serde(default)]
    pub workspace: String,
    /// The repository of the checkout claiming it, if there is one: where
    /// the claim's session runs.
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// The work item to claim; 0 with `title` to open one and claim it.
    #[serde(default)]
    pub number: u32,
    /// Without a number: the title of a new work item to open and claim.
    /// The session named by `session_id` is attached to it.
    #[serde(default)]
    pub title: Option<String>,
    /// Without a number: the new work item's description.
    #[serde(default)]
    pub body: Option<String>,
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
    /// Other active claims on the work item: someone else is on it too.
    pub others: Vec<Claim>,
    /// What the work item is blocked by, and where each stands.
    pub blocked_by: Vec<Blocker>,
    /// The work item the claim opened, when it was asked to open one (a
    /// `title` instead of a number).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<WorkItem>,
}

/// `release_claim`: gives up your active claim on a work item. Returns
/// `Outcome<Claim>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReleaseArgs {
    pub actor: User,
    /// The workspace; empty for `repo`'s.
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    pub number: u32,
    #[serde(default)]
    pub reason: Option<String>,
    /// The session whose claim it is, when the caller has several.
    #[serde(default)]
    pub session_id: Option<String>,
}

/// `hand_off_work_item`: ends your active claim on a work item as handed
/// off, to someone (`to`, a username) or anyone, with a note on where it
/// stands. Returns `Outcome<Claim>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct HandOffArgs {
    pub actor: User,
    /// The workspace; empty for `repo`'s.
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    pub number: u32,
    #[serde(default)]
    pub to: Option<String>,
    pub note: String,
    /// The session whose claim it is, when the caller has several.
    #[serde(default)]
    pub session_id: Option<String>,
}

/// `list_claims`: a workspace's claims on the work items the viewer may
/// see, newest first; active ones unless `state` says otherwise. With
/// `repo` (then `workspace` may be empty), those made from its checkouts
/// or on work items linked to it. Returns `Outcome<Vec<Claim>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListClaimsArgs {
    pub viewer: Viewer,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    #[serde(default)]
    pub state: Option<ClaimState>,
    /// Only those on this work item.
    #[serde(default)]
    pub item: Option<u32>,
}

/// A work item in brief.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ItemBrief {
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

/// A work item another is blocked by, and where it stands.
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

/// One of a work item's pull requests, with where it stands.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPull {
    /// Its repository, `owner/name`.
    pub repo: String,
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

/// One repository a work item is linked to, as an agent picking it up sees
/// it: how it is linked, whether the work landed there, and its pull
/// requests for the item.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRepo {
    #[serde(flatten)]
    pub link: ItemRepo,
    /// The checks every pull request into its default branch must pass.
    pub required_checks: Vec<String>,
    /// Its pull requests for the work item, oldest first.
    pub pulls: Vec<WorkPull>,
}

/// A repository of the workspace the work may belong in, offered for an
/// agent or a person to confirm as a target (`link_work_item`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedTarget {
    pub repo_id: String,
    /// `owner/name`.
    pub path: String,
    /// Why it is suggested, in a sentence.
    pub why: String,
    /// Higher is likelier; only the order means anything.
    pub score: u32,
}

/// Everything about a work item an agent needs to pick it up: the one call
/// to make before starting.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkContext {
    pub item: WorkItem,
    /// The items under its "Definition of done" heading.
    pub definition_of_done: Vec<String>,
    /// The repositories it is linked to, each with its pull requests for
    /// it and what landed there: origin first, then targets, then touched.
    pub repos: Vec<WorkRepo>,
    /// The targets it has not landed in yet, by path. Empty with no
    /// targets: then whatever closes it closes it.
    pub missing: Vec<String>,
    /// Repositories of the workspace it may belong in, likeliest first,
    /// when it has no targets yet or could have more.
    #[serde(default)]
    pub suggested_targets: Vec<SuggestedTarget>,
    /// Active claims on it.
    pub claims: Vec<Claim>,
    /// Sessions on it or its pull requests, most recently heard from first.
    pub sessions: Vec<Session>,
    /// What it is blocked by, and where each stands.
    pub blocked_by: Vec<Blocker>,
    /// The work items it blocks.
    pub blocks: Vec<ItemBrief>,
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
    /// The pull request it works on, else its work item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<u32>,
    pub session: Session,
}

impl SessionEvent {
    pub fn of(session: &Session) -> SessionEvent {
        SessionEvent {
            repo_id: session.repo_id.clone(),
            number: session.pull.or(session.item),
            item: session.item,
            session: session.clone(),
        }
    }
}

/// The most often a session's recording is announced as
/// `session.progressed`, so its open pages follow it without hearing of
/// every tool call.
pub const PROGRESS_EVERY_MS: u64 = 5_000;

/// `session.progressed`: a session (or a subagent of it) recorded more, for
/// the pages showing it. Says where, never what.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProgressed {
    pub repo_id: String,
    /// The pull request it works on, else its work item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    pub session_id: String,
    /// The session at the top of its tree, when it is a subagent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
}

/// `work.claimed`, `work.released`, `work.claim_expired` and
/// `work.handoff_requested`: `number` and `item` are the work item claimed,
/// in `workspace`; `repo_ids` the repositories it is linked to.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEvent {
    /// The repository of the checkout it was claimed from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    pub workspace: String,
    pub number: u32,
    pub item: u32,
    #[serde(default)]
    pub repo_ids: Vec<String>,
    pub claim: Claim,
    /// On `work.claimed`: the other active claims on the work item.
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
    pub fn of(claim: &Claim, repo_ids: &[String]) -> ClaimEvent {
        ClaimEvent {
            repo_id: claim.repo_id.clone(),
            workspace: claim.workspace.clone(),
            number: claim.item,
            item: claim.item,
            repo_ids: repo_ids.to_vec(),
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

/// `dependency.changed`: a work item's `blocked_by` changed, or one of the
/// work items it is blocked by closed or had its pull request merged.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyChanged {
    pub workspace: String,
    /// The work item whose dependencies changed.
    pub number: u32,
    pub item: u32,
    /// The repositories it is linked to.
    #[serde(default)]
    pub repo_ids: Vec<String>,
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
    pub item: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_item: Option<u32>,
}

/// `overlap.detected` between two sessions: the session `session_id` (or
/// one of its subagents) touched files that `other_session_id`, active
/// and outside its own line of parents and subagents, touched too. Sent
/// once for each side when a pair starts overlapping, and again, with the
/// new `files`, when another file in common joins. Siblings (subagents
/// of one session) are told of each other.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOverlapDetected {
    pub repo_id: String,
    /// The pull request the session is on, else its work item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    pub session_id: String,
    pub other_session_id: String,
    /// Who runs the other session.
    pub other_actor: String,
    /// The files both touched.
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_item: Option<u32>,
}

/// The sessions `touched` (session and file pairs, as found) overlaps
/// with, leaving out `me` and `family` (its parents and subagents): each
/// with the files both touched, by session id, files sorted.
pub fn session_overlaps(me: &str, family: &std::collections::HashSet<String>, touched: &[(String, String)]) -> Vec<(String, Vec<String>)> {
    let mut found: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for (session, file) in touched {
        if session == me || family.contains(session) {
            continue;
        }
        let files = found.entry(session.clone()).or_default();
        if !files.contains(file) {
            files.push(file.clone());
        }
    }
    found
        .into_iter()
        .map(|(session, mut files)| {
            files.sort();
            (session, files)
        })
        .collect()
}

/// A pair of sessions, lower id first, as overlaps are kept.
pub fn session_pair(a: &str, b: &str) -> (String, String) {
    if a <= b { (a.to_owned(), b.to_owned()) } else { (b.to_owned(), a.to_owned()) }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;

    fn items(numbers: &[u32]) -> HashSet<u32> {
        numbers.iter().copied().collect()
    }

    #[test]
    fn a_session_is_ended_by_whoever_runs_it_or_by_anyone_who_can_write() {
        assert!(may_end_session("usr_1", "usr_1", false));
        assert!(may_end_session("usr_1", "usr_2", true));
        assert!(!may_end_session("usr_1", "usr_2", false));
    }

    #[test]
    fn a_session_ended_by_hand_says_who_ended_it() {
        assert_eq!(session_end_reason(true, false, "ana", Some("done")), "done");
        assert_eq!(session_end_reason(true, false, "ana", Some("  ")), "ended");
        assert_eq!(session_end_reason(true, false, "ana", None), "ended");
        assert_eq!(session_end_reason(true, true, "ana", Some("done")), "ended by hand by @ana");
        // Someone else's: never in its harness's words.
        assert_eq!(session_end_reason(false, false, "bo", Some("done")), "ended by hand by @bo");
        assert!(ended_by_hand("bo").starts_with(ENDED_BY_HAND));
    }

    #[test]
    fn a_session_ended_by_hand_or_timed_out_comes_back_when_heard_from() {
        assert!(revives(Some("timed_out")));
        assert!(revives(Some(&ended_by_hand("bo"))));
        assert!(!revives(Some("done")));
        assert!(!revives(Some("ended")));
        assert!(!revives(None));
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
    fn blocked_by_is_work_items_of_the_workspace_never_itself() {
        let graph = HashMap::new();
        assert_eq!(check_blocked_by(5, &[3, 4, 3], &items(&[3, 4, 5]), &graph), Ok(vec![3, 4]));
        assert_eq!(check_blocked_by(5, &[], &items(&[5]), &graph), Ok(vec![]));
        assert!(check_blocked_by(5, &[5], &items(&[5]), &graph).unwrap_err().contains("itself"));
        assert!(check_blocked_by(5, &[9], &items(&[5]), &graph).unwrap_err().contains("#9 is not a work item"));
        let many: Vec<u32> = (100..100 + MAX_BLOCKED_BY as u32 + 1).collect();
        assert!(check_blocked_by(5, &many, &many.iter().copied().collect(), &graph).is_err());
    }

    #[test]
    fn blocked_by_never_makes_a_cycle() {
        // 3 is blocked by 4, which is blocked by 5.
        let graph: HashMap<u32, Vec<u32>> = [(3, vec![4]), (4, vec![5])].into_iter().collect();
        let all = items(&[3, 4, 5, 6]);
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
    fn a_subagent_is_known_by_its_parent_and_agent_id_however_it_is_spelled() {
        assert_eq!(subagent_harness_id("abc123", "agent-def456"), "abc123/agent/def456");
        assert_eq!(subagent_harness_id("abc123", "def456"), "abc123/agent/def456");
        assert_eq!(Harness::parse("claude_managed_agents"), Some(Harness::ClaudeManagedAgents));
    }

    #[test]
    fn sibling_sessions_of_one_person_hold_claims_of_their_own() {
        assert!(claim_is_mine("usr_1", Some("ses_a"), "usr_1", Some("ses_a")));
        assert!(!claim_is_mine("usr_1", Some("ses_a"), "usr_1", Some("ses_b")), "a sibling's claim is another's");
        assert!(claim_is_mine("usr_1", None, "usr_1", Some("ses_b")), "a claim from no session is the person's");
        assert!(claim_is_mine("usr_1", Some("ses_a"), "usr_1", None), "without a session, any of theirs");
        assert!(!claim_is_mine("usr_2", Some("ses_a"), "usr_1", Some("ses_a")));
    }

    #[test]
    fn references_are_hashes_followed_by_numbers_and_nothing_else() {
        assert_eq!(refs_in("Fix #12 (see #4, #12) and fixes #7."), vec![12, 4, 7]);
        assert_eq!(refs_in("a#3 &#39; #12abc #0 #x issue#9 owner/repo#5 #_2"), Vec::<u32>::new());
        assert_eq!(refs_in("#1\n#22"), vec![1, 22]);
        assert_eq!(refs_in("#12345678"), Vec::<u32>::new());
    }

    #[test]
    fn commits_name_their_sessions_in_trailers() {
        let message = "Greet in French\n\nCloses #4\n\nG1t-Session: ses_01abc\ng1t-session: ses_01abc\nG1t-Session: nope\nCo-authored-by: x";
        assert_eq!(session_trailers(message), vec!["ses_01abc".to_owned()]);
        assert!(session_trailers("no trailer").is_empty());
    }

    #[test]
    fn touches_are_tidied_and_said_once() {
        let touch = |kind, value: &str| NewTouch { kind, value: value.into() };
        let tidied = tidy_touches(&[
            touch(TouchKind::File, "src\\lib.rs"),
            touch(TouchKind::File, "src/lib.rs"),
            touch(TouchKind::Pull, "#14"),
            touch(TouchKind::Item, "not a number"),
            touch(TouchKind::Commit, "ABCDEF1234"),
            touch(TouchKind::Commit, "xyz"),
            touch(TouchKind::Branch, "refs/heads/fix-4"),
            touch(TouchKind::Branch, "  "),
        ]);
        assert_eq!(
            tidied,
            vec![
                touch(TouchKind::File, "src/lib.rs"),
                touch(TouchKind::Pull, "14"),
                touch(TouchKind::Commit, "abcdef1234"),
                touch(TouchKind::Branch, "fix-4"),
            ]
        );
    }

    #[test]
    fn links_gather_every_way_a_tree_was_tied_and_skip_what_is_unknown() {
        let record = |session: &str, kind, number, via| LinkRecord { session_id: session.into(), kind, number, via };
        let known: std::collections::HashMap<(LinkKind, u32), (String, String)> = [
            ((LinkKind::Item, 4), ("Greet".to_owned(), "open".to_owned())),
            ((LinkKind::Pull, 9), ("Greet in French".to_owned(), "open".to_owned())),
        ]
        .into_iter()
        .collect();
        let links = gather_links(
            &[
                record("ses_root", LinkKind::Item, 4, LinkVia::Ref),
                record("ses_root", LinkKind::Item, 4, LinkVia::Claim),
                record("ses_child", LinkKind::Pull, 9, LinkVia::Branch),
                record("ses_child", LinkKind::Pull, 9, LinkVia::Opened),
                record("ses_root", LinkKind::Item, 77, LinkVia::Ref),
            ],
            &known,
        );
        assert_eq!(links.len(), 2);
        assert_eq!((links[0].kind, links[0].number, links[0].via.clone()), (LinkKind::Pull, 9, vec![LinkVia::Branch, LinkVia::Opened]));
        assert_eq!(links[0].session_ids, vec!["ses_child".to_owned()]);
        assert_eq!((links[1].kind, links[1].number, links[1].via.clone()), (LinkKind::Item, 4, vec![LinkVia::Claim, LinkVia::Ref]));
    }

    #[test]
    fn a_session_from_before_subagents_reads_as_a_top_level_one() {
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "ses_1", "repoId": "rep_1", "item": null, "pull": null, "branch": null,
            "actor": { "id": "usr_1", "username": "ana" }, "harness": "claude_code",
            "harnessSessionId": null, "title": null, "state": "active", "headCommit": null,
            "startedAt": "", "lastSeenAt": "", "endedAt": null, "endReason": null
        }))
        .unwrap();
        assert_eq!((session.parent_id, session.subagents), (None, 0));
    }

    #[test]
    fn events_name_the_work_item_or_pull_request_they_are_about() {
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "ses_1", "repoId": "rep_1", "item": 4, "pull": 9, "branch": null,
            "actor": { "id": "usr_1", "username": "ana" }, "harness": "claude_code",
            "harnessSessionId": null, "title": null, "state": "active", "headCommit": null,
            "startedAt": "", "lastSeenAt": "", "endedAt": null, "endReason": null
        }))
        .unwrap();
        let event = serde_json::to_value(SessionEvent::of(&session)).unwrap();
        assert_eq!((event["number"].as_u64(), event["item"].as_u64()), (Some(9), Some(4)));
    }
}
