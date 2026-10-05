//! Agents at work and what they remember. Kept by the work service.
//!
//! Every sandbox g1t starts for an agent is an [`AgentRun`]: what it is
//! doing, on which pull request or issue, step by step, what it cost, and
//! how it ended. People watch runs live, stop them and message them.
//!
//! Memory is what agents and people have learned that the next agent
//! should know: about one project (its codebase), or about the whole
//! workspace (true across its projects). It is members-only, is given to
//! every g1t agent run, and never holds a secret.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::work::{Pull, PullStatus, SessionEntry};
use crate::{User, Viewer};

/// The work an agent run does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    /// Making the change an issue asks for.
    Implement,
    /// Addressing failed checks or a review on its own pull request.
    Revise,
    /// Reviewing someone's pull request.
    Review,
    /// Answering another agent's question or handoff.
    Answer,
    /// Merging in the branch a pull request will land on.
    Update,
    /// Turning an outcome into a plan of issues.
    Plan,
    /// Running an issue's acceptance checks. Not an agent: a sandbox.
    Checks,
    /// Building and checking a state of the merge queue. Not an agent.
    Queue,
    /// Finding out whether a pull request merges cleanly. Not an agent.
    Mergecheck,
}

impl RunKind {
    pub const ALL: [RunKind; 9] = [
        RunKind::Implement,
        RunKind::Revise,
        RunKind::Review,
        RunKind::Answer,
        RunKind::Update,
        RunKind::Plan,
        RunKind::Checks,
        RunKind::Queue,
        RunKind::Mergecheck,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RunKind::Implement => "implement",
            RunKind::Revise => "revise",
            RunKind::Review => "review",
            RunKind::Answer => "answer",
            RunKind::Update => "update",
            RunKind::Plan => "plan",
            RunKind::Checks => "checks",
            RunKind::Queue => "queue",
            RunKind::Mergecheck => "mergecheck",
        }
    }

    pub fn parse(value: &str) -> Option<RunKind> {
        RunKind::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    /// Whether a model does the work, rather than commands g1t runs.
    pub fn is_agent(self) -> bool {
        !matches!(self, RunKind::Checks | RunKind::Queue | RunKind::Mergecheck)
    }

    /// Whether a message reaches the agent while it runs: the harness asks
    /// for messages after each tool call in these. Others read nothing new
    /// until the next run on the same pull request.
    pub fn takes_messages(self) -> bool {
        matches!(self, RunKind::Implement | RunKind::Revise | RunKind::Answer)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Its sandbox is starting.
    Queued,
    Running,
    Succeeded,
    Failed,
    /// A person stopped it.
    Stopped,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
            RunStatus::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<RunStatus> {
        [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Stopped,
        ]
        .into_iter()
        .find(|status| status.as_str() == value)
    }

    pub fn is_active(self) -> bool {
        matches!(self, RunStatus::Queued | RunStatus::Running)
    }
}

/// One step of a run, as one short line.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunStep {
    /// RFC 3339.
    pub at: String,
    pub text: String,
}

/// One sandbox g1t started: an agent at work, or a run of checks.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub repo: RepoPath,
    /// The pull request it works on; for a plan, none.
    pub number: Option<u32>,
    /// That pull request's title, or the plan's brief.
    pub title: Option<String>,
    pub kind: RunKind,
    /// Who is working: `g1t-agent` for g1t's own agent, `g1t` for a sandbox
    /// that runs commands.
    pub agent: String,
    /// The model, by its public name. Members only.
    pub model: Option<String>,
    pub status: RunStatus,
    /// What it is doing now, in one line.
    pub step: Option<String>,
    /// Every step so far, oldest first. Empty in lists.
    #[serde(default)]
    pub steps: Vec<RunStep>,
    /// How many steps there are.
    #[serde(default)]
    pub step_count: u32,
    /// Who put it to work, when a person did.
    pub started_by: Option<String>,
    /// Why it failed.
    pub error: Option<String>,
    /// What it cost, in US dollars, as the harness reported it. Members only.
    pub cost_usd: Option<f64>,
    pub turns: Option<u32>,
    /// The most it may cost, in US dollars, from its guardrails. None: no
    /// cap. Members only.
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// The longest it may take, in minutes, from its guardrails.
    #[serde(default)]
    pub time_cap_minutes: Option<u32>,
    /// `budget` or `time` when g1t stopped it for reaching a cap.
    #[serde(default)]
    pub halted: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

