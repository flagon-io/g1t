//! Projects: a home for a body of work in a workspace. A project has an
//! outcome to reach, written as its brief, a lead and its people, the
//! repositories its work lands in, dates, a state and a health. A work item
//! is in one project or none.
//!
//! Projects are Work's, not Code's: what Code calls a project is a
//! repository. Reading them is for whoever may see the workspace's work
//! items and milestones; creating and changing them needs the Write role in
//! the workspace (`Capability::ManageLabels`), as milestones do; putting a
//! work item in one needs the Triage role on it.

use serde::{Deserialize, Deserializer, Serialize};

use super::{Appetite, Milestone, Progress, WorkItem};
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// Where a project is in its life.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectState {
    /// The work is being shaped: its brief is not settled yet.
    Shaping,
    /// Being worked on.
    #[default]
    Active,
    /// On hold, to come back to.
    Paused,
    /// Its outcome was reached.
    Done,
    /// Let go without reaching it.
    Dropped,
}

impl ProjectState {
    pub const ALL: [ProjectState; 5] =
        [ProjectState::Shaping, ProjectState::Active, ProjectState::Paused, ProjectState::Done, ProjectState::Dropped];

    pub fn as_str(self) -> &'static str {
        match self {
            ProjectState::Shaping => "shaping",
            ProjectState::Active => "active",
            ProjectState::Paused => "paused",
            ProjectState::Done => "done",
            ProjectState::Dropped => "dropped",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProjectState::Shaping => "Shaping",
            ProjectState::Active => "Active",
            ProjectState::Paused => "Paused",
            ProjectState::Done => "Done",
            ProjectState::Dropped => "Dropped",
        }
    }

    /// `active`, `Active`: any case.
    pub fn parse(name: &str) -> Option<ProjectState> {
        let name = name.trim().to_ascii_lowercase();
        ProjectState::ALL.into_iter().find(|state| state.as_str() == name)
    }

    /// Whether the project is still under way: shaping, active or paused.
    pub fn live(self) -> bool {
        matches!(self, ProjectState::Shaping | ProjectState::Active | ProjectState::Paused)
    }
}

/// How a project is going, as its lead says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectHealth {
    OnTrack,
    AtRisk,
    OffTrack,
}

impl ProjectHealth {
    pub const ALL: [ProjectHealth; 3] = [ProjectHealth::OnTrack, ProjectHealth::AtRisk, ProjectHealth::OffTrack];

    pub fn as_str(self) -> &'static str {
        match self {
            ProjectHealth::OnTrack => "on_track",
            ProjectHealth::AtRisk => "at_risk",
            ProjectHealth::OffTrack => "off_track",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProjectHealth::OnTrack => "On track",
            ProjectHealth::AtRisk => "At risk",
            ProjectHealth::OffTrack => "Off track",
        }
    }

    /// `on_track`, `on-track`, `On track`: any case, `-`, `_` or a space.
    pub fn parse(name: &str) -> Option<ProjectHealth> {
        let name: String = name.trim().to_ascii_lowercase().chars().map(|c| if c == '-' || c == ' ' { '_' } else { c }).collect();
        ProjectHealth::ALL.into_iter().find(|health| health.as_str() == name)
    }
}

/// What someone is in a project.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRole {
    /// Responsible for it: the one `lead` names.
    Lead,
    #[default]
    Member,
}

impl ProjectRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectRole::Lead => "lead",
            ProjectRole::Member => "member",
        }
    }
}

/// The most characters a project's name, summary, brief and instructions
/// may have, and the longest slug and icon.
pub const MAX_PROJECT_NAME_CHARS: usize = 80;
pub const MAX_PROJECT_SLUG_CHARS: usize = 60;
pub const MAX_PROJECT_SUMMARY_CHARS: usize = 200;
pub const MAX_PROJECT_BRIEF_CHARS: usize = 20_000;
pub const MAX_PROJECT_INSTRUCTIONS_CHARS: usize = 8_000;
pub const MAX_PROJECT_ICON_CHARS: usize = 16;
/// The most people and repositories one project may have.
pub const MAX_PROJECT_MEMBERS: usize = 100;
pub const MAX_PROJECT_REPOS: usize = 50;
/// The most projects a workspace lists at once.
pub const MAX_PROJECTS_LISTED: u32 = 200;

