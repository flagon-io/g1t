//! Who owns and belongs to a workspace, and what its members may do. See
//! `g1t_contracts::members` for the rules.
//!
//! - **Owners.** `update_member` makes a member an owner or an owner a
//!   member, and gives or takes away billing manager and security manager;
//!   `transfer_ownership` hands the workspace over in one step;
//!   `leave_workspace` is anyone leaving. None of them leaves a workspace
//!   without an owner.
//! - **Member privileges.** `set_member_privileges` stores them as JSON in
//!   `workspaces.member_privileges`; every membership identity resolves
//!   carries them (workspaces.rs), and the repos service enforces them.
//! - **Two-factor requirement.** `set_two_factor_requirement` sets
//!   `workspaces.require_two_factor`, which security.rs enforces.
//! - **Creators.** `grant_creator` gives whoever creates a repository the
//!   Admin role on it, and [`Identity::backfill_creator_grants`] did the
//!   same, once, for repositories made before.
//!
//! Every change is recorded in the workspace's audit log.

use g1t_contracts::audit::Surface;
use g1t_contracts::identity::Member;
use g1t_contracts::members::*;
use g1t_contracts::repos::{AllIdsArgs, CreatorPage};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::security::is_person;

const OWNERS_ONLY: &str = "Only an owner can change a workspace's members.";
const CONFIRM_FIRST: &str = "Confirm your email address before changing the workspace's members.";
const NOT_A_MEMBER: &str = "That person is not a member of this workspace.";

/// A member's row, as the rules here need it.
#[derive(Deserialize)]
pub(crate) struct MemberRow {
    pub user_id: String,
    pub username: String,
    #[serde(default)]
    pub display_username: Option<String>,
    pub role: Role,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub billing_manager: u8,
    #[serde(default)]
    pub security_manager: u8,
}

impl MemberRow {
    pub fn org_roles(&self) -> Vec<OrgRole> {
        let mut roles = Vec::new();
        if self.billing_manager != 0 {
            roles.push(OrgRole::BillingManager);
        }
        if self.security_manager != 0 {
            roles.push(OrgRole::SecurityManager);
        }
        roles
    }

    pub fn member(&self, two_factor: Option<bool>) -> Member {
        Member {
            username: self.username.clone(),
            display_username: self
                .display_username
                .clone()
                .filter(|display| display.eq_ignore_ascii_case(&self.username) && *display != self.username),
            role: self.role,
            org_roles: self.org_roles(),
            two_factor,
            name: self.name.clone(),
            avatar: self.avatar.clone(),
        }
    }
}

/// How a role change reads in the audit log.
fn role_words(role: Role) -> &'static str {
    match role {
        Role::Owner => "owner",
        Role::Member => "member",
    }
}