/// What lets a sandbox, and nothing else, report on its run.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunTicket {
    pub run_id: String,
    pub token: String,
}

/// `open_run`: records a sandbox the runner is starting. Called by the
/// runner service only. Returns `Outcome<AgentRunTicket>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRunArgs {
    /// Who the sandbox acts as.
    pub actor: User,
    pub repo: RepoPath,
    #[serde(default)]
    pub number: Option<u32>,
    #[serde(default)]
    pub pull_id: Option<String>,
    /// For a run with no pull request, such as a plan: what it is about.
    #[serde(default)]
    pub title: Option<String>,
    pub kind: RunKind,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The sandbox's name, which stopping it needs.
    pub sandbox: String,
    #[serde(default)]
    pub started_by: Option<String>,
    /// Its cost cap, from its guardrails, in US dollars.
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// Its time cap, from its guardrails, in minutes.
    #[serde(default)]
    pub time_cap_minutes: Option<u32>,
}

/// `report_run`: a sandbox telling how its run goes, with the run's token.
/// Steps are added, the current step replaced, and an outcome ends the run.
/// A finished run accepts nothing more. Returns `Outcome<RunStatus>`: the
/// run's status after the report, so a sandbox can tell it was stopped.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportRunArgs {
    pub run_id: String,
    pub token: String,
    pub steps: Vec<String>,
    pub step: Option<String>,
    pub cost_usd: Option<f64>,
    pub turns: Option<u32>,
    /// `succeeded` or `failed`, to end the run.
    pub outcome: Option<RunStatus>,
    pub error: Option<String>,
    /// `budget` or `time`: the run reached a cap of its guardrails and
    /// stopped. Ends it as stopped, like a person's stop.
    pub halt: Option<crate::guardrails::Halt>,
}

/// `stop_run`: a member stops a run. Marks it stopped and returns where its
/// sandbox is, for the runner to destroy. A pull request it worked on waits
/// for a person. Returns `Outcome<StoppedRun>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StopRunArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedRun {
    pub run: AgentRun,
    pub sandbox: String,
}

/// `list_runs`: runs in a repository, or with `workspace` instead, in every
/// repository of a workspace (members only), newest first. Returns
/// `Outcome<Vec<AgentRun>>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListRunsArgs {
    pub viewer: Viewer,
    pub repo: Option<RepoPath>,
    pub workspace: Option<String>,
    /// Only those queued or running.
    pub active: bool,
    pub kind: Option<RunKind>,
    pub status: Option<RunStatus>,
    /// Only those on this pull request.
    pub number: Option<u32>,
    /// At most 200; 50 if not given.
    pub limit: Option<u32>,
}

/// `get_run`: one run with all its steps. Returns `Outcome<AgentRun>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetRunArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub id: String,
}

/// A pull request's recorded session, summed up for a list.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub number: u32,
    pub title: String,
    pub status: PullStatus,
    /// The agent label on the pull request, such as `g1t-agent`.
    pub agent: String,
    pub entries: u32,
    /// How many tools it called.
    pub tools: u32,
    /// The start of the first prompt.
    pub prompt: Option<String>,
    /// The kinds of the runs g1t made for it.
    pub kinds: Vec<RunKind>,
    pub runs: u32,
    /// What its runs cost together. Members only.
    pub cost_usd: Option<f64>,
    /// Whether one of its runs is under way.
    pub active: bool,
    /// RFC 3339.
    pub started_at: String,
    pub last_at: String,
}

/// `list_sessions`: the pull requests of a repository that have a session,
/// most recently active first. Returns `Outcome<Vec<SessionSummary>>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListSessionsArgs {
    pub viewer: Viewer,
    pub repo: Option<RepoPath>,
    /// Only those with a run of this kind.
    pub kind: Option<RunKind>,
    /// The pull request's status: `draft`, `open`, `merged` or `closed`.
    pub outcome: Option<PullStatus>,
    pub number: Option<u32>,
}

