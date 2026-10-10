//! Teams: groups of a workspace's members (see `g1t_contracts::teams`).
//!
//! Kept beside the workspaces they belong to: `teams` and `team_members`,
//! and a team's roles on repositories as rows of `repo_grants` whose
//! principal is the team. Nothing here decides access on a request:
//! [`Identity::grants_of`] (access.rs) folds a person's teams' roles into
//! the grants every resolved user carries.
//!
//! **Who may do what.**
//!
//! | | Who |
//! | --- | --- |
//! | See a visible team | Every member of the workspace |
//! | See a secret team | Its own people and the workspace's owners |
//! | Create a team | Any member, or owners only when the workspace says so (`TeamCreation`); they become its maintainer. Under a parent: an owner, or a maintainer of the parent |
//! | Change a team, its people and settings, or delete it | Owners, and the team's maintainers |
//! | Move a team under another | Owners, or maintainers of both |
//! | Give a team a role on a repository | Admin on the repository |
//! | Take a team's role away | Admin on the repository, owners, and the team's maintainers |
//! | Leave a team | Anyone in it |
//!
//! Changes are for people only, never an agent's or a workspace's token,
//! and need a confirmed email address. Each is published as a `team.*`
//! event and recorded in the workspace's audit log.

use std::collections::{HashMap, HashSet};

use g1t_contracts::access::{RepoRef, RepoRole, granted};
use g1t_contracts::audit::Surface;
use g1t_contracts::codeowners::{Owner, OwnerCheck};
use g1t_contracts::events::TeamChanged;
use g1t_contracts::identity::AGENT_NAME;
use g1t_contracts::teams::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::access::Named;

const PEOPLE_ONLY: &str = "Only a person can change a team, signed in as themselves; never an agent's or a workspace's token.";
const CONFIRM_FIRST: &str = "Confirm your email address before changing a team.";
const NOT_FOUND: &str = "Team not found.";
const OWNERS_CREATE: &str = "Only owners can create teams in this workspace. Ask an owner to create one, or to let members create them in the workspace's settings.";

/// A [`TeamCreation`] as the audit log says it.
fn creation_words(setting: TeamCreation) -> &'static str {
    match setting {
        TeamCreation::Members => "any member",
        TeamCreation::Owners => "owners only",
    }
}
const NO_SUCH_USER: &str = "There is no account with that username.";
const LIST_LIMIT: u32 = 500;

