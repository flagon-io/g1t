//! Who may do what in a repository: repository roles, the capabilities
//! each one carries, and how a person's permission is worked out.
//!
//! **One table.** [`CAPABILITIES`] says, for each [`Capability`], the
//! least [`RepoRole`] that has it. Every service asks [`can`] (or
//! [`permission`]) instead of checking membership itself, the site draws
//! its Roles table from the same list, and
//! `packages/contracts/src/access.ts` mirrors it (a test here reads that
//! file and fails when the two differ).
//!
//! **Effective permission** is the highest of:
//!
//! - **ownership**: an owner of the repository's workspace has Admin on
//!   every repository in it;
//! - **the base permission** of the workspace ([`BasePermission`]), which
//!   every member gets on every repository (Read for a workspace made from
//!   2026-10-08, [`BasePermission::FOR_NEW_WORKSPACES`]; Write for one made
//!   before, until an owner changes it);
//! - **a direct grant** ([`RepoGrant`]) to the person, on that repository.
//!   Whoever creates a repository is given Admin on it this way;
//! - **security manager**: Read on every repository of a workspace where
//!   the person is one, with the security capabilities
//!   ([`SECURITY_MANAGER`]) on top;
//! - **public**: anyone, signed in or not, can read a public repository.
//!
//! - **a team's grant**: a role given to a team the person is in, or to
//!   one of that team's parents (see [`crate::teams`]). Identity resolves
//!   it into the same [`RepoGrant`]s, with [`RepoGrant::team`] set, so the
//!   rules here treat it as any other grant.
//!
//! Identity attaches a person's grants ([`User::grants`]) and each
//! membership's base permission ([`Membership::base_permission`]) when it
//! resolves them from credentials, so asking costs nothing: no call, and
//! the answer is as fresh as the request.
//!
//! **Tokens.** A workspace's own token has Admin on its workspace's
//! repositories, as it could do everything a member could before roles;
//! what is for people only stays refused by the checks that say so. An
//! agent's token carries the memberships and grants of the person it acts
//! for, cut down to its repository's workspace
//! (`credentials::intersect`), so it never has more than that person on
//! that repository, and its scope limits it further.

use serde::{Deserialize, Serialize};

use crate::repos::{Repo, RepoPath};
use crate::{Membership, PrincipalKind, Role, User};

/// What someone may do in one repository, from least to most.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoRole {
    /// Read and clone; open issues and pull requests, and comment.
    Read,
    /// Read, and manage issues and pull requests: label, assign, close.
    Triage,
    /// Triage, and push, merge, and put agents to work.
    Write,
    /// Write, and manage the repository's settings and topics.
    Maintain,
    /// Everything: branch protection and rulesets, webhooks, secrets,
    /// deployments, security settings, who has access, and the
    /// repository's name, visibility and archiving.
    Admin,
}

impl RepoRole {
    pub const ALL: [RepoRole; 5] = [
        RepoRole::Read,
        RepoRole::Triage,
        RepoRole::Write,
        RepoRole::Maintain,
        RepoRole::Admin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RepoRole::Read => "read",
            RepoRole::Triage => "triage",
            RepoRole::Write => "write",
            RepoRole::Maintain => "maintain",
            RepoRole::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Option<RepoRole> {
        RepoRole::ALL
            .into_iter()
            .find(|role| role.as_str() == text.trim().to_ascii_lowercase())
    }

    /// How people are shown it: "Read", "Triage"...
    pub fn label(self) -> &'static str {
        match self {
            RepoRole::Read => "Read",
            RepoRole::Triage => "Triage",
            RepoRole::Write => "Write",
            RepoRole::Maintain => "Maintain",
            RepoRole::Admin => "Admin",
        }
    }
}

/// What every member of a workspace gets on each of its repositories.
///
/// Its `Default` is what a membership that does not say gets: one a service
/// made up to act inside a workspace. Every workspace stores its own value,
/// and a new one starts at [`BasePermission::FOR_NEW_WORKSPACES`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BasePermission {
    /// Nothing beyond what is public: members see the private
    /// repositories they are given access to, and no others.
    None,
    Read,
    /// What members could do before roles: push, merge, run agents.
    #[default]
    Write,
    Admin,
}

impl BasePermission {
    /// What a new workspace's members get: Read, as on GitHub. Workspaces
    /// made before 2026-10-08 kept the Write they had.
    pub const FOR_NEW_WORKSPACES: BasePermission = BasePermission::Read;

