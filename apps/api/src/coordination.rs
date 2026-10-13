//! Coordinating work over REST and MCP: sessions of people's own harnesses
//! (the MCP `session` tool), and claims and an issue's whole context
//! (actions of the `issue` tool).
//!
//! The work service keeps them and decides who may see and change them
//! (`g1t_contracts::work::coordination`): anyone who can read the
//! repository reads them; taking part needs a confirmed email address and a
//! role that may open issues and pull requests; only the person whose
//! token started a session, or made a claim, changes it.

use g1t_contracts::agent_sessions::{AgentMode, StartAgentSessionArgs};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation on sessions, claims or an issue's context.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinationOp {
    StartSession,
    UpdateSession,
    EndSession,
    GetSession,
    ListSessions,
    RecordSessionEntries,
    ClaimIssue,
    ReleaseClaim,
    HandOffIssue,
    ListClaims,
    GetWork,
    StartAgentSession,
}

impl CoordinationOp {
    /// Every one: `Op::ALL` lists each as `Op::Coordination(…)`, which a
    /// test checks against this.
    pub const ALL: [CoordinationOp; 12] = [
        CoordinationOp::StartSession,
        CoordinationOp::UpdateSession,
        CoordinationOp::EndSession,
        CoordinationOp::GetSession,
        CoordinationOp::ListSessions,
        CoordinationOp::RecordSessionEntries,
        CoordinationOp::ClaimIssue,
        CoordinationOp::ReleaseClaim,
        CoordinationOp::HandOffIssue,
        CoordinationOp::ListClaims,
        CoordinationOp::GetWork,
        CoordinationOp::StartAgentSession,
    ];