/// `get_session`: one pull request's session in full, with its runs.
/// Returns `Outcome<SessionView>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetSessionArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub number: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub pull: Pull,
    /// Oldest first; the first 2000.
    pub entries: Vec<SessionEntry>,
    /// Newest first, with their steps.
    pub runs: Vec<AgentRun>,
    /// Members only.
    pub cost_usd: Option<f64>,
}

// --- Memory -----------------------------------------------------------------

/// Whose memory: one project's, or the whole workspace's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    /// About one project's codebase.
    Project,
    /// True across the workspace's projects.
    Workspace,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryScope::Project => "project",
            MemoryScope::Workspace => "workspace",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    /// How something is: "staging lives at staging.example.com".
    #[default]
    Fact,
    /// How things are done here: "we use pnpm everywhere".
    Convention,
    /// Something chosen, and why: "we keep Postgres, not MySQL, for jsonb".
    Decision,
    /// A trap: "the tests need TZ=UTC or the date tests fail".
    Gotcha,
}

impl MemoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryKind::Fact => "fact",
            MemoryKind::Convention => "convention",
            MemoryKind::Decision => "decision",
            MemoryKind::Gotcha => "gotcha",
        }
    }

    pub fn parse(value: &str) -> Option<MemoryKind> {
        [
            MemoryKind::Fact,
            MemoryKind::Convention,
            MemoryKind::Decision,
            MemoryKind::Gotcha,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == value)
    }
}

/// Where a memory came from.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    /// `person`, `agent` or `run`.
    pub kind: String,
    /// The agent run that learned it.
    #[serde(default)]
    pub run_id: Option<String>,
    /// The project and pull request it was learned on.
    #[serde(default)]
    pub repo: Option<RepoPath>,
    #[serde(default)]
    pub number: Option<u32>,
    /// What it was captured from: `run:<id>`, `comment:<id>`,
    /// `pull:<repo id>#<n>`, `doc:<repo id>:<path>`. See `crate::capture`.
    #[serde(default)]
    pub reference: Option<String>,
    /// What it was learned from, quoted.
    #[serde(default)]
    pub evidence: Option<String>,
}

/// Whether agents are given a memory: `kept` ones are; a `candidate` waits
/// for review (see `crate::capture`); a `dismissed` one is never suggested
/// again from the same wording.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Candidate,
    #[default]
    Kept,
    Dismissed,
}

impl MemoryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MemoryStatus::Candidate => "candidate",
            MemoryStatus::Kept => "kept",
            MemoryStatus::Dismissed => "dismissed",
        }
    }

    pub fn parse(value: &str) -> Option<MemoryStatus> {
        [MemoryStatus::Candidate, MemoryStatus::Kept, MemoryStatus::Dismissed]
            .into_iter()
            .find(|status| status.as_str() == value)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub scope: MemoryScope,
    /// The workspace's slug.
    pub workspace: String,
    /// For a project's memory, the project's repository.
    pub repo: Option<RepoPath>,
    pub text: String,
    pub kind: MemoryKind,
    pub source: MemorySource,
    /// Who wrote it: a username, or `g1t-agent`.
    pub created_by: String,
    /// Pinned memories are given to every agent first.
    pub pinned: bool,
    /// RFC 3339.
    pub created_at: String,
    pub updated_at: String,
    /// When it was last given to an agent.
    pub last_used_at: Option<String>,
    /// Kept memories are given to agents; candidates wait for review.
    #[serde(default)]
    pub status: MemoryStatus,
    /// 0 to 1: how sure its source was. None for what people wrote.
    #[serde(default)]
    pub confidence: Option<f64>,
    /// How many independent sources said it.
    #[serde(default)]
    pub seen: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memories {
    /// The project's own; empty when no project was named.
    pub project: Vec<Memory>,
    pub workspace: Vec<Memory>,
}

/// `list_memories`: a workspace's memory and, with `repo`, that project's.
/// Members only. Returns `Outcome<Memories>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListMemoriesArgs {
    pub viewer: Viewer,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
}

