//! Artifacts over REST and MCP: a workspace's docs, slides, designs and
//! dashboards (Artifacts mode, docs/ARTIFACTS_MODE.md), at
//! `/workspaces/{workspace}/artifacts` and as the `artifact` MCP tool.
//! Code calls them folios; people, URLs, the tool and the scopes say
//! "artifact". Workflow runs' artifacts are something else (artifacts.rs).
//!
//! The docs service (`services/docs`, the `DOCS` binding) decides who may
//! do what with each one, from the person's own role on it: this checks
//! the input, names people for the service (a username becomes
//! `user:<id>`), and gives each answer its public shape, in snake_case.
//! The token's `artifacts:*` scope is checked before anything runs
//! (audit.rs). A workspace's own token is refused: an artifact always has
//! a person as its owner.

use g1t_contracts::datasets::DatasetQuery;
use g1t_contracts::folios::*;
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation on artifacts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoliosOp {
    List,
    Search,
    Get,
    GetContent,
    ListVersions,
    GetAccess,
    ListTemplates,
    ListSpaces,
    QueryDataset,
    Create,
    Update,
    Edit,
    Trash,
    Restore,
    RestoreVersion,
    SetAccess,
    Purge,
}

impl FoliosOp {
    /// Every one: `Op::ALL` lists each as `Op::Folios(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [FoliosOp; 17] = [
        FoliosOp::List,
        FoliosOp::Search,
        FoliosOp::Get,
        FoliosOp::GetContent,
        FoliosOp::ListVersions,
        FoliosOp::GetAccess,
        FoliosOp::ListTemplates,
        FoliosOp::ListSpaces,
        FoliosOp::QueryDataset,
        FoliosOp::Create,
        FoliosOp::Update,
        FoliosOp::Edit,
        FoliosOp::Trash,
        FoliosOp::Restore,
        FoliosOp::RestoreVersion,
        FoliosOp::SetAccess,
        FoliosOp::Purge,
    ];

    /// Its operation id. `workspace_artifact`, because GitHub's names for
    /// workflow runs' artifacts (`list_artifacts`, `get_artifact`) are taken.
    pub fn name(self) -> &'static str {
        match self {
            FoliosOp::List => "list_workspace_artifacts",
            FoliosOp::Search => "search_workspace_artifacts",
            FoliosOp::Get => "get_workspace_artifact",
            FoliosOp::GetContent => "get_workspace_artifact_content",
            FoliosOp::ListVersions => "list_workspace_artifact_versions",
            FoliosOp::GetAccess => "get_workspace_artifact_access",
            FoliosOp::ListTemplates => "list_workspace_artifact_templates",
            FoliosOp::ListSpaces => "list_workspace_artifact_spaces",
            FoliosOp::QueryDataset => "query_workspace_dataset",
            FoliosOp::Create => "create_workspace_artifact",
            FoliosOp::Update => "update_workspace_artifact",
            FoliosOp::Edit => "edit_workspace_artifact",
            FoliosOp::Trash => "trash_workspace_artifact",
            FoliosOp::Restore => "restore_workspace_artifact",
            FoliosOp::RestoreVersion => "restore_workspace_artifact_version",
            FoliosOp::SetAccess => "set_workspace_artifact_access",
            FoliosOp::Purge => "purge_workspace_artifact",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            FoliosOp::List => "List a workspace's artifacts",
            FoliosOp::Search => "Search a workspace's artifacts",
            FoliosOp::Get => "Get an artifact",
            FoliosOp::GetContent => "Get an artifact's content",
            FoliosOp::ListVersions => "List an artifact's versions",
            FoliosOp::GetAccess => "Get who can open an artifact",
            FoliosOp::ListTemplates => "List artifact templates",
            FoliosOp::ListSpaces => "List artifact spaces",
            FoliosOp::QueryDataset => "Query a dataset",
            FoliosOp::Create => "Create an artifact",
            FoliosOp::Update => "Update an artifact",
            FoliosOp::Edit => "Edit an artifact's content",
            FoliosOp::Trash => "Move an artifact to the trash",
            FoliosOp::Restore => "Restore an artifact from the trash",
            FoliosOp::RestoreVersion => "Restore an artifact version",
            FoliosOp::SetAccess => "Share an artifact",
            FoliosOp::Purge => "Delete an artifact for good",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            FoliosOp::List => "List the artifacts (docs, slides, designs and dashboards) in a workspace that you can open, most recently edited first: each with its id (fol_…), kind, title, icon, space (null in its owner's Private), parent_id, owner, your role (viewer_role: view, comment, edit or manage), general_access, private, excerpt, edited_at and html_url. tab is all (the default), yours (you own them) or shared (shared with you). Narrow with kind, space (its slug or id), project (owner/name), q (words or meaning) and limit (at most 100); next_cursor pages on. With state trashed, the artifacts in the trash you can restore instead. Not workflow runs' artifacts.",
            FoliosOp::Search => "Search the artifacts in a workspace that you can open, by words and by meaning: each hit is the artifact with the passage that matched (snippet, and the heading it is under), its space_name and edited_at. Narrow with kind, space, project and limit (at most 50). Only what you can read now is found.",
            FoliosOp::Get => "Get one artifact by its id (fol_…) or its address (`/acme/-/artifacts/q4-roadmap-fol_…`): its kind, title, space, parent_id, owner, who made it, your role, general_access, whether it is private, how many it is shared with, its excerpt, whether it may be out of date with the code it cites (stale), and html_url. Not found when you cannot open it, as for one that does not exist. Opening a link-shared artifact this way counts as following its link.",
            FoliosOp::GetContent => "Get an artifact's content in the form agents read and write: for a doc, its Markdown in content, and its top-level blocks (id, type, level and Markdown) to target an edit at; with can (read, suggest, edit): what you may do to it. Slides, designs and dashboards answer that they are not here yet.",
            FoliosOp::ListVersions => "List an artifact's saved versions, newest first: each with its id (ver_…), created_at, kind (created, edit, agent, suggestion, proposal or restore), note, and the people and agents who made it.",
            FoliosOp::GetAccess => "Who can open an artifact and how: its owner, each person, agent and team it is shared with (principal, role, and inherited_from when the access comes from a doc it is under), general_access (none, workspace or link) with general_role, whether it follows its space or parent (inherit), agent_mode, and whether you may change it (can_share).",
            FoliosOp::ListTemplates => "The templates an artifact can start from: the built-in ones and those saved in the workspace, each with its id, kind, name, description and body (Markdown, or a JSON spec). Narrow with kind.",
            FoliosOp::ListSpaces => "The spaces in your Artifacts sidebar: the General space, open spaces you joined, your teams' spaces and Members-only spaces you are in. Each with its id, slug, name, kind (workspace for an open space, team or private), your role in it (viewer_role) and how many artifacts it holds you can open.",
            FoliosOp::QueryDataset => "Run a dataset query (issues, pull requests, workflow runs, deployments, spend or agent sessions) as you, over what you can read: rows of the measure, grouped and filtered as asked, with truncated when more rows matched, and partial true when some of it was left out because you cannot read it. Answers that dashboards are not here yet until they ship.",
            FoliosOp::Create => "Make an artifact. kind is doc (the default); slides, designs and dashboards answer that they are not here yet. It lands in space (a slug or id you can edit in), under parent_id (a doc you can edit), or, with neither, in your Private, where only you can open it. Start it from markdown, or from a template (template_id), with an optional title and icon. You own it. Returns the artifact.",
            FoliosOp::Update => "Rename an artifact (title), change its icon (null clears it), or move it: to space (a slug or id; `private` for your Private, yours only), under parent_id (a doc), before before_id among its new siblings. Moving changes who can open it when it follows its space or parent. Takes the edit role on it, and on where it goes. Returns the artifact.",
            FoliosOp::Edit => "Change an artifact's content. For a doc: markdown with a target: append (add to the end), document (replace it all), section (with heading: that heading and everything under it) or blocks (from_block through to_block, block ids from its content). With the edit role the change is made, as a new version; with the comment role, or suggest_only, it is filed as a suggestion its editors accept or reject. note says why; marks_current says it brings the doc up to date with the code it cites. Returns mode (applied or suggested), version_id or the suggestion, and the artifact.",
            FoliosOp::Trash => "Move an artifact, and everything under it, to the trash: nobody can open it until it is restored, and it is deleted for good after 30 days. Takes the edit role. Returns the artifact, with trashed_at.",
            FoliosOp::Restore => "Bring an artifact back from the trash, with what went to the trash with it, where it was (at the top of its space or your Private when the doc it was under is gone). Takes the edit role. Returns the artifact.",
            FoliosOp::RestoreVersion => "Make an earlier version (version_id) an artifact's content again, as a new version: nothing in between is lost. Takes the edit role. Returns the new version.",
            FoliosOp::SetAccess => "Change who can open an artifact. Share it with a person (username), a team (team: its slug) or an agent (agent: its id), or a principal from its access list, at role view, comment, edit or manage (full access), with an optional notify message; role none takes theirs away. Set general_access to none (only people invited), workspace (everyone in the workspace) or link (anyone in the workspace with the link), with general_role view, comment or edit. inherit false stops it following its space or parent; true follows again. agent_mode suggest or edit says how agents change it (null follows its space). Takes full access (manage). Returns who can open it now.",
            FoliosOp::Purge => "Delete an artifact in the trash, and everything under it, for good: its content and versions are gone and cannot be restored. Move it to the trash first. Takes full access (manage).",
        }
    }

    /// Whether it changes anything.
    #[cfg(test)]
    pub fn writes(self) -> bool {
        !matches!(
            self,
            FoliosOp::List
                | FoliosOp::Search
                | FoliosOp::Get
                | FoliosOp::GetContent
                | FoliosOp::ListVersions
                | FoliosOp::GetAccess
                | FoliosOp::ListTemplates
                | FoliosOp::ListSpaces
                | FoliosOp::QueryDataset
        )
    }

    pub fn input(self) -> Value {
        let workspace = json!({ "type": "string", "description": "The workspace's slug, e.g. \"acme\"." });
        let artifact_id = json!({ "type": "string", "description": "The artifact's id (fol_…), or its address: /acme/-/artifacts/q4-roadmap-fol_…" });
        let kind = json!({ "type": "string", "enum": ["doc", "slides", "design", "dashboard"], "description": "doc, slides, design or dashboard." });
        let space = json!({ "type": "string", "description": "A space: its slug (general) or id (spc_…)." });
        let project = json!({ "type": "string", "description": "Only artifacts about this repository: owner/name." });
        let with = |mut properties: Value| {
            properties["workspace"] = workspace.clone();
            properties["artifact_id"] = artifact_id.clone();
            properties
        };
        let one = ["workspace", "artifact_id"];
        let (properties, required): (Value, Vec<&str>) = match self {
            FoliosOp::List => (
                json!({
                    "workspace": workspace,
                    "tab": { "type": "string", "enum": ["all", "yours", "shared"], "description": "all (the default), yours (you own them) or shared (shared with you by others)." },
                    "kind": kind,
                    "space": space,
                    "project": project,
                    "q": { "type": "string", "description": "Only artifacts matching these words or this meaning, best first." },
                    "state": { "type": "string", "enum": ["active", "trashed"], "description": "active (the default), or trashed: what you can restore from the trash." },
                    "cursor": { "type": "string", "description": "next_cursor from the page before." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many, at most 100." },
                }),
                vec!["workspace"],
            ),
            FoliosOp::Search => (
                json!({
                    "workspace": workspace,
                    "q": { "type": "string", "description": "Words or a question." },
                    "kind": kind,
                    "space": space,
                    "project": project,
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "How many hits, at most 50." },
                }),
                vec!["workspace", "q"],
            ),
            FoliosOp::Get | FoliosOp::GetContent | FoliosOp::ListVersions | FoliosOp::GetAccess | FoliosOp::Trash | FoliosOp::Restore | FoliosOp::Purge => {
                (with(json!({})), one.to_vec())
            }
            FoliosOp::ListTemplates => (json!({ "workspace": workspace, "kind": kind }), vec!["workspace"]),
            FoliosOp::ListSpaces => (json!({ "workspace": workspace }), vec!["workspace"]),
            FoliosOp::QueryDataset => (
                json!({
                    "workspace": workspace,
                    "query": {
                        "type": "object",
                        "description": "dataset (issues, pull_requests, workflow_runs, deployments, spend or agent_sessions), measure ({ op: count, sum, avg, p50, p95 or rate, field where it takes one }), and optional group_by, interval (day, week or month), time, filters ([{ field, op, value }], at most 10), range (7d, 30d, 90d, or { from, to }, at most 366 days) and limit (at most 100).",
                    },
                }),
                vec!["workspace", "query"],
            ),
            FoliosOp::Create => (
                json!({
                    "workspace": workspace,
                    "kind": kind,
                    "title": { "type": "string", "description": "At most 200 characters. Left out: the template's, or Untitled." },
                    "icon": { "type": "string", "description": "An emoji." },
                    "space": { "type": "string", "description": "A space you can edit in: its slug or id. Left out, with no parent_id: your Private." },
                    "parent_id": { "type": "string", "description": "A doc to put it under, which you can edit: its id. Its space is the doc's." },
                    "markdown": { "type": "string", "description": "What a doc starts with, in Markdown." },
                    "template_id": { "type": "string", "description": "A template to start from (list_workspace_artifact_templates), instead of markdown." },
                }),
                vec!["workspace"],
            ),
            FoliosOp::Update => (
                with(json!({
                    "title": { "type": "string", "description": "Its new title." },
                    "icon": { "type": ["string", "null"], "description": "An emoji; null clears it." },
                    "space": { "type": "string", "description": "Move it to the top of this space (slug or id), or `private` for your Private." },
                    "parent_id": { "type": "string", "description": "Move it under this doc: its id." },
                    "before_id": { "type": "string", "description": "Where it goes among its new siblings: before this one. Left out: last." },
                })),
                one.to_vec(),
            ),
            FoliosOp::Edit => (
                with(json!({
                    "markdown": { "type": "string", "description": "For a doc: the Markdown to add, or to replace the target with." },
                    "target": {
                        "type": ["object", "string"],
                        "description": "For a doc: append or document (as a string or { \"kind\": … }), { \"kind\": \"section\", \"heading\": … }, or { \"kind\": \"blocks\", \"from_block\": …, \"to_block\": … }. Left out: append.",
                    },
                    "ops": { "type": "array", "items": { "type": "object" }, "description": "For slides, designs and dashboards, once they ship: the kind's own ops." },
                    "kind": { "type": "string", "enum": ["doc", "slides", "design", "dashboard"], "description": "The artifact's kind; left out, doc." },
                    "note": { "type": "string", "description": "Why, in a line: shown with the version or suggestion." },
                    "suggest_only": { "type": "boolean", "description": "File a suggestion even when you could edit." },
                    "marks_current": { "type": "boolean", "description": "The edit brings it up to date with the code it cites." },
                })),
                one.to_vec(),
            ),
            FoliosOp::RestoreVersion => (
                with(json!({ "version_id": { "type": "string", "description": "The version's id (ver_…), from its versions." } })),
                [one.as_slice(), &["version_id"]].concat(),
            ),
            FoliosOp::SetAccess => (
                with(json!({
                    "username": { "type": "string", "description": "A member to share it with." },
                    "team": { "type": "string", "description": "A team of the workspace to share it with: its slug." },
                    "agent": { "type": "string", "description": "An agent of the workspace to share it with: its id." },
                    "principal": { "type": "string", "description": "Who, as its access list names them: user:…, agent:… or team:…" },
                    "role": { "type": "string", "enum": ["view", "comment", "edit", "manage", "none"], "description": "What they may do: view, comment, edit, or manage (full access, sharing included); none takes their access away." },
                    "notify": { "type": "string", "description": "A message for the person it is shared with." },
                    "general_access": { "type": "string", "enum": ["none", "workspace", "link"], "description": "none (only people invited), workspace (everyone in the workspace) or link (anyone in the workspace with the link)." },
                    "general_role": { "type": "string", "enum": ["view", "comment", "edit"], "description": "What general access gives; never full access." },
                    "inherit": { "type": "boolean", "description": "Whether it follows its space or the doc it is under." },
                    "agent_mode": { "type": ["string", "null"], "enum": ["suggest", "edit", null], "description": "How agents change it: suggest or edit; null follows its space." },
                })),
                one.to_vec(),
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

// --- Reading the input --------------------------------------------------------

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// A whole number given as one, or as digits (a REST query).
fn number(input: &Value, key: &str) -> Option<u32> {
    input[key]
        .as_u64()
        .or_else(|| text(input, key).and_then(|given| given.parse().ok()))
        .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
}

fn invalid(message: impl Into<String>) -> Outcome<Value> {
    Outcome::fail(FailureCode::Invalid, message)
}

/// The folio id an `artifact_id` names: an id, or an address or link that
/// ends in one.
pub(crate) fn artifact_id(given: &str) -> Option<String> {
    let given = given.trim();
    let path = given.split(['?', '#']).next().unwrap_or_default();
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    folio_id_from(last).map(str::to_owned)
}

fn kind_of(input: &Value) -> std::result::Result<Option<FolioKind>, String> {
    match text(input, "kind") {
        None => Ok(None),
        Some(kind) => FolioKind::parse(&kind.to_lowercase())
            .map(Some)
            .ok_or_else(|| format!("There is no kind of artifact called {kind}: doc, slides, design or dashboard.")),
    }
}

/// A doc edit's target, as the docs service reads it: a string is the
/// kind, an object passes as given. Left out, append.
fn edit_target(input: &Value) -> Value {
    match &input["target"] {
        Value::String(kind) => json!({ "kind": kind.trim().to_lowercase() }),
        Value::Object(target) => Value::Object(target.clone()),
        _ => json!({ "kind": "append" }),
    }
}

/// The `FolioAgentEdit` a call describes.
pub(crate) fn agent_edit(input: &Value) -> std::result::Result<Value, String> {
    let kind = kind_of(input)?.unwrap_or(FolioKind::Doc);
    let mut edit = Map::new();
    edit.insert("kind".to_owned(), json!(kind.as_str()));
    if kind == FolioKind::Doc {
        let Some(markdown) = input["markdown"].as_str() else {
            return Err("Give the markdown to add, or to replace the target with.".to_owned());
        };
        edit.insert("markdown".to_owned(), json!(markdown));
        edit.insert("target".to_owned(), edit_target(input));
    } else {
        edit.insert("ops".to_owned(), input["ops"].clone());
    }
    for key in ["note", "suggest_only", "marks_current"] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            edit.insert(key.to_owned(), value.clone());
        }
    }
    let edit = Value::Object(edit);
    agent_edit_error(&edit)?;
    Ok(edit)
}

/// What a call to the access route changes, in order: someone's role,
/// then general access, then following the space or parent, then how
/// agents change it. The principal is resolved by the caller.
pub(crate) fn access_changes(input: &Value, principal: Option<String>) -> std::result::Result<Vec<FolioAccessChange>, String> {
    let mut changes = Vec::new();
    let role = text(input, "role").map(|role| role.to_lowercase());
    match (principal, role.as_deref()) {
        (Some(principal), Some("none")) => changes.push(FolioAccessChange::Revoke { principal }),
        (Some(principal), Some(role)) => {
            let role = parse_role(role).ok_or_else(|| format!("{role} is not a role: view, comment, edit, manage or none."))?;
            changes.push(FolioAccessChange::Grant { principal, role, notify: text(input, "notify") });
        }
        (Some(_), None) => return Err("Give the role: view, comment, edit, manage, or none to take their access away.".to_owned()),
        (None, Some(_)) => return Err("Give who to share it with: username, team, agent or principal.".to_owned()),
        (None, None) => {}
    }
    if let Some(access) = text(input, "general_access") {
        let access = match access.to_lowercase().as_str() {
            "none" | "restricted" => GeneralAccess::None,
            "workspace" => GeneralAccess::Workspace,
            "link" => GeneralAccess::Link,
            other => return Err(format!("{other} is not general access: none, workspace or link.")),
        };
        let role = match (access, text(input, "general_role")) {
            (GeneralAccess::None, _) => None,
            (_, None) => Some(FolioRole::View),
            (_, Some(role)) => Some(parse_role(&role.to_lowercase()).ok_or_else(|| format!("{role} is not a role: view, comment or edit."))?),
        };
        changes.push(FolioAccessChange::General { access, role });
    }
    if let Some(inherit) = input["inherit"].as_bool() {
        changes.push(FolioAccessChange::Inherit { inherit });
    }
    if let Some(mode) = input.get("agent_mode") {
        let agent_mode = match mode.as_str().map(str::to_lowercase).as_deref() {
            None if mode.is_null() => None,
            Some("suggest") => Some(AgentMode::Suggest),
            Some("edit") => Some(AgentMode::Edit),
            _ => return Err("agent_mode is suggest, edit, or null to follow its space.".to_owned()),
        };
        changes.push(FolioAccessChange::AgentMode { agent_mode });
    }
    if changes.is_empty() {
        return Err("Say what to change: who and a role, general_access, inherit or agent_mode.".to_owned());
    }
    for change in &changes {
        change.validate()?;
    }
    Ok(changes)
}

fn parse_role(text: &str) -> Option<FolioRole> {
    match text {
        "view" | "read" => Some(FolioRole::View),
        "comment" => Some(FolioRole::Comment),
        "edit" | "write" => Some(FolioRole::Edit),
        "manage" | "full" | "admin" => Some(FolioRole::Manage),
        _ => None,
    }
}

// --- Answers, as the API shows them -------------------------------------------

/// A person, agent or team, from a docs service profile.
pub(crate) fn person_json(profile: &Value) -> Value {
    if !profile.is_object() {
        return Value::Null;
    }
    let kind = profile["kind"].as_str().unwrap_or("user");
    let name = profile["name"].clone();
    match kind {
        "agent" => json!({ "type": "agent", "id": profile["id"], "handle": name, "display_name": profile["display_name"] }),
        "team" => json!({ "type": "team", "slug": profile["id"], "display_name": profile["display_name"] }),
        _ => json!({ "type": "user", "id": profile["id"], "username": name, "display_name": profile["display_name"] }),
    }
}

fn people_json(list: &Value) -> Value {
    Value::Array(list.as_array().map(|list| list.iter().map(person_json).collect()).unwrap_or_default())
}

fn html_url(site: &str, path: &Value) -> Value {
    match path.as_str() {
        Some(path) => json!(format!("{}{}", site.trim_end_matches('/'), path)),
        None => Value::Null,
    }
}

/// Enough to link to an artifact.
pub(crate) fn ref_json(folio: &Value, site: &str) -> Value {
    json!({
        "id": folio["id"],
        "kind": folio["kind"],
        "title": folio["title"],
        "icon": folio["icon"],
        "slug": folio["slug"],
        "html_url": html_url(site, &folio["path"]),
    })
}

/// An artifact as the API shows one.
pub(crate) fn folio_json(folio: &Value, site: &str) -> Value {
    let space = match &folio["space"] {
        Value::Object(space) => json!({ "id": space.get("id"), "slug": space.get("slug"), "name": space.get("name"), "kind": space.get("kind") }),
        _ => Value::Null,
    };
    json!({
        "id": folio["id"],
        "kind": folio["kind"],
        "title": folio["title"],
        "icon": folio["icon"],
        "slug": folio["slug"],
        "space": space,
        "parent_id": folio["parent_id"],
        "has_children": folio["has_children"],
        "owner": person_json(&folio["owner"]),
        "created_by": person_json(&folio["created_by"]),
        "created_at": folio["created_at"],
        "updated_at": folio["updated_at"],
        "edited_by": person_json(&folio["edited_by"]),
        "edited_at": folio["edited_at"],
        "trashed_at": folio["trashed_at"],
        "viewer_role": folio["viewer_role"],
        "private": folio["private"],
        "shared_count": folio["shared_count"],
        "general_access": folio["general_access"],
        "general_role": folio["general_role"],
        "inherit": folio["inherit"],
        "agent_mode": folio["agent_mode"],
        "excerpt": folio["excerpt"],
        "source": folio["source"],
        "stale": folio["stale"],
        "html_url": html_url(site, &folio["path"]),
    })
}

fn content_json(read: &Value, site: &str) -> Value {
    let mut artifact = ref_json(&read["folio"], site);
    artifact["edited_at"] = read["folio"]["edited_at"].clone();
    let mut shown = json!({
        "artifact": artifact,
        "space": read["space"],
        "content": read["content"],
        "can": read["can"],
    });
    if let Some(blocks) = read.get("blocks").filter(|blocks| blocks.is_array()) {
        shown["blocks"] = blocks.clone();
    }
    shown
}

fn suggestion_json(suggestion: &Value) -> Value {
    json!({
        "id": suggestion["id"],
        "status": suggestion["status"],
        "target": suggestion["target"],
        "before_markdown": suggestion["before_markdown"],
        "after_markdown": suggestion["after_markdown"],
        "note": suggestion["note"],
        "author": person_json(&suggestion["author"]),
        "created_at": suggestion["created_at"],
    })
}

fn edit_json(result: &Value, site: &str) -> Value {
    let mut shown = json!({ "mode": result["mode"], "artifact": ref_json(&result["folio"], site) });
    match result["mode"].as_str() {
        Some("applied") => {
            shown["version_id"] = result["version_id"].clone();
            shown["summary"] = result["summary"].clone();
        }
        Some("suggested") => shown["suggestion"] = suggestion_json(&result["suggestion"]),
        _ => {}
    }
    shown
}

fn version_json(version: &Value) -> Value {
    json!({
        "id": version["id"],
        "artifact_id": version["folio_id"],
        "created_at": version["created_at"],
        "kind": version["kind"],
        "note": version["note"],
        "authors": people_json(&version["authors"]),
    })
}

fn access_json(list: &Value) -> Value {
    let rows: Vec<Value> = list["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let inherited = match row["source"]["kind"].as_str() {
                        Some("folio") => json!({ "artifact_id": row["source"]["id"], "title": row["source"]["title"] }),
                        _ => Value::Null,
                    };
                    json!({ "principal": row["principal"], "member": person_json(&row["profile"]), "role": row["role"], "inherited_from": inherited })
                })
                .collect()
        })
        .unwrap_or_default();
    let inherited_from = match &list["inherited_from"] {
        Value::Object(from) => json!({ "type": from.get("kind").and_then(Value::as_str).map(|kind| if kind == "folio" { "artifact" } else { kind }), "id": from.get("id"), "name": from.get("name") }),
        _ => Value::Null,
    };
    json!({
        "artifact_id": list["folio_id"],
        "owner": person_json(&list["owner"]),
        "shared_with": rows,
        "general_access": list["general_access"],
        "general_role": list["general_role"],
        "inherit": list["inherit"],
        "inherited_from": inherited_from,
        "agent_mode": list["agent_mode"],
        "can_share": list["can_share"],
    })
}