fn opt(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

/// A team's row, with what lists show of it and the viewer's place in it.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct TeamRow {
    pub id: String,
    pub workspace_id: String,
    pub workspace: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub visibility: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub parent_slug: Option<String>,
    #[serde(default)]
    pub parent_name: Option<String>,
    pub notify: u8,
    #[serde(default)]
    pub review_assignment: Option<String>,
    pub members_count: u32,
    pub repos_count: u32,
    pub child_teams_count: u32,
    #[serde(default)]
    pub agents_count: u32,
    /// The viewer's role in it, if they are in it.
    #[serde(default)]
    pub viewer_role: Option<String>,
    /// Its lead: `user` or `agent`, and the id; for a person, who they are.
    #[serde(default)]
    pub lead_kind: Option<String>,
    #[serde(default)]
    pub lead_id: Option<String>,
    #[serde(default)]
    pub lead_username: Option<String>,
    #[serde(default)]
    pub lead_name: Option<String>,
    #[serde(default)]
    pub lead_avatar: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub channel_name: Option<String>,
    /// D1 hands numbers over as doubles.
    #[serde(default)]
    pub budget_micros: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

/// A team's lead from its columns: a person still on record, or an agent.
pub(crate) fn lead_of(
    kind: Option<&str>,
    id: Option<&str>,
    username: Option<&str>,
    name: Option<&str>,
    avatar: Option<&str>,
) -> Option<TeamLead> {
    match (kind?, id?) {
        ("agent", id) => Some(TeamLead::Agent { agent_id: id.to_owned() }),
        ("user", _) => Some(TeamLead::User {
            username: username?.to_owned(),
            name: name.map(str::to_owned),
            avatar: avatar.map(str::to_owned),
        }),
        _ => None,
    }
}

/// A channel from its columns, when it has both.
pub(crate) fn channel_of(id: Option<&str>, name: Option<&str>) -> Option<TeamChannel> {
    match (id, name) {
        (Some(id), Some(name)) if !id.is_empty() => Some(TeamChannel {
            id: id.to_owned(),
            name: name.to_owned(),
        }),
        _ => None,
    }
}

/// A stored budget: a whole positive number of micros, or none.
pub(crate) fn budget_of(micros: Option<f64>) -> Option<i64> {
    micros.filter(|m| m.is_finite() && *m > 0.0).map(|m| m as i64)
}

/// The most a team budget may be: a million dollars a month.
pub const MAX_TEAM_BUDGET_MICROS: i64 = 1_000_000 * 1_000_000;

impl TeamRow {
    pub fn visibility(&self) -> TeamVisibility {
        TeamVisibility::parse(&self.visibility).unwrap_or_default()
    }

    pub fn review(&self) -> ReviewAssignment {
        self.review_assignment
            .as_deref()
            .and_then(|json| serde_json::from_str::<ReviewAssignment>(json).ok())
            .unwrap_or_default()
    }

    fn viewer_role(&self) -> Option<TeamRole> {
        self.viewer_role.as_deref().and_then(TeamRole::parse)
    }

    pub(crate) fn lead(&self) -> Option<TeamLead> {
        lead_of(
            self.lead_kind.as_deref(),
            self.lead_id.as_deref(),
            self.lead_username.as_deref(),
            self.lead_name.as_deref(),
            self.lead_avatar.as_deref(),
        )
    }

    fn shown(&self, owner: bool) -> Team {
        let viewer_role = self.viewer_role();
        Team {
            id: self.id.clone(),
            workspace: self.workspace.clone(),
            slug: self.slug.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            visibility: self.visibility(),
            parent: match (&self.parent_slug, &self.parent_name) {
                (Some(slug), Some(name)) => Some(TeamRef {
                    slug: slug.clone(),
                    name: name.clone(),
                }),
                _ => None,
            },
            notify: self.notify != 0,
            review_assignment: self.review(),
            members_count: self.members_count,
            repos_count: self.repos_count,
            child_teams_count: self.child_teams_count,
            agents_count: self.agents_count,
            lead: self.lead(),
            channel: channel_of(self.channel_id.as_deref(), self.channel_name.as_deref()),
            budget_micros: budget_of(self.budget_micros),
            viewer_role,
            can_manage: may_manage(owner, viewer_role),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn event(&self) -> TeamChanged {
        TeamChanged {
            workspace: self.workspace.clone(),
            team_id: self.id.clone(),
            team: self.slug.clone(),
            name: self.name.clone(),
            visibility: Some(self.visibility()),
            parent: self.parent_slug.clone(),
            ..TeamChanged::default()
        }
    }
}

/// Every column of [`TeamRow`]; binds the viewer's id as `?1`.
const TEAM_COLUMNS: &str = "t.id, t.workspace_id, w.slug AS workspace, t.slug, t.name, t.description, t.visibility,
  t.parent_id, p.slug AS parent_slug, p.name AS parent_name, t.notify, t.review_assignment,
  (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS members_count,
  (SELECT count(*) FROM repo_grants g WHERE g.principal_kind = 'team' AND g.principal_id = t.id) AS repos_count,
  (SELECT count(*) FROM teams c WHERE c.parent_id = t.id) AS child_teams_count,
  (SELECT role FROM team_members me WHERE me.team_id = t.id AND me.user_id = ?1) AS viewer_role,
  (SELECT count(*) FROM team_agents ta WHERE ta.team_id = t.id) AS agents_count,
  t.lead_kind, t.lead_id, lu.username AS lead_username, lu.display_name AS lead_name, lu.avatar AS lead_avatar,
  t.channel_id, t.channel_name, t.budget_micros,
  t.created_at, t.updated_at
  FROM teams t
  JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
  LEFT JOIN teams p ON p.id = t.parent_id
  LEFT JOIN users lu ON t.lead_kind = 'user' AND lu.id = t.lead_id AND lu.deleted_at IS NULL";

// --- The rules, apart from the database ---------------------------------------

/// Whether someone sees a team: everyone in the workspace sees a visible
/// one; a secret one, its own people and the owners.
pub fn may_see(visibility: TeamVisibility, owner: bool, in_team: bool) -> bool {
    match visibility {
        TeamVisibility::Visible => true,
        TeamVisibility::Secret => owner || in_team,
    }
}

/// Whether someone may change a team: owners, and its maintainers.
pub fn may_manage(owner: bool, role: Option<TeamRole>) -> bool {
    owner || role == Some(TeamRole::Maintainer)
}

/// Why a team cannot go under `parent`, or `None` if it can. `chain` is
/// the parent and its ancestors, nearest first; `below` how many levels
/// of teams sit under the team (0 for none).
pub fn nesting_problem(
    team_id: &str,
    team_visibility: TeamVisibility,
    parent_id: &str,
    parent_visibility: TeamVisibility,
    chain: &[String],
    below: usize,
) -> Option<&'static str> {
    if team_id == parent_id || chain.iter().any(|id| id == team_id) {
        return Some("A team cannot go under itself or one of its own child teams.");
    }
    if team_visibility == TeamVisibility::Secret || parent_visibility == TeamVisibility::Secret {
        return Some("Secret teams cannot be nested. Make both teams visible first.");
    }
    // The parent's chain, this team, and what is under it.
    if chain.len() + 1 + below > MAX_DEPTH {
        return Some("Teams can nest at most 8 levels deep.");
    }
    None
}

/// The workspace role the viewer has, counting g1t acting in it, and a
/// workspace's own token an owner gave Admin, as owners. Any other
/// workspace token is a member.
pub(crate) fn role_of(viewer: &User, workspace: &str) -> Option<Role> {
    if matches!(viewer.kind, PrincipalKind::Workspace | PrincipalKind::System) && viewer.is_member(workspace) {
        if viewer.kind == PrincipalKind::Workspace && viewer.token.as_deref().is_some_and(|token| !token.admin) {
            return Some(Role::Member);
        }
        return Some(Role::Owner);
    }
    viewer.role_in(workspace)
}

/// One person, as a team lists them.
#[derive(Deserialize)]
struct MemberRow {
    id: String,
    username: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    role: String,
    /// The team they are in directly.
    team_id: String,
    team_slug: String,
}

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

#[derive(Deserialize)]
struct RoleRow {
    role: String,
}

impl Identity {
    pub(crate) async fn team_rows(&self, filter: &str, binds: &[JsValue]) -> Result<Vec<TeamRow>> {
        self.db
            .prepare(format!("SELECT {TEAM_COLUMNS} {filter} LIMIT {LIST_LIMIT}"))
            .bind(binds)?
            .all()
            .await?
            .results::<TeamRow>()
    }

    /// One team of a workspace by slug, with the viewer's place in it.
    pub(crate) async fn team_row(&self, workspace: &str, slug: &str, viewer_id: Option<&str>) -> Result<Option<TeamRow>> {
        Ok(self
            .team_rows(
                "WHERE w.slug = ?2 AND t.slug = ?3",
                &[opt(viewer_id), workspace.to_lowercase().into(), slug.trim().trim_start_matches('@').to_lowercase().into()],
            )
            .await?
            .into_iter()
            .next())
    }

    /// The team, if `viewer` may see it: a member of its workspace, and
    /// for a secret team, in it or an owner. Missing otherwise.
    async fn seen_team(&self, viewer: &Viewer, workspace: &str, slug: &str) -> Result<Outcome<(TeamRow, bool)>> {
        let workspace = workspace.trim().to_lowercase();
        let Some(viewer) = viewer.as_ref() else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        let Some(role) = role_of(viewer, &workspace) else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        let owner = role == Role::Owner;
        let Some(row) = self.team_row(&workspace, slug, Some(&viewer.id)).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        if !may_see(row.visibility(), owner, row.viewer_role.is_some()) {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        }
        Ok(Outcome::Ok((row, owner)))
    }

    /// The team, if `actor` may change it.
    async fn managed_team(&self, actor: &User, workspace: &str, slug: &str) -> Result<Outcome<(TeamRow, bool)>> {
        if !crate::security::is_person(actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let (row, owner) = match self.seen_team(&Some(actor.clone()), workspace, slug).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !may_manage(owner, row.viewer_role()) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("Only owners of {} and maintainers of {} can change it.", row.workspace, row.name),
            ));
        }
        if !actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, CONFIRM_FIRST));
        }
        Ok(Outcome::Ok((row, owner)))
    }

    pub async fn list_teams(&self, a: ListTeamsArgs) -> Result<Outcome<Vec<Team>>> {
        let workspace = a.workspace.trim().to_lowercase();
        let Some(role) = a.viewer.as_ref().and_then(|viewer| role_of(viewer, &workspace)) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can see a workspace's teams."));
        };
        let owner = role == Role::Owner;
        let viewer_id = a.viewer.as_ref().map(|viewer| viewer.id.as_str());
        let query = a.query.as_deref().map(str::trim).filter(|query| !query.is_empty());
        let rows = match query {
            Some(query) => {
                let like = format!("%{}%", query.to_lowercase().replace(['%', '_'], ""));
                self.team_rows(
                    "WHERE w.slug = ?2 AND (lower(t.name) LIKE ?3 OR t.slug LIKE ?3)
                     ORDER BY viewer_role IS NULL, lower(t.name)",
                    &[opt(viewer_id), workspace.as_str().into(), like.into()],
                )
                .await?
            }
            None => {
                self.team_rows(
                    "WHERE w.slug = ?2 ORDER BY viewer_role IS NULL, lower(t.name)",
                    &[opt(viewer_id), workspace.as_str().into()],
                )
                .await?
            }
        };
        Ok(Outcome::Ok(
            rows.iter()
                .filter(|row| may_see(row.visibility(), owner, row.viewer_role.is_some()))
                .map(|row| row.shown(owner))
                .collect(),
        ))
    }

    pub async fn get_team(&self, a: TeamArgs) -> Result<Outcome<Team>> {
        Ok(match self.seen_team(&a.viewer, &a.workspace, &a.team).await? {
            Outcome::Ok((row, owner)) => Outcome::Ok(row.shown(owner)),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    pub async fn child_teams(&self, a: TeamArgs) -> Result<Outcome<Vec<Team>>> {
        let (row, owner) = match self.seen_team(&a.viewer, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let viewer_id = a.viewer.as_ref().map(|viewer| viewer.id.as_str());
        let rows = self
            .team_rows("WHERE t.parent_id = ?2 ORDER BY lower(t.name)", &[opt(viewer_id), row.id.as_str().into()])
            .await?;
        Ok(Outcome::Ok(
            rows.iter()
                .filter(|row| may_see(row.visibility(), owner, row.viewer_role.is_some()))
                .map(|row| row.shown(owner))
                .collect(),
        ))
    }

    pub async fn user_teams(&self, a: UserTeamsArgs) -> Result<Outcome<Vec<Team>>> {
        let workspace = a.workspace.trim().to_lowercase();
        let Some(role) = a.viewer.as_ref().and_then(|viewer| role_of(viewer, &workspace)) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can see a workspace's teams."));
        };
        let owner = role == Role::Owner;
        let viewer_id = a.viewer.as_ref().map(|viewer| viewer.id.as_str());
        let rows = self
            .team_rows(
                "WHERE w.slug = ?2 AND t.id IN (
                   SELECT tm.team_id FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE u.username = ?3
                 ) ORDER BY lower(t.name)",
                &[opt(viewer_id), workspace.as_str().into(), a.username.trim().trim_start_matches('@').to_lowercase().into()],
            )
            .await?;
        Ok(Outcome::Ok(
            rows.iter()
                .filter(|row| may_see(row.visibility(), owner, row.viewer_role.is_some()))
                .map(|row| row.shown(owner))
                .collect(),
        ))
    }

    /// The parent and its ancestors, nearest first, by id.
    async fn chain_of(&self, team_id: &str) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare(
                "WITH RECURSIVE up(id, depth) AS (
                   SELECT ?1, 0
                   UNION ALL
                   SELECT t.parent_id, up.depth + 1 FROM teams t JOIN up ON t.id = up.id
                   WHERE t.parent_id IS NOT NULL AND up.depth < 20
                 )
                 SELECT id FROM up ORDER BY depth",
            )
            .bind(&[team_id.into()])?
            .all()
            .await?
            .results::<IdRow>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    /// How many levels of teams sit under a team.
    async fn depth_below(&self, team_id: &str) -> Result<usize> {
        #[derive(Deserialize)]
        struct Depth {
            depth: Option<u32>,
        }
        let row = self
            .db
            .prepare(
                "WITH RECURSIVE down(id, depth) AS (
                   SELECT ?1, 0
                   UNION ALL
                   SELECT t.id, down.depth + 1 FROM teams t JOIN down ON t.parent_id = down.id WHERE down.depth < 20
                 )
                 SELECT max(depth) AS depth FROM down",
            )
            .bind(&[team_id.into()])?
            .first::<Depth>(None)
            .await?;
        Ok(row.and_then(|row| row.depth).unwrap_or(0) as usize)
    }

    /// Whether `parent` can take `row` (or a new team, with `row` None)
    /// under it, as `actor`: the parent exists, the actor may manage it,
    /// and the nesting is allowed. Returns the parent.
    async fn parent_for(
        &self,
        actor: &User,
        owner: bool,
        workspace: &str,
        parent: &str,
        team: Option<(&str, TeamVisibility)>,
        visibility: TeamVisibility,
    ) -> Result<Outcome<TeamRow>> {
        let Some(parent) = self.team_row(workspace, parent, Some(&actor.id)).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no team with that slug to go under."));
        };
        if !may_see(parent.visibility(), owner, parent.viewer_role.is_some()) {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no team with that slug to go under."));
        }
        if !may_manage(owner, parent.viewer_role()) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("Only owners and maintainers of {} can put a team under it.", parent.name),
            ));
        }
        let chain = self.chain_of(&parent.id).await?;
        let (team_id, below) = match team {
            Some((id, _)) => (id.to_owned(), self.depth_below(id).await?),
            None => (String::new(), 0),
        };
        let team_visibility = team.map_or(visibility, |(_, _)| visibility);
        if let Some(why) = nesting_problem(&team_id, team_visibility, &parent.id, parent.visibility(), &chain[..], below) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        Ok(Outcome::Ok(parent))
    }

    /// Who may create a workspace's teams; the default when there is no
    /// such workspace.
    pub(crate) async fn team_creation_of(&self, slug: &str) -> Result<TeamCreation> {
        #[derive(Deserialize)]
        struct Row {
            #[serde(default)]
            team_creation: Option<String>,
        }
        let row = self
            .db
            .prepare("SELECT team_creation FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[slug.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row
            .and_then(|row| row.team_creation)
            .as_deref()
            .and_then(TeamCreation::parse)
            .unwrap_or_default())
    }

    /// `set_team_creation`: who may create the workspace's teams. Owners
    /// only, as a person with a confirmed email address. Teams already made
    /// stay as they are.
    pub async fn set_team_creation(&self, a: SetTeamCreationArgs) -> Result<Outcome<TeamCreation>> {
        let slug = a.slug.trim().to_lowercase();
        if !crate::security::is_person(&a.actor) || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can change who may create teams."));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address before changing the workspace's settings."));
        }
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let previous = self.team_creation_of(&slug).await?;
        if previous == a.team_creation {
            return Ok(Outcome::Ok(previous));
        }
        let stored = match a.team_creation {
            TeamCreation::Members => JsValue::NULL,
            other => other.as_str().into(),
        };
        self.db
            .prepare("UPDATE workspaces SET team_creation = ? WHERE id = ?")
            .bind(&[stored, workspace_id.as_str().into()])?
            .run()
            .await?;
        self.audit_workspace(
            &a.actor,
            "workspace.team_creation_changed",
            &slug,
            a.surface.unwrap_or(Surface::Web),
            format!(
                "Changed who may create teams from {} to {}",
                creation_words(previous),
                creation_words(a.team_creation)
            ),
        )
        .await;
        // Members' resolved users carry the setting, for the site's menus.
        self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        Ok(Outcome::Ok(a.team_creation))
    }

    pub async fn create_team(&self, a: CreateTeamArgs) -> Result<Outcome<Team>> {
        let workspace = a.workspace.trim().to_lowercase();
        if !crate::security::is_person(&a.actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let Some(role) = a.actor.role_in(&workspace) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members of a workspace can create its teams."));
        };
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, CONFIRM_FIRST));
        }
        // A workspace can keep creating teams to its owners.
        if !self.team_creation_of(&workspace).await?.allows(role) {
            return Ok(Outcome::fail(FailureCode::Forbidden, OWNERS_CREATE));
        }
        let owner = role == Role::Owner;
        let name: String = a.name.trim().chars().take(MAX_NAME_LENGTH).collect();
        if name.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give the team a name."));
        }
        let slug = match a.slug.as_deref().map(str::trim).filter(|slug| !slug.is_empty()) {
            Some(slug) if is_valid_slug(&slug.to_lowercase()) => slug.to_lowercase(),
            Some(_) => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "Team slugs use lowercase letters, digits and single hyphens, up to 60 characters.",
                ));
            }
            None => match slug_of(&name) {
                Some(slug) => slug,
                None => return Ok(Outcome::fail(FailureCode::Invalid, "Use letters or digits in the team's name.")),
            },
        };
        let Some(workspace_id) = self.workspace_id_of(&workspace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        if self.team_row(&workspace, &slug, None).await?.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{workspace} already has a team called @{workspace}/{slug}.")));
        }
        #[derive(Deserialize)]
        struct Count {
            n: u32,
        }
        let count = self
            .db
            .prepare("SELECT count(*) AS n FROM teams WHERE workspace_id = ?")
            .bind(&[workspace_id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |row| row.n);
        if count >= MAX_TEAMS {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("A workspace can have at most {MAX_TEAMS} teams.")));
        }
        let visibility = a.visibility.unwrap_or_default();
        let parent = match a.parent.as_deref().map(str::trim).filter(|parent| !parent.is_empty()) {
            Some(parent) => match self.parent_for(&a.actor, owner, &workspace, parent, None, visibility).await? {
                Outcome::Ok(parent) => Some(parent),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => None,
        };
        // The people to add first: members of the workspace only.
        let mut people: Vec<(String, String)> = Vec::new();
        for username in &a.members {
            let Some((id, name)) = self.person_by_username(username).await? else {
                return Ok(Outcome::fail(FailureCode::NotFound, format!("There is no account named {}.", username.trim())));
            };
            if !self.is_member_of(&workspace_id, &id).await? {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("{name} is not a member of {workspace}. Add them to the workspace first."),
                ));
            }
            if id != a.actor.id && !people.iter().any(|(had, _)| *had == id) {
                people.push((id, name));
            }
        }
        let now = now_ms();
        let id = new_id("team", now);
        let at = rfc3339(now);
        let description = a
            .description
            .as_deref()
            .map(|text| text.trim().chars().take(MAX_DESCRIPTION_LENGTH).collect::<String>())
            .filter(|text| !text.is_empty());
        let mut statements = vec![
            self.db
                .prepare(
                    "INSERT INTO teams (id, workspace_id, slug, name, description, visibility, parent_id, notify, review_assignment, created_by, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                )
                .bind(&[
                    id.as_str().into(),
                    workspace_id.as_str().into(),
                    slug.as_str().into(),
                    name.as_str().into(),
                    opt(description.as_deref()),
                    visibility.as_str().into(),
                    opt(parent.as_ref().map(|parent| parent.id.as_str())),
                    u8::from(a.notify.unwrap_or(true)).into(),
                    serde_json::to_string(&ReviewAssignment::default())?.into(),
                    a.actor.id.as_str().into(),
                    at.as_str().into(),
                ])?,
            // Whoever creates it maintains it.
            self.db
                .prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'maintainer', ?)")
                .bind(&[id.as_str().into(), a.actor.id.as_str().into(), at.as_str().into()])?,
        ];
        for (user_id, _) in &people {
            statements.push(
                self.db
                    .prepare("INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
                    .bind(&[id.as_str().into(), user_id.as_str().into(), at.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
        let Some(row) = self.team_row(&workspace, &slug, Some(&a.actor.id)).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        let surface = a.surface.unwrap_or(Surface::Web);
        self.team_event("team.created", &a.actor, row.event(), surface, format!("Created the team {}", row.name))
            .await;
        for (username, role) in std::iter::once((a.actor.username.clone(), TeamRole::Maintainer))
            .chain(people.into_iter().map(|(_, name)| (name, TeamRole::Member)))
        {
            self.team_event(
                "team.member_added",
                &a.actor,
                TeamChanged {
                    username: Some(username.clone()),
                    role: Some(role),
                    ..row.event()
                },
                surface,
                format!("Added {username} to {} as a {}", row.name, role.as_str()),
            )
            .await;
        }
        Ok(Outcome::Ok(row.shown(owner)))
    }

    pub async fn update_team(&self, a: UpdateTeamArgs) -> Result<Outcome<Team>> {
        let (row, owner) = match self.managed_team(&a.actor, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let mut changes: Vec<&'static str> = Vec::new();
        let mut sets: Vec<String> = Vec::new();
        let mut binds: Vec<JsValue> = Vec::new();
        let mut set = |column: &str, value: JsValue, binds: &mut Vec<JsValue>| {
            binds.push(value);
            sets.push(format!("{column} = ?{}", binds.len()));
        };
        if let Some(name) = &a.name {
            let name: String = name.trim().chars().take(MAX_NAME_LENGTH).collect();
            if name.is_empty() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the team a name."));
            }
            if name != row.name {
                set("name", name.into(), &mut binds);
                changes.push("name");
            }
        }
        let mut slug = row.slug.clone();
        if let Some(wanted) = a.slug.as_deref().map(|slug| slug.trim().to_lowercase()).filter(|slug| *slug != row.slug) {
            if !is_valid_slug(&wanted) {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "Team slugs use lowercase letters, digits and single hyphens, up to 60 characters.",
                ));
            }
            if self.team_row(&row.workspace, &wanted, None).await?.is_some() {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("{0} already has a team called @{0}/{wanted}.", row.workspace),
                ));
            }
            set("slug", wanted.as_str().into(), &mut binds);
            changes.push("slug");
            slug = wanted;
        }
        if let Some(description) = &a.description {
            let description: String = description.trim().chars().take(MAX_DESCRIPTION_LENGTH).collect();
            if Some(&description) != row.description.as_ref() {
                set(
                    "description",
                    if description.is_empty() { JsValue::NULL } else { description.into() },
                    &mut binds,
                );
                changes.push("description");
            }
        }
        let visibility = a.visibility.unwrap_or(row.visibility());
        let parent_slug = a.parent.as_deref().map(str::trim);
        let parent_changes = parent_slug.is_some_and(|parent| Some(parent.to_lowercase()) != row.parent_slug);
        if visibility != row.visibility() {
            if visibility == TeamVisibility::Secret {
                let has_parent = if parent_changes { parent_slug.is_some_and(|parent| !parent.is_empty()) } else { row.parent_id.is_some() };
                if has_parent || row.child_teams_count > 0 {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        "Secret teams cannot be nested. Take it out from under its parent and move its child teams first.",
                    ));
                }
            }
            set("visibility", visibility.as_str().into(), &mut binds);
            changes.push("visibility");
        }
        if parent_changes {
            match parent_slug.filter(|parent| !parent.is_empty()) {
                Some(parent) => {
                    let parent = match self
                        .parent_for(&a.actor, owner, &row.workspace, parent, Some((&row.id, visibility)), visibility)
                        .await?
                    {
                        Outcome::Ok(parent) => parent,
                        Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                    };
                    set("parent_id", parent.id.as_str().into(), &mut binds);
                }
                None => set("parent_id", JsValue::NULL, &mut binds),
            }
            changes.push("parent");
        }
        if let Some(notify) = a.notify
            && notify != (row.notify != 0)
        {
            set("notify", u8::from(notify).into(), &mut binds);
            changes.push("notify");
        }
        if let Some(review) = a.review_assignment {
            let review = review.bounded();
            if review != row.review() {
                set("review_assignment", serde_json::to_string(&review)?.into(), &mut binds);
                changes.push("review_assignment");
            }
        }
        if let Some(lead) = a.lead.as_deref().map(str::trim) {
            let (kind, id): (JsValue, JsValue) = if lead.is_empty() {
                (JsValue::NULL, JsValue::NULL)
            } else {
                match parse_lead(lead) {
                    Some(LeadInput::User(username)) => {
                        let Some((user_id, username)) = self.person_by_username(&username).await? else {
                            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
                        };
                        if self.team_role_of(&row.id, &user_id).await?.is_none() {
                            return Ok(Outcome::fail(
                                FailureCode::Invalid,
                                format!("{username} is not on {}. Add them to the team first.", row.name),
                            ));
                        }
                        ("user".into(), user_id.into())
                    }
                    Some(LeadInput::Agent(agent_id)) => {
                        if !self.has_team_agent(&row.id, &agent_id).await? {
                            return Ok(Outcome::fail(
                                FailureCode::Invalid,
                                format!("That agent is not on {}. Add it to the team first.", row.name),
                            ));
                        }
                        ("agent".into(), agent_id.into())
                    }
                    None => return Ok(Outcome::fail(FailureCode::Invalid, "Name the lead as @username, or agent:<id> for an agent.")),
                }
            };
            let same = kind.as_string() == row.lead_kind && id.as_string() == row.lead_id;
            if !same {
                set("lead_kind", kind, &mut binds);
                set("lead_id", id, &mut binds);
                changes.push("lead");
            }
        }
        if let Some(channel_id) = a.channel_id.as_deref().map(str::trim) {
            let name = a
                .channel_name
                .as_deref()
                .map(|name| name.trim().trim_start_matches('#').chars().take(80).collect::<String>())
                .unwrap_or_default();
            if !channel_id.is_empty() && name.is_empty() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the channel's name with its id."));
            }
            if Some(channel_id) != row.channel_id.as_deref() || (!channel_id.is_empty() && Some(name.as_str()) != row.channel_name.as_deref()) {
                if channel_id.is_empty() {
                    set("channel_id", JsValue::NULL, &mut binds);
                    set("channel_name", JsValue::NULL, &mut binds);
                } else {
                    set("channel_id", channel_id.into(), &mut binds);
                    set("channel_name", name.into(), &mut binds);
                }
                changes.push("channel");
            }
        }
        if let Some(budget) = a.budget_micros {
            if budget > MAX_TEAM_BUDGET_MICROS {
                return Ok(Outcome::fail(FailureCode::Invalid, "A team budget can be at most $1,000,000 a month."));
            }
            let budget = (budget > 0).then_some(budget);
            if budget != budget_of(row.budget_micros) {
                set("budget_micros", budget.map_or(JsValue::NULL, |m| JsValue::from_f64(m as f64)), &mut binds);
                changes.push("budget");
            }
        }
        if !changes.is_empty() {
            set("updated_at", rfc3339(now_ms()).into(), &mut binds);
            binds.push(row.id.as_str().into());
            self.db
                .prepare(format!("UPDATE teams SET {} WHERE id = ?{}", sets.join(", "), binds.len()))
                .bind(&binds)?
                .run()
                .await?;
        }
        let Some(updated) = self.team_row(&row.workspace, &slug, Some(&a.actor.id)).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        if !changes.is_empty() {
            self.team_event(
                "team.edited",
                &a.actor,
                TeamChanged {
                    changes: changes.iter().map(|change| (*change).to_owned()).collect(),
                    ..updated.event()
                },
                a.surface.unwrap_or(Surface::Web),
                format!("Changed the team {}: {}", updated.name, changes.join(", ").replace('_', " ")),
            )
            .await;
        }
        Ok(Outcome::Ok(updated.shown(owner)))
    }

    pub async fn delete_team(&self, a: DeleteTeamArgs) -> Result<Outcome<bool>> {
        let (row, _) = match self.managed_team(&a.actor, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let id = JsValue::from(row.id.as_str());
        self.db
            .batch(vec![
                // Its child teams move up to its parent.
                self.db
                    .prepare("UPDATE teams SET parent_id = ?1 WHERE parent_id = ?2")
                    .bind(&[opt(row.parent_id.as_deref()), id.clone()])?,
                self.db.prepare("DELETE FROM team_members WHERE team_id = ?").bind(std::slice::from_ref(&id))?,
                self.db.prepare("DELETE FROM team_agents WHERE team_id = ?").bind(std::slice::from_ref(&id))?,
                self.db
                    .prepare("DELETE FROM repo_grants WHERE principal_kind = 'team' AND principal_id = ?")
                    .bind(std::slice::from_ref(&id))?,
                self.db.prepare("DELETE FROM teams WHERE id = ?").bind(&[id])?,
            ])
            .await?;
        self.team_event(
            "team.deleted",
            &a.actor,
            row.event(),
            a.surface.unwrap_or(Surface::Web),
            format!("Deleted the team {}", row.name),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// The people of a team, its own first; with `children`, also the
    /// people of its child teams who are not its own, each with the child
    /// team they are in.
    async fn member_rows(&self, team_id: &str, children: bool) -> Result<Vec<MemberRow>> {
        let reach = if children {
            "WITH RECURSIVE down(id) AS (SELECT ?1 UNION SELECT t.id FROM teams t JOIN down ON t.parent_id = down.id)"
        } else {
            "WITH down(id) AS (SELECT ?1)"
        };
        self.db
            .prepare(format!(
                "{reach}
                 SELECT u.id, u.username, u.display_name AS name, u.avatar, tm.role, tm.team_id, t.slug AS team_slug
                 FROM down JOIN team_members tm ON tm.team_id = down.id
                 JOIN teams t ON t.id = tm.team_id
                 JOIN users u ON u.id = tm.user_id
                 ORDER BY tm.team_id != ?1, u.username, t.slug LIMIT 2000"
            ))
            .bind(&[team_id.into()])?
            .all()
            .await?
            .results::<MemberRow>()
    }

    pub async fn team_members(&self, a: TeamArgs) -> Result<Outcome<Vec<TeamMember>>> {
        let (row, _) = match self.seen_team(&a.viewer, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let mut seen: HashSet<String> = HashSet::new();
        let mut members: Vec<TeamMember> = Vec::new();
        for person in self.member_rows(&row.id, a.include_child_teams).await? {
            if !seen.insert(person.id.clone()) {
                continue;
            }
            let own = person.team_id == row.id;
            members.push(TeamMember {
                username: person.username,
                name: person.name,
                avatar: person.avatar,
                role: if own { TeamRole::parse(&person.role).unwrap_or(TeamRole::Member) } else { TeamRole::Member },
                via: (!own).then_some(person.team_slug),
            });
        }
        // Maintainers first, then by name; child teams' people after.
        members.sort_by(|a, b| {
            a.via
                .is_some()
                .cmp(&b.via.is_some())
                .then_with(|| b.role.cmp(&a.role))
                .then_with(|| a.username.cmp(&b.username))
        });
        Ok(Outcome::Ok(members))
    }

    async fn team_role_of(&self, team_id: &str, user_id: &str) -> Result<Option<TeamRole>> {
        Ok(self
            .db
            .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
            .bind(&[team_id.into(), user_id.into()])?
            .first::<RoleRow>(None)
            .await?
            .and_then(|row| TeamRole::parse(&row.role)))
    }

    pub async fn set_team_member(&self, a: SetTeamMemberArgs) -> Result<Outcome<TeamMember>> {
        let (row, _) = match self.managed_team(&a.actor, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some((user_id, username)) = self.person_by_username(&a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
        };
        if !self.is_member_of(&row.workspace_id, &user_id).await? {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("{username} is not a member of {}. Add them to the workspace first.", row.workspace),
            ));
        }
        let previous = self.team_role_of(&row.id, &user_id).await?;
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role",
            )
            .bind(&[row.id.as_str().into(), user_id.as_str().into(), a.role.as_str().into(), now.as_str().into()])?
            .run()
            .await?;
        let surface = a.surface.unwrap_or(Surface::Web);
        match previous {
            None => {
                self.team_event(
                    "team.member_added",
                    &a.actor,
                    TeamChanged {
                        username: Some(username.clone()),
                        role: Some(a.role),
                        ..row.event()
                    },
                    surface,
                    format!("Added {username} to {} as a {}", row.name, a.role.as_str()),
                )
                .await;
            }
            Some(previous) if previous != a.role => {
                self.team_event(
                    "team.member_role_changed",
                    &a.actor,
                    TeamChanged {
                        username: Some(username.clone()),
                        role: Some(a.role),
                        previous_role: Some(previous),
                        ..row.event()
                    },
                    surface,
                    format!("Made {username} a {} of {}", a.role.as_str(), row.name),
                )
                .await;
            }
            Some(_) => {}
        }
        #[derive(Deserialize)]
        struct Person {
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            avatar: Option<String>,
        }
        let person = self
            .db
            .prepare("SELECT display_name AS name, avatar FROM users WHERE id = ?")
            .bind(&[user_id.as_str().into()])?
            .first::<Person>(None)
            .await?;
        Ok(Outcome::Ok(TeamMember {
            username,
            name: person.as_ref().and_then(|person| person.name.clone()),
            avatar: person.and_then(|person| person.avatar),
            role: a.role,
            via: None,
        }))
    }

    pub async fn remove_team_member(&self, a: RemoveTeamMemberArgs) -> Result<Outcome<bool>> {
        let Some((user_id, username)) = self.person_by_username(&a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
        };
        // Anyone may leave a team; otherwise, owners and maintainers.
        let leaving = crate::security::is_person(&a.actor) && a.actor.id == user_id;
        let row = if leaving {
            match self.seen_team(&Some(a.actor.clone()), &a.workspace, &a.team).await? {
                Outcome::Ok((row, _)) => row,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            }
        } else {
            match self.managed_team(&a.actor, &a.workspace, &a.team).await? {
                Outcome::Ok((row, _)) => row,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            }
        };
        let Some(previous) = self.team_role_of(&row.id, &user_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{username} is not in {}.", row.name)));
        };
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
                    .bind(&[row.id.as_str().into(), user_id.as_str().into()])?,
                // Someone off the team no longer leads it.
                self.db
                    .prepare("UPDATE teams SET lead_kind = NULL, lead_id = NULL WHERE id = ? AND lead_kind = 'user' AND lead_id = ?")
                    .bind(&[row.id.as_str().into(), user_id.as_str().into()])?,
            ])
            .await?;
        self.team_event(
            "team.member_removed",
            &a.actor,
            TeamChanged {
                username: Some(username.clone()),
                previous_role: Some(previous),
                ..row.event()
            },
            a.surface.unwrap_or(Surface::Web),
            format!("Removed {username} from {}", row.name),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    pub async fn team_repos(&self, a: TeamArgs) -> Result<Outcome<Vec<TeamRepo>>> {
        let (row, owner) = match self.seen_team(&a.viewer, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        #[derive(Deserialize)]
        struct Row {
            repo_id: String,
            repo_name: String,
            workspace: String,
            role: String,
            depth: u32,
            team: String,
        }
        let rows = self
            .db
            .prepare(format!(
                "WITH RECURSIVE up(id, depth) AS (
                   SELECT ?1, 0
                   UNION ALL
                   SELECT t.parent_id, up.depth + 1 FROM teams t JOIN up ON t.id = up.id
                   WHERE t.parent_id IS NOT NULL AND up.depth < 20
                 )
                 SELECT g.repo_id, g.repo_name, w.slug AS workspace, g.role, up.depth, t.slug AS team
                 FROM up JOIN repo_grants g ON g.principal_kind = 'team' AND g.principal_id = up.id
                 JOIN teams t ON t.id = up.id
                 JOIN workspaces w ON w.id = g.workspace_id AND w.deleted_at IS NULL
                 ORDER BY g.repo_name, up.depth LIMIT {LIST_LIMIT}"
            ))
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let found = rows.into_iter().filter_map(|row| {
            Some((row.repo_id, format!("{}/{}", row.workspace, row.repo_name), RepoRole::parse(&row.role)?, row.depth, row.team))
        });
        let mut repos = fold_team_repos(found);
        // Only what the viewer can see: owners everything; others what
        // they have a role on.
        if !owner && let Some(viewer) = a.viewer.as_ref() {
            repos.retain(|repo| {
                granted(
                    viewer,
                    RepoRef {
                        id: &repo.repo_id,
                        namespace: &row.workspace,
                        private: true,
                    },
                )
                .is_some()
            });
        }
        Ok(Outcome::Ok(repos))
    }

    /// The repository at `path`, in the team's workspace, if `actor` may
    /// manage who has access to it.
    async fn team_repo_target(&self, actor: &User, row: &TeamRow, path: &g1t_contracts::repos::RepoPath) -> Result<Outcome<crate::access::Target>> {
        let target = match self.manageable(actor, path).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if target.workspace_id != row.workspace_id {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A team has roles only on its own workspace's repositories, and {}/{} is not in {}.", target.repo.namespace, target.repo.name, row.workspace),
            ));
        }
        Ok(Outcome::Ok(target))
    }

    async fn team_grant(&self, repo_id: &str, team_id: &str) -> Result<Option<RepoRole>> {
        Ok(self
            .db
            .prepare("SELECT role FROM repo_grants WHERE repo_id = ? AND principal_kind = 'team' AND principal_id = ?")
            .bind(&[repo_id.into(), team_id.into()])?
            .first::<RoleRow>(None)
            .await?
            .and_then(|row| RepoRole::parse(&row.role)))
    }

    pub async fn set_team_repo(&self, a: SetTeamRepoArgs) -> Result<Outcome<TeamRepo>> {
        if !crate::security::is_person(&a.actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let Some(row) = (match self.seen_team(&Some(a.actor.clone()), &a.workspace, &a.team).await? {
            Outcome::Ok((row, _)) => Some(row),
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }) else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        let target = match self.team_repo_target(&a.actor, &row, &a.repo).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let repo = &target.repo;
        let previous = self.team_grant(&repo.id, &row.id).await?;
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO repo_grants
                   (repo_id, principal_kind, principal_id, workspace_id, repo_name, role, granted_by, created_at, updated_at)
                 VALUES (?1, 'team', ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (repo_id, principal_kind, principal_id)
                 DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at",
            )
            .bind(&[
                repo.id.as_str().into(),
                row.id.as_str().into(),
                target.workspace_id.as_str().into(),
                repo.name.to_lowercase().into(),
                a.role.as_str().into(),
                a.actor.id.as_str().into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        if previous != Some(a.role) {
            let kind = if previous.is_none() { "team.repo_added" } else { "team.repo_role_changed" };
            let message = match previous {
                None => format!("Gave the team {} the {} role", row.name, a.role.label()),
                Some(previous) => format!("Changed the team {}'s role from {} to {}", row.name, previous.label(), a.role.label()),
            };
            self.team_repo_event(kind, &a.actor, &row, repo.into(), Some(a.role), previous, a.surface.unwrap_or(Surface::Web), message)
                .await;
        }
        Ok(Outcome::Ok(TeamRepo {
            repo: format!("{}/{}", repo.namespace, repo.name),
            repo_id: repo.id.clone(),
            role: a.role,
            inherited_from: None,
        }))
    }

    pub async fn remove_team_repo(&self, a: RemoveTeamRepoArgs) -> Result<Outcome<bool>> {
        if !crate::security::is_person(&a.actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let (row, owner) = match self.seen_team(&Some(a.actor.clone()), &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // An owner or maintainer may take a role from their team; anyone
        // else needs Admin on the repository.
        let repo = if may_manage(owner, row.viewer_role()) {
            if !a.actor.verified {
                return Ok(Outcome::fail(FailureCode::Forbidden, CONFIRM_FIRST));
            }
            match self.repo_for(&a.repo, &Some(a.actor.clone())).await? {
                Some(repo) => repo,
                None => return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found.")),
            }
        } else {
            match self.team_repo_target(&a.actor, &row, &a.repo).await? {
                Outcome::Ok(target) => target.repo,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            }
        };
        let Some(previous) = self.team_grant(&repo.id, &row.id).await? else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("{} has no role of its own on {}/{}.", row.name, repo.namespace, repo.name),
            ));
        };
        self.db
            .prepare("DELETE FROM repo_grants WHERE repo_id = ? AND principal_kind = 'team' AND principal_id = ?")
            .bind(&[repo.id.as_str().into(), row.id.as_str().into()])?
            .run()
            .await?;
        self.team_repo_event(
            "team.repo_removed",
            &a.actor,
            &row,
            (&repo).into(),
            None,
            Some(previous),
            a.surface.unwrap_or(Surface::Web),
            format!("Removed the team {}'s {} role", row.name, previous.label()),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    pub async fn team_memberships(&self, a: TeamMembershipsArgs) -> Result<Outcome<Vec<MemberTeams>>> {
        let workspace = a.workspace.trim().to_lowercase();
        let Some(viewer) = a.viewer.as_ref() else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can see a workspace's teams."));
        };
        let Some(role) = role_of(viewer, &workspace) else {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members can see a workspace's teams."));
        };
        #[derive(Deserialize)]
        struct Row {
            username: String,
            slug: String,
            name: String,
            visibility: String,
            /// Whether the viewer is in the team.
            mine: u8,
        }
        let rows = self
            .db
            .prepare(
                "SELECT u.username, t.slug, t.name, t.visibility,
                   EXISTS (SELECT 1 FROM team_members me WHERE me.team_id = t.id AND me.user_id = ?2) AS mine
                 FROM teams t
                 JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
                 JOIN team_members tm ON tm.team_id = t.id
                 JOIN users u ON u.id = tm.user_id
                 WHERE w.slug = ?1
                 ORDER BY u.username, lower(t.name) LIMIT 5000",
            )
            .bind(&[workspace.as_str().into(), viewer.id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let owner = role == Role::Owner;
        let mut people: Vec<MemberTeams> = Vec::new();
        for row in rows {
            let visibility = TeamVisibility::parse(&row.visibility).unwrap_or_default();
            if !may_see(visibility, owner, row.mine != 0) {
                continue;
            }
            let team = TeamRef {
                slug: row.slug,
                name: row.name,
            };
            match people.last_mut().filter(|person| person.username == row.username) {
                Some(person) => person.teams.push(team),
                None => people.push(MemberTeams {
                    username: row.username,
                    teams: vec![team],
                }),
            }
        }
        Ok(Outcome::Ok(people))
    }

    // --- For other services ---

    /// Everyone in a team: its own people, and its child teams' people who
    /// are not its own.
    async fn people_of(&self, team_id: &str) -> Result<(Vec<TeamPerson>, Vec<TeamPerson>)> {
        let mut own = Vec::new();
        let mut children = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for row in self.member_rows(team_id, true).await? {
            if !seen.insert(row.id.clone()) {
                continue;
            }
            let person = TeamPerson {
                id: row.id,
                username: row.username,
            };
            if row.team_id == team_id {
                own.push(person);
            } else {
                children.push(person);
            }
        }
        Ok((own, children))
    }

    /// A team's role on a repository: its own, or one inherited from a
    /// parent, the highest.
    async fn team_role_on(&self, team_id: &str, repo_id: &str) -> Result<Option<RepoRole>> {
        Ok(self
            .db
            .prepare(
                "WITH RECURSIVE up(id, depth) AS (
                   SELECT ?1, 0
                   UNION ALL
                   SELECT t.parent_id, up.depth + 1 FROM teams t JOIN up ON t.id = up.id
                   WHERE t.parent_id IS NOT NULL AND up.depth < 20
                 )
                 SELECT g.role FROM up JOIN repo_grants g ON g.principal_kind = 'team' AND g.principal_id = up.id
                 WHERE g.repo_id = ?2",
            )
            .bind(&[team_id.into(), repo_id.into()])?
            .all()
            .await?
            .results::<RoleRow>()?
            .into_iter()
            .filter_map(|row| RepoRole::parse(&row.role))
            .max())
    }

    /// Whether `user_id` may see a team: a member of its workspace, and for
    /// a secret team, in it or an owner.
    async fn sees(&self, row: &TeamRow, team: &ResolvedTeam, user_id: &str) -> Result<bool> {
        let role = self
            .db
            .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
            .bind(&[row.workspace_id.as_str().into(), user_id.into()])?
            .first::<RoleRow>(None)
            .await?;
        let Some(role) = role else {
            return Ok(false);
        };
        let in_team = team.everyone().any(|person| person.id == user_id);
        Ok(may_see(row.visibility(), role.role == "owner", in_team))
    }

    async fn resolved(&self, row: &TeamRow, repo_id: Option<&str>) -> Result<ResolvedTeam> {
        let (members, child_members) = self.people_of(&row.id).await?;
        let repo_role = match repo_id {
            Some(repo_id) => self.team_role_on(&row.id, repo_id).await?,
            None => None,
        };
        Ok(ResolvedTeam {
            id: row.id.clone(),
            workspace: row.workspace.clone(),
            slug: row.slug.clone(),
            name: row.name.clone(),
            visibility: row.visibility(),
            notify: row.notify != 0,
            review_assignment: row.review(),
            members,
            child_members,
            repo_role,
            asker_sees: false,
        })
    }

    pub async fn resolve_teams(&self, a: ResolveTeamsArgs) -> Result<Vec<ResolvedTeam>> {
        let mut found: Vec<ResolvedTeam> = Vec::new();
        for name in a.teams.iter().take(50) {
            let name = name.trim().trim_start_matches('@');
            let Some((workspace, slug)) = name.split_once('/') else {
                continue;
            };
            let Some(row) = self.team_row(workspace, slug, None).await? else {
                continue;
            };
            if found.iter().any(|team| team.id == row.id) {
                continue;
            }
            let mut team = self.resolved(&row, a.repo_id.as_deref()).await?;
            if let Some(asker) = a.asker.as_deref() {
                team.asker_sees = self.sees(&row, &team, asker).await?;
            }
            found.push(team);
        }
        Ok(found)
    }

    /// Someone's effective role on a repository of a workspace: owner,
    /// base permission, a direct grant or a team's.
    async fn person_role(&self, repo_id: &str, workspace_id: &str, user_id: &str) -> Result<Option<RepoRole>> {
        #[derive(Deserialize)]
        struct Row {
            #[serde(default)]
            workspace_role: Option<String>,
            #[serde(default)]
            direct: Option<String>,
        }
        let row = self
            .db
            .prepare(
                "SELECT m.role AS workspace_role, g.role AS direct FROM users u
                 LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?2
                 LEFT JOIN repo_grants g ON g.principal_kind = 'user' AND g.principal_id = u.id AND g.repo_id = ?1
                 WHERE u.id = ?3",
            )
            .bind(&[repo_id.into(), workspace_id.into(), user_id.into()])?
            .first::<Row>(None)
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let base = self.base_of(workspace_id).await?;
        let teams = self.team_roles_on(repo_id, Some(user_id)).await?;
        let workspace_role = row.workspace_role.as_deref();
        Ok(crate::access::effective(
            workspace_role == Some("owner"),
            workspace_role.and(base.role()),
            row.direct.as_deref().and_then(RepoRole::parse),
            teams.get(user_id).map(|(role, _)| *role),
        )
        .map(|(role, _)| role))
    }

    pub async fn resolve_owners(&self, a: ResolveOwnersArgs) -> Result<Vec<ResolvedOwner>> {
        let workspace = a.workspace.trim().to_lowercase();
        let Some(workspace_id) = self.workspace_id_of(&workspace).await? else {
            return Ok(Vec::new());
        };
        let mut cache: HashMap<Owner, ResolvedOwner> = HashMap::new();
        let mut out = Vec::new();
        for owner in a.owners.iter().take(2000) {
            if let Some(done) = cache.get(owner) {
                out.push(done.clone());
                continue;
            }
            let resolved = self.resolve_owner(&a.repo_id, &workspace, &workspace_id, owner).await?;
            cache.insert(owner.clone(), resolved.clone());
            out.push(resolved);
        }
        Ok(out)
    }

    async fn resolve_owner(&self, repo_id: &str, workspace: &str, workspace_id: &str, owner: &Owner) -> Result<ResolvedOwner> {
        let answer = |check: OwnerCheck, members: Vec<String>, team: Option<String>| ResolvedOwner {
            owner: owner.clone(),
            check,
            members,
            team,
        };
        let person = |id: Option<(String, String)>| async move {
            let Some((id, username)) = id else {
                return Ok::<_, worker::Error>(None);
            };
            let writes = self
                .person_role(repo_id, workspace_id, &id)
                .await?
                .is_some_and(|role| role >= RepoRole::Write);
            Ok(Some((username, writes)))
        };
        Ok(match owner {
            Owner::User { username } if username.eq_ignore_ascii_case(AGENT_NAME) => {
                answer(OwnerCheck::Ok, vec![AGENT_NAME.to_owned()], None)
            }
            Owner::User { username } => match person(self.person_by_username(username).await?).await? {
                None => answer(OwnerCheck::UnknownUser, Vec::new(), None),
                Some((username, true)) => answer(OwnerCheck::Ok, vec![username], None),
                Some((username, false)) => answer(OwnerCheck::NoWriteAccess, vec![username], None),
            },
            Owner::Email { email } => {
                let id = match self.user_with_verified_email(email).await? {
                    Some(id) => self
                        .find_public_user("SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ?", &id)
                        .await?
                        .map(|user| (user.id, user.username)),
                    None => None,
                };
                match person(id).await? {
                    None => answer(OwnerCheck::UnknownEmail, Vec::new(), None),
                    Some((username, true)) => answer(OwnerCheck::Ok, vec![username], None),
                    Some((username, false)) => answer(OwnerCheck::NoWriteAccess, vec![username], None),
                }
            }
            Owner::Team { workspace: org, slug } => {
                // A team of another g1t workspace never has a role here;
                // an `org` that is not a g1t workspace means this one.
                let home = if org.eq_ignore_ascii_case(workspace) || self.workspace_id_of(org).await?.is_none() {
                    workspace.to_owned()
                } else {
                    org.to_lowercase()
                };
                match self.team_row(&home, slug, None).await? {
                    None => answer(OwnerCheck::UnknownTeam, Vec::new(), None),
                    Some(row) => {
                        let team = self.resolved(&row, Some(repo_id)).await?;
                        let members = team.everyone().map(|person| person.username.clone()).collect();
                        let check = if home == workspace && team.repo_role.is_some_and(|role| role >= RepoRole::Write) {
                            OwnerCheck::Ok
                        } else {
                            OwnerCheck::TeamNoAccess
                        };
                        answer(check, members, Some(format!("{}/{}", row.workspace, row.slug)))
                    }
                }
            }
        })
    }

    // --- Agents on teams ---

    pub(crate) async fn has_team_agent(&self, team_id: &str, agent_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT agent_id AS id FROM team_agents WHERE team_id = ? AND agent_id = ?")
            .bind(&[team_id.into(), agent_id.into()])?
            .first::<IdRow>(None)
            .await?
            .is_some())
    }

    /// The agents added to a team, as the viewer may see the team.
    pub async fn team_agents(&self, a: TeamArgs) -> Result<Outcome<Vec<TeamAgent>>> {
        let (row, _) = match self.seen_team(&a.viewer, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        #[derive(Deserialize)]
        struct AgentRow {
            agent_id: String,
            #[serde(default)]
            added_by: Option<String>,
            created_at: String,
        }
        let rows = self
            .db
            .prepare(
                "SELECT ta.agent_id, u.username AS added_by, ta.created_at FROM team_agents ta
                 LEFT JOIN users u ON u.id = ta.added_by AND u.deleted_at IS NULL
                 WHERE ta.team_id = ? ORDER BY ta.created_at LIMIT 500",
            )
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<AgentRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| TeamAgent {
                    agent_id: row.agent_id,
                    added_by: row.added_by,
                    created_at: row.created_at,
                })
                .collect(),
        ))
    }

    pub async fn set_team_agent(&self, a: SetTeamAgentArgs) -> Result<Outcome<TeamAgent>> {
        let (row, _) = match self.managed_team(&a.actor, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let agent_id = a.agent_id.trim();
        if !matches!(parse_lead(&format!("agent:{agent_id}")), Some(LeadInput::Agent(_))) {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not an agent's id."));
        }
        let now = rfc3339(now_ms());
        let added = !self.has_team_agent(&row.id, agent_id).await?;
        self.db
            .prepare(
                "INSERT INTO team_agents (team_id, agent_id, added_by, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (team_id, agent_id) DO NOTHING",
            )
            .bind(&[row.id.as_str().into(), agent_id.into(), a.actor.id.as_str().into(), now.as_str().into()])?
            .run()
            .await?;
        if added {
            self.team_event(
                "team.edited",
                &a.actor,
                TeamChanged {
                    changes: vec!["agents".to_owned()],
                    ..row.event()
                },
                a.surface.unwrap_or(Surface::Web),
                format!("Added an agent ({agent_id}) to {}", row.name),
            )
            .await;
        }
        Ok(Outcome::Ok(TeamAgent {
            agent_id: agent_id.to_owned(),
            added_by: Some(a.actor.username.clone()),
            created_at: now,
        }))
    }

    pub async fn remove_team_agent(&self, a: RemoveTeamAgentArgs) -> Result<Outcome<bool>> {
        let (row, _) = match self.managed_team(&a.actor, &a.workspace, &a.team).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let agent_id = a.agent_id.trim();
        if !self.has_team_agent(&row.id, agent_id).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("That agent was not added to {}.", row.name)));
        }
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM team_agents WHERE team_id = ? AND agent_id = ?")
                    .bind(&[row.id.as_str().into(), agent_id.into()])?,
                self.db
                    .prepare("UPDATE teams SET lead_kind = NULL, lead_id = NULL WHERE id = ? AND lead_kind = 'agent' AND lead_id = ?")
                    .bind(&[row.id.as_str().into(), agent_id.into()])?,
            ])
            .await?;
        self.team_event(
            "team.edited",
            &a.actor,
            TeamChanged {
                changes: vec!["agents".to_owned()],
                ..row.event()
            },
            a.surface.unwrap_or(Surface::Web),
            format!("Took an agent ({agent_id}) off {}", row.name),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// For the agents service: the visible teams an agent is on, with
    /// everyone on each, for what it is told every turn.
    pub async fn agent_teams(&self, a: AgentTeamsArgs) -> Result<Vec<AgentTeam>> {
        let workspace = a.workspace.trim().to_lowercase();
        let home = a.home_team.as_deref().map(|slug| slug.trim().to_lowercase()).unwrap_or_default();
        let rows = self
            .team_rows(
                "WHERE w.slug = ?2 AND t.visibility = 'visible'
                   AND (t.id IN (SELECT team_id FROM team_agents WHERE agent_id = ?3) OR t.slug = ?4)
                 ORDER BY lower(t.name)",
                &[JsValue::NULL, workspace.as_str().into(), a.agent_id.trim().into(), home.as_str().into()],
            )
            .await?;
        let rows: Vec<TeamRow> = rows.into_iter().take(20).collect();
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(&rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>())?;
        #[derive(Deserialize)]
        struct PersonRow {
            team_id: String,
            user_id: String,
            username: String,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            timezone: Option<String>,
            role: String,
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            owns: Option<String>,
            #[serde(default)]
            manager: Option<String>,
        }
        #[derive(Deserialize)]
        struct AgentRow {
            team_id: String,
            agent_id: String,
        }
        // One trip for both.
        let mut found = self
            .db
            .batch(vec![
                self.db
                .prepare(
                    "SELECT tm.team_id, u.id AS user_id, u.username, u.display_name AS name, u.timezone, tm.role,
                       wm.title, wm.owns, mu.username AS manager
                     FROM team_members tm
                     JOIN teams t ON t.id = tm.team_id
                     JOIN users u ON u.id = tm.user_id AND u.deleted_at IS NULL
                     LEFT JOIN workspace_members wm ON wm.workspace_id = t.workspace_id AND wm.user_id = u.id
                     LEFT JOIN users mu ON mu.id = wm.manager_id AND mu.deleted_at IS NULL
                     WHERE tm.team_id IN (SELECT value FROM json_each(?1))
                     ORDER BY tm.role DESC, u.username LIMIT 2000",
                )
                .bind(&[ids.as_str().into()])?,
                self.db
                    .prepare("SELECT team_id, agent_id FROM team_agents WHERE team_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at LIMIT 2000")
                    .bind(&[ids.as_str().into()])?,
            ])
            .await?
            .into_iter();
        let people = match found.next() {
            Some(result) => result.results::<PersonRow>()?,
            None => Vec::new(),
        };
        let agents = match found.next() {
            Some(result) => result.results::<AgentRow>()?,
            None => Vec::new(),
        };
        Ok(rows
            .iter()
            .map(|row| AgentTeam {
                slug: row.slug.clone(),
                name: row.name.clone(),
                description: row.description.clone(),
                lead: row.lead(),
                channel: channel_of(row.channel_id.as_deref(), row.channel_name.as_deref()),
                budget_micros: budget_of(row.budget_micros),
                people: people
                    .iter()
                    .filter(|person| person.team_id == row.id)
                    .map(|person| RosterPerson {
                        user_id: person.user_id.clone(),
                        username: person.username.clone(),
                        name: person.name.clone(),
                        title: person.title.clone(),
                        timezone: person.timezone.clone(),
                        owns: crate::people::owns_from(person.owns.as_deref()),
                        manager: person.manager.clone(),
                        maintainer: person.role == TeamRole::Maintainer.as_str(),
                    })
                    .collect(),
                agent_ids: agents.iter().filter(|agent| agent.team_id == row.id).map(|agent| agent.agent_id.clone()).collect(),
            })
            .collect())
    }

    /// For the agents service: a workspace's visible teams, each with the
    /// agents on it, for the roster agents are told and spend by team.
    pub async fn team_agent_index(&self, a: TeamAgentIndexArgs) -> Result<Vec<TeamAgentsEntry>> {
        #[derive(Deserialize)]
        struct Row {
            slug: String,
            name: String,
            agent_id: String,
        }
        let rows = self
            .db
            .prepare(
                "SELECT t.slug, t.name, ta.agent_id FROM team_agents ta
                 JOIN teams t ON t.id = ta.team_id
                 JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
                 WHERE w.slug = ?1 AND t.visibility = 'visible'
                 ORDER BY lower(t.name), ta.created_at LIMIT 5000",
            )
            .bind(&[a.workspace.trim().to_lowercase().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut out: Vec<TeamAgentsEntry> = Vec::new();
        for row in rows {
            match out.last_mut() {
                Some(team) if team.slug == row.slug => team.agent_ids.push(row.agent_id),
                _ => out.push(TeamAgentsEntry {
                    slug: row.slug,
                    name: row.name,
                    agent_ids: vec![row.agent_id],
                }),
            }
        }
        Ok(out)
    }

    /// For the agents service, once: puts agents on the teams they named
    /// themselves when an agent carried its own team. Safe to repeat.
    pub async fn adopt_agent_teams(&self, a: AdoptAgentTeamsArgs) -> Result<Vec<AdoptedAgentTeam>> {
        let claims: Vec<AgentTeamClaim> = a.agents.into_iter().take(500).collect();
        if claims.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(Deserialize)]
        struct TeamIds {
            id: String,
            slug: String,
        }
        #[derive(Deserialize)]
        struct OnRow {
            team_id: String,
            agent_id: String,
        }
        let ids = serde_json::to_string(&claims.iter().map(|claim| claim.agent_id.trim()).collect::<Vec<_>>())?;
        let workspace_id = a.workspace_id.trim();
        let mut found = self
            .db
            .batch(vec![
                self.db
                    .prepare("SELECT id, slug FROM teams WHERE workspace_id = ?1 LIMIT 2000")
                    .bind(&[workspace_id.into()])?,
                self.db
                    .prepare(
                        "SELECT ta.team_id, ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
                         WHERE t.workspace_id = ?1 AND ta.agent_id IN (SELECT value FROM json_each(?2)) LIMIT 5000",
                    )
                    .bind(&[workspace_id.into(), ids.as_str().into()])?,
            ])
            .await?
            .into_iter();
        let teams = match found.next() {
            Some(result) => result.results::<TeamIds>()?,
            None => Vec::new(),
        };
        let on = match found.next() {
            Some(result) => result.results::<OnRow>()?,
            None => Vec::new(),
        };
        let teams: HashMap<String, String> = teams.into_iter().map(|team| (team.slug.to_lowercase(), team.id)).collect();
        let on: HashSet<(String, String)> = on.into_iter().map(|row| (row.team_id, row.agent_id)).collect();
        let (outcomes, inserts) = plan_adoption(&claims, &teams, &on);
        if !inserts.is_empty() {
            let now = rfc3339(now_ms());
            let mut statements = Vec::with_capacity(inserts.len());
            for (team_id, agent_id) in &inserts {
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO team_agents (team_id, agent_id, added_by, created_at) VALUES (?1, ?2, NULL, ?3)
                             ON CONFLICT (team_id, agent_id) DO NOTHING",
                        )
                        .bind(&[team_id.as_str().into(), agent_id.as_str().into(), now.as_str().into()])?,
                );
            }
            self.db.batch(statements).await?;
        }
        Ok(outcomes)
    }

    // --- Telling others ---

    /// Publishes a change to a team and records it in the workspace's
    /// audit log.
    async fn team_event(&self, kind: &'static str, actor: &User, data: TeamChanged, surface: Surface, message: String) {
        let workspace = data.workspace.clone();
        self.announce(kind, Some(&actor.id), data).await;
        self.audit_workspace(actor, kind, &workspace, surface, message).await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn team_repo_event(
        &self,
        kind: &'static str,
        actor: &User,
        row: &TeamRow,
        repo: Named<'_>,
        role: Option<RepoRole>,
        previous: Option<RepoRole>,
        surface: Surface,
        message: String,
    ) {
        let data = TeamChanged {
            repo_id: Some(repo.id.to_owned()),
            repo: Some(format!("{}/{}", repo.namespace, repo.name)),
            repo_role: role,
            previous_repo_role: previous,
            ..row.event()
        };
        self.publish_repo(kind, repo.id, &actor.id, data).await;
        self.audit(actor, kind, repo, surface, message).await;
    }
}

