//! Workspaces and their members.
//!
//! A workspace owns repositories and is the first segment of their URLs.
//! There is one kind: a person's own space and a company's differ only in
//! how many members they have. Nothing can be created outside one.

use g1t_contracts::access::BasePermission;
use g1t_contracts::audit::Surface;
use g1t_contracts::identity::*;
use g1t_contracts::members::{LeaveWorkspaceArgs, last_owner_refusal};
use g1t_contracts::teams::TeamCreation;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{
    FailureCode, MemberPrivileges, Membership, OrgRole, Outcome, PrincipalKind, Role, User, claimable_namespace, new_id,
};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Identity;

/// Enough for a person and their teams; stops one account claiming names in
/// bulk.
const MAX_WORKSPACES_PER_USER: usize = 10;

const MAX_NAME_LENGTH: usize = 80;
const MAX_DESCRIPTION_LENGTH: usize = 160;

const WORKSPACE_COLUMNS: &str = "workspaces.id, workspaces.slug, workspaces.name,
  workspaces.description, workspaces.avatar, workspaces.created_at, workspaces.base_permission, workspaces.team_creation,
  workspaces.member_privileges, workspaces.require_two_factor,
  (SELECT count(*) FROM workspace_members
   WHERE workspace_members.workspace_id = workspaces.id) AS member_count";

#[derive(Deserialize)]
struct WorkspaceRow {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    avatar: Option<String>,
    created_at: String,
    member_count: u32,
    #[serde(default)]
    base_permission: Option<String>,
    #[serde(default)]
    team_creation: Option<String>,
    #[serde(default)]
    member_privileges: Option<String>,
    #[serde(default)]
    require_two_factor: Option<u8>,
}

impl From<WorkspaceRow> for Workspace {
    fn from(row: WorkspaceRow) -> Self {
        Workspace {
            id: row.id,
            slug: row.slug,
            name: row.name,
            description: row.description,
            created_at: row.created_at,
            member_count: row.member_count,
            avatar: row.avatar,
            base_permission: row
                .base_permission
                .as_deref()
                .and_then(BasePermission::parse)
                .unwrap_or_default(),
            team_creation: row
                .team_creation
                .as_deref()
                .and_then(TeamCreation::parse)
                .unwrap_or_default(),
            privileges: MemberPrivileges::from_stored(row.member_privileges.as_deref()),
            two_factor_requirement_enabled: row.require_two_factor.unwrap_or(0) != 0,
        }
    }
}

/// One of a person's memberships, as stored.
#[derive(Deserialize)]
struct MembershipRow {
    slug: String,
    role: Role,
    name: Option<String>,
    avatar: Option<String>,
    base_permission: Option<String>,
    team_creation: Option<String>,
    member_privileges: Option<String>,
    #[serde(default)]
    billing_manager: u8,
    #[serde(default)]
    security_manager: u8,
    #[serde(default)]
    require_two_factor: u8,
}

impl Identity {
    /// The workspaces a user belongs to, attached to every user resolved
    /// from credentials, with what the site needs to show each one, what
    /// members get on its repositories (access.rs), the roles the person
    /// holds besides member (members.rs), and its member privileges.
    pub async fn memberships(&self, user_id: &str) -> Result<Vec<Membership>> {
        Ok(self.memberships_and_policies(user_id).await?.into_iter().map(|(membership, _)| membership).collect())
    }

