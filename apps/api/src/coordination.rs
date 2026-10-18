//! Coordinating work over REST and MCP: sessions of people's own harnesses
//! (the MCP `session` tool), and claims and a work item's whole context
//! (actions of the `work_item` tool).
//!
//! The work service keeps them and decides who may see and change them
//! (`g1t_contracts::work::coordination`): anyone who may see the work item
//! or read the repository reads them; taking part needs a confirmed email
//! address and a role that may open work items and pull requests; only the
//! person whose token started a session, or made a claim, changes it.
//! Sessions are a repository's, where they are checked out; claims and
//! work contexts are of a workspace's work items.

use g1t_contracts::agent_sessions::{AgentMode, StartAgentSessionArgs};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use g1t_contracts::repos::RepoPath;

use crate::operations::{Services, item_workspace, repo_path};

/// One operation on sessions, claims or a work item's context.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinationOp {
    StartSession,
    UpdateSession,
    EndSession,
    GetSession,
    ListSessions,
    RecordSessionEntries,
    ClaimWorkItem,
    ReleaseClaim,
    HandOffWorkItem,
    ListClaims,
    GetWork,
    StartAgentSession,
    ListWorkspaceSessions,
    GetWorkspaceSession,
}

impl CoordinationOp {
    /// Every one: `Op::ALL` lists each as `Op::Coordination(…)`, which a
    /// test checks against this.
    pub const ALL: [CoordinationOp; 14] = [
        CoordinationOp::StartSession,
        CoordinationOp::UpdateSession,
        CoordinationOp::EndSession,
        CoordinationOp::GetSession,
        CoordinationOp::ListSessions,
        CoordinationOp::RecordSessionEntries,
        CoordinationOp::ClaimWorkItem,
        CoordinationOp::ReleaseClaim,
        CoordinationOp::HandOffWorkItem,
        CoordinationOp::ListClaims,
        CoordinationOp::GetWork,
        CoordinationOp::StartAgentSession,
        CoordinationOp::ListWorkspaceSessions,
        CoordinationOp::GetWorkspaceSession,
    ];