    pub const ALL: [BasePermission; 4] = [
        BasePermission::None,
        BasePermission::Read,
        BasePermission::Write,
        BasePermission::Admin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BasePermission::None => "none",
            BasePermission::Read => "read",
            BasePermission::Write => "write",
            BasePermission::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Option<BasePermission> {
        BasePermission::ALL
            .into_iter()
            .find(|base| base.as_str() == text.trim().to_ascii_lowercase())
    }

    /// The repository role it gives, if any.
    pub fn role(self) -> Option<RepoRole> {
        match self {
            BasePermission::None => None,
            BasePermission::Read => Some(RepoRole::Read),
            BasePermission::Write => Some(RepoRole::Write),
            BasePermission::Admin => Some(RepoRole::Admin),
        }
    }
}

/// Something that can be done in a repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// See the code, issues and pull requests; clone and fetch.
    Read,
    /// Open issues and pull requests, and comment on them.
    Participate,
    /// Apply labels and milestones; assign, close and reopen issues and
    /// pull requests; ask for reviews.
    Triage,
    /// Push to branches that are not protected, and edit files on the web.
    Push,
    /// Merge pull requests and manage the merge queue.
    Merge,
    /// Create, edit and delete labels and milestones.
    ManageLabels,
    /// See and dismiss security alerts: secret scanning, code scanning and
    /// vulnerable dependencies.
    SecurityAlerts,
    /// Assign agents, start runs, plans and workflows: anything that
    /// spends compute.
    Run,
    /// Change the description, topics, website, and how pull requests and
    /// agents work.
    ManageSettings,
    /// Change branch protection, rulesets and guardrails.
    ManageProtection,
    /// Change security settings: scanning, push protection, custom
    /// patterns and bypass reviews.
    ManageSecurity,
    /// Manage webhooks, secrets and variables, deployments, domains and
    /// integrations.
    ManageIntegrations,
    /// Add, change and remove who has access, and invitations.
    ManageAccess,
    /// Rename, archive, and change the default branch.
    Administer,
    /// Make the repository public or private. Owners only when the
    /// workspace's member privileges say so.
    ChangeVisibility,
    /// Transfer or delete the repository. Owners only unless the
    /// workspace's member privileges let repository admins do it.
    Delete,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Read => "read",
            Capability::Participate => "participate",
            Capability::Triage => "triage",
            Capability::Push => "push",
            Capability::Merge => "merge",
            Capability::ManageLabels => "manage_labels",
            Capability::SecurityAlerts => "security_alerts",
            Capability::Run => "run",
            Capability::ManageSettings => "manage_settings",
            Capability::ManageProtection => "manage_protection",
            Capability::ManageSecurity => "manage_security",
            Capability::ManageIntegrations => "manage_integrations",
            Capability::ManageAccess => "manage_access",
            Capability::Administer => "administer",
            Capability::ChangeVisibility => "change_visibility",
            Capability::Delete => "delete",
        }
    }
}

/// One row of the permission table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CapabilityRow {
    pub capability: Capability,
    /// The least role that has it.
    pub role: RepoRole,
    /// What it covers, as the Roles table shows it.
    pub about: &'static str,
}

/// The permission table: the least role for each capability. The single
/// source of truth; `packages/contracts/src/access.ts` mirrors it. It
/// follows GitHub's table of repository roles; where g1t differs, the
/// access guide says so.
pub const CAPABILITIES: [CapabilityRow; 16] = [
    CapabilityRow { capability: Capability::Read, role: RepoRole::Read, about: "See code, issues and pull requests; clone and fetch" },
    CapabilityRow { capability: Capability::Participate, role: RepoRole::Read, about: "Open issues and pull requests, and comment" },
    CapabilityRow { capability: Capability::Triage, role: RepoRole::Triage, about: "Apply labels and milestones; assign, close and reopen issues and pull requests" },
    CapabilityRow { capability: Capability::Push, role: RepoRole::Write, about: "Push to branches that are not protected" },
    CapabilityRow { capability: Capability::Merge, role: RepoRole::Write, about: "Merge pull requests and use the merge queue" },
    CapabilityRow { capability: Capability::ManageLabels, role: RepoRole::Write, about: "Create, edit and delete labels and milestones" },
    CapabilityRow { capability: Capability::SecurityAlerts, role: RepoRole::Write, about: "See and dismiss security alerts" },
    CapabilityRow { capability: Capability::Run, role: RepoRole::Write, about: "Assign agents and start runs, plans and workflows" },
    CapabilityRow { capability: Capability::ManageSettings, role: RepoRole::Maintain, about: "Change the description, topics, and pull request and agent settings" },
    CapabilityRow { capability: Capability::ManageProtection, role: RepoRole::Admin, about: "Change branch protection, rulesets and guardrails" },
    CapabilityRow { capability: Capability::ManageSecurity, role: RepoRole::Admin, about: "Change security settings, custom patterns and bypass reviews" },
    CapabilityRow { capability: Capability::ManageIntegrations, role: RepoRole::Admin, about: "Manage webhooks, secrets, variables, deployments and domains" },
    CapabilityRow { capability: Capability::ManageAccess, role: RepoRole::Admin, about: "Manage who has access, and invitations" },
    CapabilityRow { capability: Capability::Administer, role: RepoRole::Admin, about: "Rename, archive and change the default branch" },
    CapabilityRow { capability: Capability::ChangeVisibility, role: RepoRole::Admin, about: "Change visibility (owners only, unless member privileges allow admins)" },
    CapabilityRow { capability: Capability::Delete, role: RepoRole::Admin, about: "Transfer or delete the repository (owners only, unless member privileges allow admins)" },
];

/// Capabilities that also need an owner of the repository's workspace,
/// whatever a person's role on the repository, unless the workspace's
/// member privileges ([`crate::MemberPrivileges`]) let its members with
/// the Admin role do them: see [`owner_only`].
pub const OWNER_ONLY: [Capability; 2] = [Capability::ChangeVisibility, Capability::Delete];