/// `add_memory`: a member or an agent adds to memory. A project's memory
/// needs `repo`. Text that looks like a key or a token is refused.
/// Returns `Outcome<Memory>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMemoryArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    pub scope: MemoryScope,
    pub text: String,
    #[serde(default)]
    pub kind: MemoryKind,
    #[serde(default)]
    pub pinned: bool,
    /// For an agent: the pull request it is working on.
    #[serde(default)]
    pub from_number: Option<u32>,
}

/// `update_memory`: changes a memory's text, kind or pin. Members only.
/// Returns `Outcome<Memory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateMemoryArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub kind: Option<MemoryKind>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// `delete_memory`: forgets a memory. Members only. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteMemoryArgs {
    pub actor: User,
    pub workspace: String,
    pub id: String,
}

/// `recall`: what a project and its workspace remember, matching `query`
/// when given (every word, in any order), pinned first. Members and g1t's
/// agents. Returns `Outcome<Memories>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RecallArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `memory_context`: what to tell an agent starting work in `repo`, within
/// `budget` characters: pinned first, then the most recently used, the
/// workspace's and the project's labelled apart. Marks what it gives as
/// used. Called by the runner service only. Returns `MemoryContext`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MemoryContextArgs {
    pub repo: RepoPath,
    #[serde(default)]
    pub budget: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MemoryContext {
    /// None when there is nothing to tell.
    pub text: Option<String>,
    pub count: u32,
}

/// The longest a memory may be.
pub const MAX_MEMORY_CHARS: usize = 1000;

/// Prefixes of credentials that say what they are.
const SECRET_PREFIXES: [(&str, &str); 20] = [
    ("sk-ant-", "an Anthropic key"),
    ("sk-proj-", "an OpenAI key"),
    ("sk_live_", "a Stripe key"),
    ("sk_test_", "a Stripe key"),
    ("rk_live_", "a Stripe key"),
    ("whsec_", "a webhook signing secret"),
    ("ghp_", "a GitHub token"),
    ("gho_", "a GitHub token"),
    ("ghs_", "a GitHub token"),
    ("ghu_", "a GitHub token"),
    ("github_pat_", "a GitHub token"),
    ("glpat-", "a GitLab token"),
    ("xoxb-", "a Slack token"),
    ("xoxp-", "a Slack token"),
    ("AKIA", "an AWS access key"),
    ("ASIA", "an AWS access key"),
    ("AIza", "a Google API key"),
    ("g1t_", "a g1t token"),
    ("npm_", "an npm token"),
    ("SG.", "a SendGrid key"),
];

/// Words that, followed by `=` or `:` and a value, set a credential.
const SECRET_WORDS: [&str; 8] = [
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "api-key",
    "token",
    "private_key",
];

/// Bits of entropy per character of `word`.
fn entropy(word: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    for c in word.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
    }
    let length = word.chars().count() as f64;
    counts
        .values()
        .map(|&count| {
            let p = count as f64 / length;
            -p * p.log2()
        })
        .sum()
}

