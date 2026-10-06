//! Who has access to a repository: roles given on one repository, the
//! invitations that offer them, and each workspace's base permission.
//!
//! The rules (which role may do what, and how a person's role is worked
//! out) live in `g1t_contracts::access`; this is where the roles are kept.
//! Every user identity resolves carries their grants ([`Identity::grants_of`],
//! under the workspace's policy) beside their memberships, so services
//! decide with `access::can` and never call here to authorize.
//!
//! **Adding someone** to a repository (Admin only, a person, never an
//! agent's or a workspace's token):
//!
//! - a member of its workspace gets the role at once: it only matters when
//!   it is higher than the base permission;
//! - anyone else with an account (by username, or a confirmed address) is
//!   sent an invitation, which they accept or decline; it lasts
//!   [`INVITATION_DAYS`];
//! - an address without an account is sent an invite code (invites.rs,
//!   charged as a workspace invite is) that makes the account and accepts.
//!
//! Accepting is checked against the workspace's policy (security.rs), as
//! joining it is. Removing someone from a workspace takes away their roles
//! on its repositories (workspaces.rs); a repository that is purged takes
//! its grants and invitations with it (`forget_repo_access`); a transfer or
//! rename keeps them (deletion.rs, `transfer_repo_scopes`).
//!
//! **Teams** slot in as another `principal_kind` in `repo_grants`,
//! resolved into the same `RepoGrant`s for each person in the team.

use g1t_contracts::access::*;
use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::events::{NewEvent, Publish, RepoCollaborator};
use g1t_contracts::repos::{GetArgs, Repo, RepoPath};
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::invites::normalize_email;

/// How long an invitation to someone with an account waits for an answer.
pub const INVITATION_DAYS: u64 = 7;
/// The most direct grants one person carries on every request.
const MAX_GRANTS: u32 = 1000;
/// The most people or invitations one list shows.
const LIST_LIMIT: u32 = 500;

const PEOPLE_ONLY: &str =
    "Only a person can change who has access to a repository, signed in as themselves; never an agent's or a workspace's token.";
const CONFIRM_FIRST: &str = "Confirm your email address before changing who has access.";
const NO_SUCH_USER: &str = "There is no account with that username.";

/// What was typed into "Add people".
#[derive(Debug, PartialEq, Eq)]
pub enum Invitee {
    Username(String),
    Email(String),
}

/// A username, or an email address, as typed; `None` if it is neither.
pub fn invitee(text: &str) -> Option<Invitee> {
    let text = text.trim().trim_start_matches('@');
    if text.contains('@') {
        return normalize_email(text).map(Invitee::Email);
    }
    let name = text.to_lowercase();
    g1t_contracts::is_valid_namespace(&name).then_some(Invitee::Username(name))
}

/// A person's role on a repository, and where it comes from: ownership,
/// the base permission, or a direct grant. A direct grant at least as high
/// as the base is shown as direct, so it can be changed where it was given.
pub fn effective(owner: bool, base: Option<RepoRole>, direct: Option<RepoRole>) -> Option<(RepoRole, AccessSource)> {
    if owner {
        return Some((RepoRole::Admin, AccessSource::Owner));
    }
    match (base, direct) {
        (base, Some(direct)) if base.is_none_or(|base| direct >= base) => Some((direct, AccessSource::Direct)),
        (Some(base), _) => Some((base, AccessSource::Base)),
        (None, None) => None,
        (None, Some(_)) => unreachable!("handled above"),
    }
}

/// Where an invitation stands at `now`.
pub fn invitation_status(row: &InvitationRow, now: &str) -> RepoInvitationStatus {
    if row.accepted_at.is_some() {
        RepoInvitationStatus::Accepted
    } else if row.declined_at.is_some() {
        RepoInvitationStatus::Declined
    } else if row.revoked_at.is_some() {
        RepoInvitationStatus::Revoked
    } else if row.expires_at.as_str() <= now {
        RepoInvitationStatus::Expired
    } else {
        RepoInvitationStatus::Pending
    }
}

#[derive(Deserialize)]
struct GrantRow {
    repo_id: String,
    workspace: String,
    role: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct InvitationRow {
    pub id: String,
    pub repo_id: String,
    pub workspace: String,
    pub workspace_id: String,
    pub repo_name: String,
    pub invitee: Option<String>,
    pub email: Option<String>,
    pub invite_id: Option<String>,
    pub role: String,
    pub inviter_id: Option<String>,
    pub inviter: Option<String>,
    #[serde(default)]
    pub inviter_avatar: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub accepted_at: Option<String>,
    pub declined_at: Option<String>,
    pub revoked_at: Option<String>,
}

impl InvitationRow {
    fn role(&self) -> RepoRole {
        RepoRole::parse(&self.role).unwrap_or(RepoRole::Read)
    }