/// What a security manager may do on every repository of their workspace,
/// whatever their role on it: read it, and see and manage its security.
pub const SECURITY_MANAGER: [Capability; 4] =
    [Capability::Read, Capability::Participate, Capability::SecurityAlerts, Capability::ManageSecurity];

/// Whether `capability` needs an owner of a workspace whose member
/// privileges are `privileges`, for a member with the Admin role.
pub fn owner_only(capability: Capability, privileges: &crate::MemberPrivileges) -> bool {
    match capability {
        Capability::ChangeVisibility => !privileges.members_can_change_repo_visibility,
        Capability::Delete => !privileges.members_can_delete_repositories,
        _ => false,
    }
}

/// The least role that has `capability`.
pub fn least_role(capability: Capability) -> RepoRole {
    CAPABILITIES
        .iter()
        .find(|row| row.capability == capability)
        .map_or(RepoRole::Admin, |row| row.role)
}

/// Whether `role` has `capability`, going by the table alone.
pub fn allows(role: RepoRole, capability: Capability) -> bool {
    role >= least_role(capability)
}

/// A person's role on one repository, given to them directly. Attached by
/// identity to every user it resolves ([`User::grants`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoGrant {
    pub repo_id: String,
    /// The repository's workspace, by slug, as it is now.
    pub workspace: String,
    pub role: RepoRole,
    /// The team it comes through, by slug, when it is a team's grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}

/// What [`permission`] needs to know about a repository.
#[derive(Clone, Copy, Debug)]
pub struct RepoRef<'a> {
    pub id: &'a str,
    /// Its workspace's slug.
    pub namespace: &'a str,
    pub private: bool,
}

impl<'a> From<&'a Repo> for RepoRef<'a> {
    fn from(repo: &'a Repo) -> Self {
        RepoRef {
            id: &repo.id,
            namespace: &repo.namespace,
            private: repo.is_private,
        }
    }
}

/// What a membership gives on each of the workspace's repositories.
fn membership_role(user: &User, membership: &Membership) -> Option<RepoRole> {
    // A workspace's own token, and g1t acting in the workspace, do what an
    // owner can on its repositories.
    if matches!(user.kind, PrincipalKind::Workspace | PrincipalKind::System) {
        return Some(RepoRole::Admin);
    }
    match membership.role {
        Role::Owner => Some(RepoRole::Admin),
        Role::Member => {
            let base = membership.base_permission.unwrap_or_default().role();
            // A security manager reads every repository.
            if membership.has(crate::OrgRole::SecurityManager) {
                base.max(Some(RepoRole::Read))
            } else {
                base
            }
        }
    }
}

/// `user`'s role on the repository, not counting that it may be public.
pub fn granted(user: &User, repo: RepoRef<'_>) -> Option<RepoRole> {
    let namespace = repo.namespace.to_lowercase();
    let from_membership = user
        .workspaces
        .iter()
        .find(|membership| membership.slug.eq_ignore_ascii_case(&namespace))
        .and_then(|membership| membership_role(user, membership));
    let direct = user
        .grants
        .iter()
        .filter(|grant| grant.repo_id == repo.id)
        .map(|grant| grant.role)
        .max();
    from_membership.max(direct)
}

/// The viewer's effective role on a repository: `None` means they may not
/// see it at all (a private repository then looks missing).
pub fn permission<'a>(viewer: Option<&User>, repo: impl Into<RepoRef<'a>>) -> Option<RepoRole> {
    let repo = repo.into();
    let role = viewer.and_then(|user| granted(user, repo));
    if repo.private {
        role
    } else {
        role.max(Some(RepoRole::Read))
    }
}

/// Whether the viewer may do `capability` in the repository. Owner-only
/// capabilities ([`OWNER_ONLY`]) also need the viewer to own its workspace,
/// or to be a member of it whose member privileges allow it. A security
/// manager of its workspace may do what [`SECURITY_MANAGER`] lists.
pub fn can<'a>(viewer: Option<&User>, repo: impl Into<RepoRef<'a>>, capability: Capability) -> bool {
    let repo = repo.into();
    let Some(role) = permission(viewer, repo) else {
        return false;
    };
    let namespace = repo.namespace.to_lowercase();
    if !allows(role, capability) {
        return SECURITY_MANAGER.contains(&capability)
            && viewer.is_some_and(|user| is_security_manager(user, &namespace));
    }
    if OWNER_ONLY.contains(&capability) {
        return viewer.is_some_and(|user| match user.membership(&namespace) {
            Some(membership) if membership.role == Role::Owner => true,
            // A member with the Admin role, when the privileges allow it;
            // never an outside collaborator.
            Some(membership) => !owner_only(capability, &membership.privileges.unwrap_or_default()),
            None => false,
        });
    }
    true
}

/// Whether `user` is a security manager of the workspace `namespace`
/// (a person, not a token acting for one).
pub fn is_security_manager(user: &User, namespace: &str) -> bool {
    user.kind == PrincipalKind::User
        && user
            .membership(namespace)
            .is_some_and(|membership| membership.has(crate::OrgRole::SecurityManager))
}

/// What a refusal answers: a repository the viewer cannot read is not
/// found (so private ones cannot be told from missing ones); one they can
/// read but not act in is forbidden.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denied {
    NotFound,
    Forbidden,
}

