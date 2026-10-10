//! Folios: what people call artifacts (Artifacts mode).
//! One mode for docs, slides, designs and dashboards, kept by the docs
//! service (`services/artifacts`, TypeScript). Code says "folio"; people see
//! "artifact" in the UI, URLs, the `artifact` MCP tool, REST paths and the
//! `artifacts:*` scopes. The Cloudflare Artifacts git store and workflow run
//! artifacts ([`crate::actions`]) are something else.
//!
//! This is the subset of `packages/contracts/src/folios.ts` the Rust API
//! needs: the shapes it sends and reads back, the arguments of the docs
//! service's RPC, the validators it runs before calling, and the `folio.*`
//! event types. Agent edits stay JSON ([`serde_json::Value`]): the docs
//! service applies them; [`agent_edit_error`] checks their envelope. Wire
//! shapes are snake_case; the tests keep field names, RPC methods and
//! validators the same as the TypeScript (`folios.fixtures.json`).
//!
//! The API (`apps/api/src/folios.rs`) calls the RPC with these; the docs
//! service publishes the events.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::User;
use crate::datasets::DatasetQuery;

// --- Kinds and roles ----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolioKind {
    Doc,
    Slides,
    Design,
    Dashboard,
}

impl FolioKind {
    pub const ALL: [FolioKind; 4] = [FolioKind::Doc, FolioKind::Slides, FolioKind::Design, FolioKind::Dashboard];

    pub fn as_str(self) -> &'static str {
        match self {
            FolioKind::Doc => "doc",
            FolioKind::Slides => "slides",
            FolioKind::Design => "design",
            FolioKind::Dashboard => "dashboard",
        }
    }

    pub fn parse(text: &str) -> Option<FolioKind> {
        FolioKind::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// As the Artifacts home's tiles name it.
    pub fn label(self) -> &'static str {
        match self {
            FolioKind::Doc => "Docs",
            FolioKind::Slides => "Slides",
            FolioKind::Design => "Design",
            FolioKind::Dashboard => "Dashboard",
        }
    }

    /// One of it, in a sentence: "a doc", "a deck".
    pub fn noun(self) -> &'static str {
        match self {
            FolioKind::Doc => "doc",
            FolioKind::Slides => "deck",
            FolioKind::Design => "design",
            FolioKind::Dashboard => "dashboard",
        }
    }

    /// Only a doc holds other folios.
    pub fn can_have_children(self) -> bool {
        self == FolioKind::Doc
    }

    /// Whether it starts from Markdown (doc, slides) or a JSON spec.
    pub fn takes_markdown(self) -> bool {
        matches!(self, FolioKind::Doc | FolioKind::Slides)
    }
}

/// What someone may do with a folio, weakest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolioRole {
    View,
    Comment,
    Edit,
    Manage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneralAccess {
    None,
    Workspace,
    Link,
}

impl GeneralAccess {
    pub fn label(self) -> &'static str {
        match self {
            GeneralAccess::None => "Restricted",
            GeneralAccess::Workspace => "Everyone in the workspace",
            GeneralAccess::Link => "Anyone in the workspace with the link",
        }
    }
}

/// How agents change a folio: file suggestions (or proposals), or edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Suggest,
    Edit,
}

/// The most ops one agent edit carries.
pub const MAX_OPS: usize = 200;
/// The longest title, in characters.
pub const MAX_TITLE: usize = 200;
/// The most people a folio is shared with in one change.
pub const MAX_SHARE: usize = 50;
/// The most folios a page of a list holds.
pub const LIST_MAX: u32 = 100;