    pub fn name(self) -> &'static str {
        match self {
            CoordinationOp::StartSession => "start_session",
            CoordinationOp::UpdateSession => "update_session",
            CoordinationOp::EndSession => "end_session",
            CoordinationOp::GetSession => "get_session",
            CoordinationOp::ListSessions => "list_sessions",
            CoordinationOp::RecordSessionEntries => "record_session_entries",
            CoordinationOp::ClaimWorkItem => "claim_work_item",
            CoordinationOp::ReleaseClaim => "release_claim",
            CoordinationOp::HandOffWorkItem => "hand_off_work_item",
            CoordinationOp::ListClaims => "list_claims",
            CoordinationOp::GetWork => "get_work",
            CoordinationOp::StartAgentSession => "start_agent_session",
            CoordinationOp::ListWorkspaceSessions => "list_workspace_sessions",
            CoordinationOp::GetWorkspaceSession => "get_workspace_session",
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
            CoordinationOp::ClaimWorkItem => "Claim a work item",
            CoordinationOp::ReleaseClaim => "Release a claim",
            CoordinationOp::HandOffWorkItem => "Hand off a work item",
            CoordinationOp::ListClaims => "List claims",
            CoordinationOp::GetWork => "Get a work item's work context",
            CoordinationOp::StartAgentSession => "Start an agent session on a work item",
            CoordinationOp::ListWorkspaceSessions => "List a workspace's sessions",
            CoordinationOp::GetWorkspaceSession => "Get a session of a workspace",
        }
    }

    /// Whether it is about one repository: sessions are where they run;
    /// claims and work contexts are of a workspace's work items, and take a
    /// repository only to name its workspace (or, for a claim, where it is
    /// made from). Sessions are read across a workspace too: listing or
    /// getting them takes a repository or a workspace.
    pub fn needs_repo(self) -> bool {
        !matches!(
            self,
            CoordinationOp::GetSession
                | CoordinationOp::ListSessions
                | CoordinationOp::ListWorkspaceSessions
                | CoordinationOp::GetWorkspaceSession
                | CoordinationOp::ClaimWorkItem
                | CoordinationOp::ReleaseClaim
                | CoordinationOp::HandOffWorkItem
                | CoordinationOp::ListClaims
                | CoordinationOp::GetWork
        )
    }

    /// Whether it only reads.
    pub fn reads(self) -> bool {
        matches!(
            self,
            CoordinationOp::GetSession
                | CoordinationOp::ListSessions
                | CoordinationOp::ListClaims
                | CoordinationOp::GetWork
                | CoordinationOp::ListWorkspaceSessions
                | CoordinationOp::GetWorkspaceSession
        )
    }

    pub fn description(self) -> &'static str {
        match self {
            CoordinationOp::StartSession => "Start a session: one run of your own harness (a Claude Code session, a Codex run) on a repository, so others can see who is working on what. `harness` is claude_code, codex, cursor, copilot or other. Give `harness_session_id`, the harness's own id for the session, and starting again with it returns the session already started (refreshing the work item, pull request, branch, title and head given) instead of a new one, so a hook that fires twice is harmless. `item` and `pull` attach it to a work item of the repository's workspace and a pull request of the repository; a pull request for a work item attaches that work item too. A subagent is a session of its own: give `parent_id` (one of your sessions here), its `agent_type`, the `task` and `prompt` its parent gave it, and as `harness_session_id` the parent's harness id, `/agent/` and the subagent's id; it starts on the parent's work item, pull request and branch unless it says otherwise, sees and is seen by its siblings in get_work and list_sessions, and once ended stays ended when started again. Returns the session (`id` `ses_…`, `state` active, idle or ended). A new session, or one started again after it ended, is a session.started event. Needs a confirmed email address and a role that may open work items.",
            CoordinationOp::UpdateSession => "Update one of your sessions: attach it to a work item or pull request, or change its branch, head commit or title. Only the fields given change. An empty body is a heartbeat: every call keeps the session active and renews the claims made from it. A session reads as idle after 15 minutes without one and ends (`end_reason` timed_out) after 30 minutes; a heartbeat brings a timed-out one back. Attaching a pull request moves the entries recorded so far into that pull request's session. A subagent's `task`, `prompt`, `model` and `result` (what it reported, up to 8,000 characters) can be set too; a subagent that ended takes them and stays ended. Returns the session; one ended with end_session is refused with `409`.",
            CoordinationOp::EndSession => "End one of your sessions, with an optional `reason` and `result` (what it reported when it finished: a subagent's final message, up to 8,000 characters, never a tool's output). A session.ended event. Ending one already ended returns it as it is, taking `result` if it had none. Its subagents still going end with it (`parent ended`). Its claims are not released: release them, hand the work item off, or let them expire. Anyone with write access to the repository may also end someone else's session, one left behind by a harness that was killed or never ended it: it ends as `ended by hand by @you`, without their `reason` or `result`.",
            CoordinationOp::GetSession => "A session and its entries, oldest first, numbered within the session (`seq`); `after` gives the entries after that number, 500 at a time. With them: `children`, its subagents and theirs in the order they started (each names its `parent_id`); `touched`, the files, commits, branches, pull requests and work items it and they touched; `links`, the work items and pull requests they worked on and how each was tied (`via`: attached, claim, branch, commit, trailer, opened or ref); `skills`, the skills they used by name; and for a subagent, `root`, the session at the top of its tree. `updates` contains up to 100 oldest pending coordination events that concern this session (id, kind, data, at): those about the work items and pull requests it is on or tied to, or every one while it is on nothing yet; never its own start, end or claims. Reading never acknowledges them; use record_session_entries with acknowledge IDs after considering them. To check for updates without the transcript, give `after` 4294967295. Anyone who can read the repository may. With `workspace` instead of `repo`, the session is found in whichever repository of the workspace it runs in, and `repo` says which.",
            CoordinationOp::ListSessions => "A repository's sessions, most recently heard from first, up to 100: `state` active (heard from in the last 15 minutes), idle or ended; `item` (a work item's number) or `pull` for those on one, attached or tied to it any other way; `path` for those that touched a file (or any under a folder ending in `/`). Subagents are left out unless `subagents` is true, which lists each tree whole. Each says how many `subagents` it started. Anyone who can read the repository may. With `workspace` instead of `repo`, every repository of the workspace you may read: see list_workspace_sessions.",
            CoordinationOp::ListWorkspaceSessions => "What is cooking across a workspace: the sessions of every repository of it you may read, every kind in one shape, most recently heard from first (up to 200, 60 if `limit` is left out). `kind` is harness (someone's own harness: Claude Code, Codex, Cursor, Copilot, another), hosted (started on g1t on the workspace's Anthropic provider), agent (g1t's own agent on a pull request; members only) or recorded (what a coding agent recorded on a pull request with no session behind it). Each gives `repo`, `title`, `actor`, `harness` or `agent`, `branch`, `item` and its title, `pull` and its title and status, `state` (active, idle or ended: one quiet for 30 minutes reads as ended), `last_activity_at`, `subagents`, and for harness and hosted ones the `session` itself. `state` live (going now), recent (the default) or ended; `harness`, `person` (a username), `repo` (a repository's name in the workspace) and `item` narrow it; `subagents` true gives each tree's subagents in `children`. With them: `queue`, the merge queues with something waiting, `landed`, the pull requests merged most recently, and `repos`, the repositories looked in. Only what you may read is listed; outside the workspace, sessions show who runs them and what they are tied to, not what they recorded.",
            CoordinationOp::GetWorkspaceSession => "One session of a workspace by its id (ses_…), in whichever of its repositories it runs: as get_session, with `repo` naming the repository. Anyone who can read that repository may.",
            CoordinationOp::RecordSessionEntries => "Record entries in one of your sessions: up to 200 at a time, each with `kind` (prompt, message, tool_call, tool_result, note, or skill for a skill it used, by name), `text` (up to 64,000 characters), and for tools `tool`. Give each a `key` and recording it again does nothing, so a retried hook records it once. `touched` says what it touched, up to 200: `{ kind, value }` with kind file (a path from the repository's root), commit, branch, pull (one it opened) or item (a work item it named); each is kept once, ties the session to the pull requests and work items it names, and a file another active session touched too (outside its own parents and subagents, so siblings yes) is an overlap.detected event for both, once per pair and again when a file it was not announced for joins. Entries of a session attached to a pull request show in that pull request's session too, where reviewers read why the change is what it is. `acknowledge` accepts up to 100 exact pending update IDs this session has considered; reading alone never acknowledges. Recording is a heartbeat. Returns how many were `recorded`, how many were `duplicates`, and how many of the `acknowledge` IDs were `acknowledged` (fewer than given means some were not this session's updates).",
            CoordinationOp::ClaimWorkItem => "Claim an open work item: say you are working on it. A claim is advisory, never a lock: anyone may claim a work item someone else has, and `others` lists the claims already on it, so you can coordinate or pick something else. It lasts `ttl_minutes` (30 unless you say, up to 240) and is renewed by claiming again or, when you give the `session_id` of one of your sessions, by that session's heartbeats. Name the work item by `workspace` and `number`; `repo`, the repository of your checkout, names the workspace when `workspace` is left out and says where the claim is made from. Returns your `claim`, the `others`, and `blocked_by`: each work item this one waits on, with its claims and pull requests. A new claim is a work.claimed event; one taking over a hand-off says which in `took_over`. For work that has no work item yet, leave out `number` and give `title` (and `body`): the work item is opened first (filed from `repo` when given; a work_item.opened event), then claimed, the session named by `session_id` is attached to it, and `item` is the work item opened. The session is checked first, so a claim it would refuse opens nothing.",
            CoordinationOp::ReleaseClaim => "Release your claim on a work item, with an optional `reason`: you stopped working on it. A work.released event. Claims also end when the work item closes (reason item_closed), and expire when not renewed. Refused with `404` when you hold no active claim on it.",
            CoordinationOp::HandOffWorkItem => "Hand a work item you claimed off: your claim ends as handed_off, with `note` saying where the work stands, for `to` (a username) or, without one, for anyone. A work.handoff_requested event, which whoever follows the work item hears; the next claim on it says it took the hand-off over. Refused with `404` when you hold no active claim on it.",
            CoordinationOp::ListClaims => "A workspace's claims on the work items you may see, newest first, up to 100: active ones unless `state` says released, expired or handed_off, and `item` for one work item's. With `repo`, those made from its checkouts or on work items linked to it.",
            CoordinationOp::GetWork => "Everything about a work item an agent needs before working on it, in one call: the `item`, its `definition_of_done` (the items under its \"Definition of done\" heading); `repos`, each repository it is linked to (origin, targets, touched) with its `role`, whether the work `landed` there, the `required_checks` every pull request into its default branch must pass, and its `pulls` for the work item, each with its status, required checks as they stand on its head, whether it merges cleanly, the other pull requests it overlaps and its place in the merge queue; `missing`, the targets it has not landed in yet; `suggested_targets`, repositories of the workspace it may belong in, likeliest first, each with `why` (link_work_item with role target confirms one); active `claims`; `sessions` on it or its pull requests; `blocked_by` (each work item it waits on, with claims and pull requests) and `blocks` (the work items waiting on it); `decisions` recorded about it; `last_integration_failure`; and `recent`, its latest coordination events, newest first.",
            CoordinationOp::StartAgentSession => "Start work on a work item in a session of its own, on the person's own Claude: g1t runs no model and bills nothing for it. Give `item` (a work item of the repository's workspace), or `title` and `body` to open a new work item first, filed from the repository; `instruction` adds to what the session is asked; `mode` (plan, implement or review) says what kind of work it is. With the workspace's Anthropic AI provider (an owner adds it in the workspace's AI settings), g1t starts a Claude Managed Agents session with that key: g1t's MCP server attached with a credential for you and this repository only that lasts the session and is kept in a vault on the Anthropic account (never in the prompt), g1t's skills (work-on-item, coordinate, fix-integration) next to the account's own, and the session, its subagents (threads), what they touched and what they reported recorded here as a g1t session (`harness` claude_managed_agents). Returns `session`, its `session_url` on g1t, `provider_session_url`, and `prompt`. With `handoff` true, or without an Anthropic AI provider when `handoff` is not false, nothing is started: `command` is a Claude Code command line, and `prompt` what to paste, for someone with g1t's Claude Code plugin, whose session then attaches to the work item as it starts.",
        }
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": "string", "description": "The session's id (ses_…), from start_session or list_sessions." });
        let number = json!({ "type": "integer", "description": "The work item's number in its workspace." });
        let workspace = json!({ "type": "string", "description": "The workspace's slug. Left out, repo's workspace." });
        let checkout = json!({ "type": "string", "description": "The repository of your checkout, as \"owner/name\": names the workspace when workspace is left out." });
        let item = json!({ "type": "integer", "description": "The work item it works on, by its number in the repository's workspace." });
        let pull = json!({ "type": "integer", "description": "The pull request it works on." });
        let fields = |more: Value| -> Value {
            let mut properties = json!({
                "repo": repo,
                "item": item,
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
        let session_id = json!({ "type": "string", "description": "The session (ses_…) whose claim it is, when you have several on the work item, such as sibling subagents." });
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
                    "repo": { "type": "string", "description": "Repository as \"owner/name\". Left out, give workspace." },
                    "workspace": { "type": "string", "description": "A workspace's slug, instead of repo: the session is found in whichever repository of it it runs in." },
                    "id": id,
                    "after": { "type": "integer", "description": "Only entries after this sequence number, for the next page. To read only pending `updates`, give 4294967295: no entries come back." },
                }),
                &["id"],
            ),
            CoordinationOp::ListSessions => (
                json!({
                    "repo": { "type": "string", "description": "Repository as \"owner/name\". Left out, give workspace for every repository of it you may read." },
                    "workspace": { "type": "string", "description": "A workspace's slug, instead of repo: its sessions across every repository of it you may read (see list_workspace_sessions for what else it takes)." },
                    "state": { "type": "string", "enum": ["active", "idle", "ended"], "description": "Only sessions in this state." },
                    "item": { "type": "integer", "description": "Only sessions on this work item: attached, or tied to it any other way." },
                    "pull": { "type": "integer", "description": "Only sessions on this pull request: attached, or tied to it any other way." },
                    "path": { "type": "string", "description": "Only sessions that touched this file, or any under it when it ends in `/`." },
                    "subagents": { "type": "boolean", "description": "List subagents too, each tree whole. Left out, only the sessions at the top." },
                }),
                &[],
            ),
            CoordinationOp::ListWorkspaceSessions => (
                json!({
                    "workspace": { "type": "string", "description": "The workspace's slug." },
                    "state": { "type": "string", "enum": ["live", "recent", "ended"], "description": "live: going now (active or idle, a run queued or running); recent: every one (the default); ended." },
                    "kind": { "type": "string", "enum": SessionKind::ALL.map(SessionKind::as_str), "description": "Only sessions of this kind." },
                    "harness": { "type": "string", "enum": Harness::ALL.map(Harness::as_str), "description": "Only sessions in this harness." },
                    "person": { "type": "string", "description": "Only sessions this person runs, by username." },
                    "repo": { "type": "string", "description": "Only sessions in this repository of the workspace, by its name (or \"owner/name\")." },
                    "item": { "type": "integer", "description": "Only sessions on this work item of the workspace." },
                    "subagents": { "type": "boolean", "description": "Give each session's subagents too, in its `children`." },
                    "limit": { "type": "integer", "description": "At most this many, up to 200; 60 if left out." },
                }),
                &["workspace"],
            ),
            CoordinationOp::GetWorkspaceSession => (
                json!({
                    "workspace": { "type": "string", "description": "The workspace's slug." },
                    "id": id,
                    "after": { "type": "integer", "description": "Only entries after this sequence number, for the next page." },
                }),
                &["workspace", "id"],
            ),
            CoordinationOp::RecordSessionEntries => (
                json!({
                    "acknowledge": { "type": "array", "maxItems": 100, "items": { "type": "string" }, "description": "Exact pending update IDs this session has considered; never acknowledge merely because fetched." },
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
                                "kind": { "type": "string", "enum": ["file", "commit", "branch", "pull", "item"] },
                                "value": { "type": "string", "description": "A path from the repository's root, a commit, a branch, or a number." },
                            },
                            "required": ["kind", "value"],
                        },
                    },
                }),
                &["repo", "id"],
            ),
            CoordinationOp::ClaimWorkItem => (
                json!({
                    "workspace": workspace,
                    "repo": checkout,
                    "number": { "type": "integer", "description": "The work item's number. Left out, give title (and body) to open one and claim it." },
                    "title": { "type": "string", "description": "Without number: the title of a new work item to open and claim, filed from repo when given." },
                    "body": { "type": "string", "description": "Without number: the new work item's description." },
                    "session_id": { "type": "string", "description": "One of your sessions (ses_…): its heartbeats renew the claim. With title, it is attached to the new work item." },
                    "note": { "type": "string", "description": "What you are doing, for whoever else looks. Up to 500 characters." },
                    "ttl_minutes": { "type": "integer", "description": "How long it lasts unless renewed: 30 unless you say, at most 240." },
                }),
                &[],
            ),
            CoordinationOp::ReleaseClaim => (
                json!({
                    "workspace": workspace,
                    "repo": checkout,
                    "number": number,
                    "reason": { "type": "string", "description": "Why, in a few words. \"released\" if left out." },
                    "session_id": session_id,
                }),
                &["number"],
            ),
            CoordinationOp::HandOffWorkItem => (
                json!({
                    "workspace": workspace,
                    "repo": checkout,
                    "number": number,
                    "to": { "type": "string", "description": "The username it is for. Left out, it is for anyone." },
                    "note": { "type": "string", "description": "Where the work stands: what is done, what is left, what to watch for. Up to 500 characters." },
                    "session_id": session_id,
                }),
                &["number", "note"],
            ),
            CoordinationOp::ListClaims => (
                json!({
                    "workspace": workspace,
                    "repo": { "type": "string", "description": "Only claims made from this repository's checkouts or on work items linked to it, \"owner/name\". Names the workspace when workspace is left out." },
                    "state": {
                        "type": "string",
                        "enum": ["active", "released", "expired", "handed_off"],
                        "description": "Claims in this state; active if left out.",
                    },
                    "item": { "type": "integer", "description": "Only claims on this work item." },
                }),
                &[],
            ),
            CoordinationOp::GetWork => (json!({ "workspace": workspace, "repo": checkout, "number": number }), &["number"]),
            CoordinationOp::StartAgentSession => (
                json!({
                    "repo": repo,
                    "item": { "type": "integer", "description": "The work item to work on, by its number in the repository's workspace. Left out, give title (and body) to open one." },
                    "title": { "type": "string", "description": "Without item: the title of a new work item to open and work on, filed from the repository." },
                    "body": { "type": "string", "description": "Without item: the new work item's description." },
                    "instruction": { "type": "string", "description": "What to do beyond what the work item says. Up to 4,000 characters." },
                    "mode": { "type": "string", "enum": ["plan", "implement", "review"], "description": "What kind of work: plan (say how, change nothing), implement (the default) or review (review its pull request)." },
                    "handoff": { "type": "boolean", "description": "true for a Claude Code command and prompt to run yourself instead of a session on the workspace's Anthropic account; false to refuse when the workspace has no Anthropic AI provider. Left out, a session when the workspace can, else the hand-off." },
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

/// `blocked_by` for `update_work_item`: work item numbers, as numbers,
/// digits or `#12`. None when left out; refused when it holds anything
/// else.
pub fn blocked_by(input: &Value) -> std::result::Result<Option<Vec<u32>>, String> {
    let items = match &input["blocked_by"] {
        Value::Null => return Ok(None),
        Value::Array(items) => items,
        _ => return Err("blocked_by is a list of work item numbers.".to_owned()),
    };
    items
        .iter()
        .map(|item| number(&json!({ "n": item }), "n").ok_or_else(|| format!("blocked_by holds {item}, which is not a work item number.")))
        .collect::<std::result::Result<Vec<u32>, String>>()
        .map(Some)
}

pub async fn run(op: CoordinationOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let given = repo_path(input);
    let repo = match given.clone() {
        Some(repo) => repo,
        None if op.needs_repo() => return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\".")),
        None => RepoPath { namespace: String::new(), name: String::new() },
    };
    let invalid = |message: String| Ok(Outcome::fail(FailureCode::Invalid, message));
    // A claim or a work context names its work item's workspace, or a
    // repository of it.
    let workspace = item_workspace(input);
    // Sessions across a workspace: listing or getting them without a repository.
    if given.is_none() && !workspace.is_empty() {
        match op {
            CoordinationOp::ListSessions => return list_workspace_sessions(services, viewer, input, workspace).await,
            CoordinationOp::GetSession => return get_workspace_session(services, viewer, input, workspace).await,
            _ => {}
        }
    }
    if matches!(op, CoordinationOp::ListWorkspaceSessions | CoordinationOp::GetWorkspaceSession) {
        if workspace.is_empty() {
            return invalid("Give the workspace by its slug.".to_owned());
        }
        return match op {
            CoordinationOp::ListWorkspaceSessions => list_workspace_sessions(services, viewer, input, workspace).await,
            _ => get_workspace_session(services, viewer, input, workspace).await,
        };
    }
    if matches!(op, CoordinationOp::ListSessions | CoordinationOp::GetSession) && given.is_none() {
        return invalid("Give the repository as \"owner/name\", or the workspace by its slug.".to_owned());
    }
    if !op.needs_repo() && workspace.is_empty() {
        return invalid("Give the workspace by its slug, or a repository of it as \"owner/name\".".to_owned());
    }
    let (item, pull) = match (optional_number(input, "item"), optional_number(input, "pull")) {
        (Ok(item), Ok(pull)) => (item, pull),
        (Err(message), _) | (_, Err(message)) => return invalid(message),
    };
    let actor = || viewer.clone().unwrap_or_default();
    let id = || text(input, "id").unwrap_or_default();
    let item_number = number(input, "number").unwrap_or_default();
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
                item,
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
                item,
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
            let args = EndSessionArgs { actor: actor(), repo, id: id(), reason: text(input, "reason"), result: text(input, "result"), by_hand: false };
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
            let args = ListWorkSessionsArgs { viewer: viewer.clone(), repo, state, item, pull, subagents, path: text(input, "path") };
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
                Err(_) => return invalid("touched is a list of { kind, value }, kind one of file, commit, branch, pull or item.".to_owned()),
            };
            let acknowledge: Vec<String> = match serde_json::from_value(input.get("acknowledge").cloned().unwrap_or(json!([]))) {
                Ok(ids) => ids,
                Err(_) => return invalid("acknowledge must be an array of update IDs.".to_owned()),
            };
            let args = RecordEntriesArgs { actor: actor(), repo, id: id(), entries, touched, acknowledge };
            g1t_kit::call(work, "record_session_entries", &args).await
        }
        CoordinationOp::ClaimWorkItem => {
            let ttl_minutes = match optional_number(input, "ttl_minutes") {
                Ok(minutes) => minutes,
                Err(message) => return invalid(message),
            };
            let title = text(input, "title");
            if item_number == 0 && title.is_none() {
                return invalid("Name the work item by its number, or give a title (and body) to open one.".to_owned());
            }
            if item_number != 0 && title.is_some() {
                return invalid("Give the work item's number or a title for a new one, not both.".to_owned());
            }
            let args = ClaimArgs {
                actor: actor(),
                workspace,
                repo: given,
                number: item_number,
                title,
                body: text(input, "body"),
                session_id: text(input, "session_id"),
                note: text(input, "note"),
                ttl_minutes,
            };
            g1t_kit::call(work, "claim_work_item", &args).await
        }
        CoordinationOp::ReleaseClaim => {
            let args = ReleaseArgs { actor: actor(), workspace, repo: given, number: item_number, reason: text(input, "reason"), session_id: text(input, "session_id") };
            g1t_kit::call(work, "release_claim", &args).await
        }
        CoordinationOp::HandOffWorkItem => {
            let Some(note) = text(input, "note") else {
                return invalid("Say where the work stands in note, for whoever picks it up.".to_owned());
            };
            let args = HandOffArgs { actor: actor(), workspace, repo: given, number: item_number, to: text(input, "to"), note, session_id: text(input, "session_id") };
            g1t_kit::call(work, "hand_off_work_item", &args).await
        }
        CoordinationOp::ListClaims => {
            let state = match text(input, "state") {
                None => None,
                Some(state) => match ClaimState::parse(&state) {
                    Some(state) => Some(state),
                    None => return invalid(format!("state is active, released, expired or handed_off, not {state}.")),
                },
            };
            let args = ListClaimsArgs { viewer: viewer.clone(), workspace, repo: given, state, item };
            g1t_kit::call(work, "list_claims", &args).await
        }
        CoordinationOp::GetWork => {
            let args = WorkItemViewArgs { workspace, number: item_number, viewer: viewer.clone() };
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
            if item.is_none() && text(input, "title").is_none() {
                return invalid("Name the work item, or give a title (and body) for a new one.".to_owned());
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
                item,
                pull: None,
                asked: None,
                title: text(input, "title"),
                body: text(input, "body"),
                instruction: text(input, "instruction"),
                mode,
                handoff,
            };
            g1t_kit::call(&services.integrations, "start_agent_session", &args).await
        }
        // Answered above, before a repository is asked for.
        CoordinationOp::ListWorkspaceSessions | CoordinationOp::GetWorkspaceSession => invalid("Give the workspace by its slug.".to_owned()),
    }
}