/// What `text` seems to hold that must never be stored in memory, which
/// every agent in the workspace reads: a key, a token, a private key or a
/// password. None when it looks clean. Errs on the side of refusing; a
/// person can always say where a secret lives instead of what it is.
pub fn secret_in(text: &str) -> Option<&'static str> {
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        return Some("a private key");
    }
    let lower = text.to_lowercase();
    for word in SECRET_WORDS {
        let mut rest = lower.as_str();
        while let Some(at) = rest.find(word) {
            let after = rest[at + word.len()..].trim_start_matches(['"', '\'', ' ']);
            if let Some(value) = after.strip_prefix(['=', ':']) {
                let value: String = value
                    .trim_start_matches([' ', '"', '\''])
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'' && *c != ',')
                    .collect();
                // "token: see 1Password" names where it is, which is fine.
                if value.chars().count() >= 8 && value.chars().any(|c| c.is_ascii_digit()) {
                    return Some("a password or token");
                }
            }
            rest = &rest[at + word.len()..];
        }
    }
    let words = text.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '<' | '>' | '[' | ']' | '{' | '}')
    });
    for word in words {
        let word = word.trim_end_matches(['.', ':']);
        // A key=value pair is judged by its value.
        let word = word.rsplit_once('=').map_or(word, |(_, value)| value);
        for (prefix, what) in SECRET_PREFIXES {
            if let Some(rest) = word.strip_prefix(prefix) {
                let tail = rest.chars().filter(|c| c.is_ascii_alphanumeric()).count();
                if tail >= 12 {
                    return Some(what);
                }
            }
        }
        // A URL with a password in it.
        if let Some((_, rest)) = word.split_once("://")
            && let Some((credentials, _)) = rest.split_once('@')
            && credentials.contains(':')
        {
            return Some("a URL with a password in it");
        }
        let length = word.chars().count();
        if length < 32 || word.contains("://") || word.contains('/') && !word.contains('+') {
            continue;
        }
        let token_chars = word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '='));
        if !token_chars {
            continue;
        }
        let hex = word.chars().all(|c| c.is_ascii_hexdigit());
        // A commit's id is 40 hex characters and fine; longer runs of hex
        // are keys and digests of keys.
        if hex {
            if length >= 48 {
                return Some("a key or token");
            }
            continue;
        }
        let upper = word.chars().any(|c| c.is_ascii_uppercase());
        let lower = word.chars().any(|c| c.is_ascii_lowercase());
        let digit = word.chars().any(|c| c.is_ascii_digit());
        if upper && lower && digit && entropy(word) > 4.0 {
            return Some("a key or token");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_knowledge_is_kept() {
        for text in [
            "We use pnpm everywhere, never npm or yarn.",
            "Staging lives at https://staging.example.com and deploys from main.",
            "The tests need TZ=UTC or the date tests fail.",
            "Commit 9f2c4e1a7b3d5f60812a4c6e8b0d2f4a6c8e0b13 introduced the flaky retry.",
            "The API token is in 1Password under 'Deploy'.",
            "token: ask Ana for one",
            "src/components/ui/select.tsx wraps Radix; import from there, not radix-ui.",
            "Run cargo test -p g1t-work before pushing changes to services/work.",
        ] {
            assert_eq!(secret_in(text), None, "{text}");
        }
    }

    #[test]
    fn credentials_are_refused() {
        // Key-shaped values are joined at run time: no whole key sits in the
        // source for secret scanners to flag.
        let join = |a: &str, b: &str| format!("{a}{b}");
        for text in [
            join("The key is sk-", "ant-api03-abcdefghijklmnopqrstuvwxyz"),
            join("use gh", "p_abcdefghijklmnopqrstuvwxyz0123456789 to clone"),
            join("AWS: AK", "IAIOSFODNN7EXAMPLE"),
            join("STRIPE_KEY=sk_l", "ive_51HabcdefghijklmnopQRSTUV"),
            "password = hunter2hunter2".to_owned(),
            "db: postgres://admin:s3cret@db.internal:5432/app".to_owned(),
            "token is 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a".to_owned(),
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE...".to_owned(),
            "secret: Zq8wN3vR7tY2uI5oP1aS6dF4gH9jK0lX".to_owned(),
            "it is xK9mQ2vL8nR4tP7wZ3yB6cF1dG5hJ0sA".to_owned(),
        ] {
            assert!(secret_in(&text).is_some(), "{text}");
        }
    }

    #[test]
    fn kinds_and_statuses_round_trip() {
        for kind in RunKind::ALL {
            assert_eq!(RunKind::parse(kind.as_str()), Some(kind));
        }
        assert!(RunKind::Implement.takes_messages() && !RunKind::Review.takes_messages());
        assert!(!RunKind::Checks.is_agent());
        assert_eq!(RunStatus::parse("stopped"), Some(RunStatus::Stopped));
        assert!(RunStatus::Queued.is_active() && !RunStatus::Failed.is_active());
        assert_eq!(MemoryKind::parse("gotcha"), Some(MemoryKind::Gotcha));
    }
}