/// Whether `text` names who a grant is for: `user:<id>`, `agent:<id>` or
/// `team:<slug>`.
pub fn is_principal(text: &str) -> bool {
    let Some((kind, id)) = text.split_once(':') else { return false };
    matches!(kind, "user" | "agent" | "team")
        && (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// The folio id at the end of an address segment (`q4-roadmap-fol_…`).
pub fn folio_id_from(segment: &str) -> Option<&str> {
    let start = segment.len().checked_sub(30)?;
    let id = segment.get(start..)?;
    let suffix = id.strip_prefix("fol_")?;
    suffix
        .bytes()
        .all(|b| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&b))
        .then_some(id)
}

// --- Shapes -------------------------------------------------------------------

/// Enough to link to a folio.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioRef {
    pub id: String,
    pub kind: FolioKind,
    pub title: String,
    pub icon: Option<String>,
    /// `<title-slug>-<id>`.
    pub slug: String,
    /// `/<ws>/-/artifacts/<slug>`.
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioSpaceRef {
    pub id: String,
    pub slug: String,
    pub name: String,
    /// `workspace` (Open), `team` or `private` (Members only).
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioInheritedFrom {
    /// `space` or `folio`.
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioSource {
    pub title: String,
    pub href: String,
}

/// A folio for one viewer. People are member profiles (`MemberProfile` in
/// chat.ts), kept as JSON.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Folio {
    #[serde(flatten)]
    pub folio: FolioRef,
    pub workspace_id: String,
    /// None: its owner's Private section.
    pub space: Option<FolioSpaceRef>,
    pub parent_id: Option<String>,
    pub position: f64,
    pub owner: Value,
    pub created_by: Value,
    pub created_at: String,
    pub updated_at: String,
    pub edited_by: Option<Value>,
    pub edited_at: String,
    pub trashed_at: Option<String>,
    pub viewer_role: FolioRole,
    pub favorite: bool,
    pub private: bool,
    pub shared_count: u32,
    pub general_access: GeneralAccess,
    pub general_role: Option<FolioRole>,
    pub inherit: bool,
    pub inherited_from: Option<FolioInheritedFrom>,
    pub agent_mode: AgentMode,
    pub excerpt: String,
    /// What a card draws; never data values.
    pub preview: Option<Value>,
    pub source: Option<FolioSource>,
    pub stale: bool,
    pub has_children: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolioListTab {
    All,
    Yours,
    Shared,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioListQuery {
    pub tab: FolioListTab,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<FolioKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub q: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl FolioListQuery {
    pub fn validate(&self) -> Result<(), String> {
        match self.limit {
            Some(limit) if !(1..=LIST_MAX).contains(&limit) => Err(format!("limit is between 1 and {LIST_MAX}.")),
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioList {
    pub items: Vec<Folio>,
    pub next_cursor: Option<String>,
}

/// Content to start from: `markdown` for docs and slides, `spec` for
/// designs and dashboards (one of them; a union in TypeScript).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FolioContentInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShareWith {
    pub principal: String,
    pub role: FolioRole,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NewFolio {
    pub kind: FolioKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// None: the creator's Private section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<FolioContentInput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<FolioSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_with: Option<Vec<ShareWith>>,
}

impl NewFolio {
    /// What is wrong with it, in the same words as `newFolioError`.
    /// Whether its space and parent exist and allow it is the docs
    /// service's to say.
    pub fn validate(&self) -> Result<(), String> {
        if self.title.as_deref().unwrap_or_default().chars().count() > MAX_TITLE {
            return Err(format!("A title is at most {MAX_TITLE} characters."));
        }
        if let Some(content) = &self.content {
            if self.kind.takes_markdown() && content.markdown.is_none() {
                return Err(format!("A {} starts from markdown.", self.kind.noun()));
            }
            if !self.kind.takes_markdown() && !content.spec.as_ref().is_some_and(Value::is_object) {
                return Err(format!("A {} starts from a spec.", self.kind.noun()));
            }
            if self.template_id.is_some() {
                return Err("Start from a template or from content, not both.".to_owned());
            }
        }
        let share = self.share_with.as_deref().unwrap_or_default();
        if share.len() > MAX_SHARE {
            return Err(format!("Share with at most {MAX_SHARE} at once."));
        }
        if let Some(row) = share.iter().find(|row| !is_principal(&row.principal)) {
            return Err(format!("{} is not user:, agent: or team: and an id.", row.principal));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FolioChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Some(None) clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioMove {
    /// None: Private.
    pub space_id: Option<String>,
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
}

/// One change from the share dialog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FolioAccessChange {
    Grant {
        principal: String,
        role: FolioRole,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notify: Option<String>,
    },
    Revoke {
        principal: String,
    },
    General {
        access: GeneralAccess,
        role: Option<FolioRole>,
    },
    Inherit {
        inherit: bool,
    },
    AgentMode {
        agent_mode: Option<AgentMode>,
    },
}

impl FolioAccessChange {
    /// What is wrong with it, in the same words as `folioAccessChangeError`.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            FolioAccessChange::Grant { principal, notify, .. } => {
                if !is_principal(principal) {
                    return Err(format!("{principal} is not user:, agent: or team: and an id."));
                }
                if notify.as_deref().is_some_and(|text| text.chars().count() > 2_000) {
                    return Err("A message is at most 2000 characters.".to_owned());
                }
                Ok(())
            }
            FolioAccessChange::Revoke { principal } if !is_principal(principal) => Err(format!("{principal} is not user:, agent: or team: and an id.")),
            FolioAccessChange::General { access: GeneralAccess::None, role } => match role {
                None => Ok(()),
                Some(_) => Err("Restricted takes no role.".to_owned()),
            },
            FolioAccessChange::General { access, role } => match role {
                None => Err(format!("{} needs a role.", access.label())),
                Some(FolioRole::Manage) => Err("General access gives view, comment or edit, never full access.".to_owned()),
                Some(_) => Ok(()),
            },
            _ => Ok(()),
        }
    }

    /// The artifacts service method it goes to.
    pub fn method(&self) -> &'static str {
        match self {
            FolioAccessChange::Grant { .. } | FolioAccessChange::Revoke { .. } => "set_folio_grant",
            _ => "set_folio_general_access",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioVersion {
    pub id: String,
    pub folio_id: String,
    pub created_at: String,
    pub authors: Vec<Value>,
    /// created, edit, agent, suggestion, proposal or restore.
    pub kind: String,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioTemplate {
    pub id: String,
    pub kind: FolioKind,
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub builtin: bool,
    pub body: String,
    pub created_by: Option<Value>,
}

// --- Agent edits --------------------------------------------------------------

/// A JavaScript `String(value)` of a field, for messages that must read the
/// same as the TypeScript's.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(Value::Array(items)) => items.iter().map(|item| js_string(Some(item))).collect::<Vec<_>>().join(","),
        Some(other) => other.to_string(),
    }
}

/// What is wrong with an agent edit's envelope (`FolioAgentEdit` in
/// folios.ts), in the same words as `folioAgentEditError`: its kind, and a
/// doc's target and Markdown or the other kinds' list of ops. Returns the
/// kind when it is well formed. Each op is the artifacts service's to check.
pub fn agent_edit_error(edit: &Value) -> Result<FolioKind, String> {
    let Some(edit) = edit.as_object() else { return Err("An edit is an object.".to_owned()) };
    let Some(kind) = edit.get("kind").and_then(Value::as_str).and_then(FolioKind::parse) else {
        return Err(format!("There is no kind of artifact called {}.", js_string(edit.get("kind"))));
    };
    if edit.get("note").is_some_and(|note| !note.is_null() && !note.is_string()) {
        return Err("note is text.".to_owned());
    }
    if kind == FolioKind::Doc {
        if !edit.get("markdown").is_some_and(Value::is_string) {
            return Err("A doc edit has markdown.".to_owned());
        }
        if edit.contains_key("ops") {
            return Err("A doc edit has a target and markdown, not ops.".to_owned());
        }
        let Some(target) = edit.get("target").and_then(Value::as_object) else {
            return Err("A doc edit has a target.".to_owned());
        };
        let text = |key: &str| target.get(key).and_then(Value::as_str);
        return match text("kind") {
            Some("append" | "document") => Ok(kind),
            Some("section") if text("heading").is_some_and(|heading| !heading.is_empty()) => Ok(kind),
            Some("section") => Err("A section target names its heading.".to_owned()),
            Some("blocks") if text("from_block").is_some() && text("to_block").is_some() => Ok(kind),
            Some("blocks") => Err("A blocks target names from_block and to_block.".to_owned()),
            _ => Err("A doc edit's target is append, document, section or blocks.".to_owned()),
        };
    }
    if edit.contains_key("markdown") || edit.contains_key("target") {
        return Err(format!("A {} edit has ops, not a target and markdown.", kind.noun()));
    }
    let Some(ops) = edit.get("ops").and_then(Value::as_array).filter(|ops| !ops.is_empty()) else {
        return Err(format!("A {} edit has a list of ops.", kind.noun()));
    };
    if ops.len() > MAX_OPS {
        return Err(format!("An edit has at most {MAX_OPS} ops."));
    }
    if !ops.iter().all(|op| op.get("op").is_some_and(Value::is_string)) {
        return Err("Each op is an object with an op.".to_owned());
    }
    Ok(kind)
}

// --- The artifacts service's folio RPC ---------------------------------------------

/// Every method the artifacts service answers for folios, as `FOLIO_RPC_METHODS`
/// in folios.ts.
pub const FOLIO_RPC_METHODS: [&str; 48] = [
    "folio_list",
    "folio_sidebar",
    "folio",
    "folio_page",
    "create_folio",
    "update_folio",
    "move_folio",
    "duplicate_folio",
    "trash_folio",
    "restore_folio",
    "delete_folio",
    "folio_trash",
    "favorite_folio",
    "folio_content",
    "edit_folio",
    "folio_access",
    "set_folio_grant",
    "set_folio_general_access",
    "request_folio_access",
    "join_space",
    "leave_space",
    "search_folios",
    "folio_versions",
    "folio_version",
    "restore_folio_version",
    "folio_templates",
    "save_folio_template",
    "delete_folio_template",
    "export_folio",
    "folio_suggestions",
    "decide_folio_suggestion",
    "folio_proposals",
    "decide_folio_proposal",
    "folio_thread",
    "folio_threads",
    "query_tile",
    "query_dataset",
    "query_dataset_for_agent",
    "folios_for_agent",
    "read_folio_for_agent",
    "create_folio_as_agent",
    "edit_folio_as_agent",
    "share_folio_as_agent",
    "attach_file_as_agent",
    "recall_folios_for_agent",
    "stale_folios_for_agent",
    "mark_folio_current",
    "reindex_folios",
];

/// `folio_list`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolioListArgs {
    pub workspace: String,
    pub viewer: User,
    pub query: FolioListQuery,
}

/// `folio`, `duplicate_folio`, `trash_folio`, `restore_folio`,
/// `delete_folio`, `folio_content`, `folio_access`, `folio_versions`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolioArgs {
    pub workspace: String,
    pub viewer: User,
    pub folio_id: String,
}

/// `create_folio`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateFolioArgs {
    pub workspace: String,
    pub viewer: User,
    pub input: NewFolio,
}

/// `update_folio`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateFolioArgs {
    pub workspace: String,
    pub viewer: User,
    pub folio_id: String,
    pub change: FolioChange,
}

/// `move_folio`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveFolioArgs {
    pub workspace: String,
    pub viewer: User,
    pub folio_id: String,
    #[serde(rename = "move")]
    pub to: FolioMove,
}

/// `edit_folio`: a `FolioAgentEdit`, as JSON.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditFolioArgs {
    pub workspace: String,
    pub viewer: User,
    pub folio_id: String,
    pub edit: Value,
}

/// `set_folio_grant` and `set_folio_general_access` (see
/// [`FolioAccessChange::method`]).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolioAccessArgs {
    pub workspace: String,
    pub viewer: User,
    pub folio_id: String,
    pub change: FolioAccessChange,
}

/// `folio_version` and `restore_folio_version`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolioVersionArgs {
    pub workspace: String,
    pub viewer: User,
    pub folio_id: String,
    pub version_id: String,
}

