//! Workspaces and their members.
//!
//! A workspace owns repositories and is the first segment of their URLs.
//! There is one kind: a person's own space and a company's differ only in
//! how many members they have. Nothing can be created outside one.

use g1t_contracts::access::BasePermission;
use g1t_contracts::identity::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{
    FailureCode, Membership, Outcome, PrincipalKind, Role, User, claimable_namespace, new_id,
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
  workspaces.description, workspaces.avatar, workspaces.created_at, workspaces.base_permission,
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
        }
    }
}

#[derive(Deserialize)]
struct MemberRow {
    username: String,
    role: Role,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

impl Identity {
    /// The workspaces a user belongs to, attached to every user resolved
    /// from credentials, with what the site needs to show each one and
    /// what members get on its repositories (access.rs).
    pub async fn memberships(&self, user_id: &str) -> Result<Vec<Membership>> {
        self.db
            .prepare(
                "SELECT workspaces.slug, workspace_members.role, workspaces.name,
                   workspaces.avatar, workspaces.base_permission
                 FROM workspace_members
                 JOIN workspaces ON workspaces.id = workspace_members.workspace_id
                 WHERE workspace_members.user_id = ? AND workspaces.deleted_at IS NULL
                 ORDER BY workspaces.slug",
            )
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<Membership>()
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
            base_permission: BasePermission::default(),
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO workspaces (id, slug, name, created_by, created_at)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        workspace.id.as_str().into(),
                        workspace.slug.as_str().into(),
                        workspace.name.as_str().into(),
                        a.user.id.as_str().into(),
                        workspace.created_at.as_str().into(),
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
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&slug)) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only members can see who is in a workspace.",
            ));
        }
        let rows = self
            .db
            .prepare(
                "SELECT users.username, workspace_members.role, users.display_name AS name, users.avatar FROM workspace_members
                 JOIN users ON users.id = workspace_members.user_id
                 JOIN workspaces ON workspaces.id = workspace_members.workspace_id
                 WHERE workspaces.slug = ? AND workspaces.deleted_at IS NULL
                 ORDER BY workspace_members.role DESC, users.username",
            )
            .bind(&[slug.into()])?
            .all()
            .await?
            .results::<MemberRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| Member {
                    username: row.username,
                    role: row.role,
                    name: row.name,
                    avatar: row.avatar,
                })
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
        self.db
            .prepare(
                "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
                 VALUES (?, ?, 'member', ?)",
            )
            .bind(&[
                workspace_id.into(),
                user.id.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    pub async fn remove_member(&self, a: MemberArgs) -> Result<Outcome<bool>> {
        let (workspace_id, user) = match self.member_target(&a).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if user.id == a.actor.id {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "An owner cannot remove themselves.",
            ));
        }
        // Leaving a workspace takes away every way into it: the person's
        // roles on its repositories go too (access.rs), and their place in
        // its teams (teams.rs). To keep someone on a repository, add them
        // to it again as an outside collaborator.
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
                    .bind(&[workspace_id.as_str().into(), user.id.as_str().into()])?,
                self.db
                    .prepare(
                        "DELETE FROM repo_grants
                         WHERE workspace_id = ? AND principal_kind = 'user' AND principal_id = ?",
                    )
                    .bind(&[workspace_id.as_str().into(), user.id.as_str().into()])?,
                self.db
                    .prepare(
                        "DELETE FROM team_members
                         WHERE team_id IN (SELECT id FROM teams WHERE workspace_id = ?) AND user_id = ?",
                    )
                    .bind(&[workspace_id.as_str().into(), user.id.as_str().into()])?,
            ])
            .await?;
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