    fn shown(&self, now: &str, with_email: bool) -> RepoInvitation {
        RepoInvitation {
            id: self.id.clone(),
            repo: format!("{}/{}", self.workspace, self.repo_name),
            repo_id: self.repo_id.clone(),
            invitee: self.invitee.clone(),
            email: if with_email { self.email.clone() } else { None },
            role: self.role(),
            invited_by: self.inviter.clone(),
            inviter_avatar: self.inviter_avatar.clone(),
            status: invitation_status(self, now),
            created_at: self.created_at.clone(),
            expires_at: self.expires_at.clone(),
        }
    }
}

const INVITATION_COLUMNS: &str = "ri.id, ri.repo_id, w.slug AS workspace, ri.workspace_id, ri.repo_name,
  ri.invitee_id, invitee.username AS invitee, ri.email, ri.invite_id, ri.role, ri.inviter_id, inviter.username AS inviter, inviter.avatar AS inviter_avatar,
  ri.created_at, ri.expires_at, ri.accepted_at, ri.declined_at, ri.revoked_at
  FROM repo_invitations ri
  JOIN workspaces w ON w.id = ri.workspace_id
  LEFT JOIN users invitee ON invitee.id = ri.invitee_id
  LEFT JOIN users inviter ON inviter.id = ri.inviter_id";

/// A person as an access list shows them.
#[derive(Deserialize)]
struct PersonRow {
    username: String,
    name: Option<String>,
    avatar: Option<String>,
    /// `owner` or `member`; null when they are not in the workspace.
    #[serde(default)]
    workspace_role: Option<String>,
    /// Their direct grant on the repository, if any.
    #[serde(default)]
    direct: Option<String>,
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct Base {
    base_permission: String,
}

/// A repository by id and path: what events and the audit log name.
#[derive(Clone, Copy)]
struct Named<'a> {
    id: &'a str,
    namespace: &'a str,
    name: &'a str,
}

impl<'a> From<&'a Repo> for Named<'a> {
    fn from(repo: &'a Repo) -> Self {
        Named {
            id: &repo.id,
            namespace: &repo.namespace,
            name: &repo.name,
        }
    }
}

/// A repository someone may manage the access of, with its workspace's id.
struct Target {
    repo: Repo,
    workspace_id: String,
}