/// A team's repositories from its own grants and its ancestors' (`depth`
/// 0 for its own): each repository once, at the highest role, named by
/// the ancestor it comes from when that is higher than its own.
pub fn fold_team_repos(rows: impl IntoIterator<Item = (String, String, RepoRole, u32, String)>) -> Vec<TeamRepo> {
    let mut repos: Vec<(TeamRepo, u32)> = Vec::new();
    for (repo_id, repo, role, depth, team) in rows {
        let inherited_from = (depth > 0).then_some(team);
        match repos.iter_mut().find(|(had, _)| had.repo_id == repo_id) {
            Some((had, had_depth)) => {
                if role > had.role || (role == had.role && depth < *had_depth) {
                    had.role = role;
                    had.inherited_from = inherited_from;
                    *had_depth = depth;
                }
            }
            None => repos.push((
                TeamRepo {
                    repo,
                    repo_id,
                    role,
                    inherited_from,
                },
                depth,
            )),
        }
    }
    let mut repos: Vec<TeamRepo> = repos.into_iter().map(|(repo, _)| repo).collect();
    repos.sort_by(|a, b| a.repo.cmp(&b.repo));
    repos
}

/// What adopting agents' own teams does: each claim's outcome, and the
/// memberships to add as (team id, agent id). `teams` maps a lowercase
/// slug to its id; `on` holds the memberships there are already.
pub(crate) fn plan_adoption(
    claims: &[AgentTeamClaim],
    teams: &HashMap<String, String>,
    on: &HashSet<(String, String)>,
) -> (Vec<AdoptedAgentTeam>, Vec<(String, String)>) {
    let mut outcomes = Vec::with_capacity(claims.len());
    let mut inserts: Vec<(String, String)> = Vec::new();
    for claim in claims {
        let agent_id = claim.agent_id.trim();
        let slug = claim.team.trim().trim_start_matches('@').to_lowercase();
        let valid = matches!(parse_lead(&format!("agent:{agent_id}")), Some(LeadInput::Agent(_)));
        let outcome = match teams.get(&slug) {
            Some(team_id) if valid => {
                let pair = (team_id.clone(), agent_id.to_owned());
                if on.contains(&pair) || inserts.contains(&pair) {
                    "already"
                } else {
                    inserts.push(pair);
                    "added"
                }
            }
            _ => "no_team",
        };
        outcomes.push(AdoptedAgentTeam {
            agent_id: agent_id.to_owned(),
            team: claim.team.clone(),
            outcome: outcome.to_owned(),
        });
    }
    (outcomes, inserts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_teams_are_seen_by_their_people_and_owners() {
        assert!(may_see(TeamVisibility::Visible, false, false));
        assert!(!may_see(TeamVisibility::Secret, false, false));
        assert!(may_see(TeamVisibility::Secret, false, true));
        assert!(may_see(TeamVisibility::Secret, true, false));
    }

    #[test]
    fn owners_and_maintainers_manage_a_team() {
        assert!(may_manage(true, None));
        assert!(may_manage(false, Some(TeamRole::Maintainer)));
        assert!(!may_manage(false, Some(TeamRole::Member)));
        assert!(!may_manage(false, None));
    }

    #[test]
    fn nesting_refuses_cycles_secret_teams_and_depth() {
        use TeamVisibility::*;
        let chain = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        assert_eq!(nesting_problem("t1", Visible, "t2", Visible, &chain(&["t2"]), 0), None);
        // Under itself, or under its own child.
        assert!(nesting_problem("t1", Visible, "t1", Visible, &chain(&["t1"]), 0).is_some());
        assert!(nesting_problem("t1", Visible, "t3", Visible, &chain(&["t3", "t2", "t1"]), 2).is_some());
        // Secret on either side.
        assert!(nesting_problem("t1", Secret, "t2", Visible, &chain(&["t2"]), 0).is_some());
        assert!(nesting_problem("t1", Visible, "t2", Secret, &chain(&["t2"]), 0).is_some());
        // Eight levels at most: a chain of 6, the team, and one below.
        let deep = chain(&["a", "b", "c", "d", "e", "f"]);
        assert_eq!(nesting_problem("t1", Visible, "a", Visible, &deep, 1), None);
        assert!(nesting_problem("t1", Visible, "a", Visible, &deep, 2).is_some());
        // A new team has no id yet and nothing below.
        assert_eq!(nesting_problem("", Visible, "a", Visible, &chain(&["a"]), 0), None);
    }

    #[test]
    fn a_teams_repositories_are_its_own_and_its_parents_at_the_highest_role() {
        let repos = fold_team_repos([
            ("rep_1".to_owned(), "acme/api".to_owned(), RepoRole::Write, 0, "backend".to_owned()),
            ("rep_1".to_owned(), "acme/api".to_owned(), RepoRole::Read, 1, "engineering".to_owned()),
            ("rep_2".to_owned(), "acme/web".to_owned(), RepoRole::Triage, 0, "backend".to_owned()),
            ("rep_2".to_owned(), "acme/web".to_owned(), RepoRole::Maintain, 2, "everyone".to_owned()),
            ("rep_3".to_owned(), "acme/docs".to_owned(), RepoRole::Read, 1, "engineering".to_owned()),
            ("rep_4".to_owned(), "acme/cli".to_owned(), RepoRole::Write, 1, "engineering".to_owned()),
            ("rep_4".to_owned(), "acme/cli".to_owned(), RepoRole::Write, 0, "backend".to_owned()),
        ]);
        let shown: Vec<(&str, RepoRole, Option<&str>)> =
            repos.iter().map(|repo| (repo.repo.as_str(), repo.role, repo.inherited_from.as_deref())).collect();
        assert_eq!(
            shown,
            vec![
                ("acme/api", RepoRole::Write, None),
                // Its own role is a tie with the parent's: its own.
                ("acme/cli", RepoRole::Write, None),
                ("acme/docs", RepoRole::Read, Some("engineering")),
                ("acme/web", RepoRole::Maintain, Some("everyone")),
            ]
        );
    }

    #[test]
    fn a_teams_lead_channel_and_budget_read_from_their_columns() {
        assert_eq!(
            lead_of(Some("agent"), Some("agt_1"), None, None, None),
            Some(TeamLead::Agent { agent_id: "agt_1".into() })
        );
        assert_eq!(
            lead_of(Some("user"), Some("usr_1"), Some("priya"), Some("Priya Shah"), None),
            Some(TeamLead::User { username: "priya".into(), name: Some("Priya Shah".into()), avatar: None })
        );
        // A person whose account is gone leads nothing.
        assert_eq!(lead_of(Some("user"), Some("usr_1"), None, None, None), None);
        assert_eq!(lead_of(None, None, None, None, None), None);
        assert_eq!(channel_of(Some("chn_1"), Some("sales")).map(|c| c.name), Some("sales".into()));
        assert_eq!(channel_of(Some(""), Some("sales")), None);
        assert_eq!(budget_of(Some(150_000_000.0)), Some(150_000_000));
        assert_eq!(budget_of(Some(0.0)), None);
        assert_eq!(budget_of(None), None);
    }

    #[test]
    fn a_workspace_token_sees_teams_as_an_owner() {
        let token = User {
            id: "wsp_1".into(),
            username: "acme".into(),
            kind: PrincipalKind::Workspace,
            workspaces: vec![g1t_contracts::Membership::member("acme")],
            ..User::default()
        };
        assert_eq!(role_of(&token, "acme"), Some(Role::Owner), "the workspace itself, with no token: a service");
        assert_eq!(role_of(&token, "globex"), None);
        let mut writer = User { token: Some(Box::new(g1t_contracts::scopes::TokenAccess::full())), ..token.clone() };
        assert_eq!(role_of(&writer, "acme"), Some(Role::Member), "a workspace token is a member unless given Admin");
        writer.token.as_mut().unwrap().admin = true;
        assert_eq!(role_of(&writer, "acme"), Some(Role::Owner));
    }

    #[test]
    fn agents_own_teams_become_memberships_once() {
        let claim = |agent: &str, team: &str| AgentTeamClaim {
            agent_id: agent.to_owned(),
            team: team.to_owned(),
        };
        let teams: HashMap<String, String> = [("qa".to_owned(), "tm_qa".to_owned()), ("sales".to_owned(), "tm_sales".to_owned())].into();
        let on: HashSet<(String, String)> = [("tm_sales".to_owned(), "agt_david".to_owned())].into();
        let claims = [claim("agt_margo", "QA"), claim("agt_david", "sales"), claim("agt_pax", "billing"), claim("agt_otto", "qa"), claim("not an id!", "qa")];
        let (outcomes, inserts) = plan_adoption(&claims, &teams, &on);
        let said: Vec<&str> = outcomes.iter().map(|o| o.outcome.as_str()).collect();
        assert_eq!(said, ["added", "already", "no_team", "added", "no_team"], "matched by slug in any case; unmatched and bad ids dropped");
        assert_eq!(inserts, [("tm_qa".to_owned(), "agt_margo".to_owned()), ("tm_qa".to_owned(), "agt_otto".to_owned())]);
        // Run again with those added: nothing more to do.
        let on: HashSet<(String, String)> = on.into_iter().chain(inserts).collect();
        let (again, more) = plan_adoption(&claims, &teams, &on);
        assert!(more.is_empty(), "safe to run twice");
        assert_eq!(again[0].outcome, "already");
    }
}