/// `Ok` when the viewer may do `capability`; otherwise whether to answer
/// not found or forbidden.
pub fn check<'a>(
    viewer: Option<&User>,
    repo: impl Into<RepoRef<'a>>,
    capability: Capability,
) -> Result<(), Denied> {
    let repo = repo.into();
    if permission(viewer, repo).is_none() {
        return Err(Denied::NotFound);
    }
    if can(viewer, repo, capability) {
        Ok(())
    } else {
        Err(Denied::Forbidden)
    }
}

/// The sentence a refusal of `capability` gives.
pub fn needs(capability: Capability, repo: &str) -> String {
    let role = least_role(capability);
    if OWNER_ONLY.contains(&capability) {
        return format!(
            "Only an owner of the workspace can do that to {repo}, unless its member privileges let members with the {} role do it.",
            role.label()
        );
    }
    format!(
        "You need the {} role or higher on {repo} to do that.",
        role.label()
    )
}

/// Whether the user has any way into the workspace `namespace`: a member,
/// or someone with a role on one of its repositories.
pub fn has_access_in(user: &User, namespace: &str) -> bool {
    let namespace = namespace.to_lowercase();
    user.is_member(&namespace) || user.grants.iter().any(|grant| grant.workspace.eq_ignore_ascii_case(&namespace))
}

/// Whether the user is an outside collaborator of `namespace`: they have
/// roles on some of its repositories without belonging to it.
pub fn is_outside_collaborator(user: &User, namespace: &str) -> bool {
    let namespace = namespace.to_lowercase();
    !user.is_member(&namespace) && user.grants.iter().any(|grant| grant.workspace.eq_ignore_ascii_case(&namespace))
}

// --- Who has access ---------------------------------------------------------

/// How a person has their role on a repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessSource {
    /// An owner of the workspace: Admin on everything in it.
    Owner,
    /// A member, through the workspace's base permission.
    Base,
    /// Given a role on this repository directly.
    Direct,
    /// In a team given a role on this repository, or in a child of one.
    Team,
}

/// One person with access to a repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collaborator {
    pub username: String,
    /// Their display name, if they set one.
    pub name: Option<String>,
    pub avatar: Option<String>,
    /// Their effective role: the highest of what they have.
    pub role: RepoRole,
    /// Where the effective role comes from.
    pub source: AccessSource,
    /// Their direct grant on this repository, if any (even when the base
    /// permission or ownership gives more).
    pub direct: Option<RepoRole>,
    /// `owner`, `member`, or null for an outside collaborator.
    pub workspace_role: Option<Role>,
    /// The highest role a team gives them here, and that team's slug.
    #[serde(default)]
    pub team_role: Option<RepoRole>,
    #[serde(default)]
    pub team: Option<String>,
}

/// Where an invitation to a repository stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoInvitationStatus {
    Pending,
    Accepted,
    Declined,
    Revoked,
    Expired,
}

/// An invitation to collaborate on one repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoInvitation {
    pub id: String,
    /// `workspace/name`, as it is now.
    pub repo: String,
    pub repo_id: String,
    /// Who is invited, when they have an account.
    pub invitee: Option<String>,
    /// The address it was sent to, when they had no account yet. Shown
    /// only to whoever may manage the repository's access.
    pub email: Option<String>,
    pub role: RepoRole,
    /// Who sent it, by username.
    pub invited_by: Option<String>,
    /// The avatar of who sent it: the SHA-256 of its bytes, served at
    /// `/avatars/<avatar>`. None means the generated letter avatar.
    #[serde(default)]
    pub inviter_avatar: Option<String>,
    pub status: RepoInvitationStatus,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub expires_at: String,
}

/// Who has access to a repository, as its Access settings show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoAccess {
    pub repo: String,
    pub base_permission: BasePermission,
    /// Everyone with access other than through the repository being
    /// public: owners, members with a base role, and direct grants.
    pub people: Vec<Collaborator>,
    /// The workspace's teams given a role on it.
    #[serde(default)]
    pub teams: Vec<crate::teams::RepoTeam>,
    /// Pending invitations. Empty unless the viewer may manage access.
    pub invitations: Vec<RepoInvitation>,
    /// The viewer's own role, and whether they may change who has access.
    pub viewer_role: Option<RepoRole>,
    pub can_manage: bool,
}

/// What adding someone did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Added {
    /// A member of the workspace: given the role at once.
    Granted { collaborator: Collaborator },
    /// Anyone else: sent an invitation to accept.
    Invited { invitation: RepoInvitation },
}

/// A person's permission on a repository, as
/// `GET /repos/{owner}/{name}/collaborators/{username}/permission` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionInfo {
    pub username: String,
    /// Their role, or null when they have none (on a public repository
    /// everyone reads it, which this does not count).
    pub role: Option<RepoRole>,
    pub source: Option<AccessSource>,
    /// What the role lets them do, from the permission table.
    pub capabilities: Vec<Capability>,
}

/// The capabilities `role` has, in the table's order.
pub fn capabilities_of(role: Option<RepoRole>) -> Vec<Capability> {
    CAPABILITIES
        .iter()
        .filter(|row| role.is_some_and(|role| role >= row.role))
        .map(|row| row.capability)
        .collect()
}