/// A project's slug from `text`: lowercase letters, digits and single
/// dashes, at most [`MAX_PROJECT_SLUG_CHARS`]. None when nothing is left.
pub fn project_slug(text: &str) -> Option<String> {
    let mut slug = String::new();
    for c in text.trim().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= MAX_PROJECT_SLUG_CHARS {
            break;
        }
    }
    let slug = slug.trim_end_matches('-').to_owned();
    // A slug never reads as a number, which `-/work/:number` takes.
    (!slug.is_empty() && !slug.chars().all(|c| c.is_ascii_digit())).then_some(slug)
}

/// A project, as a work item names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    /// `prj_…`.
    pub id: String,
    pub slug: String,
    pub name: String,
    /// Six hex digits, without `#`.
    pub color: String,
    /// An emoji, if it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// A project of a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkProject {
    /// `prj_…`.
    pub id: String,
    /// The workspace's slug.
    pub workspace: String,
    /// Unique in the workspace: `/<workspace>/-/work/projects/<slug>`.
    pub slug: String,
    pub name: String,
    /// An emoji, if it has one.
    #[serde(default)]
    pub icon: Option<String>,
    /// Six hex digits, without `#`.
    pub color: String,
    /// What it is for, in a line.
    #[serde(default)]
    pub summary: String,
    /// Markdown: the pitch (the problem, the appetite, the solution, the
    /// rabbit holes and what is out).
    #[serde(default)]
    pub brief: String,
    /// Markdown: what agents are told for every work item in it.
    #[serde(default)]
    pub instructions: String,
    /// The username of its lead, if it has one.
    #[serde(default)]
    pub lead: Option<String>,
    pub state: ProjectState,
    #[serde(default)]
    pub appetite: Option<Appetite>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub start_on: Option<String>,
    /// `YYYY-MM-DD`: when it should be done.
    #[serde(default)]
    pub target_on: Option<String>,
    /// None until someone says.
    #[serde(default)]
    pub health: Option<ProjectHealth>,
    /// Its open work items.
    #[serde(default)]
    pub open_items: u32,
    /// Its closed work items.
    #[serde(default)]
    pub closed_items: u32,
    /// How many people are in it, its lead among them.
    #[serde(default)]
    pub member_count: u32,
    /// RFC 3339.
    pub created_at: String,
    /// Who created it, by username.
    #[serde(default)]
    pub created_by: Option<String>,
    /// RFC 3339.
    pub updated_at: String,
    /// Who last changed it, by username.
    #[serde(default)]
    pub updated_by: Option<String>,
    /// RFC 3339: set while it is archived.
    #[serde(default)]
    pub archived_at: Option<String>,
}

impl WorkProject {
    /// How it is named on a work item.
    pub fn reference(&self) -> ProjectRef {
        ProjectRef {
            id: self.id.clone(),
            slug: self.slug.clone(),
            name: self.name.clone(),
            color: self.color.clone(),
            icon: self.icon.clone(),
        }
    }

    /// How far along it is, from 0 to 100: closed work items over all.
    pub fn percent(&self) -> u32 {
        let total = self.open_items + self.closed_items;
        (self.closed_items * 100).checked_div(total).unwrap_or(0)
    }
}

/// Someone in a project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMember {
    pub user_id: String,
    pub username: String,
    pub role: ProjectRole,
    /// RFC 3339.
    pub added_at: String,
}

/// A repository a project's work lands in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub repo_id: String,
    /// `owner/name`.
    pub path: String,
    /// Linked as a target to each work item filed into the project without
    /// targets of its own.
    pub default_target: bool,
}

/// A project and its home page: its people and repositories, its open
/// work items, how each stands, and the milestones its work items are in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkProjectDetail {
    pub project: WorkProject,
    /// Its lead first, then by username.
    pub members: Vec<ProjectMember>,
    /// Those the viewer may read, by path.
    pub repos: Vec<ProjectRepo>,
    /// Its open work items the viewer may see, in the plan's order: Now,
    /// then Next, Later, Triage and Set aside, at most 100.
    pub open: Vec<WorkItem>,
    /// How each of `open` stands on its hill, in the same order.
    #[serde(default)]
    pub progress: Vec<Progress>,
    /// The workspace milestones its work items are in, open ones first,
    /// each counting only this project's work items.
    #[serde(default)]
    pub milestones: Vec<Milestone>,
}

/// What `Some(None)` means in a change: the field is cleared. Absent
/// leaves it as it is; JSON `null` clears it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `list_projects`: a workspace's projects, live ones first (shaping,
/// active, paused), then done and dropped, each by name. Archived ones
/// only with `archived`. Returns `Outcome<Vec<WorkProject>>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ListProjectsArgs {
    pub workspace: String,
    pub viewer: Viewer,
    /// Only those in this state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ProjectState>,
    /// The archived ones instead.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