fn template_json(template: &Value) -> Value {
    json!({
        "id": template["id"],
        "kind": template["kind"],
        "name": template["name"],
        "description": template["description"],
        "icon": template["icon"],
        "builtin": template["builtin"],
        "body": template["body"],
    })
}

fn space_json(space: &Value) -> Value {
    json!({
        "id": space["id"],
        "slug": space["slug"],
        "name": space["name"],
        "description": space["description"],
        "icon": space["icon"],
        "kind": space["kind"],
        "is_default": space["is_default"],
        "joined": space["joined"],
        "viewer_role": space["viewer_role"],
        "artifact_count": space["page_count"],
    })
}

fn hit_json(hit: &Value, site: &str) -> Value {
    let mut shown = ref_json(hit, site);
    for key in ["space_name", "snippet", "heading", "matched", "edited_at"] {
        shown[key] = hit.get(key).cloned().unwrap_or(Value::Null);
    }
    shown
}

fn mapped(outcome: Outcome<Value>, f: impl FnOnce(&Value) -> Value) -> Outcome<Value> {
    match outcome {
        Outcome::Ok(value) => Outcome::Ok(f(&value)),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    }
}

fn listed(outcome: Outcome<Value>, f: impl Fn(&Value) -> Value) -> Outcome<Value> {
    mapped(outcome, |list| Value::Array(list.as_array().map(|list| list.iter().map(&f).collect()).unwrap_or_default()))
}