/// An outside collaborator of a workspace, and what they can reach.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutsideCollaborator {
    pub username: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub repos: Vec<CollaboratorRepo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollaboratorRepo {
    /// `workspace/name`.
    pub repo: String,
    pub role: RepoRole,
}

// --- Identity methods ---------------------------------------------------------
//
// Served by identity at `POST /rpc/<method>`. Each takes the repository's
// path and the person asking; identity asks the repos service for the
// repository as that person sees it, so a repository they cannot read is
// not found, and one they can read without managing its access is
// forbidden. Agents' tokens can never change access.

/// `repo_access`: who has access to a repository. Needs Write (as the
/// list of collaborators does); invitations need Admin.
/// Returns `Outcome<RepoAccess>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RepoAccessArgs {
    pub viewer: crate::Viewer,
    pub path: RepoPath,
}

/// `add_collaborator`: gives `invitee` (a username or an email address)
/// `role` on a repository. A member of its workspace gets it at once; a
/// person with an account is sent an invitation to accept; an address
/// without one is sent an invite code that makes their account and
/// accepts. Admin only. Returns `Outcome<Added>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddCollaboratorArgs {
    pub actor: User,
    pub path: RepoPath,
    pub invitee: String,
    pub role: RepoRole,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_collaborator_role`: changes a direct grant, or a pending
/// invitation's role. Admin only. Returns `Outcome<Collaborator>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetCollaboratorRoleArgs {
    pub actor: User,
    pub path: RepoPath,
    pub username: String,
    pub role: RepoRole,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `remove_collaborator`: takes away a direct grant. Admin only; anyone
/// may remove themselves. Owners and the base permission are not changed
/// here. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveCollaboratorArgs {
    pub actor: User,
    pub path: RepoPath,
    pub username: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `collaborator_permission`: `username`'s role on a repository. Needs
/// Write, or to be asking about yourself. Returns `Outcome<PermissionInfo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CollaboratorPermissionArgs {
    pub viewer: crate::Viewer,
    pub path: RepoPath,
    pub username: String,
}

/// `my_repo_invitations`: the invitations waiting for `user` to answer.
/// Returns `Vec<RepoInvitation>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct MyRepoInvitationsArgs {
    pub user: User,
}

/// `respond_repo_invitation`: accept or decline an invitation sent to you.
/// Accepting is checked against the workspace's policy. Returns
/// `Outcome<RepoInvitation>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RespondRepoInvitationArgs {
    pub user: User,
    pub id: String,
    pub accept: bool,
}

/// `revoke_repo_invitation`: withdraw a pending invitation. Admin only.
/// Returns `Outcome<RepoInvitation>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RevokeRepoInvitationArgs {
    pub actor: User,
    pub path: RepoPath,
    pub id: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_base_permission`: what every member gets on every repository.
/// Owners only, as a person. Returns `Outcome<BasePermission>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetBasePermissionArgs {
    pub actor: User,
    pub slug: String,
    pub base_permission: BasePermission,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `outside_collaborators`: the people with roles on a workspace's
/// repositories who are not its members. Owners only. Returns
/// `Outcome<Vec<OutsideCollaborator>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OutsideCollaboratorsArgs {
    pub viewer: crate::Viewer,
    pub slug: String,
}