    /// The same, each with whether its workspace requires two-factor
    /// authentication (security.rs).
    pub async fn memberships_and_policies(&self, user_id: &str) -> Result<Vec<(Membership, bool)>> {
        let rows = self
            .db
            .prepare(
                "SELECT workspaces.slug, workspace_members.role, workspaces.name,
                   workspaces.avatar, workspaces.base_permission, workspaces.team_creation,
                   workspaces.member_privileges, workspaces.require_two_factor,
                   workspace_members.billing_manager, workspace_members.security_manager
                 FROM workspace_members
                 JOIN workspaces ON workspaces.id = workspace_members.workspace_id
                 WHERE workspace_members.user_id = ? AND workspaces.deleted_at IS NULL
                 ORDER BY workspaces.slug",
            )
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<MembershipRow>()?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let mut org_roles = Vec::new();
                if row.billing_manager != 0 {
                    org_roles.push(OrgRole::BillingManager);
                }
                if row.security_manager != 0 {
                    org_roles.push(OrgRole::SecurityManager);
                }
                let membership = Membership {
                    slug: row.slug,
                    role: row.role,
                    name: row.name,
                    avatar: row.avatar,
                    base_permission: row.base_permission.as_deref().and_then(BasePermission::parse),
                    team_creation: row.team_creation.as_deref().and_then(TeamCreation::parse),
                    org_roles,
                    privileges: Some(MemberPrivileges::from_stored(row.member_privileges.as_deref())),
                };
                (membership, row.require_two_factor != 0)
            })
            .collect())
    }

    pub async fn create_workspace(&self, a: CreateWorkspaceArgs) -> Result<Outcome<Workspace>> {
        if a.user.kind != PrincipalKind::User {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "A workspace's access token cannot create workspaces. Sign in as a person.",
            ));
        }
        if !a.user.verified {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Confirm your email address before creating a workspace.",
            ));
        }
        let Some(slug) = claimable_namespace(&a.slug) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Workspace names use lowercase letters, digits and single hyphens, up to 39 characters, and cannot be a reserved word.",
            ));
        };
        if self.memberships(&a.user.id).await?.len() >= MAX_WORKSPACES_PER_USER {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "You belong to the maximum number of workspaces.",
            ));
        }
        // One free workspace per person (paid.rs): a new one starts free.
        if let Some(refused) = self.second_free_workspace(&a.user.id).await? {
            return Ok(refused);
        }
        // Usernames and workspaces share one namespace: a person's username
        // is theirs to use for a workspace, and nobody else's.
        let someone_elses_username = self
            .db
            .prepare("SELECT id FROM users WHERE username = ? AND id != ?")
            .bind(&[slug.as_str().into(), a.user.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        if someone_elses_username
            // A deleted workspace still holds its slug until it is purged.
            || self.slug_in_use(&slug).await?
            // A renamed workspace's old slug stays reserved for it a while.
            || self.slug_held(&slug).await?
            // A deleted workspace's slug is never given to anyone else; the
            // person whose username it is may use it again.
            || (self.slug_deleted(&slug).await?
                && !crate::deletion::may_reclaim(&slug, &a.user.username))
        {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That workspace name is taken.",
            ));
        }
        let now = now_ms();
        let workspace = Workspace {
            id: new_id("wsp", now),
            name: match a.name.trim() {
                "" => slug.clone(),
                name => name.chars().take(MAX_NAME_LENGTH).collect(),
            },
            description: None,
            slug,
            created_at: rfc3339(now),
            member_count: 1,
            avatar: None,
            // Read, as on GitHub: an owner widens it on People.
            base_permission: BasePermission::FOR_NEW_WORKSPACES,
            team_creation: TeamCreation::default(),
            privileges: MemberPrivileges::default(),
            two_factor_requirement_enabled: false,
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO workspaces (id, slug, name, created_by, created_at, base_permission)
                         VALUES (?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        workspace.id.as_str().into(),
                        workspace.slug.as_str().into(),
                        workspace.name.as_str().into(),
                        a.user.id.as_str().into(),
                        workspace.created_at.as_str().into(),
                        workspace.base_permission.as_str().into(),
                    ])?,
                self.db
                    .prepare(
                        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
                         VALUES (?, ?, 'owner', ?)",
                    )
                    .bind(&[
                        workspace.id.as_str().into(),
                        a.user.id.as_str().into(),
                        workspace.created_at.as_str().into(),
                    ])?,
            ])
            .await?;
        self.forget_deleted(&workspace.slug).await?;
        Ok(Outcome::Ok(workspace))
    }

    pub async fn get_workspace(&self, a: SlugArgs) -> Result<Option<Workspace>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT {WORKSPACE_COLUMNS} FROM workspaces WHERE slug = ? AND deleted_at IS NULL"
            ))
            .bind(&[a.slug.to_lowercase().into()])?
            .first::<WorkspaceRow>(None)
            .await?
            .map(Workspace::from))
    }

    pub async fn update_workspace(&self, a: UpdateWorkspaceArgs) -> Result<Outcome<Workspace>> {
        let slug = a.slug.to_lowercase();
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can change a workspace's details.",
            ));
        }
        let name: String = match a.name.trim() {
            "" => slug.clone(),
            name => name.chars().take(MAX_NAME_LENGTH).collect(),
        };
        let description: String = a
            .description
            .trim()
            .chars()
            .take(MAX_DESCRIPTION_LENGTH)
            .collect();
        self.db
            .prepare("UPDATE workspaces SET name = ?, description = ? WHERE slug = ?")
            .bind(&[
                name.into(),
                if description.is_empty() {
                    worker::wasm_bindgen::JsValue::NULL
                } else {
                    description.into()
                },
                slug.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(match self.get_workspace(SlugArgs { slug }).await? {
            Some(workspace) => Outcome::Ok(workspace),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    pub async fn list_members(&self, a: ListMembersArgs) -> Result<Outcome<Vec<Member>>> {
        let slug = a.slug.to_lowercase();
        let Some(viewer) = a.viewer.filter(|viewer| viewer.is_member(&slug)) else {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only members can see who is in a workspace.",
            ));
        };
        // Owners see who has two-factor authentication on, as they need to
        // before requiring it.
        let owner = viewer.role_in(&slug) == Some(Role::Owner);
        #[derive(Deserialize)]
        struct Row {
            #[serde(flatten)]
            member: crate::members::MemberRow,
            #[serde(default)]
            two_factor: u8,
        }
        let rows = self
            .db
            .prepare(
                "SELECT workspace_members.user_id, users.username, workspace_members.role, users.display_name AS name, users.avatar,
                   workspace_members.billing_manager, workspace_members.security_manager,
                   EXISTS (SELECT 1 FROM two_factor WHERE two_factor.user_id = users.id AND two_factor.enabled_at IS NOT NULL) AS two_factor
                 FROM workspace_members
                 JOIN users ON users.id = workspace_members.user_id
                 JOIN workspaces ON workspaces.id = workspace_members.workspace_id
                 WHERE workspaces.slug = ? AND workspaces.deleted_at IS NULL
                 ORDER BY workspace_members.role DESC, users.username",
            )
            .bind(&[slug.into()])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| row.member.member(owner.then_some(row.two_factor != 0)))
                .collect(),
        ))
    }

    /// The ids needed to change a workspace's members, if `actor` owns it
    /// and `username` exists.
    async fn member_target(&self, a: &MemberArgs) -> Result<Outcome<(String, User)>> {
        let slug = a.slug.to_lowercase();
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can change a workspace's members.",
            ));
        }
        let Some(workspace) = self.get_workspace(SlugArgs { slug }).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let Some(user) = self
            .find_public_user(
                "SELECT id, username, email_verified_at IS NOT NULL AS verified
                 FROM users WHERE username = ?",
                &a.username.trim().to_lowercase(),
            )
            .await?
        else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "There is no account with that username.",
            ));
        };
        Ok(Outcome::Ok((workspace.id, user)))
    }

    pub async fn add_member(&self, a: MemberArgs) -> Result<Outcome<bool>> {
        let (workspace_id, user) = match self.member_target(&a).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // What the workspace asks of its members (security.rs); nothing yet.
        if let Some(why) = self.policy_refusal(&user.id, &a.slug.to_lowercase()).await? {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        // A free workspace adds no one until it starts the plan (paid.rs);
        // g1t's agent is never someone added.
        if !crate::paid::is_g1t(&user.username)
            && let Some(refused) = self.free_workspace_refusal(&a.slug).await?
        {
            return Ok(refused);
        }
        let added = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
                 VALUES (?, ?, 'member', ?) RETURNING user_id",
            )
            .bind(&[
                workspace_id.into(),
                user.id.as_str().into(),
                rfc3339(now_ms()).into(),
            ])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        if added {
            self.audit_workspace(
                &a.actor,
                "member.added",
                &a.slug.to_lowercase(),
                a.surface.unwrap_or(Surface::Web),
                format!("Added {} as a member", user.username),
            )
            .await;
        }
        Ok(Outcome::Ok(true))
    }

    pub async fn remove_member(&self, a: MemberArgs) -> Result<Outcome<bool>> {
        // Removing yourself is leaving, which anyone may do.
        if a.username.trim().trim_start_matches('@').eq_ignore_ascii_case(&a.actor.username) {
            return self
                .leave_workspace(LeaveWorkspaceArgs { user: a.actor, slug: a.slug, surface: a.surface })
                .await;
        }
        let (workspace_id, user) = match self.member_target(&a).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let slug = a.slug.to_lowercase();
        let Some(row) = self.member_row(&workspace_id, &user.username).await? else {
            return Ok(Outcome::Ok(true));
        };
        if row.role == Role::Owner
            && let Some(why) = last_owner_refusal(self.owner_count(&workspace_id).await?, true)
        {
            return Ok(Outcome::fail(FailureCode::Conflict, why));
        }
        self.drop_member(&workspace_id, &user.id).await?;
        self.audit_workspace(
            &a.actor,
            "member.removed",
            &slug,
            a.surface.unwrap_or(Surface::Web),
            format!("Removed {} from the workspace", user.username),
        )
        .await;
        Ok(Outcome::Ok(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_workspace_is_created_with_g1ts_names() {
        // What create_workspace takes the slug through, whatever its case.
        for slug in ["g1t", "G1T", " g1t-agent ", "G1T-Agent"] {
            assert_eq!(claimable_namespace(slug), None, "{slug}");
        }
        assert_eq!(claimable_namespace("Acme").as_deref(), Some("acme"));
    }
}