// --- Running ------------------------------------------------------------------

async fn call<T: DeserializeOwned>(services: &Services, method: &str, args: &impl Serialize) -> Result<Outcome<T>> {
    g1t_kit::call(&services.docs, method, args).await
}

/// The person acting, or the refusal: nobody, or a workspace's own token.
pub(crate) fn person(viewer: &Viewer) -> std::result::Result<User, Outcome<Value>> {
    match viewer {
        None => Err(Outcome::fail(FailureCode::Unauthenticated, "This needs a g1t access token.")),
        Some(user) if user.kind == PrincipalKind::Workspace => Err(Outcome::fail(
            FailureCode::Forbidden,
            "Artifacts belong to people: use a personal access token, or a g1t agent's.",
        )),
        Some(user) => Ok(user.clone()),
    }
}

/// A space's id from its slug or id, among the spaces in the person's
/// sidebar; an id passes as given. `Ok(None)` for `private`.
async fn space_id(services: &Services, workspace: &str, viewer: &User, given: &str) -> Result<std::result::Result<Option<String>, Outcome<Value>>> {
    let given = given.trim();
    if given.eq_ignore_ascii_case("private") {
        return Ok(Ok(None));
    }
    if given.starts_with("spc_") {
        return Ok(Ok(Some(given.to_owned())));
    }
    let sidebar: Outcome<Value> = call(services, "folio_sidebar", &json!({ "workspace": workspace, "viewer": viewer })).await?;
    let sidebar = match sidebar {
        Outcome::Ok(sidebar) => sidebar,
        Outcome::Fail(refused) => return Ok(Err(Outcome::Fail(refused))),
    };
    let found = sidebar["spaces"]
        .as_array()
        .and_then(|spaces| spaces.iter().find(|space| space["slug"].as_str().is_some_and(|slug| slug.eq_ignore_ascii_case(given))))
        .and_then(|space| space["id"].as_str().map(str::to_owned));
    Ok(match found {
        Some(id) => Ok(Some(id)),
        None => Err(invalid(format!("There is no space called {given} in your sidebar: give its id, or join it first."))),
    })
}