/// `list_workspace_sessions`, from a `workspace` and its filters.
async fn list_workspace_sessions(services: &Services, viewer: &Viewer, input: &Value, workspace: String) -> Result<Outcome<Value>> {
    let invalid = |message: String| Ok(Outcome::fail(FailureCode::Invalid, message));
    let shown = match text(input, "state") {
        None => SessionsShown::Recent,
        Some(state) => match SessionsShown::parse(&state) {
            Some(shown) => shown,
            None => return invalid(format!("state is live, recent (or all) or ended, not {state}.")),
        },
    };
    let kind = match text(input, "kind") {
        None => None,
        Some(kind) => match SessionKind::parse(&kind) {
            Some(kind) => Some(kind),
            None => return invalid(format!("kind is harness, hosted, agent or recorded, not {kind}.")),
        },
    };
    let harness = match text(input, "harness") {
        None => None,
        Some(name) => match Harness::parse(&name) {
            Some(harness) => Some(harness),
            None => {
                let names: Vec<&str> = Harness::ALL.iter().map(|harness| harness.as_str()).collect();
                return invalid(format!("harness is one of {}.", names.join(", ")));
            }
        },
    };
    let item = match optional_number(input, "item") {
        Ok(item) => item,
        Err(message) => return invalid(message),
    };
    let subagents = matches!(&input["subagents"], Value::Bool(true)) || input["subagents"].as_str() == Some("true");
    let args = ListWorkspaceSessionsArgs {
        viewer: viewer.clone(),
        workspace,
        shown,
        kind,
        harness,
        person: text(input, "person"),
        repo: text(input, "repo").or_else(|| text(input, "repository")),
        item,
        subagents,
        sessions_only: false,
        limit: number(input, "limit"),
    };
    g1t_kit::call(&services.work, "list_workspace_sessions", &args).await
}