/// `forget_repo_access`: a repository was purged; its grants and
/// invitations go with it. For the repos service. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ForgetRepoAccessArgs {
    pub repo_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(memberships: &[(&str, Role, Option<BasePermission>)], grants: &[(&str, &str, RepoRole)]) -> User {
        User {
            id: "usr_1".into(),
            username: "ana".into(),
            verified: true,
            workspaces: memberships
                .iter()
                .map(|(slug, role, base)| Membership {
                    slug: (*slug).into(),
                    role: *role,
                    name: None,
                    avatar: None,
                    base_permission: *base,
                    team_creation: None,
                    org_roles: Vec::new(),
                    privileges: None,
                })
                .collect(),
            grants: grants
                .iter()
                .map(|(id, workspace, role)| RepoGrant {
                    repo_id: (*id).into(),
                    workspace: (*workspace).into(),
                    role: *role,
                    team: None,
                })
                .collect(),
            ..User::default()
        }
    }

    fn repo(id: &'static str, namespace: &'static str, private: bool) -> RepoRef<'static> {
        RepoRef { id, namespace, private }
    }

    /// Every role against every capability: the whole table, spelled out.
    #[test]
    fn every_role_has_exactly_the_capabilities_of_the_table() {
        use Capability::*;
        let expected: [(RepoRole, &[Capability]); 5] = [
            (RepoRole::Read, &[Read, Participate]),
            (RepoRole::Triage, &[Read, Participate, Triage]),
            (RepoRole::Write, &[Read, Participate, Triage, Push, Merge, ManageLabels, SecurityAlerts, Run]),
            (
                RepoRole::Maintain,
                &[Read, Participate, Triage, Push, Merge, ManageLabels, SecurityAlerts, Run, ManageSettings],
            ),
            (
                RepoRole::Admin,
                &[
                    Read, Participate, Triage, Push, Merge, ManageLabels, SecurityAlerts, Run, ManageSettings,
                    ManageProtection, ManageSecurity, ManageIntegrations, ManageAccess, Administer, ChangeVisibility,
                    Delete,
                ],
            ),
        ];
        for (role, has) in expected {
            for row in CAPABILITIES {
                assert_eq!(
                    allows(role, row.capability),
                    has.contains(&row.capability),
                    "{} and {}",
                    role.as_str(),
                    row.capability.as_str()
                );
            }
            assert_eq!(capabilities_of(Some(role)), has.to_vec());
        }
        assert!(capabilities_of(None).is_empty());
    }

    #[test]
    fn read_cannot_spend_compute() {
        assert!(!allows(RepoRole::Read, Capability::Run));
        assert!(!allows(RepoRole::Triage, Capability::Run));
        assert!(allows(RepoRole::Write, Capability::Run));
    }

    #[test]
    fn owners_have_admin_on_everything_in_their_workspace() {
        let owner = user(&[("acme", Role::Owner, Some(BasePermission::None))], &[]);
        assert_eq!(permission(Some(&owner), repo("rep_1", "acme", true)), Some(RepoRole::Admin));
        assert!(can(Some(&owner), repo("rep_1", "acme", true), Capability::Delete));
    }

    #[test]
    fn members_get_the_base_permission_and_write_when_unset() {
        let unset = user(&[("acme", Role::Member, None)], &[]);
        assert_eq!(permission(Some(&unset), repo("rep_1", "acme", true)), Some(RepoRole::Write));
        let read = user(&[("acme", Role::Member, Some(BasePermission::Read))], &[]);
        assert_eq!(permission(Some(&read), repo("rep_1", "acme", true)), Some(RepoRole::Read));
        let none = user(&[("acme", Role::Member, Some(BasePermission::None))], &[]);
        assert_eq!(permission(Some(&none), repo("rep_1", "acme", true)), None);
        assert_eq!(permission(Some(&none), repo("rep_1", "acme", false)), Some(RepoRole::Read));
    }

    /// The default keeps what members could do before roles: read, push,
    /// merge, run agents.
    #[test]
    fn the_default_base_permission_keeps_members_working() {
        assert_eq!(BasePermission::default(), BasePermission::Write);
        let member = user(&[("acme", Role::Member, None)], &[]);
        for capability in [Capability::Read, Capability::Participate, Capability::Push, Capability::Merge, Capability::Run] {
            assert!(can(Some(&member), repo("rep_1", "acme", true), capability));
        }
        // Transfer and delete were owners' only, and still are.
        assert!(!can(Some(&member), repo("rep_1", "acme", true), Capability::Delete));
    }

    #[test]
    fn effective_permission_is_the_highest_source() {
        let member = user(&[("acme", Role::Member, Some(BasePermission::Read))], &[("rep_1", "acme", RepoRole::Maintain)]);
        assert_eq!(permission(Some(&member), repo("rep_1", "acme", true)), Some(RepoRole::Maintain));
        assert_eq!(permission(Some(&member), repo("rep_2", "acme", true)), Some(RepoRole::Read));
        // A grant lower than the base changes nothing.
        let member = user(&[("acme", Role::Member, Some(BasePermission::Admin))], &[("rep_1", "acme", RepoRole::Read)]);
        assert_eq!(permission(Some(&member), repo("rep_1", "acme", true)), Some(RepoRole::Admin));
    }

    #[test]
    fn a_teams_grant_counts_like_any_other_and_the_highest_wins() {
        let mut member = user(&[("acme", Role::Member, Some(BasePermission::Read))], &[]);
        member.grants.push(RepoGrant {
            repo_id: "rep_1".into(),
            workspace: "acme".into(),
            role: RepoRole::Maintain,
            team: Some("backend".into()),
        });
        member.grants.push(RepoGrant {
            repo_id: "rep_1".into(),
            workspace: "acme".into(),
            role: RepoRole::Triage,
            team: None,
        });
        assert_eq!(permission(Some(&member), repo("rep_1", "acme", true)), Some(RepoRole::Maintain));
        assert!(can(Some(&member), repo("rep_1", "acme", true), Capability::ManageSettings));
        assert!(!can(Some(&member), repo("rep_1", "acme", true), Capability::ManageProtection));
        assert!(!can(Some(&member), repo("rep_1", "acme", true), Capability::ManageAccess));
        // Elsewhere, only the base.
        assert_eq!(permission(Some(&member), repo("rep_2", "acme", true)), Some(RepoRole::Read));
        // Serialized without `team` when it is a person's own.
        let own = serde_json::to_value(&member.grants[1]).unwrap();
        assert!(own.get("team").is_none());
        assert_eq!(serde_json::to_value(&member.grants[0]).unwrap()["team"], "backend");
    }

    #[test]
    fn outside_collaborators_reach_only_their_repositories() {
        let outsider = user(&[], &[("rep_1", "acme", RepoRole::Triage)]);
        assert_eq!(permission(Some(&outsider), repo("rep_1", "acme", true)), Some(RepoRole::Triage));
        assert_eq!(permission(Some(&outsider), repo("rep_2", "acme", true)), None);
        assert_eq!(check(Some(&outsider), repo("rep_2", "acme", true), Capability::Read), Err(Denied::NotFound));
        assert_eq!(check(Some(&outsider), repo("rep_1", "acme", true), Capability::Push), Err(Denied::Forbidden));
        assert_eq!(check(Some(&outsider), repo("rep_1", "acme", true), Capability::Triage), Ok(()));
        assert!(is_outside_collaborator(&outsider, "acme"));
        assert!(has_access_in(&outsider, "acme"));
        assert!(!has_access_in(&outsider, "globex"));
    }

    #[test]
    fn a_direct_admin_cannot_transfer_or_delete() {
        let admin = user(&[], &[("rep_1", "acme", RepoRole::Admin)]);
        assert!(can(Some(&admin), repo("rep_1", "acme", true), Capability::Administer));
        assert!(can(Some(&admin), repo("rep_1", "acme", true), Capability::ManageAccess));
        assert!(!can(Some(&admin), repo("rep_1", "acme", true), Capability::Delete));
    }

    /// GitHub's table, row by row where g1t has the action: the least role
    /// each one takes there.
    #[test]
    fn the_table_matches_githubs_repository_roles() {
        let github: [(Capability, RepoRole); 16] = [
            // "Pull from the repository", "View ..."
            (Capability::Read, RepoRole::Read),
            // "Open issues", "Comment on issues and pull requests"
            (Capability::Participate, RepoRole::Read),
            // "Apply/dismiss labels", "Apply milestones", "Close, reopen,
            // and assign all issues and pull requests"
            (Capability::Triage, RepoRole::Triage),
            // "Push to (write) the person or team's assigned repositories"
            (Capability::Push, RepoRole::Write),
            // "Merge pull requests"
            (Capability::Merge, RepoRole::Write),
            // "Create, edit, delete labels", "Create, edit, delete milestones"
            (Capability::ManageLabels, RepoRole::Write),
            // "Receive and dismiss Dependabot alerts", "List, dismiss, and
            // delete code scanning alerts", "View and dismiss secret
            // scanning alerts"
            (Capability::SecurityAlerts, RepoRole::Write),
            // "Create, edit, run, re-run, and cancel GitHub Actions workflows"
            (Capability::Run, RepoRole::Write),
            // "Edit a repository's description", "Manage topics", "Manage
            // pull request merges"
            (Capability::ManageSettings, RepoRole::Maintain),
            // "Manage branch protection rules and repository rulesets"
            (Capability::ManageProtection, RepoRole::Admin),
            // "Manage security and analysis features"
            (Capability::ManageSecurity, RepoRole::Admin),
            // "Manage webhooks and deploy keys"
            (Capability::ManageIntegrations, RepoRole::Admin),
            // "Manage individual and team access to the repository"
            (Capability::ManageAccess, RepoRole::Admin),
            // "Rename a repository", "Archive repositories", "Change the
            // default branch"
            (Capability::Administer, RepoRole::Admin),
            // "Change a repository's visibility"
            (Capability::ChangeVisibility, RepoRole::Admin),
            // "Delete or transfer repositories"
            (Capability::Delete, RepoRole::Admin),
        ];
        for (capability, role) in github {
            assert_eq!(least_role(capability), role, "{}", capability.as_str());
        }
        assert_eq!(github.len(), CAPABILITIES.len());
    }

    fn with_privileges(mut person: User, privileges: crate::MemberPrivileges) -> User {
        for membership in &mut person.workspaces {
            membership.privileges = Some(privileges);
        }
        person
    }

    #[test]
    fn member_privileges_decide_whether_admins_change_visibility_delete_and_transfer() {
        let admin = user(&[("acme", Role::Member, Some(BasePermission::Read))], &[("rep_1", "acme", RepoRole::Admin)]);
        let rep = repo("rep_1", "acme", true);
        // The defaults: admins change visibility; only owners delete.
        assert!(can(Some(&admin), rep, Capability::ChangeVisibility));
        assert!(!can(Some(&admin), rep, Capability::Delete));
        let open = with_privileges(
            admin.clone(),
            crate::MemberPrivileges { members_can_delete_repositories: true, ..crate::MemberPrivileges::default() },
        );
        assert!(can(Some(&open), rep, Capability::Delete));
        let closed = with_privileges(
            admin.clone(),
            crate::MemberPrivileges { members_can_change_repo_visibility: false, ..crate::MemberPrivileges::default() },
        );
        assert!(!can(Some(&closed), rep, Capability::ChangeVisibility));
        // A writer never can, whatever the privileges.
        let writer = with_privileges(
            user(&[("acme", Role::Member, Some(BasePermission::Write))], &[]),
            crate::MemberPrivileges { members_can_delete_repositories: true, ..crate::MemberPrivileges::default() },
        );
        assert!(!can(Some(&writer), rep, Capability::Delete));
        // Owners always can.
        let owner = with_privileges(
            user(&[("acme", Role::Owner, None)], &[]),
            crate::MemberPrivileges { members_can_change_repo_visibility: false, ..crate::MemberPrivileges::default() },
        );
        assert!(can(Some(&owner), rep, Capability::ChangeVisibility));
        assert!(can(Some(&owner), rep, Capability::Delete));
    }

    #[test]
    fn a_security_manager_reads_everything_and_manages_its_security_only() {
        let mut manager = user(&[("acme", Role::Member, Some(BasePermission::None))], &[]);
        manager.workspaces[0].org_roles.push(crate::OrgRole::SecurityManager);
        let rep = repo("rep_1", "acme", true);
        assert_eq!(permission(Some(&manager), rep), Some(RepoRole::Read));
        for capability in SECURITY_MANAGER {
            assert!(can(Some(&manager), rep, capability), "{}", capability.as_str());
        }
        for capability in [Capability::Triage, Capability::Push, Capability::ManageSettings, Capability::ManageProtection] {
            assert!(!can(Some(&manager), rep, capability), "{}", capability.as_str());
        }
        // Elsewhere, nothing.
        assert_eq!(permission(Some(&manager), repo("rep_2", "globex", true)), None);
        // A billing manager gets no repository access from the role.
        let mut billing = user(&[("acme", Role::Member, Some(BasePermission::None))], &[]);
        billing.workspaces[0].org_roles.push(crate::OrgRole::BillingManager);
        assert_eq!(permission(Some(&billing), rep), None);
        assert!(billing.manages_billing("acme"));
        assert!(!billing.manages_security("acme"));
    }

    #[test]
    fn a_maintainer_no_longer_changes_branch_protection() {
        let maintainer = user(&[], &[("rep_1", "acme", RepoRole::Maintain)]);
        let rep = repo("rep_1", "acme", true);
        assert!(can(Some(&maintainer), rep, Capability::ManageSettings));
        assert!(!can(Some(&maintainer), rep, Capability::ManageProtection));
        let triager = user(&[], &[("rep_1", "acme", RepoRole::Triage)]);
        assert!(can(Some(&triager), rep, Capability::Triage));
        assert!(!can(Some(&triager), rep, Capability::ManageLabels));
        let writer = user(&[], &[("rep_1", "acme", RepoRole::Write)]);
        assert!(can(Some(&writer), rep, Capability::ManageLabels));
        assert!(can(Some(&writer), rep, Capability::SecurityAlerts));
    }

    #[test]
    fn new_workspaces_start_at_read() {
        assert_eq!(BasePermission::FOR_NEW_WORKSPACES, BasePermission::Read);
    }

    #[test]
    fn anyone_reads_a_public_repository_and_nothing_more() {
        assert_eq!(permission(None, repo("rep_1", "acme", false)), Some(RepoRole::Read));
        assert_eq!(permission(None, repo("rep_1", "acme", true)), None);
        assert!(can(None, repo("rep_1", "acme", false), Capability::Read));
        assert!(!can(None, repo("rep_1", "acme", false), Capability::Triage));
        let stranger = user(&[("globex", Role::Owner, None)], &[]);
        assert_eq!(check(Some(&stranger), repo("rep_1", "acme", false), Capability::Push), Err(Denied::Forbidden));
    }

    #[test]
    fn a_workspace_token_has_admin_in_its_workspace_only() {
        let token = User {
            id: "wsp_1".into(),
            username: "acme".into(),
            kind: PrincipalKind::Workspace,
            workspaces: vec![Membership::member("acme")],
            ..User::default()
        };
        assert_eq!(permission(Some(&token), repo("rep_1", "acme", true)), Some(RepoRole::Admin));
        assert_eq!(permission(Some(&token), repo("rep_2", "globex", true)), None);
    }

    #[test]
    fn roles_and_base_permissions_read_and_write_as_words() {
        for role in RepoRole::ALL {
            assert_eq!(RepoRole::parse(role.as_str()), Some(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        for base in BasePermission::ALL {
            assert_eq!(BasePermission::parse(base.as_str()), Some(base));
            assert_eq!(serde_json::to_value(base).unwrap(), base.as_str());
        }
        for row in CAPABILITIES {
            assert_eq!(serde_json::to_value(row.capability).unwrap(), row.capability.as_str());
        }
        assert!(RepoRole::Read < RepoRole::Triage && RepoRole::Maintain < RepoRole::Admin);
    }

    /// `packages/contracts/src/access.ts` lists the same table, in the
    /// same order, with the same least roles.
    #[test]
    fn the_typescript_mirror_has_the_same_table() {
        let ts = include_str!("../../../packages/contracts/src/access.ts");
        let table = ts
            .split_once("export const CAPABILITIES = [")
            .and_then(|(_, rest)| rest.split_once("] as const"))
            .map(|(table, _)| table)
            .expect("CAPABILITIES in access.ts");
        let rows: Vec<(String, String)> = table
            .lines()
            .filter_map(|line| {
                let capability = line.split_once("capability: \"")?.1.split_once('"')?.0;
                let role = line.split_once("role: \"")?.1.split_once('"')?.0;
                Some((capability.to_owned(), role.to_owned()))
            })
            .collect();
        let expected: Vec<(String, String)> = CAPABILITIES
            .iter()
            .map(|row| (row.capability.as_str().to_owned(), row.role.as_str().to_owned()))
            .collect();
        assert_eq!(rows, expected);
        let owner_only = ts
            .split_once("export const OWNER_ONLY = [")
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(list, _)| list)
            .expect("OWNER_ONLY in access.ts");
        let mirrored: Vec<&str> = owner_only
            .split(',')
            .map(|item| item.trim().trim_matches('"'))
            .filter(|item| !item.is_empty())
            .collect();
        let expected: Vec<&str> = OWNER_ONLY.iter().map(|capability| capability.as_str()).collect();
        assert_eq!(mirrored, expected);
    }
}