/// Who a share is for, as the docs service names them.
async fn principal(services: &Services, input: &Value) -> Result<std::result::Result<Option<String>, Outcome<Value>>> {
    if let Some(principal) = text(input, "principal") {
        return Ok(Ok(Some(principal)));
    }
    if let Some(team) = text(input, "team") {
        let slug = team.trim_start_matches('@').rsplit('/').next().unwrap_or_default().to_lowercase();
        return Ok(Ok(Some(format!("team:{slug}"))));
    }
    if let Some(agent) = text(input, "agent") {
        return Ok(Ok(Some(format!("agent:{agent}"))));
    }
    let Some(username) = text(input, "username").or_else(|| text(input, "user")) else {
        return Ok(Ok(None));
    };
    let username = username.trim_start_matches('@').to_lowercase();
    let found: Viewer = g1t_kit::call(&services.identity, "user_by_username", &UsernameArgs { username: username.clone() }).await?;
    Ok(match found {
        Some(user) => Ok(Some(format!("user:{}", user.id))),
        None => Err(invalid(format!("There is no account named {username}."))),
    })
}

pub async fn run(op: FoliosOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let site = services.addresses.site.clone();
    let viewer = match person(viewer) {
        Ok(user) => user,
        Err(refused) => return Ok(refused),
    };
    let Some(workspace) = text(input, "workspace").map(|w| w.to_lowercase()) else {
        return Ok(invalid("Give the workspace's slug."));
    };
    let kind = match kind_of(input) {
        Ok(kind) => kind,
        Err(message) => return Ok(invalid(message)),
    };
    macro_rules! space {
        ($given:expr) => {
            match space_id(services, &workspace, &viewer, $given).await? {
                Ok(id) => id,
                Err(refused) => return Ok(refused),
            }
        };
    }
    let folio_id = match op {
        FoliosOp::List | FoliosOp::Search | FoliosOp::ListTemplates | FoliosOp::ListSpaces | FoliosOp::QueryDataset | FoliosOp::Create => String::new(),
        _ => match text(input, "artifact_id").as_deref().and_then(artifact_id) {
            Some(id) => id,
            None => return Ok(invalid("Give the artifact_id: its id (fol_…) or its address.")),
        },
    };
    let one = || FolioArgs { workspace: workspace.clone(), viewer: viewer.clone(), folio_id: folio_id.clone() };
    let shown = |folio: &Value| folio_json(folio, &site);
    Ok(match op {
        FoliosOp::List => {
            if text(input, "state").as_deref() == Some("trashed") {
                let found: Outcome<Value> = call(services, "folio_trash", &json!({ "workspace": workspace, "viewer": viewer })).await?;
                return Ok(mapped(found, |list| json!({ "items": list.as_array().map(|list| list.iter().map(shown).collect::<Vec<_>>()).unwrap_or_default(), "next_cursor": null })));
            }
            let tab = match text(input, "tab").map(|tab| tab.to_lowercase()).as_deref() {
                None | Some("all") => FolioListTab::All,
                Some("yours") | Some("mine") => FolioListTab::Yours,
                Some("shared") => FolioListTab::Shared,
                Some(other) => return Ok(invalid(format!("{other} is not a tab: all, yours or shared."))),
            };
            let space_id = match text(input, "space") {
                Some(given) => space!(&given),
                None => None,
            };
            let limit = number(input, "limit");
            let query = FolioListQuery {
                tab,
                kinds: kind.map(|kind| vec![kind]),
                space_id,
                owner: None,
                project: text(input, "project"),
                q: text(input, "q"),
                cursor: text(input, "cursor"),
                limit,
            };
            if let Err(message) = query.validate() {
                return Ok(invalid(message));
            }
            let found: Outcome<Value> = call(services, "folio_list", &FolioListArgs { workspace, viewer, query }).await?;
            mapped(found, |list| {
                json!({
                    "items": list["items"].as_array().map(|items| items.iter().map(shown).collect::<Vec<_>>()).unwrap_or_default(),
                    "next_cursor": list["next_cursor"],
                })
            })
        }
        FoliosOp::Search => {
            let Some(q) = text(input, "q") else { return Ok(invalid("Give q: what to search for.")) };
            let space_id = match text(input, "space") {
                Some(given) => space!(&given),
                None => None,
            };
            let limit = number(input, "limit").map(|l| l.clamp(1, 50));
            let query = FolioSearchQuery { q, kinds: kind.map(|kind| vec![kind]), space_id, project: text(input, "project"), owner: None, mode: Some("hybrid".to_owned()), limit };
            let found: Outcome<Value> = call(services, "search_folios", &SearchFoliosArgs { workspace, viewer, query }).await?;
            listed(found, |hit| hit_json(hit, &site))
        }
        FoliosOp::Get => mapped(call(services, "folio", &one()).await?, shown),
        FoliosOp::GetContent => mapped(call(services, "folio_content", &one()).await?, |read| content_json(read, &site)),
        FoliosOp::ListVersions => listed(call(services, "folio_versions", &one()).await?, version_json),
        FoliosOp::GetAccess => mapped(call(services, "folio_access", &one()).await?, access_json),
        FoliosOp::ListTemplates => {
            let found: Outcome<Value> = call(services, "folio_templates", &FolioTemplatesArgs { workspace, viewer, kind }).await?;
            listed(found, template_json)
        }
        FoliosOp::ListSpaces => {
            let found: Outcome<Value> = call(services, "folio_sidebar", &json!({ "workspace": workspace, "viewer": viewer })).await?;
            mapped(found, |sidebar| Value::Array(sidebar["spaces"].as_array().map(|spaces| spaces.iter().map(space_json).collect()).unwrap_or_default()))
        }
        FoliosOp::QueryDataset => {
            let query: DatasetQuery = match serde_json::from_value(input["query"].clone()) {
                Ok(query) => query,
                Err(error) => return Ok(invalid(format!("That query does not read: {error}."))),
            };
            if let Err(message) = query.validate() {
                return Ok(invalid(message));
            }
            call(services, "query_dataset", &QueryDatasetArgs { workspace, viewer, query }).await?
        }
        FoliosOp::Create => {
            let kind = kind.unwrap_or(FolioKind::Doc);
            let space_id = match text(input, "space") {
                Some(given) => space!(&given),
                None => None,
            };
            let content = input["markdown"].as_str().map(|markdown| FolioContentInput { markdown: Some(markdown.to_owned()), spec: None });
            let new = NewFolio {
                kind,
                title: text(input, "title"),
                icon: text(input, "icon"),
                space_id,
                parent_id: text(input, "parent_id"),
                template_id: text(input, "template_id"),
                content,
                source: None,
                share_with: None,
            };
            if let Err(message) = new.validate() {
                return Ok(invalid(message));
            }
            mapped(call(services, "create_folio", &CreateFolioArgs { workspace, viewer, input: new }).await?, shown)
        }
        FoliosOp::Update => {
            let mut change = FolioChange::default();
            if let Some(title) = input["title"].as_str() {
                if title.chars().count() > MAX_TITLE {
                    return Ok(invalid(format!("A title is at most {MAX_TITLE} characters.")));
                }
                change.title = Some(title.to_owned());
            }
            if let Some(icon) = input.get("icon") {
                change.icon = Some(icon.as_str().map(str::to_owned));
            }
            let moving = input.get("space").is_some_and(|v| !v.is_null()) || input.get("parent_id").is_some_and(|v| !v.is_null());
            if change == FolioChange::default() && !moving {
                return Ok(invalid("Say what to change: title, icon, space or parent_id."));
            }
            let mut answer: Option<Outcome<Value>> = None;
            if change != FolioChange::default() {
                let changed: Outcome<Value> = call(services, "update_folio", &UpdateFolioArgs { workspace: workspace.clone(), viewer: viewer.clone(), folio_id: folio_id.clone(), change }).await?;
                if let Outcome::Fail(_) = changed {
                    return Ok(changed);
                }
                answer = Some(changed);
            }
            if moving {
                let parent_id = text(input, "parent_id");
                let space_id = match (&parent_id, text(input, "space")) {
                    (None, Some(given)) => space!(&given),
                    _ => None,
                };
                let to = FolioMove { space_id, parent_id, before_id: text(input, "before_id") };
                answer = Some(call(services, "move_folio", &MoveFolioArgs { workspace, viewer, folio_id, to }).await?);
            }
            mapped(answer.unwrap_or_else(|| invalid("Nothing to change.")), shown)
        }
        FoliosOp::Edit => {
            let edit = match agent_edit(input) {
                Ok(edit) => edit,
                Err(message) => return Ok(invalid(message)),
            };
            mapped(call(services, "edit_folio", &EditFolioArgs { workspace, viewer, folio_id, edit }).await?, |result| edit_json(result, &site))
        }
        FoliosOp::Trash => mapped(call(services, "trash_folio", &one()).await?, shown),
        FoliosOp::Restore => mapped(call(services, "restore_folio", &one()).await?, shown),
        FoliosOp::Purge => mapped(call(services, "delete_folio", &one()).await?, |_| json!({ "deleted": true })),
        FoliosOp::RestoreVersion => {
            let Some(version_id) = text(input, "version_id") else { return Ok(invalid("Give the version_id.")) };
            let args = FolioVersionArgs { workspace, viewer, folio_id, version_id };
            mapped(call(services, "restore_folio_version", &args).await?, version_json)
        }
        FoliosOp::SetAccess => {
            let principal = match principal(services, input).await? {
                Ok(principal) => principal,
                Err(refused) => return Ok(refused),
            };
            let changes = match access_changes(input, principal) {
                Ok(changes) => changes,
                Err(message) => return Ok(invalid(message)),
            };
            let mut last: Outcome<Value> = invalid("Nothing to change.");
            for change in changes {
                let method = change.method();
                let args = FolioAccessArgs { workspace: workspace.clone(), viewer: viewer.clone(), folio_id: folio_id.clone(), change };
                last = call(services, method, &args).await?;
                if let Outcome::Fail(_) = last {
                    return Ok(last);
                }
            }
            mapped(last, access_json)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folio() -> Value {
        json!({
            "id": "fol_0123456789abcdefghjkmnpqrs",
            "kind": "doc",
            "title": "Q4 roadmap",
            "icon": null,
            "slug": "q4-roadmap-fol_0123456789abcdefghjkmnpqrs",
            "path": "/acme/-/artifacts/q4-roadmap-fol_0123456789abcdefghjkmnpqrs",
            "workspace_id": "ws_1",
            "space": { "id": "spc_1", "slug": "general", "name": "General", "kind": "workspace" },
            "parent_id": null,
            "position": 1024,
            "owner": { "kind": "user", "id": "usr_1", "name": "ana", "display_name": "Ana", "avatar": null, "role": null },
            "created_by": { "kind": "agent", "id": "agt_1", "name": "g1t", "display_name": "g1t", "avatar": null, "role": null },
            "created_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-02T00:00:00.000Z",
            "edited_by": null,
            "edited_at": "2026-10-02T00:00:00.000Z",
            "trashed_at": null,
            "viewer_role": "manage",
            "favorite": false,
            "private": false,
            "shared_count": 2,
            "general_access": "workspace",
            "general_role": "view",
            "inherit": true,
            "inherited_from": null,
            "agent_mode": "suggest",
            "excerpt": "What we ship.",
            "preview": null,
            "source": null,
            "stale": false,
            "has_children": false,
        })
    }

    #[test]
    fn an_artifact_is_snake_case_with_its_page() {
        let shown = folio_json(&folio(), "https://g1t.sh/");
        assert_eq!(shown["html_url"], "https://g1t.sh/acme/-/artifacts/q4-roadmap-fol_0123456789abcdefghjkmnpqrs");
        assert_eq!(shown["owner"], json!({ "type": "user", "id": "usr_1", "username": "ana", "display_name": "Ana" }));
        assert_eq!(shown["created_by"]["type"], "agent");
        assert_eq!(shown["edited_by"], Value::Null);
        assert_eq!(shown["space"]["slug"], "general");
        assert!(shown.get("preview").is_none() && shown.get("workspace_id").is_none());
        assert!(g1t_kit::wire::camel_case_keys(&shown).is_empty());
    }

    #[test]
    fn an_artifact_is_named_by_its_id_or_any_address_ending_in_it() {
        let id = "fol_0123456789abcdefghjkmnpqrs";
        assert_eq!(artifact_id(id).as_deref(), Some(id));
        assert_eq!(artifact_id("q4-roadmap-fol_0123456789abcdefghjkmnpqrs").as_deref(), Some(id));
        assert_eq!(artifact_id("https://g1t.sh/acme/-/artifacts/q4-roadmap-fol_0123456789abcdefghjkmnpqrs?x=1#h").as_deref(), Some(id));
        assert_eq!(artifact_id("/acme/-/artifacts/q4-roadmap-fol_0123456789abcdefghjkmnpqrs/").as_deref(), Some(id));
        assert_eq!(artifact_id("q4-roadmap"), None);
        assert_eq!(artifact_id("../fol_x"), None);
    }

    #[test]
    fn an_edit_is_a_doc_edit_unless_it_says_otherwise() {
        let edit = agent_edit(&json!({ "markdown": "## Next\n\nMore." })).unwrap();
        assert_eq!(edit, json!({ "kind": "doc", "markdown": "## Next\n\nMore.", "target": { "kind": "append" } }));
        let edit = agent_edit(&json!({ "markdown": "x", "target": "Document", "note": "Rewrite", "suggest_only": true })).unwrap();
        assert_eq!(edit["target"], json!({ "kind": "document" }));
        assert_eq!(edit["note"], "Rewrite");
        assert_eq!(edit["suggest_only"], true);
        let edit = agent_edit(&json!({ "markdown": "x", "target": { "kind": "section", "heading": "Risks" } })).unwrap();
        assert_eq!(edit["target"]["heading"], "Risks");
        assert_eq!(agent_edit(&json!({ "markdown": "x", "target": { "kind": "section" } })), Err("A section target names its heading.".to_owned()));
        assert!(agent_edit(&json!({})).unwrap_err().contains("markdown"));
        // Other kinds carry ops, which the docs service checks (and refuses
        // until each kind ships).
        let edit = agent_edit(&json!({ "kind": "slides", "ops": [{ "op": "add_slide" }] })).unwrap();
        assert_eq!(edit["kind"], "slides");
        assert_eq!(agent_edit(&json!({ "kind": "slides" })), Err("A deck edit has a list of ops.".to_owned()));
        assert!(agent_edit(&json!({ "kind": "poster", "markdown": "x" })).unwrap_err().contains("poster"));
    }

    #[test]
    fn sharing_reads_one_change_of_each_kind_in_order() {
        let changes = access_changes(
            &json!({ "role": "edit", "notify": "Have a look", "general_access": "workspace", "inherit": false, "agent_mode": null }),
            Some("user:usr_2".to_owned()),
        )
        .unwrap();
        assert_eq!(
            changes,
            vec![
                FolioAccessChange::Grant { principal: "user:usr_2".into(), role: FolioRole::Edit, notify: Some("Have a look".into()) },
                FolioAccessChange::General { access: GeneralAccess::Workspace, role: Some(FolioRole::View) },
                FolioAccessChange::Inherit { inherit: false },
                FolioAccessChange::AgentMode { agent_mode: None },
            ]
        );
        assert_eq!(changes[0].method(), "set_folio_grant");
        assert_eq!(changes[1].method(), "set_folio_general_access");
        assert_eq!(
            access_changes(&json!({ "role": "none" }), Some("team:design".into())).unwrap(),
            vec![FolioAccessChange::Revoke { principal: "team:design".into() }]
        );
        assert_eq!(
            access_changes(&json!({ "general_access": "none", "general_role": "edit" }), None).unwrap(),
            vec![FolioAccessChange::General { access: GeneralAccess::None, role: None }]
        );
        // General access never gives full access; that is shared by name.
        assert_eq!(
            access_changes(&json!({ "general_access": "link", "general_role": "manage" }), None),
            Err("General access gives view, comment or edit, never full access.".to_owned())
        );
        assert!(access_changes(&json!({ "role": "edit" }), None).unwrap_err().contains("who"));
        assert!(access_changes(&json!({}), Some("user:usr_2".into())).unwrap_err().contains("role"));
        assert!(access_changes(&json!({}), None).unwrap_err().starts_with("Say what to change"));
        assert!(access_changes(&json!({ "role": "owner" }), Some("user:usr_2".into())).unwrap_err().contains("owner"));
        assert!(access_changes(&json!({ "role": "view" }), Some("someone".into())).unwrap_err().contains("user:, agent: or team:"));
    }

    #[test]
    fn a_workspace_token_is_refused_and_nobody_is_asked_to_sign_in() {
        let workspace = User { id: "ws_1".into(), username: "acme".into(), kind: PrincipalKind::Workspace, ..User::default() };
        let Err(Outcome::Fail(refused)) = person(&Some(workspace)) else { panic!("a workspace token") };
        assert_eq!(refused.code, FailureCode::Forbidden);
        let Err(Outcome::Fail(refused)) = person(&None) else { panic!("nobody") };
        assert_eq!(refused.code, FailureCode::Unauthenticated);
        assert!(person(&Some(User { id: "usr_1".into(), username: "ana".into(), ..User::default() })).is_ok());
    }

    #[test]
    fn answers_are_snake_case_and_name_people_the_api_way() {
        let site = "https://g1t.sh";
        let access = access_json(&json!({
            "folio_id": "fol_1",
            "owner": { "kind": "user", "id": "usr_1", "name": "ana", "display_name": "Ana" },
            "rows": [
                { "principal": "team:design", "profile": { "kind": "team", "id": "design", "name": "design", "display_name": "@acme/design" }, "role": "edit", "source": { "kind": "folio", "id": "fol_0", "title": "Plans", "path": "/acme/-/artifacts/plans-fol_0" } },
                { "principal": "user:usr_2", "profile": { "kind": "user", "id": "usr_2", "name": "bo", "display_name": "Bo" }, "role": "view", "source": { "kind": "grant" } },
            ],
            "general_access": "none",
            "general_role": null,
            "inherit": true,
            "inherited_from": { "kind": "folio", "id": "fol_0", "name": "Plans" },
            "agent_mode": null,
            "can_share": true,
            "public_link": "off",
        }));
        assert_eq!(access["shared_with"][0]["member"], json!({ "type": "team", "slug": "design", "display_name": "@acme/design" }));
        assert_eq!(access["shared_with"][0]["inherited_from"]["artifact_id"], "fol_0");
        assert_eq!(access["shared_with"][1]["inherited_from"], Value::Null);
        assert_eq!(access["inherited_from"]["type"], "artifact");
        assert!(access.get("public_link").is_none());
        let content = content_json(
            &json!({ "folio": { "id": "fol_1", "kind": "doc", "title": "T", "icon": null, "slug": "t-fol_1", "path": "/acme/-/artifacts/t-fol_1", "edited_at": "2026-10-02T00:00:00.000Z" }, "space": null, "content": "# T", "blocks": [{ "id": "b1", "type": "heading", "level": 1, "markdown": "# T" }], "can": { "read": true, "suggest": true, "edit": true }, "audience_can_read": true }),
            site,
        );
        assert_eq!(content["artifact"]["html_url"], "https://g1t.sh/acme/-/artifacts/t-fol_1");
        assert!(content.get("audience_can_read").is_none());
        let edit = edit_json(&json!({ "mode": "applied", "version_id": "ver_1", "folio": { "id": "fol_1", "path": "/acme/-/artifacts/t-fol_1" }, "summary": "Added a section." }), site);
        assert_eq!(edit["version_id"], "ver_1");
        for shown in [access, content, edit, version_json(&json!({ "id": "ver_1", "folio_id": "fol_1", "authors": [{ "kind": "user", "id": "usr_1", "name": "ana", "display_name": "Ana" }] }))] {
            assert!(g1t_kit::wire::camel_case_keys(&shown).is_empty(), "{shown}");
        }
    }

    #[test]
    fn each_operation_is_described_with_a_schema_and_a_scope() {
        use g1t_contracts::scopes::{Level, Scope, scope_for};
        for op in FoliosOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Folios(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 80, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")), "{}", op.name());
            let scope = scope_for(op.name()).unwrap();
            assert_eq!(scope.resource(), g1t_contracts::scopes::Resource::Artifacts, "{}", op.name());
            assert_eq!(op.writes(), scope.level() != Level::Read, "{}", op.name());
        }
        // Sharing and deleting for good are the admin scope's alone.
        let admin: Vec<FoliosOp> = FoliosOp::ALL.into_iter().filter(|op| scope_for(op.name()) == Some(Scope::ArtifactsAdmin)).collect();
        assert_eq!(admin, vec![FoliosOp::SetAccess, FoliosOp::Purge]);
    }
}