/// `folio_templates`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FolioTemplatesArgs {
    pub workspace: String,
    pub viewer: User,
    pub kind: Option<FolioKind>,
}

/// `search_folios`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchFoliosArgs {
    pub workspace: String,
    pub viewer: User,
    pub query: FolioSearchQuery,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolioSearchQuery {
    pub q: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<FolioKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// `words` or `hybrid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `query_dataset`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryDatasetArgs {
    pub workspace: String,
    pub viewer: User,
    pub query: DatasetQuery,
}

// --- Events -------------------------------------------------------------------

/// The `folio.*` types the artifacts service publishes, with no `repoId` on
/// the event: a folio may be private, so it never reaches a repository's
/// timeline or webhooks. Nothing subscribes to them yet.
pub const FOLIO_EVENTS: [&str; 6] = ["folio.created", "folio.updated", "folio.trashed", "folio.restored", "folio.shared", "folio.stale"];

/// What every `folio.*` event carries (`FolioEventData` in events.ts).
/// Event data is camelCase, as every event on the bus.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolioEvent {
    pub workspace: String,
    pub workspace_id: String,
    pub folio_id: String,
    pub kind: FolioKind,
    pub space_id: Option<String>,
    /// None unless every member of the workspace can read it.
    pub title: Option<String>,
}

