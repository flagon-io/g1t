//! Projects (`g1t_contracts::work::projects`, migrations/0061_projects.sql):
//! homes for bodies of work in a workspace, with their people and the
//! repositories their work lands in. A work item is in one project or none
//! (`work_items.project_id`).
//!
//! Who may read one is who may read the workspace's milestones
//! (`workspace_visible`); creating and changing one needs the Write role in
//! the workspace, as milestones do (`labelled_workspace`); putting a work
//! item in one needs the Triage role on it, as a milestone does.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::milestones::MilestoneRow;
use super::plan::{FACTS, FactsRow, PLAN_ORDER, days_before};
use super::rows::{Held, ITEM_COLUMNS, ItemRow, path_of, repo_readable, workspace_of};
use crate::{Work, optional};

/// A project's columns, with how many of its work items are open and
/// closed and how many people are in it.
const PROJECT_COLUMNS: &str = "projects.*,
  (SELECT count(*) FROM work_items w WHERE w.project_id = projects.id AND w.state = 'open' AND w.number IS NOT NULL) AS open_items,
  (SELECT count(*) FROM work_items w WHERE w.project_id = projects.id AND w.state = 'closed' AND w.number IS NOT NULL) AS closed_items,
  (SELECT count(*) FROM project_members m WHERE m.project_id = projects.id) AS member_count";

/// Live projects first (shaping, active, paused), then done and dropped,
/// each by name.
const LIST_ORDER: &str = "ORDER BY projects.state IN ('done', 'dropped'), lower(projects.name), projects.slug";

/// A project's open, numbered work items, `?1` its id: Now, Next, Later,
/// Triage and Set aside, each in the plan's order.
const OPEN_ITEMS: &str = "SELECT {ITEM_COLUMNS} FROM work_items
   WHERE work_items.project_id = ?1 AND work_items.state = 'open' AND work_items.number IS NOT NULL
   ORDER BY CASE COALESCE(work_items.horizon, 'triage')
              WHEN 'now' THEN 0 WHEN 'next' THEN 1 WHEN 'later' THEN 2 WHEN 'triage' THEN 3 ELSE 4 END,
            {PLAN_ORDER}
   LIMIT 100";

/// The workspace milestones (`?1`) project `?2`'s work items are in, each
/// counting only those: open ones first, soonest due first.
const MILESTONES: &str = "SELECT m.*,
   (SELECT count(*) FROM work_items w WHERE w.project_id = ?2 AND w.milestone = m.number AND w.state = 'open') AS open_items,
   (SELECT count(*) FROM work_items w WHERE w.project_id = ?2 AND w.milestone = m.number AND w.state = 'closed') AS closed_items
 FROM milestones m
 WHERE m.workspace = ?1 AND EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = ?2 AND w.milestone = m.number)
 ORDER BY m.state = 'closed', m.due_on IS NULL, m.due_on, m.number LIMIT 20";

/// A project's people, `?1` its id: its lead first, then by username.
const MEMBERS: &str =
    "SELECT user_id, username, role, added_at FROM project_members WHERE project_id = ?1 ORDER BY role <> 'lead', username";

/// A project's repositories, `?1` its id, with where each is.
const REPOS: &str = "SELECT r.repo_id, r.default_target, rw.path, rw.workspace, rw.private
   FROM project_repos r LEFT JOIN repo_workspaces rw ON rw.repo_id = r.repo_id
   WHERE r.project_id = ?1 ORDER BY rw.path";

/// A workspace renamed (`g1t_kit::rename`, `?1` its slug now, `?2`
/// before): its projects follow.
pub(crate) const RENAMED: &[&str] = &["UPDATE OR IGNORE projects SET workspace = ?1 WHERE workspace = ?2"];

/// A workspace deleted (`?1` its slug): its projects go, with their people
/// and repositories.
pub(crate) const DELETED: &[&str] = &[
    "DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE workspace = ?1)",
    "DELETE FROM project_repos WHERE project_id IN (SELECT id FROM projects WHERE workspace = ?1)",
    "DELETE FROM projects WHERE workspace = ?1",
];

/// A repository purged (`?1` its id): no project names it.
pub(crate) const REPO_PURGED: &str = "DELETE FROM project_repos WHERE repo_id = ?1";

/// An account purged (ghost.rs, `?1` its id): it leads nothing and is in
/// no project, and what it created or changed shows as ghost's.
pub(crate) fn user_deleted() -> Vec<String> {
    use g1t_contracts::account_deletion::{GHOST_ID, GHOST_USERNAME};
    vec![
        "UPDATE projects SET lead_id = NULL, lead_name = NULL WHERE lead_id = ?1".to_owned(),
        "DELETE FROM project_members WHERE user_id = ?1".to_owned(),
        format!("UPDATE projects SET created_by = '{GHOST_ID}', created_by_name = '{GHOST_USERNAME}' WHERE created_by = ?1"),
        format!("UPDATE projects SET updated_by = '{GHOST_ID}', updated_by_name = '{GHOST_USERNAME}' WHERE updated_by = ?1"),
    ]
}