impl Identity {
    /// The workspace's id, if `actor` is a verified person who owns it; the
    /// refusal otherwise.
    async fn owners_workspace(&self, actor: &User, slug: &str) -> Result<Outcome<String>> {
        if !is_person(actor) || actor.role_in(slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, OWNERS_ONLY));
        }
        if !actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, CONFIRM_FIRST));
        }
        Ok(match self.workspace_id_of(slug).await? {
            Some(id) => Outcome::Ok(id),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    /// One member of a workspace, by username.
    pub(crate) async fn member_row(&self, workspace_id: &str, username: &str) -> Result<Option<MemberRow>> {
        self.db
            .prepare(
                "SELECT m.user_id, u.username, u.display_username, m.role, u.display_name AS name, u.avatar,
                   m.billing_manager, m.security_manager
                 FROM workspace_members m JOIN users u ON u.id = m.user_id
                 WHERE m.workspace_id = ? AND u.username = ?",
            )
            .bind(&[workspace_id.into(), username.trim().trim_start_matches('@').to_lowercase().into()])?
            .first::<MemberRow>(None)
            .await
    }

    /// How many owners a workspace has.
    pub(crate) async fn owner_count(&self, workspace_id: &str) -> Result<usize> {
        #[derive(Deserialize)]
        struct Count {
            owners: u32,
        }
        Ok(self
            .db
            .prepare("SELECT count(*) AS owners FROM workspace_members WHERE workspace_id = ? AND role = 'owner'")
            .bind(&[workspace_id.into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.owners as usize))
    }

    /// `update_member`: see [`UpdateMemberArgs`].
    pub async fn update_member(&self, a: UpdateMemberArgs) -> Result<Outcome<Member>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.owners_workspace(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(row) = self.member_row(&workspace_id, &a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_A_MEMBER));
        };
        if a.role.is_none() && a.org_roles.is_none() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give role or org_roles to change."));
        }
        let surface = a.surface.unwrap_or(Surface::Web);
        let role = a.role.unwrap_or(row.role);
        if row.role == Role::Owner
            && role == Role::Member
            && let Some(why) = last_owner_refusal(self.owner_count(&workspace_id).await?, true)
        {
            return Ok(Outcome::fail(FailureCode::Conflict, why));
        }
        let mut org_roles = a.org_roles.clone().unwrap_or_else(|| row.org_roles());
        org_roles.sort();
        org_roles.dedup();
        let billing = org_roles.contains(&OrgRole::BillingManager);
        let security = org_roles.contains(&OrgRole::SecurityManager);
        self.db
            .prepare(
                "UPDATE workspace_members SET role = ?, billing_manager = ?, security_manager = ?
                 WHERE workspace_id = ? AND user_id = ?",
            )
            .bind(&[
                role_words(role).into(),
                (billing as u8).into(),
                (security as u8).into(),
                workspace_id.as_str().into(),
                row.user_id.as_str().into(),
            ])?
            .run()
            .await?;
        if role != row.role {
            self.audit_workspace(
                &a.actor,
                "member.role_changed",
                &slug,
                surface,
                format!("Changed {}'s role from {} to {}", row.username, role_words(row.role), role_words(role)),
            )
            .await;
        }
        let before = row.org_roles();
        for changed in OrgRole::ALL {
            let (had, has) = (before.contains(&changed), org_roles.contains(&changed));
            if had != has {
                self.audit_workspace(
                    &a.actor,
                    if has { "member.org_role_added" } else { "member.org_role_removed" },
                    &slug,
                    surface,
                    if has {
                        format!("Made {} a {}", row.username, changed.label().to_lowercase())
                    } else {
                        format!("Took {} off as {}", row.username, changed.label().to_lowercase())
                    },
                )
                .await;
            }
        }
        let updated = MemberRow { role, billing_manager: billing as u8, security_manager: security as u8, ..row };
        Ok(Outcome::Ok(updated.member(None)))
    }

    /// `transfer_ownership`: see [`TransferOwnershipArgs`].
    pub async fn transfer_ownership(&self, a: TransferOwnershipArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.owners_workspace(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(row) = self.member_row(&workspace_id, &a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_A_MEMBER));
        };
        if row.user_id == a.actor.id {
            return Ok(Outcome::fail(FailureCode::Invalid, "Choose another member to hand the workspace to."));
        }
        // The new owner must be able to use the workspace: its policy holds
        // for owners too.
        if let Some(why) = self.policy_refusal(&row.user_id, &slug).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{} cannot own {slug} yet: {why}", row.username)));
        }
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?")
                    .bind(&[workspace_id.as_str().into(), row.user_id.as_str().into()])?,
                self.db
                    .prepare("UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?")
                    .bind(&[workspace_id.as_str().into(), a.actor.id.as_str().into()])?,
            ])
            .await?;
        self.audit_workspace(
            &a.actor,
            "workspace.ownership_transferred",
            &slug,
            a.surface.unwrap_or(Surface::Web),
            format!("Handed {slug} to {}: they are an owner, and {} a member", row.username, a.actor.username),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// `leave_workspace`: see [`LeaveWorkspaceArgs`].
    pub async fn leave_workspace(&self, a: LeaveWorkspaceArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person can leave a workspace, signed in as themselves."));
        }
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        // Read from the table, not the resolved user: someone held out by
        // the workspace's policy can still leave it.
        let Some(row) = self.member_row(&workspace_id, &a.user.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "You are not a member of this workspace."));
        };
        if row.role == Role::Owner
            && let Some(why) = last_owner_refusal(self.owner_count(&workspace_id).await?, true)
        {
            return Ok(Outcome::fail(FailureCode::Conflict, why));
        }
        self.drop_member(&workspace_id, &row.user_id).await?;
        self.audit_workspace(&a.user, "member.left", &slug, a.surface.unwrap_or(Surface::Web), format!("{} left {slug}", row.username))
            .await;
        Ok(Outcome::Ok(true))
    }

    /// Takes a person out of a workspace and every way into it: their roles
    /// on its repositories (access.rs) and their place in its teams
    /// (teams.rs). To keep them on a repository, add them to it again as an
    /// outside collaborator.
    pub(crate) async fn drop_member(&self, workspace_id: &str, user_id: &str) -> Result<()> {
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
                    .bind(&[workspace_id.into(), user_id.into()])?,
                self.db
                    .prepare(
                        "DELETE FROM repo_grants
                         WHERE workspace_id = ? AND principal_kind = 'user' AND principal_id = ?",
                    )
                    .bind(&[workspace_id.into(), user_id.into()])?,
                self.db
                    .prepare(
                        "DELETE FROM team_members
                         WHERE team_id IN (SELECT id FROM teams WHERE workspace_id = ?) AND user_id = ?",
                    )
                    .bind(&[workspace_id.into(), user_id.into()])?,
                // No one reports to them here any more, and they lead no team.
                self.db
                    .prepare("UPDATE workspace_members SET manager_id = NULL WHERE workspace_id = ? AND manager_id = ?")
                    .bind(&[workspace_id.into(), user_id.into()])?,
                self.db
                    .prepare("UPDATE teams SET lead_kind = NULL, lead_id = NULL WHERE workspace_id = ? AND lead_kind = 'user' AND lead_id = ?")
                    .bind(&[workspace_id.into(), user_id.into()])?,
            ])
            .await?;
        Ok(())
    }

    /// A workspace's member privileges, by its id.
    pub(crate) async fn privileges_of(&self, workspace_id: &str) -> Result<MemberPrivileges> {
        #[derive(Deserialize)]
        struct Row {
            member_privileges: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT member_privileges FROM workspaces WHERE id = ?")
            .bind(&[workspace_id.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| MemberPrivileges::from_stored(row.member_privileges.as_deref()))
            .unwrap_or_default())
    }

    /// `set_member_privileges`: see [`SetMemberPrivilegesArgs`].
    pub async fn set_member_privileges(&self, a: SetMemberPrivilegesArgs) -> Result<Outcome<MemberPrivileges>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.owners_workspace(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let before = self.privileges_of(&workspace_id).await?;
        let after = a.privileges.apply(before);
        if after == before {
            return Ok(Outcome::Ok(before));
        }
        let stored = serde_json::to_string(&after).unwrap_or_default();
        self.db
            .prepare("UPDATE workspaces SET member_privileges = ? WHERE id = ?")
            .bind(&[stored.into(), workspace_id.as_str().into()])?
            .run()
            .await?;
        for ((name, was), (_, now)) in before.listed().into_iter().zip(after.listed()) {
            if was != now {
                self.audit_workspace(
                    &a.actor,
                    "workspace.member_privileges_changed",
                    &slug,
                    a.surface.unwrap_or(Surface::Web),
                    format!("Turned {} {}", if now { "on" } else { "off" }, MemberPrivileges::describe(name)),
                )
                .await;
            }
        }
        self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        Ok(Outcome::Ok(after))
    }

    /// `set_two_factor_requirement`: see [`SetTwoFactorRequirementArgs`].
    pub async fn set_two_factor_requirement(&self, a: SetTwoFactorRequirementArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.owners_workspace(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if a.required && !self.two_factor_enabled(&a.actor.id).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "Turn on two-factor authentication for your own account before requiring it of everyone.",
            ));
        }
        let before = self.workspace_policy(&slug).await?.require_two_factor;
        if before == a.required {
            return Ok(Outcome::Ok(before));
        }
        self.db
            .prepare("UPDATE workspaces SET require_two_factor = ? WHERE id = ?")
            .bind(&[(a.required as u8).into(), workspace_id.as_str().into()])?
            .run()
            .await?;
        self.audit_workspace(
            &a.actor,
            if a.required { "workspace.two_factor_required" } else { "workspace.two_factor_not_required" },
            &slug,
            a.surface.unwrap_or(Surface::Web),
            if a.required {
                "Required two-factor authentication of members and outside collaborators".to_owned()
            } else {
                "Stopped requiring two-factor authentication".to_owned()
            },
        )
        .await;
        self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        Ok(Outcome::Ok(a.required))
    }

    /// `grant_creator`: see [`GrantCreatorArgs`].
    pub async fn grant_creator(&self, a: GrantCreatorArgs) -> Result<bool> {
        let Some(workspace_id) = self.workspace_id_of(&a.namespace.to_lowercase()).await? else {
            return Ok(false);
        };
        if !self.is_member_of(&workspace_id, &a.user_id).await? {
            return Ok(false);
        }
        self.insert_creator_grant(&a.repo_id, &workspace_id, &a.name, &a.user_id).await?;
        Ok(true)
    }

    async fn insert_creator_grant(&self, repo_id: &str, workspace_id: &str, name: &str, user_id: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        // Never lowers a role someone already gave them.
        self.db
            .prepare(
                "INSERT INTO repo_grants
                   (repo_id, principal_kind, principal_id, workspace_id, repo_name, role, granted_by, created_at, updated_at)
                 VALUES (?1, 'user', ?2, ?3, ?4, 'admin', NULL, ?5, ?5)
                 ON CONFLICT (repo_id, principal_kind, principal_id)
                 DO UPDATE SET role = 'admin', updated_at = excluded.updated_at",
            )
            .bind(&[repo_id.into(), user_id.into(), workspace_id.into(), name.into(), now.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Once, a page per run of the scheduled handler: the person who
    /// created each repository made before creators were given Admin gets
    /// it, if they are still a member of its workspace and lack it.
    pub async fn backfill_creator_grants(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Job {
            cursor: Option<String>,
            done_at: Option<String>,
        }
        let Some(job) = self
            .db
            .prepare("SELECT cursor, done_at FROM identity_jobs WHERE name = 'creator_grants'")
            .first::<Job>(None)
            .await?
        else {
            return Ok(());
        };
        if job.done_at.is_some() {
            return Ok(());
        }
        let page: CreatorPage = g1t_kit::call(
            &self.env.service("REPOS")?,
            "repo_creators",
            &AllIdsArgs { after: job.cursor.clone(), limit: 200 },
        )
        .await?;
        #[derive(Deserialize)]
        struct Standing {
            workspace_id: String,
            role: String,
            base_permission: String,
            direct: Option<String>,
        }
        for repo in &page.repos {
            let standing = self
                .db
                .prepare(
                    "SELECT w.id AS workspace_id, m.role, w.base_permission,
                       (SELECT g.role FROM repo_grants g WHERE g.repo_id = ?1 AND g.principal_kind = 'user' AND g.principal_id = ?2) AS direct
                     FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?2
                     WHERE w.slug = ?3 AND w.deleted_at IS NULL",
                )
                .bind(&[repo.id.as_str().into(), repo.owner_id.as_str().into(), repo.namespace.to_lowercase().into()])?
                .first::<Standing>(None)
                .await?;
            let Some(standing) = standing else { continue };
            let has_admin = standing.role == "owner" || standing.base_permission == "admin" || standing.direct.as_deref() == Some("admin");
            if !has_admin {
                self.insert_creator_grant(&repo.id, &standing.workspace_id, &repo.name, &repo.owner_id).await?;
            }
        }
        let (cursor, done): (JsValue, JsValue) = match &page.next {
            Some(next) => (next.as_str().into(), JsValue::NULL),
            None => (job.cursor.as_deref().map_or(JsValue::NULL, Into::into), rfc3339(now_ms()).into()),
        };
        self.db
            .prepare("UPDATE identity_jobs SET cursor = ?, done_at = ? WHERE name = 'creator_grants'")
            .bind(&[cursor, done])?
            .run()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(billing: u8, security: u8) -> MemberRow {
        MemberRow {
            user_id: "usr_1".into(),
            username: "ada".into(),
            display_username: Some("Ada".into()),
            role: Role::Member,
            name: None,
            avatar: None,
            billing_manager: billing,
            security_manager: security,
        }
    }

    #[test]
    fn a_member_keeps_their_usernames_chosen_case() {
        assert_eq!(row(0, 0).member(None).display_username.as_deref(), Some("Ada"));
        let plain = MemberRow { display_username: Some("ada".into()), ..row(0, 0) };
        assert_eq!(plain.member(None).display_username, None);
    }

    #[test]
    fn a_rows_flags_are_its_org_roles() {
        assert!(row(0, 0).org_roles().is_empty());
        assert_eq!(row(1, 0).org_roles(), vec![OrgRole::BillingManager]);
        assert_eq!(row(1, 1).org_roles(), vec![OrgRole::BillingManager, OrgRole::SecurityManager]);
        let member = row(0, 1).member(Some(true));
        assert_eq!(member.org_roles, vec![OrgRole::SecurityManager]);
        assert_eq!(member.two_factor, Some(true));
    }
}