fn opt(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

fn full_name(repo: &Repo) -> String {
    format!("{}/{}", repo.namespace, repo.name)
}

impl Identity {
    /// Every repository `user_id` has a role on directly, with the slug of
    /// its workspace now. Attached to every user resolved from credentials.
    pub async fn grants_of(&self, user_id: &str) -> Result<Vec<RepoGrant>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT g.repo_id, w.slug AS workspace, g.role FROM repo_grants g
                 JOIN workspaces w ON w.id = g.workspace_id
                 WHERE g.principal_kind = 'user' AND g.principal_id = ?
                 ORDER BY g.created_at LIMIT {MAX_GRANTS}"
            ))
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<GrantRow>()?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                Some(RepoGrant {
                    repo_id: row.repo_id,
                    workspace: row.workspace,
                    role: RepoRole::parse(&row.role)?,
                })
            })
            .collect())
    }

    /// The repository at `path` as `viewer` sees it: missing when they
    /// cannot read it. Asked of repos, which owns visibility.
    async fn repo_for(&self, path: &RepoPath, viewer: &Viewer) -> Result<Option<Repo>> {
        let repos = self.env.service("REPOS")?;
        let found: Outcome<Repo> = g1t_kit::call(
            &repos,
            "get",
            &GetArgs {
                path: path.clone(),
                viewer: viewer.clone(),
            },
        )
        .await?;
        Ok(match found {
            // A pull request's working copy has no access of its own.
            Outcome::Ok(repo) if repo.fork_of.is_none() => Some(repo),
            _ => None,
        })
    }

    pub(crate) async fn workspace_id_of(&self, slug: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .prepare("SELECT id FROM workspaces WHERE slug = ?")
            .bind(&[slug.to_lowercase().into()])?
            .first::<Id>(None)
            .await?
            .map(|row| row.id))
    }

    async fn base_of(&self, workspace_id: &str) -> Result<BasePermission> {
        Ok(self
            .db
            .prepare("SELECT base_permission FROM workspaces WHERE id = ?")
            .bind(&[workspace_id.into()])?
            .first::<Base>(None)
            .await?
            .and_then(|row| BasePermission::parse(&row.base_permission))
            .unwrap_or_default())
    }

    /// The repository at `path`, if `actor` may change who has access to it.
    async fn manageable(&self, actor: &User, path: &RepoPath) -> Result<Outcome<Target>> {
        if !crate::security::is_person(actor) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        let viewer = Some(actor.clone());
        let Some(repo) = self.repo_for(path, &viewer).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        if !can(Some(actor), &repo, Capability::ManageAccess) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                needs(Capability::ManageAccess, &full_name(&repo)),
            ));
        }
        if !actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, CONFIRM_FIRST));
        }
        let Some(workspace_id) = self.workspace_id_of(&repo.namespace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        Ok(Outcome::Ok(Target { repo, workspace_id }))
    }

    /// The members of the repository's workspace and the people with a
    /// direct grant on it, each once.
    async fn people_rows(&self, repo_id: &str, workspace_id: &str) -> Result<Vec<PersonRow>> {
        self.db
            .prepare(format!(
                "SELECT u.id, u.username, u.display_name AS name, u.avatar,
                   m.role AS workspace_role, g.role AS direct
                 FROM users u
                 LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?2
                 LEFT JOIN repo_grants g ON g.principal_kind = 'user' AND g.principal_id = u.id AND g.repo_id = ?1
                 WHERE m.user_id IS NOT NULL OR g.principal_id IS NOT NULL
                 ORDER BY u.username LIMIT {LIST_LIMIT}"
            ))
            .bind(&[repo_id.into(), workspace_id.into()])?
            .all()
            .await?
            .results::<PersonRow>()
    }

    fn collaborator(row: PersonRow, base: BasePermission) -> Option<Collaborator> {
        let workspace_role = match row.workspace_role.as_deref() {
            Some("owner") => Some(Role::Owner),
            Some(_) => Some(Role::Member),
            None => None,
        };
        let direct = row.direct.as_deref().and_then(RepoRole::parse);
        let base_role = workspace_role.and(base.role());
        let (role, source) = effective(workspace_role == Some(Role::Owner), base_role, direct)?;
        Some(Collaborator {
            username: row.username,
            name: row.name,
            avatar: row.avatar,
            role,
            source,
            direct,
            workspace_role,
        })
    }

    async fn invitations(&self, filter: &str, binds: &[JsValue]) -> Result<Vec<InvitationRow>> {
        self.db
            .prepare(format!("SELECT {INVITATION_COLUMNS} {filter} ORDER BY ri.created_at DESC LIMIT {LIST_LIMIT}"))
            .bind(binds)?
            .all()
            .await?
            .results::<InvitationRow>()
    }

    async fn pending_invitations(&self, filter: &str, binds: &[JsValue]) -> Result<Vec<InvitationRow>> {
        let filter = format!(
            "{filter} AND ri.accepted_at IS NULL AND ri.declined_at IS NULL AND ri.revoked_at IS NULL
               AND ri.expires_at > {SQL_NOW}"
        );
        self.invitations(&filter, binds).await
    }

    pub async fn repo_access(&self, a: RepoAccessArgs) -> Result<Outcome<RepoAccess>> {
        let Some(repo) = self.repo_for(&a.path, &a.viewer).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        let viewer_role = a.viewer.as_ref().and_then(|viewer| granted(viewer, (&repo).into()));
        // Like the list of collaborators: for those who can push.
        if !viewer_role.is_some_and(|role| role >= RepoRole::Write) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("You need the Write role or higher on {} to see who has access.", full_name(&repo)),
            ));
        }
        let can_manage = can(a.viewer.as_ref(), &repo, Capability::ManageAccess);
        let Some(workspace_id) = self.workspace_id_of(&repo.namespace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        let base = self.base_of(&workspace_id).await?;
        let mut people: Vec<Collaborator> = self
            .people_rows(&repo.id, &workspace_id)
            .await?
            .into_iter()
            .filter_map(|row| Self::collaborator(row, base))
            .collect();
        people.sort_by(|a, b| b.role.cmp(&a.role).then_with(|| a.username.cmp(&b.username)));
        let invitations = if can_manage {
            let now = rfc3339(now_ms());
            self.pending_invitations("WHERE ri.repo_id = ?", &[repo.id.as_str().into()])
                .await?
                .iter()
                .map(|row| row.shown(&now, true))
                .collect()
        } else {
            Vec::new()
        };
        Ok(Outcome::Ok(RepoAccess {
            repo: full_name(&repo),
            base_permission: base,
            people,
            invitations,
            viewer_role,
            can_manage,
        }))
    }

    /// One person's place on the repository, as the access list shows it.
    async fn collaborator_on(&self, repo: &Repo, workspace_id: &str, user_id: &str) -> Result<Option<Collaborator>> {
        let base = self.base_of(workspace_id).await?;
        let row = self
            .db
            .prepare(
                "SELECT u.id, u.username, u.display_name AS name, u.avatar,
                   m.role AS workspace_role, g.role AS direct
                 FROM users u
                 LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ?2
                 LEFT JOIN repo_grants g ON g.principal_kind = 'user' AND g.principal_id = u.id AND g.repo_id = ?1
                 WHERE u.id = ?3",
            )
            .bind(&[repo.id.as_str().into(), workspace_id.into(), user_id.into()])?
            .first::<PersonRow>(None)
            .await?;
        Ok(row.and_then(|row| Self::collaborator(row, base)))
    }

    async fn person_by_username(&self, username: &str) -> Result<Option<(String, String)>> {
        #[derive(Deserialize)]
        struct Person {
            id: String,
            username: String,
        }
        Ok(self
            .db
            .prepare("SELECT id, username FROM users WHERE username = ?")
            .bind(&[username.trim().trim_start_matches('@').to_lowercase().into()])?
            .first::<Person>(None)
            .await?
            .map(|person| (person.id, person.username)))
    }

    async fn is_member_of(&self, workspace_id: &str, user_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT user_id AS id FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
            .bind(&[workspace_id.into(), user_id.into()])?
            .first::<Id>(None)
            .await?
            .is_some())
    }

    async fn direct_role(&self, repo_id: &str, user_id: &str) -> Result<Option<RepoRole>> {
        #[derive(Deserialize)]
        struct RoleRow {
            role: String,
        }
        Ok(self
            .db
            .prepare("SELECT role FROM repo_grants WHERE repo_id = ? AND principal_kind = 'user' AND principal_id = ?")
            .bind(&[repo_id.into(), user_id.into()])?
            .first::<RoleRow>(None)
            .await?
            .and_then(|row| RepoRole::parse(&row.role)))
    }

    /// Gives `user_id` `role` on the repository, or changes the role they
    /// have; returns the role they had before.
    async fn put_grant(
        &self,
        repo_id: &str,
        workspace_id: &str,
        repo_name: &str,
        user_id: &str,
        role: RepoRole,
        granted_by: Option<&str>,
    ) -> Result<Option<RepoRole>> {
        let previous = self.direct_role(repo_id, user_id).await?;
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO repo_grants
                   (repo_id, principal_kind, principal_id, workspace_id, repo_name, role, granted_by, created_at, updated_at)
                 VALUES (?1, 'user', ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (repo_id, principal_kind, principal_id)
                 DO UPDATE SET role = excluded.role, workspace_id = excluded.workspace_id,
                   repo_name = excluded.repo_name, updated_at = excluded.updated_at",
            )
            .bind(&[
                repo_id.into(),
                user_id.into(),
                workspace_id.into(),
                repo_name.into(),
                role.as_str().into(),
                opt(granted_by),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(previous)
    }

    pub async fn add_collaborator(&self, a: AddCollaboratorArgs) -> Result<Outcome<Added>> {
        let Target { repo, workspace_id } = match self.manageable(&a.actor, &a.path).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let surface = a.surface.unwrap_or(Surface::Web);
        let invitee = match invitee(&a.invitee) {
            Some(invitee) => invitee,
            None => return Ok(Outcome::fail(FailureCode::Invalid, "Enter a username or an email address.")),
        };
        // Who it names: an account by username, or by a confirmed address.
        let person = match &invitee {
            Invitee::Username(name) => match self.person_by_username(name).await? {
                Some(person) => Some(person),
                None => return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER)),
            },
            Invitee::Email(email) => match self.user_with_verified_email(email).await? {
                Some(id) => self
                    .find_public_user(
                        "SELECT id, username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ?",
                        &id,
                    )
                    .await?
                    .map(|user| (user.id, user.username)),
                None => None,
            },
        };
        let Some((user_id, username)) = person else {
            let Invitee::Email(email) = invitee else {
                return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
            };
            return self.invite_address(&a.actor, &repo, &workspace_id, &email, a.role, surface).await;
        };
        // What the workspace asks of anyone with access to it (security.rs).
        if let Some(why) = self.policy_refusal(&user_id, &repo.namespace).await? {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        if self.is_member_of(&workspace_id, &user_id).await? {
            let previous = self
                .put_grant(&repo.id, &workspace_id, &repo.name, &user_id, a.role, Some(&a.actor.id))
                .await?;
            self.changed(&a.actor, (&repo).into(), &username, Some(a.role), previous, surface).await;
            let Some(collaborator) = self.collaborator_on(&repo, &workspace_id, &user_id).await? else {
                return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
            };
            return Ok(Outcome::Ok(Added::Granted { collaborator }));
        }
        if self.direct_role(&repo.id, &user_id).await?.is_some() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{username} already has access to {}. Change their role instead.", full_name(&repo)),
            ));
        }
        let pending = self
            .pending_invitations(
                "WHERE ri.repo_id = ? AND ri.invitee_id = ?",
                &[repo.id.as_str().into(), user_id.as_str().into()],
            )
            .await?;
        if !pending.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{username} already has a pending invitation to {}. Change its role, or revoke it to send a new one.", full_name(&repo)),
            ));
        }
        let id = self
            .insert_invitation(&repo, &workspace_id, Some(&user_id), None, None, a.role, &a.actor.id, INVITATION_DAYS)
            .await?;
        let now = rfc3339(now_ms());
        let Some(row) = self.invitation_by_id(&id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Invitation not found."));
        };
        // Told by email, at their primary address and the one typed.
        let mut to = self.notice_recipients(&user_id, false).await.unwrap_or_default();
        if let Invitee::Email(email) = &invitee
            && !to.iter().any(|address| address.eq_ignore_ascii_case(email))
        {
            to.push(email.clone());
        }
        for address in to.iter().take(2) {
            if let Err(error) = crate::email::send_repo_invite(
                &self.env,
                address,
                &a.actor.username,
                &full_name(&repo),
                a.role.label(),
                None,
                INVITATION_DAYS,
            )
            .await
            {
                worker::console_error!("repository invitation email failed: {error}");
            }
        }
        self.audit(&a.actor, "repo.invitation_created", (&repo).into(), surface, format!("Invited {username} as {}", a.role.label()))
            .await;
        Ok(Outcome::Ok(Added::Invited {
            invitation: row.shown(&now, true),
        }))
    }

    /// An address without an account: an invite code that makes it and
    /// accepts (invites.rs).
    async fn invite_address(
        &self,
        actor: &User,
        repo: &Repo,
        workspace_id: &str,
        email: &str,
        role: RepoRole,
        surface: Surface,
    ) -> Result<Outcome<Added>> {
        let pending = self
            .pending_invitations(
                "WHERE ri.repo_id = ? AND ri.email = ?",
                &[repo.id.as_str().into(), email.into()],
            )
            .await?;
        if !pending.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "That address already has a pending invitation to this repository. Revoke it to send a new one.",
            ));
        }
        let invite = match self.repo_invite_code(actor, email, workspace_id).await? {
            Outcome::Ok(invite) => invite,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let days = self.invite_days();
        let id = self
            .insert_invitation(repo, workspace_id, None, Some(email), Some(&invite.id), role, &actor.id, days)
            .await?;
        if let Some(code) = &invite.code
            && let Err(error) = crate::email::send_repo_invite(
                &self.env,
                email,
                &actor.username,
                &full_name(repo),
                role.label(),
                Some(code),
                days,
            )
            .await
        {
            worker::console_error!("repository invitation email failed: {error}");
        }
        self.audit(
            actor,
            "repo.invitation_created",
            repo.into(),
            surface,
            format!("Invited {} as {}", crate::invites::mask_email(email), role.label()),
        )
        .await;
        let now = rfc3339(now_ms());
        Ok(match self.invitation_by_id(&id).await? {
            Some(row) => Outcome::Ok(Added::Invited {
                invitation: row.shown(&now, true),
            }),
            None => Outcome::fail(FailureCode::NotFound, "Invitation not found."),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_invitation(
        &self,
        repo: &Repo,
        workspace_id: &str,
        invitee_id: Option<&str>,
        email: Option<&str>,
        invite_id: Option<&str>,
        role: RepoRole,
        inviter_id: &str,
        days: u64,
    ) -> Result<String> {
        let now = now_ms();
        let id = new_id("rin", now);
        self.db
            .prepare(
                "INSERT INTO repo_invitations
                   (id, repo_id, workspace_id, repo_name, invitee_id, email, invite_id, role, inviter_id, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                workspace_id.into(),
                repo.name.as_str().into(),
                opt(invitee_id),
                opt(email),
                opt(invite_id),
                role.as_str().into(),
                inviter_id.into(),
                rfc3339(now).into(),
                rfc3339(now + days * 86_400_000).into(),
            ])?
            .run()
            .await?;
        Ok(id)
    }

    async fn invitation_by_id(&self, id: &str) -> Result<Option<InvitationRow>> {
        Ok(self
            .invitations("WHERE ri.id = ?", &[id.into()])
            .await?
            .into_iter()
            .next())
    }

    fn invite_days(&self) -> u64 {
        self.env
            .var("INVITE_TTL_DAYS")
            .ok()
            .and_then(|value| value.to_string().parse().ok())
            .unwrap_or(g1t_contracts::identity::INVITE_TTL_DAYS)
    }

    pub async fn set_collaborator_role(&self, a: SetCollaboratorRoleArgs) -> Result<Outcome<Collaborator>> {
        let Target { repo, workspace_id } = match self.manageable(&a.actor, &a.path).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some((user_id, username)) = self.person_by_username(&a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
        };
        let surface = a.surface.unwrap_or(Surface::Web);
        match self.direct_role(&repo.id, &user_id).await? {
            Some(previous) => {
                self.put_grant(&repo.id, &workspace_id, &repo.name, &user_id, a.role, Some(&a.actor.id))
                    .await?;
                if previous != a.role {
                    self.changed(&a.actor, (&repo).into(), &username, Some(a.role), Some(previous), surface).await;
                }
            }
            None => {
                // A pending invitation's role changes until it is answered.
                let changed = self
                    .db
                    .prepare(format!(
                        "UPDATE repo_invitations SET role = ?1
                         WHERE repo_id = ?2 AND invitee_id = ?3 AND accepted_at IS NULL AND declined_at IS NULL
                           AND revoked_at IS NULL AND expires_at > {SQL_NOW}
                         RETURNING id"
                    ))
                    .bind(&[a.role.as_str().into(), repo.id.as_str().into(), user_id.as_str().into()])?
                    .first::<Id>(None)
                    .await?;
                if changed.is_none() {
                    return Ok(Outcome::fail(
                        FailureCode::NotFound,
                        format!(
                            "{username} has no role of their own on {}. Owners have Admin, and members the base permission; add them to give them more.",
                            full_name(&repo)
                        ),
                    ));
                }
            }
        }
        Ok(match self.collaborator_on(&repo, &workspace_id, &user_id).await? {
            Some(collaborator) => Outcome::Ok(collaborator),
            // Invited, not yet a collaborator: say what they will be.
            None => Outcome::Ok(Collaborator {
                username,
                name: None,
                avatar: None,
                role: a.role,
                source: AccessSource::Direct,
                direct: Some(a.role),
                workspace_role: None,
            }),
        })
    }

    pub async fn remove_collaborator(&self, a: RemoveCollaboratorArgs) -> Result<Outcome<bool>> {
        let Some((user_id, username)) = self.person_by_username(&a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
        };
        let surface = a.surface.unwrap_or(Surface::Web);
        // Anyone may give up their own role; otherwise, Admin only.
        let leaving = crate::security::is_person(&a.actor) && a.actor.id == user_id;
        let repo = if leaving {
            match self.repo_for(&a.path, &Some(a.actor.clone())).await? {
                Some(repo) => repo,
                None => return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found.")),
            }
        } else {
            match self.manageable(&a.actor, &a.path).await? {
                Outcome::Ok(target) => target.repo,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            }
        };
        let Some(previous) = self.direct_role(&repo.id, &user_id).await? else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!(
                    "{username} has no role of their own on {}. To take away a member's access, change the base permission or remove them from the workspace.",
                    full_name(&repo)
                ),
            ));
        };
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM repo_grants WHERE repo_id = ? AND principal_kind = 'user' AND principal_id = ?")
                    .bind(&[repo.id.as_str().into(), user_id.as_str().into()])?,
                self.db
                    .prepare(format!(
                        "UPDATE repo_invitations SET revoked_at = {SQL_NOW}
                         WHERE repo_id = ? AND invitee_id = ? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL"
                    ))
                    .bind(&[repo.id.as_str().into(), user_id.as_str().into()])?,
            ])
            .await?;
        self.changed(&a.actor, (&repo).into(), &username, None, Some(previous), surface).await;
        Ok(Outcome::Ok(true))
    }

    pub async fn collaborator_permission(&self, a: CollaboratorPermissionArgs) -> Result<Outcome<PermissionInfo>> {
        let Some(repo) = self.repo_for(&a.path, &a.viewer).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        let asking_about_self = a
            .viewer
            .as_ref()
            .is_some_and(|viewer| viewer.username.eq_ignore_ascii_case(a.username.trim()));
        if !asking_about_self && !can(a.viewer.as_ref(), &repo, Capability::Push) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("You need the Write role or higher on {} to see others' permissions.", full_name(&repo)),
            ));
        }
        let Some((user_id, username)) = self.person_by_username(&a.username).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_USER));
        };
        let Some(workspace_id) = self.workspace_id_of(&repo.namespace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        // Held to the workspace's policy as their requests are.
        let within = self.policy_refusal(&user_id, &repo.namespace).await?.is_none();
        let place = if within {
            self.collaborator_on(&repo, &workspace_id, &user_id).await?
        } else {
            None
        };
        let role = place.as_ref().map(|place| place.role);
        Ok(Outcome::Ok(PermissionInfo {
            username,
            role,
            source: place.map(|place| place.source),
            capabilities: capabilities_of(role),
        }))
    }

    pub async fn my_repo_invitations(&self, a: MyRepoInvitationsArgs) -> Result<Vec<RepoInvitation>> {
        if !crate::security::is_person(&a.user) {
            return Ok(Vec::new());
        }
        let now = rfc3339(now_ms());
        Ok(self
            .invitations_for(&a.user, None)
            .await?
            .iter()
            .map(|row| row.shown(&now, false))
            .collect())
    }

    /// The pending invitations for `user`: sent to them, or to one of
    /// their confirmed addresses before they had an account (and made it
    /// some other way than with the code). `id` narrows it to one.
    async fn invitations_for(&self, user: &User, id: Option<&str>) -> Result<Vec<InvitationRow>> {
        let emails = serde_json::to_string(&self.verified_emails(&user.id).await?)?;
        let mut filter = "WHERE (ri.invitee_id = ? OR (ri.invitee_id IS NULL AND ri.email IN (SELECT value FROM json_each(?))))".to_owned();
        let mut binds = vec![JsValue::from(user.id.as_str()), emails.into()];
        if let Some(id) = id {
            filter.push_str(" AND ri.id = ?");
            binds.push(id.into());
        }
        self.pending_invitations(&filter, &binds).await
    }

    pub async fn respond_repo_invitation(&self, a: RespondRepoInvitationArgs) -> Result<Outcome<RepoInvitation>> {
        if !crate::security::is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person can answer an invitation."));
        }
        let now = rfc3339(now_ms());
        let row = self
            .invitations_for(&a.user, Some(&a.id))
            .await?
            .into_iter()
            .next();
        let Some(row) = row else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                "There is no pending invitation of yours with that id. It may have expired or been revoked.",
            ));
        };
        if !a.accept {
            self.db
                .prepare(format!("UPDATE repo_invitations SET declined_at = {SQL_NOW} WHERE id = ?"))
                .bind(&[row.id.as_str().into()])?
                .run()
                .await?;
            let mut shown = row.shown(&now, false);
            shown.status = RepoInvitationStatus::Declined;
            return Ok(Outcome::Ok(shown));
        }
        if let Some(why) = self.policy_refusal(&a.user.id, &row.workspace).await? {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        self.accept(&row, &a.user).await?;
        let mut shown = row.shown(&now, false);
        shown.status = RepoInvitationStatus::Accepted;
        Ok(Outcome::Ok(shown))
    }

    /// Turns an invitation into a grant, once.
    async fn accept(&self, row: &InvitationRow, user: &User) -> Result<()> {
        let claimed = self
            .db
            .prepare(format!(
                "UPDATE repo_invitations SET accepted_at = {SQL_NOW}, invitee_id = ?1
                 WHERE id = ?2 AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
                 RETURNING id"
            ))
            .bind(&[user.id.as_str().into(), row.id.as_str().into()])?
            .first::<Id>(None)
            .await?;
        if claimed.is_none() {
            return Ok(());
        }
        let role = row.role();
        // Never lowers a role they already have.
        let current = self.direct_role(&row.repo_id, &user.id).await?;
        let role = current.map_or(role, |current| current.max(role));
        let previous = self
            .put_grant(&row.repo_id, &row.workspace_id, &row.repo_name, &user.id, role, row.inviter_id.as_deref())
            .await?;
        let repo = Named {
            id: &row.repo_id,
            namespace: &row.workspace,
            name: &row.repo_name,
        };
        self.changed(user, repo, &user.username, Some(role), previous, Surface::Web).await;
        Ok(())
    }

    /// The repository an invite code was sent with, for the invite's page
    /// (invites.rs): whatever became of the invitation since.
    pub(crate) async fn repository_of_code(
        &self,
        invite_id: &str,
    ) -> Result<Option<g1t_contracts::identity::InviteRepository>> {
        Ok(self
            .invitations("WHERE ri.invite_id = ?", &[invite_id.into()])
            .await?
            .into_iter()
            .next()
            .map(|row| g1t_contracts::identity::InviteRepository {
                name: format!("{}/{}", row.workspace, row.repo_name),
                role: row.role().as_str().to_owned(),
            }))
    }

    /// Accepts the repository invitations sent with an invite code, once
    /// the code made `user`'s account (invites.rs).
    pub(crate) async fn accept_invitations_of_code(&self, invite_id: &str, user: &User) -> Result<()> {
        let rows = self
            .pending_invitations("WHERE ri.invite_id = ?", &[invite_id.into()])
            .await?;
        for row in rows {
            if self.policy_refusal(&user.id, &row.workspace).await?.is_some() {
                continue;
            }
            self.accept(&row, user).await?;
        }
        Ok(())
    }

    pub async fn revoke_repo_invitation(&self, a: RevokeRepoInvitationArgs) -> Result<Outcome<RepoInvitation>> {
        let Target { repo, .. } = match self.manageable(&a.actor, &a.path).await? {
            Outcome::Ok(target) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let revoked = self
            .db
            .prepare(format!(
                "UPDATE repo_invitations SET revoked_at = {SQL_NOW}
                 WHERE id = ? AND repo_id = ? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
                 RETURNING id"
            ))
            .bind(&[a.id.as_str().into(), repo.id.as_str().into()])?
            .first::<Id>(None)
            .await?;
        if revoked.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no pending invitation with that id."));
        }
        let Some(row) = self.invitation_by_id(&a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Invitation not found."));
        };
        if let Some(invite_id) = &row.invite_id {
            self.revoke_code(invite_id).await?;
        }
        let who = row
            .invitee
            .clone()
            .or_else(|| row.email.as_deref().map(crate::invites::mask_email))
            .unwrap_or_default();
        self.audit(
            &a.actor,
            "repo.invitation_revoked",
            (&repo).into(),
            a.surface.unwrap_or(Surface::Web),
            format!("Revoked the invitation to {who}"),
        )
        .await;
        Ok(Outcome::Ok(row.shown(&rfc3339(now_ms()), true)))
    }

    pub async fn set_base_permission(&self, a: SetBasePermissionArgs) -> Result<Outcome<BasePermission>> {
        let slug = a.slug.trim().to_lowercase();
        if !crate::security::is_person(&a.actor) || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can change what members get on every repository.",
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, CONFIRM_FIRST));
        }
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let previous = self.base_of(&workspace_id).await?;
        self.db
            .prepare("UPDATE workspaces SET base_permission = ? WHERE id = ?")
            .bind(&[a.base_permission.as_str().into(), workspace_id.as_str().into()])?
            .run()
            .await?;
        if previous != a.base_permission {
            self.audit_workspace(
                &a.actor,
                "workspace.base_permission_changed",
                &slug,
                a.surface.unwrap_or(Surface::Web),
                format!(
                    "Changed the base permission from {} to {}",
                    previous.as_str(),
                    a.base_permission.as_str()
                ),
            )
            .await;
            self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        }
        Ok(Outcome::Ok(a.base_permission))
    }

    pub async fn outside_collaborators(&self, a: OutsideCollaboratorsArgs) -> Result<Outcome<Vec<OutsideCollaborator>>> {
        let slug = a.slug.trim().to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.role_in(&slug) == Some(Role::Owner)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only owners can see a workspace's outside collaborators."));
        }
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        #[derive(Deserialize)]
        struct Row {
            username: String,
            name: Option<String>,
            avatar: Option<String>,
            repo_name: String,
            role: String,
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT u.username, u.display_name AS name, u.avatar, g.repo_name, g.role
                 FROM repo_grants g JOIN users u ON u.id = g.principal_id
                 WHERE g.workspace_id = ?1 AND g.principal_kind = 'user'
                   AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = ?1 AND m.user_id = g.principal_id)
                 ORDER BY u.username, g.repo_name LIMIT {LIST_LIMIT}"
            ))
            .bind(&[workspace_id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut people: Vec<OutsideCollaborator> = Vec::new();
        for row in rows {
            let Some(role) = RepoRole::parse(&row.role) else {
                continue;
            };
            let repo = CollaboratorRepo {
                repo: format!("{slug}/{}", row.repo_name),
                role,
            };
            match people.last_mut().filter(|person| person.username == row.username) {
                Some(person) => person.repos.push(repo),
                None => people.push(OutsideCollaborator {
                    username: row.username,
                    name: row.name,
                    avatar: row.avatar,
                    repos: vec![repo],
                }),
            }
        }
        Ok(Outcome::Ok(people))
    }

    pub async fn forget_repo_access(&self, a: ForgetRepoAccessArgs) -> Result<bool> {
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM repo_grants WHERE repo_id = ?")
                    .bind(&[a.repo_id.as_str().into()])?,
                self.db
                    .prepare("DELETE FROM repo_invitations WHERE repo_id = ?")
                    .bind(&[a.repo_id.as_str().into()])?,
            ])
            .await?;
        Ok(true)
    }

    /// A repository moved or was renamed: its grants and invitations follow
    /// it (deletion.rs, `transfer_repo_scopes`).
    pub(crate) async fn move_repo_access(&self, from: &RepoPath, to: &RepoPath) -> Result<()> {
        let (Some(from_id), Some(to_id)) = (
            self.workspace_id_of(&from.namespace).await?,
            self.workspace_id_of(&to.namespace).await?,
        ) else {
            return Ok(());
        };
        let binds = [
            JsValue::from(to_id.as_str()),
            to.name.to_lowercase().into(),
            from_id.as_str().into(),
            from.name.to_lowercase().into(),
        ];
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE repo_grants SET workspace_id = ?1, repo_name = ?2 WHERE workspace_id = ?3 AND repo_name = ?4")
                    .bind(&binds)?,
                self.db
                    .prepare("UPDATE repo_invitations SET workspace_id = ?1, repo_name = ?2 WHERE workspace_id = ?3 AND repo_name = ?4")
                    .bind(&binds)?,
            ])
            .await?;
        Ok(())
    }

    // --- Telling others ---

    /// Publishes the change of a person's own role, and records it in the
    /// workspace's audit log.
    async fn changed(
        &self,
        actor: &User,
        repo: Named<'_>,
        username: &str,
        role: Option<RepoRole>,
        previous: Option<RepoRole>,
        surface: Surface,
    ) {
        let (kind, message) = match (previous, role) {
            (None, Some(role)) => ("repo.collaborator_added", format!("Gave {username} the {} role", role.label())),
            (Some(previous), Some(role)) => (
                "repo.collaborator_role_changed",
                format!("Changed {username}'s role from {} to {}", previous.label(), role.label()),
            ),
            (Some(previous), None) => ("repo.collaborator_removed", format!("Removed {username}'s {} role", previous.label())),
            (None, None) => return,
        };
        self.publish_repo(
            kind,
            repo.id,
            &actor.id,
            RepoCollaborator {
                repo_id: repo.id.to_owned(),
                namespace: repo.namespace.to_owned(),
                name: repo.name.to_owned(),
                username: username.to_owned(),
                role,
                previous_role: previous,
            },
        )
        .await;
        self.audit(actor, kind, repo, surface, message).await;
    }

    async fn publish_repo<T: Serialize>(&self, kind: &'static str, repo_id: &str, actor: &str, data: T) {
        let Ok(events) = self.env.service("EVENTS") else {
            return;
        };
        let publish = Publish {
            events: vec![NewEvent {
                kind,
                source: "identity",
                repo_id: Some(repo_id.to_owned()),
                actor: Some(actor.to_owned()),
                data,
            }],
        };
        if let Err(error) = g1t_kit::call::<_, serde_json::Value>(&events, "publish", &publish).await {
            worker::console_error!("{kind} not published: {error}");
        }
    }

    async fn audit(&self, actor: &User, action: &str, repo: Named<'_>, surface: Surface, message: String) {
        let full = format!("{}/{}", repo.namespace, repo.name);
        self.record(actor, action, repo.namespace, Some(full), surface, message).await;
    }

    async fn audit_workspace(&self, actor: &User, action: &str, slug: &str, surface: Surface, message: String) {
        self.record(actor, action, slug, None, surface, message).await;
    }

    async fn record(&self, actor: &User, action: &str, workspace: &str, repo: Option<String>, surface: Surface, message: String) {
        let Ok(events) = self.env.service("EVENTS") else {
            return;
        };
        let entry = NewAuditEntry {
            actor: AuditActor::of(actor),
            action: action.to_owned(),
            surface,
            target: AuditTarget {
                workspace: workspace.to_lowercase(),
                repo,
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: if actor.kind == PrincipalKind::User { "access" } else { "access:token" }.to_owned(),
            result: Some("ok".to_owned()),
            message: Some(message),
            request_id: new_id("req", now_ms()),
        };
        let recorded: Result<u32> =
            g1t_kit::call(&events, "audit_record", &RecordAuditArgs { entries: vec![entry] }).await;
        if let Err(error) = recorded {
            worker::console_error!("{action} not recorded: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn people_are_added_by_username_or_address() {
        assert_eq!(invitee(" Ada "), Some(Invitee::Username("ada".into())));
        assert_eq!(invitee("@ada"), Some(Invitee::Username("ada".into())));
        assert_eq!(invitee("Ada@Example.com"), Some(Invitee::Email("ada@example.com".into())));
        assert_eq!(invitee("not a name"), None);
        assert_eq!(invitee("ada@"), None);
    }

    #[test]
    fn a_role_comes_from_ownership_the_base_or_a_grant() {
        use AccessSource::*;
        use RepoRole::*;
        assert_eq!(effective(true, Some(Read), Some(Write)), Some((Admin, Owner)));
        assert_eq!(effective(false, Some(Write), None), Some((Write, Base)));
        assert_eq!(effective(false, Some(Write), Some(Maintain)), Some((Maintain, Direct)));
        // A grant as high as the base is shown as direct, where it can be changed.
        assert_eq!(effective(false, Some(Write), Some(Write)), Some((Write, Direct)));
        assert_eq!(effective(false, Some(Admin), Some(Read)), Some((Admin, Base)));
        // An outside collaborator.
        assert_eq!(effective(false, None, Some(Triage)), Some((Triage, Direct)));
        // A member of a workspace whose base is none, with no grant.
        assert_eq!(effective(false, None, None), None);
    }

    #[test]
    fn an_invitation_is_pending_until_answered_revoked_or_expired() {
        let row = InvitationRow {
            expires_at: "2026-10-12T00:00:00.000Z".into(),
            ..InvitationRow::default()
        };
        let now = "2026-10-05T00:00:00.000Z";
        assert_eq!(invitation_status(&row, now), RepoInvitationStatus::Pending);
        assert_eq!(invitation_status(&row, "2026-10-12T00:00:00.000Z"), RepoInvitationStatus::Expired);
        let accepted = InvitationRow { accepted_at: Some(now.into()), ..row.clone() };
        assert_eq!(invitation_status(&accepted, now), RepoInvitationStatus::Accepted);
        let declined = InvitationRow { declined_at: Some(now.into()), ..row.clone() };
        assert_eq!(invitation_status(&declined, now), RepoInvitationStatus::Declined);
        let revoked = InvitationRow { revoked_at: Some(now.into()), ..row };
        assert_eq!(invitation_status(&revoked, now), RepoInvitationStatus::Revoked);
    }

    #[test]
    fn invitations_show_addresses_only_to_those_who_manage_access() {
        let row = InvitationRow {
            id: "rin_1".into(),
            workspace: "acme".into(),
            repo_name: "rocket".into(),
            email: Some("ada@example.com".into()),
            role: "triage".into(),
            expires_at: "2099-01-01T00:00:00.000Z".into(),
            ..InvitationRow::default()
        };
        let now = "2026-10-05T00:00:00.000Z";
        assert_eq!(row.shown(now, true).email.as_deref(), Some("ada@example.com"));
        assert_eq!(row.shown(now, false).email, None);
        assert_eq!(row.shown(now, false).repo, "acme/rocket");
        assert_eq!(row.shown(now, false).role, RepoRole::Triage);
    }
}