#[derive(Deserialize)]
struct ProjectRow {
    id: String,
    workspace: String,
    slug: String,
    name: String,
    #[serde(default)]
    icon: Option<String>,
    color: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    brief: String,
    #[serde(default)]
    instructions: String,
    #[serde(default)]
    lead_name: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    appetite: Option<Appetite>,
    #[serde(default)]
    start_on: Option<String>,
    #[serde(default)]
    target_on: Option<String>,
    #[serde(default)]
    health: Option<String>,
    #[serde(default)]
    open_items: u32,
    #[serde(default)]
    closed_items: u32,
    #[serde(default)]
    member_count: u32,
    created_at: String,
    #[serde(default)]
    created_by_name: Option<String>,
    updated_at: String,
    #[serde(default)]
    updated_by_name: Option<String>,
    #[serde(default)]
    archived_at: Option<String>,
}

impl From<ProjectRow> for WorkProject {
    fn from(row: ProjectRow) -> Self {
        WorkProject {
            id: row.id,
            workspace: row.workspace,
            slug: row.slug,
            name: row.name,
            icon: row.icon.filter(|icon| !icon.is_empty()),
            color: row.color,
            summary: row.summary,
            brief: row.brief,
            instructions: row.instructions,
            lead: row.lead_name,
            state: row.state.as_deref().and_then(ProjectState::parse).unwrap_or_default(),
            appetite: row.appetite,
            start_on: row.start_on,
            target_on: row.target_on,
            health: row.health.as_deref().and_then(ProjectHealth::parse),
            open_items: row.open_items,
            closed_items: row.closed_items,
            member_count: row.member_count,
            created_at: row.created_at,
            created_by: row.created_by_name,
            updated_at: row.updated_at,
            updated_by: row.updated_by_name,
            archived_at: row.archived_at,
        }
    }
}

#[derive(Deserialize)]
struct MemberRow {
    user_id: String,
    username: String,
    role: String,
    added_at: String,
}

impl From<MemberRow> for ProjectMember {
    fn from(row: MemberRow) -> Self {
        ProjectMember {
            user_id: row.user_id,
            username: row.username,
            role: if row.role == "lead" { ProjectRole::Lead } else { ProjectRole::Member },
            added_at: row.added_at,
        }
    }
}

#[derive(Deserialize)]
struct RepoRow {
    repo_id: String,
    #[serde(default)]
    default_target: u8,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    private: Option<u8>,
}

/// A project's name as given: trimmed, not empty, not too long.
fn tidy_name(name: &str) -> std::result::Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        Err("A project needs a name.".to_owned())
    } else if name.chars().count() > MAX_PROJECT_NAME_CHARS {
        Err(format!("A project's name can be at most {MAX_PROJECT_NAME_CHARS} characters."))
    } else {
        Ok(name)
    }
}

/// Text as given, trimmed, if it is not longer than `max`; `what` names it
/// in the refusal.
fn bounded(text: Option<&str>, max: usize, what: &str) -> std::result::Result<Option<String>, String> {
    match text.map(str::trim) {
        Some(text) if text.chars().count() > max => Err(format!("A project's {what} can be at most {max} characters.")),
        text => Ok(text.map(str::to_owned)),
    }
}

/// A day as given: `Some(None)` clears it.
fn day(given: Option<&str>, what: &str) -> std::result::Result<Option<Option<String>>, String> {
    match given.map(str::trim) {
        None => Ok(None),
        Some("") => Ok(Some(None)),
        Some(value) => match tidy_due_on(value) {
            Some(day) => Ok(Some(Some(day))),
            None => Err(format!("A {what} is a day, written YYYY-MM-DD.")),
        },
    }
}

/// An icon as given: an emoji or a few characters; `Some(None)` clears it.
fn icon(given: Option<&str>) -> std::result::Result<Option<Option<String>>, String> {
    match given.map(str::trim) {
        None => Ok(None),
        Some("") => Ok(Some(None)),
        Some(icon) if icon.chars().count() > MAX_PROJECT_ICON_CHARS => Err("A project's icon is an emoji.".to_owned()),
        Some(icon) => Ok(Some(Some(icon.to_owned()))),
    }
}

/// What a work item says when it moves between projects.
pub(crate) fn project_note(before: Option<&ProjectRef>, after: Option<&ProjectRef>) -> Option<String> {
    match (before, after) {
        (Some(old), Some(new)) if old.id == new.id => None,
        (Some(old), Some(new)) => Some(format!("moved this from the {} project to {}", old.name, new.name)),
        (None, Some(new)) => Some(format!("added this to the {} project", new.name)),
        (Some(old), None) => Some(format!("removed this from the {} project", old.name)),
        (None, None) => None,
    }
}

fn not_found<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Project not found.")
}

/// Whether `key` names a project by id rather than by slug.
fn by_id(key: &str) -> bool {
    key.starts_with("prj_")
}