/// `get_workspace_session`, from a `workspace` and the session's `id`.
async fn get_workspace_session(services: &Services, viewer: &Viewer, input: &Value, workspace: String) -> Result<Outcome<Value>> {
    let Some(id) = text(input, "id") else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the session by its id (ses_…)."));
    };
    let args = GetWorkspaceSessionArgs { viewer: viewer.clone(), workspace, id, after_seq: number(input, "after").unwrap_or_default() };
    g1t_kit::call(&services.work, "get_workspace_session", &args).await
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
            assert_eq!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), op.needs_repo(), "{}", op.name());
            let scope = scope_for(op.name()).unwrap();
            assert_eq!(scope.level() == Level::Read, op.reads(), "{}", op.name());
            let sessions = op.name().contains("session");
            let expected = match (sessions, op.reads()) {
                (true, true) => Scope::PullRequestsRead,
                (true, false) => Scope::PullRequestsWrite,
                (false, true) => Scope::WorkRead,
                (false, false) => Scope::WorkWrite,
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
        let (op, input) = resolve("GET", "/repos/acme/web/sessions", &[("state", "idle"), ("item", "4")], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::ListSessions));
        assert_eq!(input, json!({ "state": "idle", "item": "4", "repo": "acme/web" }));
        let (op, _) = resolve("POST", "/repos/acme/web/sessions/ses_1/entries", &[], json!({ "entries": [] }));
        assert_eq!(op, coordination(CoordinationOp::RecordSessionEntries));
        let (op, input) = resolve("POST", "/workspaces/acme/work/4/claim", &[], json!({ "note": "on it", "repo": "acme/web" }));
        assert_eq!(op, coordination(CoordinationOp::ClaimWorkItem));
        assert_eq!(input, json!({ "note": "on it", "number": 4, "workspace": "acme", "repo": "acme/web" }));
        // Work with no work item yet: one is opened and claimed.
        let (op, input) = resolve("POST", "/workspaces/acme/claims", &[], json!({ "title": "Fix previews" }));
        assert_eq!(op, coordination(CoordinationOp::ClaimWorkItem));
        assert_eq!(input, json!({ "title": "Fix previews", "workspace": "acme" }));
        let (op, _) = resolve("POST", "/workspaces/acme/work/4/release", &[], json!({}));
        assert_eq!(op, coordination(CoordinationOp::ReleaseClaim));
        let (op, _) = resolve("POST", "/workspaces/acme/work/4/handoff", &[], json!({ "note": "half done" }));
        assert_eq!(op, coordination(CoordinationOp::HandOffWorkItem));
        let (op, input) = resolve("GET", "/workspaces/acme/claims", &[("state", "active"), ("repo", "acme/web")], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::ListClaims));
        assert_eq!(input, json!({ "state": "active", "repo": "acme/web", "workspace": "acme" }));
        let (op, input) = resolve("GET", "/workspaces/acme/work/4/work", &[], Value::Null);
        assert_eq!(op, coordination(CoordinationOp::GetWork));
        assert_eq!(input, json!({ "number": 4, "workspace": "acme" }));
    }

    #[test]
    fn mcp_actions_reach_each_operation() {
        use crate::tools::{Tool, resolve};
        let call = |tool: &str, action: &str| resolve(Tool::by_name(tool).unwrap(), &json!({ "action": action, "repo": "a/b", "id": "ses_1", "number": 4, "harness": "codex", "entries": [], "note": "x" }));
        assert_eq!(call("session", "start"), Ok(Op::Coordination(CoordinationOp::StartSession)));
        assert_eq!(call("session", "update"), Ok(Op::Coordination(CoordinationOp::UpdateSession)));
        assert_eq!(call("session", "record"), Ok(Op::Coordination(CoordinationOp::RecordSessionEntries)));
        assert_eq!(call("work_item", "claim"), Ok(Op::Coordination(CoordinationOp::ClaimWorkItem)));
        let claim_new = resolve(Tool::by_name("work_item").unwrap(), &json!({ "action": "claim", "repo": "a/b", "title": "Fix previews" }));
        assert_eq!(claim_new, Ok(Op::Coordination(CoordinationOp::ClaimWorkItem)));
        assert_eq!(call("work_item", "work"), Ok(Op::Coordination(CoordinationOp::GetWork)));
    }

    #[test]
    fn numbers_come_as_numbers_digits_or_with_a_hash() {
        assert_eq!(blocked_by(&json!({})), Ok(None));
        assert_eq!(blocked_by(&json!({ "blocked_by": [3, "4", "#5"] })), Ok(Some(vec![3, 4, 5])));
        assert_eq!(blocked_by(&json!({ "blocked_by": [] })), Ok(Some(vec![])));
        assert!(blocked_by(&json!({ "blocked_by": ["x"] })).is_err());
        assert!(blocked_by(&json!({ "blocked_by": 3 })).is_err());
        assert_eq!(optional_number(&json!({ "item": "" }), "item"), Ok(None));
        assert!(optional_number(&json!({ "item": "soon" }), "item").is_err());
    }
}