/// `folio.updated`: a version.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolioUpdated {
    #[serde(flatten)]
    pub folio: FolioEvent,
    pub version_id: String,
    /// edit, agent, suggestion, proposal or restore.
    pub version_kind: String,
    /// Member keys.
    pub authors: Vec<String>,
}

/// `folio.shared`: who was given access, never content.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolioShared {
    #[serde(flatten)]
    pub folio: FolioEvent,
    pub principals: Vec<String>,
    pub role: FolioRole,
}

/// `folio.stale`: code it cites changed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolioStale {
    #[serde(flatten)]
    pub folio: FolioEvent,
    /// `owner/name`.
    pub repo: String,
    pub commit: String,
    pub pull: Option<u32>,
    pub paths: Vec<String>,
    pub owners: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TS: &str = include_str!("../../../packages/contracts/src/folios.ts");
    const EVENTS_TS: &str = include_str!("../../../packages/contracts/src/events.ts");

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("../../../packages/contracts/src/folios.fixtures.json")).unwrap()
    }

    /// The body of `export type <name> = ...` up to its closing `};`.
    fn ts_type<'a>(source: &'a str, name: &str) -> &'a str {
        let start = format!("export type {name} = ");
        source
            .split_once(&start)
            .and_then(|(_, rest)| rest.split_once("\n};"))
            .map(|(body, _)| body)
            .unwrap_or_else(|| panic!("{name} in the TypeScript"))
    }

    /// Every key `value` serializes to is a field of one of the TypeScript
    /// types named.
    fn fields_match(value: &Value, source: &str, types: &[&str]) {
        let bodies: Vec<&str> = types.iter().map(|name| ts_type(source, name)).collect();
        for key in value.as_object().unwrap().keys() {
            assert!(
                bodies.iter().any(|body| body.contains(&format!("  {key}: ")) || body.contains(&format!("  {key}?: "))),
                "{key} is not a field of {types:?}"
            );
        }
    }

    fn folio() -> Folio {
        serde_json::from_value(json!({
            "id": "fol_01jb2k7x9hfq0b3zj0f5s2m8ra", "kind": "slides", "title": "Q4 roadmap", "icon": null,
            "slug": "q4-roadmap-fol_01jb2k7x9hfq0b3zj0f5s2m8ra", "path": "/acme/-/artifacts/q4-roadmap-fol_01jb2k7x9hfq0b3zj0f5s2m8ra",
            "workspace_id": "wsp_1", "space": { "id": "spc_1", "slug": "general", "name": "General", "kind": "workspace" },
            "parent_id": null, "position": 1.5,
            "owner": { "kind": "user", "id": "usr_1", "name": "ana", "display_name": "Ana" },
            "created_by": { "kind": "agent", "id": "agt_1", "name": "g1t", "display_name": "g1t" },
            "created_at": "2026-10-09T00:00:00.000Z", "updated_at": "2026-10-09T00:00:00.000Z",
            "edited_by": null, "edited_at": "2026-10-09T00:00:00.000Z", "trashed_at": null,
            "viewer_role": "edit", "favorite": false, "private": false, "shared_count": 2,
            "general_access": "none", "general_role": null, "inherit": true,
            "inherited_from": { "kind": "space", "id": "spc_1", "name": "General" }, "agent_mode": "suggest",
            "excerpt": "", "preview": { "kind": "slides", "aspect": "16:9", "count": 3, "layout": "title", "title": "Q4" },
            "source": { "title": "#product", "href": "/acme/-/chat/c/1" }, "stale": false, "has_children": false
        }))
        .unwrap()
    }

    #[test]
    fn shapes_have_the_typescript_field_names() {
        fields_match(&serde_json::to_value(folio()).unwrap(), TS, &["FolioRef", "Folio"]);
        let new = NewFolio {
            kind: FolioKind::Doc,
            title: Some("Plan".to_owned()),
            icon: Some("🗺️".to_owned()),
            space_id: Some("spc_1".to_owned()),
            parent_id: Some("fol_1".to_owned()),
            template_id: Some("tpl_1".to_owned()),
            content: Some(FolioContentInput { markdown: Some("# Plan".to_owned()), spec: None }),
            source: Some(FolioSource { title: "t".to_owned(), href: "/h".to_owned() }),
            share_with: Some(vec![ShareWith { principal: "user:usr_2".to_owned(), role: FolioRole::View }]),
        };
        fields_match(&serde_json::to_value(&new).unwrap(), TS, &["NewFolio"]);
        let query = FolioListQuery {
            tab: FolioListTab::Shared,
            kinds: Some(vec![FolioKind::Design]),
            space_id: Some("s".to_owned()),
            owner: Some("user:u".to_owned()),
            project: Some("acme/web".to_owned()),
            q: Some("roadmap".to_owned()),
            cursor: Some("c".to_owned()),
            limit: Some(20),
        };
        fields_match(&serde_json::to_value(&query).unwrap(), TS, &["FolioListQuery"]);
        let change = FolioChange { title: Some("x".to_owned()), icon: Some(None), cover: Some(None), projects: Some(vec![]) };
        fields_match(&serde_json::to_value(&change).unwrap(), TS, &["FolioChange"]);
        let to = FolioMove { space_id: None, parent_id: None, before_id: Some("fol_2".to_owned()) };
        assert_eq!(serde_json::to_value(&to).unwrap(), json!({ "space_id": null, "parent_id": null, "before_id": "fol_2" }));
        let list = FolioList { items: vec![], next_cursor: None };
        assert_eq!(serde_json::to_value(&list).unwrap(), json!({ "items": [], "next_cursor": null }));
        let version = FolioVersion { id: "ver_1".to_owned(), folio_id: "fol_1".to_owned(), created_at: "t".to_owned(), authors: vec![], kind: "edit".to_owned(), note: None };
        fields_match(&serde_json::to_value(&version).unwrap(), TS, &["FolioVersion"]);
        let template = FolioTemplate {
            id: "tpl_1".to_owned(),
            kind: FolioKind::Dashboard,
            name: "Engineering health".to_owned(),
            description: String::new(),
            icon: None,
            builtin: true,
            body: "{}".to_owned(),
            created_by: None,
        };
        fields_match(&serde_json::to_value(&template).unwrap(), TS, &["FolioTemplate"]);
        // Every field of the TypeScript `Folio` comes back from Rust too.
        let rust: Vec<String> = serde_json::to_value(folio()).unwrap().as_object().unwrap().keys().cloned().collect();
        for body in [ts_type(TS, "FolioRef"), ts_type(TS, "Folio")] {
            for line in body.lines() {
                let line = line.trim_start();
                if let Some((key, _)) = line.split_once(':').filter(|(key, _)| !key.is_empty() && key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')) {
                    assert!(rust.contains(&key.to_owned()), "Folio has no {key} in Rust");
                }
            }
        }
    }

    #[test]
    fn access_changes_travel_tagged_by_op() {
        let change = FolioAccessChange::General { access: GeneralAccess::Link, role: Some(FolioRole::Comment) };
        assert_eq!(serde_json::to_value(&change).unwrap(), json!({ "op": "general", "access": "link", "role": "comment" }));
        assert_eq!(change.method(), "set_folio_general_access");
        let grant: FolioAccessChange = serde_json::from_value(json!({ "op": "grant", "principal": "team:design", "role": "edit" })).unwrap();
        assert_eq!(grant.method(), "set_folio_grant");
        let mode: FolioAccessChange = serde_json::from_value(json!({ "op": "agent_mode", "agent_mode": "edit" })).unwrap();
        assert_eq!(mode, FolioAccessChange::AgentMode { agent_mode: Some(AgentMode::Edit) });
    }

    /// The validators agree with the TypeScript's on the shared fixtures.
    #[test]
    fn agrees_with_the_typescript_validators_on_the_fixtures() {
        let fixtures = fixtures();
        let check = |case: &Value, outcome: Result<(), String>| match case["error"].as_str() {
            None => assert_eq!(outcome, Ok(()), "{case}"),
            Some("*") => assert!(outcome.is_err(), "{case} should be refused"),
            Some(error) => assert_eq!(outcome, Err(error.to_owned()), "{case}"),
        };
        for case in fixtures["new_folio"].as_array().unwrap() {
            let outcome = serde_json::from_value::<NewFolio>(case["input"].clone()).map_err(|_| "*".to_owned()).and_then(|input| input.validate());
            check(case, outcome);
        }
        for case in fixtures["access_change"].as_array().unwrap() {
            let outcome = serde_json::from_value::<FolioAccessChange>(case["change"].clone()).map_err(|_| "*".to_owned()).and_then(|change| change.validate());
            check(case, outcome);
        }
        for case in fixtures["agent_edit"].as_array().unwrap() {
            check(case, agent_edit_error(&case["edit"]).map(|_| ()));
        }
        for case in fixtures["folio_ids"].as_array().unwrap() {
            assert_eq!(folio_id_from(case["segment"].as_str().unwrap()), case["id"].as_str(), "{case}");
        }
    }

    #[test]
    fn the_typescript_mirror_has_the_same_kinds_methods_and_events() {
        for kind in FolioKind::ALL {
            assert!(TS.contains(&format!("  {}: \"{}\",", kind.as_str(), kind.label())), "{}", kind.as_str());
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        let methods: Vec<&str> = TS
            .split_once("export const FOLIO_RPC_METHODS = [")
            .and_then(|(_, rest)| rest.split_once("] as const"))
            .map(|(list, _)| list)
            .expect("FOLIO_RPC_METHODS in folios.ts")
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"').and_then(|rest| rest.split_once('"')).map(|(name, _)| name))
            .collect();
        assert_eq!(methods, FOLIO_RPC_METHODS);
        for event in FOLIO_EVENTS {
            assert!(EVENTS_TS.contains(&format!("  \"{event}\": FolioEventData")), "{event} in events.ts");
        }
        let event = FolioEvent {
            workspace: "acme".to_owned(),
            workspace_id: "wsp_1".to_owned(),
            folio_id: "fol_1".to_owned(),
            kind: FolioKind::Doc,
            space_id: None,
            title: None,
        };
        fields_match(&serde_json::to_value(&event).unwrap(), EVENTS_TS, &["FolioEventData"]);
    }

    #[test]
    fn folio_events_read_as_published_and_name_no_repository_id() {
        let data = json!({
            "workspace": "acme", "workspaceId": "wsp_1", "folioId": "fol_1", "kind": "doc", "spaceId": null, "title": null,
            "repo": "acme/web", "commit": "abc", "pull": 431, "paths": ["src/export.ts"], "owners": ["user:usr_1"]
        });
        let stale: FolioStale = serde_json::from_value(data).unwrap();
        assert_eq!((stale.folio.folio_id.as_str(), stale.pull), ("fol_1", Some(431)));
        let json = serde_json::to_value(&stale).unwrap();
        assert!(json.get("repoId").is_none());
        let shared: FolioShared = serde_json::from_value(json!({
            "workspace": "acme", "workspaceId": "wsp_1", "folioId": "fol_1", "kind": "slides", "spaceId": "spc_1", "title": "Q4",
            "principals": ["user:usr_2"], "role": "comment"
        }))
        .unwrap();
        assert_eq!(shared.role, FolioRole::Comment);
        // Not offered to webhooks.
        for event in FOLIO_EVENTS {
            assert!(!crate::webhooks::EVENT_TYPES.contains(&event), "{event}");
        }
    }

    #[test]
    fn principals_and_kinds() {
        assert!(is_principal("user:usr_01jb"));
        assert!(is_principal("team:platform-web"));
        assert!(!is_principal("user:"));
        assert!(!is_principal("group:x"));
        assert!(!is_principal("user:a b"));
        assert!(FolioKind::Doc.can_have_children());
        assert!(FolioKind::ALL.iter().filter(|kind| kind.can_have_children()).count() == 1);
        assert!(FolioRole::Manage > FolioRole::Edit && FolioRole::Comment > FolioRole::View);
    }
}