/// `get_project`: one project and its home page. Returns
/// `Outcome<WorkProjectDetail>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GetProjectArgs {
    pub workspace: String,
    pub viewer: Viewer,
    /// Its slug or id.
    pub project: String,
}

/// `create_project` and `update_project`: creates a project of a
/// workspace, or with `project` changes the fields given of one. Needs
/// the Write role in the workspace. Returns `Outcome<WorkProject>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SaveProjectArgs {
    pub actor: User,
    pub workspace: String,
    /// For `update_project`: the project to change, by slug or id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Required to create one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Made from the name when creating without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// An emoji; an empty string clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Six hex digits; one is chosen from the name when creating without.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// A username, made a member with the role lead (the lead before stays
    /// a member); an empty string leaves it without one. The actor when
    /// creating without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    /// `active` when creating without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ProjectState>,
    /// `null` clears it.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub appetite: Option<Option<Appetite>>,
    /// `YYYY-MM-DD`; an empty string clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_on: Option<String>,
    /// `YYYY-MM-DD`, not before `start_on`; an empty string clears it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_on: Option<String>,
    /// `null` clears it.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub health: Option<Option<ProjectHealth>>,
}

/// `archive_project`: archives a project, or with `archived` false brings
/// it back. Its work items stay in it. Needs the Write role in the
/// workspace. Returns `Outcome<WorkProject>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ArchiveProjectArgs {
    pub actor: User,
    pub workspace: String,
    /// Its slug or id.
    pub project: String,
    #[serde(default = "yes")]
    pub archived: bool,
}

fn yes() -> bool {
    true
}

/// `add_project_member` and `remove_project_member`: adds someone to a
/// project or changes their role, or takes them out. Taking out its lead
/// leaves it without one. Needs the Write role in the workspace. Returns
/// `Outcome<Vec<ProjectMember>>`, everyone in it now.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProjectMemberArgs {
    pub actor: User,
    pub workspace: String,
    /// Its slug or id.
    pub project: String,
    pub username: String,
    /// For `add_project_member`: `member` when absent; `lead` makes them
    /// its lead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<ProjectRole>,
}

/// `add_project_repo` and `remove_project_repo`: names a repository of the
/// workspace as one the project's work lands in, or changes whether it is
/// a default target, or takes it off. Needs the Write role in the
/// workspace. Returns `Outcome<Vec<ProjectRepo>>`, its repositories now.
#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectRepoArgs {
    pub actor: User,
    pub workspace: String,
    /// Its slug or id.
    pub project: String,
    pub repo: RepoPath,
    /// For `add_project_repo`: true when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_target: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_made_from_names() {
        assert_eq!(project_slug("Work overhaul").as_deref(), Some("work-overhaul"));
        assert_eq!(project_slug("  Mobile 2.0!! ").as_deref(), Some("mobile-2-0"));
        assert_eq!(project_slug("--a__b--").as_deref(), Some("a-b"));
        assert_eq!(project_slug("!!!"), None);
        // A number would read as a work item's.
        assert_eq!(project_slug("2026"), None);
        assert_eq!(project_slug(&"x".repeat(100)).map(|slug| slug.len()), Some(MAX_PROJECT_SLUG_CHARS));
    }

    #[test]
    fn states_and_health_parse_as_people_write_them() {
        assert_eq!(ProjectState::parse(" Paused "), Some(ProjectState::Paused));
        assert!(ProjectState::Shaping.live() && !ProjectState::Done.live());
        assert_eq!(ProjectHealth::parse("at-risk"), Some(ProjectHealth::AtRisk));
        assert_eq!(ProjectHealth::parse("On track"), Some(ProjectHealth::OnTrack));
        assert_eq!(serde_json::to_value(ProjectHealth::OffTrack).unwrap(), "off_track");
    }

    #[test]
    fn a_change_can_clear_health_and_appetite() {
        let cleared: SaveProjectArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "ana" }, "workspace": "acme", "project": "web",
            "health": null, "appetite": null
        }))
        .unwrap();
        assert_eq!(cleared.health, Some(None));
        assert_eq!(cleared.appetite, Some(None));
        let left: SaveProjectArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "ana" }, "workspace": "acme", "health": "at_risk"
        }))
        .unwrap();
        assert_eq!(left.health, Some(Some(ProjectHealth::AtRisk)));
        assert_eq!(left.appetite, None);
        let archive: ArchiveProjectArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "ana" }, "workspace": "acme", "project": "web"
        }))
        .unwrap();
        assert!(archive.archived);
    }
}