    pub fn name(self) -> &'static str {
        match self {
            CoordinationOp::StartSession => "start_session",
            CoordinationOp::UpdateSession => "update_session",
            CoordinationOp::EndSession => "end_session",
            CoordinationOp::GetSession => "get_session",
            CoordinationOp::ListSessions => "list_sessions",
            CoordinationOp::RecordSessionEntries => "record_session_entries",
            CoordinationOp::ClaimIssue => "claim_issue",
            CoordinationOp::ReleaseClaim => "release_claim",
            CoordinationOp::HandOffIssue => "hand_off_issue",
            CoordinationOp::ListClaims => "list_claims",
            CoordinationOp::GetWork => "get_work",
            CoordinationOp::StartAgentSession => "start_agent_session",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            CoordinationOp::StartSession => "Start a session",
            CoordinationOp::UpdateSession => "Update a session",
            CoordinationOp::EndSession => "End a session",
            CoordinationOp::GetSession => "Get a session",
            CoordinationOp::ListSessions => "List sessions",
            CoordinationOp::RecordSessionEntries => "Record entries in a session",
            CoordinationOp::ClaimIssue => "Claim an issue",
            CoordinationOp::ReleaseClaim => "Release a claim",
            CoordinationOp::HandOffIssue => "Hand off an issue",
            CoordinationOp::ListClaims => "List claims",
            CoordinationOp::GetWork => "Get an issue's work context",
            CoordinationOp::StartAgentSession => "Start an agent session on an issue",
        }
    }

    /// Whether it only reads.
    pub fn reads(self) -> bool {
        matches!(
            self,
            CoordinationOp::GetSession | CoordinationOp::ListSessions | CoordinationOp::ListClaims | CoordinationOp::GetWork
        )
    }

    pub fn description(self) -> &'static str {
        match self {
            CoordinationOp::StartSession => "Start a session: one run of your own harness (a Claude Code session, a Codex run) on a repository, so others can see who is working on what. `harness` is claude_code, codex, cursor, copilot or other. Give `harness_session_id`, the harness's own id for the session, and starting again with it returns the session already started (refreshing the issue, pull request, branch, title and head given) instead of a new one, so a hook that fires twice is harmless. `issue` and `pull` attach it to an issue and a pull request of the repository; a pull request for an issue attaches that issue too. A subagent is a session of its own: give `parent_id` (one of your sessions here), its `agent_type`, the `task` and `prompt` its parent gave it, and as `harness_session_id` the parent's harness id, `/agent/` and the subagent's id; it starts on the parent's issue, pull request and branch unless it says otherwise, sees and is seen by its siblings in get_work and list_sessions, and once ended stays ended when started again. Returns the session (`id` `ses_…`, `state` active, idle or ended). A new session, or one started again after it ended, is a session.started event. Needs a confirmed email address and a role that may open issues.",
            CoordinationOp::UpdateSession => "Update one of your sessions: attach it to an issue or pull request, or change its branch, head commit or title. Only the fields given change. An empty body is a heartbeat: every call keeps the session active and renews the claims made from it. A session reads as idle after 15 minutes without one and ends (`end_reason` timed_out) after 2 hours; a heartbeat brings a timed-out one back. Attaching a pull request moves the entries recorded so far into that pull request's session. A subagent's `task`, `prompt`, `model` and `result` (what it reported, up to 8,000 characters) can be set too; a subagent that ended takes them and stays ended. Returns the session; one ended with end_session is refused with `409`.",
            CoordinationOp::EndSession => "End one of your sessions, with an optional `reason` and `result` (what it reported when it finished: a subagent's final message, up to 8,000 characters, never a tool's output). A session.ended event. Ending one already ended returns it as it is, taking `result` if it had none. Its subagents still going end with it (`parent ended`). Its claims are not released: release them, hand the issue off, or let them expire.",
            CoordinationOp::GetSession => "A session and its entries, oldest first, numbered within the session (`seq`); `after` gives the entries after that number, 500 at a time. With them: `children`, its subagents and theirs in the order they started (each names its `parent_id`); `touched`, the files, commits, branches, pull requests and issues it and they touched; `links`, the issues and pull requests they worked on and how each was tied (`via`: attached, claim, branch, commit, trailer, opened or ref); `skills`, the skills they used by name; and for a subagent, `root`, the session at the top of its tree. Anyone who can read the repository may.",
            CoordinationOp::ListSessions => "A repository's sessions, most recently heard from first, up to 100: `state` active (heard from in the last 15 minutes), idle or ended; `issue` or `pull` for those on one, attached or tied to it any other way; `path` for those that touched a file (or any under a folder ending in `/`). Subagents are left out unless `subagents` is true, which lists each tree whole. Each says how many `subagents` it started. Anyone who can read the repository may.",
            CoordinationOp::RecordSessionEntries => "Record entries in one of your sessions: up to 200 at a time, each with `kind` (prompt, message, tool_call, tool_result, note, or skill for a skill it used, by name), `text` (up to 64,000 characters), and for tools `tool`. Give each a `key` and recording it again does nothing, so a retried hook records it once. `touched` says what it touched, up to 200: `{ kind, value }` with kind file (a path from the repository's root), commit, branch, pull (one it opened) or issue (one it named); each is kept once, ties the session to the pull requests and issues it names, and a file another active session touched too (outside its own parents and subagents, so siblings yes) is an overlap.detected event for both, once per pair. Entries of a session attached to a pull request show in that pull request's session too, where reviewers read why the change is what it is. Recording is a heartbeat. Returns how many were `recorded` and how many were `duplicates`.",
            CoordinationOp::ClaimIssue => "Claim an open issue: say you are working on it. A claim is advisory, never a lock: anyone may claim an issue someone else has, and `others` lists the claims already on it, so you can coordinate or pick something else. It lasts `ttl_minutes` (30 unless you say, up to 240) and is renewed by claiming again or, when you give the `session_id` of one of your sessions, by that session's heartbeats. Returns your `claim`, the `others`, and `blocked_by`: each issue this one waits on, with its claims and pull requests. A new claim is a work.claimed event; one taking over a hand-off says which in `took_over`.",
            CoordinationOp::ReleaseClaim => "Release your claim on an issue, with an optional `reason`: you stopped working on it. A work.released event. Claims also end when the issue closes, and expire when not renewed. Refused with `404` when you hold no active claim on it.",
            CoordinationOp::HandOffIssue => "Hand an issue you claimed off: your claim ends as handed_off, with `note` saying where the work stands, for `to` (a username) or, without one, for anyone. A work.handoff_requested event, which whoever follows the issue hears; the next claim on it says it took the hand-off over. Refused with `404` when you hold no active claim on it.",
            CoordinationOp::ListClaims => "A repository's claims, newest first, up to 100: active ones unless `state` says released, expired or handed_off, and `issue` for one issue's. Anyone who can read the repository may.",
            CoordinationOp::GetWork => "Everything about an issue an agent needs before working on it, in one call: the `issue`, its `definition_of_done` (the items under its \"Definition of done\" heading) and the `required_checks` every pull request into the default branch must pass; active `claims`; `sessions` on it or its pull requests; its `pulls`, each with its status, required checks as they stand on its head, whether it merges cleanly, the other pull requests it overlaps and its place in the merge queue; `blocked_by` (each issue it waits on, with claims and pull requests) and `blocks` (the issues waiting on it); `decisions` recorded about it; `last_integration_failure`; and `recent`, its latest coordination events, newest first.",
            CoordinationOp::StartAgentSession => "Start work on an issue in a session of its own, on the person's own Claude: g1t runs no model and bills nothing for it. Give `issue`, or `title` and `body` to open a new issue first; `instruction` adds to what the session is asked; `mode` (plan, implement or review) says what kind of work it is. With the workspace's Anthropic connection (an owner adds it under Integrations), g1t starts a Claude Managed Agents session with that key: g1t's MCP server attached with a credential for you and this repository only that lasts the session and is kept in a vault on the Anthropic account (never in the prompt), g1t's skills (work-on-issue, coordinate, fix-integration) next to the account's own, and the session, its subagents (threads), what they touched and what they reported recorded here as a g1t session (`harness` claude_managed_agents). Returns `session`, its `session_url` on g1t, `provider_session_url`, and `prompt`. With `handoff` true, or without an Anthropic connection when `handoff` is not false, nothing is started: `command` is a Claude Code command line, and `prompt` what to paste, for someone with g1t's Claude Code plugin, whose session then attaches to the issue as it starts.",
        }
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": "string", "description": "The session's id (ses_…), from start_session or list_sessions." });
        let number = json!({ "type": "integer", "description": "The issue's number." });
        let issue = json!({ "type": "integer", "description": "The issue it works on." });
        let pull = json!({ "type": "integer", "description": "The pull request it works on." });
        let fields = |more: Value| -> Value {
            let mut properties = json!({
                "repo": repo,
                "issue": issue,
                "pull": pull,
                "branch": { "type": "string", "description": "The branch it works on." },
                "title": { "type": "string", "description": "What it is doing, in a few words. Up to 200 characters." },
                "head_commit": { "type": "string", "description": "The commit it is at, such as after a push." },
            });
            if let (Some(all), Value::Object(more)) = (properties.as_object_mut(), more) {
                all.extend(more);
            }
            properties
        };
        let session_id = json!({ "type": "string", "description": "The session (ses_…) whose claim it is, when you have several on the issue, such as sibling subagents." });
        let subagent = json!({
            "agent_type": { "type": "string", "description": "For a subagent: its kind, as the harness names it (Explore, security-reviewer)." },
            "task": { "type": "string", "description": "For a subagent: the task it was given, in a few words. Up to 200 characters." },
            "prompt": { "type": "string", "description": "For a subagent: the prompt its parent gave it. Kept up to 4,000 characters." },
            "model": { "type": "string", "description": "The model it runs on, when known." },
        });
        let with = |base: Value, more: Value| -> Value {
            let mut base = base;
            if let (Some(all), Value::Object(more)) = (base.as_object_mut(), more) {
                all.extend(more);
            }
            base
        };
        let result = json!({ "type": "string", "description": "What it reported when it finished: a subagent's final message. Kept up to 8,000 characters. Never a tool's output." });
        let (properties, required): (Value, &[&str]) = match self {
            CoordinationOp::StartSession => (
                with(
                    fields(json!({
                        "harness": {
                            "type": "string",
                            "enum": Harness::ALL.map(Harness::as_str),
                            "description": "The harness the session runs in.",
                        },
                        "harness_session_id": {
                            "type": "string",
                            "description": "The harness's own id for the session, such as Claude Code's session_id; for a subagent, the parent's, `/agent/` and the subagent's id. Starting again with it returns the same session.",
                        },
                        "parent_id": { "type": "string", "description": "For a subagent: the session that started it (ses_…), one of yours on the repository." },
                    })),
                    subagent.clone(),
                ),
                &["repo", "harness"],
            ),
            CoordinationOp::UpdateSession => (with(fields(json!({ "id": id, "result": result })), subagent.clone()), &["repo", "id"]),
            CoordinationOp::EndSession => (
                json!({
                    "repo": repo,
                    "id": id,
                    "reason": { "type": "string", "description": "Why it ended, in a few words. \"ended\" if left out." },
                    "result": result,
                }),
                &["repo", "id"],
            ),
            CoordinationOp::GetSession => (
                json!({
                    "repo": repo,
                    "id": id,
                    "after": { "type": "integer", "description": "Only entries after this sequence number, for the next page." },
                }),
                &["repo", "id"],
            ),
            CoordinationOp::ListSessions => (
                json!({
                    "repo": repo,
                    "state": { "type": "string", "enum": ["active", "idle", "ended"], "description": "Only sessions in this state." },
                    "issue": { "type": "integer", "description": "Only sessions on this issue: attached, or tied to it any other way." },
                    "pull": { "type": "integer", "description": "Only sessions on this pull request: attached, or tied to it any other way." },
                    "path": { "type": "string", "description": "Only sessions that touched this file, or any under it when it ends in `/`." },
                    "subagents": { "type": "boolean", "description": "List subagents too, each tree whole. Left out, only the sessions at the top." },
                }),
                &["repo"],
            ),
            CoordinationOp::RecordSessionEntries => (
                json!({
                    "repo": repo,
                    "id": id,
                    "entries": {
                        "type": "array",
                        "description": "Up to 200 entries, oldest first.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["prompt", "message", "tool_call", "tool_result", "note", "skill"] },
                                "text": { "type": "string", "description": "For a skill, its name only." },
                                "tool": { "type": "string", "description": "For tool_call and tool_result: the tool's name." },
                                "commit": { "type": "string", "description": "The commit it was recorded at; the session's head if left out." },
                                "key": { "type": "string", "description": "An idempotency key, unique in the session: an entry with a key recorded before is skipped." },
                            },
                            "required": ["kind", "text"],
                        },
                    },
                    "touched": {
                        "type": "array",
                        "description": "What it touched, up to 200, each kept once.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "enum": ["file", "commit", "branch", "pull", "issue"] },
                                "value": { "type": "string", "description": "A path from the repository's root, a commit, a branch, or a number." },
                            },
                            "required": ["kind", "value"],
                        },
                    },
                }),
                &["repo", "id"],
            ),
            CoordinationOp::ClaimIssue => (
                json!({
                    "repo": repo,
                    "number": number,
                    "session_id": { "type": "string", "description": "One of your sessions (ses_…) on the repository: its heartbeats renew the claim." },
                    "note": { "type": "string", "description": "What you are doing, for whoever else looks. Up to 500 characters." },
                    "ttl_minutes": { "type": "integer", "description": "How long it lasts unless renewed: 30 unless you say, at most 240." },
                }),
                &["repo", "number"],
            ),
            CoordinationOp::ReleaseClaim => (
                json!({
                    "repo": repo,
                    "number": number,
                    "reason": { "type": "string", "description": "Why, in a few words. \"released\" if left out." },
                    "session_id": session_id,
                }),
                &["repo", "number"],
            ),
            CoordinationOp::HandOffIssue => (
                json!({
                    "repo": repo,
                    "number": number,
                    "to": { "type": "string", "description": "The username it is for. Left out, it is for anyone." },
                    "note": { "type": "string", "description": "Where the work stands: what is done, what is left, what to watch for. Up to 500 characters." },
                    "session_id": session_id,
                }),
                &["repo", "number", "note"],
            ),
            CoordinationOp::ListClaims => (
                json!({
                    "repo": repo,
                    "state": {
                        "type": "string",
                        "enum": ["active", "released", "expired", "handed_off"],
                        "description": "Claims in this state; active if left out.",
                    },
                    "issue": { "type": "integer", "description": "Only claims on this issue." },
                }),
                &["repo"],
            ),
            CoordinationOp::GetWork => (json!({ "repo": repo, "number": number }), &["repo", "number"]),
            CoordinationOp::StartAgentSession => (
                json!({
                    "repo": repo,
                    "issue": { "type": "integer", "description": "The issue to work on. Left out, give title (and body) to open one." },
                    "title": { "type": "string", "description": "Without issue: the title of a new issue to open and work on." },
                    "body": { "type": "string", "description": "Without issue: the new issue's description." },
                    "instruction": { "type": "string", "description": "What to do beyond what the issue says. Up to 4,000 characters." },
                    "mode": { "type": "string", "enum": ["plan", "implement", "review"], "description": "What kind of work: plan (say how, change nothing), implement (the default) or review (review its pull request)." },
                    "handoff": { "type": "boolean", "description": "true for a Claude Code command and prompt to run yourself instead of a session on the workspace's Anthropic account; false to refuse when there is no Anthropic connection. Left out, a session when the workspace can, else the hand-off." },
                }),
                &["repo"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// A whole number given as a number, as digits, or as `#12`.
fn number(input: &Value, key: &str) -> Option<u32> {
    match &input[key] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.trim().trim_start_matches('#').parse().ok(),
        _ => None,
    }
}

/// An optional whole number: none when left out, refused when not one.
fn optional_number(input: &Value, key: &str) -> std::result::Result<Option<u32>, String> {
    match &input[key] {
        Value::Null => Ok(None),
        Value::String(text) if text.trim().is_empty() => Ok(None),
        _ => number(input, key).map(Some).ok_or_else(|| format!("{key} is a number.")),
    }
}

/// `blocked_by` for `update_issue`: issue numbers, as numbers, digits or
/// `#12`. None when left out; refused when it holds anything else.
pub fn blocked_by(input: &Value) -> std::result::Result<Option<Vec<u32>>, String> {
    let items = match &input["blocked_by"] {
        Value::Null => return Ok(None),
        Value::Array(items) => items,
        _ => return Err("blocked_by is a list of issue numbers.".to_owned()),
    };
    items
        .iter()
        .map(|item| number(&json!({ "n": item }), "n").ok_or_else(|| format!("blocked_by holds {item}, which is not an issue number.")))
        .collect::<std::result::Result<Vec<u32>, String>>()
        .map(Some)
}

pub async fn run(op: CoordinationOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(repo) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let invalid = |message: String| Ok(Outcome::fail(FailureCode::Invalid, message));
    let (issue, pull) = match (optional_number(input, "issue"), optional_number(input, "pull")) {
        (Ok(issue), Ok(pull)) => (issue, pull),
        (Err(message), _) | (_, Err(message)) => return invalid(message),
    };
    let actor = || viewer.clone().unwrap_or_default();
    let id = || text(input, "id").unwrap_or_default();
    let issue_number = number(input, "number").unwrap_or_default();
    let work = &services.work;
    if matches!(
        op,
        CoordinationOp::UpdateSession | CoordinationOp::EndSession | CoordinationOp::GetSession | CoordinationOp::RecordSessionEntries
    ) && id().is_empty()
    {
        return invalid("Name the session by its id (ses_…).".to_owned());
    }
    match op {
        CoordinationOp::StartSession => {
            let Some(harness) = input["harness"].as_str().and_then(Harness::parse) else {
                let names: Vec<&str> = Harness::ALL.iter().map(|harness| harness.as_str()).collect();
                return invalid(format!("harness is one of {}.", names.join(", ")));
            };
            let args = StartSessionArgs {
                actor: actor(),
                repo,
                harness,
                harness_session_id: text(input, "harness_session_id"),
                issue,
                pull,
                branch: text(input, "branch"),
                title: text(input, "title"),
                head_commit: text(input, "head_commit"),
                parent_id: text(input, "parent_id"),
                agent_type: text(input, "agent_type"),
                task: text(input, "task"),
                prompt: text(input, "prompt"),
                model: text(input, "model"),
            };
            g1t_kit::call(work, "start_session", &args).await
        }
        CoordinationOp::UpdateSession => {
            let args = UpdateSessionArgs {
                actor: actor(),
                repo,
                id: id(),
                issue,
                pull,
                branch: text(input, "branch"),
                head_commit: text(input, "head_commit"),
                title: text(input, "title"),
                agent_type: text(input, "agent_type"),
                task: text(input, "task"),
                prompt: text(input, "prompt"),
                model: text(input, "model"),
                result: text(input, "result"),
            };
            g1t_kit::call(work, "update_session", &args).await
        }
        CoordinationOp::EndSession => {
            let args = EndSessionArgs { actor: actor(), repo, id: id(), reason: text(input, "reason"), result: text(input, "result") };
            g1t_kit::call(work, "end_session", &args).await
        }
        CoordinationOp::GetSession => {
            let args = WorkSessionArgs { viewer: viewer.clone(), repo, id: id(), after_seq: number(input, "after").unwrap_or_default() };
            g1t_kit::call(work, "get_work_session", &args).await
        }
        CoordinationOp::ListSessions => {
            let state = match text(input, "state") {
                None => None,
                Some(state) => match SessionState::parse(&state) {
                    Some(state) => Some(state),
                    None => return invalid(format!("state is active, idle or ended, not {state}.")),
                },
            };
            let subagents = matches!(&input["subagents"], Value::Bool(true)) || input["subagents"].as_str() == Some("true");
            let args = ListWorkSessionsArgs { viewer: viewer.clone(), repo, state, issue, pull, subagents, path: text(input, "path") };
            g1t_kit::call(work, "list_work_sessions", &args).await
        }
        CoordinationOp::RecordSessionEntries => {
            let entries: Vec<KeyedSessionEntry> = match serde_json::from_value(match &input["entries"] {
                Value::Null => json!([]),
                entries => entries.clone(),
            }) {
                Ok(entries) => entries,
                Err(_) => {
                    return invalid(
                        "entries is a list of { kind, text }, kind one of prompt, message, tool_call, tool_result, note or skill, with tool, commit and key as needed.".to_owned(),
                    );
                }
            };
            let touched: Vec<NewTouch> = match serde_json::from_value(match &input["touched"] {
                Value::Null => json!([]),
                touched => touched.clone(),
            }) {
                Ok(touched) => touched,
                Err(_) => return invalid("touched is a list of { kind, value }, kind one of file, commit, branch, pull or issue.".to_owned()),
            };
            let args = RecordEntriesArgs { actor: actor(), repo, id: id(), entries, touched };
            g1t_kit::call(work, "record_session_entries", &args).await
        }
        CoordinationOp::ClaimIssue => {
            let ttl_minutes = match optional_number(input, "ttl_minutes") {
                Ok(minutes) => minutes,
                Err(message) => return invalid(message),
            };
            let args = ClaimArgs {
                actor: actor(),
                repo,
                number: issue_number,
                session_id: text(input, "session_id"),
                note: text(input, "note"),
                ttl_minutes,
            };
            g1t_kit::call(work, "claim_issue", &args).await
        }
        CoordinationOp::ReleaseClaim => {
            let args = ReleaseArgs { actor: actor(), repo, number: issue_number, reason: text(input, "reason"), session_id: text(input, "session_id") };
            g1t_kit::call(work, "release_claim", &args).await
        }
        CoordinationOp::HandOffIssue => {
            let Some(note) = text(input, "note") else {
                return invalid("Say where the work stands in note, for whoever picks it up.".to_owned());
            };
            let args = HandOffArgs { actor: actor(), repo, number: issue_number, to: text(input, "to"), note, session_id: text(input, "session_id") };
            g1t_kit::call(work, "hand_off_issue", &args).await
        }
        CoordinationOp::ListClaims => {
            let state = match text(input, "state") {
                None => None,
                Some(state) => match ClaimState::parse(&state) {
                    Some(state) => Some(state),
                    None => return invalid(format!("state is active, released, expired or handed_off, not {state}.")),
                },
            };
            let args = ListClaimsArgs { viewer: viewer.clone(), repo, state, issue };
            g1t_kit::call(work, "list_claims", &args).await
        }
        CoordinationOp::GetWork => {
            let args = GetWorkArgs { viewer: viewer.clone(), repo, number: issue_number };
            g1t_kit::call(work, "get_work", &args).await
        }
        CoordinationOp::StartAgentSession => {
            let mode = match text(input, "mode") {
                None => None,
                Some(mode) => match AgentMode::parse(&mode) {
                    Some(mode) => Some(mode),
                    None => return invalid(format!("mode is plan, implement or review, not {mode}.")),
                },
            };
            if issue.is_none() && text(input, "title").is_none() {
                return invalid("Name the issue, or give a title (and body) for a new one.".to_owned());
            }
            let handoff = match &input["handoff"] {
                Value::Bool(handoff) => Some(*handoff),
                Value::String(text) if text == "true" => Some(true),
                Value::String(text) if text == "false" => Some(false),
                _ => None,
            };
            let args = StartAgentSessionArgs {
                actor: actor(),
                repo,
                issue,
                title: text(input, "title"),
                body: text(input, "body"),
                instruction: text(input, "instruction"),
                mode,
                handoff,
            };
            g1t_kit::call(&services.integrations, "start_agent_session", &args).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::Op;
    use g1t_contracts::scopes::{Level, Scope, scope_for};

    #[test]
    fn each_operation_is_described_scoped_and_listed() {
        for op in CoordinationOp::ALL {
            assert!(Op::ALL.contains(&Op::Coordination(op)), "{}", op.name());
            assert_eq!(Op::by_name(op.name()), Some(Op::Coordination(op)));
            assert!(!op.title().is_empty() && op.description().len() > 80, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            let scope = scope_for(op.name()).unwrap();
            assert_eq!(scope.level() == Level::Read, op.reads(), "{}", op.name());
            let sessions = op.name().contains("session");
            let expected = match (sessions, op.reads()) {
                (true, true) => Scope::PullRequestsRead,
                (true, false) => Scope::PullRequestsWrite,
                (false, true) => Scope::IssuesRead,
                (false, false) => Scope::IssuesWrite,
            };
            assert_eq!(scope, expected, "{}", op.name());
        }
    }

    #[test]
    fn routes_reach_each_operation_with_its_input() {
        let resolve = |method: &str, path: &str, query: &[(&str, &str)], body: Value| {
            let query: Vec<(String, String)> = query.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            let (route, input) = crate::rest::resolve(method, path, &query, body).unwrap();
            (route.op, input)
        };
        let coordination = |op| Op::Coordination(op);
        let (op, input) = resolve("POST", "/repos/acme/web/sessions", &[], json!({ "harness": "claude_code" }));
        assert_eq!(op, coordination(CoordinationOp::StartSession));
        assert_eq!(input, json!({ "harness": "claude_code", "repo": "acme/web" }));
        let (op, input) = resolve("PATCH", "/repos/acme/web/sessions/ses_1", &[], json!({}));
        assert_eq!(op, coordination(CoordinationOp::UpdateSession));
        assert_eq!(input, json!({ "id": "ses_1", "repo": "acme/web" }));
        let (op, _) = resolve("POST", "/repos/acme/web/sessions/ses_1/end", &[], json!({}));
        assert_eq!(op, coordination(CoordinationOp::EndSession));
        let (op, input) = resolve("GET", "/repos/acme/web/sessions/ses_1", &[("after", "40")], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::GetSession));
        assert_eq!(input["after"], "40");
        let (op, input) = resolve("GET", "/repos/acme/web/sessions", &[("state", "idle"), ("issue", "4")], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::ListSessions));
        assert_eq!(input, json!({ "state": "idle", "issue": "4", "repo": "acme/web" }));
        let (op, _) = resolve("POST", "/repos/acme/web/sessions/ses_1/entries", &[], json!({ "entries": [] }));
        assert_eq!(op, coordination(CoordinationOp::RecordSessionEntries));
        let (op, input) = resolve("POST", "/repos/acme/web/issues/4/claim", &[], json!({ "note": "on it" }));
        assert_eq!(op, coordination(CoordinationOp::ClaimIssue));
        assert_eq!(input, json!({ "note": "on it", "number": 4, "repo": "acme/web" }));
        let (op, _) = resolve("POST", "/repos/acme/web/issues/4/release", &[], json!({}));
        assert_eq!(op, coordination(CoordinationOp::ReleaseClaim));
        let (op, _) = resolve("POST", "/repos/acme/web/issues/4/handoff", &[], json!({ "note": "half done" }));
        assert_eq!(op, coordination(CoordinationOp::HandOffIssue));
        let (op, _) = resolve("GET", "/repos/acme/web/claims", &[("state", "active")], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::ListClaims));
        let (op, input) = resolve("GET", "/repos/acme/web/issues/4/work", &[], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::GetWork));
        assert_eq!(input, json!({ "number": 4, "repo": "acme/web" }));
    }

    #[test]
    fn mcp_actions_reach_each_operation() {
        use crate::tools::{Tool, resolve};
        let call = |tool: &str, action: &str| resolve(Tool::by_name(tool).unwrap(), &json!({ "action": action, "repo": "a/b", "id": "ses_1", "number": 4, "harness": "codex", "entries": [], "note": "x" }));
        assert_eq!(call("session", "start"), Ok(Op::Coordination(CoordinationOp::StartSession)));
        assert_eq!(call("session", "update"), Ok(Op::Coordination(CoordinationOp::UpdateSession)));
        assert_eq!(call("session", "record"), Ok(Op::Coordination(CoordinationOp::RecordSessionEntries)));
        assert_eq!(call("issue", "claim"), Ok(Op::Coordination(CoordinationOp::ClaimIssue)));
        assert_eq!(call("issue", "work"), Ok(Op::Coordination(CoordinationOp::GetWork)));
    }

    #[test]
    fn numbers_come_as_numbers_digits_or_with_a_hash() {
        assert_eq!(blocked_by(&json!({})), Ok(None));
        assert_eq!(blocked_by(&json!({ "blocked_by": [3, "4", "#5"] })), Ok(Some(vec![3, 4, 5])));
        assert_eq!(blocked_by(&json!({ "blocked_by": [] })), Ok(Some(vec![])));
        assert!(blocked_by(&json!({ "blocked_by": ["x"] })).is_err());
        assert!(blocked_by(&json!({ "blocked_by": 3 })).is_err());
        assert_eq!(optional_number(&json!({ "issue": "" }), "issue"), Ok(None));
        assert!(optional_number(&json!({ "issue": "soon" }), "issue").is_err());
    }
}