impl Work {
    /// The project of `workspace` that `key` (its slug or id) names,
    /// archived or not.
    pub(crate) async fn project_in(&self, workspace: &str, key: &str) -> Result<Option<WorkProject>> {
        let key = key.trim();
        if key.is_empty() {
            return Ok(None);
        }
        let column = if by_id(key) { "id" } else { "slug" };
        let key = if by_id(key) { key.to_owned() } else { key.to_lowercase() };
        Ok(self
            .db
            .prepare(format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE workspace = ?1 AND {column} = ?2"))
            .bind(&[workspace.into(), key.as_str().into()])?
            .first::<ProjectRow>(None)
            .await?
            .map(WorkProject::from))
    }

    async fn members_of(&self, project_id: &str) -> Result<Vec<ProjectMember>> {
        let rows = self.db.prepare(MEMBERS).bind(&[project_id.into()])?.all().await?.results::<MemberRow>()?;
        Ok(rows.into_iter().map(ProjectMember::from).collect())
    }

    /// A project's repositories that `viewer` may read.
    async fn repos_of(&self, project_id: &str, viewer: Option<&User>) -> Result<Vec<ProjectRepo>> {
        let rows = self.db.prepare(REPOS).bind(&[project_id.into()])?.all().await?.results::<RepoRow>()?;
        Ok(rows
            .into_iter()
            .filter(|row| repo_readable(viewer, &row.repo_id, row.workspace.as_deref(), row.private))
            .map(|row| ProjectRepo { repo_id: row.repo_id, path: row.path.unwrap_or_default(), default_target: row.default_target != 0 })
            .collect())
    }

    /// The account of `username`, as a project names it: (id, username).
    async fn account(&self, username: &str) -> Result<Outcome<(String, String)>> {
        let name = username.trim().trim_start_matches('@').to_lowercase();
        if name.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say who, by username."));
        }
        let account: Viewer = g1t_kit::call(&self.identity, "user_by_username", &UsernameArgs { username: name.clone() }).await?;
        Ok(match account {
            Some(user) => Outcome::Ok((user.id, user.username.to_lowercase())),
            None => Outcome::fail(FailureCode::Invalid, format!("There is no account named {name}.")),
        })
    }

    /// The project named by `key` that `actor` may change, with its
    /// workspace.
    async fn changeable_project(&self, actor: &User, workspace: &str, key: &str) -> Result<Outcome<(String, WorkProject)>> {
        let workspace = check!(self.labelled_workspace(actor, workspace).await?);
        match self.project_in(&workspace, key).await? {
            Some(project) => Ok(Outcome::Ok((workspace, project))),
            None => Ok(not_found()),
        }
    }

    /// Makes `user_id` its lead (`Some`), or leaves it without one, in
    /// statements for a batch: the lead before stays a member.
    fn lead_statements(&self, project_id: &str, lead: Option<(&str, &str)>, at: &str, by: &str) -> Result<Vec<worker::D1PreparedStatement>> {
        let mut statements = vec![self
            .db
            .prepare("UPDATE project_members SET role = 'member' WHERE project_id = ?1 AND role = 'lead'")
            .bind(&[project_id.into()])?];
        match lead {
            Some((id, username)) => {
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO project_members (project_id, user_id, username, role, added_at, added_by)
                             VALUES (?1, ?2, ?3, 'lead', ?4, ?5)
                             ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'lead', username = excluded.username",
                        )
                        .bind(&[project_id.into(), id.into(), username.into(), at.into(), by.into()])?,
                );
                statements.push(
                    self.db
                        .prepare("UPDATE projects SET lead_id = ?2, lead_name = ?3 WHERE id = ?1")
                        .bind(&[project_id.into(), id.into(), username.into()])?,
                );
            }
            None => statements.push(
                self.db.prepare("UPDATE projects SET lead_id = NULL, lead_name = NULL WHERE id = ?1").bind(&[project_id.into()])?,
            ),
        }
        Ok(statements)
    }

    // --- RPC methods ----------------------------------------------------------

    pub(crate) async fn list_projects(&self, a: ListProjectsArgs) -> Result<Outcome<Vec<WorkProject>>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        let state = a.state.map_or(JsValue::NULL, |state| state.as_str().into());
        let rows = self
            .db
            .prepare(format!(
                "SELECT {PROJECT_COLUMNS} FROM projects
                 WHERE workspace = ?1 AND (?2 IS NULL OR state = ?2) AND (archived_at IS NOT NULL) = ?3
                 {LIST_ORDER} LIMIT {MAX_PROJECTS_LISTED}"
            ))
            .bind(&[workspace.as_str().into(), state, u32::from(a.archived).into()])?
            .all()
            .await?
            .results::<ProjectRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(WorkProject::from).collect()))
    }

    /// A project and its home page: its people, the repositories the viewer
    /// may read, its open work items they may see with how each stands, and
    /// the milestones its work items are in.
    pub(crate) async fn get_project(&self, a: GetProjectArgs) -> Result<Outcome<WorkProjectDetail>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(not_found());
        }
        let Some(project) = self.project_in(&workspace, &a.project).await? else {
            return Ok(not_found());
        };
        let viewer = a.viewer.as_ref();
        let key = [JsValue::from(project.id.as_str())];
        let open_sql = OPEN_ITEMS.replace("{ITEM_COLUMNS}", ITEM_COLUMNS).replace("{PLAN_ORDER}", PLAN_ORDER);
        let results = self
            .timing
            .db(
                4,
                self.db.batch(vec![
                    self.db.prepare(MEMBERS).bind(&key)?,
                    self.db.prepare(REPOS).bind(&key)?,
                    self.db.prepare(open_sql).bind(&key)?,
                    self.db.prepare(MILESTONES).bind(&[workspace.as_str().into(), project.id.as_str().into()])?,
                ]),
            )
            .await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let members = rows(0)?.results::<MemberRow>()?.into_iter().map(ProjectMember::from).collect();
        let repos = rows(1)?
            .results::<RepoRow>()?
            .into_iter()
            .filter(|row| repo_readable(viewer, &row.repo_id, row.workspace.as_deref(), row.private))
            .map(|row| ProjectRepo { repo_id: row.repo_id, path: row.path.unwrap_or_default(), default_target: row.default_target != 0 })
            .collect();
        let open: Vec<WorkItem> = rows(2)?
            .results::<ItemRow>()?
            .into_iter()
            .filter_map(ItemRow::held)
            .filter(|held| held.may(viewer, Capability::Read))
            .map(|held| held.shown(viewer))
            .collect();
        let milestones = rows(3)?.results::<MilestoneRow>()?.into_iter().map(Milestone::from).collect();
        // How each open one stands on its hill, as the plan reads Now's.
        let ids: Vec<&str> = open.iter().map(|item| item.id.as_str()).collect();
        let mut facts: Vec<FactsRow> = if ids.is_empty() {
            Vec::new()
        } else {
            self.db.prepare(FACTS).bind(&[serde_json::to_string(&ids)?.into()])?.all().await?.results::<FactsRow>()?
        };
        let quiet_before = days_before(now_ms(), QUIET_DAYS);
        let progress = open
            .iter()
            .filter_map(|item| {
                let at = facts.iter().position(|row| row.number == item.number)?;
                Some(facts.swap_remove(at).progress(&quiet_before))
            })
            .collect();
        Ok(Outcome::Ok(WorkProjectDetail { project, members, repos, open, progress, milestones }))
    }

    pub(crate) async fn create_project(&self, mut a: SaveProjectArgs) -> Result<Outcome<WorkProject>> {
        a.project = None;
        self.save_project(a).await
    }

    pub(crate) async fn update_project(&self, a: SaveProjectArgs) -> Result<Outcome<WorkProject>> {
        if a.project.as_deref().is_none_or(|key| key.trim().is_empty()) {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which project, by its slug."));
        }
        self.save_project(a).await
    }

    /// Creates a project, or with `project` changes the fields given of one.
    async fn save_project(&self, a: SaveProjectArgs) -> Result<Outcome<WorkProject>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        let existing = match a.project.as_deref() {
            Some(key) => match self.project_in(&workspace, key).await? {
                Some(project) => Some(project),
                None => return Ok(not_found()),
            },
            None => None,
        };
        let invalid = |message: String| Ok(Outcome::fail(FailureCode::Invalid, message));
        let name = match a.name.as_deref().map(tidy_name) {
            Some(Err(message)) => return invalid(message),
            Some(Ok(name)) => Some(name),
            None => None,
        };
        if existing.is_none() && name.is_none() {
            return invalid("A project needs a name.".to_owned());
        }
        let slug = match a.slug.as_deref().map(str::trim).filter(|slug| !slug.is_empty()) {
            Some(given) => match project_slug(given) {
                Some(slug) => Some(slug),
                None => return invalid("A project's slug needs a letter: letters, digits and dashes.".to_owned()),
            },
            // A new one is named after itself.
            None if existing.is_none() => match name.as_deref().and_then(project_slug) {
                Some(slug) => Some(slug),
                None => return invalid("Give the project a slug: its name has no letters to make one from.".to_owned()),
            },
            None => None,
        };
        let color = match a.color.as_deref().map(str::trim).filter(|color| !color.is_empty()) {
            Some(given) => match tidy_color(given) {
                Some(color) => Some(color),
                None => return invalid("A color is six hex digits, like 1d76db.".to_owned()),
            },
            None if existing.is_none() => Some(label_color_for(slug.as_deref().unwrap_or_default())),
            None => None,
        };
        let icon = match icon(a.icon.as_deref()) {
            Ok(icon) => icon,
            Err(message) => return invalid(message),
        };
        let summary = match bounded(a.summary.as_deref(), MAX_PROJECT_SUMMARY_CHARS, "summary") {
            Ok(summary) => summary.map(|summary| summary.split_whitespace().collect::<Vec<_>>().join(" ")),
            Err(message) => return invalid(message),
        };
        let brief = match bounded(a.brief.as_deref(), MAX_PROJECT_BRIEF_CHARS, "brief") {
            Ok(brief) => brief,
            Err(message) => return invalid(message),
        };
        let instructions = match bounded(a.instructions.as_deref(), MAX_PROJECT_INSTRUCTIONS_CHARS, "instructions") {
            Ok(instructions) => instructions,
            Err(message) => return invalid(message),
        };
        let (start_on, target_on) = match (day(a.start_on.as_deref(), "start date"), day(a.target_on.as_deref(), "target date")) {
            (Ok(start), Ok(target)) => (start, target),
            (Err(message), _) | (_, Err(message)) => return invalid(message),
        };
        // The target is never before the start, as it will be after this.
        let start_after = start_on.clone().unwrap_or_else(|| existing.as_ref().and_then(|project| project.start_on.clone()));
        let target_after = target_on.clone().unwrap_or_else(|| existing.as_ref().and_then(|project| project.target_on.clone()));
        if let (Some(start), Some(target)) = (&start_after, &target_after) {
            if target < start {
                return invalid("A project's target date can't be before its start date.".to_owned());
            }
        }
        // Its lead: someone with an account; the actor for a new one
        // without.
        let lead = match a.lead.as_deref().map(str::trim) {
            Some("") => Some(None),
            Some(name) => Some(Some(check!(self.account(name).await?))),
            None if existing.is_none() => Some(Some((a.actor.id.clone(), a.actor.username.to_lowercase()))),
            None => None,
        };
        // Slugs are unique in a workspace.
        if let Some(slug) = &slug {
            let clash = self
                .db
                .prepare("SELECT id AS value FROM projects WHERE workspace = ?1 AND slug = ?2 AND (?3 IS NULL OR id <> ?3)")
                .bind(&[workspace.as_str().into(), slug.as_str().into(), optional(&existing.as_ref().map(|project| project.id.clone()))])?
                .first::<crate::rows::ValueRow>(None)
                .await?;
            if clash.is_some() {
                return Ok(Outcome::fail(FailureCode::Conflict, format!("A project with the slug {slug} already exists.")));
            }
        }
        let now = now_ms();
        let at = rfc3339(now);
        let actor_name = a.actor.username.to_lowercase();
        let day_value = |value: &Option<Option<String>>| value.clone().flatten().map_or(JsValue::NULL, JsValue::from);
        let health = a.health.map(|health| health.map(ProjectHealth::as_str));
        let appetite = a.appetite.map(|appetite| appetite.map(Appetite::as_str));
        let (id, mut statements) = match &existing {
            None => {
                let id = new_id("prj", now);
                let statement = self
                    .db
                    .prepare(
                        "INSERT INTO projects
                           (id, workspace, slug, name, icon, color, summary, brief, instructions, state, appetite,
                            start_on, target_on, health, created_at, created_by, created_by_name, updated_at, updated_by, updated_by_name)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?15, ?16, ?17)",
                    )
                    .bind(&[
                        id.as_str().into(),
                        workspace.as_str().into(),
                        slug.clone().unwrap_or_default().into(),
                        name.clone().unwrap_or_default().into(),
                        icon.clone().flatten().map_or(JsValue::NULL, JsValue::from),
                        color.clone().unwrap_or_default().into(),
                        summary.clone().unwrap_or_default().into(),
                        brief.clone().unwrap_or_default().into(),
                        instructions.clone().unwrap_or_default().into(),
                        a.state.unwrap_or_default().as_str().into(),
                        appetite.flatten().map_or(JsValue::NULL, JsValue::from),
                        day_value(&start_on),
                        day_value(&target_on),
                        health.flatten().map_or(JsValue::NULL, JsValue::from),
                        at.as_str().into(),
                        a.actor.id.as_str().into(),
                        actor_name.as_str().into(),
                    ])?;
                (id, vec![statement])
            }
            Some(project) => {
                let statement = self
                    .db
                    .prepare(
                        "UPDATE projects
                         SET slug = COALESCE(?2, slug), name = COALESCE(?3, name),
                             icon = CASE WHEN ?4 THEN ?5 ELSE icon END, color = COALESCE(?6, color),
                             summary = COALESCE(?7, summary), brief = COALESCE(?8, brief),
                             instructions = COALESCE(?9, instructions), state = COALESCE(?10, state),
                             appetite = CASE WHEN ?11 THEN ?12 ELSE appetite END,
                             start_on = CASE WHEN ?13 THEN ?14 ELSE start_on END,
                             target_on = CASE WHEN ?15 THEN ?16 ELSE target_on END,
                             health = CASE WHEN ?17 THEN ?18 ELSE health END,
                             updated_at = ?19, updated_by = ?20, updated_by_name = ?21
                         WHERE id = ?1",
                    )
                    .bind(&[
                        project.id.as_str().into(),
                        optional(&slug),
                        optional(&name),
                        icon.is_some().into(),
                        icon.clone().flatten().map_or(JsValue::NULL, JsValue::from),
                        optional(&color),
                        optional(&summary),
                        optional(&brief),
                        optional(&instructions),
                        a.state.map_or(JsValue::NULL, |state| state.as_str().into()),
                        appetite.is_some().into(),
                        appetite.flatten().map_or(JsValue::NULL, JsValue::from),
                        start_on.is_some().into(),
                        day_value(&start_on),
                        target_on.is_some().into(),
                        day_value(&target_on),
                        health.is_some().into(),
                        health.flatten().map_or(JsValue::NULL, JsValue::from),
                        at.as_str().into(),
                        a.actor.id.as_str().into(),
                        actor_name.as_str().into(),
                    ])?;
                (project.id.clone(), vec![statement])
            }
        };
        if let Some(lead) = &lead {
            let lead = lead.as_ref().map(|(id, name)| (id.as_str(), name.as_str()));
            statements.extend(self.lead_statements(&id, lead, &at, &a.actor.id)?);
        }
        self.db.batch(statements).await?;
        Ok(match self.project_in(&workspace, &id).await? {
            Some(project) => Outcome::Ok(project),
            None => not_found(),
        })
    }

    pub(crate) async fn archive_project(&self, a: ArchiveProjectArgs) -> Result<Outcome<WorkProject>> {
        let (workspace, project) = check!(self.changeable_project(&a.actor, &a.workspace, &a.project).await?);
        if project.archived_at.is_some() != a.archived {
            let at = rfc3339(now_ms());
            self.db
                .prepare(
                    "UPDATE projects SET archived_at = CASE WHEN ?2 THEN ?3 ELSE NULL END,
                       updated_at = ?3, updated_by = ?4, updated_by_name = ?5 WHERE id = ?1",
                )
                .bind(&[
                    project.id.as_str().into(),
                    a.archived.into(),
                    at.as_str().into(),
                    a.actor.id.as_str().into(),
                    a.actor.username.to_lowercase().into(),
                ])?
                .run()
                .await?;
        }
        Ok(match self.project_in(&workspace, &project.id).await? {
            Some(project) => Outcome::Ok(project),
            None => not_found(),
        })
    }

    pub(crate) async fn add_project_member(&self, a: ProjectMemberArgs) -> Result<Outcome<Vec<ProjectMember>>> {
        let (_, project) = check!(self.changeable_project(&a.actor, &a.workspace, &a.project).await?);
        let (id, username) = check!(self.account(&a.username).await?);
        let members = self.members_of(&project.id).await?;
        if members.len() >= MAX_PROJECT_MEMBERS && !members.iter().any(|member| member.user_id == id) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("A project can have at most {MAX_PROJECT_MEMBERS} people.")));
        }
        let at = rfc3339(now_ms());
        let statements = if a.role == Some(ProjectRole::Lead) {
            self.lead_statements(&project.id, Some((&id, &username)), &at, &a.actor.id)?
        } else {
            // Made a member: the lead taken down to one leaves it without.
            let mut statements = vec![self
                .db
                .prepare(
                    "INSERT INTO project_members (project_id, user_id, username, role, added_at, added_by)
                     VALUES (?1, ?2, ?3, 'member', ?4, ?5)
                     ON CONFLICT (project_id, user_id) DO UPDATE SET username = excluded.username,
                       role = CASE WHEN ?6 THEN 'member' ELSE project_members.role END",
                )
                .bind(&[
                    project.id.as_str().into(),
                    id.as_str().into(),
                    username.as_str().into(),
                    at.as_str().into(),
                    a.actor.id.as_str().into(),
                    a.role.is_some().into(),
                ])?];
            if a.role == Some(ProjectRole::Member) {
                statements.push(
                    self.db
                        .prepare("UPDATE projects SET lead_id = NULL, lead_name = NULL WHERE id = ?1 AND lead_id = ?2")
                        .bind(&[project.id.as_str().into(), id.as_str().into()])?,
                );
            }
            statements
        };
        self.db.batch(statements).await?;
        Ok(Outcome::Ok(self.members_of(&project.id).await?))
    }

    pub(crate) async fn remove_project_member(&self, a: ProjectMemberArgs) -> Result<Outcome<Vec<ProjectMember>>> {
        let (_, project) = check!(self.changeable_project(&a.actor, &a.workspace, &a.project).await?);
        let name = a.username.trim().trim_start_matches('@').to_lowercase();
        let members = self.members_of(&project.id).await?;
        let Some(member) = members.iter().find(|member| member.username == name) else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{name} is not in the {} project.", project.name)));
        };
        let key = [JsValue::from(project.id.as_str()), JsValue::from(member.user_id.as_str())];
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM project_members WHERE project_id = ?1 AND user_id = ?2").bind(&key)?,
                self.db.prepare("UPDATE projects SET lead_id = NULL, lead_name = NULL WHERE id = ?1 AND lead_id = ?2").bind(&key)?,
            ])
            .await?;
        Ok(Outcome::Ok(self.members_of(&project.id).await?))
    }

    pub(crate) async fn add_project_repo(&self, a: ProjectRepoArgs) -> Result<Outcome<Vec<ProjectRepo>>> {
        let (workspace, project) = check!(self.changeable_project(&a.actor, &a.workspace, &a.project).await?);
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        if !repo.namespace.eq_ignore_ascii_case(&workspace) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{} is not a repository of {workspace}.", path_of(&repo))));
        }
        let known = self.repos_of(&project.id, Some(&a.actor)).await?;
        if known.len() >= MAX_PROJECT_REPOS && !known.iter().any(|linked| linked.repo_id == repo.id) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("A project can name at most {MAX_PROJECT_REPOS} repositories.")));
        }
        self.remember_repo(&repo).await?;
        let default_target = a.default_target.unwrap_or(true);
        self.db
            .prepare(
                "INSERT INTO project_repos (project_id, repo_id, default_target, added_at, added_by) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (project_id, repo_id) DO UPDATE SET default_target = excluded.default_target",
            )
            .bind(&[
                project.id.as_str().into(),
                repo.id.as_str().into(),
                u32::from(default_target).into(),
                rfc3339(now_ms()).into(),
                a.actor.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.repos_of(&project.id, Some(&a.actor)).await?))
    }

    pub(crate) async fn remove_project_repo(&self, a: ProjectRepoArgs) -> Result<Outcome<Vec<ProjectRepo>>> {
        let (_, project) = check!(self.changeable_project(&a.actor, &a.workspace, &a.project).await?);
        let path = format!("{}/{}", a.repo.namespace, a.repo.name).to_lowercase();
        let known = self.repos_of(&project.id, Some(&a.actor)).await?;
        let Some(linked) = known.iter().find(|linked| linked.path.to_lowercase() == path) else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("The {} project does not name {path}.", project.name)));
        };
        self.db
            .prepare("DELETE FROM project_repos WHERE project_id = ?1 AND repo_id = ?2")
            .bind(&[project.id.as_str().into(), linked.repo_id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.repos_of(&project.id, Some(&a.actor)).await?))
    }

    // --- Work items in projects ------------------------------------------------

    /// The project `key` names in `workspace`, as a work item names it:
    /// `Some(None)` for an empty key, which names none. An archived
    /// project takes no new work items.
    pub(crate) async fn project_ref(&self, workspace: &str, key: &str) -> Result<Outcome<Option<WorkProject>>> {
        if key.trim().is_empty() {
            return Ok(Outcome::Ok(None));
        }
        Ok(match self.project_in(workspace, key).await? {
            Some(project) if project.archived_at.is_some() => {
                Outcome::fail(FailureCode::Invalid, format!("The {} project is archived.", project.name))
            }
            Some(project) => Outcome::Ok(Some(project)),
            None => Outcome::fail(FailureCode::Invalid, format!("There is no project {} in {workspace}.", key.trim())),
        })
    }

    /// The paths of the repositories a work item filed into `project_id`
    /// without targets is linked to as targets.
    pub(crate) async fn default_targets(&self, project_id: &str) -> Result<Vec<g1t_contracts::repos::RepoPath>> {
        #[derive(Deserialize)]
        struct Path {
            path: String,
        }
        let rows = self
            .db
            .prepare(
                "SELECT rw.path FROM project_repos r JOIN repo_workspaces rw ON rw.repo_id = r.repo_id
                 WHERE r.project_id = ?1 AND r.default_target = 1 AND rw.deleted_at IS NULL ORDER BY rw.path",
            )
            .bind(&[project_id.into()])?
            .all()
            .await?
            .results::<Path>()?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let (namespace, name) = row.path.split_once('/')?;
                Some(g1t_contracts::repos::RepoPath { namespace: namespace.to_owned(), name: name.to_owned() })
            })
            .collect())
    }

    /// Puts work item `held` in the project `key` names, or with an empty
    /// key in none, and says so in its conversation. Needs the Triage role.
    pub(crate) async fn set_project(&self, actor: &User, held: &Held, key: &str) -> Result<Outcome<()>> {
        let workspace = held.item.workspace.clone();
        if !held.may(Some(actor), Capability::Triage) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
        }
        let after = check!(self.project_ref(&workspace, key).await?).map(|project| project.reference());
        let before = held.item.project.clone();
        if before.as_ref().map(|project| &project.id) == after.as_ref().map(|project| &project.id) {
            return Ok(Outcome::Ok(()));
        }
        self.db
            .prepare("UPDATE work_items SET project_id = ?, updated_at = ? WHERE id = ?")
            .bind(&[
                optional(&after.as_ref().map(|project| project.id.clone())),
                rfc3339(now_ms()).into(),
                held.item.id.as_str().into(),
            ])?
            .run()
            .await?;
        if let Some(text) = project_note(before.as_ref(), after.as_ref()) {
            self.note_item(&held.item.id, actor, &text).await?;
        }
        Ok(Outcome::Ok(()))
    }

    /// The id of the project of `workspace` that `key` names, for a filter:
    /// none when it names none, which matches nothing.
    pub(crate) async fn project_filter(&self, workspace: &str, key: Option<&str>) -> Result<Option<String>> {
        match key.map(str::trim).filter(|key| !key.is_empty()) {
            Some(key) => Ok(Some(self.project_in(workspace, key).await?.map_or_else(|| "none".to_owned(), |project| project.id))),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::migrated::database;

    fn named(id: &str, name: &str) -> ProjectRef {
        ProjectRef { id: id.into(), slug: name.to_lowercase(), name: name.into(), color: "1d76db".into(), icon: None }
    }

    #[test]
    fn moving_between_projects_is_said_once() {
        assert_eq!(project_note(None, Some(&named("prj_1", "Launch"))).as_deref(), Some("added this to the Launch project"));
        assert_eq!(project_note(Some(&named("prj_1", "Launch")), None).as_deref(), Some("removed this from the Launch project"));
        assert_eq!(
            project_note(Some(&named("prj_1", "Launch")), Some(&named("prj_2", "Mobile"))).as_deref(),
            Some("moved this from the Launch project to Mobile")
        );
        assert_eq!(project_note(Some(&named("prj_1", "Launch")), Some(&named("prj_1", "Launch"))), None);
    }

    #[test]
    fn fields_are_checked() {
        assert_eq!(tidy_name("  Work   overhaul ").unwrap(), "Work overhaul");
        assert!(tidy_name(" ").is_err());
        assert!(tidy_name(&"x".repeat(81)).is_err());
        assert_eq!(day(Some(""), "start date"), Ok(Some(None)));
        assert_eq!(day(Some("2026-11-07"), "start date"), Ok(Some(Some("2026-11-07".into()))));
        assert!(day(Some("soon"), "start date").is_err());
        assert_eq!(icon(Some("🚀")), Ok(Some(Some("🚀".into()))));
        assert_eq!(icon(Some(" ")), Ok(Some(None)));
        assert!(bounded(Some(&"x".repeat(201)), MAX_PROJECT_SUMMARY_CHARS, "summary").is_err());
    }

    /// acme with a project and three work items in it (one closed, one in
    /// Now, one in Next) and one outside it.
    fn acme() -> Connection {
        let db = database();
        db.execute_batch(
            "INSERT INTO projects (id, workspace, slug, name, color, created_at, updated_at)
             VALUES ('prj_1', 'acme', 'launch', 'Launch', '1d76db', '', '');
             INSERT INTO project_members (project_id, user_id, username, role, added_at)
             VALUES ('prj_1', 'usr_1', 'ana', 'lead', ''), ('prj_1', 'usr_2', 'bo', 'member', '');
             INSERT INTO milestones (workspace, number, title, description, state, created_at, updated_at)
             VALUES ('acme', 1, 'Beta', '', 'open', '', '');
             INSERT INTO work_items (id, workspace, number, title, body, labels, author_id, author_name, created_at, updated_at,
                                     state, horizon, rank, project_id, milestone)
             VALUES ('wki_1', 'acme', 1, 'One', '', '[]', 'usr_1', 'ana', '', '', 'closed', 'now', 'a', 'prj_1', 1),
                    ('wki_2', 'acme', 2, 'Two', '', '[]', 'usr_1', 'ana', '', '', 'open', 'next', 'a', 'prj_1', 1),
                    ('wki_3', 'acme', 3, 'Three', '', '[]', 'usr_1', 'ana', '', '', 'open', 'now', 'b', 'prj_1', NULL),
                    ('wki_4', 'acme', 4, 'Four', '', '[]', 'usr_1', 'ana', '', '', 'open', 'now', 'a', NULL, 1);",
        )
        .unwrap();
        db
    }

    #[test]
    fn a_project_counts_its_own_work_items_and_people() {
        let db = acme();
        let (open, closed, people): (u32, u32, u32) = db
            .query_row(&format!("SELECT open_items, closed_items, member_count FROM (SELECT {PROJECT_COLUMNS} FROM projects)"), [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!((open, closed, people), (2, 1, 2));
        // Its lead first.
        let mut statement = db.prepare(MEMBERS).unwrap();
        let names: Vec<String> = statement.query_map(["prj_1"], |row| row.get::<_, String>("username")).unwrap().map(Result::unwrap).collect();
        assert_eq!(names, ["ana", "bo"]);
    }

    #[test]
    fn its_open_work_items_come_in_the_plans_order_now_first() {
        let db = acme();
        let sql = OPEN_ITEMS.replace("{ITEM_COLUMNS}", ITEM_COLUMNS).replace("{PLAN_ORDER}", PLAN_ORDER);
        let mut statement = db.prepare(&sql).unwrap();
        let numbers: Vec<u32> = statement.query_map(["prj_1"], |row| row.get::<_, u32>("number")).unwrap().map(Result::unwrap).collect();
        assert_eq!(numbers, [3, 2]);
        // Each names its project.
        let named: String = db
            .query_row(&format!("SELECT project_json FROM (SELECT {ITEM_COLUMNS} FROM work_items WHERE id = 'wki_3')"), [], |row| row.get(0))
            .unwrap();
        let project: ProjectRef = serde_json::from_str(&named).unwrap();
        assert_eq!((project.slug.as_str(), project.icon), ("launch", None));
    }

    #[test]
    fn its_milestones_count_only_its_work_items() {
        let db = acme();
        let (number, open, closed): (u32, u32, u32) = db
            .query_row(MILESTONES, ["acme", "prj_1"], |row| Ok((row.get("number")?, row.get("open_items")?, row.get("closed_items")?)))
            .unwrap();
        // #4 is in Beta too, but not in the project.
        assert_eq!((number, open, closed), (1, 1, 1));
    }

    #[test]
    fn a_renamed_or_deleted_workspace_takes_its_projects() {
        let db = acme();
        for sql in RENAMED {
            db.execute(sql, ["globex", "acme"]).unwrap();
        }
        let workspace: String = db.query_row("SELECT workspace FROM projects", [], |row| row.get(0)).unwrap();
        assert_eq!(workspace, "globex");
        for sql in DELETED {
            db.execute(sql, ["globex"]).unwrap();
        }
        let left: u32 = db.query_row("SELECT count(*) FROM projects", [], |row| row.get(0)).unwrap();
        let members: u32 = db.query_row("SELECT count(*) FROM project_members", [], |row| row.get(0)).unwrap();
        assert_eq!((left, members), (0, 0));
    }

    #[test]
    fn a_purged_account_leads_nothing() {
        let db = acme();
        db.execute("UPDATE projects SET lead_id = 'usr_1', lead_name = 'ana', created_by = 'usr_1'", []).unwrap();
        for sql in user_deleted() {
            db.execute(&sql, ["usr_1"]).unwrap();
        }
        let (lead, created): (Option<String>, String) =
            db.query_row("SELECT lead_name, created_by_name FROM projects", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(lead, None);
        assert_eq!(created, g1t_contracts::account_deletion::GHOST_USERNAME);
        let members: u32 = db.query_row("SELECT count(*) FROM project_members", [], |row| row.get(0)).unwrap();
        assert_eq!(members, 1);
    }
}
